/**
 * Bounded `WorkflowHandle.query()` wrapper — Issue #433.
 *
 * **Problem.** `@temporalio/client@1.15` doesn't expose an `AbortSignal` or a
 * per-call `deadline` on `WorkflowHandle.query()`. When the workflow is alive
 * (`Running`) but the worker that polls its task queue is dead (orphaned
 * adapter, wedged Copilot bridge, sticky-cache lock-up), `query()` never
 * resolves — it sits on its gRPC stream until the connection is torn down.
 *
 * Until v0.26 this only manifested as background reconcile log noise. After
 * #399 W2 layered `getPlayerWireMeta` (3 session queries × N players) into
 * the snapshot fan-out, a single hung session also wedged the snapshot
 * endpoint and the AggregateRunner's 750ms poll loop — the trigger for this
 * fix.
 *
 * **Strategy.** Race `handle.query()` against a `setTimeout`. When the timeout
 * wins, throw `QueryTimeoutError` so the caller's existing soft-failure path
 * (`Promise.allSettled` / `try-catch` / `.catch(() => …)`) takes over. The
 * underlying RPC stays pending in memory until it eventually resolves or the
 * gRPC connection is closed — see "Leak characteristics" below for why
 * that's bounded.
 *
 * **Leak characteristics.** The pending `handle.query()` Promise can't be
 * cancelled in this SDK version. Instead we **dedupe in-flight queries** by
 * `(workflowId, queryName)` so the AggregateRunner firing every 750ms against
 * the same hung session doesn't accumulate one new dangling promise per tick
 * — it gets the *same* shared promise back. Entries are reclaimed when the
 * RPC settles, and — daemon-resilience PR-B — **evicted when the timeout
 * fires**: under sustained worker starvation a never-settling shared promise
 * would otherwise accumulate one unreclaimable `Promise.race` reaction per
 * poll tick forever (the observed 180→919 MB daemon rss climb on 2026-07-14,
 * docs/research/daemon-query-timeout-rca.md). Eviction trades bounded RPC
 * abandonment (one per timeout window) for an unbounded reaction chain. When
 * `@temporalio/client` adds AbortSignal support, swap the race for a real
 * cancellation and drop the dedup map.
 *
 * **Configurable.** Default timeout is `DEFAULT_QUERY_TIMEOUT_MS` (2000ms) —
 * Temporal queries against a live worker round-trip in <100ms, so a 2s ceiling
 * is two orders of magnitude larger than a healthy query. Pass a smaller value
 * for tests; pass a larger value if you have a slow query handler that does
 * meaningful work synchronously.
 */
import type { WorkflowHandle } from '@temporalio/client';
import type { QueryDefinition } from '@temporalio/common';

/**
 * Default per-query timeout. 2 seconds — Temporal queries against a healthy
 * worker round-trip in <100ms, so this is two orders of magnitude of
 * headroom while still being short enough that a hung snapshot fan-out
 * (~12 players × 3 queries) still completes well under 10s.
 */
export const DEFAULT_QUERY_TIMEOUT_MS = 2000;

/**
 * Thrown by {@link queryHandleWithTimeout} when the per-query timeout fires
 * before the underlying RPC settles. Subclasses `Error`; `name` is set so
 * `err.name === 'QueryTimeoutError'` and `err instanceof QueryTimeoutError`
 * both work for callers that switch on either.
 */
export class QueryTimeoutError extends Error {
  constructor(
    public readonly workflowId: string,
    public readonly queryName: string,
    public readonly timeoutMs: number,
  ) {
    super(
      `Temporal query timed out after ${timeoutMs}ms: ` +
      `workflow="${workflowId}" query="${queryName}" ` +
      `(worker may be down or wedged — see #433)`,
    );
    this.name = 'QueryTimeoutError';
  }
}

/** Module-level dedup table keyed by `(workflowId, queryName)`. See JSDoc. */
const inflightQueries = new Map<string, Promise<unknown>>();

function inflightKey(workflowId: string, queryName: string): string {
  // NUL separator — workflow ids follow the project's `claude-{kind}-…`
  // convention and query names are JS identifiers, so neither can contain
  // a literal NUL byte. Guarantees no collision between e.g.
  // workflow `a` + query `b\0foo` vs. workflow `a\0b` + query `foo`.
  return `${workflowId}\x00${queryName}`;
}

/**
 * Test-only — clear the in-flight dedup table so each test case starts with
 * an empty cache. Follows the `__<verb><Noun>ForTests` convention from
 * ADR 0006: never call from production code.
 */
