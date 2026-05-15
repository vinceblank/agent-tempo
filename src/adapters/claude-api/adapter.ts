/**
 * Headless Claude API adapter — SDK class.
 *
 * Issue #131 Phase C. Uses the Anthropic Messages API directly via
 * `@anthropic-ai/sdk` — no terminal, no Claude Code CLI, headless from
 * spawn to detach. Mirrors the Copilot bridge structure: detached Node
 * subprocess, dual-purpose entry point (class import vs `require.main`
 * self-exec), `claimAttachment` + heartbeat lifecycle inherited from
 * `SdkAttachment`.
 *
 * Class hierarchy: `DirectApiAttachment extends SdkAttachment extends BaseAttachment`.
 * Concrete adapter overrides `invokeSdk` (the LLM turn loop, commit 4),
 * `onSuperseded` (AbortController.abort, commit 4), and the descriptor;
 * everything else (claim, heartbeat, phase watcher, `processingStart`/`End`
 * pairing, `markDelivered`) is free.
 *
 * **Commit progression for #131 Phase C**:
 *   - Commit 1: wire scaffold (descriptor, optional-dep guard, class stub).
 *   - Commit 2: in-process MCP bridge module + tool-registration helpers.
 *   - **Commit 3 (this commit)**: full lifecycle wiring — workflow connect,
 *     workflow-register polling, runId pin, MCP bridge boot, V2 attachment
 *     claim, terminal-cleanup hook, signal handlers, idle poll loop. The
 *     `invokeSdk` method is still a stub that throws — commit 4 wires the
 *     tool-use loop against the Anthropic Messages API.
 *   - Commit 4: tool-use loop + verification-addendum landmines.
 *   - Commit 5: tests + docs.
 *
 * Design reference: `docs/design/131-claude-api-adapter.md` §0 (TL;DR), §2
 * (adapter precedents), §3 (spawn integration), §6 (cancellation + lifecycle),
 * §8 (engineer-facing skeleton). Verification addendum (2026-04-28) for
 * landmines applied to commit 4.
 */
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { Client, WorkflowHandle } from '@temporalio/client';
import type { Message, AdapterDescriptor } from '../../types';
import { SdkAttachment, type SdkDeliverResult } from '../sdk/base';
import { ENV, getConfig } from '../../config';
import { createTemporalConnection } from '../../connection';
import { pendingMessagesQuery, allMessagesQuery, allSentMessagesQuery, isDestroyedQuery, receiveMessageSignal } from '../../workflows/signals';
import { buildServerInstructions } from '../../server-tools';
import { bootMcpBridge, type McpBridge } from './mcp-bridge';
import { classifyApiError, computeBackoffMs, DEFAULT_RETRY_BUDGET } from './api-error';
import type { Message as TempoMessage, SentMessage } from '../../types';

/**
 * Descriptor for the claude-api adapter. Kept colocated with the class so
 * `adapter.ts` has no import dependency on `index.ts` (breaks the circular
 * module-graph cycle that QA flagged on copilot's PR-B). `index.ts` re-exports
 * this constant alongside the class.
 *
 * Design reference: docs/design/131-claude-api-adapter.md §2 + ADR 0012.
 */
export const claudeApiDescriptor: AdapterDescriptor = {
  adapterId: 'claude-api',
  adapterClass: 'sdk',
  // messages.create blocks on the LLM turn — processingStart/End pairing is
  // mandatory and provided by SdkAttachment.deliver().
  blocksOnLLMTurn: true,
  // SDK class — 30s cadence per design doc + lifecycle-rebuild-v2 §4.3.
  // Inherited from BaseAttachment's heartbeat loop via the descriptor.
  heartbeatMs: 30_000,
};

// Optional dependency — must be installed separately: npm install @anthropic-ai/sdk
// Mirrors the Copilot pattern: when run as the adapter subprocess entry point,
// print an actionable error and exit. When imported by the registry during
// normal MCP server startup, stay silent — the SDK is optional and non-API
// users should see no noise.
let Anthropic: unknown;
try {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  Anthropic = require('@anthropic-ai/sdk').default;
} catch {
  if (require.main === module) {
    console.error(
      'Error: @anthropic-ai/sdk is not installed.\n' +
      'Install it with: npm install @anthropic-ai/sdk\n' +
      'Or recruit with a different agent (claude / copilot).',
    );
    process.exit(1);
  }
}

