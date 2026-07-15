/**
 * PR-D of the 2026-07-13 daemon-resilience program — per-worker supervisor.
 * Architect ruling: `docs/research/daemon-resilience-architect-ruling.md`
 * (§1 PR-D, §2 Q1–Q3, §3 exit-code contract); design:
 * `docs/research/daemon-worker-resilience-design.md`.
 *
 * The incident this exists for: 2026-07-13, a fatal worker error (query
 * starvation → Core fatal → `run()` rejection) rode `Promise.all` into the
 * daemon's normal-shutdown epilogue and killed the WHOLE process — HTTP/SSE,
 * the healthy per-host worker, everything — with exit code 0. All ensembles
 * froze ~14.5h because nothing restarts a daemon that claims it exited
 * cleanly.
 *
 * The supervisor gives each worker an independent lifecycle:
 *
 *  - **Fatal `run()` failure** → close the dead worker's NativeConnection,
 *    rebuild a fresh Worker + connection (a FAILED Worker instance is
 *    non-reusable), with capped backoff. HTTP and the other worker never
 *    notice.
 *  - **Create/connect failure** (Temporal unreachable) → indefinite
 *    capped-backoff reconnect + `reconnecting` state, NEVER give-up (ruling
 *    §2 Q1 amendment; posture matches #768's `runHttpBindRetryLoop`).
 *    Restarting the local Temporal server is a routine operation.
 *  - **Restart budget** — counts only `run()` rejections after a successful
 *    create: 5 restarts per rolling 10 min; a run that survived ≥10 min
 *    clears the window (a daily transient never accumulates). Budget
 *    exhausted → `gave-up`: loud `[agent-tempo:ALARM]`, `onGiveUp` callback
 *    (the daemon writes `daemon.last-exit.json` and exits 1).
 *
 * Everything time/IO-shaped is injectable so the whole state machine is
 * unit-testable without a Temporal server (`tests/daemon-worker-supervisor.test.ts`).
 */

// ── Health state (wire shape for `/v1/health.workers`) ───────────────────

/** The two daemon workers, by role. */
export type SupervisedWorkerName = 'shared' | 'host';

/**
 * Wire states (ruling §2 Q2):
 *  - `running`      — worker is polling.
 *  - `restarting`   — last run failed fatally; rebuilding after backoff.
 *  - `reconnecting` — cannot create the worker (Temporal unreachable);
 *                     retrying forever with capped backoff. Also the initial
 *                     state before the first successful create.
 *  - `gave-up`      — restart budget exhausted; the daemon is exiting 1.
 */
export type WorkerSupervisorState = 'running' | 'restarting' | 'reconnecting' | 'gave-up';

/** §4.1 `/v1/health` — one worker's supervisor snapshot. */
export interface WorkerHealthV1 {
  state: WorkerSupervisorState;
  /** Cumulative successful restarts since daemon boot (not the rolling window). */
  restarts: number;
  /** ISO timestamp of the most recent fatal `run()` failure, if any. */
  lastFatalAt?: string;
  /** Message of the most recent fatal `run()` failure (truncated), if any. */
  lastFatalMessage?: string;
}

/** §4.1 `/v1/health` — `workers` field: both supervisors' snapshots. */
export type WorkersHealthV1 = Record<SupervisedWorkerName, WorkerHealthV1>;

/** Bound on persisted/served fatal messages — keeps health payloads and the
 * last-exit marker small no matter what a native error drags along. */
export const FATAL_MESSAGE_MAX_CHARS = 2_048;

/** Truncate an unknown error to a bounded, JSON-safe message string. */
export function fatalMessageOf(err: unknown): string {
  const msg = err instanceof Error ? `${err.name}: ${err.message}` : String(err);
  return msg.length > FATAL_MESSAGE_MAX_CHARS ? `${msg.slice(0, FATAL_MESSAGE_MAX_CHARS)}…` : msg;
}

/**
 * Mutable health registry, one per daemon process. The HTTP `/v1/health`
 * handler reads it via the module-level global below — same pattern as
 * #886's nondeterminism alarm (`getGlobalNondeterminismAlarm`).
 */
