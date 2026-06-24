/**
 * Nondeterminism alarm (#886 slice 1).
 *
 * The #801 incident produced **57 workflow-task failures in 3 minutes with
 * ZERO operator signal** — a nondeterminism flap (a 2.0 worker replaying a
 * 1.x-recorded history, or a code/bundle skew) surfaces only as Temporal's
 * own `WARN`-level Core log line, buried in `daemon.log` among normal chatter.
 * Nothing NAMED the flap, counted it, or raised its severity.
 *
 * This module gives the daemon a tiny, process-global counter that:
 *   1. Intercepts Temporal Runtime log records (via {@link wrapLoggerWithAlarm},
 *      installed in the daemon's `Runtime.install({ logger })`).
 *   2. Classifies nondeterminism / determinism-violation records
 *      ({@link isNondeterminismLog}) — wording-tolerant, like the SA-preflight
 *      marker set, so a Core/SDK phrasing change can't silently disarm it.
 *   3. PROMOTES each hit to a prominent, greppable `[agent-tempo:ALARM]` line
 *      with a running count — so a flap is named the instant it starts.
 *   4. Keeps a small rolling snapshot ({@link NondeterminismAlarm.snapshot})
 *      surfaced on `GET /v1/health` so external monitors / the dashboard can
 *      poll the alarm state without scraping logs.
 *
 * **Temporal-VALUE-free by design:** this module imports only the `Logger`
 * TYPE from `@temporalio/common` (erased at compile). The worker `Runtime` /
 * `DefaultLogger` VALUES are imported by the daemon, which wraps a real logger
 * with {@link wrapLoggerWithAlarm} and installs it. That keeps the HTTP layer
 * (`/v1/health`) able to read {@link getGlobalNondeterminismAlarm} without
 * pulling `@temporalio/worker` into the HTTP module graph.
 *
 * NOTE: daemon-side observability code — NOT workflow code — so `Date`/clocks
 * are fine here; `now` is injected purely for deterministic unit tests.
 */
import type { Logger, LogLevel, LogMetadata } from '@temporalio/common';

/**
 * Substrings (matched case-insensitively against the log message) that mark a
 * nondeterminism / determinism-violation record. A SET rather than one phrase
 * because the exact wording varies across Core (Rust) and SDK (JS) sources and
 * versions — `DeterminismViolationError` surfaces "Replay failed with a
 * nondeterminism error", Core forwards a `WARN` referencing nondeterminism, and
 * Temporal surfaces the incident class under the `TMPRL1100` code. Matching a
 * set keeps the alarm armed across phrasing drift (same rationale as
 * `UNREGISTERED_SA_MARKERS` in `sa-preflight.ts`).
 */
export const NONDETERMINISM_MARKERS: readonly string[] = Object.freeze([
  'nondetermin',
  'non-determin',
  'determinismviolation',
  'tmprl1100',
]);

/** A single recorded nondeterminism hit (most-recent-N kept by the alarm). */
export interface NondeterminismSample {
  /** ISO timestamp of the hit. */
  at: string;
  /** Best-effort detail: workflow type / id from log meta + a message snippet. */
  detail: string;
}

/** Pollable alarm state — embedded in `GET /v1/health` (`HealthV1.nondeterminism`). */
export interface NondeterminismAlarmSnapshot {
  /** Total nondeterminism records seen since daemon boot. */
  count: number;
  /** ISO timestamp of the first hit, or `undefined` when count === 0. */
  firstSeenAt?: string;
  /** ISO timestamp of the most recent hit, or `undefined` when count === 0. */
  lastSeenAt?: string;
  /** Most-recent samples (capped), newest last. */
  recent: NondeterminismSample[];
}

/** Max recent samples retained for the `/v1/health` snapshot. */
const RECENT_CAP = 10;
/** Max message characters kept per sample (logs can be long stack-y blobs). */
const DETAIL_SNIPPET_MAX = 200;

export interface NondeterminismAlarmOpts {
  /** Injectable clock (epoch ms) — defaults to `Date.now`. Test seam only. */
  now?: () => number;
  /**
   * Promotion sink — invoked on EVERY hit with the running count + sample, so
   * the daemon can emit the prominent `[agent-tempo:ALARM]` line. Defaults to a
   * no-op; the daemon passes a `console.error`-backed promoter. Kept injectable
   * so unit tests can assert promotion without capturing stderr.
   */
  onHit?: (count: number, sample: NondeterminismSample) => void;
}

/**
 * Process-global nondeterminism counter. One per daemon. Records hits, promotes
 * each, and exposes a rolling snapshot.
 */
export class NondeterminismAlarm {
  private _count = 0;
  private _firstSeenAt?: string;
  private _lastSeenAt?: string;
  private readonly _recent: NondeterminismSample[] = [];
  private readonly now: () => number;
  private readonly onHit: (count: number, sample: NondeterminismSample) => void;