// Unbuffered logging — fs.writeSync(2, ...) bypasses Node.js stream buffering
// so log lines appear immediately even when stderr is redirected to a file.
// Same pattern the copilot bridge uses for the same reason.
const log = (...args: unknown[]) => {
  const msg = `[agent-tempo:claude-api] ${args.map((a) => typeof a === 'string' ? a : JSON.stringify(a)).join(' ')}\n`;
  fs.writeSync(2, msg);
};

/**
 * Format an unknown thrown value for a single log line. Caps long bodies
 * (Anthropic 4xx error JSON can be hundreds of chars) so individual log
 * lines stay grep-friendly. Used by the #521 retry-classification path.
 */
function truncateErr(err: unknown, max = 240): string {
  const raw = (err as Error)?.message ?? (typeof err === 'string' ? err : JSON.stringify(err));
  if (!raw) return 'unknown';
  return raw.length > max ? raw.slice(0, max) + '…' : raw;
}

/** Default model id — verification addendum §1 (no date suffix on direct API). */
const DEFAULT_MODEL = 'claude-opus-4-7';
/** Idle poll cadence (ms). Matches Copilot bridge — short enough for snappy cue delivery, loose enough not to hammer Temporal. */
const POLL_INTERVAL_MS = 2000;
/** Workflow-register poll loop bounds. */
const WORKFLOW_REGISTER_ATTEMPTS = 30;
const WORKFLOW_REGISTER_INTERVAL_MS = 1000;
/** Workflow status check cadence (every N polls). */
const WORKFLOW_STATUS_CHECK_INTERVAL = 15;
/** Per-turn timeout passed to invokeSdk. Anthropic streams can run minutes for long tool-use chains. */
const TURN_TIMEOUT_MS = 5 * 60 * 1000;
/** Max tokens per assistant turn. Sized for tool-use chains; bounded to prevent runaway billing. */
const MAX_TOKENS_PER_TURN = 8192;
/** Headless-identity addendum appended to the shared instructions per design §10. */
const HEADLESS_ADDENDUM =
  '\n\nYou are a **headless** claude-api player — you have access to the claude-tempo MCP tools ' +
  '(cue, report, recall, ensemble, broadcast, recruit, set_part, …) but **NOT** the file-edit, shell, ' +
  'or web tools that a `claude-code` player would have (no Bash, Read, Write, Edit, Glob, Grep, ' +
  'WebSearch, WebFetch). For tasks requiring file edits or shell commands, ask the conductor to ' +
  'recruit a `claude-code` player and hand off via cue. (File-op tool support is planned for a Phase 2 ' +
  'enhancement.)';

/**
 * SDK-class adapter for the Anthropic Messages API.
 *
 * Delivery model is pull-based (blocks on LLM turn): the adapter polls the
 * workflow for pending messages, runs a tool-use loop against the Messages
 * API (commit 4), and acks via `markDelivered`. `processingStart`/`End`
 * are paired around each blocking turn so the workflow's stale detection
 * doesn't misclassify a long tool-call sequence as a dead session.
 */
export class DirectApiAttachment extends SdkAttachment {
  readonly descriptor: AdapterDescriptor = claudeApiDescriptor;

  /** AbortController stashed during invokeSdk so onSuperseded can abort the in-flight stream. */
  private abortController: AbortController | null = null;
  /** In-process MCP bridge — server + client + cached tool list. Populated by run(). */
  private mcp: McpBridge | null = null;
  /** Anthropic SDK client (typed `unknown` because the SDK is an optional dep). Populated by run(). */
  private apiClient: unknown = null;
  /** Resolved model id (recruit-arg → env → DEFAULT_MODEL). */
  private model: string;
  /** Cached system prompt — built once at session start, stays in the cached prefix every turn. */
  private systemPrompt = '';
  /** Player id stashed for the per-turn telemetry log. */
  private playerName = '';

  constructor(opts: { model?: string } = {}) {
    super();
    this.model = opts.model ?? process.env[ENV.API_MODEL] ?? DEFAULT_MODEL;
  }

  /**
   * Lease-revocation hook — fired by `SdkAttachment` when the base-class
   * phase watcher detects another claimant stole the attachment. Aborts the
   * in-flight `messages.create` via the AbortController wired in
   * `invokeSdk`. Concrete abort wiring lands in commit 4.
   */
  protected onSuperseded(): void {
    const c = this.abortController;
    this.abortController = null;
    if (!c) return;
    log('lease revoked — aborting in-flight messages.create');
    try { c.abort(); } catch (err) { log('abort threw:', (err as Error)?.message ?? err); }
  }

