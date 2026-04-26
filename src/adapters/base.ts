/**
 * Base adapter infrastructure.
 *
 * Owns the V2 attachment lifecycle — `claimAttachment`, heartbeat loop,
 * `attachmentInfo` phase watcher, `WorkflowNotFound` terminal handling, and
 * graceful-detach orchestration. PR-H (#132) removed the
 * `CLAUDE_TEMPO_LIFECYCLE_V2=0` escape hatch and its PR-A compat shim path;
 * V2 is now the only path.
 *
 * The `SdkAttachment` intermediate class (processing-signal pairing, split-brain
 * cancellation per §9.3) lives in `src/adapters/sdk/base.ts`.
 *
 * Design reference: docs/design/session-lifecycle-rebuild-v2.md §§3.2, 4.3, 9.1–9.5.
 */
import type { Client, WorkflowHandle } from '@temporalio/client';
import {
  claimAttachmentUpdate,
  heartbeatSignal,
  attachmentInfoQuery,
  adapterExitedSignal,
} from '../workflows/signals';
import type {
  AdapterClass,
  AdapterDescriptor,
  AttachmentToken,
  AttachmentInfo,
  AttachmentPhase,
  DetachReason,
} from '../types';
import { isTerminalWorkflowError } from './terminal-error';
const log = (...args: unknown[]) => console.error('[claude-tempo:adapter]', ...args);

// ── Hypothesis A telemetry (#258 follow-up) ─────────────────────────────
//
// The structured `terminal fire` log shipped in #258 made the next
// adapter-silence incident self-describing — but only for cases where
// `fireTerminal` actually fires. Hypothesis A (process death — crash, OOM,
// Windows sleep, terminal close, SIGKILL) wouldn't produce that log
// because the process never reached the code path. The handlers below
// close that gap: a future #258 recurrence with no `fireTerminal` log AND
// no `adapter-process-terminating` log narrows to a distinct hypothesis
// (likely SIGKILL / abrupt OS termination — file separately).
//
// Design tenets:
//   - **Idempotent registration**: a module-level boolean ensures multiple
//     adapter instances spawning in the same process never double-register
//     handlers. Repeated `installProcessLifecycleTelemetry()` calls no-op.
//   - **Additive only**: every `process.on(...)` call appends; nothing
//     calls `removeAllListeners`. Coexists with the test-cleanup chain in
//     `test/helpers.ts` (#312) and the daemon's own SIGTERM/SIGINT
//     shutdown function.
//   - **Synchronous logging on terminal signals**: process termination
//     doesn't await async log flushes. `console.error` to stderr is
//     synchronous on POSIX + Windows, which is enough.
//   - **No behavior change on uncaughtException**: we register
//     `uncaughtExceptionMonitor` (Node 13.7+) to telemeter without
//     suppressing Node's default crash. If the runtime predates that
//     event, we fall back to `uncaughtException` + `process.exit(1)`
//     which preserves "don't swallow."
//   - **Test gating**: mocha defines `it` globally (vitest with
//     `globals: false` does not). Skip auto-install whenever the test
//     framework signal is present so we don't fight the existing zombie
//     reap in `test/helpers.ts`. The unit tests for these handlers spawn
//     a dedicated child Node process where the gate doesn't fire.

/**
 * Live adapters in this process. Populated by `startV2Lifecycle` after a
 * successful claim; emptied on `stopV2Lifecycle` and `fireTerminal`.
 * Each lifecycle handler iterates this set to build the per-adapter
 * snapshot in the structured log.
 */
const liveAdapters = new Set<BaseAttachment>();

let processLifecycleTelemetryInstalled = false;
let processLifecycleHandlerRefs: Array<{ event: string; handler: (...args: unknown[]) => void }> = [];

/**
 * Should `installProcessLifecycleTelemetry()` actually wire up handlers?
 *
 * - Forced on by `CLAUDE_TEMPO_LIFECYCLE_TELEMETRY=1` (used by the
 *   child-process tests for these handlers — see
 *   `test/adapter-process-lifecycle-telemetry.test.ts`).
 * - Forced off by `CLAUDE_TEMPO_LIFECYCLE_TELEMETRY=0`.
 * - Off when running under mocha (detected via `globalThis.it` —
 *   mocha defines this; vitest with `globals: false` does not).
 * - Off when `NODE_ENV === 'test'` — belt and suspenders.
 * - Otherwise on.
 */
function shouldInstallLifecycleTelemetry(force: boolean): boolean {
  if (force) return true;
  const flag = process.env.CLAUDE_TEMPO_LIFECYCLE_TELEMETRY;
  if (flag === '1' || flag === 'true') return true;
  if (flag === '0' || flag === 'false') return false;
  // Mocha exposes BDD globals (`it`, `describe`, …) on the global object;
  // our vitest config opts out of globals so it doesn't trigger this gate.
  if (typeof (globalThis as { it?: unknown }).it === 'function') return false;
  if (process.env.NODE_ENV === 'test') return false;
  return true;
}

/** Snapshot of adapter state included in every telemetry frame. */
interface AdapterTelemetrySnapshot {
  attachmentId: string | null;
  workflowId: string | null;
  runId: string | null;
  heartbeatsSent: number;
  phaseTicksDone: number;
}

function snapshotLiveAdapters(): AdapterTelemetrySnapshot[] {
  const out: AdapterTelemetrySnapshot[] = [];
  for (const adapter of liveAdapters) {
    out.push(adapter._captureTelemetrySnapshot());
  }
  return out;
}

/**
 * Build the structured frame emitted by every lifecycle handler. Pure
 * function — exposed for unit tests that don't want to spawn a child
 * process.
 */
export function buildProcessTerminatingFrame(
  signal: string,
  errorMessage?: string,
  snapshot: AdapterTelemetrySnapshot[] = snapshotLiveAdapters(),
): string {
  return JSON.stringify({
    event: 'adapter-process-terminating',
    signal,
    ...(errorMessage !== undefined ? { errorMessage } : {}),
    adapterCount: snapshot.length,
    adapters: snapshot,
  });
}

function emitTerminatingLog(signal: string, errorMessage?: string): void {
  // `console.error` synchronously writes to stderr on POSIX + Windows.
  // The `[claude-tempo:adapter]` prefix matches the rest of the adapter
  // logs so a single grep surfaces both the existing `terminal fire`
  // line and these new lifecycle lines for the same incident.
  log(`adapter-process-terminating: ${buildProcessTerminatingFrame(signal, errorMessage)}`);
}

/**
 * Install the process-lifecycle telemetry handlers. Idempotent. Skipped
 * by default in test environments (see {@link shouldInstallLifecycleTelemetry}).
 *
 * Production callers (and the first `startV2Lifecycle()` call on any
 * adapter) invoke without arguments. Unit tests pass `{ force: true }`
 * to bypass the env gate.
 */
