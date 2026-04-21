/**
 * Lookup table + helper for the ten CLI verbs removed in #288 (design #285).
 *
 * Kept in its own module so the CLI entrypoint (`src/cli.ts`) can dispatch
 * removed-verb errors BEFORE loading the Temporal-touching command surface —
 * the same crash-proof pattern as `help-text.ts` — and so the mapping can be
 * unit-tested without spinning up the parser or dispatch loop.
 *
 * Any change to this table should ship alongside a matching edit in
 * `src/cli/help-text.ts` under the "Removed in v0.27 (use the TUI)" block.
 */
import * as out from './output';

/**
 * Short hints completing "Use the TUI: claude-tempo → …". Keys are the
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
  migrate: '/restart <player> --host <hostname>',
  pause: '/pause',
  resume: '/play',
};

/** Format the error message for a single removed verb. */
export function removedVerbMessage(verb: string): string {
  const hint = REMOVED_VERBS[verb];
  return `"${verb}" is no longer a CLI verb. Use the TUI: claude-tempo → ${hint}. See https://github.com/vinceblank/claude-tempo/issues/285 for details.`;
}

/** Print the removed-verb error to stderr via the shared output helpers. */
export function printRemovedVerbMessage(verb: string): void {
  out.error(removedVerbMessage(verb));
}
