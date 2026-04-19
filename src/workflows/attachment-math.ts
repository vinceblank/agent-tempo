/**
 * Pure attachment-math helpers for the session workflow.
 *
 * **Workflow-sandbox safe**: this file imports only types. No `@temporalio/*`
 * runtime imports, no `Date.now()`, no random, no I/O — every caller passes
 * `now` as a parameter so the same inputs always produce the same output.
 * That makes it:
 *   - Cheap to unit-test from Mocha without `TestWorkflowEnvironment`, and
 *   - Safe to call from deterministic workflow code (caller is responsible
 *     for sourcing `now` via the SDK-intercepted `new Date().getTime()`).
 *
 * Extracted in PR #127-fix as a follow-up to PR-G (#125) architect review:
 * the alternative was a ~60 LOC history-fill harness that would have tested
 * Temporal's CAN-trigger heuristic rather than our extension logic, and
 * would have been brittle to Temporal-SDK internals. Pure-function + direct
 * unit tests is the durable choice.
 */
import type { Attachment } from '../types';

/**
 * Produce a new {@link Attachment} whose lease window is extended so an
 * adapter that was beating normally at the moment of `continueAsNew` has room
 * to land its next heartbeat before the new execution's first main-loop tick
 * reaps the lease.
 *
 * **Design rationale (session-lifecycle-rebuild-v2.md §2.3):** the CAN
 * transition is not instantaneous. If we were to write the pre-CAN
 * `expiresAt` verbatim into the new execution, a transition that takes
 * ~100-500ms could leave the new run's first deadline race observing an
 * already-expired lease and reaping a healthy attachment. Pushing
 * `expiresAt` out to `now + extendMs` guarantees the adapter has room to land
 * its next heartbeat.
 *
 * Why this is a total function (returns a new object unconditionally,
 * rather than accepting `null` and returning `undefined`): null-handling is
 * the caller's business — a workflow that has no current attachment simply
 * skips the call. Keeping this function non-nullable keeps the unit tests
 * focused on math rather than null-propagation.
 *
 * @param attachment - the pre-CAN attachment record. All non-timestamp
 *   fields (`attachmentId`, `hostname`, `adapterId`, `adapterClass`,
 *   `claimedAt`, `leaseMs`, `runId`) are carried forward verbatim.
 * @param extendMs - how far past `now` to push `expiresAt`, in milliseconds.
 *   Post-#249 callers pass `attachment.leaseMs` (= 3 × heartbeatMs — covers one
 *   full lease window and therefore at least one full heartbeat interval for
 *   every adapter class). Pre-#249 callers passed a hardcoded 30_000 constant
 *   which under-covered the claude-code adapter's 60s cadence — the rename
 *   from `heartbeatMs` disambiguates that the parameter is a raw extension
 *   duration, not a cadence. The function does not validate — any non-negative
 *   integer is accepted.
 * @param now - current time in epoch milliseconds. In workflow context
 *   callers pass `new Date().getTime()` (the Temporal SDK intercepts `new
 *   Date()` to return replay-consistent time). In unit tests callers pass
 *   an arbitrary fixed value.
 * @returns a new `Attachment` object — the input is not mutated.
 */
export function extendAttachmentForCAN(
  attachment: Attachment,
  extendMs: number,
  now: number,
): Attachment {
  return {
    ...attachment,
    lastHeartbeatAt: new Date(now).toISOString(),
    expiresAt: new Date(now + extendMs).toISOString(),
  };
}