export function installProcessLifecycleTelemetry(opts: { force?: boolean } = {}): void {
  if (processLifecycleTelemetryInstalled) return;
  if (!shouldInstallLifecycleTelemetry(opts.force === true)) return;
  processLifecycleTelemetryInstalled = true;

  const handlers: Array<{ event: string; handler: (...args: unknown[]) => void }> = [];

  // `exit` — synchronous, last chance. Don't do async work; just log.
  const onExit = () => emitTerminatingLog('exit');
  process.on('exit', onExit);
  handlers.push({ event: 'exit', handler: onExit as (...args: unknown[]) => void });

  // `beforeExit` — event loop is empty but Node hasn't exited yet.
  const onBeforeExit = () => emitTerminatingLog('beforeExit');
  process.on('beforeExit', onBeforeExit);
  handlers.push({ event: 'beforeExit', handler: onBeforeExit as (...args: unknown[]) => void });

  // SIGTERM — graceful termination request (kill, supervisord, systemd).
  const onSigterm = () => emitTerminatingLog('SIGTERM');
  process.on('SIGTERM', onSigterm);
  handlers.push({ event: 'SIGTERM', handler: onSigterm as (...args: unknown[]) => void });

  // SIGINT — Ctrl+C from a controlling terminal.
  const onSigint = () => emitTerminatingLog('SIGINT');
  process.on('SIGINT', onSigint);
  handlers.push({ event: 'SIGINT', handler: onSigint as (...args: unknown[]) => void });

  // `uncaughtExceptionMonitor` lets us telemeter without suppressing
  // Node's default crash behavior. The default action runs unchanged:
  // print stack, exit non-zero. The codebase's `engines` requirement
  // (Node 20+) guarantees this event is available — Node 13.7+.
  const onUncaughtMonitor = (err: Error) => {
    emitTerminatingLog('uncaughtException', err instanceof Error ? err.message : String(err));
  };
  process.on('uncaughtExceptionMonitor', onUncaughtMonitor);
  handlers.push({ event: 'uncaughtExceptionMonitor', handler: onUncaughtMonitor as (...args: unknown[]) => void });

  // `unhandledRejection` — log only. Adding a listener prevents Node's
  // default crash on unhandled promise rejections (Node 15+); that's
  // intentional per the brief ("log + don't crash").
  const onUnhandled = (reason: unknown) => {
    const msg = reason instanceof Error ? reason.message : String(reason);
    emitTerminatingLog('unhandledRejection', msg);
  };
  process.on('unhandledRejection', onUnhandled);
  handlers.push({ event: 'unhandledRejection', handler: onUnhandled as (...args: unknown[]) => void });

  processLifecycleHandlerRefs = handlers;
}

/** Test-only — uninstall handlers + reset state. */
export function _resetProcessLifecycleTelemetryForTest(): void {
  for (const { event, handler } of processLifecycleHandlerRefs) {
    process.off(event, handler);
  }
  processLifecycleHandlerRefs = [];
  processLifecycleTelemetryInstalled = false;
  liveAdapters.clear();
}

/** Test-only — direct access to the live-adapter set. */
export function _liveAdaptersForTest(): ReadonlySet<BaseAttachment> {
  return liveAdapters;
}

/** Backoff tuning for the heartbeat + phase-watcher loops on transient errors. */
const LOOP_BACKOFF_FACTOR = 1.5;
const LOOP_BACKOFF_MAX_MS = 30_000;

/**
 * Emit a periodic `heartbeats-delivered=N` / `phase-ticks=N` summary every N
 * successful ticks (#249). Chosen so a live claude-code adapter (60s cadence)
 * logs roughly once every 10 minutes and an SDK adapter (30s cadence) once
 * every 5 — rare enough to stay quiet, frequent enough that a 2-hour incident
 * window always contains at least one breadcrumb.
 */
const LOOP_SUMMARY_EVERY = 10;

/**
 * Reconnect tuning (#201). The loop retries `claimAttachment` with exponential backoff
 * bounded by a total elapsed-time budget. Elapsed-time bounds beat retry-count bounds
 * because they map cleanly to user-facing mental models ("waits ~15 min then gives up")
 * and don't drift when the backoff curve changes. 15 min catches the long tail of
 * laptop-sleep events without leaving zombie pollers running forever.
 */
const RECONNECT_TOTAL_BUDGET_MS = 15 * 60_000;
const RECONNECT_BASE_MS = 10_000;
const RECONNECT_MAX_MS = 60_000;
const RECONNECT_BACKOFF_FACTOR = 1.5;

/**
 * #258: tiebreaker timeout for the `describe()` confirmation that gates
 * `fireTerminal('destroy')` from the reconnect-loop pre-check. The Temporal
 * SDK's per-call default is conservative (10s+); we'd rather conclude
 * "describe is hung, treat as terminal" in 3s than freeze the reconnect
 * loop on a slow visibility-API call.
 */
const DESCRIBE_TIMEOUT_MS = 3_000;

/**
 * Workflow execution statuses that are unambiguously terminal — used by
 * the #258 `describe()` tiebreaker to decide whether a transient
 * pre-check error reflects a genuinely-gone workflow (fire destroy) or a
 * transient blip (continue the loop). Anything not in this set, including
 * `RUNNING`, `PAUSED`, `UNSPECIFIED`, and `UNKNOWN`, is treated as
 * non-terminal — conservatively keeps the loop alive when classification
 * is ambiguous.
 */
const TERMINAL_WORKFLOW_STATUSES = new Set<string>([
  'COMPLETED',
  'FAILED',
  'CANCELLED',
  'TERMINATED',
  'CONTINUED_AS_NEW',
  'TIMED_OUT',
]);

/**
 * Override bundle for the reconnect loop timing (#201). Production defaults are
 * tuned for laptop-sleep cycles (15-min elapsed budget, 10s base, 60s cap). Tests
 * override to run the whole loop in <1s. Any field omitted falls back to the
 * production constant.
 */
export interface ReconnectTimingOverrides {
  baseMs?: number;
  maxMs?: number;
  budgetMs?: number;
  backoffFactor?: number;
}

/** Options shared by every adapter extending `BaseAttachment`. */
export interface BaseAttachmentOptions {
  /** Temporal client — required for V2 attachment claim + runId pinning. */
  client?: Client;
  /** Hostname to announce in `claimAttachment`. Defaults to `os.hostname()` when omitted. */
  host?: string;
  /** Test-only: shrink the reconnect backoff/budget. Production callers never set this. */
  reconnectTiming?: ReconnectTimingOverrides;
}

/**
 * Abstract base class for session adapters.
 *
 * Concrete adapters (`InteractiveAttachment`, `CopilotSdkAttachment`) own
 * their own top-level delivery loop. The base class owns the V2 attachment
 * lifecycle: claim, heartbeat at `descriptor.heartbeatMs`, phase-watcher
 * loop, `WorkflowGone` classifier, graceful `adapterExited` on teardown.
 * Subclasses must call `startV2Lifecycle()` before their delivery loop and
 * `stopV2Lifecycle()` on shutdown.
 *
 * PR-H (#132): the `CLAUDE_TEMPO_LIFECYCLE_V2` flag and the legacy V1 poll-
 * only path it gated have been removed. The V2 attachment-lease path is
 * now the only path.
 */
export abstract class BaseAttachment {
  abstract readonly descriptor: AdapterDescriptor;

  /** Populated at construction for InteractiveAttachment; lazily via `configureV2()` for subprocess adapters (Copilot bridge). */
  protected client?: Client;
  protected host?: string;

