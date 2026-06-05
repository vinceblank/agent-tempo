/**
 * Mission-control Controller.cmdTail unit tests (3f / H3a) — the cross-host
 * tail refusal. Constructs the Controller directly with a fake actions + ctx;
 * no Pi, no daemon, no SSE. Importing extension.ts is side-effect-free (the
 * default export just builds a closure; getConfig/port-file run only inside it).
 */
import { expect } from 'chai';
import { Controller } from '../src/pi/mission-control/extension';
import { applyTempoEvent } from '../src/pi/mission-control/board';
import type { TempoEvent, PlayerSummaryV1 } from '../src/http/event-types';
import type { MissionControlActions } from '../src/pi/mission-control/actions';
import type { McExtensionContext } from '../src/pi/mission-control/pi-ui';

let seq = 0;
function addPlayer(ctrl: Controller, over: Partial<PlayerSummaryV1>): void {
  const payload = { playerId: 'p', isConductor: false, part: '', ...over } as PlayerSummaryV1;
  applyTempoEvent(
    ctrl.model,
    { v: 1, eventId: `0:${++seq}`, type: 'player.added', payload } as unknown as TempoEvent,
  );
}

function fakeCtx(sink: string[]): McExtensionContext {
  return {
    hasUI: true,
    ui: {
      notify: (m: string) => sink.push(m),
      setWidget: () => {},
      select: async () => undefined,
      confirm: async () => false,
      input: async () => undefined,
    },
  };
}

// cmdTail never touches actions — a bare stub is enough.
const noActions = {} as unknown as MissionControlActions;

describe('mission-control Controller.cmdTail — tailability gating (H3a)', () => {
  it('refuses a cross-host tail: no tail opened, not selected, clear actionable message', async () => {
    const ctrl = new Controller('ens', noActions, 'box-1');
    addPlayer(ctrl, { playerId: 'remote', hostname: 'box-2' });
    const calls: (string | null)[] = [];
    ctrl.onTailRequest = (p) => calls.push(p);
    const msgs: string[] = [];

    await ctrl.cmdTail('remote', fakeCtx(msgs));

    expect(calls).to.have.length(0); // openTail never invoked
    expect(ctrl.model.selected).to.equal(null); // never selected
    expect(msgs).to.have.length(1);
    expect(msgs[0]).to.match(/^Inner tail unavailable:/);
    expect(msgs[0]).to.include('box-2'); // the player's host
    expect(msgs[0]).to.include('box-1'); // this daemon's host
    expect(msgs[0]).to.include('#645 / H3b'); // tracked follow-up
  });

  it('tails a same-host player: opens the tail, selects, confirms', async () => {
    const ctrl = new Controller('ens', noActions, 'box-1');
    addPlayer(ctrl, { playerId: 'local', hostname: 'box-1' });
    const calls: (string | null)[] = [];
    ctrl.onTailRequest = (p) => calls.push(p);
    const msgs: string[] = [];

    await ctrl.cmdTail('local', fakeCtx(msgs));

    expect(calls).to.deep.equal(['local']);
    expect(ctrl.model.selected).to.equal('local');
    expect(msgs).to.deep.equal(['Tailing local.']);
  });

  it('does not block a player with an undefined hostname (older snapshot)', async () => {
    const ctrl = new Controller('ens', noActions, 'box-1');
    addPlayer(ctrl, { playerId: 'legacy' }); // no hostname
    const calls: (string | null)[] = [];
    ctrl.onTailRequest = (p) => calls.push(p);
    const msgs: string[] = [];

    await ctrl.cmdTail('legacy', fakeCtx(msgs));

    expect(calls).to.deep.equal(['legacy']);
    expect(ctrl.model.selected).to.equal('legacy');
  });

  it('reports no-such-player for an unknown id (no tail opened)', async () => {
    const ctrl = new Controller('ens', noActions, 'box-1');
    const calls: (string | null)[] = [];
    ctrl.onTailRequest = (p) => calls.push(p);
    const msgs: string[] = [];

    await ctrl.cmdTail('ghost', fakeCtx(msgs));

    expect(calls).to.have.length(0);
    expect(ctrl.model.selected).to.equal(null);
    expect(msgs).to.deep.equal(['No such player: ghost']);
  });

  it('/tail off clears the selection regardless of host', async () => {
    const ctrl = new Controller('ens', noActions, 'box-1');
    addPlayer(ctrl, { playerId: 'local', hostname: 'box-1' });
    const calls: (string | null)[] = [];
    ctrl.onTailRequest = (p) => calls.push(p);
    await ctrl.cmdTail('local', fakeCtx([]));
    expect(ctrl.model.selected).to.equal('local');

    const msgs: string[] = [];
    await ctrl.cmdTail('off', fakeCtx(msgs));

    expect(ctrl.model.selected).to.equal(null);
    expect(calls).to.deep.equal(['local', null]);
    expect(msgs).to.deep.equal(['Inner-loop tail off.']);
  });
});
