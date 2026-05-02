/**
 * Dashboard slash-command registry — minimal v1 surface (#471/#472).
 *
 * The dashboard ships a smaller command surface than the TUI on purpose:
 * the heavier verbs (recruit / destroy / restart / migrate / schedule /
 * worktree / lineup / status) belong in dedicated screens with structured
 * forms, not as one-line slash commands. Anything not listed here will
 * surface a "delegate to conductor" status banner above the Composer
 * (via `useSlashDispatcher` → `<ComposerStatus>`) so users have a clear
 * next step.
 *
 * Entries are pure metadata — name + description + usage. The submit-time
 * dispatcher in `parse-chat-input` decides what each verb actually does.
 */

export interface DashboardCommandMeta {
  /** Command name without the leading slash. */
  name: string;
  /** Short description for the autofill popup. */
  description: string;
  /** Usage hint (e.g., "/recall <player>"). */
  usage: string;
}

/**
 * The minimal v1 set: operations the dashboard already wires through
 * its own React Query mutations, plus two pure-UI verbs (`clear`,
 * `help`).
 *
 * Order is intentional — the popup renders entries in registry order
 * for the empty-prefix case, so the most-likely verbs come first.
 */
export const DASHBOARD_COMMANDS: readonly DashboardCommandMeta[] = [
  {
    name: 'help',
    description: 'Show available slash commands',
    usage: '/help',
  },
  {
    name: 'clear',
    description: 'Clear the local chat scrollback (does not affect server history)',
    usage: '/clear',
  },
  {
    name: 'pause',
    description: 'Pause every session + scheduler + maestro in this ensemble',
    usage: '/pause',
  },
  {
    name: 'play',
    description: 'Resume a paused ensemble',
    usage: '/play',
  },
  {
    name: 'release',
    description: 'Release all held players (or a single player when given)',
    usage: '/release [player]',
  },
  {
    name: 'recall',
    description: "Read a player's message history",
    usage: '/recall <player>',
  },
];

/**
 * Indexed lookup for popup descriptions and usage hints. Built once at
 * module load — the registry is immutable.
 */
export const DASHBOARD_COMMAND_NAMES: readonly string[] =
  DASHBOARD_COMMANDS.map((c) => c.name);

export function getDashboardCommandMeta(name: string): DashboardCommandMeta | undefined {
  return DASHBOARD_COMMANDS.find((c) => c.name === name.toLowerCase());
}
