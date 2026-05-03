/**
 * Pure-constant types for the claude-code-headless adapter.
 *
 * Lives in its own file so consumers (the adapter class, the spawn
 * helper, the recruit tool's Zod schema, the `RecruitOutboxEntry` shape,
 * the `SpawnProcessInput` shape) can import the canonical permission-mode
 * tuple WITHOUT dragging in `@temporalio/client` (which the adapter class
 * needs but the others don't). DRY single-source-of-truth — adding a new
 * permission mode means editing exactly one tuple. Addresses QA Nit 3
 * from PR-1's review.
 */

/**
 * Permission-mode tuple accepted by `claude -p --permission-mode`. Single
 * source of truth — all of:
 *
 *   - `ClaudeCodeHeadlessPermissionMode` type (this file)
 *   - `recruit` MCP tool Zod enum
 *   - `RecruitOutboxEntry.permissionMode`
 *   - `SpawnProcessInput.permissionMode`
 *   - `ClaudeCodeHeadlessAdapterOpts.permissionMode` (spawn helper)
 *   - `ClaudeCodeHeadlessAdapterOptions.permissionMode` (adapter class)
 *
 * import / re-derive from this tuple. Adding a new mode requires editing
 * only this tuple; the type + Zod enum + every consumer's schema follow.
 */
export const CLAUDE_CODE_PERMISSION_MODES = [
  'acceptEdits',
  'auto',
  'bypassPermissions',
  'default',
  'dontAsk',
  'plan',
] as const;

/** Permission mode for `claude -p --permission-mode`. Derived from {@link CLAUDE_CODE_PERMISSION_MODES}. */
export type ClaudeCodeHeadlessPermissionMode = typeof CLAUDE_CODE_PERMISSION_MODES[number];
