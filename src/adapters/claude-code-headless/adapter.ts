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
import type { ChildProcess } from 'child_process';
import { Client, WorkflowHandle } from '@temporalio/client';
import type { AdapterDescriptor, Message, SessionMetadata } from '../../types';
import { SdkAttachment, type SdkDeliverResult } from '../sdk/base';
import { ENV, getConfig } from '../../config';
import { createTemporalConnection } from '../../connection';
import {
  pendingMessagesQuery,
  isDestroyedQuery,
  getMetadataQuery,
  updateMetadataSignal,
} from '../../workflows/signals';

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
  const msg = `[claude-tempo:claude-code-headless] ${args.map((a) => {
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
   * Per-cwd Claude Code session UUID. Used as both `--session-id` (every
   * turn) and `--resume` (subsequent turns; see design §5.1). Hydrated from
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
    const expectedWorkflowId = `claude-session-${config.ensemble}-${playerIdForWorkflow}`;
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
        // PR-3's invokeSdk reads `messages` directly via closure to build
        // the prompt argv.
        await this.deliver(
          handle,
          messages[0],
          /* prompt unused — invokeSdk reads `messages` directly via closure */ '',
          TURN_TIMEOUT_MS,
          (timeoutPrompt, timeoutMs) => this.invokeSdk(timeoutPrompt, timeoutMs),
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
   * Per-turn LLM dispatch. **PR-3** — currently a stub.
   *
   * Will spawn `claude -p --output-format stream-json --verbose
   * --strict-mcp-config --mcp-config <inline-json> --session-id <uuid>
   * [--resume <uuid>] --permission-mode <mode>`, parse stream-json frames
   * via `stream-json.ts`, and return the assembled assistant text +
   * stop_reason + usage from the closing `result` frame.
   *
   * For PR-2 the body throws — the poll loop catches it and the message
   * stays PENDING for the next poll. This is the loud-failure path: a
   * silent no-op would leave operators wondering why their cue went into
   * a black hole. Once PR-3 lands the real implementation drops in.
   */
  protected async invokeSdk(_prompt: string, _timeoutMs: number): Promise<SdkDeliverResult> {
    throw new Error(
      'claude-code-headless adapter invokeSdk() not yet implemented (PR-3 wires the per-turn `claude -p` tool-use loop). ' +
      `Adapter is otherwise alive — sessionId=${this.sessionId}, permissionMode=${this.dangerouslySkipPermissions ? 'dangerously-skip-permissions' : this.permissionMode}.`,
    );
  }
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
