/**
 * Slash command parser and registry for the TUI shell.
 * Parses user input into structured commands and provides a skeleton
 * registry for handler implementations.
 */
import type { TuiApi } from './core-api';

// ── Types ──

export interface ParsedCommand {
  /** Command name (without the leading slash). */
  name: string;
  /** Positional arguments after the command name. */
  args: string[];
  /** The original raw input string. */
  raw: string;
}

/** Handler function signature for slash commands. */
export type CommandHandler = (
  args: string[],
  dispatch: (action: any) => void,
  api: TuiApi,
) => Promise<void>;

/** Command definition with metadata. */
export interface CommandDef {
  /** Short description for /help output. */
  description: string;
  /** Usage hint (e.g., "/cue <player> <message>"). */
  usage: string;
  /** Handler implementation (null = not yet implemented). */
  handler: CommandHandler | null;
}

// ── Parser ──

/**
 * Parse raw input into a structured command.
 * Returns null if input is not a slash command (doesn't start with "/").
 */
export function parseCommand(input: string): ParsedCommand | null {
  const trimmed = input.trim();
  if (!trimmed.startsWith('/')) return null;

  // Split on whitespace, treating the first token as the command
  const parts = trimmed.slice(1).split(/\s+/).filter(Boolean);
  if (parts.length === 0) return null;

  const name = parts[0].toLowerCase();
  const args = parts.slice(1);

  return { name, args, raw: trimmed };
}

// ── Registry ──

/** All supported slash commands. Handlers are filled in by the view layer. */
export const COMMANDS: Record<string, CommandDef> = {
  cue: {
    description: 'Send a message to a player',
    usage: '/cue <player> <message>',
    handler: null,
  },
  recruit: {
    description: 'Spawn a new player session',
    usage: '/recruit <name> [--type <type>] [--dir <path>]',
    handler: null,
  },
  stop: {
    description: 'Stop a player session',
    usage: '/stop <player>',
    handler: null,
  },
  broadcast: {
    description: 'Send a message to all active players',
    usage: '/broadcast <message>',
    handler: null,
  },
  encore: {
    description: 'Revive a stale player session',
    usage: '/encore <player>',
    handler: null,
  },
  recall: {
    description: "Read a player's message history",
    usage: '/recall [player] [--limit N]',
    handler: null,
  },
  schedule: {
    description: 'Create a scheduled message',
    usage: '/schedule <name> --to <player> --every <interval> <message>',
    handler: null,
  },
  unschedule: {
    description: 'Cancel a named schedule',
    usage: '/unschedule <name>',
    handler: null,
  },
  help: {
    description: 'Show available commands',
    usage: '/help [command]',
    handler: null,
  },
  players: {
    description: 'List players in the current ensemble',
    usage: '/players',
    handler: null,
  },
  gates: {
    description: 'List quality gates and their status',
    usage: '/gates',
    handler: null,
  },
  stages: {
    description: 'List stages and their status',
    usage: '/stages',
    handler: null,
  },
  worktree: {
    description: 'Manage git worktrees for player isolation',
    usage: '/worktree <create|remove|list> [args...]',
    handler: null,
  },
  back: {
    description: 'Go back to the previous view',
    usage: '/back',
    handler: null,
  },
  quit: {
    description: 'Exit the TUI',
    usage: '/quit',
    handler: null,
  },
};

/** Get sorted list of command names for display. */
export function getCommandNames(): string[] {
  return Object.keys(COMMANDS).sort();
}

/** Check if a command name is registered. */
export function isValidCommand(name: string): boolean {
  return name in COMMANDS;
}

/** Format a help summary of all commands. */
export function formatHelpSummary(): string {
  const lines = getCommandNames().map(name => {
    const cmd = COMMANDS[name];
    return `  ${cmd.usage.padEnd(48)} ${cmd.description}`;
  });
  return ['Available commands:', '', ...lines, '', 'Type /help <command> for details.'].join('\n');
}