  /**
   * Subprocess entry point. Boots the in-process MCP bridge, connects to
   * Temporal, claims the attachment via V2 lifecycle, and runs the poll loop.
   */
  async run(): Promise<void> {
    if (!Anthropic) {
      throw new Error('@anthropic-ai/sdk not installed — adapter cannot start (this should have been caught by the optional-dep guard above).');
    }
    const config = getConfig();
    const isConductor = process.env[ENV.CONDUCTOR] === 'true';
    const requestedName = process.env[ENV.PLAYER_NAME] || '';
    const playerIdForWorkflow = isConductor
      ? 'conductor'
      : (requestedName && requestedName !== 'conductor' ? requestedName : '') || `claude-api-${Date.now()}`;
    const expectedWorkflowId = `agent-session-${config.ensemble}-${playerIdForWorkflow}`;
    const workDir = process.cwd();

    log(`Starting claude-api adapter in ${workDir} (ensemble: ${config.ensemble}, player: ${playerIdForWorkflow}, model: ${this.model})`);

    // Connect Temporal client — used for workflow polling + claim. The
    // adapter's MCP server uses it too via the shared registerAllTempoTools
    // path so cue/report/recruit/… all reach the right namespace.
    const connection = await createTemporalConnection(config);
    const client = new Client({
      connection,
      namespace: config.temporalNamespace,
    });

    // Hand the client + host to BaseAttachment so startV2Lifecycle can
    // issue claimAttachment + heartbeat against it.
    this.configureV2(client, os.hostname());

    // Wait for the session workflow to register in Temporal (the spawn
    // activity is responsible for starting it; we know the ID deterministically).
    log(`Waiting for workflow ${expectedWorkflowId} to register...`);
    let handle = client.workflow.getHandle(expectedWorkflowId);
    let pinnedRunId: string | undefined;
    let workflowReady = false;
    for (let attempt = 0; attempt < WORKFLOW_REGISTER_ATTEMPTS; attempt++) {
      try {
        const desc = await handle.describe();
        if (desc.status.name === 'RUNNING') {
          workflowReady = true;
          pinnedRunId = desc.runId;
          break;
        }
      } catch { /* not yet started */ }
      await new Promise((r) => setTimeout(r, WORKFLOW_REGISTER_INTERVAL_MS));
      if (attempt % 5 === 4) log(`Still waiting for workflow... attempt ${attempt + 1}/${WORKFLOW_REGISTER_ATTEMPTS}`);
    }
    if (!workflowReady) {
      log(`ERROR: Workflow ${expectedWorkflowId} did not register within ${WORKFLOW_REGISTER_ATTEMPTS}s — exiting`);
      process.exit(1);
    }
    handle = client.workflow.getHandle(expectedWorkflowId, pinnedRunId);
    log(`Workflow ready: ${expectedWorkflowId} (pinned runId ${pinnedRunId})`);

    // Boot the in-process MCP bridge. The adapter's `setPlayerId` is a
    // no-op — headless players don't need rename support (the recruit flow
    // assigns the name at spawn time and it's pinned in the workflow id).
    log('Booting in-process MCP bridge...');
    this.mcp = await bootMcpBridge({
      client,
      config,
      getPlayerId: () => playerIdForWorkflow,
      setPlayerId: () => { /* headless adapter — name is fixed at spawn */ },
      handle,
      workflowId: expectedWorkflowId,
      ownAgentType: 'claude-api',
      isConductor,
    });
    log(`MCP bridge ready — ${this.mcp.tools.length} tools available`);

    // Build the cached system prompt once at session start. Lives under the
    // `cache_control` ephemeral block on every turn (verification addendum
    // §2 + design §5.2) so we pay the cache-create cost on the first turn
    // and ride the cache-read price on every subsequent one. Recruited
    // players have hasRequestedName=true (the spawn activity always passes
    // PLAYER_NAME) so the addendum's `set_name` directive is suppressed.
    this.systemPrompt = buildServerInstructions({
      ensemble: config.ensemble,
      playerId: playerIdForWorkflow,
      isConductor,
      hasRequestedName: true,
    }) + HEADLESS_ADDENDUM;
    this.playerName = playerIdForWorkflow;

    // Construct the Anthropic SDK client. SDK retry is disabled inside the
    // tool-use loop so a 5xx mid-turn doesn't double-execute the previous
    // turn's side-effecting tool calls. Adapter handles failure by exiting
    // cleanly — operator restart picks the message up.
    const AnthropicCtor = Anthropic as new (opts: { apiKey?: string; maxRetries?: number }) => unknown;
    this.apiClient = new AnthropicCtor({
      apiKey: process.env.ANTHROPIC_API_KEY,
      maxRetries: 0,
    });

    // Wire terminal-cleanup hook BEFORE claiming so a race between claim +
    // lease loss can't drop the event.
    let shuttingDown = false;
    const cleanup = async () => {
      if (shuttingDown) return;
      shuttingDown = true;
      log('Cleanup running...');
      // Graceful detach — fires `adapterExited` so the workflow collapses
      // draining → detached immediately. Same pattern Copilot uses.
      try { await this.detachGracefully('user-stop'); }
      catch (err) { log('detachGracefully error:', (err as Error)?.message ?? err); }
      try { await this.mcp?.close(); }
      catch (err) { log('mcp.close error:', (err as Error)?.message ?? err); }
    };
    this.onTerminal((reason) => {
      log(`V2 terminal (${reason}) — triggering cleanup`);
      cleanup().catch((err) => log('terminal cleanup error:', (err as Error)?.message ?? err));
    });

    // V2 path: claim the attachment + start the base-class heartbeat &
    // phase watcher loops. `startV2Lifecycle` returns its own pinned
    // handle; we use that going forward so the heartbeat and delivery
    // share a consistent handle.
    try {
      const expectedAttachmentId = process.env[ENV.ATTACHMENT_ID] || undefined;
      handle = await this.startV2Lifecycle(expectedWorkflowId, expectedAttachmentId);
      log(`V2 attachment claimed (attachmentId=${this.token?.attachmentId}${expectedAttachmentId ? ', renewed' : ''})`);
    } catch (err) {
      log(`ERROR: V2 claimAttachment failed: ${(err as Error)?.message ?? err}`);
      await this.mcp?.close().catch(() => {});
      process.exit(1);
    }

    // PID file so callers can find / kill orphaned adapter processes.
    const pidDir = path.join(workDir, 'logs');
    const pidFile = path.join(pidDir, `${playerIdForWorkflow}.pid`);
    try {
      fs.mkdirSync(pidDir, { recursive: true });
      fs.writeFileSync(pidFile, String(process.pid));
    } catch (err) {
      log(`Warning: PID file write failed: ${(err as Error)?.message ?? err}`);
    }

    // Graceful shutdown handlers. The cleanup fn is idempotent so racing
    // signals are safe.
    const shutdown = async () => {
      log('Shutting down (signal received)...');
      await cleanup();
      try { fs.unlinkSync(pidFile); } catch { /* already gone */ }
      process.exit(0);
    };
    process.on('SIGINT', shutdown);
    process.on('SIGTERM', shutdown);

    // Drive the poll loop until cleanup is requested.
    await this.pollLoop(handle);
    try { fs.unlinkSync(pidFile); } catch { /* already gone */ }
  }

