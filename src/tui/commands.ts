/**
 * Slash command parser and registry for the TUI shell.
 * Parses user input into structured commands and provides handler
 * implementations for each command.
 */
import { execFile } from 'child_process';
import type { TempoClient } from '../client';
import type { TuiAction, StaticItem } from './store';
import type { Message, SentMessage } from '../types';
import { statusIcons, supportsUnicode } from './utils/platform';
import { listAllLineups } from '../ensemble/saver';

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
  /** Default agent type from config (defaults to 'claude'). */
  defaultAgent?: 'claude' | 'copilot';
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
      lines.push('\n  \u2139 Showing Maestro event log. Main chat uses ensemble feed.');
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
  ctx: CommandContext,
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
  dispatch({ type: 'ENTER_RECRUIT', answers, defaultAgent: ctx.defaultAgent });
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

/** Delete a schedule by name — shared logic for /schedule delete and /unschedule. */
async function deleteSchedule(
  name: string,
  dispatch: (action: TuiAction) => void,
  api: TempoClient,
  ctx: CommandContext,
): Promise<void> {
  if (!ctx.activeEnsemble) {
    commitStatic(dispatch, 'error', 'No active ensemble. Select one with /ensemble first.');
    return;
  }
  try {
    await api.cancelSchedule(ctx.activeEnsemble, name);
    commitStatic(dispatch, 'message', `\u2714 Schedule "${name}" deleted.`);
  } catch (err) {
    commitStatic(dispatch, 'error', `\u2717 Failed to delete schedule "${name}": ${err}`);
  }
}

/** /schedule [create|delete <name>] — manage schedules. */
async function handleSchedule(
  args: string[],
  dispatch: (action: TuiAction) => void,
  api: TempoClient,
  ctx: CommandContext,
): Promise<void> {
  if (args.length > 0) {
    const sub = args[0].toLowerCase();

    // /schedule create → enter wizard
    if (sub === 'create') {
      dispatch({ type: 'ENTER_SCHEDULE_WIZARD' });
      return;
    }

    // /schedule delete <name>
    if (sub === 'delete') {
      if (args.length < 2) {
        commitStatic(dispatch, 'error', 'Usage: /schedule delete <name>');
        return;
      }
      await deleteSchedule(args[1], dispatch, api, ctx);
      return;
    }

    commitStatic(dispatch, 'error', `Unknown subcommand: ${sub}. Usage: /schedule [create | delete <name>]`);
    return;
  }

  // /schedule (no args) → show interactive overlay
  if (!ctx.activeEnsemble) {
    commitStatic(dispatch, 'error', 'No active ensemble. Select one with /ensemble first.');
    return;
  }
  try {
    const schedules = await api.getSchedules(ctx.activeEnsemble);
    if (schedules.length === 0) {
      dispatch({
        type: 'SHOW_OVERLAY',
        overlay: {
          type: 'schedules',
          title: 'Schedules',
          items: [{ id: '_empty', label: 'No active schedules' }],
          hint: 'n=new  esc=close',
        },
      });
      return;
    }
    const items = schedules.map(s => {
      const timingParts: string[] = [];
      if (s.type === 'interval' && s.interval) {
        timingParts.push(`every ${formatMs(s.interval)}`);
      }
      if (s.cronExpression) {
        timingParts.push(`cron: ${s.cronExpression}`);
      }
      if (s.nextFireAt) {
        timingParts.push(`next: ${formatTimestamp(s.nextFireAt)}`);
      }
      if (s.firedCount > 0) {
        timingParts.push(`fired ${s.firedCount}x`);
      }
      return {
        id: s.name,
        label: `${s.name} \u2192 ${s.target}`,
        sublabel: timingParts.join('  \u00B7  ') || s.type,
      };
    });
    dispatch({
      type: 'SHOW_OVERLAY',
      overlay: {
        type: 'schedules',
        title: 'Schedules',
        items,
        hint: 'n=new  d=delete  esc=close',
      },
    });
  } catch (err) {
    commitStatic(dispatch, 'error', `Failed to fetch schedules: ${err}`);
  }
}

