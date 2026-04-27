/**
 * Mock adapter descriptor — kept in its own file so `index.ts` (which gates the
 * import behind `isDevMode()`) can reference the constant without pulling in
 * the full `adapter.ts` compile unit.
 *
 * Mirrors the `copilotDescriptor` colocation pattern; ADR 0014 §4.1 fixes the
 * SDK class + 30 s heartbeat cadence.
 */
import type { AdapterDescriptor } from '../../types';

export const mockDescriptor: AdapterDescriptor = {
  adapterId: 'mock',
  // SDK class — pull-delivery + processingStart/End pairing matches what the
  // dashboard renders for real Claude Code / Copilot sessions (ADR 0014 §4.1).
  adapterClass: 'sdk',
  // The mock pretends to think between actions (`delayMs`, default 500 ms in
  // scripted mode) so the dashboard sees a believable processing window —
  // exactly the property a real LLM turn has.
  blocksOnLLMTurn: true,
  // SDK class cadence per `docs/design/session-lifecycle-rebuild-v2.md` §4.3.
  heartbeatMs: 30_000,
};