  constructor(opts: NondeterminismAlarmOpts = {}) {
    this.now = opts.now ?? (() => Date.now());
    this.onHit = opts.onHit ?? (() => { /* no-op */ });
  }

  /** Record one nondeterminism hit from a log record. */
  record(message: string, meta?: LogMetadata): void {
    const at = new Date(this.now()).toISOString();
    this._count += 1;
    if (this._firstSeenAt === undefined) this._firstSeenAt = at;
    this._lastSeenAt = at;

    const sample: NondeterminismSample = { at, detail: buildDetail(message, meta) };
    this._recent.push(sample);
    if (this._recent.length > RECENT_CAP) this._recent.shift();

    // Promote — fire the prominent, greppable alarm line (the whole point: the
    // #801 flap produced zero operator signal). Never let a throwing sink eat
    // the count.
    try {
      this.onHit(this._count, sample);
    } catch {
      /* a broken promoter must not disarm the counter */
    }
  }

  /** Current count (total hits since boot). */
  get count(): number {
    return this._count;
  }

  /** Immutable snapshot for `/v1/health`. */
  snapshot(): NondeterminismAlarmSnapshot {
    return {
      count: this._count,
      ...(this._firstSeenAt !== undefined ? { firstSeenAt: this._firstSeenAt } : {}),
      ...(this._lastSeenAt !== undefined ? { lastSeenAt: this._lastSeenAt } : {}),
      recent: this._recent.slice(),
    };
  }
}

/** Build the best-effort sample detail from log meta + a message snippet. */
function buildDetail(message: string, meta?: LogMetadata): string {
  const bits: string[] = [];
  const wfType = meta?.['workflowType'];
  const wfId = meta?.['workflowId'];
  const runId = meta?.['runId'];
  if (typeof wfType === 'string') bits.push(`workflowType=${wfType}`);
  if (typeof wfId === 'string') bits.push(`workflowId=${wfId}`);
  if (typeof runId === 'string') bits.push(`runId=${runId}`);
  const snippet = (message ?? '').slice(0, DETAIL_SNIPPET_MAX);
  bits.push(snippet);
  return bits.join(' · ');
}

/**
 * True when a log record (its message) signals a nondeterminism / determinism
 * violation. Case-insensitive substring match over {@link NONDETERMINISM_MARKERS}.
 */
export function isNondeterminismLog(message: string, _meta?: LogMetadata): boolean {
  if (!message) return false;
  const m = message.toLowerCase();
  return NONDETERMINISM_MARKERS.some((marker) => m.includes(marker));
}

/**
 * Wrap a base {@link Logger} so every record still flows to `base`, but any
 * `WARN`/`ERROR` record matching {@link isNondeterminismLog} also feeds the
 * alarm. Transparent: trace/debug/info pass straight through; warn/error/log are
 * classified first, then forwarded unchanged.
 *
 * Only `WARN`/`ERROR` are inspected — a nondeterminism failure is always logged
 * at one of those levels, and ignoring lower levels avoids a hot classifier on
 * the (high-volume) debug/trace path.
 */
export function wrapLoggerWithAlarm(base: Logger, alarm: NondeterminismAlarm): Logger {
  const consider = (level: LogLevel, message: string, meta?: LogMetadata): void => {
    if ((level === 'WARN' || level === 'ERROR') && isNondeterminismLog(message, meta)) {
      alarm.record(message, meta);
    }
  };
  return {
    log(level: LogLevel, message: string, meta?: LogMetadata): void {
      consider(level, message, meta);
      base.log(level, message, meta);
    },
    trace(message: string, meta?: LogMetadata): void {
      base.trace(message, meta);
    },
    debug(message: string, meta?: LogMetadata): void {
      base.debug(message, meta);
    },
    info(message: string, meta?: LogMetadata): void {
      base.info(message, meta);
    },
    warn(message: string, meta?: LogMetadata): void {
      consider('WARN', message, meta);
      base.warn(message, meta);
    },
    error(message: string, meta?: LogMetadata): void {
      consider('ERROR', message, meta);
      base.error(message, meta);
    },
  };
}

// ── Process singleton ───────────────────────────────────────────────────────
// The daemon installs ONE alarm at boot; `/v1/health` reads it without
// threading a reference through the HTTP server constructor (and without
// importing `@temporalio/worker` into the HTTP layer).

let globalAlarm: NondeterminismAlarm | undefined;

/** Set the process-global alarm (daemon boot only). */
export function setGlobalNondeterminismAlarm(alarm: NondeterminismAlarm): void {
  globalAlarm = alarm;
}

/** Read the process-global alarm, or `undefined` if not installed (e.g. tests, non-daemon). */
export function getGlobalNondeterminismAlarm(): NondeterminismAlarm | undefined {
  return globalAlarm;
}

/** Test seam — reset the singleton between unit tests. */
export function __resetGlobalNondeterminismAlarmForTests(): void {
  globalAlarm = undefined;
}