export class WorkerHealthRegistry {
  private readonly health: WorkersHealthV1 = {
    // `reconnecting` until the first successful create — semantically
    // "not yet running, trying to establish the worker".
    shared: { state: 'reconnecting', restarts: 0 },
    host: { state: 'reconnecting', restarts: 0 },
  };

  setState(name: SupervisedWorkerName, state: WorkerSupervisorState): void {
    this.health[name].state = state;
  }

  /** Record a fatal `run()` failure (message + timestamp) without moving state. */
  recordFatal(name: SupervisedWorkerName, message: string, atIso: string): void {
    this.health[name].lastFatalAt = atIso;
    this.health[name].lastFatalMessage = message;
  }

  /** Bump the cumulative restart counter (a rebuild after a fatal). */
  recordRestart(name: SupervisedWorkerName): void {
    this.health[name].restarts += 1;
  }

  snapshot(): WorkersHealthV1 {
    return {
      shared: { ...this.health.shared },
      host: { ...this.health.host },
    };
  }
}

let globalRegistry: WorkerHealthRegistry | null = null;

/** Install the daemon's registry so the HTTP health handler can read it. */
export function setGlobalWorkerHealthRegistry(registry: WorkerHealthRegistry): void {
  globalRegistry = registry;
}

/** Read the process-global registry (`null` outside a daemon process). */
export function getGlobalWorkerHealthRegistry(): WorkerHealthRegistry | null {
  return globalRegistry;
}

/**
 * Test-only reset of the module-level singleton. Never call from production
 * code. See docs/adr/0006-test-hooks-naming.md.
 */
export function __resetGlobalWorkerHealthRegistryForTests(): void {
  globalRegistry = null;
}

// ── Supervisor ────────────────────────────────────────────────────────────

/**
 * The slice of `@temporalio/worker.Worker` the supervisor drives. Narrowed
 * so tests can hand in a fake without a Temporal server.
 */
export interface SupervisedWorker {
  run(): Promise<void>;
  shutdown(): void;
}

/** What a worker factory returns: the worker + the NativeConnection to close on death. */
export interface WorkerFactoryResult<W extends SupervisedWorker = SupervisedWorker> {
  worker: W;
  connection: { close(): Promise<void> };
}

/** Passed to `onGiveUp` — everything the last-exit marker needs. */
export interface GiveUpInfo {
  worker: SupervisedWorkerName;
  /** Restart attempts performed since boot (matches `DaemonLastExit.restarts`
   *  semantics: "restart attempts made before giving up"). */
  restarts: number;
  lastFatalMessage: string;
  atIso: string;
}

export interface SuperviseWorkerOpts<W extends SupervisedWorker = SupervisedWorker> {
  name: SupervisedWorkerName;
  /** Build a fresh Worker + NativeConnection. A FAILED Worker is non-reusable. */
  factory: () => Promise<WorkerFactoryResult<W>>;
  /**
   * Already-created first worker (the daemon's boot-time create, which stays
   * fail-fast — the boot guards just proved Temporal reachable, so a failure
   * THERE is a config problem, not an outage to ride out). When present, the
   * first supervision iteration runs it instead of calling `factory`.
   */
  initial?: WorkerFactoryResult<W>;
  /** The daemon's drain latch. Checked before create, after sleeps, after run. */
  isShuttingDown: () => boolean;
  health: WorkerHealthRegistry;
  /**
   * Called with each new Worker instance so the daemon's shutdown handler
   * (which holds mutable refs) always drains the CURRENT instance.
   */
  onWorkerReplaced?: (worker: W) => void;
  /** Fired once, on budget exhaustion, before the supervisor returns 'gave-up'. */
  onGiveUp?: (info: GiveUpInfo) => void;
  /**
   * Re-assert the Temporal Runtime before a rebuild. If BOTH workers happen
   * to be dead at once, `Runtime.deregisterWorker` → `shutdownIfIdle()` tears
   * down the Runtime singleton; the next `Worker.create` would lazily build a
   * DEFAULT Runtime, silently dropping the #886 nondeterminism-alarm logger.
   * The daemon passes its boot-time `Runtime.install` block (guarded against
   * "already instantiated").
   */
  ensureRuntimeInstalled?: () => void;

