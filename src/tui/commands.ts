/**
 * Slash command parser and registry for the TUI shell.
 * Parses user input into structured commands and provides handler
 * implementations for each command.
 */
import type { TuiApi } from './core-api';
import { statusIcons, supportsUnicode } from './utils/platform';

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

// ── Static item helper ──

let _staticIdCounter = 0;
function nextId(): string {
  return `cmd-${++_staticIdCounter}`;
}

function commitStatic(dispatch: (action: any) => void, type: string, content: string): void {
  dispatch({
    type: 'COMMIT_STATIC',
    item: { id: nextId(), type, content, timestamp: Date.now() },
  });
}

// ── Handlers ──

/** /cue <player> [message] — enter chat mode or send a quick cue. */
async function handleCue(
  args: string[],
  dispatch: (action: any) => void,
  api: TuiApi,
): Promise<void> {
  if (args.length === 0) {
    commitStatic(dispatch, 'error', 'Usage: /cue <player> [message]');
    return;
  }

  const target = args[0];

  if (args.length === 1) {
    // Enter chat mode with this player
    dispatch({ type: 'ENTER_CHAT', target });
    commitStatic(dispatch, 'info', `Entering chat mode with ${target}. Type messages directly, /back to exit.`);
  } else {
    // Quick cue — send message without entering chat mode
    const message = args.slice(1).join(' ');
    try {
      await api.sendMessage('', target, message, 'tui');
      commitStatic(dispatch, 'message', `\u2192 ${target}: ${message}`);
    } catch (err) {
      commitStatic(dispatch, 'error', `Failed to send cue to ${target}: ${err}`);
    }
  }
}

/** /players — list players in the current ensemble. */
async function handlePlayers(
  _args: string[],
  dispatch: (action: any) => void,
  api: TuiApi,
): Promise<void> {
  // The player data is already in state via polling; format from recent poll data.
  // We can't access state directly here, so we'll fetch fresh data.
  try {
    const ensembles = await api.discoverEnsembles();
    if (ensembles.length === 0) {
      commitStatic(dispatch, 'info', 'No ensembles running.');
      return;
    }

    // Show all players across ensembles
    const icons = statusIcons(supportsUnicode());
    const lines: string[] = [];

    for (const ens of ensembles) {
      const players = await api.getPlayers(ens.name);
      lines.push(`\n  ${ens.name} (${players.length} players):`);
      for (const p of players) {
        const icon = p.isConductor ? icons.conductor
          : p.status === 'active' ? icons.active
          : p.status === 'stale' ? icons.stale
          : icons.pending;
        const typeName = p.playerType || p.agentType || '';
        const part = p.part ? ` \u2014 ${p.part}` : '';
        lines.push(`    ${icon} ${p.playerId.padEnd(18)} ${typeName.padEnd(13)} [${p.status || '?'}]${part}`);
      }
    }

    commitStatic(dispatch, 'command-output', lines.join('\n'));
  } catch (err) {
    commitStatic(dispatch, 'error', `Failed to fetch players: ${err}`);
  }
}

/** /stop <player> — terminate a player session. */
async function handleStop(
  args: string[],
  dispatch: (action: any) => void,
  api: TuiApi,
): Promise<void> {
  if (args.length === 0) {
    commitStatic(dispatch, 'error', 'Usage: /stop <player>');
    return;
  }

  const target = args[0];
  try {
    // Discover the ensemble this player belongs to
    const ensembles = await api.discoverEnsembles();
    for (const ens of ensembles) {
      try {
        await api.terminatePlayer(ens.name, target);
        commitStatic(dispatch, 'info', `\u2717 Stopped player: ${target}`);
        return;
      } catch {
        // Try next ensemble
      }
    }
    commitStatic(dispatch, 'error', `Player "${target}" not found in any ensemble.`);
  } catch (err) {
    commitStatic(dispatch, 'error', `Failed to stop ${target}: ${err}`);
  }
}

