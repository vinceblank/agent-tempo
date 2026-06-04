/**
 * Pi adapter — registry/identity descriptor ONLY (Phase 3a).
 *
 * Unlike the other headless adapters (copilot / opencode / claude-api /
 * claude-code-headless), Pi does NOT have a `BaseAttachment` subprocess driver.
 * The headless Pi runtime injects the Phase 2 `src/pi` EXTENSION into Pi's
 * `createAgentSession` as an inline factory; the module-scope extension singleton
 * owns claim / heartbeat / phase / tool registration / cue pump (MD-D). This
 * descriptor exists purely for adapter identity, registry resolution, spawn
 * routing, and heartbeat-cadence config (MD-A: 30s heartbeat, lease = 3×).
 *
 * Spawn entry: `src/adapters/pi/adapter.ts` (A2) → `src/pi/headless.ts`.
 */
import type { AdapterDescriptor } from '../../types';

/** Pi headless adapter descriptor. `sdk` class (blocks on the LLM turn); 30s heartbeat. */
export const piDescriptor: AdapterDescriptor = {
  adapterId: 'pi',
  adapterClass: 'sdk',
  blocksOnLLMTurn: true,
  heartbeatMs: 30_000,
};
