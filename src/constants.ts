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
 * user has spoken, then combines context + user intent + directive into a
 * single prompt so the conductor never acts before the user speaks.
 *
 * The ensemble is paused at startup via `pause_ensemble` (scheduler +
 * per-session outbox + maestro), so the directive instructs the conductor to
 * call `resume_ensemble` BEFORE any other action — this unblocks the players
 * it will then delegate to.
 */
export const RESUME_ENSEMBLE_DIRECTIVE =
  'IMPORTANT: Call the `resume_ensemble` tool BEFORE any other action — ' +
  'this unpauses the scheduler and unlocks all player outboxes. Then proceed ' +
  'with the lineup context above and the user task below.';
