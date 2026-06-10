/**
 * Headless Claude Code adapter — SDK class.
 *
 * Issue #520. Drives the host's installed `claude` CLI (the official Claude
 * Code binary) as a per-turn `claude -p` subprocess. The whole point: tap
 * subscription extra-usage credits via the host's existing OAuth login —
 * the only ToS-clean way for a third-party tool to reach that pool per
 * Anthropic's authentication policy.
 *
 * Mirrors the claude-api / opencode SDK-class adapters: detached Node
 * subprocess, dual-purpose entry point (`require.main === module`),
 * `claimAttachment` + heartbeat lifecycle inherited from `SdkAttachment`.
 *
 * Class hierarchy: `ClaudeCodeHeadlessAttachment extends SdkAttachment extends BaseAttachment`.
 *
 * **Commit progression for #520**:
 *   - PR-1: scaffold — directory layout, descriptor, class skeleton, recruit
 *     pre-flight, AgentType extension, registry registration.
 *   - **PR-2 (this commit)**: lifecycle + subprocess spawn — `run()` connects
 *     Temporal, claims attachment, hydrates session UUID via the shared
 *     `sessionId` metadata field (architect-ratified post-spike — see PR-3
 *     §16 spike-findings appendix), drives the poll loop. `onSuperseded()`
 *     scaffold for the in-flight `claude` subprocess SIGTERM (target hooks
 *     in PR-3). `invokeSdk()` still a stub — calling it throws so the
 *     adapter exits loudly on the first message rather than silently
 *     dropping it.
 *   - PR-3: tool-use loop — stream-json frame parser, --mcp-config inline
 *     JSON synthesis, error-mapper translating subprocess fail modes into
 *     the shared `ApiErrorCategory` classifier (per architect's
 *     ratification of Delta #3).
 *   - PR-4: tests + docs + example lineup.
 *
 * Design reference: `docs/design/520-claude-code-headless-adapter.md` —
 * §0 (TL;DR), §2 (adapter precedents), §3 (spawn integration), §5
 * (streaming + state), §6 (wire-protocol), §7 (engineer-facing skeleton).
 */
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as crypto from 'crypto';
import { spawn, type ChildProcess } from 'child_process';
import { Client, WorkflowHandle } from '@temporalio/client';
import type { AdapterDescriptor, Message, SessionMetadata } from '../../types';
import { SdkAttachment, type SdkDeliverResult } from '../sdk/base';
import { ENV, getConfig, resolveAdapterPidFile } from '../../config';
import { createTemporalConnection } from '../../connection';
import { actionCountingInterceptors, withActionSource } from '../../utils/action-counters';
import {
  pendingMessagesQuery,
  isDestroyedQuery,
  getMetadataQuery,
  updateMetadataSignal,
} from '../../workflows/signals';
import { StreamJsonReader, type TurnAccumulator } from './stream-json';
import {
  mapSubprocessFailure,
  describeFailure,
  type ApiErrorCategory,
} from './error-mapper';
// #536 — pure prompt-build helpers (system-prompt injection +
// MAESTRO_ACK augmentation). Extracted so the per-turn driver below
// stays focused on subprocess I/O.
import {
  buildClaudeArgs,
  buildPromptText,
  buildSdkSystemPrompt,
} from './prompt';

/**
 * Descriptor for the claude-code-headless adapter. Colocated with the
 * class so `adapter.ts` has no import dependency on `index.ts` (avoids
 * the circular module-graph cycle QA flagged on copilot's PR-B).
 *
 * Design reference: `docs/design/520-claude-code-headless-adapter.md` §2.
 */
export const claudeCodeHeadlessDescriptor: AdapterDescriptor = {
  adapterId: 'claude-code-headless',
  adapterClass: 'sdk',
  // `claude -p` blocks until the result frame — processingStart/End pairing
  // is mandatory and provided by SdkAttachment.deliver().
  blocksOnLLMTurn: true,
  // SDK class — 30s cadence per design § / lifecycle-rebuild-v2 §4.3.
  // Inherited from BaseAttachment's heartbeat loop via the descriptor.
  heartbeatMs: 30_000,
};