  /**
   * Poll the workflow for pending messages, drive each one through
   * `SdkAttachment.deliver()`. Mirrors the Copilot bridge's loop shape;
   * the LLM call lives in `invokeSdk` (commit 4).
   *
   * Periodic workflow-status checks detect external termination /
   * destroy and exit cleanly so the daemon doesn't accumulate zombie
   * adapter processes after a `destroy` from another player.
   */
  private async pollLoop(handle: WorkflowHandle): Promise<void> {
    let polling = true;
    let processing = false;
    let pollCount = 0;
    // #521: consecutive retriable-failure counter. Reset on every clean
    // deliver; incremented on every retriable verdict; escalated to fatal
    // once it exceeds DEFAULT_RETRY_BUDGET so a sustained outage doesn't
    // wedge the player indefinitely.
    let consecutiveFailures = 0;
    const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

    while (polling && !this.shouldStop()) {
      pollCount++;

      // Periodic workflow status check — detect external destroy / completion.
      if (pollCount % WORKFLOW_STATUS_CHECK_INTERVAL === 0) {
        try {
          const desc = await handle.describe();
          if (desc.status.name !== 'RUNNING') {
            log(`Workflow status is ${desc.status.name} — exiting cleanly`);
            polling = false;
            break;
          }
          try {
            const isDestroyed = await handle.query(isDestroyedQuery);
            if (isDestroyed) {
              log('Workflow destroyed — exiting cleanly');
              polling = false;
              break;
            }
          } catch { /* isDestroyed query unavailable on pre-upgrade workflows — safe to skip */ }
        } catch (err) {
          log(`Workflow describe failed: ${(err as Error)?.message ?? err} — treating as terminated`);
          polling = false;
          break;
        }
      }

      if (processing) {
        await sleep(POLL_INTERVAL_MS);
        continue;
      }

      let messages: Message[] = [];
      try {
        messages = await handle.query(pendingMessagesQuery);
      } catch (err) {
        log(`pendingMessages query failed: ${(err as Error)?.message ?? err}`);
        await sleep(POLL_INTERVAL_MS);
        continue;
      }
      if (messages.length === 0) {
        await sleep(POLL_INTERVAL_MS);
        continue;
      }

      processing = true;
      try {
        // Representative message for processingStart/End pairing; ack the
        // full batch via the deliver() ackIds parameter.
        const ackIds = messages.map((m) => m.id);
        await this.deliver(
          handle,
          messages[0],
          /* prompt unused — invokeSdk reads workflow history directly */ '',
          TURN_TIMEOUT_MS,
          this.invokeSdk.bind(this),
          ackIds,
        );
        // Clean delivery — reset the retry budget so a future transient
        // doesn't compound with stale failure counts.
        consecutiveFailures = 0;
      } catch (err) {
        // #521: classify before retrying. Pre-#521 every error was treated
        // as transient — a non-retriable 4xx (e.g. 400 invalid_request_error
        // for low credits, 401 auth, 403 permission, 404 model) would hot-
        // loop the API forever, burning quota and wedging the player.
        //
        // Lease-revocation path: `onSuperseded` calls `AbortController.abort()`
        // which surfaces as `APIUserAbortError` here. We classify those as
        // fatal but skip the detach call below — the base-class terminal
        // hook has already fired and `shouldStop()` returns true.
        if (this.shouldStop()) {
          log(`deliver error during shutdown — exiting loop: ${(err as Error)?.message ?? err}`);
          polling = false;
          break;
        }

        const verdict = classifyApiError(err);
        log(`deliver error [${verdict.classification}] reason="${verdict.reason}" raw="${truncateErr(err)}"`);

        // Both terminal paths below detach with `agent-exited` then exit
        // the loop. Single helper keeps them obviously parallel.
        const detachAndExit = async (logTag: string): Promise<void> => {
          polling = false;
          await this.detachGracefully('agent-exited').catch((e) =>
            log(`${logTag} detachGracefully error:`, (e as Error)?.message ?? e),
          );
        };

        if (verdict.classification === 'fatal') {
          // Non-retriable. Surface the reason loudly so the operator sees it
          // in the adapter log, then detach gracefully so `attachment_info`
          // shows the player as detached (not stuck in `processing`).
          log(`FATAL: ${verdict.reason} — detaching and exiting (no retry)`);
          await detachAndExit('fatal-detach');
          break;
        }

        consecutiveFailures += 1;
        if (consecutiveFailures > DEFAULT_RETRY_BUDGET) {
          // Retry budget exhausted. Escalate to fatal so we don't hot-loop
          // on a sustained outage.
          log(
            `retry budget exhausted (${consecutiveFailures - 1} consecutive retriable failures; ` +
            `last reason: ${verdict.reason}) — escalating to fatal, detaching and exiting`,
          );
          await detachAndExit('budget-exhausted');
          break;
        }

        const sleepMs = verdict.retryAfterMs ?? computeBackoffMs(consecutiveFailures);
        log(
          `retriable failure ${consecutiveFailures}/${DEFAULT_RETRY_BUDGET} — ` +
          `sleeping ${sleepMs}ms before retry${verdict.retryAfterMs !== undefined ? ' (honoring retry-after)' : ''}`,
        );
        await sleep(sleepMs);
      } finally {
        processing = false;
      }
    }

    log('Poll loop exiting');
  }

