/**
 * Per-source Temporal action instrumentation — Issue #753 (epic #747, step 0).
 *
 * **Problem.** The cost spike (docs/design/temporal-cost-rearchitecture.md)
 * produced two irreconcilable estimates for the idle action bill: the
 * researcher's ~2.0M actions/day (maestro-loop dominated) vs the naïve
 * aggregate.ts 750ms-cadence math of ~7.8M/day. Don't guess — meter.
 *
 * **What this is.** Low-cardinality in-memory counters of outbound Temporal
 * client calls, tagged `source × kind`:
 *
 * - `kind` mirrors the wire verb (`query`, `signal`, `update`, `start`,
 *   `describe`, `terminate`, `cancel`, `list`). Pricing analysis maps kinds
 *   to billable actions afterwards (e.g. queries/signals/updates are 1
 *   action each; whether visibility `list` scans bill is exactly one of the
 *   open questions — so `list` is its own kind, never lumped in).
 * - `source` is the subsystem that initiated the call (`maestro`,
 *   `aggregate`, `pi-pump`, `sdk-poller`, `heartbeat`, `phase-watcher`,
 *   `outbox`, `schedule`, `reconcile`, `other`).
 *
 * **How counting works.** A {@link createActionCountingInterceptor
 * WorkflowClientInterceptor} installed at `new Client(...)` sites counts
 * every signal/query/update/start/describe/terminate/cancel that actually
 * goes out on the wire — one instrumentation point, zero per-call-site
 * edits. Notably this composes correctly with `queryHandleWithTimeout`'s
 * in-flight dedup (#433): a deduped caller never reaches `handle.query()`,
 * so shared RPCs are counted exactly once. Visibility scans
 * (`client.workflow.list`) don't flow through the interceptor, so they're
 * counted explicitly via {@link recordAction}('list') at the list seams.
 *
 * **How attribution works.** Subsystem entry points wrap their bodies in
 * {@link withActionSource}; the tag rides Node's `AsyncLocalStorage` down
 * the async call chain into the interceptor, however deep the call stack
 * (e.g. aggregate tick → buildEnsembleSnapshot → TempoClient →
 * queryHandleWithTimeout → handle.query). Untagged calls land in `other`.
 *
 * **Zero added Temporal calls.** Counters are plain in-memory objects;
 * the read surfaces are the daemon's `GET /v1/debug/action-counters`
 * endpoint (daemon process only) and a periodic
 * `[agent-tempo:action-counters]` log line that each instrumented process
 * (daemon, MCP server, SDK adapters, Pi runtime) emits, so the 24h idle
 * meter can be reconstructed per-process from logs.
 *
 * **Not workflow-safe.** This module uses `node:async_hooks` and timers —
 * it must never be imported from `src/workflows/` (it isn't; it's wired
 * into clients, activities, adapters, and the HTTP plane only).
 */
import { AsyncLocalStorage } from 'node:async_hooks';
import type { WorkflowClientInterceptor } from '@temporalio/client';
import { ENV } from '../config';

/** Subsystems that initiate Temporal client calls. Keep low-cardinality. */
const ACTION_SOURCES = [
  'maestro',
  'aggregate',
  'pi-pump',
  'sdk-poller',
  'heartbeat',
  'phase-watcher',
  'outbox',
  'schedule',
  'reconcile',
  'other',
] as const;
export type ActionSource = (typeof ACTION_SOURCES)[number];

/** Wire verbs counted. `list` = one `client.workflow.list()` invocation (not per page). */
const ACTION_KINDS = [
  'query',
  'signal',
  'update',
  'start',
  'describe',
  'terminate',
  'cancel',
  'list',
] as const;
export type ActionKind = (typeof ACTION_KINDS)[number];

/** Snapshot shape returned by {@link snapshotActionCounters} (and the debug endpoint). */
export interface ActionCounterSnapshot {
  /** ISO timestamp of process start / last test reset — the metering window origin. */
  sinceIso: string;
  /** Milliseconds covered by this snapshot (now − since). */
  windowMs: number;
  /** Sum of every counted call across all sources and kinds. */
  total: number;
  /** `source → kind → count`; sources/kinds with zero counts are omitted. */
  bySource: Partial<Record<ActionSource, Partial<Record<ActionKind, number>> & { total: number }>>;
}

const sourceStorage = new AsyncLocalStorage<ActionSource>();

/** counters[source][kind] — lazily populated so the snapshot stays sparse. */
let counters: Map<ActionSource, Map<ActionKind, number>> = new Map();
let sinceMs = Date.now();
let total = 0;

/**
 * Run `fn` with all Temporal client calls made (transitively, across
 * `await` boundaries) attributed to `source`. Nesting is innermost-wins.
 * Returns `fn`'s result verbatim — sync or async.
 */
export function withActionSource<T>(source: ActionSource, fn: () => T): T {
  return sourceStorage.run(source, fn);
}

/** The source tag active on the current async execution path (default `'other'`). */
export function currentActionSource(): ActionSource {
  return sourceStorage.getStore() ?? 'other';
}

/**
 * Wrap every function-valued property of `fns` in {@link withActionSource}.
 * Used by activity factories (`createMaestroActivities` → `'maestro'`,
 * `createOutboxActivities` → `'outbox'`, …) so every Temporal call an
 * activity makes — however deep (e.g. outbox → resolveSession →
 * queryHandleWithTimeout) — is attributed to the owning subsystem.
 *
 * Constraint: the wrapped functions must not rely on `this` (the activity
 * factories in this codebase close over `client`/`config` instead — true
 * for all current call sites).
 */
