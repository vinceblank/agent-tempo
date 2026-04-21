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
import { phaseToLabel } from './utils/format';
import { listAllLineups } from '../ensemble/saver';
import { formatAttachmentInfoForDisplay } from '../utils/attachment-format';
import { formatHostList } from '../utils/format-hosts';
import { buildTimeline, formatRecall } from '../utils/recall-format';

// ── Types ──

export interface ParsedCommand {
  /** Command name (without the leading slash). */
  name: string;
  /** Positional arguments after the command name. */
  args: string[];
  /** The original raw input string. */
  raw: string;
  /**
   * #109: `true` when tokenization encountered an opening quote that never
   * closed (e.g. user is mid-typing `/x "hello`). Strictly additive — existing
   * handlers that don't inspect this field keep their forgiving-input behavior
   * unchanged. Future strict-mode callers can opt in by checking the flag and
   * surfacing an error sentinel before dispatch. Absent on well-formed input.
   */
  unterminatedQuote?: boolean;
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
 * Quote-aware tokenizer (#109). Splits on whitespace EXCEPT within balanced
 * `"…"` or `'…'` runs. Backslash escapes are intentionally NOT supported — the
 * TUI's command surface is small and escape handling adds failure modes
 * (Windows paths mis-escaping, for example). Callers that need literal quotes
 * inside an argument can use the other quote kind: `/x "with 'apostrophe'"`.
 *
 * Returns a tuple of `{ tokens, unterminatedQuote }`:
 *  - Well-formed input:  `unterminatedQuote === false`, all tokens split.
 *  - Mid-typed input with an open quote (e.g. `/x "hello`): everything still
 *    flushes as the final token and `unterminatedQuote === true` so downstream
 *    strict callers can distinguish. The TUI's on-every-keystroke consumer
 *    ignores the flag — forgiving input by design.
 *
 * Exported for unit tests; callers outside this module should use
 * {@link parseCommand} which wraps this with slash-prefix validation and
 * command-name lowercasing.
 */
export function tokenize(input: string): { tokens: string[]; unterminatedQuote: boolean } {
  const tokens: string[] = [];
  let cur = '';
  let inSingle = false;
  let inDouble = false;
  // Tracks whether any char has been emitted into `cur` during the current
  // token — needed so that an explicit empty string (`""`) becomes a real
  // zero-length token rather than being collapsed with the surrounding
  // whitespace boundary.
  let hasContent = false;

  const flush = () => {
    if (cur.length > 0 || hasContent) {
      tokens.push(cur);
      cur = '';
      hasContent = false;
    }
  };

  for (let i = 0; i < input.length; i++) {
    const ch = input[i];
    if (ch === '"' && !inSingle) {
      inDouble = !inDouble;
      hasContent = true;
      continue;
    }
    if (ch === "'" && !inDouble) {
      inSingle = !inSingle;
      hasContent = true;
      continue;
    }
    if (/\s/.test(ch) && !inSingle && !inDouble) {
      flush();
      continue;
    }
    cur += ch;
    hasContent = true;
  }
  flush();
  return { tokens, unterminatedQuote: inSingle || inDouble };
}

/**
 * Parse raw input into a structured command.
 * Returns null if input is not a slash command (doesn't start with "/").
 *
 * Uses the quote-aware {@link tokenize} helper so `/schedule create foo cron "0 * * * *"`
 * correctly binds the cron expression as a single argument (#109). When the input
 * has an unterminated quote (user mid-typing), the `unterminatedQuote` flag is
 * surfaced on the returned ParsedCommand — existing callers that ignore it keep
 * their pre-#109 forgiving behavior.
 */
export function parseCommand(input: string): ParsedCommand | null {
  const trimmed = input.trim();
  if (!trimmed.startsWith('/')) return null;

  const { tokens, unterminatedQuote } = tokenize(trimmed.slice(1));
  if (tokens.length === 0) return null;

  const name = tokens[0].toLowerCase();
  const args = tokens.slice(1);

  return unterminatedQuote
    ? { name, args, raw: trimmed, unterminatedQuote: true }
    : { name, args, raw: trimmed };
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

/**
 * /destroy <player> [reason] — request terminal-destroy confirmation.
 *
 * PR-H (#132): consolidates the legacy `/stop` slash command (which routed
 * through `terminatePlayer` — raw Temporal terminate) and the no-confirm
 * `/destroy` shipped in PR-D into one flow. The slash command always
 * prompts y/N first; the yes-confirm handler in App.tsx routes through
 * `TempoClient.destroy()` (V2 `destroyUpdate` via the outbox path) so the
 * adapter's `isDestroyed` query sees the terminal state cleanly.
 *
 * The optional `reason` is concatenated from args[1..] and stashed on the
 * action for the confirmation handler to forward to `destroy(reason)`.
 */
async function handleDestroy(
  args: string[],
  dispatch: (action: TuiAction) => void,
  _api: TempoClient,
  ctx: CommandContext,
): Promise<void> {
  if (args.length === 0) {
    commitStatic(dispatch, 'error', 'Usage: /destroy <player|ensemble> [reason]');
    return;
  }

  const target = args[0];
  // Ensemble scope: target matches the active ensemble → typed-name
  // confirmation. Player scope: any other target → y/N. The active-ensemble
  // match is unambiguous inside a single-ensemble TUI session.
  if (target === ctx.activeEnsemble) {
    dispatch({ type: 'CONFIRM_ENSEMBLE_DESTROY', ensemble: target });
    return;
  }
  const reason = args.slice(1).join(' ') || undefined;
  dispatch({ type: 'CONFIRM_STOP', player: target, ...(reason !== undefined ? { reason } : {}) });
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
      // Broadcast to talkable phases only — `active` (attached/processing) and
      // `idle` (awaiting). Mirrors `shouldIncludeInBroadcast` in utils/validation.
      const label = phaseToLabel(p.phase);
      if (label === 'active' || label === 'idle') {
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

/**
 * /hosts [--all] — list daemons polling this Temporal namespace.
 *
 * #274. Surfaces the same data as `claude-tempo hosts` CLI and the
 * `hosts` MCP tool via the shared `formatHostList` helper.
 * `--all` opts into stale hosts; default hides them.
 */
async function handleHosts(
  args: string[],
  dispatch: (action: TuiAction) => void,
  api: TempoClient,
): Promise<void> {
  const includeStale = args.includes('--all');
  try {
    const list = await api.listHosts({ force: true });
    dispatch({
      type: 'SHOW_COMMAND_OVERLAY',
      title: 'Hosts',
      content: formatHostList(list, { includeStale }),
    });
  } catch (err) {
    commitStatic(dispatch, 'error', `/hosts failed: ${err instanceof Error ? err.message : String(err)}`);
  }
}

/**
 * /recall [player] [--limit N] [--offset N] [--preview N] [--from X]
 *         [--since ISO] [--include-sent]
 *
 * #128: unified per-session recall. Without a player positional, targets
 * the ensemble's maestro session (the TUI's natural context); with a
 * player positional, queries that player's session — same data shape the
 * MCP `recall` tool and `claude-tempo recall <name>` CLI surface.
 *
 * The legacy pre-#128 behavior (aggregated maestro relay-log filtered
 * by player) is retired; that path was inconsistent with the other two
 * surfaces and the design doc on #128 explicitly chose parity.
 */
async function handleRecall(
  args: string[],
  dispatch: (action: TuiAction) => void,
  api: TempoClient,
  ctx: CommandContext,
): Promise<void> {
  const ensemble = requireEnsemble(dispatch, ctx);
  if (!ensemble) return;

  const parsed = parseRecallFlags(args);
  if (parsed.error) {
    commitStatic(dispatch, 'error', parsed.error);
    return;
  }
  // Player defaults to the ensemble's maestro — see docstring.
  const targetPlayer = parsed.player ?? 'maestro';

  try {
    const { received, sent } = await api.recall(ensemble, targetPlayer);
    const timeline = buildTimeline(received, sent, Boolean(parsed.includeSent));
    const rendered = formatRecall(timeline, {
      limit: parsed.limit,
      offset: parsed.offset,
      previewLength: parsed.previewLength,
      since: parsed.since,
      from: parsed.from,
    });
    const title = `Recall \u00B7 ${targetPlayer}`;
    dispatch({ type: 'SHOW_COMMAND_OVERLAY', title, content: rendered.text });
  } catch (err) {
    commitStatic(dispatch, 'error', `Failed to recall messages: ${err instanceof Error ? err.message : String(err)}`);
  }
}

interface ParsedRecallFlags {
  player?: string;
  limit?: number;
  offset?: number;
  previewLength?: number;
  since?: string;
  from?: string;
  includeSent?: boolean;
  error?: string;
}

/**
 * Parse the `/recall` arg vector into structured flags. Exported for unit
 * tests; the TUI handler consumes the structured result directly.
 *
 * Accepted shapes:
 *   `/recall`                                    — maestro session
 *   `/recall alice`                              — alice's session
 *   `/recall --limit 5 --preview 80`             — flags only
 *   `/recall alice --limit 5 --include-sent`     — player + flags
 *
 * Unknown flags or non-numeric values for numeric flags produce a usage
 * error rather than silent drop, so the user isn't surprised by a default.
 */
export function parseRecallFlags(args: string[]): ParsedRecallFlags {
  const out: ParsedRecallFlags = {};
  let i = 0;
  // Leading non-flag positional is the player override.
  if (args.length > 0 && !args[0].startsWith('--')) {
    out.player = args[0];
    i = 1;
  }
  while (i < args.length) {
    const flag = args[i];
    const consumeNumber = (name: string, key: 'limit' | 'offset' | 'previewLength'): string | null => {
      const raw = args[i + 1];
      if (raw === undefined) return `Missing value for ${name}`;
      const n = Number(raw);
      if (!Number.isFinite(n) || !Number.isInteger(n) || n < (key === 'offset' ? 0 : 1)) {
        return `Invalid ${name}: ${raw}`;
      }
      // #270: cap --limit at 100 to match the MCP Zod schema. Recall queries
      // load the full inbox/sent history from the workflow; the cap bounds
      // the worst-case payload across every surface. Error message matches
      // the CLI parser at `src/cli.ts` verbatim so operators see the same
      // suggestion regardless of entry point.
      if (key === 'limit' && n > 100) {
        return `--limit exceeds max (100). Use --offset N to page through more results.`;
      }
      out[key] = n;
      i += 2;
      return null;
    };
    const consumeString = (name: string, key: 'since' | 'from'): string | null => {
      const raw = args[i + 1];
      if (raw === undefined) return `Missing value for ${name}`;
      out[key] = raw;
      i += 2;
      return null;
    };
    let err: string | null = null;
    switch (flag) {
      case '--limit':   err = consumeNumber('--limit', 'limit'); break;
      case '--offset':  err = consumeNumber('--offset', 'offset'); break;
      case '--preview': err = consumeNumber('--preview', 'previewLength'); break;
      case '--since':   err = consumeString('--since', 'since'); break;
      case '--from':    err = consumeString('--from', 'from'); break;
      case '--include-sent': out.includeSent = true; i += 1; break;
      default: err = `Unknown flag: ${flag}`;
    }
    if (err) return { error: err };
  }
  return out;
}

// ── PR-D verbs — thin handlers calling TempoClient methods ──

function requireEnsemble(
  dispatch: (action: TuiAction) => void,
  ctx: CommandContext,
): string | null {
  if (!ctx.activeEnsemble) {
    commitStatic(dispatch, 'error', 'No active ensemble. Use /ensemble <name> first.');
    return null;
  }
  return ctx.activeEnsemble;
}

/** /restart <player> [--fresh] [--force] — revive a player session per §8.2. */
async function handleRestart(
  args: string[],
  dispatch: (action: TuiAction) => void,
  api: TempoClient,
  ctx: CommandContext,
): Promise<void> {
  if (args.length === 0) {
    commitStatic(dispatch, 'error', 'Usage: /restart <player> [--fresh] [--force]');
    return;
  }
  const ensemble = requireEnsemble(dispatch, ctx);
  if (!ensemble) return;

  const target = args[0];
  const fresh = args.includes('--fresh');
  const force = args.includes('--force');

  try {
    const result = await api.restart(ensemble, target, {
      fresh,
      force,
      invokerPlayerId: 'tui',
    });
    commitStatic(
      dispatch,
      'info',
      `\u21BB Restart queued for ${result.playerId}${result.host ? ` on ${result.host}` : ''} (outbox ${result.entryId}).`,
    );
  } catch (err) {
    commitStatic(dispatch, 'error', `Restart failed for ${target}: ${err instanceof Error ? err.message : String(err)}`);
  }
}

/** /migrate <player> <host> [--fresh] [--force] — restart on a different host. */
async function handleMigrate(
  args: string[],
  dispatch: (action: TuiAction) => void,
  api: TempoClient,
  ctx: CommandContext,
): Promise<void> {
  if (args.length < 2) {
    commitStatic(dispatch, 'error', 'Usage: /migrate <player> <host> [--fresh] [--force]');
    return;
  }
  const ensemble = requireEnsemble(dispatch, ctx);
  if (!ensemble) return;

  const target = args[0];
  const host = args[1];
  const fresh = args.includes('--fresh');
  const force = args.includes('--force');

  try {
    const result = await api.migrate(ensemble, target, host, {
      fresh,
      force,
      invokerPlayerId: 'tui',
    });
    commitStatic(
      dispatch,
      'info',
      `\u27A4 Migrate queued for ${result.playerId} \u2192 ${result.host ?? host} (outbox ${result.entryId}).`,
    );
  } catch (err) {
    commitStatic(dispatch, 'error', `Migrate failed for ${target}: ${err instanceof Error ? err.message : String(err)}`);
  }
}

/** /attachment-info <player> — inspect the V2 attachment phase + current holder. */
async function handleAttachmentInfo(
  args: string[],
  dispatch: (action: TuiAction) => void,
  api: TempoClient,
  ctx: CommandContext,
): Promise<void> {
  if (args.length === 0) {
    commitStatic(dispatch, 'error', 'Usage: /attachment-info <player>');
    return;
  }
  const ensemble = requireEnsemble(dispatch, ctx);
  if (!ensemble) return;

  const target = args[0];

  try {
    const info = await api.attachmentInfo(ensemble, target);
    // #264: share the display formatter with the CLI (`src/utils/attachment-format.ts`)
    // so both surfaces render heartbeat age + match each other's field order /
    // edge-case handling. Pre-#264 this block inlined a near-identical render
    // but omitted heartbeat age, creating a latent parity gap.
    const lines = formatAttachmentInfoForDisplay(target, info);
    dispatch({ type: 'SHOW_COMMAND_OVERLAY', title: `Attachment \u00B7 ${target}`, content: lines.join('\n') });
  } catch (err) {
    commitStatic(dispatch, 'error', `attachment_info failed for ${target}: ${err instanceof Error ? err.message : String(err)}`);
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

/**
 * Resolve the ensemble target from args/context, emitting a friendly error
 * when neither is available. Shared by every ensemble-scoped verb below.
 */
function resolveEnsembleArg(
  args: string[],
  ctx: CommandContext,
  dispatch: (action: TuiAction) => void,
  verb: string,
): string | null {
  const target = args[0] ?? ctx.activeEnsemble;
  if (!target) {
    commitStatic(dispatch, 'error', `No active ensemble. Use /ensemble to select one, or /${verb} <ensemble>.`);
    return null;
  }
  return target;
}

/** /pause [ensemble] — pause every session + scheduler + maestro. */
async function handlePause(
  args: string[],
  dispatch: (action: TuiAction) => void,
  api: TempoClient,
  ctx: CommandContext,
): Promise<void> {
  const ensemble = resolveEnsembleArg(args, ctx, dispatch, 'pause');
  if (!ensemble) return;
  try {
    await api.pause(ensemble);
    commitStatic(dispatch, 'info', `\u23F8 Paused ensemble "${ensemble}".`);
  } catch (err) {
    commitStatic(dispatch, 'error', `\u2717 Pause failed: ${err instanceof Error ? err.message : String(err)}`);
  }
}

/** /play [ensemble] — resume a paused ensemble (renamed from /resume). */
async function handlePlay(
  args: string[],
  dispatch: (action: TuiAction) => void,
  api: TempoClient,
  ctx: CommandContext,
): Promise<void> {
  const ensemble = resolveEnsembleArg(args, ctx, dispatch, 'play');
  if (!ensemble) return;
  try {
    await api.play(ensemble);
    commitStatic(dispatch, 'info', `\u25B6 Resumed ensemble "${ensemble}".`);
  } catch (err) {
    commitStatic(dispatch, 'error', `\u2717 Play failed: ${err instanceof Error ? err.message : String(err)}`);
  }
}

/** /shutdown [ensemble] — graceful teardown (detach adapters + pause maestro/scheduler). */
async function handleShutdown(
  args: string[],
  dispatch: (action: TuiAction) => void,
  api: TempoClient,
  ctx: CommandContext,
): Promise<void> {
  const ensemble = resolveEnsembleArg(args, ctx, dispatch, 'shutdown');
  if (!ensemble) return;
  commitStatic(dispatch, 'info', `\u2026 Shutting down "${ensemble}" \u2026`);
  try {
    const summary = await api.shutdown(ensemble);
    for (const d of summary.details) {
      const line = `  ${d.playerId} \u2014 ${d.outcome}${d.error ? `: ${d.error}` : ''}`;
      commitStatic(dispatch, d.outcome === 'failed' ? 'error' : 'info', line);
    }
    commitStatic(
      dispatch,
      summary.failed === 0 ? 'info' : 'error',
      `\u2714 Shutdown "${ensemble}" \u2014 ${summary.detached} detached, ${summary.skipped} skipped, ${summary.failed} failed` +
        `${summary.maestroPaused ? ', maestro paused' : ''}${summary.schedulerPaused ? ', scheduler paused' : ''}.`,
    );
  } catch (err) {
    commitStatic(dispatch, 'error', `\u2717 Shutdown failed: ${err instanceof Error ? err.message : String(err)}`);
  }
}

/** /restore [ensemble] — bring a parked ensemble back (reattach orphans + spawn conductor if absent). */
async function handleRestore(
  args: string[],
  dispatch: (action: TuiAction) => void,
  api: TempoClient,
  ctx: CommandContext,
): Promise<void> {
  const ensemble = resolveEnsembleArg(args, ctx, dispatch, 'restore');
  if (!ensemble) return;
  commitStatic(dispatch, 'info', `\u2026 Restoring "${ensemble}" \u2026`);
  try {
    const summary = await api.restore(ensemble);
    const { formatRestoreOutcome } = await import('../reconcile/orphans');
    for (const d of summary.details) {
      const text = `  ${d.playerId} \u2014 ${formatRestoreOutcome(d.outcome)}`;
      commitStatic(dispatch, d.outcome.kind === 'failed' ? 'error' : 'info', text);
    }
    commitStatic(
      dispatch,
      summary.failed === 0 ? 'info' : 'error',
      `\u2714 Restore "${ensemble}" \u2014 ${summary.reattached} reattached, ${summary.skipped} skipped, ${summary.failed} failed.`,
    );
    // Step 2: ensure a conductor terminal is present (spawn if absent).
    const { ensureConductorSpawned } = await import('../client/ensure-conductor-spawned');
    const conductorOutcome = await ensureConductorSpawned(ensemble, api);
    if (conductorOutcome.spawned) {
      commitStatic(dispatch, 'info', '  Conductor terminal launched.');
    } else if (conductorOutcome.reason === 'spawnFailed') {
      commitStatic(dispatch, 'error', `  Conductor spawn failed: ${conductorOutcome.error}`);
    }
    // `alreadyLive` + `noConductorRecord` are silent — no action needed.
  } catch (err) {
    commitStatic(dispatch, 'error', `\u2717 Restore failed: ${err instanceof Error ? err.message : String(err)}`);
  }
}

/** /home — navigate back to the home view without touching workflow state. */
async function handleHome(
  _args: string[],
  dispatch: (action: TuiAction) => void,
): Promise<void> {
  dispatch({ type: 'NAVIGATE_HOME' });
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
  broadcast: {
    description: 'Send a message to all active players',
    usage: '/broadcast <message>',
    handler: handleBroadcast,
  },
  restart: {
    description: 'Restart a session (reap + claim + context replay + spawn)',
    usage: '/restart <player> [--fresh] [--force]',
    handler: handleRestart,
  },
  destroy: {
    description: 'Terminally destroy a player (y/N) or an ensemble (typed-name)',
    usage: '/destroy <player|ensemble> [reason]',
    handler: handleDestroy,
  },
  migrate: {
    description: 'Restart a session on a different host',
    usage: '/migrate <player> <host> [--fresh] [--force]',
    handler: handleMigrate,
  },
  'attachment-info': {
    description: 'Inspect the V2 attachment state of a session',
    usage: '/attachment-info <player>',
    handler: handleAttachmentInfo,
  },
  hosts: {
    description: 'List daemons polling this Temporal namespace with advertised capabilities (#274)',
    usage: '/hosts [--all]',
    handler: handleHosts,
  },
  recall: {
    description: "Read a player's message history",
    usage: '/recall [player] [--limit N] [--offset N] [--preview N] [--from X] [--since ISO] [--include-sent]',
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
    description: 'Pause every session + scheduler + maestro in the ensemble',
    usage: '/pause [ensemble]',
    handler: handlePause,
  },
  play: {
    description: 'Resume a paused ensemble (renamed from /resume — avoids collision with `claude --resume`)',
    usage: '/play [ensemble]',
    handler: handlePlay,
  },
  shutdown: {
    description: 'Graceful ensemble teardown — detach adapters, pause maestro + scheduler',
    usage: '/shutdown [ensemble]',
    handler: handleShutdown,
  },
  restore: {
    description: 'Restore a parked ensemble — reattach orphans, unpause maestro + scheduler',
    usage: '/restore [ensemble]',
    handler: handleRestore,
  },
  home: {
    description: 'Return to the home view (does not touch workflows)',
    usage: '/home',
    handler: handleHome,
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

/**
 * Filter palette command entries by a typed prefix.
 * Prefix may optionally include a leading '/' — it's stripped before matching.
 * An empty prefix returns all commands in order.
 *
 * Pure function — safe to call from React render paths and unit tests.
 */
export function filterPaletteCommands<T extends { name: string }>(
  commands: readonly T[],
  filter: string,
): T[] {
  const prefix = filter.startsWith('/') ? filter.slice(1) : filter;
  if (!prefix) return [...commands];
  const lower = prefix.toLowerCase();
  return commands.filter((c) => c.name.toLowerCase().startsWith(lower));
}

/**
 * Resolve the target of a `/help <name>` invocation. Accepts either
 * `recruit` or `/recruit` — both resolve to the same command def.
 * Returns null if the command is unknown.
 */
export function resolveHelpTarget(raw: string): { name: string; def: CommandDef } | null {
  const name = raw.replace(/^\//, '').trim().toLowerCase();
  if (!name) return null;
  const def = COMMANDS[name];
  if (!def) return null;
  return { name, def };
}

/** Commands that take a player name as their first parameter. */
export const PLAYER_PARAM_COMMANDS = new Set(['worktree', 'restart', 'destroy', 'attachment-info']);

/** Commands with hardcoded subcommands (shown in autocomplete). */
export const SUBCOMMAND_MAP: Record<string, string[]> = {
  worktree: ['create', 'remove', 'list'],
  stage: ['create', 'list', 'cancel'],
  schedule: ['create', 'delete'],
  lineup: ['load', 'save'],
  ensemble: ['save', 'list', 'show'],
};
