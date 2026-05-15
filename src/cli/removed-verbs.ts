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
 * Short hints completing "Use the TUI: agent-tempo → …". Keys are the
 * removed CLI verbs; values name the TUI equivalent.
 */
export const REMOVED_VERBS: Record<string, string> = {
  stop: '/destroy',
  conduct: 'launch directly (the TUI auto-provisions the conductor)',
  start: '/recruit <name>',
  disband: '/destroy',
  detach: '/shutdown (ensemble-wide) — detach is no longer a user-facing verb',
  restart: '/restart <player>',
  recruit: '/recruit <name>',
  migrate: '/migrate <player> <host>',
  resume: '/play',
};

/** Format the error message for a single removed verb. */
export function removedVerbMessage(verb: string): string {
  const hint = REMOVED_VERBS[verb];
  return `"${verb}" is no longer a CLI verb. Use the TUI: agent-tempo → ${hint}. See https://github.com/vinceblank/agent-tempo/issues/285 for details.`;
}

/** Print the removed-verb error to stderr via the shared output helpers. */
export function printRemovedVerbMessage(verb: string): void {
  out.error(removedVerbMessage(verb));
}
