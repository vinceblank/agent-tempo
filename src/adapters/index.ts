/**
 * Adapter registry bootstrap + barrel exports.
 *
 * Import side effect: registers every shipped adapter descriptor with the
 * singleton {@link registry}. Callers should:
 *
 * ```ts
 * import { registry } from './adapters';
 * const descriptor = registry.get(metadata.adapterId ?? registry.resolveFromAgentType(metadata.agentType));
 * ```
 *
 * Adding a new adapter is one line — import its descriptor here and call
 * `registry.register(...)`. See `src/adapters/README.md`.
 *
 * Design reference: docs/design/session-lifecycle-rebuild-v2.md §§4.1–4.2.
 * Sequencing memo: §3 PR-B.
 */
import { AdapterRegistry } from './base';
import { claudeCodeDescriptor } from './claude-code';
import { copilotDescriptor } from './copilot';

export const registry = new AdapterRegistry();

registry.register(claudeCodeDescriptor);
registry.register(copilotDescriptor);

export { BaseAttachment, AdapterRegistry } from './base';
export { SdkAttachment } from './sdk/base';
export { InteractiveAttachment } from './claude-code';
export { CopilotSdkAttachment } from './copilot';
export type { AdapterClass, AdapterDescriptor } from '../types';