  /** V2 state — populated by `startV2Lifecycle()`, null on legacy path. */
  protected token: AttachmentToken | null = null;
  /** Handle pinned to the runId returned by `claimAttachment`. Never resolve by ID alone (§6.3). */
  protected pinnedHandle: WorkflowHandle | null = null;
  private heartbeatTimer: ReturnType<typeof setTimeout> | null = null;
  private phaseWatcherTimer: ReturnType<typeof setTimeout> | null = null;
  private heartbeatBackoff = 0;
  private phaseBackoff = 0;
  private stopped = false;
  private terminalFired = false;
  private knownPhase: AttachmentPhase | null = null;
  /**
   * `true` once a heartbeat has successfully landed on the current attachment (or rebind).
   * Cleared on `startV2Lifecycle`, reconnect-loop success, and CAN rebind so each freshly
   * live attachment emits its own `heartbeat#1 delivered` diagnostic. Added in #249 to
   * distinguish "claim OK but heartbeat loop died" from "adapter just hasn't ticked yet."
   */
  private firstHeartbeatLogged = false;
  /**
   * Monotonic heartbeat counter for the current attachment cycle. Reset on
   * claim/reconnect/CAN-rebind. Emitted periodically (every {@link LOOP_SUMMARY_EVERY}
   * ticks) so a long-running session leaves breadcrumbs in the log proving the loop is
   * alive — operators can `grep 'heartbeats-delivered='` to confirm health without
   * parsing Temporal history. Added in #249.
   */
  private heartbeatsSent = 0;
  /**
   * Mirror of {@link heartbeatsSent} for the phase-watcher loop. Same emission cadence,
   * same rationale — the watcher is the only self-heal surface when the heartbeat loop
   * dies silently, so a summary log line proves it's still live too.
   */
  private phaseTicksDone = 0;

  private readonly phaseChangeListeners: Array<(phase: AttachmentPhase) => void> = [];
  private readonly leaseRevokedListeners: Array<(reason: DetachReason) => void> = [];
  private readonly terminalListeners: Array<(reason: DetachReason) => void> = [];

  /**
   * Pending `abortableSleep` cancellers (#201). `stopV2Lifecycle` iterates and invokes
   * each so any in-flight reconnect backoff rejects immediately and the loop unwinds
   * instead of stalling teardown by up to `RECONNECT_MAX_MS`.
   */
  private readonly sleepAborters = new Set<() => void>();

  /**
   * `true` while `runReconnectLoop` is active. Prevents concurrent reconnect attempts
   * (e.g. if both the heartbeat and phase-watcher loops observe the same lease expiry
   * at nearly the same time) and gates heartbeat/watcher ticks from firing new terminals
   * while the reconnect pre-check is still deciding.
   */
  private reconnecting = false;

  /** Reconnect loop timing — production constants unless overridden for tests. */
  private readonly reconnectBaseMs: number;
  private readonly reconnectMaxMs: number;
  private readonly reconnectBudgetMs: number;
  private readonly reconnectBackoffFactor: number;

  constructor(options: BaseAttachmentOptions = {}) {
    this.client = options.client;
    this.host = options.host;
    const t = options.reconnectTiming ?? {};
    this.reconnectBaseMs = t.baseMs ?? RECONNECT_BASE_MS;
    this.reconnectMaxMs = t.maxMs ?? RECONNECT_MAX_MS;
    this.reconnectBudgetMs = t.budgetMs ?? RECONNECT_TOTAL_BUDGET_MS;
    this.reconnectBackoffFactor = t.backoffFactor ?? RECONNECT_BACKOFF_FACTOR;
  }

  /**
   * Lazily populate the V2-path dependencies (Temporal client, host). Used by
   * adapters whose subprocess constructs the client inside `run()` rather
   * than receiving it from the outer process (Copilot bridge). Must be called
   * BEFORE `startV2Lifecycle()`.
   *
   * C3 (PR-C dual-QA follow-up): rejects late reconfiguration — once a claim
   * token has been issued, swapping the client out silently would leave the
   * pinned handle pointing at the previous connection. Future adapters that
   * mis-order the calls fail loudly instead of drifting.
   */
  protected configureV2(client: Client, host: string): void {
    if (this.token) {
      throw new Error(
        'configureV2() called after startV2Lifecycle; configuration must happen before claim',
      );
    }
    this.client = client;
    this.host = host;
  }

  /** Subscribe to `attachmentInfo.phase` changes observed by the watcher. */
  onPhaseChange(listener: (phase: AttachmentPhase) => void): () => void {
    this.phaseChangeListeners.push(listener);
    return () => {
      const i = this.phaseChangeListeners.indexOf(listener);
      if (i >= 0) this.phaseChangeListeners.splice(i, 1);
    };
  }

  /** Subscribe to lease-revocation events (§9.3 split-brain resolution). */
  onLeaseRevoked(listener: (reason: DetachReason) => void): () => void {
    this.leaseRevokedListeners.push(listener);
    return () => {
      const i = this.leaseRevokedListeners.indexOf(listener);
      if (i >= 0) this.leaseRevokedListeners.splice(i, 1);
    };
  }

  /**
   * Hypothesis A telemetry — capture the adapter state included in
   * process-lifecycle log frames. Public so the module-level
   * `snapshotLiveAdapters()` helper can read private fields without an
   * `any` cast; consumers other than the telemetry path should not call it.
   */
  _captureTelemetrySnapshot(): AdapterTelemetrySnapshot {
    return {
      attachmentId: this.token?.attachmentId ?? null,
      workflowId: this.pinnedHandle?.workflowId ?? null,
      runId: this.token?.runId ?? null,
      heartbeatsSent: this.heartbeatsSent,
      phaseTicksDone: this.phaseTicksDone,
    };
  }

  /**
   * Subscribe to terminal events — `WorkflowNotFound` (§9.4) and phase `gone`.
   * Terminal fires at most once per instance. Subclasses stop delivery + exit.
   */
  onTerminal(listener: (reason: DetachReason) => void): () => void {
    this.terminalListeners.push(listener);
    return () => {
      const i = this.terminalListeners.indexOf(listener);
      if (i >= 0) this.terminalListeners.splice(i, 1);
    };
  }

  /**
   * V2 lifecycle entry point. Claims (or renews) the attachment, pins the handle by runId,
   * and starts the heartbeat + phase watcher loops.
   *
   * @param workflowId  Target session workflow id.
   * @param expectedAttachmentId
   *   PR-D renewal path. When present, the adapter was spawned by `restart` or `migrate`
   *   — the workflow has already created an `Attachment` with this id and is
   *   expecting the new adapter to take over. Passing it through to `claimAttachment`
   *   selects the renewal branch in §9.2 (refresh lease in place, idempotent on retry)
   *   instead of the fresh-claim branch. Fresh spawn (first recruit) omits this arg.
   * @returns Pinned `WorkflowHandle` — subclass delivery loop MUST use this for every
   *          subsequent query/signal (never resolve by id alone).
   * @throws  Re-throws `claimAttachment` rejections (`AttachmentConflict`, `WorkflowGone`).
   */
  protected async startV2Lifecycle(
    workflowId: string,
    expectedAttachmentId?: string,
  ): Promise<WorkflowHandle> {
    if (!this.client) {
      throw new Error('BaseAttachment V2 path requires a Temporal client — pass via constructor options');
    }
    if (!this.host) {
      throw new Error('BaseAttachment V2 path requires a host — pass via constructor options');
    }

    const unpinned = this.client.workflow.getHandle(workflowId);
    this.token = await unpinned.executeUpdate(claimAttachmentUpdate, {
      args: [{
        host: this.host,
        adapterId: this.descriptor.adapterId,
        adapterClass: this.descriptor.adapterClass as AdapterClass,
        leaseMs: 3 * this.descriptor.heartbeatMs,
        ...(expectedAttachmentId ? { expectedAttachmentId } : {}),
      }],
    });

    this.pinnedHandle = this.client.workflow.getHandle(workflowId, this.token.runId);
    // Hypothesis A telemetry — register this adapter so a future process-
    // lifecycle handler (exit / SIGTERM / uncaughtException / …) can
    // include its state in the structured log. `installProcessLifecycleTelemetry`
    // is idempotent + env-gated; first call wires the handlers, subsequent
    // calls no-op.
    liveAdapters.add(this);
    installProcessLifecycleTelemetry();
    // #249: reset the per-attachment diagnostic counters so the next tick emits
    // `heartbeat#1 delivered` on the freshly live lease. Without this reset a
    // renewal path (e.g. restart → renewed claim) would never re-log first-heartbeat.
    this.firstHeartbeatLogged = false;
    this.heartbeatsSent = 0;
    this.phaseTicksDone = 0;
    log(
      `${expectedAttachmentId ? 'renewed' : 'attached to'} ${workflowId} ` +
      `(attachmentId=${this.token.attachmentId}, runId=${this.token.runId}); ` +
      `first heartbeat scheduled in ${this.descriptor.heartbeatMs}ms`,
    );

    this.scheduleHeartbeat();
    this.schedulePhaseWatcher();

    return this.pinnedHandle;
  }