/** /broadcast <message> — send a message to all active players. */
async function handleBroadcast(
  args: string[],
  dispatch: (action: any) => void,
  api: TuiApi,
): Promise<void> {
  if (args.length === 0) {
    commitStatic(dispatch, 'error', 'Usage: /broadcast <message>');
    return;
  }

  const message = args.join(' ');
  try {
    const ensembles = await api.discoverEnsembles();
    let sent = 0;
    for (const ens of ensembles) {
      const players = await api.getPlayers(ens.name);
      for (const p of players) {
        if (p.status === 'active') {
          try {
            await api.sendMessage(ens.name, p.playerId, message, 'tui');
            sent++;
          } catch {
            // Skip individual failures
          }
        }
      }
    }
    commitStatic(dispatch, 'message', `\u21D2 Broadcast sent to ${sent} player${sent !== 1 ? 's' : ''}: ${message}`);
  } catch (err) {
    commitStatic(dispatch, 'error', `Broadcast failed: ${err}`);
  }
}

/** /recall [player] — fetch message history. */
async function handleRecall(
  args: string[],
  dispatch: (action: any) => void,
  api: TuiApi,
): Promise<void> {
  try {
    const ensembles = await api.discoverEnsembles();
    if (ensembles.length === 0) {
      commitStatic(dispatch, 'info', 'No ensembles running.');
      return;
    }

    const targetPlayer = args[0];
    const lines: string[] = [];

    for (const ens of ensembles) {
      const messages = await api.getMessages(ens.name, 20);
      const filtered = targetPlayer
        ? messages.filter(m => m.from === targetPlayer || m.to === targetPlayer)
        : messages;

      if (filtered.length > 0) {
        lines.push(`\n  ${ens.name} — ${filtered.length} message${filtered.length !== 1 ? 's' : ''}:`);
        for (const m of filtered.slice(-15)) {
          const time = formatTimestamp(m.timestamp);
          const text = m.text.length > 60 ? m.text.slice(0, 57) + '...' : m.text;
          lines.push(`    ${time}  ${m.from} \u2192 ${m.to}: ${text}`);
        }
      }
    }

    if (lines.length === 0) {
      commitStatic(dispatch, 'info', targetPlayer
        ? `No messages found for "${targetPlayer}".`
        : 'No recent messages.');
    } else {
      commitStatic(dispatch, 'command-output', lines.join('\n'));
    }
  } catch (err) {
    commitStatic(dispatch, 'error', `Failed to recall messages: ${err}`);
  }
}

/** /recruit — placeholder. */
async function handleRecruit(
  args: string[],
  dispatch: (action: any) => void,
  _api: TuiApi,
): Promise<void> {
  if (args.length === 0) {
    commitStatic(dispatch, 'info', 'Recruit wizard coming soon. Usage: /recruit <name> [--type <type>] [--dir <path>]');
    return;
  }
  commitStatic(dispatch, 'info', `Recruit for "${args[0]}" — coming soon.`);
}

/** /encore <player> — placeholder. */
async function handleEncore(
  args: string[],
  dispatch: (action: any) => void,
  _api: TuiApi,
): Promise<void> {
  if (args.length === 0) {
    commitStatic(dispatch, 'error', 'Usage: /encore <player>');
    return;
  }
  commitStatic(dispatch, 'info', `Encore for "${args[0]}" — coming soon.`);
}

// ── Utility ──

function formatTimestamp(ts: string): string {
  try {
    const d = new Date(ts);
    return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
  } catch {
    return '??:??';
  }
}

// ── Registry ──

/** All supported slash commands. */
export const COMMANDS: Record<string, CommandDef> = {
  cue: {
    description: 'Send a message to a player',
    usage: '/cue <player> [message]',
    handler: handleCue,
  },
  recruit: {
    description: 'Spawn a new player session',
    usage: '/recruit <name> [--type <type>] [--dir <path>]',
    handler: handleRecruit,
  },
  stop: {
    description: 'Stop a player session',
    usage: '/stop <player>',
    handler: handleStop,
  },
  broadcast: {
    description: 'Send a message to all active players',
    usage: '/broadcast <message>',
    handler: handleBroadcast,
  },
  encore: {
    description: 'Revive a stale player session',
    usage: '/encore <player>',
    handler: handleEncore,
  },
  recall: {
    description: "Read a player's message history",
    usage: '/recall [player] [--limit N]',
    handler: handleRecall,
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
  players: {
    description: 'List players in the current ensemble',
    usage: '/players',
    handler: handlePlayers,
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
  help: {
    description: 'Show available commands',
    usage: '/help [command]',
    handler: null, // Handled directly in App.tsx
  },
  back: {
    description: 'Go back to the previous view',
    usage: '/back',
    handler: null, // Handled directly in App.tsx
  },
  quit: {
    description: 'Exit the TUI',
    usage: '/quit',
    handler: null, // Handled directly in App.tsx
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
