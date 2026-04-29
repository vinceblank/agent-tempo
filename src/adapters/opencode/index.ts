/**
 * opencode adapter — barrel export.
 *
 * Re-exports the descriptor and class from `./adapter`. `src/adapters/index.ts`
 * imports the descriptor here at module load and registers it with the
 * singleton {@link AdapterRegistry}. Direct consumers should fetch from the
 * registry, not import the descriptor directly.
 *
 * Same cycle-avoidance pattern as `src/adapters/claude-api/index.ts` and
 * `src/adapters/copilot/index.ts`.
 */
export { OpenCodeAttachment, opencodeDescriptor } from './adapter';