// Re-export the canonical permission-mode type from `./types` so existing
// consumers that import it from `./adapter` (or from the barrel) keep
// working unchanged. Single source of truth lives in `./types.ts` —
// addresses QA Nit 3 from PR-1's review.
export {
  CLAUDE_CODE_PERMISSION_MODES,
  type ClaudeCodeHeadlessPermissionMode,
} from './types';
import type { ClaudeCodeHeadlessPermissionMode } from './types';

/** Construction options for {@link ClaudeCodeHeadlessAttachment}. */
export interface ClaudeCodeHeadlessAdapterOptions {
  /** `--permission-mode` flag value. Default: `'acceptEdits'`. */
  permissionMode?: ClaudeCodeHeadlessPermissionMode;
  /** Pass `--dangerously-skip-permissions` instead of `--permission-mode`. Mutually exclusive with `permissionMode`. */
  dangerouslySkipPermissions?: boolean;
}

/**
 * Unbuffered stderr logger. `fs.writeSync(2, ...)` bypasses Node.js stream
 * buffering so log lines appear immediately even when stderr is redirected
 * to a file. Same pattern claude-api / opencode use.
 */
const log = (...args: unknown[]) => {
  const msg = `[agent-tempo:claude-code-headless] ${args.map((a) => {
    if (typeof a === 'string') return a;
    if (a instanceof Error) return a.stack ? `${a.message}\n${a.stack}` : a.message;
    try { return JSON.stringify(a); } catch { return String(a); }
  }).join(' ')}\n`;
  fs.writeSync(2, msg);
};

/** Idle poll cadence — short enough for snappy cue delivery, loose on Temporal. */
const POLL_INTERVAL_MS = 2000;
/** Workflow-register poll bounds — same as claude-api/opencode. */
const WORKFLOW_REGISTER_ATTEMPTS = 30;
const WORKFLOW_REGISTER_INTERVAL_MS = 1000;
/** Workflow status check cadence (every N polls). */
const WORKFLOW_STATUS_CHECK_INTERVAL = 15;
/** Per-turn timeout — `claude -p` tool-use chains can run minutes. */
const TURN_TIMEOUT_MS = 5 * 60 * 1000;
/** SIGTERM grace before SIGKILL escalation on the in-flight `claude` subprocess. */
const SIGTERM_GRACE_MS = 5_000;

/**
 * SDK-class adapter that drives `claude -p` as a per-turn subprocess.
 *
 * **PR-2 status**: lifecycle + spawn scaffold complete. `run()` boots the
 * full V2 lifecycle, hydrates the per-cwd session UUID via the shared
 * `sessionId` metadata field, and drives the poll loop. `onSuperseded()`
 * SIGTERMs `this.childProcess` (which PR-3 populates inside `invokeSdk`).
 * `invokeSdk()` still throws — calling it errors the turn loudly until
 * PR-3 wires the per-turn `claude -p` invocation.
 *
 * Lifecycle inherited from `SdkAttachment` / `BaseAttachment`: claim,
 * heartbeat, phase watcher, `processingStart`/`End` pairing,
 * `markDelivered`. No reconnect opt-in (matches claude-api / opencode —
 * the daemon's `reconcile-on-boot` recovers from lease loss).
 */
export class ClaudeCodeHeadlessAttachment extends SdkAttachment {
  readonly descriptor: AdapterDescriptor = claudeCodeHeadlessDescriptor;

  /** `--permission-mode` flag value. Resolved at construction; ENV fallback. */
  protected readonly permissionMode: ClaudeCodeHeadlessPermissionMode;
  /** Whether to use `--dangerously-skip-permissions` instead of permissionMode. */
  protected readonly dangerouslySkipPermissions: boolean;
  /**
   * In-flight per-turn `claude -p` subprocess. Set by PR-3's `invokeSdk`
   * before each turn; cleared after exit. `onSuperseded` reads this to
   * SIGTERM the child on lease revocation.
   */
  protected childProcess: ChildProcess | null = null;
  /**
   * Per-cwd Claude Code session UUID. Used as `--session-id` on the first
   * turn (to PIN the UUID) and `--resume` alone on subsequent turns
   * (mutually exclusive per CLI v2.1.126 — see §16.9). Hydrated from
   * `SessionMetadata.sessionId` on `run()` — generated fresh + stashed if
   * absent. The same field is shared with the interactive Claude Code
   * adapter (architect-ratified Option (a) post-spike — see PR-3 §16).
   */
  protected sessionId: string | null = null;
  /** Cached for the per-turn telemetry log. Populated in `run()`. */
  protected playerName = '';