  /**
   * Tear down V2 machinery. Idempotent. Called by subclass on stop, on terminal
   * events, and on graceful detach completion.
   *
   * When `graceful=true` (detach owner) we fire `adapterExited` so the workflow
   * collapses `draining → detached` immediately per §11.1.
   */
  protected async stopV2Lifecycle(reason: DetachReason = 'user-stop', graceful = false): Promise<void> {
    if (this.stopped) return;
    this.stopped = true;
    // Hypothesis A telemetry — keep `liveAdapters` accurate so a subsequent
    // process-lifecycle handler firing after stop doesn't include a
    // already-torn-down adapter in its frame.
    liveAdapters.delete(this);

    if (this.heartbeatTimer) {
      clearTimeout(this.heartbeatTimer);
      this.heartbeatTimer = null;
    }
    if (this.phaseWatcherTimer) {
      clearTimeout(this.phaseWatcherTimer);
      this.phaseWatcherTimer = null;
    }

    // #201: a user-initiated stop must abort any in-flight reconnect backoff
    // BEFORE awaiting `adapterExited`, otherwise teardown stalls up to
    // `RECONNECT_MAX_MS` while the sleep timer runs out naturally.
    this.abortSleepers();

    if (graceful && this.pinnedHandle && this.token) {
      try {
        await this.pinnedHandle.signal(adapterExitedSignal, {
          attachmentId: this.token.attachmentId,
          reason,
        });
      } catch (err) {
        // Best-effort — workflow may already have reaped us. Don't fail shutdown.
        log(`adapterExited signal suppressed error: ${(err as Error)?.message ?? err}`);
      }
    }
  }

  private scheduleHeartbeat(): void {
    const delay = this.heartbeatBackoff || this.descriptor.heartbeatMs;
    this.heartbeatTimer = setTimeout(() => { void this.tickHeartbeat(); }, delay);
  }

  /**
   * Emit a loud diagnostic when a tick early-returns via one of its guard paths (#249).
   * Pre-#249 these returns were silent — the only observable effect was "heartbeats stop
   * arriving." Now operators can grep `adapter.*guard tripped` to confirm or rule out
   * tick-orphan as a failure mode without needing workflow history.
   *
   * `terminalFired=true` / `stopped=true` guards are load-bearing on the terminal path
   * (don't want to re-enter terminal) so they're expected during teardown; we still log
   * them but at the same level — operators can correlate timestamps against the preceding
   * `terminal (...) — stopping delivery poll permanently` line.
   */
  private logGuardTrip(loop: 'heartbeat' | 'phase-watcher'): void {
    log(
      `${loop} guard tripped:`,
      JSON.stringify({
        stopped: this.stopped,
        reconnecting: this.reconnecting,
        hasHandle: this.pinnedHandle !== null,
        hasToken: this.token !== null,
        terminalFired: this.terminalFired,
      }),
    );
  }

  /**
   * Single tick of the heartbeat loop. Try/finally scaffolding (#249) guarantees
   * reschedule in every path except genuinely terminal state (`stopped`,
   * `terminalFired`) or when the reconnect loop has taken ownership of scheduling
   * (`reconnecting`). Pre-#249 the three early-return paths at the top + the
   * handled-terminal-error path silently orphaned the timer forever; a transient
   * `reconnecting=true` window or a null-handle race was enough to kill the loop
   * with no log and no teardown.
   *
   * Handled terminals (CAN rebind, destroy) still short-circuit via `return` —
   * the `finally` block re-checks `reconnecting` / `terminalFired` before
   * rescheduling, so the reconnect/terminal machinery keeps ownership of
   * whatever comes next.
   */
  private async tickHeartbeat(): Promise<void> {
    try {
      if (this.stopped || this.terminalFired) {
        this.logGuardTrip('heartbeat');
        return;
      }
      if (this.reconnecting) {
        // Reconnect loop owns reschedule; this tick was queued before the guard
        // flipped. Dropping it is correct — the reconnect path will rearm.
        this.logGuardTrip('heartbeat');
        return;
      }
      if (!this.pinnedHandle || !this.token) {
        // Should be unreachable after `startV2Lifecycle` success — surface loudly
        // if we ever hit it instead of silently orphaning (the pre-#249 behavior).
        this.logGuardTrip('heartbeat');
        return;
      }
      try {
        await this.pinnedHandle.signal(heartbeatSignal, {
          attachmentId: this.token.attachmentId,
          at: new Date().toISOString(),
        });
        this.heartbeatBackoff = 0;
        this.heartbeatsSent++;
        if (!this.firstHeartbeatLogged) {
          this.firstHeartbeatLogged = true;
          log(`heartbeat#1 delivered (attachmentId=${this.token.attachmentId}, runId=${this.token.runId})`);
        } else if (this.heartbeatsSent % LOOP_SUMMARY_EVERY === 0) {
          log(`heartbeats-delivered=${this.heartbeatsSent} (attachmentId=${this.token.attachmentId})`);
        }
      } catch (err) {
        if (await this.handleRunEndError(err)) return;
        this.heartbeatBackoff = Math.min(
          this.heartbeatBackoff ? this.heartbeatBackoff * LOOP_BACKOFF_FACTOR : this.descriptor.heartbeatMs,
          LOOP_BACKOFF_MAX_MS,
        );
        log(`heartbeat transient error (retry in ${Math.round(this.heartbeatBackoff)}ms):`, (err as Error)?.message ?? err);
      }
    } finally {
      if (!this.stopped && !this.reconnecting && !this.terminalFired) {
        this.scheduleHeartbeat();
      }
    }
  }

  private schedulePhaseWatcher(): void {
    // §3.2 item 6: relaxed poll — once per 5 heartbeat intervals.
    const base = this.descriptor.heartbeatMs * 5;
    const delay = this.phaseBackoff || base;
    this.phaseWatcherTimer = setTimeout(() => { void this.tickPhaseWatcher(); }, delay);
  }

