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
import type { PiToolAccess } from '../../pi/extension';
import type { GuardrailPolicy } from '../../types';

const log = (...args: unknown[]): void => {
  // eslint-disable-next-line no-console
  console.error('[agent-tempo:pi]', ...args);
};

/** Normalize the env tool-access value to the MD-C policy (default 'restricted'). */
function readToolAccess(): PiToolAccess {
  const raw = process.env[ENV.TOOL_ACCESS];
  return raw === 'standard' || raw === 'full' ? raw : 'restricted';
}

/**
 * #700 (P2 / G) — normalize the env guardrail posture. Unknown / absent ⇒
 * undefined (the extension defaults to 'autonomous'). The durable source is
 * SessionMetadata; this env is re-derived from it on every (re)spawn.
 */
function readGuardrailPolicy(): GuardrailPolicy | undefined {
  const raw = process.env[ENV.GUARDRAIL_POLICY];
  return raw === 'autonomous' || raw === 'monitored' || raw === 'supervised' || raw === 'observe-only'
    ? raw
    : undefined;
}

/** Parse the spawn-provided env into options and run. Exported for testing. */
export async function main(): Promise<void> {
  await runHeadlessPi({
    toolAccess: readToolAccess(),
    guardrailPolicy: readGuardrailPolicy(),
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