export function __resetInflightQueriesForTests(): void {
  inflightQueries.clear();
}

/**
 * Run `handle.query(queryDef, …(opts.args))` with a
 * {@link DEFAULT_QUERY_TIMEOUT_MS} (or `opts.timeoutMs`) ceiling. Throws
 * {@link QueryTimeoutError} if the timeout fires first. Multiple callers
 * issuing the same `(workflowId, queryName)` while the prior call is
 * still in flight share one underlying RPC — see the file header for
 * leak characteristics.
 *
 * `queryDef` may be a typed `QueryDefinition` (preferred — caller gets
 * type inference on `Ret`) or a bare string name (legacy call sites that
 * predate the signal-defs file: `getMetadata`, `getPart`, `maestroPlayers`,
 * etc.).
 *
 * `opts.args` forwards extra positional args to the SDK `query()` call.
 * Used by `getEnsembleChat`'s `{ offset, limit }` payload — every other
 * call site in this codebase issues a zero-arg query.
 *
 * **Dedup caveat with args**: the dedup key is `(workflowId, queryName)`
 * only — args are NOT in the key. If two concurrent callers issue the
 * same query name with *different* args, the second caller will receive
 * the first caller's result. Acceptable today because `getEnsembleChat`
 * is called with `(0, SNAPSHOT_CHAT_LIMIT)` from the snapshot fan-out
 * and a wider `(0, POLL_CHAT_LIMIT)` from the aggregate poll — both
 * are zero-offset reads, the wider window is a superset of the
 * narrower, and the bus's §8 chat cap collapses excess. Revisit if a
 * future args-passing caller issues a non-superset shape.
 *
 * **No retry**: caller decides whether to retry or fall back. Most call
 * sites fall back (snapshot returns `null` wireMeta;
 * `queryOrphanedSessions` skips the candidate; `getEnsembleMeta`
 * substitutes sentinels) so a retry loop here would just delay the
 * inevitable fallback.
 */
export async function queryHandleWithTimeout<Ret, Args extends unknown[] = []>(
  handle: WorkflowHandle,
  queryDef: QueryDefinition<Ret, Args> | string,
  opts: { timeoutMs?: number; args?: Args } = {},
): Promise<Ret> {
  const timeoutMs = opts.timeoutMs ?? DEFAULT_QUERY_TIMEOUT_MS;
  const queryName = typeof queryDef === 'string' ? queryDef : queryDef.name;
  const key = inflightKey(handle.workflowId, queryName);

  let underlying = inflightQueries.get(key) as Promise<Ret> | undefined;
  if (!underlying) {
    const args = (opts.args ?? ([] as unknown as Args));
    underlying = handle.query<Ret, Args>(
      queryDef as QueryDefinition<Ret, Args>,
      ...args,
    ).finally(() => {
      // Free the slot once the RPC settles — success or failure both clear.
      // Multiple racing callers all see the same settled value.
      // Identity-guarded: if this entry was already evicted on timeout
      // (below) and a NEWER RPC now occupies the slot, a late settle of
      // the old RPC must not delete the new entry out from under its
      // callers.
      if (inflightQueries.get(key) === underlying) {
        inflightQueries.delete(key);
      }
    });
    inflightQueries.set(key, underlying as Promise<unknown>);
  }

  let timer: NodeJS.Timeout | undefined;
  const timeoutPromise = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      reject(new QueryTimeoutError(handle.workflowId, queryName, timeoutMs));
    }, timeoutMs);
    // Don't let the timeout keep the process alive.
    timer.unref?.();
  });

  try {
    return await Promise.race([underlying, timeoutPromise]);
  } catch (err) {
    if (err instanceof QueryTimeoutError) {
      // Daemon-resilience PR-B (architect amendment to #433): EVICT the
      // dedup entry when the timeout fires. Under sustained worker
      // starvation the shared never-settling promise otherwise stays in
      // the map indefinitely, and every subsequent poll tick attaches a
      // fresh `Promise.race` reaction (plus the caller's async
      // continuation) to it — reaction records on a pending promise are
      // unreclaimable, which is the observed 180→919 MB daemon rss climb
      // (docs/research/daemon-query-timeout-rca.md). Evicting caps the
      // pile-up at one abandoned RPC per timeout window instead of an
      // unbounded reaction chain on a single immortal promise. The
      // identity check keeps a slower racer's timeout from evicting a
      // newer entry that already replaced this one.
      if (inflightQueries.get(key) === underlying) {
        inflightQueries.delete(key);
      }
    }
    throw err;
  } finally {
    if (timer) clearTimeout(timer);
  }
}
