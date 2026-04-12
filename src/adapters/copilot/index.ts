/**
 * copilot adapter — descriptor registration.
 *
 * Imported by `src/adapters/index.ts` at module load; registered with the
 * singleton {@link AdapterRegistry} there. Direct consumers should fetch from
 * the registry, not import this descriptor directly.
 *
 * Design reference: docs/design/session-lifecycle-rebuild-v2.md §4.2.
 */
import type { AdapterDescriptor } from '../../types';

export const copilotDescriptor: AdapterDescriptor = {
  adapterId: 'copilot',
  adapterClass: 'sdk',
  // Copilot's sendAndWait blocks on the LLM turn — processingStart/End pairing
  // is required (handled today inline in the bridge; PR-C centralizes it in
  // SdkAttachment.deliver()).
  blocksOnLLMTurn: true,
  // SDK class — 30s cadence per design §4.3. PR-C wires this into the
  // heartbeat loop on BaseAttachment.
  heartbeatMs: 30_000,
};

export { CopilotSdkAttachment } from './adapter';
