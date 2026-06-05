/**
 * Mission-control board model + SSE-parse unit tests (3f) — PURE, no Pi/daemon.
 */
import { expect } from 'chai';
import {
  initBoard,
  applyTempoEvent,
  applyInnerFrame,
  selectPlayer,
  sortedPlayerIds,
  tailability,
} from '../src/pi/mission-control/board';
import { parseInnerSse } from '../src/pi/mission-control/inner-tail';
import type { TempoEvent, PlayerSummaryV1 } from '../src/http/event-types';
import type { InnerFrame } from '../src/pi/inner-loop-publisher';

let seq = 0;
const ev = (type: string, payload: unknown): TempoEvent =>
  ({ v: 1, eventId: `0:${++seq}`, type, payload } as unknown as TempoEvent);

const summary = (over: Partial<PlayerSummaryV1>): PlayerSummaryV1 =>
  ({ playerId: 'p', isConductor: false, part: '', ...over } as PlayerSummaryV1);

const frame = (over: Partial<Extract<InnerFrame, { type: 'inner.turn' }>> = {}): InnerFrame =>
  ({ type: 'inner.turn', phase: 'start', turnIndex: 0, ts: 1, ...over } as InnerFrame);

describe('mission-control board — applyTempoEvent', () => {
  it('snapshot rebuilds the player set authoritatively', () => {
    const m = initBoard('ens');
    applyTempoEvent(m, ev('snapshot', { players: [summary({ playerId: 'a' }), summary({ playerId: 'b' })] }));
    expect([...m.players.keys()].sort()).to.deep.equal(['a', 'b']);
    // A second snapshot replaces (drops 'b', adds 'c').
    applyTempoEvent(m, ev('snapshot', { players: [summary({ playerId: 'a' }), summary({ playerId: 'c' })] }));
    expect([...m.players.keys()].sort()).to.deep.equal(['a', 'c']);
  });

  it('player.added / player.removed add + drop rows', () => {
    const m = initBoard('ens');
    applyTempoEvent(m, ev('player.added', summary({ playerId: 'a', part: 'building' })));
    expect(m.players.get('a')?.part).to.equal('building');
    applyTempoEvent(m, ev('player.removed', { playerId: 'a', ensemble: 'ens', removedAt: 't', reason: 'gone' }));
    expect(m.players.has('a')).to.equal(false);
  });

  it('player.phase_changed updates the row phase', () => {
    const m = initBoard('ens');
    applyTempoEvent(m, ev('player.added', summary({ playerId: 'a', phase: 'attached' })));
    applyTempoEvent(m, ev('player.phase_changed', { playerId: 'a', ensemble: 'ens', phase: 'processing', at: 't' }));
    expect(m.players.get('a')?.phase).to.equal('processing');
  });

  it('player.activity updates currentTool + contextPercent (3c coarse)', () => {
    const m = initBoard('ens');
    applyTempoEvent(m, ev('player.added', summary({ playerId: 'a' })));
    applyTempoEvent(m, ev('player.activity', { playerId: 'a', ensemble: 'ens', currentTool: 'bash', contextPercent: 0.42, at: 't' }));
    const row = m.players.get('a')!;
    expect(row.currentTool).to.equal('bash');
    expect(row.contextPercent).to.equal(0.42);
  });

  it('ignores non-board events without bumping revision', () => {
    const m = initBoard('ens');
    const r0 = m.revision;
    applyTempoEvent(m, ev('heartbeat', { at: 't' }));
    expect(m.revision).to.equal(r0);
  });

  it('removing the selected player clears the selection + tail', () => {
    const m = initBoard('ens');
    applyTempoEvent(m, ev('player.added', summary({ playerId: 'a' })));
    selectPlayer(m, 'a');
    applyInnerFrame(m, frame());
    applyTempoEvent(m, ev('player.removed', { playerId: 'a', ensemble: 'ens', removedAt: 't', reason: 'gone' }));
    expect(m.selected).to.equal(null);
    expect(m.innerTail).to.have.length(0);
  });
});