  /**
   * Single tick of the phase-watcher loop. Same orphan-resistance scaffolding as
   * {@link tickHeartbeat} (#249): try/finally reschedule, unconditional unless
   * `stopped` / `terminalFired` / `reconnecting`. When the heartbeat loop dies
   * silently, the watcher is the only remaining self-heal surface — losing it
   * too meant the adapter had no path back to a healthy state short of process
   * restart.
   */
  private async tickPhaseWatcher(): Promise<void> {
    try {
      if (this.stopped || this.terminalFired) {
        this.logGuardTrip('phase-watcher');
        return;
      }
      if (this.reconnecting) {
        this.logGuardTrip('phase-watcher');
        return;
      }
      if (!this.pinnedHandle || !this.token) {
        this.logGuardTrip('phase-watcher');
        return;
      }
      try {
        const info: AttachmentInfo = await this.pinnedHandle.query(attachmentInfoQuery);
        this.phaseBackoff = 0;
        this.phaseTicksDone++;
        if (this.phaseTicksDone % LOOP_SUMMARY_EVERY === 0) {
          log(`phase-ticks=${this.phaseTicksDone} (phase=${info.phase}, attachmentId=${this.token.attachmentId})`);
        }

        // #249: if the workflow-side attachment record shows our last heartbeat landed
        // more than 2 * heartbeatMs ago, the heartbeat loop is drifting (or has
        // silently died) even though the lease hasn't yet expired. Loud warning so
        // operators can catch degradation before the reaper fires. Baseline is
        // `claimedAt` on cycles before the first post-claim heartbeat lands.
        if (info.currentAttachment && info.currentAttachment.attachmentId === this.token.attachmentId) {
          const lastBeatMs = new Date(
            info.currentAttachment.lastHeartbeatAt || info.currentAttachment.claimedAt,
          ).getTime();
          const ageMs = Date.now() - lastBeatMs;
          if (ageMs > 2 * this.descriptor.heartbeatMs) {
            log(
              `WARNING: heartbeat staleness — lastHeartbeatAt=${info.currentAttachment.lastHeartbeatAt} ` +
              `age=${ageMs}ms exceeds 2× heartbeatMs (${2 * this.descriptor.heartbeatMs}ms); ` +
              `lease may be about to reap (expiresAt=${info.currentAttachment.expiresAt})`,
            );
          }
        }

        if (this.knownPhase !== info.phase) {
          this.knownPhase = info.phase;
          for (const l of this.phaseChangeListeners) {
            try { l(info.phase); } catch (err) { log('phase listener threw:', err); }
          }
        }

        // Lease revocation (§9.3) — another claimant took over.
        if (
          info.currentAttachment &&
          info.currentAttachment.attachmentId !== this.token.attachmentId
        ) {
          log(`lease revoked: attachmentId ${info.currentAttachment.attachmentId} does not match ours ${this.token.attachmentId}`);
          for (const l of this.leaseRevokedListeners) {
            try { l('superseded'); } catch (err) { log('leaseRevoked listener threw:', err); }
          }
          this.fireTerminalOrReconnect('superseded');
          return;
        }

        // #201: the workflow side reaped our lease (main-loop §9.5.a) without anyone
        // else claiming. This is the laptop-sleep failure mode — `phase=detached` with
        // `currentAttachment=undefined`. Before #201 this branch was silent and the
        // poller kept querying a workflow that had already evicted us, so no cues were
        // delivered until manual `restart`. Now we surface it as a recoverable terminal
        // that the subclass can choose to reconnect through.
        if (info.phase === 'detached' && !info.currentAttachment) {
          log(`lease reaped workflow-side (phase=detached, no current attachment)`);
          for (const l of this.leaseRevokedListeners) {
            try { l('heartbeat-timeout'); } catch (err) { log('leaseRevoked listener threw:', err); }
          }
          this.fireTerminalOrReconnect('heartbeat-timeout');
          return;
        }

        // Phase `gone` is terminal — workflow destroyed. Never recoverable.
        if (info.phase === 'gone') {
          this.fireTerminal('destroy', 'tickPhaseWatcher:phase-gone');
          return;
        }
      } catch (err) {
        if (await this.handleRunEndError(err)) return;
        this.phaseBackoff = Math.min(
          this.phaseBackoff ? this.phaseBackoff * LOOP_BACKOFF_FACTOR : this.descriptor.heartbeatMs,
          LOOP_BACKOFF_MAX_MS,
        );
        log(`phase watcher transient error (retry in ${Math.round(this.phaseBackoff)}ms):`, (err as Error)?.message ?? err);
      }
    } finally {
      if (!this.stopped && !this.reconnecting && !this.terminalFired) {
        this.schedulePhaseWatcher();
      }
    }
  }

  /**
   * Shared error-classification path for the heartbeat + phase-watcher ticks (#226).
   *
   * Returns `true` if the error was a terminal-class (handled inline: CAN rebind
   * kicked off, or destroy fired). Returns `false` when the caller should treat
   * the error as transient and continue its backoff.
   *
   * Always consults `fetchHistory` on any terminal-class error, because the
   * Temporal SDK can't distinguish CAN-close from true-complete at the error
   * level — see {@link isTerminalWorkflowError}. The history lookup is cheap
   * (only runs on terminal, so at most once per adapter lifetime per terminal)
   * and safer than re-querying by workflow id (which could race a fresh session
   * reusing the id).
   */
  private async handleRunEndError(err: unknown): Promise<boolean> {
    if (!isTerminalWorkflowError(err)) return false;
    // Always try to find a CAN successor — the Temporal SDK's error shape is
    // ambiguous between CAN and true-destroy, so history is the only reliable
    // disambiguator (option 1 from the #226 design brief).
    const successorRunId = await this.findCanSuccessorRunId();
    if (successorRunId) {
      this.fireTerminalOrReconnect('continued-as-new', successorRunId);
      return true;
    }
    // No CAN event in the closed run's history → truly terminal (COMPLETED /
    // TERMINATED / FAILED / workflow-id GC'd).
    this.fireTerminal('destroy', 'handleRunEndError:no-can-successor');
    return true;
  }

  /**
   * Fetch the closed pinned run's history and return the runId of a CAN successor
   * if present, else `null`. Scoped to the pinned (old) run via `this.pinnedHandle`,
   * so it can't be fooled by a fresh session that happens to reuse the workflow id.
   *
   * Called only on the terminal path from {@link handleRunEndError}, so the cost
   * of `fetchHistory` (a full event stream for the closed run) is paid at most
   * once per terminal — not on every tick.
   */
  private async findCanSuccessorRunId(): Promise<string | null> {
    if (!this.pinnedHandle) return null;
    try {
      const history = await this.pinnedHandle.fetchHistory();
      const events = history?.events ?? [];
      for (const ev of events) {
        const attrs = ev.workflowExecutionContinuedAsNewEventAttributes;
        const newRunId = attrs?.newExecutionRunId;
        if (newRunId) return newRunId;
      }
      return null;
    } catch (err) {
      log('findCanSuccessorRunId: fetchHistory failed:', (err as Error)?.message ?? err);
      return null;
    }
  }

  /**
   * Fire the terminal hook — the adapter is going dark and won't recover.
   *
   * #258: emits a structured log line on every fire so the next post-CAN
   * silence incident is unambiguous in logs. Pre-#258, a `fireTerminal`
   * from an unexpected source (the root cause was a silent destroy from
   * the reconnect-loop pre-check on a transient terminal-class error) was
   * indistinguishable from process death in workflow history — both produced
   * "no further heartbeats." The structured log includes:
   *
   *   - `reason` — the existing DetachReason
   *   - `callsite` — the calling function or rationale (passed by every
   *     callsite so the source is grep-able without parsing stack traces)
   *   - `attachmentId` / `workflowId` / `runId` — for cross-referencing
   *     against workflow history when bisecting an incident
   *   - `heartbeatsSent` / `phaseTicksDone` — the existing #249 counters
   *     so an operator can correlate "loop alive at N heartbeats, then
   *     terminal fired at this callsite" without external context
   *
   * Idempotent — repeat calls (e.g. reconnect-exhausted re-fires after
   * destroy) early-return without re-logging. The first fire wins.
   */
  private fireTerminal(reason: DetachReason, callsite = 'unspecified'): void {
    if (this.terminalFired) return;
    this.terminalFired = true;
    this.stopped = true;
    // Hypothesis A telemetry — same reasoning as `stopV2Lifecycle`.
    liveAdapters.delete(this);
    log(
      `terminal fire:`,
      JSON.stringify({
        reason,
        callsite,
        attachmentId: this.token?.attachmentId ?? null,
        workflowId: this.pinnedHandle?.workflowId ?? null,
        runId: this.token?.runId ?? null,
        heartbeatsSent: this.heartbeatsSent,
        phaseTicksDone: this.phaseTicksDone,
      }),
    );
    if (this.heartbeatTimer) { clearTimeout(this.heartbeatTimer); this.heartbeatTimer = null; }
    if (this.phaseWatcherTimer) { clearTimeout(this.phaseWatcherTimer); this.phaseWatcherTimer = null; }
    this.abortSleepers();
    for (const l of this.terminalListeners) {
      try { l(reason); } catch (err) { log('terminal listener threw:', err); }
    }
  }

