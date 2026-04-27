/**
 * Workflow invariant: pause + spawn-drain interaction.
 *
 * When the ensemble is paused (`setPaused(true)`) AND the outbox has pending
 * spawn entries, the dispatch loop must:
 *  - NOT drain spawn entries while paused
 *  - Resume draining when `setPaused(false)` is received
 *  - Continue to honor `stop` outbox entries during pause (they bypass the lock)
 *
 * **PR-G scaffolding (step 7/7).** Stubbed — the interaction surface it
 * exercises spans the outbox dispatcher (`src/activities/outbox.ts`), pause
 * flag propagation (`src/workflows/session.ts` `setPaused` handler), and the
 * `enqueueSpawn` update (PR-A). The test requires a worker configured with
 * stubbed spawn activities that record invocations without real process
 * launches, which is a PR-C+ adapter-harness shape. Un-skip when the mock
 * spawn activity is available.
 *
 * Related coverage:
 * - `test/pause-resume.test.ts` covers the pause/resume primitive itself.
 * - This file adds the specific interaction with `enqueueSpawn` outbox entries
 *   — a new verb surface in v0.25 that the pause invariant needs to respect.
 *
 * Design reference: docs/design/session-lifecycle-rebuild-v2.md §8 (pause),
 * §10 (spawn/daemon interplay).
 * Sequencing memo: §3 PR-G workflow invariants.
 */
import { setupTestEnv,
  setupSharedEnv, teardownTestEnv } from '../helpers';

describe('workflow invariant: pause holds spawn outbox entries (§8, §10)', function () {
  before(setupSharedEnv);

  after(async function () {
    await teardownTestEnv();
  });

  it.skip('spawn entries queued during pause are not dispatched until resume', async function () {
    // TODO (PR-C + PR-E): requires mock spawn activity that records invocations
    // without launching real processes. Shape:
    //   1. Start session; setPaused(true).
    //   2. Submit an outbox entry of type 'enqueueSpawn' (PR-D verb).
    //   3. Assert mock spawn activity is NOT invoked.
    //   4. setPaused(false). Assert mock spawn activity IS invoked exactly once.
  });

  it.skip('stop entries still dispatched during pause (emergency channel)', async function () {
    // TODO (PR-C + PR-D): same harness requirements. Shape:
    //   1. Start session; setPaused(true).
    //   2. Submit outbox 'stop' entry.
    //   3. Assert stop activity runs immediately — the pause lock does not gate stops.
  });
});
