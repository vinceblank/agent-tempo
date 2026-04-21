/**
 * Migration hints for slash commands removed or renamed in the S6
 * rewrite. Every entry maps a legacy name to a one-liner pointing at
 * the replacement, so users who rely on muscle memory get a clear
 * correction instead of a generic "unknown command" error.
 */

export const REMOVED_SLASH_COMMANDS: Record<string, string> = {
  pause_ensemble: '/pause_ensemble was renamed to /pause.',
  resume_ensemble: '/resume_ensemble was renamed to /play.',
  resume: '/resume was renamed to /play to avoid colliding with `claude --resume`.',
  detach: '/detach was removed; /shutdown handles ensemble-scope teardown and conductor reaping.',
  disband: '/disband was removed; /destroy <ensemble> is the replacement.',
};

/** Build the help-text suffix appended after a migration-hint line. */
export function removedSlashCommandHelp(name: string): string | null {
  const hint = REMOVED_SLASH_COMMANDS[name];
  return hint ? `${hint} Type /help for the current command list.` : null;
}
