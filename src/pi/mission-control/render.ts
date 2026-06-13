/**
 * Mission-control widget renderer (3f) — PURE: BoardModel → string[] (the lines
 * `ctx.ui.setWidget` displays). No Pi/IO. Unit-tested directly.
 */
import type { AttachmentPhase } from '../../http/event-types';
import { sortedPlayerIds, type BoardModel, type PlayerRow } from './board';
import type { InnerFrame } from '../inner-loop-publisher';

/** How many recent fine-tail frames to show under the selected player. */
const TAIL_RENDER_LINES = 12;

/**
 * #821 — render the persistent command-log footer (recent acks/⚠/failures). Folds
 * write-command results into the widget so feedback doesn't vanish like the old
 * ephemeral toast. Each entry's `text` already carries its outcome glyph
 * (`✓`/`⚠`/`✗`, set at report-time). Empty log → no footer lines.
 */
function renderCommandLog(model: BoardModel): string[] {
  if (model.commandLog.length === 0) return [];
  const out = ['── recent ──'];
  for (const e of model.commandLog) out.push(`  ${e.text}`);
  return out;
}

/** Compact phase glyph — ASCII-safe for the TUI. */
function phaseGlyph(phase: AttachmentPhase | undefined): string {
  switch (phase) {
    case 'processing': return '*'; // working
    case 'awaiting': return 'o';   // idle, attached
    case 'attached': return '+';
    case 'booting': return '.';
    case 'draining': return '~';
    case 'detached': return 'x';
    case 'gone': return '#';
    default: return '?';
  }
}

function pct(contextPercent: number | undefined): string {
  if (contextPercent === undefined) return '';
  // contextPercent may be a 0..1 fraction or a 0..100 number — normalize to %.
  const p = contextPercent <= 1 ? contextPercent * 100 : contextPercent;
  return `${Math.round(p)}%`;
}

function renderRow(row: PlayerRow, selected: boolean, localHost?: string): string {
  const sel = selected ? '>' : ' ';
  const glyph = phaseGlyph(row.phase);
  const tool = row.currentTool ? `[${row.currentTool}]` : '';
  const ctx = pct(row.contextPercent);
  const part = row.part ? ` ${row.part}` : '';
  // H3a: flag cross-host players (`@host`) so the operator sees at a glance which
  // are non-tailable (the /inner tail is daemon-local). Only when localHost is known.
  const host = localHost && row.hostname && row.hostname !== localHost ? `@${row.hostname}` : '';
  // sel glyph id  part  tool  ctx  @host
  return [`${sel}${glyph} ${row.playerId}`, part, tool, ctx, host]
    .filter((s) => s !== '')
    .join('  ')
    .trimEnd();
}

/** One-line summary of a fine inner-loop frame for the tail. */
function renderInnerFrame(f: InnerFrame): string {
  switch (f.type) {
    case 'inner.thinking':
      return `  ${f.kind === 'thinking' ? '~' : '"'} ${oneLine(f.delta, 80)}`;
    case 'inner.tool_call':
      return `  -> ${f.tool}(${oneLine(f.argsSummary, 60)})`;
    case 'inner.tool_result':
      return `  <- ${f.tool}${f.isError ? ' ERR' : ''}: ${oneLine(f.resultSummary, 60)}`;
    case 'inner.token':
      return `  · ctx ${f.contextTokens ?? '?'} tok${f.contextPercent !== undefined ? ` (${pct(f.contextPercent)})` : ''}`;
    case 'inner.turn':
      return `  -- turn ${f.phase} #${f.turnIndex}`;
    default:
      return '  ·';
  }
}

/** Collapse whitespace + truncate for a single tail line. */
function oneLine(s: string, max: number): string {
  const flat = s.replace(/\s+/g, ' ').trim();
  return flat.length <= max ? flat : flat.slice(0, max - 1) + '…';
}

/**
 * Render the full board. Header + player rows (conductor first), then — when a
 * player is selected — a fine inner-loop tail (last {@link TAIL_RENDER_LINES}).
 */
