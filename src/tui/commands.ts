/**
 * Slash command parser and registry for the TUI shell.
 * Parses user input into structured commands and provides handler
 * implementations for each command.
 */
import { exec } from 'child_process';
import type { TempoClient } from './client';
import type { TuiAction, StaticItem } from './store';
import type { Message, SentMessage } from '../types';
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
  dispatch: (action: TuiAction) => void,
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

function commitStatic(
  dispatch: (action: TuiAction) => void,
  type: StaticItem['type'],
  content: string,
): void {
  dispatch({
    type: 'COMMIT_STATIC',
    item: { id: nextId(), type, content, timestamp: Date.now() },
  });
}

// ── Handlers ──

/** /players — show interactive player picker. */
async function handlePlayers(
  _args: string[],
  dispatch: (action: TuiAction) => void,
  _api: TempoClient,
): Promise<void> {
  // Show picker overlay — data comes from store (already polled)
  dispatch({ type: 'SHOW_PICKER', pickerType: 'players' });
}

/** /player <name> — show detailed player info. */
async function handlePlayer(
  args: string[],
  dispatch: (action: TuiAction) => void,
  api: TempoClient,
  ctx: CommandContext,
): Promise<void> {
  if (args.length === 0) {
    // No args — show picker with navigate intent (App.tsx dispatches NAVIGATE_PLAYER on selection)
    dispatch({ type: 'SHOW_PICKER', pickerType: 'players', intent: 'navigate' });
    return;
  }

  const target = args[0];

  try {
    // Verify the player exists
    const ensembles = ctx.activeEnsemble
      ? [{ name: ctx.activeEnsemble }]
      : await api.discoverEnsembles();

    for (const ens of ensembles) {
      const players = await api.getPlayers(ens.name);
      const player = players.find(p => p.playerId === target);
      if (!player) continue;

      // Navigate to the player detail view
      dispatch({ type: 'NAVIGATE_PLAYER', playerId: target });
      return;
    }

    commitStatic(dispatch, 'error', `Player "${target}" not found in any ensemble.`);
  } catch (err) {
    commitStatic(dispatch, 'error', `Failed to get player info: ${err}`);
  }
}

/** /stop <player> — request stop confirmation. */
async function handleStop(
  args: string[],
  dispatch: (action: TuiAction) => void,
): Promise<void> {
  if (args.length === 0) {
    commitStatic(dispatch, 'error', 'Usage: /stop <player>');
    return;
  }

  const target = args[0];
  // Enter confirmation mode — App.tsx handles the y/n input
  dispatch({ type: 'CONFIRM_STOP', player: target });
}

/** /disband — tear down the current ensemble (with confirmation). */
async function handleDisband(
  _args: string[],
  dispatch: (action: TuiAction) => void,
  _api: TempoClient,
  ctx: CommandContext,
): Promise<void> {
  const ensemble = ctx.activeEnsemble;
  if (!ensemble) {
    commitStatic(dispatch, 'error', 'No active ensemble. Navigate to one first with /ensemble <name>.');
    return;
  }

  // Enter confirmation mode — App.tsx handles the y/n input
  dispatch({ type: 'CONFIRM_DISBAND', ensemble });
}

/** /broadcast <message> — send a message to all active players in the current ensemble. */
async function handleBroadcast(
  args: string[],
  dispatch: (action: TuiAction) => void,
  api: TempoClient,
  ctx: CommandContext,
): Promise<void> {
  if (args.length === 0) {
    commitStatic(dispatch, 'error', 'Usage: /broadcast <message>');
    return;
  }

  if (!ctx.activeEnsemble) {
    commitStatic(dispatch, 'error', 'No active ensemble. Select one with /ensemble first.');
    return;
  }

  const message = args.join(' ');
  try {
    const players = await api.getPlayers(ctx.activeEnsemble);
    let sent = 0;
    for (const p of players) {
      if (p.status === 'active') {
        try {
          await api.sendMessage(ctx.activeEnsemble, p.playerId, message, 'maestro');
          sent++;
        } catch {
          // Skip individual failures
        }
      }
    }
    commitStatic(dispatch, 'message', `\u2714 Broadcast delivered to ${sent} player${sent !== 1 ? 's' : ''}: ${message}`);
  } catch (err) {
    commitStatic(dispatch, 'error', `\u2717 Broadcast failed: ${err}`);
  }
}