export function tagActionSource<T extends object>(source: ActionSource, fns: T): T {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(fns)) {
    out[key] = typeof value === 'function'
      ? (...args: unknown[]) =>
          sourceStorage.run(source, () => (value as (...a: unknown[]) => unknown)(...args))
      : value;
  }
  return out as T;
}

/**
 * Count one outbound Temporal call. `source` defaults to the ambient
 * {@link withActionSource} tag. Called by the client interceptor for
 * handle verbs; called explicitly (kind `'list'`) at visibility-scan seams.
 */
export function recordAction(kind: ActionKind, source: ActionSource = currentActionSource()): void {
  let byKind = counters.get(source);
  if (!byKind) {
    byKind = new Map();
    counters.set(source, byKind);
  }
  byKind.set(kind, (byKind.get(kind) ?? 0) + 1);
  total++;
  maybeStartLogTimer();
}

/** Build the JSON-able snapshot read by the debug endpoint and the periodic log. */
export function snapshotActionCounters(now: number = Date.now()): ActionCounterSnapshot {
  const bySource: ActionCounterSnapshot['bySource'] = {};
  for (const [source, byKind] of counters) {
    let sourceTotal = 0;
    const kinds: Partial<Record<ActionKind, number>> = {};
    for (const [kind, n] of byKind) {
      kinds[kind] = n;
      sourceTotal += n;
    }
    bySource[source] = { ...kinds, total: sourceTotal };
  }
  return {
    sinceIso: new Date(sinceMs).toISOString(),
    windowMs: Math.max(0, now - sinceMs),
    total,
    bySource,
  };
}

// ── Periodic log line ────────────────────────────────────────────────────
//
// Each instrumented process self-reports its counters on an interval so the
// 24h idle meter can be assembled from logs across processes (adapters and
// the Pi runtime don't serve HTTP; the daemon endpoint only sees the daemon
// process). Lazily started on the first counted action; the timer is
// unref'd so it never holds a process open; emits only when counts changed.

/** Default emit cadence — 5 minutes. Override via `AGENT_TEMPO_ACTION_LOG_INTERVAL_MS`; `0` disables. */
export const DEFAULT_ACTION_LOG_INTERVAL_MS = 300_000;

let logTimer: NodeJS.Timeout | null = null;
let lastLoggedTotal = 0;
/** Set once the enable/disable decision is made — avoids re-reading the env var on every recordAction when logging is disabled. */
let logDecisionMade = false;

function logIntervalMs(): number {
  const raw = process.env[ENV.ACTION_LOG_INTERVAL_MS];
  if (raw === undefined || raw === '') return DEFAULT_ACTION_LOG_INTERVAL_MS;
  const n = Number(raw);
  return Number.isFinite(n) && n >= 0 ? n : DEFAULT_ACTION_LOG_INTERVAL_MS;
}

function maybeStartLogTimer(): void {
  if (logDecisionMade) return;
  logDecisionMade = true;
  const intervalMs = logIntervalMs();
  if (intervalMs === 0) return;
  logTimer = setInterval(() => {
    if (total === lastLoggedTotal) return; // nothing new — stay quiet
    lastLoggedTotal = total;
    console.error(
      '[agent-tempo:action-counters]',
      JSON.stringify(snapshotActionCounters()),
    );
  }, intervalMs);
  logTimer.unref?.();
}

// ── Client interceptor ───────────────────────────────────────────────────

/**
 * A `WorkflowClientInterceptor` that counts each outbound call under the
 * ambient {@link withActionSource} tag, then forwards to `next` untouched.
 * Install at `new Client({ ..., interceptors: { workflow:
 * [createActionCountingInterceptor()] } })`.
 *
 * Composite verbs count each wire effect: `signalWithStart` = signal +
 * start; `startUpdateWithStart` = update + start — mirroring how Temporal
 * bills the underlying events.
 */
export function createActionCountingInterceptor(): WorkflowClientInterceptor {
  return {
    async startWithDetails(input, next) {
      recordAction('start');
      return next(input);
    },
    async startUpdate(input, next) {
      recordAction('update');
      return next(input);
    },
    async startUpdateWithStart(input, next) {
      recordAction('update');
      recordAction('start');
      return next(input);
    },
    async signal(input, next) {
      recordAction('signal');
      return next(input);
    },
    async signalWithStart(input, next) {
      recordAction('signal');
      recordAction('start');
      return next(input);
    },
    async query(input, next) {
      recordAction('query');
      return next(input);
    },
    async describe(input, next) {
      recordAction('describe');
      return next(input);
    },
    async terminate(input, next) {
      recordAction('terminate');
      return next(input);
    },
    async cancel(input, next) {
      recordAction('cancel');
      return next(input);
    },
  };
}

/**
 * Convenience for `new Client({ ..., interceptors: actionCountingInterceptors() })`
 * — keeps the ten construction sites one-term and uniform.
 */
export function actionCountingInterceptors(): { workflow: WorkflowClientInterceptor[] } {
  return { workflow: [createActionCountingInterceptor()] };
}

/**
 * Test-only — zero all counters, reset the window origin, and stop the
 * periodic log timer. Follows the `__<verb><Noun>ForTests` convention from
 * ADR 0006: never call from production code.
 */
export function __resetActionCountersForTests(): void {
  counters = new Map();
  total = 0;
  sinceMs = Date.now();
  lastLoggedTotal = 0;
  logDecisionMade = false;
  if (logTimer) {
    clearInterval(logTimer);
    logTimer = null;
  }
}
