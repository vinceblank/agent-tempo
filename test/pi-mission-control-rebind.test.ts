/**
 * #790 — mission-control multi-ensemble home + re-bind tests.
 *
 * Covers the full re-bind chain at unit level (the H3a test pattern: real
 * Controller + fake actions/ctx, no Pi, no daemon): the `rebindBoard`
 * reducer, the actions client's `setEnsemble`/`listEnsembles`, the
 * `/ensembles` + `/ensemble` commands (validation, #673 --force escape
 * hatch, onRebind hook firing), and the planner `list_ensembles` /
 * `bind_ensemble` tools.
 */
import { expect } from 'chai';
import { Controller, registerPlannerTools } from '../src/pi/mission-control/extension';
import { initBoard, rebindBoard, applyTempoEvent, selectPlayer } from '../src/pi/mission-control/board';
import { MissionControlActions } from '../src/pi/mission-control/actions';
import type { ActionFetch } from '../src/pi/mission-control/actions';
import type { TempoEvent, PlayerSummaryV1 } from '../src/http/event-types';
import type { McExtensionAPI, McExtensionContext, McToolResult } from '../src/pi/mission-control/pi-ui';
import type { EnsembleSummary } from '../src/client/interface';

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

/** Fake actions exposing only what the rebind surface touches. */
function fakeActions(opts: {
  ensembles?: EnsembleSummary[] | { error: string };
}): MissionControlActions {
  const calls: string[] = [];
  const fake = {
    calls,
    setEnsemble: (e: string) => { calls.push(`set:${e}`); },
    listEnsembles: async () => {
      const v = opts.ensembles ?? [];
      if (!Array.isArray(v)) return { ok: false as const, error: v.error };
      return { ok: true as const, ensembles: v };
    },
  };
  return fake as unknown as MissionControlActions;
}

const ens = (name: string, playerCount = 1, state?: EnsembleSummary['state']): EnsembleSummary =>
  ({ name, playerCount, hasConductor: true, ...(state ? { state } : {}) });

describe('#790 rebindBoard reducer', () => {
  it('re-keys IN PLACE: clears players/selection/tail/flags, bumps revision, keeps identity', () => {
    const model = initBoard('alpha');
    const before = model;
    applyTempoEvent(model, {
      v: 1, eventId: '0:1', type: 'player.added',
      payload: { playerId: 'x', isConductor: false, part: '' },
    } as unknown as TempoEvent);
    selectPlayer(model, 'x');
    model.paused = true;
    model.held = true;
    const rev = model.revision;

    rebindBoard(model, 'beta');

    expect(model).to.equal(before); // same object — closures stay live
    expect(model.ensemble).to.equal('beta');
    expect(model.players.size).to.equal(0);
    expect(model.selected).to.equal(null);
    expect(model.innerTail).to.deep.equal([]);
    expect(model.paused).to.equal(false);
    expect(model.held).to.equal(false);
    expect(model.revision).to.be.greaterThan(rev);
  });
});

describe('#790 MissionControlActions — setEnsemble + listEnsembles', () => {
  function recordingFetch(responses: Record<string, { status: number; body: string }>): { fetchFn: ActionFetch; urls: string[] } {
    const urls: string[] = [];
    const fetchFn: ActionFetch = async (url) => {
      urls.push(url);
      const suffix = url.replace(/^http:\/\/[^/]+/, '');
      const r = responses[suffix] ?? { status: 200, body: '{}' };
      return { status: r.status, text: async () => r.body };
    };
    return { fetchFn, urls };
  }

  it('setEnsemble re-points every ensemble-scoped route', async () => {
    const { fetchFn, urls } = recordingFetch({});
    const a = new MissionControlActions({ ensemble: 'alpha', baseUrl: 'http://x', fetchFn });
    await a.cue('p', 'hi');
    a.setEnsemble('beta');
    await a.cue('p', 'hi');
    expect(urls[0]).to.include('/v1/ensembles/alpha/cue');
    expect(urls[1]).to.include('/v1/ensembles/beta/cue');
  });

  it('listEnsembles GETs /v1/ensembles and parses the summary list', async () => {
    const { fetchFn } = recordingFetch({
      '/v1/ensembles': { status: 200, body: JSON.stringify([ens('alpha', 2, 'online'), ens('beta', 0, 'offline')]) },
    });
    const a = new MissionControlActions({ ensemble: 'alpha', baseUrl: 'http://x', fetchFn });
    const r = await a.listEnsembles();
    expect(r.ok).to.equal(true);
    if (r.ok) expect(r.ensembles.map((e) => e.name)).to.deep.equal(['alpha', 'beta']);
  });

  it('listEnsembles surfaces a non-2xx as an error', async () => {
    const { fetchFn } = recordingFetch({ '/v1/ensembles': { status: 500, body: 'boom' } });
    const a = new MissionControlActions({ ensemble: 'alpha', baseUrl: 'http://x', fetchFn });
    const r = await a.listEnsembles();
    expect(r.ok).to.equal(false);
  });
});