  /**
   * Whether the adapter should stop polling — true once `onTerminal` has
   * fired (which sets `shuttingDown` indirectly via cleanup). The flag
   * lives in cleanup's closure scope, so we read terminal state via the
   * base class instead. `BaseAttachment` exposes lifecycle state via
   * `this.token` — null after lease loss or graceful detach.
   */
  private shouldStop(): boolean {
    return this.token === null;
  }

  /**
   * Concrete LLM-turn invocation. Rebuilds conversation state from workflow
   * queries, calls `messages.create({ stream: true })` in a tool-use loop,
   * dispatches tool calls through the in-process MCP bridge, and exits when
   * the model signals `end_turn` / `max_tokens` / context overflow.
   *
   * Verification-addendum landmines applied here:
   *   - **§2.1 thinking-block round-trip**: assistant turns push the FULL
   *     content array (thinking + tool_use blocks together) so the
   *     signature chain stays intact between sub-turns of the loop.
   *   - **§2.2 Opus 4.7 param discipline**: no `temperature`, `top_p`,
   *     `top_k`, or `thinking.budget_tokens` on the request body. We don't
   *     set `thinking` at all — Opus 4.7 defaults to adaptive-omitted.
   *   - **§2.3 cache breakpoints**: `cache_control: { type: 'ephemeral' }`
   *     on the LAST system block and the LAST tool definition (2 of 4
   *     breakpoints used; the marker tells the server where the cached
   *     prefix ENDS, not where it starts).
   *   - **§2.4 input_json_delta**: tool_use input accumulates as a string
   *     and is only `JSON.parse`'d at `content_block_stop`.
   *   - **§2.5 mid-stream errors**: the `for await` loop is wrapped in
   *     try/catch; thrown errors propagate up so `SdkAttachment.deliver`'s
   *     `finally` fires `processingEnd` and the message stays PENDING for
   *     the next poll's retry. No turn-level retry inside the adapter
   *     (avoids double-execution of side-effecting tool calls).
   */
  protected async invokeSdk(_prompt: string, _timeoutMs: number): Promise<SdkDeliverResult> {
    if (!this.mcp || !this.apiClient || !this.pinnedHandle) {
      throw new Error('DirectApiAttachment invokeSdk called before run() finished initialization');
    }
    const handle = this.pinnedHandle;

    // Build the Anthropic message array from workflow history. Parallel
    // queries keep the per-turn latency tight.
    const [received, sent] = await Promise.all([
      handle.query(allMessagesQuery) as Promise<TempoMessage[]>,
      handle.query(allSentMessagesQuery) as Promise<SentMessage[]>,
    ]);
    // The history rebuild yields plain string content; in-loop turns push
    // structured content arrays (assistant: thinking + tool_use blocks per
    // §2.1; user: tool_result blocks). Widen the local variable explicitly
    // so the tool-use-loop pushes typecheck without relaxing the helper's
    // contract.
    const messages: Array<{ role: 'user' | 'assistant'; content: string | unknown[] }> =
      buildAnthropicMessages(received, sent);

    // System + tools both carry an ephemeral cache_control breakpoint at
    // their tail (verification §2.3). 2 of 4 breakpoints used; commit-5
    // could add a third if the conversation tail grows past the cache
    // threshold, but v1 leaves it implicit.
    const system = [{ type: 'text', text: this.systemPrompt, cache_control: { type: 'ephemeral' } }];
    const tools = this.mcp.tools.map((t, i) =>
      i === this.mcp!.tools.length - 1
        ? { ...t, cache_control: { type: 'ephemeral' } }
        : t,
    );

    this.abortController = new AbortController();
    let assistantText = '';
    const t0 = Date.now();
    let stopReason: string | null = null;
    let lastUsage: Record<string, number> | null = null;

    try {
      // Tool-use loop. Each pass is one streaming `messages.create` call;
      // when `stop_reason === 'tool_use'` we dispatch the tools and loop.
      while (true) {
        const apiClient = this.apiClient as { messages: { create: (body: unknown, opts?: unknown) => Promise<AsyncIterable<AnthropicStreamEvent>> } };
        const stream = await apiClient.messages.create({
          model: this.model,
          max_tokens: MAX_TOKENS_PER_TURN,
          system,
          tools,
          messages,
        }, { signal: this.abortController.signal, stream: true });

        // Streaming consumer state — accumulate by content_block index so
        // interleaved tool_use + text + thinking deltas land in the right
        // bucket. Anthropic's stream emits `content_block_start` with an
        // `index`, then deltas tagged with the same index, then `_stop`.
        const blocks: AssistantContentBlock[] = [];
        let turnUsage: Record<string, number> | null = null;
        let turnStopReason: string | null = null;
        try {
          for await (const event of stream) {
            handleStreamEvent(event, blocks);
            if (event.type === 'message_delta') {
              if (event.delta?.stop_reason) turnStopReason = event.delta.stop_reason;
              if (event.usage) turnUsage = { ...(turnUsage ?? {}), ...event.usage };
            } else if (event.type === 'message_start' && event.message?.usage) {
              turnUsage = { ...(turnUsage ?? {}), ...event.message.usage };
            }
          }
        } catch (err) {
          // Verification §2.5 — mid-stream APIError. processingEnd will
          // fire in SdkAttachment.deliver()'s finally; markDelivered will
          // NOT fire (we threw); message stays PENDING; next poll retries.
          log(`stream error mid-turn: ${(err as Error)?.message ?? err}`);
          throw err;
        }

        stopReason = turnStopReason;
        lastUsage = turnUsage ?? lastUsage;

        // Accumulate the assistant's user-facing text from this sub-turn
        // for the markDelivered return value (the workflow doesn't store
        // it — it's just diagnostic — but operators see it in adapter logs).
        for (const b of blocks) {
          if (b.type === 'text') assistantText += b.text;
        }

        // Per-turn telemetry — design §5.6 stderr-only shape. No wire signal in v1.
        if (turnUsage) {
          log(`turn-usage model=${this.model} input=${turnUsage.input_tokens ?? 0} output=${turnUsage.output_tokens ?? 0} cache_create=${turnUsage.cache_creation_input_tokens ?? 0} cache_read=${turnUsage.cache_read_input_tokens ?? 0} elapsed_ms=${Date.now() - t0} player=${this.playerName} stop_reason=${stopReason ?? 'none'}`);
        }

        // Stop conditions.
        if (stopReason === 'end_turn' || stopReason === 'max_tokens') break;
        if (stopReason === 'model_context_window_exceeded') {
          await this.deliverContextOverflowMessage(handle);
          break;
        }
        if (stopReason !== 'tool_use') {
          log(`unexpected stop_reason "${stopReason}" — exiting turn`);
          break;
        }

        // tool_use loop — push the FULL assistant content array (thinking
        // + tool_use blocks per verification §2.1) and dispatch each tool.
        const toolUses = blocks.filter((b): b is AssistantToolUseBlock => b.type === 'tool_use');
        if (toolUses.length === 0) {
          log('stop_reason=tool_use but no tool_use blocks parsed — exiting turn');
          break;
        }

        // Push the assistant message with full content (thinking + tool_use).
        messages.push({ role: 'assistant', content: blocks });

        // Dispatch tools in parallel — they may run side effects (cue,
        // recruit, …) but each is independent within a single turn.
        const toolResults = await Promise.all(toolUses.map(async (tu) => {
          let parsedInput: Record<string, unknown> = {};
          try {
            parsedInput = tu.input ? (JSON.parse(tu.input) as Record<string, unknown>) : {};
          } catch (err) {
            log(`tool_use ${tu.id} (${tu.name}) input JSON.parse failed: ${(err as Error)?.message ?? err}`);
            return {
              type: 'tool_result' as const,
              tool_use_id: tu.id,
              content: `Error: tool input JSON was malformed (${(err as Error)?.message ?? err})`,
              is_error: true,
            };
          }
          try {
            const result = await this.mcp!.callTool(tu.name, parsedInput);
            return {
              type: 'tool_result' as const,
              tool_use_id: tu.id,
              content: result.content,
              is_error: result.isError ?? false,
            };
          } catch (err) {
            log(`tool ${tu.name} dispatch threw: ${(err as Error)?.message ?? err}`);
            return {
              type: 'tool_result' as const,
              tool_use_id: tu.id,
              content: `Error: ${(err as Error)?.message ?? err}`,
              is_error: true,
            };
          }
        }));
        messages.push({ role: 'user', content: toolResults });
      }
    } finally {
      this.abortController = null;
    }

    return {
      sdkResult: { assistantText, stopReason, usage: lastUsage },
      elapsedMs: Date.now() - t0,
    };
  }

