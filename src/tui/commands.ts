/**
 * Slash command parser and registry for the TUI shell.
 * Parses user input into structured commands and provides handler
 * implementations for each command.
 */
import type { TempoClient } from './client';
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

/** Context passed to command handlers from the shell. */
export interface CommandContext {
  /** Current active ensemble (null if viewing all ensembles). */
  activeEnsemble: string | null;
}

/** Handler function signature for slash commands. */
export type CommandHandler = (
  args: string[],
  dispatch: (action: any) => void,
  api: TempoClient,
  ctx: CommandContext,
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
  api: TempoClient,
  ctx: CommandContext,
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

    // Resolve ensemble — use active or discover
    let ensemble = ctx.activeEnsemble || '';
    if (!ensemble) {
      try {
        const ensembles = await api.discoverEnsembles();
        if (ensembles.length === 1) {
          ensemble = ensembles[0].name;
        } else if (ensembles.length > 1) {
          // Try to find which ensemble the target is in
          for (const ens of ensembles) {
            const players = await api.getPlayers(ens.name);
            if (players.some(p => p.playerId === target)) {
              ensemble = ens.name;
              break;
            }
          }
        }
      } catch {
        // Fall through — ensemble may still be empty
      }
    }

    if (!ensemble) {
      commitStatic(dispatch, 'error', `Player "${target}" not found in any ensemble.`);
      return;
    }

    try {
      await api.sendMessage(ensemble, target, message, 'tui');
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
  api: TempoClient,
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
  api: TempoClient,
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
  api: TempoClient,
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
  api: TempoClient,
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
  _api: TempoClient,
): Promise<void> {
  if (args.length === 0) {
    commitStatic(dispatch, 'info', 'Recruit wizard coming soon. Usage: /recruit <name> [--type <type>] [--dir <path>]');
    return;
  }
  commitStatic(dispatch, 'info', `Recruit for "${args[0]}" — coming soon.`);
}

/** /encore <player> — revive a stale player. */
async function handleEncore(
  args: string[],
  dispatch: (action: any) => void,
  api: TempoClient,
): Promise<void> {
  if (args.length === 0) {
    commitStatic(dispatch, 'error', 'Usage: /encore <player>');
    return;
  }

  const target = args[0];
  try {
    // Find the stale player's ensemble and send encore via conductor
    const ensembles = await api.discoverEnsembles();
    for (const ens of ensembles) {
      const players = await api.getPlayers(ens.name);
      const player = players.find(p => p.playerId === target);
      if (player) {
        if (player.status !== 'stale') {
          commitStatic(dispatch, 'error', `Player "${target}" is ${player.status}, not stale. Encore only works on stale sessions.`);
          return;
        }
        // Send encore command via conductor
        await api.sendCommand(ens.name, `/encore ${target}`, 'tui');
        commitStatic(dispatch, 'info', `\u21BB Encore requested for ${target}. The conductor will revive the session.`);
        return;
      }
    }
    commitStatic(dispatch, 'error', `Player "${target}" not found in any ensemble.`);
  } catch (err) {
    commitStatic(dispatch, 'error', `Encore failed for ${target}: ${err}`);
  }
}

/** /schedule — list active schedules. */
async function handleSchedule(
  args: string[],
  dispatch: (action: any) => void,
  api: TempoClient,
): Promise<void> {
  try {
    const ensembles = await api.discoverEnsembles();
    if (ensembles.length === 0) {
      commitStatic(dispatch, 'info', 'No ensembles running.');
      return;
    }

    const lines: string[] = [];
    for (const ens of ensembles) {
      const schedules = await api.getSchedules(ens.name);
      if (schedules.length > 0) {
        lines.push(`\n  ${ens.name} — ${schedules.length} schedule${schedules.length !== 1 ? 's' : ''}:`);
        for (const s of schedules) {
          const nextFire = formatTimestamp(s.nextFireAt);
          const fired = s.firedCount > 0 ? ` (fired ${s.firedCount}x)` : '';
          lines.push(`    \u21BB ${s.name.padEnd(20)} ${s.type.padEnd(8)} \u2192 ${s.target}  next: ${nextFire}${fired}`);
        }
      }
    }

    if (lines.length === 0) {
      commitStatic(dispatch, 'info', 'No active schedules.');
    } else {
      commitStatic(dispatch, 'command-output', lines.join('\n'));
    }
  } catch (err) {
    commitStatic(dispatch, 'error', `Failed to fetch schedules: ${err}`);
  }
}

/** /unschedule <name> — cancel a schedule. */
async function handleUnschedule(
  args: string[],
  dispatch: (action: any) => void,
  _api: TempoClient,
): Promise<void> {
  if (args.length === 0) {
    commitStatic(dispatch, 'error', 'Usage: /unschedule <name>');
    return;
  }
  // TODO: Wire to scheduler workflow signal when TUI has ensemble context
  commitStatic(dispatch, 'info', `Unschedule "${args[0]}" — not yet available from TUI. Use: claude-tempo unschedule ${args[0]}`);
}

/** /gates — list quality gates. */
async function handleGates(
  _args: string[],
  dispatch: (action: any) => void,
  api: TempoClient,
): Promise<void> {
  try {
    const ensembles = await api.discoverEnsembles();
    if (ensembles.length === 0) {
      commitStatic(dispatch, 'info', 'No ensembles running.');
      return;
    }

    const icons = statusIcons(supportsUnicode());
    const lines: string[] = [];

    for (const ens of ensembles) {
      const gates = await api.getGates(ens.name);
      if (gates.length > 0) {
        lines.push(`\n  ${ens.name} — ${gates.length} gate${gates.length !== 1 ? 's' : ''}:`);
        for (const g of gates) {
          const icon = g.status === 'passed' ? icons.check
            : g.status === 'failed' ? icons.cross
            : '\u25CB'; // open circle
          const statusColor = g.status === 'passed' ? 'passed' : g.status === 'failed' ? 'FAILED' : 'open';
          lines.push(`    ${icon} ${g.task.padEnd(30)} [${statusColor}]`);
          for (const c of g.criteria) {
            const cIcon = c.status === 'passed' ? icons.check : c.status === 'failed' ? icons.cross : icons.pending;
            lines.push(`      ${cIcon} ${c.text} [${c.status}]`);
          }
        }
      }
    }

    if (lines.length === 0) {
      commitStatic(dispatch, 'info', 'No quality gates defined.');
    } else {
      commitStatic(dispatch, 'command-output', lines.join('\n'));
    }
  } catch (err) {
    commitStatic(dispatch, 'error', `Failed to fetch gates: ${err}`);
  }
}

/** /stages — list stages. */
async function handleStages(
  _args: string[],
  dispatch: (action: any) => void,
  api: TempoClient,
): Promise<void> {
  try {
    const ensembles = await api.discoverEnsembles();
    if (ensembles.length === 0) {
      commitStatic(dispatch, 'info', 'No ensembles running.');
      return;
    }

    const icons = statusIcons(supportsUnicode());
    const lines: string[] = [];

    for (const ens of ensembles) {
      const stages = await api.getStages(ens.name);
      if (stages.length > 0) {
        lines.push(`\n  ${ens.name} — ${stages.length} stage${stages.length !== 1 ? 's' : ''}:`);
        for (const s of stages) {
          const icon = s.status === 'complete' ? icons.check
            : s.status === 'failed' ? icons.cross
            : s.status === 'cancelled' ? icons.terminated
            : icons.active;
          lines.push(`    ${icon} ${s.name.padEnd(25)} [${s.status}] (${s.failurePolicy})`);
          for (const p of s.players) {
            const pIcon = p.status === 'reported' ? icons.check
              : p.status === 'blocked' ? icons.cross
              : icons.pending;
            const detail = p.reportText ? ` — ${p.reportText.slice(0, 40)}` : '';
            lines.push(`      ${pIcon} ${p.playerId.padEnd(18)} [${p.status}]${detail}`);
          }
        }
      }
    }

    if (lines.length === 0) {
      commitStatic(dispatch, 'info', 'No stages defined.');
    } else {
      commitStatic(dispatch, 'command-output', lines.join('\n'));
    }
  } catch (err) {
    commitStatic(dispatch, 'error', `Failed to fetch stages: ${err}`);
  }
}

/** /worktree [list] — list active worktrees. */
async function handleWorktree(
  args: string[],
  dispatch: (action: any) => void,
  api: TempoClient,
): Promise<void> {
  const subcommand = args[0] || 'list';

  if (subcommand !== 'list') {
    commitStatic(dispatch, 'info', `Worktree ${subcommand} — not yet available from TUI. Use: claude-tempo worktree ${args.join(' ')}`);
    return;
  }

  try {
    const ensembles = await api.discoverEnsembles();
    if (ensembles.length === 0) {
      commitStatic(dispatch, 'info', 'No ensembles running.');
      return;
    }

    const lines: string[] = [];

    for (const ens of ensembles) {
      const worktrees = await api.getWorktrees(ens.name);
      if (worktrees.length > 0) {
        lines.push(`\n  ${ens.name} — ${worktrees.length} worktree${worktrees.length !== 1 ? 's' : ''}:`);
        for (const w of worktrees) {
          const created = formatTimestamp(w.createdAt);
          lines.push(`    ${w.player.padEnd(18)} ${w.branch.padEnd(25)} ${w.path}`);
          lines.push(`      created: ${created} by ${w.createdBy}`);
        }
      }
    }

    if (lines.length === 0) {
      commitStatic(dispatch, 'info', 'No active worktrees.');
    } else {
      commitStatic(dispatch, 'command-output', lines.join('\n'));
    }
  } catch (err) {
    commitStatic(dispatch, 'error', `Failed to fetch worktrees: ${err}`);
  }
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
    description: 'List active schedules',
    usage: '/schedule',
    handler: handleSchedule,
  },
  unschedule: {
    description: 'Cancel a named schedule',
    usage: '/unschedule <name>',
    handler: handleUnschedule,
  },
  players: {
    description: 'List players in the current ensemble',
    usage: '/players',
    handler: handlePlayers,
  },
  gates: {
    description: 'List quality gates and their status',
    usage: '/gates',
    handler: handleGates,
  },
  stages: {
    description: 'List stages and their status',
    usage: '/stages',
    handler: handleStages,
  },
  worktree: {
    description: 'Manage git worktrees for player isolation',
    usage: '/worktree [list]',
    handler: handleWorktree,
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