describe('#790 Controller — /ensembles + /ensemble', () => {
  it('/ensembles renders the list with ▶ marking the bound ensemble', async () => {
    const ctrl = new Controller('alpha', fakeActions({ ensembles: [ens('alpha', 2, 'online'), ens('beta', 1, 'paused')] }), 'box');
    const msgs: string[] = [];
    await ctrl.cmdEnsembles(fakeCtx(msgs));
    expect(msgs).to.have.length(1);
    expect(msgs[0]).to.include('Ensembles (2)');
    expect(msgs[0]).to.include('▶ alpha (2 players, online)');
    expect(msgs[0]).to.include('beta (1 player, paused)');
    expect(msgs[0].indexOf('▶')).to.equal(msgs[0].indexOf('▶ alpha')); // only the bound one marked
  });

  it('/ensemble with no name shows the current binding + usage (no rebind)', async () => {
    const ctrl = new Controller('alpha', fakeActions({}), 'box');
    const rebinds: string[] = [];
    ctrl.onRebind = (e) => rebinds.push(e);
    const msgs: string[] = [];
    await ctrl.cmdEnsemble('', fakeCtx(msgs));
    expect(rebinds).to.deep.equal([]);
    expect(msgs[0]).to.include('Bound to "alpha"');
    expect(msgs[0]).to.include('Usage: /ensemble <name>');
  });

  it('/ensemble to the SAME ensemble is a no-op', async () => {
    const ctrl = new Controller('alpha', fakeActions({ ensembles: [ens('alpha')] }), 'box');
    const rebinds: string[] = [];
    ctrl.onRebind = (e) => rebinds.push(e);
    const msgs: string[] = [];
    await ctrl.cmdEnsemble('alpha', fakeCtx(msgs));
    expect(rebinds).to.deep.equal([]);
    expect(msgs).to.deep.equal(['Already bound to "alpha".']);
  });

  it('/ensemble refuses an unknown name with the known list + /ensemble-up hint (no rebind)', async () => {
    const ctrl = new Controller('alpha', fakeActions({ ensembles: [ens('alpha'), ens('beta')] }), 'box');
    const rebinds: string[] = [];
    ctrl.onRebind = (e) => rebinds.push(e);
    const msgs: string[] = [];
    await ctrl.cmdEnsemble('ghost', fakeCtx(msgs));
    expect(rebinds).to.deep.equal([]);
    expect(msgs[0]).to.include('No such ensemble: "ghost"');
    expect(msgs[0]).to.include('alpha, beta');
    expect(msgs[0]).to.include('/ensemble-up ghost');
    expect(msgs[0]).to.include('--force'); // the #673 visibility-lag escape hatch is advertised
    expect(ctrl.model.ensemble).to.equal('alpha'); // unchanged
  });

  it('/ensemble refuses (with --force hint) when the daemon list is unavailable', async () => {
    const ctrl = new Controller('alpha', fakeActions({ ensembles: { error: 'daemon down' } }), 'box');
    const rebinds: string[] = [];
    ctrl.onRebind = (e) => rebinds.push(e);
    const msgs: string[] = [];
    await ctrl.cmdEnsemble('beta', fakeCtx(msgs));
    expect(rebinds).to.deep.equal([]);
    expect(msgs[0]).to.include('Cannot verify');
    expect(msgs[0]).to.include('--force');
  });

  it('/ensemble <name> happy path: re-keys actions + model, fires onRebind, clears board state', async () => {
    const actions = fakeActions({ ensembles: [ens('alpha'), ens('beta')] });
    const ctrl = new Controller('alpha', actions, 'box');
    addPlayer(ctrl, { playerId: 'x', hostname: 'box' });
    await ctrl.cmdTail('x', fakeCtx([]));
    const rebinds: string[] = [];
    ctrl.onRebind = (e) => rebinds.push(e);
    const msgs: string[] = [];

    await ctrl.cmdEnsemble('beta', fakeCtx(msgs));

    expect(rebinds).to.deep.equal(['beta']);
    expect((actions as unknown as { calls: string[] }).calls).to.include('set:beta');
    expect(ctrl.model.ensemble).to.equal('beta');
    expect(ctrl.model.players.size).to.equal(0); // old ensemble's rows cleared
    expect(ctrl.model.selected).to.equal(null);  // tail selection cleared
    expect(msgs[0]).to.include('Re-bound to "beta"');
  });

  it('/ensemble <name> --force binds without consulting the list (#673 lag window)', async () => {
    const actions = fakeActions({ ensembles: { error: 'must not be called' } });
    const ctrl = new Controller('alpha', actions, 'box');
    const rebinds: string[] = [];
    ctrl.onRebind = (e) => rebinds.push(e);
    const msgs: string[] = [];

    await ctrl.cmdEnsemble('fresh --force', fakeCtx(msgs));

    expect(rebinds).to.deep.equal(['fresh']);
    expect(ctrl.model.ensemble).to.equal('fresh');
    expect(msgs[0]).to.include('Re-bound to "fresh"');
  });
});

