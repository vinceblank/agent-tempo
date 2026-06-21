/**
 * Lookup table + helper for the CLI verbs removed in #288 (design #285).
 *
 * Kept in its own module so `src/cli.ts` can dispatch removed-verb errors
 * BEFORE loading the Temporal-touching command surface (crash-proof
 * pattern, same as `help-text.ts`) and so the mapping can be unit-tested
 * without spinning up the dispatch loop.
 *
 * Any change to this table should ship alongside matching edits in
 * `src/cli/help-text.ts` and `src/cli.ts` (no `case` for any key here).
 *
 * Dev-mode verbs (#432) are intercepted before this table — a verb is
 * either dev-mode-live or removed-with-a-hint, never both. The
 * mechanical test in `test/cli-dev-verbs.test.ts` enforces this.
 */
import * as out from './output';

/**
 * Hints for removed CLI verbs. Keys are the removed verbs; values complete
 * the "Use …" sentence in {@link removedVerbMessage}.
 *
 * #789 (E.8): the Ink TUI is gone, so the #288-era "Use the TUI: …" hints
 * were rewritten against the surviving operator surfaces — mission-control
 * (`agent-tempo command-center`, slash commands) with the web dashboard as
 * the zero-dependency fallback. Per the v2 scoping plan (§C.3), this WHOLE
 * file — every entry including the new `tui` one — ships for one 2.0
 * release as migration hints and is then deleted as a unit.
 */
const CC = 'the command-center: agent-tempo command-center → ';

export const REMOVED_VERBS: Record<string, string> = {
  stop: `${CC}/destroy <player>`,
  conduct: '`agent-tempo up` (auto-provisions the conductor), then `agent-tempo command-center`',
  start: `${CC}/recruit <name>`,
  disband: `${CC}/destroy <player> (or /ensemble-down)`,
  detach: `${CC}/ensemble-down (detach is no longer a user-facing verb)`,
  restart: `${CC}/restart <player>`,
  recruit: `${CC}/recruit <name>`,
  migrate: `${CC}/migrate <player> <host>`,
  resume: `${CC}/play`,
  // #789 — the TUI launch verb itself. Bare `agent-tempo` is now the status
  // home; the live surfaces are the command-center and the web dashboard.
  tui: 'bare `agent-tempo` for status, `agent-tempo command-center` for the live board (Pi seat), or `agent-tempo dashboard`',
};

/** Format the error message for a single removed verb. */
export function removedVerbMessage(verb: string): string {
  const hint = REMOVED_VERBS[verb];
  return `"${verb}" is no longer a CLI verb. Use ${hint}. See https://github.com/vinceblank/agent-tempo/issues/285 for details.`;
}

/** Print the removed-verb error to stderr via the shared output helpers. */
export function printRemovedVerbMessage(verb: string): void {
  out.error(removedVerbMessage(verb));
}
