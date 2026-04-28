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
import { pendingMessagesQuery, allMessagesQuery, allSentMessagesQuery, isDestroyedQuery } from '../../workflows/signals';
import { bootMcpBridge, type McpBridge } from './mcp-bridge';

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
  const msg = `[claude-tempo:claude-api] ${args.map((a) => typeof a === 'string' ? a : JSON.stringify(a)).join(' ')}\n`;
  fs.writeSync(2, msg);
};

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

  /** AbortController stashed during invokeSdk so onSuperseded can abort the in-flight stream (commit 4). */
  private abortController: AbortController | null = null;
  /** In-process MCP bridge — server + client + cached tool list. Populated by run(). */
  private mcp: McpBridge | null = null;
  /** Anthropic SDK client (typed `unknown` because the SDK is an optional dep). Populated by run(). */
  private apiClient: unknown = null;
  /** Resolved model id (recruit-arg → env → DEFAULT_MODEL). */
  private model: string;

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
    const expectedWorkflowId = `claude-session-${config.ensemble}-${playerIdForWorkflow}`;
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
      } catch (err) {
        log(`deliver error: ${(err as Error)?.message ?? err}`);
        // Don't exit the loop — transient failures (network blips,
        // workflow-side update rejections) should leave the message
        // PENDING for the next poll. Only terminal events (lease loss,
        // destroy) exit via the onTerminal / status-check paths above.
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
   * Concrete LLM-turn invocation — wires `messages.create({ stream: true })`
   * + the tool-use loop. **Stub in commit 3**; commit 4 fills in:
   *   - Conversation rebuild from `allMessagesQuery` + `allSentMessagesQuery`
   *   - AsyncIterable streaming consumer (text_delta, tool_use, thinking, usage)
   *   - Tool dispatch via `this.mcp.callTool(...)`
   *   - Verification-addendum landmines: thinking-block round-trip,
   *     Opus 4.7 parameter discipline (no temperature/top_p/top_k/budget),
   *     `input_json_delta` deferred-parse, mid-stream error try/catch
   *   - Cache-control breakpoints (last system + last tool, 2/4 used)
   *   - Per-turn stderr usage log
   *   - Context-overflow message + clean exit
   */
  protected async invokeSdk(_prompt: string, _timeoutMs: number): Promise<SdkDeliverResult> {
    // Commit 3 stub — fail loudly if the poll loop ever drives through.
    // Commit 4 replaces with the real loop. Reference the pull queries
    // here so static analysis confirms the imports survive the stub.
    void allMessagesQuery; void allSentMessagesQuery; void this.mcp;
    throw new Error(
      'DirectApiAttachment.invokeSdk() not yet implemented — commit 4 of #131 Phase C wires the tool-use loop.',
    );
  }
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
