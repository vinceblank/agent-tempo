/**
 * claude-api adapter — barrel export.
 *
 * Re-exports the descriptor and class from `./adapter`. `src/adapters/index.ts`
 * imports the descriptor here at module load and registers it with the
 * singleton {@link AdapterRegistry}. Direct consumers should fetch from the
 * registry, not import the descriptor directly.
 *
 * The descriptor constant itself lives colocated with the class in `./adapter`
 * so this file has no inward-pointing imports — same cycle-avoidance pattern
 * the copilot adapter uses.
 *
 * Design reference: docs/design/131-claude-api-adapter.md §2 (adapter class
 * placement) + §3.5 (optional dep gating).
 */
export { DirectApiAttachment, claudeApiDescriptor } from './adapter';
