/**
 * Headless Pi adapter entry point (Phase 3a). Spawned as a detached subprocess
 * by `spawnPiHeadless` (src/spawn.ts) on a recruited `agent: 'pi'`. Reads its
 * config from the env the spawn set, then delegates to `runHeadlessPi`, which
 * injects the agent-tempo extension into Pi's `createAgentSession`.
 *
 * Unlike the other headless adapters, there is NO `BaseAttachment` driver here:
 * the module-scope Pi extension singleton (Phase 2) owns claim / heartbeat /
 * phase / tool registration / cue pump (MD-D). This file is purely the process
 * entry + env→options wiring.
 *
 * Dual-purpose: importing this module is inert; only running it as the process
 * entry (`require.main === module`) boots the runtime.
 */
import { ENV } from '../../config';
import { runHeadlessPi } from '../../pi/headless';

const log = (...args: unknown[]): void => {
  // eslint-disable-next-line no-console
  console.error('[agent-tempo:pi]', ...args);
};

/** Parse the spawn-provided env into options and run. Exported for testing. */
export async function main(): Promise<void> {
  await runHeadlessPi({
    model: process.env[ENV.PI_MODEL] || undefined,
    continueSessionId: process.env[ENV.PI_CONTINUE_SESSION] || undefined,
  });
}

if (require.main === module) {
  main().catch((err) => {
    log('FATAL — headless Pi adapter crashed:', err instanceof Error ? (err.stack ?? err.message) : err);
    // eslint-disable-next-line no-process-exit
    process.exit(1);
  });
}