  constructor(opts: ClaudeCodeHeadlessAdapterOptions = {}) {
    super();
    this.permissionMode = opts.permissionMode
      ?? (process.env[ENV.PERMISSION_MODE] as ClaudeCodeHeadlessPermissionMode | undefined)
      ?? 'acceptEdits';
    this.dangerouslySkipPermissions = opts.dangerouslySkipPermissions === true;
  }

  /**
   * Lease-revocation hook — fired by `SdkAttachment` when the base-class
   * phase watcher detects another claimant stole the attachment.
   *
   * Two-step graceful → forced fallback per design §5.7: SIGTERM first
   * (lets `claude` flush any in-flight stream-json frames + tear down its
   * MCP child cleanly); SIGKILL after {@link SIGTERM_GRACE_MS} grace if it
   * doesn't exit. Identical pattern to opencode/adapter.ts:160-173.
   *
   * Idempotent — racing signals (lease revoke + cleanup) are safe.
   */
  protected onSuperseded(): void {
    const child = this.childProcess;
    this.childProcess = null;
    if (!child) {
      // No in-flight subprocess to kill — common case when superseded
      // fires while the adapter is idle in the poll loop.
      log('lease revoked — no in-flight claude subprocess');
      return;
    }
    log('lease revoked — SIGTERM in-flight claude subprocess');
    try {
      child.kill('SIGTERM');
    } catch (err) {
      log('SIGTERM threw:', (err as Error)?.message ?? err);
    }
    setTimeout(() => {
      if (child.exitCode === null && !child.killed) {
        log(`SIGTERM grace (${SIGTERM_GRACE_MS}ms) expired — escalating to SIGKILL`);
        try {
          child.kill('SIGKILL');
        } catch {
          // Already gone — fine.
        }
      }
    }, SIGTERM_GRACE_MS).unref();
  }