  /**
   * Emit a workflow-side message recommending `save_state` + `restart`
   * when Anthropic returns `stop_reason: 'model_context_window_exceeded'`.
   * Design §5.5 — auto-compact via #334 deferred to Phase 2.
   */
  private async deliverContextOverflowMessage(handle: WorkflowHandle): Promise<void> {
    const overflowMessage = [
      '⚠️ **Context window exhausted.**',
      '',
      'The conversation has grown beyond this model\'s context. Recommended actions:',
      '1. `save_state(content: "<curated summary of where you are>")`',
      '2. `restart({ loadFromState: true })` — new session resumes from your saved state',
      '',
      'Alternatively, ask the conductor to recruit a fresh player and hand off via cue.',
    ].join('\n');
    try {
      await handle.signal(receiveMessageSignal, {
        from: 'system',
        text: overflowMessage,
        responseRequested: false,
      });
    } catch (err) {
      log(`context-overflow message signal failed: ${(err as Error)?.message ?? err}`);
    }
  }
}

// ── Anthropic streaming type shims ─────────────────────────────────────
//
// The SDK is an optional dependency, so the adapter can't import its
// types at compile time. These shims model just the fields the streaming
// loop reads — narrow, deliberately permissive (everything not enumerated
// is `unknown`). Drift between these and the SDK is bounded by what the
// loop actually inspects.