  /**
   * #258 tiebreaker: confirm whether a workflow is genuinely terminal after
   * the reconnect-loop pre-check threw a terminal-class error. Used to
   * distinguish a real workflow-gone state from a transient gRPC /
   * visibility-API blip that classified as terminal.
   *
   * Returns:
   *  - `{ kind: 'running', statusName }` — workflow is alive (any
   *    non-terminal status). Caller should treat the original error as
   *    transient and continue the reconnect loop.
   *  - `{ kind: 'terminal', statusName }` — workflow is in a terminal
   *    status (`COMPLETED` / `FAILED` / `CANCELLED` / `TERMINATED` /
   *    `CONTINUED_AS_NEW` / `TIMED_OUT`). Caller should fire destroy.
   *  - `{ kind: 'describe-threw' }` — `describe()` itself failed. Treat
   *    as terminal (fire destroy) — consistent with pre-#258 semantics
   *    when classification is ambiguous, and avoids spinning forever on
   *    a workflow we can't reach.
   *  - `{ kind: 'timed-out' }` — `describe()` exceeded
   *    {@link DESCRIBE_TIMEOUT_MS}. Treat as terminal (fire destroy) —
   *    same rationale: prefer clean shutdown to a hung loop.
   *
   * The unpinned handle follows any CAN chain to the latest run, so
   * `desc.status.name === 'CONTINUED_AS_NEW'` here means the workflow
   * id itself is closed (no successor) — genuinely terminal.
   */
  private async confirmWorkflowTerminal(
    unpinned: WorkflowHandle,
  ): Promise<
    | { kind: 'running'; statusName: string }
    | { kind: 'terminal'; statusName: string }
    | { kind: 'describe-threw' }
    | { kind: 'timed-out' }
  > {
    let timer: ReturnType<typeof setTimeout> | null = null;
    try {
      const desc = await Promise.race<
        { status: { name: string } } | 'timeout'
      >([
        unpinned.describe() as Promise<{ status: { name: string } }>,
        new Promise<'timeout'>((resolve) => {
          timer = setTimeout(() => resolve('timeout'), DESCRIBE_TIMEOUT_MS);
        }),
      ]);
      if (desc === 'timeout') return { kind: 'timed-out' };
      const statusName = desc.status?.name ?? 'UNKNOWN';
      if (TERMINAL_WORKFLOW_STATUSES.has(statusName)) {
        return { kind: 'terminal', statusName };
      }
      return { kind: 'running', statusName };
    } catch {
      return { kind: 'describe-threw' };
    } finally {
      if (timer) clearTimeout(timer);
    }
  }

  // ───────────────────────────────────────────────────────────────────────────
  // #201 reconnect machinery. Subclasses opt in by overriding `shouldReconnect`.
  // ───────────────────────────────────────────────────────────────────────────

  /**
   * Opt-in reconnect policy. Default: return `false` — the base class behaves
   * exactly as it did before #201 (fire terminal, tear down). Subclasses that
   * can safely replay delivery on a fresh lease should override and return
   * `true` for recoverable reasons (typically `heartbeat-timeout` and
   * `superseded`; never `destroy`).
   *
   * Why opt-in: SDK adapters (e.g. Copilot bridge) have their own subprocess
   * restart logic; double-reconnecting would race their native poller and
   * produce duplicate `pendingMessages` queries. Keep them on the old
   * behavior until we've proven reconnect is safe there.
   */
  protected shouldReconnect(_reason: DetachReason): boolean {
    return false;
  }

  /**
   * Called once, just before the reconnect loop enters its first backoff sleep.
   * Subclasses should tear down any delivery loops that are still polling the
   * stale pinned handle (it may succeed but `markDelivered` will be ignored by
   * the workflow because our `attachmentId` is no longer current). The default
   * is a no-op.
   */
  protected async onReconnectStart(_reason: DetachReason): Promise<void> {
    // Default: nothing to tear down.
  }

  /**
   * Called once on a successful re-claim, with the freshly pinned handle.
   * Subclasses should restart their delivery loop against `handle`. Runs
   * before the base class reschedules its own heartbeat + phase-watcher
   * loops, so the subclass sees a quiescent state.
   *
   * Note: the runId returned by `claimAttachment` may differ from the previous
   * pinned handle's runId (the workflow may have `continueAsNew`'d during the
   * outage), so subclasses MUST use the `handle` argument — never cache a
   * handle from before the reconnect.
   */
  protected async onReconnected(_handle: WorkflowHandle): Promise<void> {
    // Default: nothing to restart.
  }

  /**
   * Sleep `ms` milliseconds, resolving cleanly on timer and rejecting with
   * `aborted:stopped` if `stopV2Lifecycle` or `fireTerminal` fires mid-wait.
   * The canonical pattern for any blocking wait inside an adapter loop —
   * never use bare `setTimeout` + `Promise` in loop code, or teardown stalls.
   */
  protected async abortableSleep(ms: number): Promise<void> {
    if (this.stopped) throw new Error('aborted:stopped');
    await new Promise<void>((resolve, reject) => {
      let aborter: (() => void) | null = null;
      const timer = setTimeout(() => {
        if (aborter) this.sleepAborters.delete(aborter);
        resolve();
      }, ms);
      aborter = () => {
        clearTimeout(timer);
        if (aborter) this.sleepAborters.delete(aborter);
        reject(new Error('aborted:stopped'));
      };
      this.sleepAborters.add(aborter);
    });
  }

  /** Reject every in-flight `abortableSleep`. Called on stop + terminal. */
  private abortSleepers(): void {
    // Snapshot then clear — each aborter mutates the set during iteration.
    const aborters = [...this.sleepAborters];
    this.sleepAborters.clear();
    for (const abort of aborters) {
      try { abort(); } catch (err) { log('sleep aborter threw:', err); }
    }
  }

  /**
   * Consult {@link shouldReconnect}; if true, kick off the reconnect loop in
   * the background (fire-and-forget), otherwise fire terminal synchronously.
   * Called by the heartbeat / phase-watcher ticks instead of `fireTerminal`
   * when the reason is potentially recoverable.
   */
  private fireTerminalOrReconnect(reason: DetachReason, canSuccessorRunId?: string): void {
    if (this.stopped || this.terminalFired || this.reconnecting) return;
    if (!this.shouldReconnect(reason)) {
      this.fireTerminal(reason, 'fireTerminalOrReconnect:not-recoverable');
      return;
    }
    // Pause the heartbeat + watcher loops for the duration of the reconnect.
    this.reconnecting = true;
    if (this.heartbeatTimer) { clearTimeout(this.heartbeatTimer); this.heartbeatTimer = null; }
    if (this.phaseWatcherTimer) { clearTimeout(this.phaseWatcherTimer); this.phaseWatcherTimer = null; }
    log(`reconnect requested (reason=${reason})`);

    // #226: CAN takes the short-circuit rebind path (no backoff, no re-claim —
    // the workflow's §2.3 CAN-boundary lease extension keeps the lease alive
    // across the transition). Every other recoverable reason goes through the
    // full #201 budget-bounded re-claim loop.
    if (reason === 'continued-as-new' && canSuccessorRunId) {
      void this.runCanRebind(canSuccessorRunId).catch((err) => {
        log(`CAN rebind crashed:`, (err as Error)?.message ?? err);
        this.reconnecting = false;
        this.fireTerminal('reconnect-exhausted', 'runCanRebind:crashed');
      });
      return;
    }

    void this.runReconnectLoop(reason).catch((err) => {
      log(`reconnect loop crashed:`, (err as Error)?.message ?? err);
      this.reconnecting = false;
      this.fireTerminal('reconnect-exhausted', 'runReconnectLoop:crashed');
    });
  }

