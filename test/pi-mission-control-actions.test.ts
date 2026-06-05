/**
 * Mission-control action-client + command-handler unit tests (3f).
 * Injected fetch (no daemon) + a fake Pi ctx (records notify).
 */
import { expect } from 'chai';
import { MissionControlActions, type ActionFetch } from '../src/pi/mission-control/actions';
import { Controller } from '../src/pi/mission-control/extension';
import { applyTempoEvent } from '../src/pi/mission-control/board';
import type { TempoEvent, PlayerSummaryV1 } from '../src/http/event-types';
import type { McExtensionContext } from '../src/pi/mission-control/pi-ui';

interface Recorded { url: string; method: string; headers: Record<string, string>; body?: string }

class FakeFetch {
  public readonly calls: Recorded[] = [];
  public nextStatus = 202;
  public nextText = '';
  readonly fn: ActionFetch = (url, init) => {
    this.calls.push({ url, method: init.method, headers: init.headers, body: init.body });
    return Promise.resolve({ status: this.nextStatus, text: async () => this.nextText });
  };
}

const actions = (fake: FakeFetch, over = {}) =>
  new MissionControlActions({ ensemble: 'ens', adminToken: 'tok', baseUrl: 'http://127.0.0.1:8473', fetchFn: fake.fn, ...over });

describe('MissionControlActions — write surface', () => {
  it('cue POSTs /v1/ensembles/:e/cue with {to,message} + bearer', async () => {
    const fake = new FakeFetch();
    const r = await actions(fake).cue('bob', 'hello');
    expect(r.ok).to.equal(true);
    const c = fake.calls[0];
    expect(c.method).to.equal('POST');
    expect(c.url).to.equal('http://127.0.0.1:8473/v1/ensembles/ens/cue');
    expect(c.headers.Authorization).to.equal('Bearer tok');
    expect(JSON.parse(c.body!)).to.deep.equal({ to: 'bob', message: 'hello' });
  });

  it('pause / play(release) hit the right endpoints', async () => {
    const fake = new FakeFetch();
    const a = actions(fake);
    await a.pause();
    await a.play(true);
    expect(fake.calls[0].url).to.equal('http://127.0.0.1:8473/v1/ensembles/ens/pause');
    expect(fake.calls[1].url).to.equal('http://127.0.0.1:8473/v1/ensembles/ens/play');
    expect(JSON.parse(fake.calls[1].body!)).to.deep.equal({ release: true });
  });

  it('restart / destroy carry playerId + optional reason', async () => {
    const fake = new FakeFetch();
    const a = actions(fake);
    await a.restart('eng', 'stuck');
    await a.destroy('eng');
    expect(JSON.parse(fake.calls[0].body!)).to.deep.equal({ playerId: 'eng', reason: 'stuck' });
    expect(JSON.parse(fake.calls[1].body!)).to.deep.equal({ playerId: 'eng' });
  });

  it('reset POSTs /reset with playerId + optional reason (H5b D14 clean-wipe)', async () => {
    const fake = new FakeFetch();
    const a = actions(fake);
    await a.reset('eng', 'off-track');
    await a.reset('eng');
    expect(fake.calls[0].url).to.equal('http://127.0.0.1:8473/v1/ensembles/ens/reset');
    expect(fake.calls[0].headers.Authorization).to.equal('Bearer tok');
    expect(JSON.parse(fake.calls[0].body!)).to.deep.equal({ playerId: 'eng', reason: 'off-track' });
    expect(JSON.parse(fake.calls[1].body!)).to.deep.equal({ playerId: 'eng' });
  });

  it('reset surfaces a non-2xx as an error (no throw)', async () => {
    const fake = new FakeFetch();
    fake.nextStatus = 404;
    const a = actions(fake);
    const r = await a.reset('ghost');
    expect(r.ok).to.equal(false);
  });

  it('gate arm/disarm/decide hit the player gate plane', async () => {
    const fake = new FakeFetch();
    fake.nextStatus = 204;
    const a = actions(fake);
    await a.gateArm('eng');
    await a.gateDecide('eng', 'req-1', 'allow');
    expect(fake.calls[0].url).to.equal('http://127.0.0.1:8473/v1/players/ens/eng/gate-arm');
    expect(fake.calls[1].url).to.equal('http://127.0.0.1:8473/v1/players/ens/eng/gate/req-1');
    expect(JSON.parse(fake.calls[1].body!)).to.deep.equal({ decision: 'allow' });
  });

  it('returns an error (no throw) on a non-2xx response', async () => {
    const fake = new FakeFetch();
    fake.nextStatus = 403; fake.nextText = 'forbidden';
    const r = await actions(fake).cue('bob', 'hi');
    expect(r.ok).to.equal(false);
    if (!r.ok) expect(r.error).to.contain('403');
  });

  it('is unusable (clear error) when no admin token is set', async () => {
    const fake = new FakeFetch();
    const a = new MissionControlActions({ ensemble: 'ens', adminToken: undefined, baseUrl: 'http://x', fetchFn: fake.fn });
    expect(a.ready).to.equal(false);
    const r = await a.cue('b', 'm');
    expect(r.ok).to.equal(false);
    expect(fake.calls).to.have.length(0);
  });
});