  /** Restart budget: give up on failure N+1 within the window. Default 5. */
  maxRestarts?: number;
  /** Rolling budget window. Default 10 min. */
  restartWindowMs?: number;
  /** A run that survived this long clears the budget + backoff. Default 10 min. */
  healthyResetMs?: number;
  /** Backoff base/cap for both restart and reconnect delays. Defaults 1s / 30s. */
  backoffBaseMs?: number;
  backoffCapMs?: number;
  /** Reconnect-beacon rate limit (mirrors #768). Default 5 min. */
  beaconIntervalMs?: number;

  // Injectable clocks/IO for tests.
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
  log?: (...args: unknown[]) => void;
}

export type SuperviseOutcome = 'shutdown' | 'gave-up';

/** Capped exponential backoff: base·2^retry, capped. Same curve as #768's
 * `httpBindRetryDelayMs` (local copy — importing from daemon.ts would cycle). */
export function supervisorBackoffMs(retry: number, baseMs = 1_000, capMs = 30_000): number {
  return Math.min(capMs, baseMs * 2 ** Math.min(retry, 31));
}

const DEFAULT_MAX_RESTARTS = 5;
const DEFAULT_RESTART_WINDOW_MS = 10 * 60 * 1000;
const DEFAULT_HEALTHY_RESET_MS = 10 * 60 * 1000;
const DEFAULT_BEACON_INTERVAL_MS = 5 * 60 * 1000;

/** Sleep slice for shutdown-interruptible backoff waits. A 30s backoff must
 * not delay a requested drain past the 15s `hardExit` net, so we sleep in
 * short slices and re-check the latch. */
const SLEEP_SLICE_MS = 250;

/**
 * Run one worker under supervision. Resolves — NEVER rejects — with:
 *  - `'shutdown'`: the daemon requested a drain (the normal exit path);
 *  - `'gave-up'`: the restart budget was exhausted (the daemon should write
 *    the last-exit marker via `onGiveUp` and exit 1).
 */