/** /recall [player] — fetch message history. */
async function handleRecall(
  args: string[],
  dispatch: (action: TuiAction) => void,
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
      const title = targetPlayer ? `Recall \u00B7 ${targetPlayer}` : 'Recall \u00B7 all';
      dispatch({ type: 'SHOW_COMMAND_OVERLAY', title, content: lines.join('\n') });
    }
  } catch (err) {
    commitStatic(dispatch, 'error', `Failed to recall messages: ${err}`);
  }
}

/** /recruit [name] — launch the recruit wizard. Pre-fills name if given. */
async function handleRecruit(
  args: string[],
  dispatch: (action: TuiAction) => void,
  _api: TempoClient,
): Promise<void> {
  // Parse optional inline args: /recruit name --type foo --dir /path
  const answers: Record<string, string> = {};
  if (args.length > 0 && !args[0].startsWith('--')) {
    answers.name = args[0];
  }
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--type' && args[i + 1]) answers.playerType = args[++i];
    if (args[i] === '--dir' && args[i + 1]) answers.workDir = args[++i];
    if (args[i] === '--agent' && args[i + 1]) answers.agent = args[++i];
    if (args[i] === '--host' && args[i + 1]) answers.host = args[++i];
  }
  dispatch({ type: 'ENTER_RECRUIT', answers });
}

/** /encore <player> — revive a stale player. */
async function handleEncore(
  args: string[],
  dispatch: (action: TuiAction) => void,
  api: TempoClient,
): Promise<void> {
  if (args.length === 0) {
    commitStatic(dispatch, 'error', 'Usage: /encore <player>');
    return;
  }

  const target = args[0];
  try {
    // Find the stale player and encore directly via the maestro session's outbox
    const ensembles = await api.discoverEnsembles();
    for (const ens of ensembles) {
      const players = await api.getPlayers(ens.name);
      const player = players.find(p => p.playerId === target);
      if (player) {
        if (player.status !== 'stale') {
          commitStatic(dispatch, 'error', `Player "${target}" is ${player.status}, not stale. Encore only works on stale sessions.`);
          return;
        }
        await api.encorePlayer(ens.name, target);
        commitStatic(dispatch, 'info', `\u21BB Encore submitted for ${target}. The session will be revived with context restored.`);
        return;
      }
    }
    commitStatic(dispatch, 'error', `Player "${target}" not found in any ensemble.`);
  } catch (err) {
    commitStatic(dispatch, 'error', `Encore failed for ${target}: ${err}`);
  }
}

/** /schedule [create] — list schedules or enter creation wizard. */
async function handleSchedule(
  args: string[],
  dispatch: (action: TuiAction) => void,
): Promise<void> {
  // /schedule create → enter wizard
  if (args.length > 0 && args[0].toLowerCase() === 'create') {
    dispatch({ type: 'ENTER_SCHEDULE_WIZARD' });
    return;
  }

  // /schedule (no args) → show schedule overlay with already-polled data
  dispatch({ type: 'SHOW_SCHEDULE_OVERLAY' });
}

/** /unschedule <name> — cancel a named schedule. */
async function handleUnschedule(
  args: string[],
  dispatch: (action: TuiAction) => void,
  api: TempoClient,
  ctx: CommandContext,
): Promise<void> {
  if (args.length === 0) {
    commitStatic(dispatch, 'error', 'Usage: /unschedule <name>');
    return;
  }

  if (!ctx.activeEnsemble) {
    commitStatic(dispatch, 'error', 'No active ensemble. Select one with /ensemble first.');
    return;
  }

  const name = args[0];
  try {
    await api.cancelSchedule(ctx.activeEnsemble, name);
    commitStatic(dispatch, 'message', `\u2714 Schedule "${name}" cancelled.`);
  } catch (err) {
    commitStatic(dispatch, 'error', `\u2717 Failed to cancel schedule "${name}": ${err}`);
  }
}

