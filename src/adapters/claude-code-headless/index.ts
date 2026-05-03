/**
 * claude-code-headless adapter — barrel export.
 *
 * Re-exports the descriptor, class, and pre-flight probes from
 * `./adapter` and `./pre-flight`. `src/adapters/index.ts` imports the
 * descriptor here at module load and registers it with the singleton
 * `AdapterRegistry`. Direct consumers should fetch from the registry,
 * not import the descriptor directly.
 *
 * Same cycle-avoidance pattern as `src/adapters/claude-api/index.ts`,
 * `src/adapters/opencode/index.ts`, and `src/adapters/copilot/index.ts`.
 *
 * Design reference: docs/design/520-claude-code-headless-adapter.md §3.5.
 */
export {
  ClaudeCodeHeadlessAttachment,
  claudeCodeHeadlessDescriptor,
  type ClaudeCodeHeadlessAdapterOptions,
} from './adapter';
export {
  CLAUDE_CODE_PERMISSION_MODES,
  type ClaudeCodeHeadlessPermissionMode,
} from './types';
export {
  probeClaudeBinary,
  probeClaudeAuth,
  parseAuthStatusOutput,
  type BinaryProbeResult,
  type AuthProbeResult,
} from './pre-flight';