// ── Controller command handlers (fake actions via the real client + fake ctx) ──

function fakeCtx(): McExtensionContext & { notes: string[] } {
  const notes: string[] = [];
  return {
    notes,
    hasUI: true,
    ui: {
      setWidget: () => {},
      notify: (m: string) => { notes.push(m); },
      select: async () => undefined,
      confirm: async () => false,
      input: async () => undefined,
    },
  };
}

const summary = (over: Partial<PlayerSummaryV1>): PlayerSummaryV1 =>
  ({ playerId: 'p', isConductor: false, part: '', ...over } as PlayerSummaryV1);
const addPlayer = (c: Controller, id: string) =>
  applyTempoEvent(c.model, { v: 1, eventId: '0:1', type: 'player.added', payload: summary({ playerId: id }) } as unknown as TempoEvent);

describe('mission-control Controller — commands', () => {
  it('cmdCue parses <player> <message> and POSTs the cue', async () => {
    const fake = new FakeFetch();
    const c = new Controller('ens', actions(fake));
    const ctx = fakeCtx();
    await c.cmdCue('bob hello there', ctx);
    expect(JSON.parse(fake.calls[0].body!)).to.deep.equal({ to: 'bob', message: 'hello there' });
    expect(ctx.notes[0]).to.contain('✓');
  });

  it('cmdCue rejects missing args with a usage notice (no POST)', async () => {
    const fake = new FakeFetch();
    const c = new Controller('ens', actions(fake));
    const ctx = fakeCtx();
    await c.cmdCue('bob', ctx); // no message
    expect(fake.calls).to.have.length(0);
    expect(ctx.notes[0]).to.contain('Usage');
  });

  it('cmdTail selects a known player + fires onTailRequest', async () => {
    const fake = new FakeFetch();
    const c = new Controller('ens', actions(fake));
    addPlayer(c, 'eng');
    let tailed: string | null | undefined;
    c.onTailRequest = (p) => { tailed = p; };
    const ctx = fakeCtx();
    await c.cmdTail('eng', ctx);
    expect(c.model.selected).to.equal('eng');
    expect(tailed).to.equal('eng');
    await c.cmdTail('off', ctx);
    expect(c.model.selected).to.equal(null);
    expect(tailed).to.equal(null);
  });

  it('cmdGate requires a selected player + a valid decision', async () => {
    const fake = new FakeFetch();
    const c = new Controller('ens', actions(fake));
    addPlayer(c, 'eng');
    const ctx = fakeCtx();
    await c.cmdGate('req-1 allow', ctx); // no selection yet
    expect(ctx.notes.pop()).to.contain('Select a player');
    c.onTailRequest = () => {};
    await c.cmdTail('eng', ctx);
    await c.cmdGate('req-1 maybe', ctx); // bad decision
    expect(ctx.notes.pop()).to.contain('Usage');
    await c.cmdGate('req-1 deny', ctx); // valid
    expect(fake.calls.some((x) => x.url.endsWith('/gate/req-1'))).to.equal(true);
  });

  it('cmdReset POSTs the reset route + reports success (H5b — mirrors restart)', async () => {
    const fake = new FakeFetch();
    const c = new Controller('ens', actions(fake));
    const ctx = fakeCtx();
    await c.cmdReset('eng wedged', ctx);
    expect(fake.calls).to.have.length(1);
    expect(fake.calls[0].url).to.equal('http://127.0.0.1:8473/v1/ensembles/ens/reset');
    expect(JSON.parse(fake.calls[0].body!)).to.deep.equal({ playerId: 'eng', reason: 'wedged' });
    expect(ctx.notes[0]).to.contain('✓');
  });

  it('cmdReset with no player shows usage (no POST)', async () => {
    const fake = new FakeFetch();
    const c = new Controller('ens', actions(fake));
    const ctx = fakeCtx();
    await c.cmdReset('', ctx);
    expect(fake.calls).to.have.length(0);
    expect(ctx.notes[0]).to.contain('Usage');
  });
});
