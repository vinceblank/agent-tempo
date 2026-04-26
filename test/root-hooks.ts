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
import { reapOrphanTemporalServers, teardownSharedTestEnv } from './helpers';

/**
 * Reap orphan `temporal-sdk-typescript-*` ephemeral servers from prior
 * crashed runs before the suite starts. A live zombie holds the spawn
 * lock and turns the next `setupTestEnv()` into "Failed to start
 * ephemeral server: Access is denied. (os error 5)". Symmetric with the
 * teardown below.
 */
export const mochaGlobalSetup = async function (): Promise<void> {
  await reapOrphanTemporalServers();
};

export const mochaGlobalTeardown = async function (): Promise<void> {
  await teardownSharedTestEnv();
};
