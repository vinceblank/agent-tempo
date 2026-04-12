/**
 * claude-code adapter — barrel export.
 *
 * Re-exports the descriptor and class from `./adapter`. `src/adapters/index.ts`
 * imports the descriptor here at module load and registers it with the
 * singleton {@link AdapterRegistry}. Direct consumers should fetch from the
 * registry, not import the descriptor directly.
 *
 * The descriptor constant itself lives colocated with the class in `./adapter`
 * so this file has no inward-pointing imports — breaks the module-graph cycle
 * flagged in PR-B QA review.
 *
 * Design reference: docs/design/session-lifecycle-rebuild-v2.md §4.2.
 */
export { InteractiveAttachment, claudeCodeDescriptor } from './adapter';