  /**
   * #226 CAN rebind. Transparently repoints `pinnedHandle` at the successor run,
   * keeps the existing `attachmentId` / `leaseMs` (the workflow extended the lease
   * by one heartbeat interval during the CAN transition per §2.3, so the lease is
   * still live on the new run), notifies the subclass to restart its delivery
   * loop, and resumes heartbeat + phase-watcher.
   *
   * Why this is safe without re-claiming:
   *  - The new run carries forward `currentAttachment` verbatim from the old run.
   *  - The adapter's `attachmentId` still matches, so the next `heartbeat` /
   *    `markDelivered` / `adapterExited` signal on the new pinned handle will be
   *    accepted unchanged by the workflow's handlers.
   *  - If the lease actually did expire before we got here (e.g. adapter was
   *    offline through multiple CAN cycles), the next phase-watcher tick on the
   *    new pinned handle will see `phase=detached` + no current attachment and
   *    fall through to the existing #201 reclaim path — belt-and-suspenders.
   */
  private async runCanRebind(newRunId: string): Promise<void> {
    try {
      if (!this.client || !this.pinnedHandle || !this.token) {
        log('runCanRebind: missing client/handle/token — firing terminal');
        this.fireTerminal('reconnect-exhausted', 'runCanRebind:missing-state');
        return;
      }
      const workflowId = this.pinnedHandle.workflowId;
      const oldRunId = this.token.runId;

      try {
        // Tear down any subclass-owned stream against the stale pinned handle
        // before repointing, so the subclass doesn't race itself on the rebuild.
        await this.onReconnectStart('continued-as-new');
      } catch (err) {
        log('onReconnectStart threw:', (err as Error)?.message ?? err);
      }

      const newHandle = this.client.workflow.getHandle(workflowId, newRunId);
      this.pinnedHandle = newHandle;
      // Keep attachmentId + leaseMs (lease carried across CAN); refresh runId so
      // diagnostic logging and any token-based debug output reflect the live run.
      this.token = { ...this.token, runId: newRunId };
      this.knownPhase = null; // force next phase-watcher tick to re-emit phaseChange
      this.heartbeatBackoff = 0;
      this.phaseBackoff = 0;
      // #249: reset per-attachment diagnostic counters so the first post-rebind
      // heartbeat re-logs `heartbeat#1 delivered`. Without this a rebind could
      // mask a dead loop on the successor run — we'd never see the confirmation
      // that heartbeats resumed.
      this.firstHeartbeatLogged = false;
      this.heartbeatsSent = 0;
      this.phaseTicksDone = 0;
      log(
        `rebound ${workflowId} to CAN successor ` +
        `(attachmentId=${this.token.attachmentId}, oldRunId=${oldRunId}, newRunId=${newRunId})`,
      );

      try {
        await this.onReconnected(newHandle);
      } catch (err) {
        log('onReconnected threw:', (err as Error)?.message ?? err);
      }

      // Clear reconnecting BEFORE rescheduling so the first tick after rebind
      // doesn't short-circuit on its own reconnecting-guard. Mirrors the pattern
      // in `runReconnectLoop`'s success path (#206).
      this.reconnecting = false;
      if (!this.stopped) {
        this.scheduleHeartbeat();
        this.schedulePhaseWatcher();
      }
    } finally {
      this.reconnecting = false;
    }
  }