export async function superviseWorker<W extends SupervisedWorker>(
  opts: SuperviseWorkerOpts<W>,
): Promise<SuperviseOutcome> {
  const {
    name,
    factory,
    isShuttingDown,
    health,
    onWorkerReplaced,
    onGiveUp,
    ensureRuntimeInstalled,
  } = opts;
  const maxRestarts = opts.maxRestarts ?? DEFAULT_MAX_RESTARTS;
  const restartWindowMs = opts.restartWindowMs ?? DEFAULT_RESTART_WINDOW_MS;
  const healthyResetMs = opts.healthyResetMs ?? DEFAULT_HEALTHY_RESET_MS;
  const backoffBaseMs = opts.backoffBaseMs ?? 1_000;
  const backoffCapMs = opts.backoffCapMs ?? 30_000;
  const beaconIntervalMs = opts.beaconIntervalMs ?? DEFAULT_BEACON_INTERVAL_MS;
  const now = opts.now ?? Date.now;
  const sleep = opts.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const log = opts.log ?? ((...args: unknown[]) => console.error('[agent-tempo:daemon]', ...args));

  /** Shutdown-interruptible sleep — returns early (true) if the drain latch flipped. */
  const interruptibleSleep = async (ms: number): Promise<boolean> => {
    const deadline = now() + ms;
    while (now() < deadline) {
      if (isShuttingDown()) return true;
      await sleep(Math.min(SLEEP_SLICE_MS, Math.max(1, deadline - now())));
    }
    return isShuttingDown();
  };

  /** Fatal-failure timestamps inside the rolling window (budget). */
  const fatalTimestamps: number[] = [];
  /** Cumulative rebuilds since boot — reported in GiveUpInfo/health. */
  let restartsPerformed = 0;
  /** Consecutive fatal failures since the last healthy run (drives restart backoff). */
  let consecutiveFatals = 0;
  /** Consecutive create failures (drives reconnect backoff; NEVER budgeted). */
  let reconnectRetries = 0;
  let lastReconnectBeaconAt = -Infinity;
  /** Boot-time pre-created worker — consumed by the first iteration only. */
  let pending: WorkerFactoryResult<W> | null = opts.initial ?? null;

  for (;;) {
    if (isShuttingDown()) return 'shutdown';

    // ── Create phase — reconnect-forever posture (ruling §2 Q1) ──
    let created: WorkerFactoryResult<W>;
    if (pending) {
      created = pending;
      pending = null;
    } else try {
      ensureRuntimeInstalled?.();
      created = await factory();
    } catch (err) {
      health.setState(name, 'reconnecting');
      if (now() - lastReconnectBeaconAt >= beaconIntervalMs) {
        lastReconnectBeaconAt = now();
        log(
          `WARNING: worker '${name}' cannot be created (attempt ${reconnectRetries + 1}) — ` +
          `Temporal unreachable? Retrying every ≤${Math.round(backoffCapMs / 1000)}s, ` +
          `will not give up (ruling §2 Q1): ${fatalMessageOf(err)}`,
        );
      }
      if (await interruptibleSleep(supervisorBackoffMs(reconnectRetries++, backoffBaseMs, backoffCapMs))) {
        return 'shutdown';
      }
      continue;
    }
    reconnectRetries = 0;
    lastReconnectBeaconAt = -Infinity;

    if (isShuttingDown()) {
      // Drain began between create and run. The worker was never run, so
      // `shutdown()` would throw (`Not running`); just release the connection.
      await created.connection.close().catch(() => { /* draining anyway */ });
      return 'shutdown';
    }

    onWorkerReplaced?.(created.worker);
    health.setState(name, 'running');
    const startedAt = now();

    // ── Run phase ──
    let runError: unknown = null;
    let runRejected = false;
    try {
      await created.worker.run();
    } catch (err) {
      runRejected = true;
      runError = err;
    }

    if (isShuttingDown()) {
      // Requested drain: `run()` settling (either way) means the worker is
      // done; release the connection and report the normal outcome.
      await created.connection.close().catch(() => { /* draining anyway */ });
      return 'shutdown';
    }

    // ── Fatal phase — run() settled WITHOUT a requested shutdown ──
    // A rejection is the incident path; a clean resolve without a drain
    // request is equally abnormal (a worker that stops unrequested is not
    // healthy) and takes the same restart path — exit-code contract §3:
    // nothing that wasn't requested may look normal.
    const fatalMsg = runRejected
      ? fatalMessageOf(runError)
      : 'worker.run() resolved without a requested shutdown';
    const atIso = new Date(now()).toISOString();
    log(`[agent-tempo:ALARM] worker-fatal '${name}': ${fatalMsg}`);

    // The failed Worker instance is non-reusable; release its NativeConnection.
    // (When core-bridge finalize failed with "Worker still in use", the native
    // worker leaks — accepted, bounded by the budget; see design §2.2.)
    await created.connection.close().catch(() => { /* best-effort */ });

    // Reset-on-healthy: a long healthy run forgives history (ruling Q1).
    if (now() - startedAt >= healthyResetMs) {
      fatalTimestamps.length = 0;
      consecutiveFatals = 0;
    }

    // Budget: prune the rolling window, admit this failure, give up on the
    // (maxRestarts+1)-th failure inside the window — i.e. after maxRestarts
    // rebuilds have already been spent.
    const cutoff = now() - restartWindowMs;
    while (fatalTimestamps.length > 0 && fatalTimestamps[0] < cutoff) fatalTimestamps.shift();
    fatalTimestamps.push(now());
    health.recordFatal(name, fatalMsg, atIso);

    if (fatalTimestamps.length > maxRestarts) {
      health.setState(name, 'gave-up');
      log(
        `[agent-tempo:ALARM] worker '${name}' gave up after ${maxRestarts} restarts in ` +
        `${Math.round(restartWindowMs / 60_000)}min — daemon exiting 1 ` +
        `(last fatal: ${fatalMsg})`,
      );
      onGiveUp?.({ worker: name, restarts: restartsPerformed, lastFatalMessage: fatalMsg, atIso });
      return 'gave-up';
    }

    health.setState(name, 'restarting');
    health.recordRestart(name);
    restartsPerformed += 1;
    if (await interruptibleSleep(supervisorBackoffMs(consecutiveFatals++, backoffBaseMs, backoffCapMs))) {
      return 'shutdown';
    }
  }
}
