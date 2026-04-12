/**
 * Workflow invariant: CAN-boundary lease extension (§2.3).
 *
 * Before firing `continueAsNew`, the session workflow extends the carried
 * `currentAttachment.expiresAt` by one `HEARTBEAT_INTERVAL_MS` so the new
 * execution's first main-loop tick doesn't reap a healthy attachment during the
 * CAN transition window.
 *
 * **PR-G scaffolding (step 7/7).** This file stubs the extension-before-CAN test
 * that architect-2 identified as complementary to PR-A's boot-side coverage.
 * Today's TestWorkflowEnvironment does not expose a stable way to force
 * `workflowInfo().continueAsNewSuggested === true` — the trigger is history-size
 * based and varies with SDK internals. Filling history deterministically from
 * a test would require either a patched workflow threshold or a ~50 LOC signal-
 * spam loop that's brittle across SDK versions.
 *
 * Un-skip and implement when the test harness gains an explicit CAN trigger
 * (e.g. `testEnv.advanceHistory()`), or when the extension helper is extracted
 * from `src/workflows/session.ts` as a pure function testable without a worker.
 *
 * Cross-reference:
 * - `test/session-lease.test.ts:61` covers the BOOT side — "pre-populated
 *   `currentAttachment` is restored and phase=attached". Do NOT duplicate.
 * - `src/workflows/session.ts:1322-1333` is the production extension code
 *   (currentAttachment.expiresAt bumped to `workflow.now() + HEARTBEAT_INTERVAL_MS`
 *   just before `continueAsNew`).
 *
 * Design reference: docs/design/session-lifecycle-rebuild-v2.md §2.3, §9.5.
 * Sequencing memo: §3 PR-G "starter-3" (CAN-boundary extension-before-CAN path).
 */
import { setupTestEnv, teardownTestEnv } from '../helpers';

describe('workflow invariant: CAN-boundary lease extension (§2.3)', function () {
  before(async function () {
    this.timeout(60_000);
    await setupTestEnv();
  });

  after(async function () {
    await teardownTestEnv();
  });

  it.skip('extends currentAttachment.expiresAt by HEARTBEAT_INTERVAL_MS before continueAsNew', async function () {
    // TODO (PR-G follow-up or PR-C): see file docstring for the harness limitation.
    // Expected shape once implementable:
    //   1. Start a fresh session + claimAttachment (lease T0).
    //   2. Trigger continueAsNew (currently no clean API; would require history spam).
    //   3. Read post-CAN attachmentInfo — assert currentAttachment.expiresAt is
    //      approximately `workflow.now() + HEARTBEAT_INTERVAL_MS` (30_000ms), not the
    //      original T0 expiresAt (which could have been mid-lease).
    //   4. Tolerance: ±1s for scheduler variance.
  });
});