describe('#790 planner tools — list_ensembles + bind_ensemble', () => {
  type Tool = {
    name: string;
    execute: (id: string, params: unknown) => Promise<McToolResult> | McToolResult;
  };
  function fakePi(): { pi: McExtensionAPI; tools: Map<string, Tool> } {
    const tools = new Map<string, Tool>();
    const pi = {
      registerTool: (t: Tool) => { tools.set(t.name, t); },
    } as unknown as McExtensionAPI;
    return { pi, tools };
  }
  const text = (r: McToolResult): string => (r.content[0] as { text: string }).text;

  it('list_ensembles returns the same ▶-marked line the command shows', async () => {
    const ctrl = new Controller('alpha', fakeActions({ ensembles: [ens('alpha', 3, 'online')] }), 'box');
    const { pi, tools } = fakePi();
    registerPlannerTools(pi, ctrl);
    const out = await tools.get('list_ensembles')!.execute('1', {});
    expect(text(out as McToolResult)).to.include('▶ alpha (3 players, online)');
  });

  it('bind_ensemble re-binds through the same Controller path (onRebind fires)', async () => {
    const ctrl = new Controller('alpha', fakeActions({ ensembles: [ens('alpha'), ens('beta')] }), 'box');
    const rebinds: string[] = [];
    ctrl.onRebind = (e) => rebinds.push(e);
    const { pi, tools } = fakePi();
    registerPlannerTools(pi, ctrl);

    const out = await tools.get('bind_ensemble')!.execute('1', { name: 'beta' });

    expect(rebinds).to.deep.equal(['beta']);
    expect(ctrl.model.ensemble).to.equal('beta');
    expect(text(out as McToolResult)).to.include('Re-bound to "beta"');
  });

  it('bind_ensemble throws on an unknown ensemble (no rebind)', async () => {
    const ctrl = new Controller('alpha', fakeActions({ ensembles: [ens('alpha')] }), 'box');
    const rebinds: string[] = [];
    ctrl.onRebind = (e) => rebinds.push(e);
    const { pi, tools } = fakePi();
    registerPlannerTools(pi, ctrl);

    let threw = '';
    try {
      await tools.get('bind_ensemble')!.execute('1', { name: 'ghost' });
    } catch (err) {
      threw = (err as Error).message;
    }
    expect(threw).to.include('no such ensemble "ghost"');
    expect(rebinds).to.deep.equal([]);
    expect(ctrl.model.ensemble).to.equal('alpha');
  });
});