interface AnthropicStreamEvent {
  type: string;
  index?: number;
  delta?: { type?: string; text?: string; partial_json?: string; thinking?: string; signature?: string; stop_reason?: string };
  content_block?: { type: string; text?: string; id?: string; name?: string; input?: unknown; thinking?: string };
  message?: { usage?: Record<string, number> };
  usage?: Record<string, number>;
}

interface AssistantTextBlock { type: 'text'; text: string }
interface AssistantToolUseBlock { type: 'tool_use'; id: string; name: string; input: string }
interface AssistantThinkingBlock { type: 'thinking'; thinking: string; signature?: string }
type AssistantContentBlock = AssistantTextBlock | AssistantToolUseBlock | AssistantThinkingBlock;

/**
 * Reduce one `MessageStreamEvent` into the assistant content-block array.
 * Mutates `blocks` in place; same `index` slots map to the same block so
 * interleaved deltas land in the right bucket. Tool input accumulates as
 * a string per verification §2.4 (parsed only by the caller, after
 * `content_block_stop`).
 */
export function handleStreamEvent(event: AnthropicStreamEvent, blocks: AssistantContentBlock[]): void {
  switch (event.type) {
    case 'content_block_start': {
      const idx = event.index ?? blocks.length;
      const cb = event.content_block;
      if (!cb) return;
      if (cb.type === 'text') {
        blocks[idx] = { type: 'text', text: cb.text ?? '' };
      } else if (cb.type === 'tool_use') {
        blocks[idx] = { type: 'tool_use', id: cb.id ?? '', name: cb.name ?? '', input: '' };
      } else if (cb.type === 'thinking') {
        blocks[idx] = { type: 'thinking', thinking: cb.thinking ?? '' };
      }
      // Other block types (e.g. server_tool_use) silently ignored — Phase 2.
      return;
    }
    case 'content_block_delta': {
      const idx = event.index ?? -1;
      const block = blocks[idx];
      const d = event.delta;
      if (!block || !d) return;
      if (d.type === 'text_delta' && block.type === 'text' && d.text) {
        block.text += d.text;
      } else if (d.type === 'input_json_delta' && block.type === 'tool_use' && d.partial_json) {
        // Verification §2.4 — append raw chunks; do NOT JSON.parse here.
        block.input += d.partial_json;
      } else if (d.type === 'thinking_delta' && block.type === 'thinking' && d.thinking) {
        block.thinking += d.thinking;
      } else if (d.type === 'signature_delta' && block.type === 'thinking' && d.signature) {
        // Verification §2.1 — preserve the signature so the next turn's
        // assistant message can replay it for reasoning continuity.
        block.signature = (block.signature ?? '') + d.signature;
      }
      return;
    }
    // content_block_stop / message_start / message_delta / message_stop — handled by caller.
  }
}

