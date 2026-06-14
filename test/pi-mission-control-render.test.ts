/**
 * Mission-control render unit tests (3f) — PURE BoardModel → string[].
 */
import { expect } from 'chai';
import { initBoard, applyTempoEvent, applyInnerFrame, selectPlayer, setConnection, pushCommandLog } from '../src/pi/mission-control/board';
import {
  renderBoard,
  MAX_WIDGET_LINES,
  RECONNECT_ARMING_DETAIL,
  STREAM_DOWN_DETAIL,
} from '../src/pi/mission-control/render';
import type { TempoEvent, PlayerSummaryV1 } from '../src/http/event-types';
import type { InnerFrame } from '../src/pi/inner-loop-publisher';

let seq = 0;
const ev = (type: string, payload: unknown): TempoEvent =>
  ({ v: 1, eventId: `0:${++seq}`, type, payload } as unknown as TempoEvent);
const summary = (over: Partial<PlayerSummaryV1>): PlayerSummaryV1 =>
  ({ playerId: 'p', isConductor: false, part: '', ...over } as PlayerSummaryV1);

describe('mission-control renderBoard', () => {
  it('renders a header with the ensemble + player count', () => {
    const m = initBoard('demo');
    applyTempoEvent(m, ev('player.added', summary({ playerId: 'a' })));
    const lines = renderBoard(m);
    expect(lines[0]).to.contain('MISSION CONTROL');
    expect(lines[0]).to.contain('demo');
    expect(lines[0]).to.contain('1 player');
  });

  it('shows an empty-state line when there are no players', () => {
    const lines = renderBoard(initBoard('demo'));
    expect(lines.join('\n')).to.contain('no players');
  });

  it('renders a row with phase glyph, part, currentTool, and context %', () => {
    const m = initBoard('demo');
    applyTempoEvent(m, ev('player.added', summary({ playerId: 'eng', phase: 'processing', part: 'building X' })));
    applyTempoEvent(m, ev('player.activity', { playerId: 'eng', ensemble: 'demo', currentTool: 'bash', contextPercent: 0.5, at: 't' }));
    const row = renderBoard(m).find((l) => l.includes('eng'))!;
    expect(row).to.contain('*');         // processing glyph
    expect(row).to.contain('eng');
    expect(row).to.contain('building X');
    expect(row).to.contain('[bash]');
    expect(row).to.contain('50%');       // 0.5 fraction → 50%
  });

  it('marks the selected player and renders its inner tail', () => {
    const m = initBoard('demo');
    applyTempoEvent(m, ev('player.added', summary({ playerId: 'eng' })));
    selectPlayer(m, 'eng');
    applyInnerFrame(m, { type: 'inner.tool_call', tool: 'read', argsSummary: '{"path":"x"}', ts: 1 } as InnerFrame);
    const out = renderBoard(m);
    const selRow = out.find((l) => l.trimStart().startsWith('>'));
    expect(selRow, 'selected row marker').to.exist;
    expect(out.join('\n')).to.contain('tail: eng');
    expect(out.join('\n')).to.contain('read(');
  });

  it('tags cross-host players with @host when localHost is known (H3a)', () => {
    const m = initBoard('demo');
    applyTempoEvent(m, ev('player.added', summary({ playerId: 'local', hostname: 'box-1' })));
    applyTempoEvent(m, ev('player.added', summary({ playerId: 'remote', hostname: 'box-2' })));
    const lines = renderBoard(m, 'box-1');
    const localRow = lines.find((l) => l.includes('local'))!;
    const remoteRow = lines.find((l) => l.includes('remote'))!;
    expect(remoteRow).to.contain('@box-2'); // cross-host → tagged
    expect(localRow).to.not.contain('@');    // same-host → no tag
  });

  it('omits the @host tag entirely when localHost is not provided', () => {
    const m = initBoard('demo');
    applyTempoEvent(m, ev('player.added', summary({ playerId: 'remote', hostname: 'box-2' })));
    expect(renderBoard(m).join('\n')).to.not.contain('@box-2');
  });

  it('normalizes a 0..100 contextPercent the same as a 0..1 fraction', () => {
    const m = initBoard('demo');
    applyTempoEvent(m, ev('player.added', summary({ playerId: 'a' })));
    applyTempoEvent(m, ev('player.activity', { playerId: 'a', ensemble: 'demo', currentTool: null, contextPercent: 73, at: 't' }));
    expect(renderBoard(m).some((l) => l.includes('73%'))).to.equal(true);
  });

  // #752 — paused/held must be LOUD on the board (the 5h silent-wedge incident).
  it('renders a [PAUSED] header marker + warning line naming the resume verb', () => {
    const m = initBoard('demo');
    applyTempoEvent(m, ev('flags.changed', { ensemble: 'demo', paused: true, held: false, at: 't' }));
    const lines = renderBoard(m);
    expect(lines[0]).to.contain('[PAUSED]');
    expect(lines[1]).to.contain('ENSEMBLE PAUSED');
    expect(lines[1]).to.contain('cues queue');
    // #821/#833 — the hint now names the one-obvious-resume verb `/unpause`
    // (clears both PAUSE + HELD) and keeps `/play release` for the two-axis
    // primitive. `/unpause`, not `/resume` (the latter collides with a Pi built-in).
    expect(lines[1]).to.contain('/unpause');
    expect(lines[1]).to.not.contain('/resume');
    expect(lines[1]).to.contain('/play release');
    expect(lines[1]).to.not.contain('release: true');
  });

  it('renders a [HELD] marker when only held players exist', () => {
    const m = initBoard('demo');
    applyTempoEvent(m, ev('flags.changed', { ensemble: 'demo', paused: false, held: true, at: 't' }));
    const lines = renderBoard(m);
    expect(lines[0]).to.contain('[HELD]');
    expect(lines[1]).to.contain('HELD players');
  });

  it('renders no suspension marker on a healthy board', () => {
    const m = initBoard('demo');
    applyTempoEvent(m, ev('player.added', summary({ playerId: 'a' })));
    const joined = renderBoard(m).join('\n');
    expect(joined).to.not.contain('[PAUSED]');
    expect(joined).to.not.contain('[HELD]');
    expect(joined).to.not.contain('!!');
  });

  // #823 — connection-state banners. The view must converge to reality instead
  // of freezing on the last snapshot after a destroy / stream drop.
  it('renders a loud ENSEMBLE DESTROYED banner and NO stale rows when connection is gone', () => {
    const m = initBoard('demo');
    applyTempoEvent(m, ev('player.added', summary({ playerId: 'eng' })));
    applyTempoEvent(m, ev('player.added', summary({ playerId: 'qa' })));
    setConnection(m, 'gone'); // hard 404 — clears players
    const lines = renderBoard(m);
    const joined = lines.join('\n');
    expect(lines[0]).to.contain('ENSEMBLE GONE');
    expect(joined).to.contain('ENSEMBLE DESTROYED');
    expect(joined).to.contain('/ensemble');
    // The stale roster must NOT be asserted as live (#823 symptom).
    expect(joined).to.not.contain('eng');
    expect(joined).to.not.contain('qa');
  });

  it('renders an honest [STREAM ENDED] banner (NOT "reconnecting") + KEEPS last-known rows', () => {
    const m = initBoard('demo');
    applyTempoEvent(m, ev('player.added', summary({ playerId: 'eng', part: 'building X' })));
    setConnection(m, 'reconnecting');
    const lines = renderBoard(m);
    const joined = lines.join('\n');
    // #827 review: the label must not oversell auto-recovery — the stream ended
    // and reopens on re-bind, it does NOT reconnect on its own.
    expect(lines[0]).to.contain('[STREAM ENDED]');
    expect(joined).to.not.contain('RECONNECTING');
    expect(joined).to.contain('last-known state');
    expect(joined).to.contain('re-bind');
    // Rows are retained (stale, shown under the banner) rather than cleared.
    expect(joined).to.contain('eng');
    expect(joined).to.contain('building X');
  });

  it('surfaces the connection detail (e.g. the 401 auth hint) in the stream-ended banner', () => {
    const m = initBoard('demo');
    setConnection(m, 'reconnecting', 'auth rejected — set AGENT_TEMPO_HTTP_ADMIN_TOKEN');
    const joined = renderBoard(m).join('\n');
    expect(joined).to.contain('STREAM ENDED');
    expect(joined).to.contain('AGENT_TEMPO_HTTP_ADMIN_TOKEN');
  });

  // #828 — auto-re-arm is real now, so the reconnecting state has honest variants
  // selected by connectionDetail (no new BoardConnection enum value).
  it('reconnecting + arming detail → [RECONNECTING] (honest now that re-arm is real)', () => {
    const m = initBoard('demo');
    applyTempoEvent(m, ev('player.added', summary({ playerId: 'eng', part: 'building X' })));
    setConnection(m, 'reconnecting', RECONNECT_ARMING_DETAIL);
    const lines = renderBoard(m);
    const joined = lines.join('\n');
    expect(lines[0]).to.contain('[RECONNECTING]');
    expect(joined).to.contain(RECONNECT_ARMING_DETAIL);
    expect(joined).to.not.contain('[STREAM ENDED]');
    expect(joined).to.not.contain('[STREAM DOWN]');
    // Rows are retained (stale) under the banner during re-arm.
    expect(joined).to.contain('eng');
  });

  it('reconnecting + settled detail → [STREAM DOWN] (re-arm capped, daemon still dead)', () => {
    const m = initBoard('demo');
    setConnection(m, 'reconnecting', STREAM_DOWN_DETAIL);
    const lines = renderBoard(m);
    const joined = lines.join('\n');
    expect(lines[0]).to.contain('[STREAM DOWN]');
    expect(joined).to.contain('retrying every 30s');
    expect(joined).to.not.contain('[RECONNECTING]');
    expect(joined).to.not.contain('[STREAM ENDED]');
  });

  it('shows no connection banner while connecting (normal startup) or live', () => {
    const m = initBoard('demo'); // initial state is 'connecting'
    expect(renderBoard(m).join('\n')).to.not.contain('STREAM ENDED');
    setConnection(m, 'live');
    applyTempoEvent(m, ev('player.added', summary({ playerId: 'a' })));
    const joined = renderBoard(m).join('\n');
    expect(joined).to.not.contain('STREAM ENDED');
    expect(joined).to.not.contain('ENSEMBLE GONE');
  });

  // #821 — the persistent command-log footer.
  it('renders a recent-command footer with the persisted result lines', () => {
    const m = initBoard('demo');
    applyTempoEvent(m, ev('player.added', summary({ playerId: 'a' })));
    pushCommandLog(m, '✓ cue → bob', 'ok');
    pushCommandLog(m, '⚠ cue → cond queued (detached — delivers on re-attach)', 'warn');
    const joined = renderBoard(m).join('\n');
    expect(joined).to.contain('── recent ──');
    expect(joined).to.contain('✓ cue → bob');
    expect(joined).to.contain('⚠ cue → cond queued');
  });

  it('keeps the command-log footer visible on a GONE board (the destroy ack persists)', () => {
    const m = initBoard('demo');
    applyTempoEvent(m, ev('player.added', summary({ playerId: 'a' })));
    pushCommandLog(m, '✓ ensemble-down --destroy', 'ok');
    setConnection(m, 'gone');
    const joined = renderBoard(m).join('\n');
    expect(joined).to.contain('ENSEMBLE DESTROYED');
    expect(joined).to.contain('✓ ensemble-down --destroy'); // ack still on screen
  });

  it('omits the footer entirely when no commands have run', () => {
    const m = initBoard('demo');
    applyTempoEvent(m, ev('player.added', summary({ playerId: 'a' })));
    expect(renderBoard(m).join('\n')).to.not.contain('── recent ──');
  });

  // #836 — Pi caps a widget at MAX_WIDGET_LINES and otherwise appends its own
  // dev-speak "... (widget truncated)" while clipping the BOTTOM (the acks). We
  // clamp ourselves: fit the budget, keep header + command-log footer, and trim
  // only the expendable middle under a friendly hidden-count marker.
  it('clamps an oversized board to MAX_WIDGET_LINES with an operator-friendly marker', () => {
    const m = initBoard('demo');
    // 8 players + a selected tail + a command-log ack → well over 10 lines.
    for (let i = 0; i < 8; i++) applyTempoEvent(m, ev('player.added', summary({ playerId: `p${i}` })));
    selectPlayer(m, 'p0');
    for (let i = 0; i < 12; i++) {
      applyInnerFrame(m, { type: 'inner.tool_call', tool: `t${i}`, argsSummary: '{}', ts: i } as InnerFrame);
    }
    pushCommandLog(m, '✓ cue → p1', 'ok');
    const lines = renderBoard(m);
    expect(lines.length).to.be.at.most(MAX_WIDGET_LINES);
    const joined = lines.join('\n');
    // Operator-friendly marker, NOT Pi's dev-speak.
    expect(joined).to.contain('⋯');
    expect(joined).to.contain('hidden');
    expect(joined).to.not.contain('widget truncated');
    // Header (top) survives.
    expect(lines[0]).to.contain('MISSION CONTROL');
    // Command-log ack (bottom) survives the clamp — Pi's top-N slice would drop it.
    expect(joined).to.contain('✓ cue → p1');
  });

  it('does not clamp or add a marker when the board fits the budget', () => {
    const m = initBoard('demo');
    applyTempoEvent(m, ev('player.added', summary({ playerId: 'a' })));
    const joined = renderBoard(m).join('\n');
    expect(joined).to.not.contain('⋯');
    expect(joined).to.not.contain('hidden');
  });
});
