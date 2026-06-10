/**
 * Mission-control widget renderer (3f) — PURE: BoardModel → string[] (the lines
 * `ctx.ui.setWidget` displays). No Pi/IO. Unit-tested directly.
 */
import type { AttachmentPhase } from '../../http/event-types';
import { sortedPlayerIds, type BoardModel, type PlayerRow } from './board';
import type { InnerFrame } from '../inner-loop-publisher';

/** How many recent fine-tail frames to show under the selected player. */
const TAIL_RENDER_LINES = 12;

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
  lines.push(`MISSION CONTROL · ${model.ensemble} · ${ids.length} player${ids.length === 1 ? '' : 's'}`);

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

  return lines;
}