  /**
   * Budget-bounded reconnect loop.
   *
   * Strategy:
   *   1. Sleep (abortable) with exponential backoff from {@link RECONNECT_BASE_MS}
   *      up to {@link RECONNECT_MAX_MS}, capped by an elapsed-time budget of
   *      {@link RECONNECT_TOTAL_BUDGET_MS}.
   *   2. Query `attachmentInfo` via a fresh unpinned handle:
   *        • workflow gone → fire `destroy`, exit.
   *        • phase `gone` → fire `destroy`, exit.
   *        • someone else holds the lease → fire `superseded`, exit (architect §1).
   *        • phase `draining` → wait another tick (lease about to reap).
   *        • otherwise → attempt fresh `claimAttachment`.
   *   3. On successful claim: rebuild `this.pinnedHandle` from the **new** token's
   *      `runId` (workflow may have `continueAsNew`'d during outage), reset loop
   *      state, call subclass hooks, restart heartbeat + watcher.
   *
   * Fires `reconnect-exhausted` on budget exhaustion. Exits silently (without
   * firing terminal) on abort — `stopV2Lifecycle` owns teardown messaging.
   */
  private async runReconnectLoop(initialReason: DetachReason): Promise<void> {
    // Single try/finally so `reconnecting` always resets no matter how we exit
    // — success path, any fireTerminal, abort-during-sleep, or an unexpected
    // throw. #206 fixed the prior abort-catch path that leaked `reconnecting=true`
    // if `stopV2Lifecycle` aborted the backoff sleep.
    try {
      if (!this.client || !this.host || !this.token || !this.pinnedHandle) {
        log('runReconnectLoop: missing client/host/token/handle — aborting');
        this.fireTerminal('reconnect-exhausted', 'runReconnectLoop:missing-state');
        return;
      }

      const workflowId = this.pinnedHandle.workflowId;
      const oldAttachmentId = this.token.attachmentId;

      try {
        await this.onReconnectStart(initialReason);
      } catch (err) {
        log('onReconnectStart threw:', (err as Error)?.message ?? err);
      }

      const deadline = Date.now() + this.reconnectBudgetMs;
      let backoff = this.reconnectBaseMs;
      let attempt = 0;

      while (!this.stopped && Date.now() < deadline) {
        attempt++;
        log(`reconnect attempt ${attempt} (sleep ${Math.round(backoff)}ms)`);
        try {
          await this.abortableSleep(backoff);
        } catch {
          // User-initiated stop during sleep — teardown already owns the rest.
          // The finally block still resets `reconnecting` so a subsequent
          // reclaim attempt (hypothetical — stop normally ends the adapter) would
          // find clean state. #206.
          log('reconnect aborted by stop during backoff');
          return;
        }
        if (this.stopped) return;

        // §Pre-check (architect §1): query attachmentInfo via a fresh unpinned handle.
        // The old pinned handle's runId may be stale after a continueAsNew.
        const unpinned = this.client.workflow.getHandle(workflowId);
        let info: AttachmentInfo;
        try {
          info = await unpinned.query(attachmentInfoQuery);
        } catch (err) {
          if (isTerminalWorkflowError(err)) {
            // #258: ONE terminal-class pre-check error is not enough evidence
            // to destroy the adapter. The classifier matches phrasings
            // (`WorkflowNotFound`, `NOT_FOUND`, "workflow execution already
            // completed") that can ALSO surface from transient gRPC blips and
            // momentary visibility-API hiccups. Pre-#258, this branch fired
            // `fireTerminal('destroy')` immediately — a single transient
            // error orphaned the adapter for the rest of the session
            // (heartbeat + watcher dead via `terminalFired`, poller torn
            // down by `onReconnectStart` + `onTerminal` listener).
            //
            // Tiebreaker: confirm with `describe()` against the same unpinned
            // handle. If the workflow is genuinely gone, `describe()` will
            // either return a closed status (COMPLETED/TERMINATED/...) or
            // itself throw — fire destroy with confidence. If it returns
            // RUNNING (or any non-terminal status), the original error was
            // transient — log and continue the loop. Bounded by
            // `DESCRIBE_TIMEOUT_MS` so a slow visibility-API call can't hang
            // the reconnect path indefinitely.
            const errClass = (err as Error)?.name ?? 'unknown';
            const errMsg = (err as Error)?.message ?? String(err);
            const tiebreak = await this.confirmWorkflowTerminal(unpinned);
            if (tiebreak.kind === 'running') {
              log(
                `reconnect: pre-check threw ${errClass} but describe() shows ` +
                `${tiebreak.statusName} — treating as transient, continuing loop ` +
                `(originalError="${errMsg}")`,
              );
              backoff = Math.min(backoff * this.reconnectBackoffFactor, this.reconnectMaxMs);
              continue;
            }
            const confirmDesc = tiebreak.kind === 'terminal'
              ? `describe() confirmed ${tiebreak.statusName}`
              : `describe() ${tiebreak.kind === 'describe-threw' ? 'threw' : 'timed out'}`;
            log(
              `reconnect: pre-check terminal (${errClass}) and ${confirmDesc} — firing destroy ` +
              `(originalError="${errMsg}")`,
            );
            this.fireTerminal('destroy', 'runReconnectLoop:precheck-terminal-confirmed');
            return;
          }
          backoff = Math.min(backoff * this.reconnectBackoffFactor, this.reconnectMaxMs);
          log(`reconnect pre-check transient error (next backoff ${Math.round(backoff)}ms):`, (err as Error)?.message ?? err);
          continue;
        }

        if (info.phase === 'gone') {
          log('reconnect: phase=gone — giving up');
          this.fireTerminal('destroy', 'runReconnectLoop:phase-gone');
          return;
        }
        if (info.currentAttachment && info.currentAttachment.attachmentId !== oldAttachmentId) {
          log(`reconnect: another adapter holds the lease (${info.currentAttachment.attachmentId}) — bailing`);
          this.fireTerminal('superseded', 'runReconnectLoop:other-holder');
          return;
        }
        if (info.phase === 'draining') {
          // About to reap — give the workflow one more tick to finish collapsing.
          backoff = Math.min(backoff * this.reconnectBackoffFactor, this.reconnectMaxMs);
          log(`reconnect: phase=draining, waiting (next backoff ${Math.round(backoff)}ms)`);
          continue;
        }

        // §Claim: attempt a fresh `claimAttachment` (no expectedAttachmentId — our
        // previous lease is revoked, this is a fresh claim from the workflow's POV).
        try {
          const newToken = await unpinned.executeUpdate(claimAttachmentUpdate, {
            args: [{
              host: this.host,
              adapterId: this.descriptor.adapterId,
              adapterClass: this.descriptor.adapterClass as AdapterClass,
              leaseMs: 3 * this.descriptor.heartbeatMs,
            }],
          });

          // Success — rebuild pinned handle from the NEW runId and hand it to the subclass.
          this.token = newToken;
          this.pinnedHandle = this.client.workflow.getHandle(workflowId, newToken.runId);
          this.knownPhase = null; // force the next phase-watcher tick to re-emit phaseChange
          this.heartbeatBackoff = 0;
          this.phaseBackoff = 0;
          // #249: reset per-attachment diagnostic counters so the first post-reconnect
          // heartbeat re-logs `heartbeat#1 delivered`. Parity with CAN rebind path.
          this.firstHeartbeatLogged = false;
          this.heartbeatsSent = 0;
          this.phaseTicksDone = 0;
          log(
            `reconnected to ${workflowId} after ${attempt} attempt(s) ` +
            `(new attachmentId=${newToken.attachmentId}, runId=${newToken.runId})`,
          );

          try {
            await this.onReconnected(this.pinnedHandle);
          } catch (err) {
            log('onReconnected threw:', (err as Error)?.message ?? err);
          }

          // Clear the reconnecting flag BEFORE rescheduling so the first
          // heartbeat/watcher tick after reconnect doesn't short-circuit on
          // its own `this.reconnecting` guard. The finally block reasserts
          // `reconnecting=false` after return; this early assignment is the
          // one that matters for loop wiring.
          this.reconnecting = false;
          if (!this.stopped) {
            this.scheduleHeartbeat();
            this.schedulePhaseWatcher();
          }
          return;
        } catch (err) {
          if (isTerminalWorkflowError(err)) {
            log('reconnect: workflow gone during claim');
            this.fireTerminal('destroy', 'runReconnectLoop:claim-terminal');
            return;
          }
          backoff = Math.min(backoff * this.reconnectBackoffFactor, this.reconnectMaxMs);
          log(`reconnect claim failed (next backoff ${Math.round(backoff)}ms):`, (err as Error)?.message ?? err);
        }
      }

      // Budget exhausted — give up cleanly.
      log(`reconnect budget exhausted after ${attempt} attempt(s)`);
      this.fireTerminal('reconnect-exhausted', 'runReconnectLoop:budget-exhausted');
    } finally {
      // Guarantee state reset regardless of which path we exited on. Safe to
      // assign unconditionally — a successful reconnect also ends up here after
      // the early assignment inside the success path (the early one is needed
      // so tick reschedulers see `reconnecting=false`; this one is belt-and-
      // suspenders for the abort/throw/terminal paths).
      this.reconnecting = false;
    }
  }
}

/**
 * Registry of adapter descriptors keyed by `adapterId`.
 *
 * Look up the descriptor for a given session by `SessionMetadata.adapterId` (or
 * fall back to `'claude-code'` for pre-v0.25 sessions that have no adapterId set).
 * `src/adapters/index.ts` creates the singleton `registry` and registers all
 * shipped adapters at import time.
 */
export class AdapterRegistry {
  private readonly byId = new Map<string, AdapterDescriptor>();

  /** Register an adapter descriptor. Replaces any existing entry with the same id. */
  register(desc: AdapterDescriptor): void {
    this.byId.set(desc.adapterId, desc);
  }

  /**
   * Fetch the descriptor for `adapterId`. Throws if unregistered.
   *
   * Callers resolving from possibly-undefined metadata should coalesce first:
   * `registry.get(metadata.adapterId ?? 'claude-code')`.
   */
  get(adapterId: string): AdapterDescriptor {
    const desc = this.byId.get(adapterId);
    if (!desc) {
      const known = [...this.byId.keys()].join(', ') || '(none registered)';
      throw new Error(`Unknown adapter "${adapterId}". Registered: ${known}`);
    }
    return desc;
  }

  /** `true` if `adapterId` is registered. */
  has(adapterId: string): boolean {
    return this.byId.has(adapterId);
  }

  /** Snapshot of all registered descriptors. */
  all(): readonly AdapterDescriptor[] {
    return [...this.byId.values()];
  }

  /**
   * Resolve an `adapterId` from the legacy `agent` field on {@link SessionMetadata}.
   * Maps `'claude'` → `'claude-code'`, `'copilot'` → `'copilot'`.
   *
   * Used as a fallback when `adapterId` is not yet populated on the session metadata
   * (e.g. sessions started before PR-B landed). PR-D removes this mapping when the
   * legacy `AgentType` enum is retired.
   */
  resolveFromAgentType(agent: string | undefined): string {
    if (agent === 'copilot') return 'copilot';
    return 'claude-code';
  }
}

export type { AdapterClass, AdapterDescriptor };
