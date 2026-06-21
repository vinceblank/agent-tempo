/**
 * Iterator-level deadlines for unbounded Temporal visibility queries
 * (`client.workflow.list({ query })`). Closes #336 + #529.
 *
 * ## Background
 *
 * Six daemon hot-path sites consume `for await (const wf of
 * client.workflow.list({ query }))` without any iterator-level deadline.
 * Temporal's visibility API is page-based: each `next()` may fetch
 * additional pages over gRPC. A wedged worker, a slow page on a deep
 * scan, or a backend hiccup can stall the iterator indefinitely while
 * the gRPC stream retains buffer state. Researcher's spike on #336
 * traced 17h-runtime memory growth to retained `WorkflowExecutionInfo`
 * protobufs hanging off un-completed iterator streams.
 *
 * The fix per site is small (≤ 12 LoC), but the **caller's correctness
 * model around partial enumeration is what varies** — three patterns:
 *
 * - **Partial-tolerant + warn-log**: silently breaking out is safe;
 *   the caller treats the truncated result as a best-effort snapshot
 *   that the next tick / retry will fill in. (Sites 2, 3, 5)
 * - **Structured outcome**: the caller branches on whether enumeration
 *   completed. Sites 4 (`fireSchedule target='all'`) extends its
 *   existing `{delivered, failures}` result. Site 1 (`resolveSession`)
 *   throws {@link VisibilityIteratorTimeoutError} so callers can
 *   distinguish "definitely absent" from "scan didn't finish."
 * - **Skip the entire tick / preserve prior state**: AggregateRunner's
 *   ensemble-set diff (site 6) — partial results would emit phantom
 *   `ensemble.destroyed` SSE events. Handled separately via the
 *   architect-approved invariant in `src/http/aggregate.ts`.
 *
 * ## Deadline tuning rationale
 *
 * Per-site defaults live in {@link VISIBILITY_DEADLINES_MS}. Numbers
 * chosen to balance:
 *
 * - The caller's tick cadence (a 5s deadline is "instant" if the
 *   caller polls every 750ms but "an eternity" if they boot once and
 *   never retry).
 * - The expected scan depth (orphan boot scan walks every running
 *   session workflow across every host; aggregate poll walks the same
 *   set but happens 80× per minute).
 * - Headroom against the activity-level StartToClose timeout
 *   (typically 60s) — the iterator deadline should fire well before
 *   StartToClose so the activity returns a structured "timed out"
 *   outcome rather than getting force-cancelled by Temporal.
 *
 * Tune per site rather than chasing a single magic number; reviewer
 * sanity-checks the values in this map during PR review.
 */
import type { WorkflowExecutionInfo } from '@temporalio/client';
import { recordAction } from './action-counters';

/**
 * Per-site deadline budgets for visibility iterators (#336/#529).
 *
 * Adding a new site? Pick a deadline that:
 * 1. Comfortably fits within the caller's StartToClose if it runs as an activity.
 * 2. Is short enough that a wedged iterator can't dominate the caller's tick budget.
 * 3. Documents the rationale below.
 */
export const VISIBILITY_DEADLINES_MS = {
  /**
   * `resolveSession` — finds a single `(ensemble, playerId)` in the
   * running-session set. Called from outbox / CLI / tools on every
   * cue/signal/restart. 10s gives plenty of headroom for a healthy
   * lookup while preventing a wedged session worker from holding the
   * outbox loop indefinitely (per-workflow `getMetadata` already
   * bounded at #433's `queryHandleWithTimeout`).
   */
  resolveSession: 10_000,
  /**
   * `scanEnsembleSessions` — full ensemble enumeration with metadata
   * + part + activity-state per session. Called from the `ensemble`
   * MCP tool and the maestro refresh activity. 15s allows scanning
   * hundreds of workflows with the per-query bounds at #433.
   */
  scanEnsembleSessions: 15_000,
  /**
   * `discoverEnsembles` (maestro activity) — aggregates unique ensemble
   * names. 10s; the maestro retries on its own schedule, so a partial
   * result self-heals on the next tick.
   */
  discoverEnsembles: 10_000,
  /**
   * `fireSchedule target='all'` — broadcast loop. 20s; broadcasts can
   * fan out to many players, and the caller's existing `failures: []`
   * surface already records partial delivery — extending it with a
   * `timedOut` flag preserves the "scheduler promised 'all'" semantic.
   */
  fireScheduleAll: 20_000,
  /**
   * `queryOrphanedSessions` boot scan — runs once at daemon startup.
   * 60s budget because losing an orphan means a session goes
   * un-reconciled, but the function's existing comment explicitly
   * marks partial results as acceptable ("next tick will retry").
   */
  orphanQueryBoot: 60_000,
  /**
   * `queryOrphanedSessions` cleanup loop — 6h-cadence sweep. 30s;
   * shorter than boot because the cleanup loop runs frequently
   * enough to amortize partial scans across many sweeps.
   */
  orphanQueryCleanup: 30_000,
  /**
   * #786 — `checkProtocolGuard` daemon boot scan. Walks every Running
   * agent-tempo workflow (the 4 workflow types) reading only the
   * `AgentTempoProtocol` memo straight off the visibility page — NO
   * per-workflow query, so it's pure page iteration and far cheaper than
   * the orphan scan. 30s is generous headroom for a large-but-healthy
   * namespace (page-streaming even thousands of rows completes in
   * seconds) while still bounding a wedged visibility backend.
   *
   * **Load-bearing: this budget is FAIL-CLOSED.** A timeout here does NOT
   * yield a best-effort partial — the guard treats an unfinished scan as
   * "couldn't prove the cutover is clean" and REFUSES to boot (the #845
   * partial-scan lesson: a 2.0 worker that replays a 1.x history corrupts
   * deterministically, so an unverified scan must never be read as clean).
   */
  protocolGuardBoot: 30_000,
} as const;