/** /unschedule <name> — alias for /schedule delete. */
async function handleUnschedule(
  args: string[],
  dispatch: (action: TuiAction) => void,
  api: TempoClient,
  ctx: CommandContext,
): Promise<void> {
  if (args.length === 0) {
    commitStatic(dispatch, 'error', 'Usage: /unschedule <name> (hint: use /schedule delete <name>)');
    return;
  }
  await deleteSchedule(args[0], dispatch, api, ctx);
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
    const allItems: Array<{ id: string; label: string; sublabel?: string }> = [];

    for (const ensName of ensembleNames) {
      const gates = await api.getGates(ensName);
      for (const g of gates) {
        const icon = g.status === 'passed' ? icons.check
          : g.status === 'failed' ? icons.cross
          : '\u25CB';
        const criteriaSum = g.criteria.map(c => {
          const cIcon = c.status === 'passed' ? icons.check : c.status === 'failed' ? icons.cross : icons.pending;
          return `${cIcon} ${c.text}`;
        }).join('  ');
        allItems.push({
          id: `${ensName}:${g.task}`,
          label: `${icon} ${g.task}  [${g.status}]`,
          sublabel: criteriaSum || '(no criteria)',
        });
      }
    }

    if (allItems.length === 0) {
      commitStatic(dispatch, 'info', 'No quality gates defined.');
    } else {
      dispatch({
        type: 'SHOW_OVERLAY',
        overlay: {
          type: 'gates',
          title: 'Quality Gates',
          items: allItems,
          hint: '\u21B5=detail  esc=close',
        },
      });
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
    const allItems: Array<{ id: string; label: string; sublabel?: string }> = [];

    for (const ensName of ensembleNames) {
      const stages = await api.getStages(ensName);
      for (const s of stages) {
        const icon = s.status === 'complete' ? icons.check
          : s.status === 'failed' ? icons.cross
          : s.status === 'cancelled' ? icons.terminated
          : icons.active;
        const playerSum = s.players.map(p => {
          const pIcon = p.status === 'reported' ? icons.check
            : p.status === 'blocked' ? icons.cross
            : icons.pending;
          return `${pIcon} ${p.playerId}`;
        }).join('  ');
        allItems.push({
          id: `${ensName}:${s.name}`,
          label: `${icon} ${s.name}  [${s.status}]  (${s.failurePolicy})`,
          sublabel: playerSum || '(no players)',
        });
      }
    }

    if (allItems.length === 0) {
      commitStatic(dispatch, 'info', 'No stages defined.');
    } else {
      dispatch({
        type: 'SHOW_OVERLAY',
        overlay: {
          type: 'stages',
          title: 'Stages',
          items: allItems,
          hint: '\u21B5=detail  esc=close',
        },
      });
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
  ctx: CommandContext,
): Promise<void> {
  const subcommand = args[0] || 'list';

  // /worktree create <player> [--branch <name>] — delegate to conductor
  if (subcommand === 'create') {
    if (args.length < 2) {
      commitStatic(dispatch, 'error', 'Usage: /worktree create <player> [--branch <name>]');
      return;
    }
    const ensemble = ctx.activeEnsemble;
    if (!ensemble) {
      commitStatic(dispatch, 'error', 'No active ensemble. Use /ensemble to select one.');
      return;
    }
    const ensembles = await api.discoverEnsembles();
    const ens = ensembles.find(e => e.name === ensemble);
    if (!ens?.hasConductor) {
      commitStatic(dispatch, 'error', 'No conductor in this ensemble. Worktree create requires a conductor.');
      return;
    }
    const cmdParts = args.slice(0); // ['create', '<player>', ...flags]
    await api.sendCommand(ensemble, `/worktree ${cmdParts.join(' ')}`, 'maestro');
    commitStatic(dispatch, 'info', `\u2192 Worktree create request sent to conductor for ${args[1]}.`);
    return;
  }

  // /worktree remove <player> — delegate to conductor
  if (subcommand === 'remove') {
    if (args.length < 2) {
      commitStatic(dispatch, 'error', 'Usage: /worktree remove <player>');
      return;
    }
    const ensemble = ctx.activeEnsemble;
    if (!ensemble) {
      commitStatic(dispatch, 'error', 'No active ensemble. Use /ensemble to select one.');
      return;
    }
    const ensembles = await api.discoverEnsembles();
    const ens = ensembles.find(e => e.name === ensemble);
    if (!ens?.hasConductor) {
      commitStatic(dispatch, 'error', 'No conductor in this ensemble. Worktree remove requires a conductor.');
      return;
    }
    await api.sendCommand(ensemble, `/worktree remove ${args[1]}`, 'maestro');
    commitStatic(dispatch, 'info', `\u2192 Worktree remove request sent to conductor for ${args[1]}.`);
    return;
  }

  if (subcommand !== 'list') {
    commitStatic(dispatch, 'error', `Unknown subcommand: ${subcommand}. Usage: /worktree [list | create <player> | remove <player>]`);
    return;
  }

  try {
    const ensembles = await api.discoverEnsembles();
    if (ensembles.length === 0) {
      commitStatic(dispatch, 'info', 'No ensembles running.');
      return;
    }

    const allItems: Array<{ id: string; label: string; sublabel?: string }> = [];

    for (const ens of ensembles) {
      const worktrees = await api.getWorktrees(ens.name);
      for (const w of worktrees) {
        allItems.push({
          id: `${ens.name}:${w.player}`,
          label: `${w.player} \u2192 ${w.branch}`,
          sublabel: `${w.path}  (${w.createdBy})`,
        });
      }
    }

    if (allItems.length === 0) {
      commitStatic(dispatch, 'info', 'No active worktrees.');
    } else {
      dispatch({
        type: 'SHOW_OVERLAY',
        overlay: {
          type: 'worktrees',
          title: 'Worktrees',
          items: allItems,
          hint: 'esc=close',
        },
      });
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
    const seen = new Set<string>();

    for (const ens of ensembles) {
      // Fetch from both Maestro event log (100) and ensemble chat cache (500)
      const [messages, chatResult] = await Promise.all([
        api.getMessages(ens.name, 100),
        api.getEnsembleChat(ens.name, 0, 500).catch(() => ({ messages: [] as any[] })),
      ]);

      // Merge both sources, dedup by from+to+timestamp prefix
      const combined = [
        ...messages.map(m => ({ from: m.from, to: m.to, text: m.text, timestamp: m.timestamp })),
        ...chatResult.messages.map((m: any) => ({ from: m.from, to: m.to, text: m.text, timestamp: m.timestamp })),
      ];

      for (const m of combined) {
        const dedupKey = `${m.from}:${m.to}:${m.text.slice(0, 60)}:${m.timestamp.slice(0, 19)}`;
        if (seen.has(dedupKey)) continue;
        seen.add(dedupKey);

        const haystack = `${m.from} ${m.to} ${m.text}`.toLowerCase();
        if (haystack.includes(termLower)) {
          allResults.push({ ensemble: ens.name, ...m });
        }
      }
    }

    if (allResults.length === 0) {
      commitStatic(dispatch, 'info', `No messages matching "${term}".`);
      return;
    }

    const lines: string[] = [`\n  ${allResults.length} result${allResults.length !== 1 ? 's' : ''} for "${term}":\n`];

    for (const r of allResults.slice(-50)) {
      const time = formatTimestamp(r.timestamp);
      const text = r.text.replace(/\n/g, ' ');
      const truncated = text.length > 70 ? text.slice(0, 67) + '...' : text;
      lines.push(`  ${time}  ${r.from} \u2192 ${r.to}: ${truncated}`);
    }

    if (allResults.length > 50) {
      lines.push(`\n  ... and ${allResults.length - 50} more. Narrow your search for fewer results.`);
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
  // shell: true resolves .cmd wrappers on Windows
  execFile('claude-tempo', ['conduct', ensemble], { timeout: 30000, shell: true }, (execErr: any) => {
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
      // No file arg — show available lineups
      try {
        const lineups = listAllLineups();
        if (lineups.length === 0) {
          commitStatic(dispatch, 'info', 'No lineups available. Create one with /lineup save.');
          return;
        }
        const items = lineups.map(l => ({
          id: l.name,
          label: l.name,
          sublabel: l.source === 'saved' ? 'saved' : 'shipped example',
        }));
        dispatch({
          type: 'SHOW_OVERLAY',
          overlay: {
            type: 'lineups',
            title: 'Available Lineups',
            items,
            hint: 'Usage: /lineup load <name>  \u00B7  esc=close',
          },
        });
      } catch {
        commitStatic(dispatch, 'error', 'Usage: /lineup load <name>');
      }
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

/** /go — release all held players in the current ensemble. */
async function handleGo(
  _args: string[],
  dispatch: (action: TuiAction) => void,
  api: TempoClient,
  ctx: CommandContext,
): Promise<void> {
  const ensemble = ctx.activeEnsemble;
  if (!ensemble) {
    commitStatic(dispatch, 'error', 'No active ensemble. Use /ensemble to select one.');
    return;
  }

  const ensembles = await api.discoverEnsembles();
  const ens = ensembles.find(e => e.name === ensemble);
  if (!ens?.hasConductor) {
    commitStatic(dispatch, 'error', 'No conductor in this ensemble. /go requires a conductor.');
    return;
  }

  try {
    await api.sendCommand(ensemble, '/release', 'maestro');
    commitStatic(dispatch, 'info', '\u2714 Release command sent to conductor.');
  } catch (err) {
    commitStatic(dispatch, 'error', `\u2717 Release failed: ${err}`);
  }
}

/** /pause — pause the current ensemble. */
async function handlePause(
  _args: string[],
  dispatch: (action: TuiAction) => void,
  api: TempoClient,
  ctx: CommandContext,
): Promise<void> {
  const ensemble = ctx.activeEnsemble;
  if (!ensemble) {
    commitStatic(dispatch, 'error', 'No active ensemble. Use /ensemble to select one.');
    return;
  }

  const ensembles = await api.discoverEnsembles();
  const ens = ensembles.find(e => e.name === ensemble);
  if (!ens?.hasConductor) {
    commitStatic(dispatch, 'error', 'No conductor in this ensemble. /pause requires a conductor.');
    return;
  }

  try {
    await api.sendCommand(ensemble, '/pause', 'maestro');
    commitStatic(dispatch, 'info', '\u23F8 Pause command sent to conductor.');
  } catch (err) {
    commitStatic(dispatch, 'error', `\u2717 Pause failed: ${err}`);
  }
}

/** /resume — resume a paused ensemble. */
async function handleResume(
  _args: string[],
  dispatch: (action: TuiAction) => void,
  api: TempoClient,
  ctx: CommandContext,
): Promise<void> {
  const ensemble = ctx.activeEnsemble;
  if (!ensemble) {
    commitStatic(dispatch, 'error', 'No active ensemble. Use /ensemble to select one.');
    return;
  }

  const ensembles = await api.discoverEnsembles();
  const ens = ensembles.find(e => e.name === ensemble);
  if (!ens?.hasConductor) {
    commitStatic(dispatch, 'error', 'No conductor in this ensemble. /resume requires a conductor.');
    return;
  }

  try {
    await api.sendCommand(ensemble, '/resume', 'maestro');
    commitStatic(dispatch, 'info', '\u25B6 Resume command sent to conductor.');
  } catch (err) {
    commitStatic(dispatch, 'error', `\u2717 Resume failed: ${err}`);
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

/** Format milliseconds as a human-readable duration (e.g. "30s", "5m", "1.5h"). */
function formatMs(ms: number): string {
  if (ms < 60000) return `${Math.round(ms / 1000)}s`;
  if (ms < 3600000) return `${Math.round(ms / 60000)}m`;
  return `${(ms / 3600000).toFixed(1)}h`;
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
    description: 'Manage schedules — list, create, or delete',
    usage: '/schedule [create | delete <name>]',
    handler: handleSchedule,
  },
  players: {
    description: 'List active players or show player detail',
    usage: '/players [name]',
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
    usage: '/worktree [list | create <player> | remove <player>]',
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
  go: {
    description: 'Release all held players (unlock outbox)',
    usage: '/go',
    handler: handleGo,
  },
  pause: {
    description: 'Pause the ensemble (sessions, scheduler)',
    usage: '/pause',
    handler: handlePause,
  },
  resume: {
    description: 'Resume a paused ensemble',
    usage: '/resume',
    handler: handleResume,
  },
  back: {
    description: 'Return to maestro view',
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

/** Commands that take a player name as their first parameter. */
export const PLAYER_PARAM_COMMANDS = new Set(['stop', 'encore', 'worktree']);

/** Commands with hardcoded subcommands (shown in autocomplete). */
export const SUBCOMMAND_MAP: Record<string, string[]> = {
  worktree: ['create', 'remove', 'list'],
  stage: ['create', 'list', 'cancel'],
  schedule: ['create', 'delete'],
  lineup: ['load', 'save'],
  ensemble: ['save', 'list', 'show'],
};
