/**
 * claude-code adapter — descriptor registration.
 *
 * Imported by `src/adapters/index.ts` at module load; registered with the
 * singleton {@link AdapterRegistry} there. Direct consumers should fetch from the
 * registry, not import this descriptor directly.
 *
 * Design reference: docs/design/session-lifecycle-rebuild-v2.md §4.2.
 */
import type { AdapterDescriptor } from '../../types';

export const claudeCodeDescriptor: AdapterDescriptor = {
  adapterId: 'claude-code',
  adapterClass: 'interactive',
  blocksOnLLMTurn: false,
  // Interactive class — 60s cadence per design §4.3. PR-C wires this into the
  // heartbeat loop on BaseAttachment.
  heartbeatMs: 60_000,
};

export { InteractiveAttachment } from './adapter';