export function renderBoard(model: BoardModel, localHost?: string): string[] {
  const ids = sortedPlayerIds(model);
  const lines: string[] = [];

  // #823 — a GONE ensemble (hard 404 — the maestro is torn down) is the most
  // urgent signal and makes the player list + suspension flags meaningless:
  // render the loud teardown banner and stop, so a destructive
  // `/ensemble-down --destroy` (or an external destroy) can't leave the operator
  // staring at the stale pre-destroy roster (the reported symptom). Players are
  // already cleared by `setConnection('gone')`.
  if (model.connection === 'gone') {
    lines.push(`MISSION CONTROL · ${model.ensemble} · ENSEMBLE GONE`);
    lines.push(
      '!! ENSEMBLE DESTROYED — no active players. ' +
      '/ensemble <name> to observe another, or /ensemble-up to re-create.',
    );
    // #821 — keep the command log visible so the `ensemble-down --destroy ✓`
    // ack that produced this state is still on screen (the #823 scenario).
    lines.push(...renderCommandLog(model));
    return lines;
  }

  // #752/#823 — the header marker rides one loud line so a paused/held/
  // stream-ended ensemble can't sit unnoticed (the 5h silent-wedge incident).
  // A dropped stream outranks PAUSED/HELD: the suspension flags below are then
  // last-known-only and the operator needs to know the view itself may be stale.
  //
  // HONEST LABEL (#827 review): the `'reconnecting'` connection state does NOT
  // auto-reconnect today — `createSubscribe` swallows genuine transient blips
  // internally (the board stays `live` through them), so this state is only
  // reached when the coarse stream has actually ended and the loop has exited.
  // It reopens on an `/ensemble` re-bind, not on its own. We therefore label it
  // "STREAM ENDED … reopens on re-bind" rather than the misleading "RECONNECTING"
  // (shipping a reconnecting badge that doesn't reconnect is the exact
  // misleading-feedback class this PR fixes). Auto-re-arm is tracked in #828;
  // if/when the loop re-subscribes with backoff, restore the reconnecting wording.
  let marker = '';
  let what = '';
  if (model.connection === 'reconnecting') {
    marker = ' · [STREAM ENDED]';
    const tail = 'last-known state, reopens on /ensemble re-bind';
    what = model.connectionDetail
      ? `STREAM ENDED — ${model.connectionDetail}; ${tail}`
      : `STREAM ENDED — coarse stream dropped; ${tail}`;
  } else if (model.paused) {
    marker = ' · [PAUSED]';
    what = model.held ? 'ENSEMBLE PAUSED + HELD players' : 'ENSEMBLE PAUSED';
  } else if (model.held) {
    marker = ' · [HELD]';
    what = 'HELD players';
  }
  lines.push(`MISSION CONTROL · ${model.ensemble} · ${ids.length} player${ids.length === 1 ? '' : 's'}${marker}`);
  if (what) {
    if (model.connection === 'reconnecting') {
      // Informational — no resume hint (the issue is the stream, not a suspend).
      lines.push(`!! ${what}`);
    } else {
      // #821 — the one obvious resume is `/resume` (clears PAUSE + HELD); `/play`
      // (sources only) and `/play release` remain for the two-axis primitive.
      lines.push(`!! ${what} — cues queue silently; resume: /resume (or /play release)`);
    }
  }

  if (ids.length === 0) {
    lines.push('  (no players — waiting for the ensemble…)');
  } else {
    for (const id of ids) {
      const row = model.players.get(id)!;
      lines.push(renderRow(row, id === model.selected, localHost));
    }
  }

  if (model.selected) {
    lines.push(`── tail: ${model.selected} ──`);
    const recent = model.innerTail.slice(-TAIL_RENDER_LINES);
    if (recent.length === 0) {
      lines.push('  (no inner-loop activity yet)');
    } else {
      for (const f of recent) lines.push(renderInnerFrame(f));
    }
  }

  // #821 — persistent command-result footer (recent acks/⚠/failures).
  lines.push(...renderCommandLog(model));

  return lines;
}
