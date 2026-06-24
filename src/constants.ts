/**
 * Shared constants used across the CLI, TUI, and MCP tool layers.
 *
 * Keep runtime-free (no imports) so this module can be pulled into workflow
 * code without dragging Node-only modules into the sandboxed bundle.
 */

/**
 * CLI flag injected into every Claude Code spawn to carry the ensemble name as a
 * sentinel in the process's CommandLine. `src/activities/hard-terminate.ts`
 * matches against this flag to scope `destroy --all` kills to a single ensemble
 * (issue #180): two ensembles sharing a lineup template (identical player names)
 * must not clobber each other's processes.
 *
 * The claude CLI silently accepts this flag even when remote control is inactive,
 * and the value remains visible in Win32_Process.CommandLine / /proc/<pid>/cmdline
 * for the kill regex to match.
 */
export const ENSEMBLE_SENTINEL_FLAG = '--remote-control-session-name-prefix';

/**
 * 2.0 wire-protocol version (#786 — the cutover keystone). Single source of truth
 * for the protocol stamp, the boot guard, and the `claimAttachment` adapter
 * handshake.
 *
 * - **Stamp:** every 2.0-created workflow records `protocol: PROTOCOL_VERSION` on
 *   its START input (so it's in history from run 1 and survives `continueAsNew`
 *   via the input spread) and upserts the memo key {@link
 *   MEMO_KEYS.protocol | `AgentTempoProtocol`} = PROTOCOL_VERSION.
 * - **Boot guard:** a 2.0 daemon refuses to register workers if visibility shows
 *   any Running agent-tempo workflow lacking the stamp — a 2.0 worker can never
 *   deterministically replay a 1.x-recorded history, so we fail LOUD at boot
 *   (printing `agent-tempo upgrade-to-2`) instead of non-determinism-faulting
 *   deep in a workflow task later.
 * - **claimAttachment:** the adapter sends `protocolVersion`; a 2.0 workflow
 *   rejects any value `!== PROTOCOL_VERSION` (incl. a v1 adapter that omits it).
 *
 * This module is runtime-free, so the constant is safe to import from BOTH the
 * sandboxed workflow bundle (the stamp + claim validator) AND the daemon guard /
 * CLI (the check). Bumping it is a hard cutover — see `docs/design/v2-scoping.md`.
 */
export const PROTOCOL_VERSION = 2 as const;

/**
 * Escape the two regex metacharacters that can appear in validated player/ensemble
 * names (which are constrained to `[A-Za-z0-9._-]+`). Safe to interpolate the
 * result into a regex source string.
 */
export function escapeNameForRegex(s: string): string {
  return s.replace(/[.-]/g, (c) => `\\${c}`);
}

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
    'IMPORTANT: The ensemble is PAUSED and players are HELD. Do not take any action yet — the user has not described their task.',
    '',
    'When the user sends their first message, you must:',
    '1. Call the `resume_ensemble` tool to unpause the scheduler and sessions.',
    '2. Call the `release` tool (no args) to deliver any deferred task assignments to held players and unlock their outboxes.',
    '3. Then decompose the user\'s task using the lineup context above, and delegate to the appropriate players.',
    '',
    'If the user has not spoken yet, wait silently.',
  ].join('\n');
}

/** One command-center access tier — its short label + the source-of-truth wording. */
export interface CommandCenterAccessTier {
  /** Short label shown at the head of the line (e.g. `No auth`, `/login`, `API key`). */
  label: string;
  /** Tier wording — mirrored VERBATIM into docs/cli.md (drift-guarded). */
  description: string;
}

/**
 * #791 — command-center access tiers. THE SINGLE SOURCE OF TRUTH for the three
 * access levels the `command-center` board offers, shared between the launch
 * banner (`src/cli/command-center-command.ts`) and `docs/cli.md`.
 *
 * The tiers are independent, NOT a strict ladder: tier 1 (board + operator
 * controls) needs NO auth on a local loopback daemon; tiers 2/3 only add the
 * LLM PLANNER (ask / handoff / recruit), which needs either a Claude
 * subscription via in-session `/login` (zero API key) or an `ANTHROPIC_API_KEY`.
 *
 * `tests/cli/command-center-access-tiers.test.ts` asserts the banner renders
 * every tier AND that `docs/cli.md` carries each tier's label + description
 * verbatim — so the launch text and the docs can never drift.
 */
export const COMMAND_CENTER_ACCESS_TIERS: readonly CommandCenterAccessTier[] = [
  {
    label: 'No auth',
    description:
      'board + operator controls (cue, pause, play, restart, destroy) — works out of the box on a local (loopback) daemon; no token or login required.',
  },
  {
    label: '/login',
    description:
      'LLM planner on your Claude Pro/Max subscription — run /login inside the board to enable the planner (ask, handoff, recruit) with zero API key.',
  },
  {
    label: 'API key',
    description:
      'LLM planner on an API key — set ANTHROPIC_API_KEY before launch to run the planner against the Anthropic API.',
  },
];

/**
 * Render {@link COMMAND_CENTER_ACCESS_TIERS} as plain indented `  • label — description`
 * lines for the `command-center` launch banner. One string per tier; the caller
 * styles them and prints a heading. Runtime-free, so it stays importable anywhere.
 */
export function commandCenterAccessTierLines(): string[] {
  return COMMAND_CENTER_ACCESS_TIERS.map((t) => `  • ${t.label} — ${t.description}`);
}
