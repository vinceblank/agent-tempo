/**
 * Mission-control board observability tests (#821 / #822 / #823) — the uniform
 * write-command feedback + view-reconciliation pattern.
 *
 * Pure unit level (the H3a pattern): real Controller + injected fetch + fake ctx;
 * no Pi, no daemon. Covers the three guarantees every board write command makes:
 * (1) visible result line, (2) warn-on-undeliverable/no-op, (3) view converges.
 */
import { expect } from 'chai';
import { MissionControlActions, parseDeliveryHint, type ActionFetch } from '../src/pi/mission-control/actions';
import {
  Controller,
  parseReleaseArg,
  formatOutcome,
  classifyCoarseStreamEnd,
} from '../src/pi/mission-control/extension';
import { applyTempoEvent } from '../src/pi/mission-control/board';
import { SubscribeHttpError } from '../src/client/subscribe';
import type { TempoEvent, PlayerSummaryV1 } from '../src/http/event-types';
import type { McExtensionContext } from '../src/pi/mission-control/pi-ui';

// ── Harness (mirrors pi-mission-control-actions.test.ts) ──

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

const actions = (fake: FakeFetch) =>
  new MissionControlActions({ ensemble: 'ens', adminToken: 'tok', baseUrl: 'http://127.0.0.1:8473', fetchFn: fake.fn });

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

let seq = 0;
const summary = (over: Partial<PlayerSummaryV1>): PlayerSummaryV1 =>
  ({ playerId: 'p', isConductor: false, part: '', ...over } as PlayerSummaryV1);
const addPlayer = (c: Controller, id: string) =>
  applyTempoEvent(c.model, { v: 1, eventId: `0:${++seq}`, type: 'player.added', payload: summary({ playerId: id }) } as unknown as TempoEvent);

// ── #821/#833 — /play release parsing + /unpause + residual-HELD note ──

describe('#821 parseReleaseArg', () => {
  it('treats the bare word `release` and the key:val forms as true', () => {
    for (const a of ['release', 'release:true', 'release: true', 'release=true', '  release  ']) {
      expect(parseReleaseArg(a), a).to.equal(true);
    }
  });
  it('treats empty / false / garbage as sources-only (false)', () => {
    for (const a of ['', 'release:false', 'release=false', 'nonsense', 'hold']) {
      expect(parseReleaseArg(a), a).to.equal(false);
    }
  });
});

describe('#821/#822 formatOutcome', () => {
  it('success → ✓ + ok level', () => {
    expect(formatOutcome('cue → bob', { ok: true, status: 202 })).to.deep.equal({ text: '✓ cue → bob', level: 'ok' });
  });
  it('queued (#822) → ⚠ + warn level, names the phase + re-attach', () => {
    const o = formatOutcome('cue → bob', { ok: true, status: 202, delivery: 'queued', phase: 'detached' });
    expect(o.level).to.equal('warn');
    expect(o.text).to.contain('⚠');
    expect(o.text).to.contain('detached');
    expect(o.text).to.contain('re-attach');
  });
  it('failure → ✗ + fail level', () => {
    const o = formatOutcome('play', { ok: false, error: 'boom' });
    expect(o.level).to.equal('fail');
    expect(o.text).to.contain('✗');
    expect(o.text).to.contain('boom');
  });
  it('appends the extra note (e.g. residual-HELD)', () => {
    const o = formatOutcome('play', { ok: true, status: 202 }, 'still HELD');
    expect(o.text).to.contain('still HELD');
  });
});

describe('#823 classifyCoarseStreamEnd', () => {
  it('aborted (intentional teardown/rebind) → null (no change)', () => {
    expect(classifyCoarseStreamEnd(new SubscribeHttpError(404, 'x'), true)).to.equal(null);
    expect(classifyCoarseStreamEnd(undefined, true)).to.equal(null);
  });
  it('404 (maestro gone) → gone', () => {
    expect(classifyCoarseStreamEnd(new SubscribeHttpError(404, 'not found'), false)).to.deep.equal({ connection: 'gone' });
  });
  it('401 (auth) → reconnecting + actionable hint, NOT gone', () => {
    const r = classifyCoarseStreamEnd(new SubscribeHttpError(401, 'denied'), false);
    expect(r?.connection).to.equal('reconnecting');
    expect(r?.detail).to.contain('AGENT_TEMPO_HTTP_ADMIN_TOKEN');
  });
  it('any other error → reconnecting', () => {
    expect(classifyCoarseStreamEnd(new Error('socket reset'), false)).to.deep.equal({ connection: 'reconnecting' });
  });
  it('a normal stream-end (no error) → reconnecting', () => {
    expect(classifyCoarseStreamEnd(undefined, false)).to.deep.equal({ connection: 'reconnecting' });
  });
});

describe('#822 parseDeliveryHint', () => {
  it('parses delivery / phase / warning', () => {
    expect(parseDeliveryHint(JSON.stringify({ delivery: 'queued', phase: 'detached', warning: 'queued-undeliverable (detached)' })))
      .to.deep.equal({ delivery: 'queued', phase: 'detached', warning: 'queued-undeliverable (detached)' });
  });
  it('maps a legacy queued:true → delivery:queued', () => {
    expect(parseDeliveryHint(JSON.stringify({ queued: true, phase: 'gone' }))).to.deep.equal({ delivery: 'queued', phase: 'gone' });
  });
  it('tolerates empty / non-JSON / hint-less bodies → {}', () => {
    expect(parseDeliveryHint('')).to.deep.equal({});
    expect(parseDeliveryHint('not json')).to.deep.equal({});
    expect(parseDeliveryHint(JSON.stringify({ ok: true, to: 'x' }))).to.deep.equal({});
  });
});