  /**
   * Subprocess entry point. Connects Temporal, waits for the session
   * workflow to register, hydrates the per-cwd session UUID via metadata,
   * claims the attachment via V2 lifecycle, and drives the poll loop.
   *
   * Design reference: §3.6 (env hygiene), §5.1 (session continuity), §7
   * (engineer-facing skeleton).
   */
  async run(): Promise<void> {
    const config = getConfig();
    const isConductor = process.env[ENV.CONDUCTOR] === 'true';
    const requestedName = process.env[ENV.PLAYER_NAME] || '';
    const playerIdForWorkflow = isConductor
      ? 'conductor'
      : (requestedName && requestedName !== 'conductor' ? requestedName : '') || `claude-code-headless-${Date.now()}`;
    const expectedWorkflowId = `agent-session-${config.ensemble}-${playerIdForWorkflow}`;
    const workDir = process.cwd();
    this.playerName = playerIdForWorkflow;

    // §3.6 env-hygiene early warning. ANTHROPIC_API_KEY in the parent env
    // would defeat the whole point of this adapter (subscription billing).
    // The actual env-strip happens in PR-3's invokeSdk before each `claude
    // -p` spawn; this is just a heads-up so operators don't burn an hour
    // wondering why their Console workspace is being charged. The strip is
    // load-bearing — log it loudly.
    if (process.env.ANTHROPIC_API_KEY) {
      log(
        'WARNING: ANTHROPIC_API_KEY is set in the adapter env. ' +
        'The per-turn `claude` child will have it stripped (PR-3) so OAuth ' +
        'subscription billing wins. If you intended Console billing, recruit ' +
        'with `agent: "claude-api"` instead.',
      );
    }
    if (process.env.CLAUDE_CODE_OAUTH_TOKEN) {
      log(
        'WARNING: CLAUDE_CODE_OAUTH_TOKEN is set in the adapter env. ' +
        'The per-turn `claude` child will have it stripped (PR-3) — the ' +
        'host\'s keychain OAuth wins. Set `setup-token` only if you want ' +
        'long-lived non-keychain auth and recruit accordingly.',
      );
    }

    log(`Starting claude-code-headless adapter in ${workDir} (ensemble: ${config.ensemble}, player: ${playerIdForWorkflow}, permissionMode: ${this.dangerouslySkipPermissions ? 'dangerously-skip-permissions' : this.permissionMode})`);

    const connection = await createTemporalConnection(config);
    const client = new Client({
      connection,
      namespace: config.temporalNamespace,
      interceptors: actionCountingInterceptors(),
    });
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

    // Hydrate the per-cwd Claude Code session UUID. Architect-ratified
    // Option (a) post-spike: reuse the existing `sessionId` metadata field
    // (already typed for shared use across Copilot + Claude Code per
    // types.ts JSDoc). Same UUID survives encore / restart / migrate-within-cwd
    // for free since Claude Code's session JSONL is per-cwd, not per-adapter.
    try {
      const meta = await handle.query(getMetadataQuery) as SessionMetadata;
      if (meta.sessionId) {
        this.sessionId = meta.sessionId;
        log(`Resuming Claude Code session ${this.sessionId} from workflow metadata`);
      } else {
        this.sessionId = crypto.randomUUID();
        await handle.signal(updateMetadataSignal, { sessionId: this.sessionId });
        log(`Created new Claude Code session ${this.sessionId}; stashed on workflow metadata`);
      }
    } catch (err) {
      log(`ERROR: session-UUID hydration failed: ${(err as Error)?.message ?? err} — exiting`);
      process.exit(1);
    }

    // Wire terminal-cleanup hook BEFORE claiming so a race between claim +
    // lease loss can't drop the event.
    let shuttingDown = false;
    const cleanup = async () => {
      if (shuttingDown) return;
      shuttingDown = true;
      log('Cleanup running...');
      // SIGTERM any in-flight subprocess via onSuperseded's machinery.
      this.onSuperseded();
      // Graceful detach — fires `adapterExited` so the workflow collapses
      // draining → detached immediately. Same pattern claude-api uses.
      try { await this.detachGracefully('user-stop'); }
      catch (err) { log('detachGracefully error:', (err as Error)?.message ?? err); }
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
      await cleanup();
      process.exit(1);
    }

    // PID file so callers can find / kill orphaned adapter processes.
    // #690 — write/unlink the EXACT path the spawner computed (ENV.PID_FILE) so the
    // adapter pid can't diverge from the spawner's; helper fallback for a manual launch.
    const pidFile = resolveAdapterPidFile(config.ensemble, playerIdForWorkflow);
    try {
      fs.mkdirSync(path.dirname(pidFile), { recursive: true });
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
    // #753 — meter its Temporal calls under 'sdk-poller'.
    await withActionSource('sdk-poller', () => this.pollLoop(handle));
    try { fs.unlinkSync(pidFile); } catch { /* already gone */ }
  }

  /**
   * Poll the workflow for pending messages, drive each one through
   * `SdkAttachment.deliver()`. Mirrors claude-api's loop shape; the LLM
   * call lives in `invokeSdk` (PR-3).
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

      // Periodic workflow-status check — detect external destroy / completion.
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
        const ackIds = messages.map((m) => m.id);
        // The whole batch is delivered as one `claude -p` invocation — the
        // representative `messages[0]` only drives processingStart/End.
        // QA flag from PR-2 review: closure-wrap so `invokeSdkWithBatch`
        // sees `messages` via the captured argument (NOT via instance
        // state — the prior comment claimed "via closure" but the method
        // can't actually read closure-only vars). Mirrors opencode's
        // pattern at `src/adapters/opencode/adapter.ts:443`.
        await this.deliver(
          handle,
          messages[0],
          /* prompt unused — invokeSdkWithBatch reads `messages` from the closure-captured arg */ '',
          TURN_TIMEOUT_MS,
          (timeoutPrompt, timeoutMs) => this.invokeSdkWithBatch(messages, timeoutPrompt, timeoutMs),
          ackIds,
        );
      } catch (err) {
        log(`deliver error: ${(err as Error)?.message ?? err}`);
        // Don't exit the loop — transient failures leave messages PENDING
        // for the next poll. Only terminal events (lease loss, destroy)
        // exit via onTerminal / status-check above.
      } finally {
        processing = false;
      }
    }

    log('Poll loop exiting');
  }

  /** True once `onTerminal` fired and cleanup tore down the V2 token. */
  private shouldStop(): boolean {
    return this.token === null;
  }

  /**
   * Per-turn LLM dispatch. Spawns `claude -p` with the synthesized argv
   * + inline `--mcp-config`, streams stdout through `StreamJsonReader`,
   * and returns the closing `result` frame's assembled text + usage.
   *
   * Closure-captured `messages[]` carries the multi-cue batch (PR-2 QA
   * flag — see `pollLoop` for the closure-wrapping rationale). The
   * representative `_prompt` arg from `SdkAttachment.deliver()` is
   * unused; we build the prompt argv from `messages` directly.
   *
   * `_timeoutMs` is passed through to a Promise.race that SIGTERMs the
   * subprocess on timeout. The base `SdkAttachment.deliver()` doesn't
   * enforce its own timeout — we do it here.
   *
   * Subprocess failures (exit != 0, no result frame, or
   * `result.is_error`) flow through the architect-ratified classifier
   * in `./error-mapper.ts`. The classifier output is logged but the
   * adapter does NOT call `markDelivered` on failure — the message
   * stays PENDING so the next poll picks it up. The adapter's own
   * retry-budget logic (PR-3 follow-up; mirrors #521's claude-api fix)
   * tracks consecutive failures and escalates to detach when N=10
   * `retriable-with-backoff` failures pile up.
   */
  protected async invokeSdkWithBatch(
    messages: Message[],
    _prompt: string,
    timeoutMs: number,
  ): Promise<SdkDeliverResult> {
    if (!this.sessionId) {
      throw new Error('invokeSdkWithBatch called before run() initialized sessionId');
    }
    const sessionId = this.sessionId;
    const t0 = Date.now();

    // Build the prompt — concatenate every queued cue with attribution.
    // Mirrors opencode's `[from ${m.from}]: ${m.text}` shape so operators
    // who switch between adapters see consistent transcript framing.
    // #536 — `buildPromptText` additionally appends MAESTRO_ACK to any
    // message with `isMaestro: true`, mirroring copilot's poll-loop
    // pattern (see `src/adapters/copilot/adapter.ts:639-645`).
    const promptText = buildPromptText(messages);

    // Synthesize the inline --mcp-config JSON. Per design §4 the adapter
    // does NOT translate tool schemas itself; instead `claude` spawns
    // `node dist/server.js` as a stdio MCP child of THE child (a separate
    // process from the adapter). The MCP server picks up the env vars
    // and registers all tempo tools natively.
    const mcpServerPath = path.resolve(__dirname, '..', '..', 'server.js');
    const config = getConfig();
    const mcpConfig = JSON.stringify({
      mcpServers: {
        'agent-tempo': {
          type: 'stdio',
          command: 'node',
          args: [mcpServerPath],
          env: {
            [ENV.ENSEMBLE]: config.ensemble,
            [ENV.PLAYER_NAME]: this.playerName,
            [ENV.TEMPORAL_ADDRESS]: config.temporalAddress,
            [ENV.TEMPORAL_NAMESPACE]: config.temporalNamespace,
          },
        },
      },
    });

    // Build the per-turn argv. `--resume` only on subsequent turns —
    // detect by checking the per-cwd JSONL session file (see design
    // §5.1 and the §11.2 cwd-encoding spike check).
    const sessionFile = path.join(
      os.homedir(),
      '.claude',
      'projects',
      encodeCwd(process.cwd()),
      `${sessionId}.jsonl`,
    );
    const isResume = fs.existsSync(sessionFile);

    // #536 — per-turn system-prompt injection. The shared template
    // (also used by copilot via `sessionConfig.systemMessage`) tells
    // the model to use MCP tools — including `cue` — to reply. Without
    // this the model produced English-prose responses to stdout that
    // the adapter captured and discarded; no cue-back ever surfaced.
    const systemPrompt = buildSdkSystemPrompt({ ensemble: config.ensemble });

    const args = buildClaudeArgs({
      sessionId,
      isResume,
      mcpConfig,
      systemPrompt,
      promptText,
      permissionMode: this.permissionMode,
      dangerouslySkipPermissions: this.dangerouslySkipPermissions,
    });

    // Env hygiene per design §3.6. ANTHROPIC_API_KEY would defeat the
    // adapter's whole point (subscription billing); CLAUDE_CODE_OAUTH_TOKEN
    // would force long-lived OAuth instead of the host's keychain. Strip
    // both. Also strip AGENT_TEMPO_* (adapter-internal — the MCP server
    // child gets its own env block via --mcp-config).
    const childEnv: NodeJS.ProcessEnv = { ...process.env };
    delete childEnv.ANTHROPIC_API_KEY;
    delete childEnv.CLAUDE_CODE_OAUTH_TOKEN;
    for (const k of Object.keys(childEnv)) {
      if (k.startsWith('AGENT_TEMPO_')) delete childEnv[k];
    }

    // Windows: per architect's PR-3 reminder + the established pattern
    // from spawnInTerminal / spawnOpenCodeAdapter, npm-installed binaries
    // land as `.cmd` shims that Node's `CreateProcess` won't run directly
    // and `shell: true` trips DEP0190. Wrap via `cmd.exe /c claude ...`
    // explicitly. Non-Windows hosts spawn `claude` directly.
    const isWindows = process.platform === 'win32';
    const spawnCmd = isWindows ? 'cmd.exe' : 'claude';
    const spawnArgs = isWindows ? ['/c', 'claude', ...args] : args;

    log(`spawning claude -p (sessionId=${sessionId}, resume=${isResume}, permissionMode=${this.dangerouslySkipPermissions ? 'dangerously-skip-permissions' : this.permissionMode}, batch=${messages.length})`);

    const child = spawn(spawnCmd, spawnArgs, {
      stdio: ['ignore', 'pipe', 'pipe'],
      env: childEnv,
      // Don't inherit a controlling TTY — adapter runs headless.
      detached: false,
    });
    this.childProcess = child;

    const reader = new StreamJsonReader({
      onParseError: (line, err) => {
        log(`malformed stream-json frame skipped: ${err.message} — first 120 bytes: ${line.slice(0, 120)}`);
      },
    });
    child.stdout!.on('data', (chunk) => reader.feed(chunk));

    const stderrChunks: string[] = [];
    let stderrBytes = 0;
    const STDERR_CAP = 4096;
    child.stderr!.on('data', (chunk) => {
      const s = chunk.toString('utf8');
      if (stderrBytes < STDERR_CAP) {
        stderrChunks.push(s);
        stderrBytes += s.length;
      }
    });

    // Wait for subprocess exit OR per-turn timeout. The timeout SIGTERMs
    // the child via `onSuperseded`'s machinery (childProcess pointer is
    // set above) — same path the lease-loss abort uses.
    let timedOut = false;
    let timer: ReturnType<typeof setTimeout> | null = null;
    const exitCode = await new Promise<number | null>((resolve) => {
      timer = setTimeout(() => {
        timedOut = true;
        log(`turn timeout (${timeoutMs}ms) — SIGTERMing claude subprocess`);
        try { child.kill('SIGTERM'); } catch (err) { log('SIGTERM threw:', (err as Error)?.message ?? err); }
      }, timeoutMs);
      child.on('exit', (code) => resolve(code));
    });
    if (timer) clearTimeout(timer);

    // Flush any trailing stdout line that arrived without a newline.
    reader.flush();
    this.childProcess = null;

    const turn = reader.snapshot();
    const stderr = stderrChunks.join('');

    // Telemetry — log `apiKeySource: 'none'` from init so operators can
    // confirm OAuth subscription billing is in effect. Architect note
    // from spike comment.
    if (turn.initApiKeySource !== null) {
      log(`init apiKeySource=${turn.initApiKeySource} model=${turn.initModel ?? 'unknown'} (apiKeySource='none' confirms OAuth subscription billing)`);
    }
    if (turn.pluginErrors.length > 0) {
      log(`WARNING: plugin_errors observed: ${JSON.stringify(turn.pluginErrors)}`);
    }

    // Surface informational rate-limit transitions for ops visibility.
    // Architect Constraint #1: status='allowed' is informational — log
    // only the action-required transitions to keep the log signal clean.
    for (const evt of turn.rateLimitEvents) {
      const status = evt.rate_limit_info?.status;
      const overage = evt.rate_limit_info?.overageStatus;
      if (status === 'blocked') {
        log(`WARNING: rate_limit_event status=${status} overageStatus=${overage} — see error-mapper for classifier dispatch`);
      }
    }

    // Per-turn telemetry log (design §5.6). `total_cost_usd` is reported
    // even on subscription billing — it reflects equivalent API cost,
    // not actual subscription burn. Operators should know this.
    log(
      `turn-usage adapter=claude-code-headless model=${turn.initModel ?? 'unknown'} ` +
      `input=${(turn.usage?.['input_tokens'] as number | undefined) ?? 0} ` +
      `output=${(turn.usage?.['output_tokens'] as number | undefined) ?? 0} ` +
      `cache_read=${(turn.usage?.['cache_read_input_tokens'] as number | undefined) ?? 0} ` +
      `cache_create=${(turn.usage?.['cache_creation_input_tokens'] as number | undefined) ?? 0} ` +
      `cost_usd=${turn.totalCostUsd ?? 0} ` +
      `elapsed_ms=${Date.now() - t0} ` +
      `player=${this.playerName} ` +
      `stop_reason=${turn.stopReason ?? 'none'}`,
    );

    // ── Success path ──
    if (
      turn.resultFrameSeen &&
      turn.resultIsError === false &&
      exitCode === 0
    ) {
      return {
        sdkResult: {
          assistantText: turn.assembledText,
          stopReason: turn.stopReason,
          usage: turn.usage,
          totalCostUsd: turn.totalCostUsd,
        },
        elapsedMs: Date.now() - t0,
      };
    }

    // ── Failure path ── classify and surface a useful error.
    const ctx = { exitCode: timedOut ? null : exitCode, stderr, turn };
    const category: ApiErrorCategory = mapSubprocessFailure(ctx);
    const description = describeFailure(ctx);
    log(`classifier=${category}: ${description}`);

    // Throwing here surfaces to `SdkAttachment.deliver()`'s try/finally
    // so `processingEnd` still fires and the message stays PENDING (no
    // markDelivered on failure). The classifier category is logged for
    // future PR-3 follow-up: when #521's shared classifier lands, the
    // adapter's retry-budget logic will read this category and escalate
    // to detach after N=10 consecutive `retriable-with-backoff` failures.
    throw new Error(`claude -p ${category}: ${description}`);
  }
}