/**
 * Merge workflow `Message[]` (received from others) + `SentMessage[]`
 * (sent by this player) into the Anthropic Messages API array.
 *
 *   - Sort chronologically by `timestamp`
 *   - `received` → `role: 'user'`, `sent` → `role: 'assistant'`
 *   - Fold consecutive same-role rows into one message (Anthropic requires
 *     strict user/assistant alternation; multiple cues stacking into the
 *     player's queue must collapse to a single user turn)
 *   - Tag each row with the originator (`[from: <name>]`) on user side so
 *     the model can disambiguate when several players are talking
 *
 * Exported for unit testing (commit 5).
 */
export function buildAnthropicMessages(
  received: TempoMessage[],
  sent: SentMessage[],
): Array<{ role: 'user' | 'assistant'; content: string }> {
  type Row = { role: 'user' | 'assistant'; text: string; ts: string };
  const rows: Row[] = [];
  for (const m of received) rows.push({ role: 'user', text: `[from ${m.from}]: ${m.text}`, ts: m.timestamp });
  for (const m of sent) rows.push({ role: 'assistant', text: m.text, ts: m.timestamp });
  rows.sort((a, b) => a.ts.localeCompare(b.ts));

  const out: Array<{ role: 'user' | 'assistant'; content: string }> = [];
  for (const r of rows) {
    const last = out[out.length - 1];
    if (last && last.role === r.role) {
      last.content += '\n\n' + r.text;
    } else {
      out.push({ role: r.role, content: r.text });
    }
  }
  return out;
}

if (require.main === module) {
  if (!Anthropic) {
    // The optional-dep guard above already exited — this is unreachable in
    // practice but kept for type-narrowing safety on the self-exec path.
    process.exit(1);
  }
  const model = process.env[ENV.API_MODEL];
  new DirectApiAttachment(model ? { model } : {}).run().catch((err) => {
    log('Fatal error:', err);
    process.exit(1);
  });
}