describe('#822 Controller.cmdCue — ⚠ on a detached target (daemon-reported)', () => {
  it('renders ⚠ queued + persists a warn entry when the daemon says delivery:queued', async () => {
    const fake = new FakeFetch();
    fake.nextText = JSON.stringify({ ok: true, to: 'cond', delivery: 'queued', phase: 'detached', queued: true, warning: 'queued-undeliverable (detached)' });
    const c = new Controller('ens', actions(fake));
    const ctx = fakeCtx();
    await c.cmdCue('cond hello', ctx);
    expect(ctx.notes[0]).to.contain('⚠');
    expect(ctx.notes[0]).to.contain('detached');
    expect(c.model.commandLog.at(-1)).to.deep.include({ level: 'warn' });
  });

  it('renders ✓ when the daemon reports delivery:live', async () => {
    const fake = new FakeFetch();
    fake.nextText = JSON.stringify({ ok: true, to: 'bob', delivery: 'live', queued: false });
    const c = new Controller('ens', actions(fake));
    const ctx = fakeCtx();
    await c.cmdCue('bob hi', ctx);
    expect(ctx.notes[0]).to.contain('✓');
    expect(c.model.commandLog.at(-1)).to.deep.include({ level: 'ok' });
  });
});

describe('#821/#833 Controller — /unpause + /play residual-HELD', () => {
  it('cmdUnpause POSTs play{release:true} (clears both axes)', async () => {
    const fake = new FakeFetch();
    const c = new Controller('ens', actions(fake));
    const ctx = fakeCtx();
    await c.cmdUnpause('', ctx);
    expect(fake.calls[0].url).to.equal('http://127.0.0.1:8473/v1/ensembles/ens/play');
    expect(JSON.parse(fake.calls[0].body!)).to.deep.equal({ release: true });
    expect(ctx.notes[0]).to.contain('✓');
    expect(ctx.notes[0]).to.contain('unpause');
  });

  it('cmdPlay release (key:val form) POSTs play{release:true}', async () => {
    const fake = new FakeFetch();
    const c = new Controller('ens', actions(fake));
    await c.cmdPlay('release: true', fakeCtx());
    expect(JSON.parse(fake.calls[0].body!)).to.deep.equal({ release: true });
  });

  it('cmdPlay (sources-only) with players still HELD names the residual axis', async () => {
    const fake = new FakeFetch();
    const c = new Controller('ens', actions(fake));
    c.model.held = true; // last-known: held players remain after a sources-only play
    const ctx = fakeCtx();
    await c.cmdPlay('', ctx);
    expect(JSON.parse(fake.calls[0].body!)).to.deep.equal({}); // release omitted
    expect(ctx.notes[0]).to.contain('HELD');
    expect(ctx.notes[0]).to.contain('/unpause');
  });

  it('cmdPlay (sources-only) with NO held players reports a plain ✓', async () => {
    const fake = new FakeFetch();
    const c = new Controller('ens', actions(fake));
    const ctx = fakeCtx();
    await c.cmdPlay('', ctx);
    expect(ctx.notes[0]).to.contain('✓');
    expect(ctx.notes[0]).to.not.contain('HELD');
  });
});

describe('#823 Controller.cmdEnsembleDown — optimistic gone on destroy', () => {
  const okInfra = async () => ({});
  it('--destroy success → board converges to gone + roster cleared', async () => {
    const fake = new FakeFetch();
    const c = new Controller('ens', actions(fake), 'host', okInfra);
    addPlayer(c, 'eng');
    addPlayer(c, 'qa');
    const ctx = fakeCtx();
    await c.cmdEnsembleDown('--destroy', ctx);
    expect(fake.calls[0].url).to.equal('http://127.0.0.1:8473/v1/ensembles/ens/shutdown');
    expect(JSON.parse(fake.calls[0].body!)).to.deep.equal({ destroy: true });
    expect(c.model.connection).to.equal('gone');
    expect(c.model.players.size).to.equal(0);
    expect(ctx.notes.at(-1)).to.contain('✓');
  });

  it('graceful (no --destroy) does NOT clear the board (players stay detached, reconciled by SSE)', async () => {
    const fake = new FakeFetch();
    const c = new Controller('ens', actions(fake), 'host', okInfra);
    addPlayer(c, 'eng');
    await c.cmdEnsembleDown('', fakeCtx());
    expect(c.model.connection).to.not.equal('gone');
    expect(c.model.players.size).to.equal(1);
  });

  it('--destroy FAILURE does NOT optimistically clear (no false convergence)', async () => {
    const fake = new FakeFetch();
    fake.nextStatus = 500;
    const c = new Controller('ens', actions(fake), 'host', okInfra);
    addPlayer(c, 'eng');
    await c.cmdEnsembleDown('--destroy', fakeCtx());
    expect(c.model.connection).to.not.equal('gone');
    expect(c.model.players.size).to.equal(1);
  });
});

describe('#821 command-log persistence — every write report folds into the widget model', () => {
  it('cmdCue persists its result line so the ack survives (not just an ephemeral toast)', async () => {
    const fake = new FakeFetch();
    const c = new Controller('ens', actions(fake));
    await c.cmdCue('bob hi', fakeCtx());
    expect(c.model.commandLog).to.have.length(1);
    expect(c.model.commandLog[0].text).to.contain('cue → bob');
  });

  it('the log is bounded (drop-oldest) so it can never grow unbounded', async () => {
    const fake = new FakeFetch();
    const c = new Controller('ens', actions(fake));
    for (let i = 0; i < 10; i++) await c.cmdCue(`p${i} hi`, fakeCtx());
    expect(c.model.commandLog.length).to.be.at.most(4);
    // The newest entry is retained.
    expect(c.model.commandLog.at(-1)!.text).to.contain('p9');
  });
});