/** /status — show ensemble status overlay. */
async function handleStatus(
  _args: string[],
  dispatch: (action: TuiAction) => void,
): Promise<void> {
  dispatch({ type: 'SHOW_STATUS' });
}

/** /gates — list quality gates. */
async function handleGates(
  _args: string[],
  dispatch: (action: TuiAction) => void,
  api: TempoClient,
  ctx: CommandContext,
): Promise<void> {
  try {
    let ensembleNames: string[];
    if (ctx.activeEnsemble) {
      ensembleNames = [ctx.activeEnsemble];
    } else {
      const ensembles = await api.discoverEnsembles();
      if (ensembles.length === 0) {
        commitStatic(dispatch, 'info', 'No ensembles running.');
        return;
      }
      ensembleNames = ensembles.map(e => e.name);
    }

    const icons = statusIcons(supportsUnicode());
    const lines: string[] = [];

    for (const ensName of ensembleNames) {
      const gates = await api.getGates(ensName);
      if (gates.length > 0) {
        lines.push(`\n  ${ensName} — ${gates.length} gate${gates.length !== 1 ? 's' : ''}:`);
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
      dispatch({ type: 'SHOW_COMMAND_OVERLAY', title: 'Quality Gates', content: lines.join('\n') });
    }
  } catch (err) {
    commitStatic(dispatch, 'error', `Failed to fetch gates: ${err}`);
  }
}

/** /stages — list stages. */
async function handleStages(
  _args: string[],
  dispatch: (action: TuiAction) => void,
  api: TempoClient,
  ctx: CommandContext,
): Promise<void> {
  try {
    let ensembleNames: string[];
    if (ctx.activeEnsemble) {
      ensembleNames = [ctx.activeEnsemble];
    } else {
      const ensembles = await api.discoverEnsembles();
      if (ensembles.length === 0) {
        commitStatic(dispatch, 'info', 'No ensembles running.');
        return;
      }
      ensembleNames = ensembles.map(e => e.name);
    }

    const icons = statusIcons(supportsUnicode());
    const lines: string[] = [];

    for (const ensName of ensembleNames) {
      const stages = await api.getStages(ensName);
      if (stages.length > 0) {
        lines.push(`\n  ${ensName} — ${stages.length} stage${stages.length !== 1 ? 's' : ''}:`);
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
      dispatch({ type: 'SHOW_COMMAND_OVERLAY', title: 'Stages', content: lines.join('\n') });
    }
  } catch (err) {
    commitStatic(dispatch, 'error', `Failed to fetch stages: ${err}`);
  }
}

/** /worktree [list] — list active worktrees. */
async function handleWorktree(
  args: string[],
  dispatch: (action: TuiAction) => void,
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
      dispatch({ type: 'SHOW_COMMAND_OVERLAY', title: 'Worktrees', content: lines.join('\n') });
    }
  } catch (err) {
    commitStatic(dispatch, 'error', `Failed to fetch worktrees: ${err}`);
  }
}