/**
 * Encode a cwd into Claude Code's per-cwd project-dir naming scheme.
 * Confirmed empirically in the §11.2 spike check (issue #520) — every
 * `:`, `/`, and `\` becomes `-`. Drive prefixes like `C:\` produce a
 * double-dash (`C--`).
 *
 * Pinned by `tests/adapters/claude-code-headless/cwd-encoding.test.ts`
 * against the captured fixture so a future Claude Code minor bump that
 * changes the scheme breaks loudly here, not silently in resume.
 *
 * Exported for tests only — production callers go through the on-disk
 * sessionFile-exists check in `invokeSdkWithBatch`.
 */
export function encodeCwd(cwd: string): string {
  return cwd.replace(/[\/\\:]/g, '-');
}

// Self-exec entry point — same pattern as claude-api / opencode. When this
// file is launched as `node dist/adapters/claude-code-headless/adapter.js`
// (per the spawn helper in src/spawn.ts), boot the adapter. When imported
// by the registry during normal MCP-server startup, no-op.
if (require.main === module) {
  const opts: ClaudeCodeHeadlessAdapterOptions = {};
  const pmode = process.env[ENV.PERMISSION_MODE] as ClaudeCodeHeadlessPermissionMode | undefined;
  if (pmode) opts.permissionMode = pmode;
  if (process.env[ENV.DANGEROUSLY_SKIP_PERMISSIONS] === '1') opts.dangerouslySkipPermissions = true;
  new ClaudeCodeHeadlessAttachment(opts).run().catch((err) => {
    log('Fatal error:', err);
    process.exit(1);
  });
}
