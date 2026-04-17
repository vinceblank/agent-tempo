/**
 * Shared constants used across the CLI, TUI, and MCP tool layers.
 *
 * Keep runtime-free (no imports) so this module can be pulled into workflow
 * code without dragging Node-only modules into the sandboxed bundle.
 */

/**
 * Canonical "ensemble ready" banner shown after `up` / `conduct` completes
 * ensemble startup but before the user has typed their first message.
 *
 * Used by:
 *   - CLI (`src/cli/commands.ts`) — printed on stdout after successful setup
 *   - `load_lineup` tool — delivered as the banner half of the combined
 *     system message seeded on the conductor's inbox when `initialStartup=true`
 *
 * Intentionally duplicated verbatim across surfaces so the user sees the same
 * phrasing on every entry point. See issue #172 for the rationale.
 */
export function ensembleReadyBanner(name: string, playerCount: number): string {
  const plural = playerCount === 1 ? '' : 's';
  return `Ensemble **${name}** is ready. ${playerCount} player${plural} on standby. Describe your task to begin.`;
}

/**
 * Combined banner + "wait for user, then resume_ensemble first" directive
 * baked into the conductor's `messages[]` at workflow creation on
 * initial-startup paths (`up --lineup` / `conduct --lineup`). Issue #172.
 *
 * Delivered as a single `from: 'system'` message that the conductor reads
 * alongside the lineup instructions. The directive is carried via the
 * message text itself — the LLM reads "wait silently until the user speaks,
 * then call `resume_ensemble` FIRST" and honors it. No workflow-level
 * interceptor is needed; the ensemble-wide pause (`pause_ensemble`) is what
 * actually stops other players from acting while the conductor waits.
 */
export function ensembleReadyDirective(name: string, playerCount: number): string {
  return [
    ensembleReadyBanner(name, playerCount),
    '',
    'IMPORTANT: The ensemble is PAUSED. Do not take any action yet — the user has not described their task.',
    '',
    'When the user sends their first message, you must:',
    '1. Call the `resume_ensemble` tool FIRST to unpause the scheduler and unlock player outboxes.',
    '2. Then decompose the user\'s task using the lineup context above, and delegate to the appropriate players.',
    '',
    'If the user has not spoken yet, wait silently.',
  ].join('\n');
}
