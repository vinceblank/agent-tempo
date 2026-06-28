/**
 * Mocha global fixtures for the shared `TestWorkflowEnvironment` (#210 Phase 1).
 *
 * Loaded via `.mocharc.yml`'s `require:` key. Runs once per Mocha process,
 * AFTER all spec files have finished — exactly the right place to tear down
 * the process-wide env that `setupTestEnv()` created on first call.
 *
 * Global setup is intentionally NOT exported here: env creation is lazy,
 * triggered by the first `setupTestEnv()` call inside a spec's `before()`
 * hook. That keeps single-file invocations (`npx mocha test/foo.test.ts`)
 * cheap — they only pay for one env, the one they actually use.
 *
 * Fallback: set `TEMPO_TEST_ISOLATED=1` to restore per-file env lifecycle.
 * In that mode this teardown is a no-op (each file tore down its own env).
 */
import {
  installTemporalZombieReaper,
  reapOrphanTemporalServers,
  teardownSharedTestEnv,
} from './helpers';

/**
 * v1 (#306, `fa3a96d`): reap pre-existing orphan `temporal-sdk-typescript-*`
 * ephemeral servers BEFORE the suite starts. A live zombie holds the spawn
 * lock and turns the next `setupTestEnv()` into "Failed to start ephemeral
 * server: Access is denied. (os error 5)".
 *
 * v2 (#306 follow-up): also install last-ditch `process.on('exit')` +
 * SIGINT/SIGTERM handlers so zombies spawned by THIS run don't survive a
 * crash mid-flow. Without v2, a crashed test orphans fresh ephemerals and
 * blocks the next `npm test` until the v1 pre-suite reap fires —
 * exactly the failure mode reported in the #308 review ("Full mocha suite
 * blocked by the same Windows ephemeral-server permission issue").
 */
export const mochaGlobalSetup = async function (): Promise<void> {
  installTemporalZombieReaper();
  await reapOrphanTemporalServers();
};

/**
 * Tear down the shared `TestWorkflowEnvironment`, then reap any leftover
 * `temporal-sdk-typescript-*` ephemerals. The reap catches the case where
 * `testEnv.teardown()` returned but the bundled ephemeral binary's process
 * tree hadn't fully exited — Mocha's process exits seconds later either
 * way, but the zombie is what bricks the NEXT `npm test`.
 */
export const mochaGlobalTeardown = async function (): Promise<void> {
  console.log(`[teardown:global] mochaGlobalTeardown START @ ${Date.now()}`);
  try {
    console.log(`[teardown:global] teardownSharedTestEnv START @ ${Date.now()}`);
    await teardownSharedTestEnv();
    console.log(`[teardown:global] teardownSharedTestEnv DONE @ ${Date.now()}`);
  } finally {
    // Run the reap even if teardown threw — a partial teardown is the
    // exact case that produces the leftover zombie we're trying to kill.
    console.log(`[teardown:global] reapOrphanTemporalServers START @ ${Date.now()}`);
    await reapOrphanTemporalServers();
    console.log(`[teardown:global] reapOrphanTemporalServers DONE @ ${Date.now()}`);
  }
  console.log(`[teardown:global] mochaGlobalTeardown DONE @ ${Date.now()}`);
};
