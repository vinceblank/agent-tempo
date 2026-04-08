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

/** /cue <player> [message] — enter chat mode or send a quick cue. */
async function handleCue(
  args: string[],
  dispatch: (action: TuiAction) => void,
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
    commitStatic(dispatch, 'info', `\u2500\u2500 chatting with ${target} \u2500\u2500`);
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
      await api.sendMessage(ensemble, target, message, 'maestro');
      commitStatic(dispatch, 'message', `\u2714 Delivered to ${target}: ${message}`);
    } catch (err) {
      commitStatic(dispatch, 'error', `\u2717 Failed to deliver to ${target}: ${err}`);
    }
  }
}

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
    // No args — show picker (same as /players)
    dispatch({ type: 'SHOW_PICKER', pickerType: 'players' });
    return;
  }

  const target = args[0];
  const icons = statusIcons(supportsUnicode());

  try {
    // Find the player across ensembles
    const ensembles = ctx.activeEnsemble
      ? [{ name: ctx.activeEnsemble }]
      : await api.discoverEnsembles();

    for (const ens of ensembles) {
      const players = await api.getPlayers(ens.name);
      const player = players.find(p => p.playerId === target);
      if (!player) continue;

      // Get detailed metadata
      const metadata = await api.getPlayerMetadata(ens.name, target);
      const messages = await api.getPlayerMessages(ens.name, target);

      const statusIcon = player.status === 'active' ? icons.active
        : player.status === 'stale' ? icons.stale
        : player.status === 'pending' ? icons.pending
        : icons.terminated;

      const lines: string[] = [];
      lines.push(`\n  Player: ${target}`);
      lines.push(`  Type: ${player.playerType || player.agentType || '(default)'}`);
      lines.push(`  Status: ${statusIcon} ${player.status || 'unknown'}`);
      if (player.part) lines.push(`  Part: ${player.part}`);
      if (metadata?.gitBranch) lines.push(`  Branch: ${metadata.gitBranch}`);
      if (metadata?.workDir) lines.push(`  Dir: ${metadata.workDir}`);
      if (player.hostname) lines.push(`  Host: ${player.hostname}`);
      if (player.isConductor) lines.push(`  Role: ${icons.conductor} Conductor`);
      lines.push(`  Ensemble: ${ens.name}`);

      // Recent messages (last 5)
      const recent = messages.slice(-5);
      if (recent.length > 0) {
        lines.push('');
        lines.push(`  Recent messages (last ${recent.length}):`);
        for (const m of recent) {
          const time = formatTimestamp(m.timestamp);
          const isSent = isSentMessage(m);
          const dir = isSent
            ? `${target} ${icons.arrow} ${m.to}`
            : `${(m as Message).from} ${icons.arrow} ${target}`;
          const text = m.text.length > 50 ? m.text.slice(0, 47) + '...' : m.text;
          lines.push(`  ${time}  ${dir}: ${text.replace(/\n/g, ' ')}`);
        }
      }

      commitStatic(dispatch, 'command-output', lines.join('\n'));
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

/** /broadcast <message> — send a message to all active players. */
async function handleBroadcast(
  args: string[],
  dispatch: (action: TuiAction) => void,
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
            await api.sendMessage(ens.name, p.playerId, message, 'maestro');
            sent++;
          } catch {
            // Skip individual failures
          }
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
      commitStatic(dispatch, 'command-output', lines.join('\n'));
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
        await api.sendCommand(ens.name, `/encore ${target}`, 'maestro');
        commitStatic(dispatch, 'info', `\u21BB Encore requested for ${target}. The conductor will revive the session.`);
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
  api: TempoClient,
): Promise<void> {
  // /schedule create → enter wizard
  if (args.length > 0 && args[0].toLowerCase() === 'create') {
    dispatch({ type: 'ENTER_SCHEDULE_WIZARD' });
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
  dispatch: (action: TuiAction) => void,
  _api: TempoClient,
): Promise<void> {
  if (args.length === 0) {
    commitStatic(dispatch, 'error', 'Usage: /unschedule <name>');
    return;
  }
  // TODO: Wire to scheduler workflow signal when TUI has ensemble context
  commitStatic(dispatch, 'info', `Unschedule "${args[0]}" — not yet available from TUI. Use: claude-tempo unschedule ${args[0]}`);
}

/** /status — show ensemble players and status. */
async function handleStatus(
  _args: string[],
  dispatch: (action: TuiAction) => void,
  api: TempoClient,
  ctx: CommandContext,
): Promise<void> {
  if (!ctx.activeEnsemble) {
    commitStatic(dispatch, 'error', 'Not connected to an ensemble.');
    return;
  }
  const players = await api.getPlayers(ctx.activeEnsemble);
  const icons: Record<string, string> = { active: '\u25CF', blocked: '\u25CB', stale: '\u25CC', pending: '\u23F3' };
  const lines = [`Ensemble: ${ctx.activeEnsemble} (${players.length} player${players.length !== 1 ? 's' : ''})\n`];
  for (const p of players) {
    const icon = icons[p.status || 'unknown'] || '?';
    const name = p.playerId.padEnd(20);
    const status = (p.status || '?').padEnd(9);
    const branch = (p.gitBranch || '\u2014').padEnd(14);
    const type = (p.playerType || p.agentType || '\u2014').padEnd(20);
    const part = p.part ? p.part.slice(0, 50) : '';
    const conductor = p.isConductor ? ' \u2605' : '';
    lines.push(`  ${icon} ${name} ${status} ${branch} ${type} ${part}${conductor}`);
  }
  commitStatic(dispatch, 'command-output', lines.join('\n'));
}

/** /gates — list quality gates. */
async function handleGates(
  _args: string[],
  dispatch: (action: TuiAction) => void,
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
  dispatch: (action: TuiAction) => void,
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
      commitStatic(dispatch, 'command-output', lines.join('\n'));
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

    commitStatic(dispatch, 'command-output', lines.join('\n'));
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
    commitStatic(dispatch, 'error', 'No active ensemble. Use /up <name> first.');
    return;
  }

  commitStatic(dispatch, 'info', '\u2026 Recruiting conductor (tempo-conductor)...');

  try {
    await api.sendCommand(ensemble, '/recruit conductor --type tempo-conductor --conductor', 'maestro');
    commitStatic(dispatch, 'info', '\u2714 Conductor recruitment requested. It will appear shortly.');
  } catch (err) {
    // Fallback: shell out if no conductor to receive the command

    exec(`claude-tempo conduct ${ensemble}`, { timeout: 30000 }, (execErr: any) => {
      if (execErr) {
        commitStatic(dispatch, 'error', `\u2717 Failed to recruit conductor: ${execErr.message || execErr}`);
      } else {
        commitStatic(dispatch, 'info', '\u2714 Conductor started. Auto-connecting...');
      }
    });
  }
}

/** /up <name> — create a new ensemble from within the TUI. */
async function handleUp(
  args: string[],
  dispatch: (action: TuiAction) => void,
): Promise<void> {
  if (args.length === 0) {
    commitStatic(dispatch, 'error', 'Usage: /up <ensemble-name> [--lineup <name>]');
    return;
  }

  const name = args[0];
  const lineupIdx = args.indexOf('--lineup');
  const lineup = lineupIdx >= 0 && args[lineupIdx + 1] ? args[lineupIdx + 1] : undefined;

  commitStatic(dispatch, 'info', `\u2026 Starting ensemble "${name}"${lineup ? ` with lineup ${lineup}` : ''}...`);

  // Shell out to claude-tempo up (runs in background, non-blocking)
  const { exec } = require('child_process') as typeof import('child_process');
  const cmd = lineup
    ? `claude-tempo up ${name} --lineup ${lineup}`
    : `claude-tempo up ${name}`;

  exec(cmd, { timeout: 60000 }, (err: any, stdout: string, stderr: string) => {
    if (err) {
      const msg = stderr?.trim() || err.message || 'Unknown error';
      commitStatic(dispatch, 'error', `\u2717 Failed to start ensemble: ${msg}`);
    } else {
      commitStatic(dispatch, 'info', `\u2714 Ensemble "${name}" started. Auto-connecting...`);
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
function isSentMessage(m: Message | (SentMessage & { direction: 'sent' })): m is SentMessage & { direction: 'sent' } {
  return 'direction' in m && (m as SentMessage & { direction: 'sent' }).direction === 'sent';
}

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
    handler: null, // Stub — not yet wired to scheduler workflow
  },
  player: {
    description: 'Show detailed player info',
    usage: '/player <name>',
    handler: handlePlayer,
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
  up: {
    description: 'Create a new ensemble',
    usage: '/up <name> [--lineup <name>]',
    handler: handleUp,
  },
  status: {
    description: 'Show ensemble players and status',
    usage: '/status',
    handler: handleStatus,
  },
  dashboard: {
    description: 'Show player/schedule dashboard',
    usage: '/dashboard',
    handler: null, // Handled directly in App.tsx
  },
  chat: {
    description: 'Enter direct chat with a player',
    usage: '/chat <player>',
    handler: handleCue, // Same handler as /cue
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