export type VisibilitySite = keyof typeof VISIBILITY_DEADLINES_MS;

/**
 * Thrown by {@link iterateWithDeadline} when the per-iterator deadline
 * fires. Callers that want to distinguish "scan didn't finish" from
 * "scan completed with N results" should catch this error specifically.
 *
 * Carries `site` (which deadline tripped) and `partialCount` (how many
 * entries were yielded before the timeout) so warn-log surfaces are
 * actionable — `"orphanQueryBoot timed out after 60000ms, partial=423"`
 * tells the operator both which budget is too tight AND how close to
 * complete the scan got.
 */
export class VisibilityIteratorTimeoutError extends Error {
  override readonly name = 'VisibilityIteratorTimeoutError';
  constructor(
    readonly site: string,
    readonly deadlineMs: number,
    readonly partialCount: number,
  ) {
    super(
      `Visibility iterator "${site}" exceeded ${deadlineMs}ms deadline ` +
      `after ${partialCount} entries`,
    );
  }
}

/**
 * Wrap an async iterable of `WorkflowExecutionInfo` (the type yielded
 * by `client.workflow.list({ query })`) with a wall-clock deadline.
 *
 * Yields entries until either the upstream iterator exhausts (normal
 * end) or `Date.now() > deadline` (timeout). On timeout, throws
 * {@link VisibilityIteratorTimeoutError} after the in-progress
 * iteration completes — so the caller can choose whether to swallow
 * the throw (partial-tolerant pattern) or propagate it.
 *
 * The deadline check fires **before** each yield, not after — so the
 * iterator never spends time fetching a page it won't consume. The
 * `partialCount` reported in the error reflects entries yielded, not
 * pages fetched, which matches what operators care about.
 *
 * ## Usage pattern (partial-tolerant)
 *
 * ```ts
 * try {
 *   for await (const wf of iterateWithDeadline(
 *     client.workflow.list({ query }),
 *     VISIBILITY_DEADLINES_MS.scanEnsembleSessions,
 *     'scanEnsembleSessions',
 *   )) {
 *     // existing loop body
 *   }
 * } catch (err) {
 *   if (err instanceof VisibilityIteratorTimeoutError) {
 *     log('warn: ' + err.message + ' — returning partial results');
 *     // fall through to return whatever we accumulated
 *   } else {
 *     throw err;
 *   }
 * }
 * ```
 *
 * ## Usage pattern (structured outcome)
 *
 * ```ts
 * let timedOut = false;
 * try {
 *   for await (const wf of iterateWithDeadline(...)) { ... }
 * } catch (err) {
 *   if (err instanceof VisibilityIteratorTimeoutError) {
 *     timedOut = true;
 *     // fall through — caller surfaces `timedOut` in the result
 *   } else {
 *     throw err;
 *   }
 * }
 * return { success: !timedOut, ..., timedOut };
 * ```
 */
export async function* iterateWithDeadline(
  source: AsyncIterable<WorkflowExecutionInfo>,
  deadlineMs: number,
  site: string,
  /** Test-only — defaults to `Date.now`; injectable so unit tests can advance the clock. */
  now: () => number = Date.now,
): AsyncGenerator<WorkflowExecutionInfo> {
  // #753 — visibility scans don't flow through the workflow-client
  // interceptor, so they're counted here: one 'list' per invocation
  // (per scan, not per page — see ACTION_KINDS).
  recordAction('list');
  const deadline = now() + deadlineMs;
  let count = 0;
  for await (const entry of source) {
    if (now() > deadline) {
      throw new VisibilityIteratorTimeoutError(site, deadlineMs, count);
    }
    yield entry;
    count++;
  }
}

/**
 * Compose `iterateWithDeadline` with the partial-tolerant catch pattern
 * for sites that just want "log a warn, return what we got."
 *
 * Sites 2, 3, 5 use this; sites 1 + 4 use the raw iterator so they can
 * carry the timeout signal into their return shape.
 */
export function isVisibilityTimeout(err: unknown): err is VisibilityIteratorTimeoutError {
  return err instanceof VisibilityIteratorTimeoutError;
}