/** /search <term> — search message history. */
async function handleSearch(
  args: string[],
  dispatch: (action: TuiAction) => void,
  api: TempoClient,
  ctx: CommandContext,
): Promise<void> {
  if (args.length === 0) {
    commitStatic(dispatch, 'error', 'Usage: /search <term>');
    return;
  }

  const term = args.join(' ');
  const termLower = term.toLowerCase();

  try {
    // Fetch messages from ensemble(s)
    const ensembles = ctx.activeEnsemble
      ? [{ name: ctx.activeEnsemble }]
      : await api.discoverEnsembles();

    const allResults: Array<{ ensemble: string; from: string; to: string; text: string; timestamp: string }> = [];

    for (const ens of ensembles) {
      const messages = await api.getMessages(ens.name, 100);
      for (const m of messages) {
        const haystack = `${m.from} ${m.to} ${m.text}`.toLowerCase();
        if (haystack.includes(termLower)) {
          allResults.push({
            ensemble: ens.name,
            from: m.from,
            to: m.to,
            text: m.text,
            timestamp: m.timestamp,
          });
        }
      }
    }

    if (allResults.length === 0) {
      commitStatic(dispatch, 'info', `No messages matching "${term}".`);
      return;
    }

    const lines: string[] = [`\n  ${allResults.length} result${allResults.length !== 1 ? 's' : ''} for "${term}":\n`];

    for (const r of allResults.slice(-20)) {
      const time = formatTimestamp(r.timestamp);
      const text = r.text.replace(/\n/g, ' ');
      const truncated = text.length > 70 ? text.slice(0, 67) + '...' : text;
      lines.push(`  ${time}  ${r.from} \u2192 ${r.to}: ${truncated}`);
    }

    if (allResults.length > 20) {
      lines.push(`\n  ... and ${allResults.length - 20} more. Narrow your search for fewer results.`);
    }

    dispatch({ type: 'SHOW_COMMAND_OVERLAY', title: `Search \u00B7 "${term}"`, content: lines.join('\n') });
  } catch (err) {
    commitStatic(dispatch, 'error', `Search failed: ${err}`);
  }
}

/** /recruit-conductor — one-shot recruit a conductor for the current ensemble. */
async function handleRecruitConductor(
  _args: string[],
  dispatch: (action: TuiAction) => void,
  api: TempoClient,
  ctx: CommandContext,
): Promise<void> {
  const ensemble = ctx.activeEnsemble;
  if (!ensemble) {
    commitStatic(dispatch, 'error', 'No active ensemble. Use /ensemble to select or create one.');
    return;
  }

  commitStatic(dispatch, 'info', '\u2026 Recruiting conductor (tempo-conductor)...');

  // Spawn the conductor directly via CLI — no conductor exists yet to receive commands
  exec(`claude-tempo conduct ${ensemble}`, { timeout: 30000 }, (execErr: any) => {
    if (execErr) {
      commitStatic(dispatch, 'error', `\u2717 Failed to recruit conductor: ${execErr.message || execErr}`);
    } else {
      commitStatic(dispatch, 'info', '\u2714 Conductor started. Auto-connecting...');
    }
  });
}

/** /lineup load|save — manage ensemble lineups. */
async function handleLineup(
  args: string[],
  dispatch: (action: TuiAction) => void,
  api: TempoClient,
  ctx: CommandContext,
): Promise<void> {
  if (args.length === 0) {
    commitStatic(dispatch, 'error', 'Usage: /lineup load <file> | /lineup save [file]');
    return;
  }

  const subcommand = args[0].toLowerCase();

  if (subcommand === 'load') {
    if (args.length < 2) {
      commitStatic(dispatch, 'error', 'Usage: /lineup load <file.yml>');
      return;
    }
    const filePath = args[1];
    // Enter lineup confirmation mode — App.tsx handles y/n
    dispatch({
      type: 'CONFIRM_LINEUP',
      action: 'load',
      path: filePath,
      summary: `Load lineup from: ${filePath}`,
    });
    return;
  }

  if (subcommand === 'save') {
    const ensemble = ctx.activeEnsemble;
    if (!ensemble) {
      commitStatic(dispatch, 'error', 'No active ensemble. Use /ensemble <name> first.');
      return;
    }

    const filePath = args[1] || `ensemble-${ensemble}.yml`;
    try {
      await api.sendCommand(ensemble, `/save_lineup ${filePath}`, 'maestro');
      commitStatic(dispatch, 'info', `\u2714 Lineup save requested: ${filePath}`);
    } catch (err) {
      commitStatic(dispatch, 'error', `\u2717 Failed to save lineup: ${err}`);
    }
    return;
  }

  commitStatic(dispatch, 'error', `Unknown lineup subcommand: ${subcommand}. Use: load, save`);
}

/** /ensembles — show interactive ensemble picker. */
async function handleEnsembles(
  _args: string[],
  dispatch: (action: TuiAction) => void,
  _api: TempoClient,
): Promise<void> {
  dispatch({ type: 'SHOW_PICKER', pickerType: 'ensembles' });
}