describe('mission-control board — selectPlayer + tail', () => {
  it('select fails on an unknown player, succeeds + clears tail on a known one', () => {
    const m = initBoard('ens');
    applyTempoEvent(m, ev('player.added', summary({ playerId: 'a' })));
    expect(selectPlayer(m, 'ghost')).to.equal(false);
    expect(m.selected).to.equal(null);
    applyInnerFrame(m, frame());
    expect(selectPlayer(m, 'a')).to.equal(true);
    expect(m.selected).to.equal('a');
    expect(m.innerTail).to.have.length(0); // cleared on select
  });

  it('applyInnerFrame bounds the tail to tailLimit (drop-oldest)', () => {
    const m = initBoard('ens', 3);
    for (let i = 0; i < 5; i++) applyInnerFrame(m, frame({ turnIndex: i }));
    expect(m.innerTail).to.have.length(3);
    expect((m.innerTail[0] as Extract<InnerFrame, { type: 'inner.turn' }>).turnIndex).to.equal(2); // oldest 0,1 dropped
  });

  it('sortedPlayerIds puts the conductor first, then alphabetical', () => {
    const m = initBoard('ens');
    applyTempoEvent(m, ev('player.added', summary({ playerId: 'zeta' })));
    applyTempoEvent(m, ev('player.added', summary({ playerId: 'alpha' })));
    applyTempoEvent(m, ev('player.added', summary({ playerId: 'cond', isConductor: true })));
    expect(sortedPlayerIds(m)).to.deep.equal(['cond', 'alpha', 'zeta']);
  });
});

describe('mission-control board — hostname projection (H3a)', () => {
  it('rowFromSummary carries PlayerSummaryV1.hostname (snapshot + player.added)', () => {
    const m = initBoard('ens');
    applyTempoEvent(m, ev('snapshot', { players: [summary({ playerId: 'a', hostname: 'box-1' })] }));
    expect(m.players.get('a')?.hostname).to.equal('box-1');
    applyTempoEvent(m, ev('player.added', summary({ playerId: 'b', hostname: 'box-2' })));
    expect(m.players.get('b')?.hostname).to.equal('box-2');
  });

  it('leaves hostname undefined when the summary omits it (older snapshot)', () => {
    const m = initBoard('ens');
    applyTempoEvent(m, ev('player.added', summary({ playerId: 'a' })));
    expect(m.players.get('a')?.hostname).to.equal(undefined);
  });
});

describe('mission-control board — tailability (H3a)', () => {
  const withPlayer = (over: Partial<PlayerSummaryV1>) => {
    const m = initBoard('ens');
    applyTempoEvent(m, ev('player.added', summary(over)));
    return m;
  };

  it('no-such-player when the id is absent', () => {
    const m = initBoard('ens');
    expect(tailability(m, 'ghost', 'box-1')).to.deep.equal({ ok: false, reason: 'no-such-player' });
  });

  it('ok when the player is on the local host', () => {
    const m = withPlayer({ playerId: 'a', hostname: 'box-1' });
    expect(tailability(m, 'a', 'box-1')).to.deep.equal({ ok: true });
  });

  it('cross-host (carrying playerHost) when the player runs elsewhere', () => {
    const m = withPlayer({ playerId: 'a', hostname: 'box-2' });
    expect(tailability(m, 'a', 'box-1')).to.deep.equal({ ok: false, reason: 'cross-host', playerHost: 'box-2' });
  });

  it('treats an undefined hostname as tailable — never block on absent data', () => {
    const m = withPlayer({ playerId: 'a' }); // no hostname (older snapshot)
    expect(tailability(m, 'a', 'box-1')).to.deep.equal({ ok: true });
  });

  it('flags the maestro/dashboard UI player as ui-player (not cross-host)', () => {
    // The TUI's own maestro session stamps hostname:'dashboard' (client/core.ts).
    const m = withPlayer({ playerId: 'maestro', hostname: 'dashboard' });
    expect(tailability(m, 'maestro', 'box-1')).to.deep.equal({ ok: false, reason: 'ui-player' });
  });
});

describe('mission-control — parseInnerSse', () => {
  it('decodes inner.* frames from data: lines and returns the trailing carry', () => {
    const chunk =
      'data: {"type":"inner.turn","phase":"start","turnIndex":1,"ts":1}\n\n' +
      ': keepalive\n\n' +
      'data: {"type":"inner.tool_call","tool":"bash","argsSummary":"ls","ts":2}\n\n' +
      'data: {"type":"inner.thi'; // partial — should become carry
    const { frames, carry } = parseInnerSse(chunk);
    expect(frames.map((f) => f.type)).to.deep.equal(['inner.turn', 'inner.tool_call']);
    expect(carry).to.equal('data: {"type":"inner.thi');
  });

  it('reassembles a frame split across two chunks via the carry', () => {
    const a = parseInnerSse('data: {"type":"inner.token","contextTokens":5');
    expect(a.frames).to.have.length(0);
    const b = parseInnerSse('0,"contextPercent":0.1}\n\n', a.carry);
    expect(b.frames).to.have.length(1);
    expect(b.frames[0]).to.deep.equal({ type: 'inner.token', contextTokens: 50, contextPercent: 0.1 });
  });

  it('ignores malformed / non-inner data', () => {
    const { frames } = parseInnerSse('data: not json\n\ndata: {"type":"other"}\n\n');
    expect(frames).to.have.length(0);
  });
});
