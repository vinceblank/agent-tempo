/**
 * Mission-control render unit tests (3f) — PURE BoardModel → string[].
 */
import { expect } from 'chai';
import { initBoard, applyTempoEvent, applyInnerFrame, selectPlayer } from '../src/pi/mission-control/board';
import { renderBoard } from '../src/pi/mission-control/render';
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
    expect(lines[1]).to.contain('play');
    expect(lines[1]).to.contain('release: true');
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
});