/** /ensemble <name> — switch active ensemble context. */
async function handleEnsemble(
  args: string[],
  dispatch: (action: TuiAction) => void,
  api: TempoClient,
): Promise<void> {
  if (args.length === 0) {
    // No args — show ensemble picker
    dispatch({ type: 'SHOW_PICKER', pickerType: 'ensembles' });
    return;
  }

  const name = args[0];

  try {
    const ensembles = await api.discoverEnsembles();
    const match = ensembles.find(e => e.name === name);

    if (!match) {
      const available = ensembles.map(e => e.name).join(', ') || 'none';
      commitStatic(dispatch, 'error', `Ensemble "${name}" not found. Available: ${available}`);
      return;
    }

    // Switch ensemble — clears old data, polling will refresh
    dispatch({ type: 'NAVIGATE_ENSEMBLE', ensemble: name });
    commitStatic(dispatch, 'info', `\u2714 Switched to ensemble: ${name} (${match.playerCount} player${match.playerCount !== 1 ? 's' : ''})`);
  } catch (err) {
    commitStatic(dispatch, 'error', `Failed to switch ensemble: ${err}`);
  }
}

// ── Utility ──

/** Type guard: distinguish SentMessage (has `to` + `direction`) from Message (has `from`). */
export function isSentMessage(m: Message | (SentMessage & { direction: 'sent' })): m is SentMessage & { direction: 'sent' } {
  return 'direction' in m && (m as SentMessage & { direction: 'sent' }).direction === 'sent';
}

export function formatTimestamp(ts: string): string {
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
  disband: {
    description: 'Tear down the current ensemble (all sessions + scheduler)',
    usage: '/disband',
    handler: handleDisband,
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
    description: 'List schedules or create a new one',
    usage: '/schedule [create]',
    handler: handleSchedule,
  },
  unschedule: {
    description: 'Cancel a named schedule',
    usage: '/unschedule <name>',
    handler: handleUnschedule,
  },
  player: {
    description: 'Show detailed player info',
    usage: '/player <name>',
    handler: handlePlayer,
  },
  players: {
    description: 'List active players',
    usage: '/players',
    handler: null, // Handled directly in App.tsx
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
  lineup: {
    description: 'Load or save an ensemble lineup',
    usage: '/lineup load <file> | save [file]',
    handler: handleLineup,
  },
  ensemble: {
    description: 'Switch active ensemble context',
    usage: '/ensemble <name>',
    handler: handleEnsemble,
  },
  search: {
    description: 'Search message history',
    usage: '/search <term>',
    handler: handleSearch,
  },
  help: {
    description: 'Show available commands',
    usage: '/help [command]',
    handler: null, // Handled directly in App.tsx
  },
  'recruit-conductor': {
    description: 'Recruit a conductor for the current ensemble',
    usage: '/recruit-conductor',
    handler: handleRecruitConductor,
  },
  status: {
    description: 'Show ensemble players and status',
    usage: '/status',
    handler: handleStatus,
  },
  back: {
    description: 'Return to maestro view',
    usage: '/back',
    handler: null, // Handled directly in App.tsx
  },
  home: {
    description: 'Return to maestro view',
    usage: '/home',
    handler: null, // Handled directly in App.tsx (alias for /back)
  },
  maestro: {
    description: 'Return to maestro view',
    usage: '/maestro',
    handler: null, // Handled directly in App.tsx (alias for /back)
  },
  quit: {
    description: 'Exit the TUI',
    usage: '/quit',
    handler: null, // Handled directly in App.tsx
  },
  exit: {
    description: 'Exit the TUI (alias for /quit)',
    usage: '/exit',
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

/** Commands that take a player name as their first parameter. */
export const PLAYER_PARAM_COMMANDS = new Set(['stop', 'encore', 'worktree']);

/** Commands with hardcoded subcommands (shown in autocomplete). */
export const SUBCOMMAND_MAP: Record<string, string[]> = {
  worktree: ['create', 'remove', 'list'],
  stage: ['create', 'list', 'cancel'],
  schedule: ['create', 'list', 'cancel'],
  lineup: ['load', 'save'],
  ensemble: ['save', 'list', 'show'],
};
