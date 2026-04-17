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
 *   - `load_lineup` tool — delivered as a single system message on the
 *     conductor's inbox when `initialStartup=true`
 *   - TUI (`src/tui/App.tsx`) — rendered as a banner/header when entering a
 *     fresh ensemble whose conductor still has `pendingStartupContext`
 *
 * Intentionally duplicated verbatim across surfaces so the user sees the same
 * phrasing on every entry point. See issue #172 for the rationale.
 */
export function ensembleReadyBanner(name: string, playerCount: number): string {
  const plural = playerCount === 1 ? '' : 's';
  return `Ensemble **${name}** is ready. ${playerCount} player${plural} on standby. Describe your task to begin.`;
}

/**
 * Short directive prepended to the user's first message when pending startup
 * context is being released. Separated from the banner so the conductor sees
 * a distinct "act now" prelude rather than a presentation-layer banner.
 *
 * Issue #172: keeps the lineup's conductor instructions deferred until the
 * user has spoken, then combines context + user intent + release directive
 * into a single prompt so the conductor never acts before the user speaks.
 */
export const RELEASE_PLAYERS_DIRECTIVE =
  'The ensemble is loaded and the user has just spoken for the first time. ' +
  'Decompose their task using the lineup context above, then call the `release` ' +
  'tool to unlock any held players and delegate work.';
