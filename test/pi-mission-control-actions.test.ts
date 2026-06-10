/**
 * Mission-control action-client + command-handler unit tests (3f).
 * Injected fetch (no daemon) + a fake Pi ctx (records notify).
 */
import { expect } from 'chai';
import { MissionControlActions, type ActionFetch } from '../src/pi/mission-control/actions';
import {
  Controller,
  parseEnsembleUpArgs,
  parseRecruitArgs,
  registerPlannerTools,
} from '../src/pi/mission-control/extension';
import { applyTempoEvent } from '../src/pi/mission-control/board';
import type { TempoEvent, PlayerSummaryV1 } from '../src/http/event-types';
import type { McExtensionContext, McExtensionAPI, McToolDefinition } from '../src/pi/mission-control/pi-ui';

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

  it('returns an error (no throw) on a non-2xx response', async () => {
    const fake = new FakeFetch();
    fake.nextStatus = 403; fake.nextText = 'forbidden';
    const r = await actions(fake).cue('bob', 'hi');
    expect(r.ok).to.equal(false);
    if (!r.ok) expect(r.error).to.contain('403');
  });

  // #54 — tokenless is NO LONGER a hard pre-block. A loopback daemon grants full
  // trust tokenless, so the client ATTEMPTS the request (no Authorization header)
  // and lets the daemon decide; the token is only required by a remote/0.0.0.0
  // daemon (which 401s). auth.ts is untouched — remote stays enforced server-side.
  it('without a token → ATTEMPTS tokenless (no Authorization header) and succeeds on 2xx (#54 loopback)', async () => {
    const fake = new FakeFetch(); // default nextStatus 202 (2xx)
    const a = new MissionControlActions({ ensemble: 'ens', adminToken: undefined, baseUrl: 'http://x', fetchFn: fake.fn });
    expect(a.ready, 'ready no longer gates on the token').to.equal(true);
    const r = await a.cue('b', 'm');
    expect(r.ok).to.equal(true);
    expect(fake.calls, 'it DID contact the daemon').to.have.length(1);
    expect(fake.calls[0].headers.Authorization, 'no Bearer sent tokenless').to.equal(undefined);
    expect(fake.calls[0].headers['Content-Type']).to.equal('application/json');
  });

  it('without a token → a 401/403/503 surfaces an ACTIONABLE error naming the admin token (#54 remote)', async () => {
    for (const status of [401, 403, 503]) {
      const fake = new FakeFetch();
      fake.nextStatus = status; fake.nextText = 'denied';
      const a = new MissionControlActions({ ensemble: 'ens', adminToken: undefined, baseUrl: 'http://x', fetchFn: fake.fn });
      const r = await a.cue('b', 'm');
      expect(r.ok, `status ${status}`).to.equal(false);
      if (!r.ok) {
        expect(r.error, `status ${status} in error`).to.contain(String(status));
        expect(r.error, `status ${status} actionable`).to.contain('AGENT_TEMPO_HTTP_ADMIN_TOKEN');
      }
    }
  });

  it('with a token → sends the Bearer header (#54 — non-loopback path preserved)', async () => {
    const fake = new FakeFetch();
    const r = await actions(fake).cue('b', 'm'); // actions() injects adminToken: 'tok'
    expect(r.ok).to.equal(true);
    expect(fake.calls[0].headers.Authorization).to.equal('Bearer tok');
  });

  // ── Bootstrap surface (#700 P1) ──
  it('createEnsemble POSTs /v1/ensembles with the bound name + opts', async () => {
    const fake = new FakeFetch();
    fake.nextStatus = 201;
    await actions(fake).createEnsemble({ lineup: 'tempo-dev-team', startMode: 'hold', conductorAgent: 'pi' });
    expect(fake.calls[0].url).to.equal('http://127.0.0.1:8473/v1/ensembles');
    expect(JSON.parse(fake.calls[0].body!)).to.deep.equal({
      name: 'ens', lineup: 'tempo-dev-team', startMode: 'hold', conductorAgent: 'pi',
    });
  });

  it('createEnsemble lets an explicit name override the bound ensemble', async () => {
    const fake = new FakeFetch();
    fake.nextStatus = 201;
    await actions(fake).createEnsemble({ name: 'myband' });
    expect(JSON.parse(fake.calls[0].body!)).to.deep.equal({ name: 'myband' });
  });

  it('recruit POSTs /v1/ensembles/:e/recruit with name+workDir+opts', async () => {
    const fake = new FakeFetch();
    await actions(fake).recruit({ name: 'eng', workDir: '/w', playerType: 'tempo-soloist', agent: 'pi' });
    expect(fake.calls[0].url).to.equal('http://127.0.0.1:8473/v1/ensembles/ens/recruit');
    expect(JSON.parse(fake.calls[0].body!)).to.deep.equal({ name: 'eng', workDir: '/w', playerType: 'tempo-soloist', agent: 'pi' });
  });

  it('shutdownEnsemble POSTs /shutdown — empty body graceful, {destroy} on destroy', async () => {
    const fake = new FakeFetch();
    const a = actions(fake);
    await a.shutdownEnsemble();
    await a.shutdownEnsemble(true);
    expect(fake.calls[0].url).to.equal('http://127.0.0.1:8473/v1/ensembles/ens/shutdown');
    expect(JSON.parse(fake.calls[0].body!)).to.deep.equal({});
    expect(JSON.parse(fake.calls[1].body!)).to.deep.equal({ destroy: true });
  });
});

describe('mission-control bootstrap arg parsers (#700 P1)', () => {
  it('parseEnsembleUpArgs handles name / --lineup / --hold (and = forms)', () => {
    expect(parseEnsembleUpArgs('')).to.deep.equal({ hold: false });
    expect(parseEnsembleUpArgs('myband --lineup tempo-dev-team --hold')).to.deep.equal({ name: 'myband', lineup: 'tempo-dev-team', hold: true });
    expect(parseEnsembleUpArgs('myband --lineup=foo')).to.deep.equal({ name: 'myband', lineup: 'foo', hold: false });
  });

  it('parseRecruitArgs handles name + --type/--host/--agent (and = forms)', () => {
    expect(parseRecruitArgs('eng --type tempo-soloist --host h1 --agent pi')).to.deep.equal({ name: 'eng', type: 'tempo-soloist', host: 'h1', agent: 'pi' });
    expect(parseRecruitArgs('eng --agent=claude')).to.deep.equal({ name: 'eng', agent: 'claude' });
    expect(parseRecruitArgs('')).to.deep.equal({});
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

describe('mission-control Controller — bootstrap commands (#700 P1)', () => {
  // Injected ensureInfra that just resolves (no Temporal / daemon spawn).
  const okInfra = async () => ({});

  it('cmdEnsembleUp ensures infra then POSTs create with conductorAgent=pi (headless default)', async () => {
    const fake = new FakeFetch();
    fake.nextStatus = 201;
    let infraCalls = 0;
    const c = new Controller('ens', actions(fake), 'host', async () => { infraCalls++; return {}; });
    const ctx = fakeCtx();
    await c.cmdEnsembleUp('--lineup tempo-dev-team', ctx);
    expect(infraCalls).to.equal(1);
    expect(fake.calls[0].url).to.equal('http://127.0.0.1:8473/v1/ensembles');
    expect(JSON.parse(fake.calls[0].body!)).to.deep.equal({ name: 'ens', lineup: 'tempo-dev-team', startMode: 'release', conductorAgent: 'pi' });
    expect(ctx.notes.pop()).to.contain('✓');
  });

  it('cmdEnsembleUp --hold maps to startMode:hold and honors a name arg', async () => {
    const fake = new FakeFetch();
    fake.nextStatus = 201;
    const c = new Controller('ens', actions(fake), 'host', okInfra);
    await c.cmdEnsembleUp('myband --hold', fakeCtx());
    expect(JSON.parse(fake.calls[0].body!)).to.deep.equal({ name: 'myband', startMode: 'hold', conductorAgent: 'pi' });
  });

  it('cmdEnsembleUp aborts (no POST) when ensureInfra fails', async () => {
    const fake = new FakeFetch();
    const c = new Controller('ens', actions(fake), 'host', async () => { throw new Error('temporal down'); });
    const ctx = fakeCtx();
    await c.cmdEnsembleUp('', ctx);
    expect(fake.calls).to.have.length(0);
    expect(ctx.notes.some((n) => n.includes('infra failed'))).to.equal(true);
  });

  it('cmdRecruit ensures infra then POSTs recruit with workDir + opts', async () => {
    const fake = new FakeFetch();
    const c = new Controller('ens', actions(fake), 'host', okInfra);
    await c.cmdRecruit('eng --type tempo-soloist --agent pi', fakeCtx());
    expect(fake.calls[0].url).to.equal('http://127.0.0.1:8473/v1/ensembles/ens/recruit');
    const body = JSON.parse(fake.calls[0].body!);
    expect(body.name).to.equal('eng');
    expect(body.playerType).to.equal('tempo-soloist');
    expect(body.agent).to.equal('pi');
    expect(typeof body.workDir).to.equal('string'); // process.cwd()
  });

  it('cmdRecruit with no name shows usage (no infra, no POST)', async () => {
    const fake = new FakeFetch();
    let infraCalls = 0;
    const c = new Controller('ens', actions(fake), 'host', async () => { infraCalls++; return {}; });
    const ctx = fakeCtx();
    await c.cmdRecruit('', ctx);
    expect(infraCalls).to.equal(0);
    expect(fake.calls).to.have.length(0);
    expect(ctx.notes[0]).to.contain('Usage');
  });

  it('cmdEnsembleDown POSTs /shutdown — graceful by default, {destroy} with --destroy', async () => {
    const fake = new FakeFetch();
    const c = new Controller('ens', actions(fake), 'host', okInfra);
    await c.cmdEnsembleDown('', fakeCtx());
    await c.cmdEnsembleDown('--destroy', fakeCtx());
    expect(fake.calls[0].url).to.equal('http://127.0.0.1:8473/v1/ensembles/ens/shutdown');
    expect(JSON.parse(fake.calls[0].body!)).to.deep.equal({});
    expect(JSON.parse(fake.calls[1].body!)).to.deep.equal({ destroy: true });
  });
});

describe('MissionControlActions — Q&A surface (#700 P2)', () => {
  it('ask POSTs /ask with {target, question, questionId}', async () => {
    const fake = new FakeFetch();
    await actions(fake).ask({ target: 'eng', question: 'done?', questionId: 'q-1' });
    expect(fake.calls[0].url).to.equal('http://127.0.0.1:8473/v1/ensembles/ens/ask');
    expect(JSON.parse(fake.calls[0].body!)).to.deep.equal({ target: 'eng', question: 'done?', questionId: 'q-1' });
  });

  it('readAnswer GETs /answer and returns the entry', async () => {
    const fake = new FakeFetch();
    fake.nextStatus = 200;
    fake.nextText = JSON.stringify({ answer: { questionId: 'q-1', from: 'eng', text: 'done', answeredAt: '2026-01-01T00:00:00.000Z' } });
    const a = await actions(fake).readAnswer('q-1');
    expect(fake.calls[0].method).to.equal('GET');
    expect(fake.calls[0].url).to.equal('http://127.0.0.1:8473/v1/ensembles/ens/answer/q-1');
    expect(a).to.deep.equal({ questionId: 'q-1', from: 'eng', text: 'done', answeredAt: '2026-01-01T00:00:00.000Z' });
  });

  it('readAnswer returns null when the mailbox is empty', async () => {
    const fake = new FakeFetch();
    fake.nextStatus = 200; fake.nextText = JSON.stringify({ answer: null });
    expect(await actions(fake).readAnswer('q-x')).to.equal(null);
  });
});

describe('MissionControlActions — coat-check surface (#713)', () => {
  it('coatCheckPut POSTs /coat-check and returns the ticket from the body', async () => {
    const fake = new FakeFetch();
    fake.nextStatus = 200;
    fake.nextText = JSON.stringify({ ok: true, ticket: 'tkt-1', slotsUsed: 1, slotsTotal: 20 });
    const r = await actions(fake).coatCheckPut({ summary: 's', content: 'body', contentType: 'text/markdown' });
    expect(fake.calls[0].method).to.equal('POST');
    expect(fake.calls[0].url).to.equal('http://127.0.0.1:8473/v1/ensembles/ens/coat-check');
    expect(JSON.parse(fake.calls[0].body!)).to.deep.equal({ summary: 's', content: 'body', contentType: 'text/markdown' });
    expect(r.ok).to.equal(true);
    if (r.ok) expect(r.ticket).to.equal('tkt-1');
  });

  it('coatCheckPut surfaces a non-2xx as an error (no throw)', async () => {
    const fake = new FakeFetch();
    fake.nextStatus = 409; fake.nextText = JSON.stringify({ error: 'coat-check-slots-full' });
    const r = await actions(fake).coatCheckPut({ summary: 's', content: 'b' });
    expect(r.ok).to.equal(false);
  });
});

describe('mission-control Controller — Q&A + handoff commands (#700 P2)', () => {
  it('cmdAsk POSTs /ask then reports the answer (human poll path)', async () => {
    const fake = new FakeFetch();
    fake.nextStatus = 200;
    fake.nextText = JSON.stringify({ answer: { questionId: 'q', from: 'eng', text: 'all green', answeredAt: '2026-01-01T00:00:00.000Z' } });
    const c = new Controller('ens', actions(fake));
    const ctx = fakeCtx();
    await c.cmdAsk('eng is the migration done?', ctx);
    const ask = fake.calls.find((x) => x.url.endsWith('/ask'));
    expect(ask, 'ask POST fired').to.not.equal(undefined);
    const body = JSON.parse(ask!.body!);
    expect(body.target).to.equal('eng');
    expect(body.question).to.equal('is the migration done?');
    expect(body.questionId).to.be.a('string').with.length.greaterThan(0);
    expect(ctx.notes.some((n) => n.includes('all green'))).to.equal(true);
  });

  it('cmdAsk with no question shows usage (no POST)', async () => {
    const fake = new FakeFetch();
    const c = new Controller('ens', actions(fake));
    const ctx = fakeCtx();
    await c.cmdAsk('eng', ctx);
    expect(fake.calls).to.have.length(0);
    expect(ctx.notes[0]).to.contain('Usage');
  });

  it('cmdHandoff cues the conductor INLINE with a [PLAN HANDOFF] prefix (small plan)', async () => {
    const fake = new FakeFetch();
    const c = new Controller('ens', actions(fake));
    await c.cmdHandoff('## Objective\nship it', fakeCtx());
    expect(fake.calls).to.have.length(1); // inline cue only — no coat-check stash
    expect(fake.calls[0].url).to.equal('http://127.0.0.1:8473/v1/ensembles/ens/cue');
    const body = JSON.parse(fake.calls[0].body!);
    expect(body.to).to.equal('conductor');
    expect(body.message).to.contain('[PLAN HANDOFF]');
    expect(body.message).to.contain('ship it');
  });

  it('cmdHandoff STASHES a medium plan (8–32KiB) and cues a ticket, not the body (#713)', async () => {
    const fake = new FakeFetch();
    fake.nextStatus = 200;
    fake.nextText = JSON.stringify({ ok: true, ticket: 'tkt-xyz', slotsUsed: 1, slotsTotal: 20 });
    const c = new Controller('ens', actions(fake));
    const bigPlan = '# Plan\n' + 'x'.repeat(10 * 1024); // > 8KiB, ≤ 32KiB → stash band
    await c.cmdHandoff(bigPlan, fakeCtx());
    // First: stash to the coat-check with the full plan as content.
    const stash = fake.calls.find((x) => x.url.endsWith('/coat-check'));
    expect(stash, 'coat-check POST fired').to.not.equal(undefined);
    expect(stash!.method).to.equal('POST');
    const stashBody = JSON.parse(stash!.body!);
    expect(stashBody.content).to.equal(bigPlan);
    expect(stashBody.contentType).to.equal('text/markdown');
    // Then: cue carries the redeem instruction + ticket, NOT the full plan body.
    const cue = fake.calls.find((x) => x.url.endsWith('/cue'));
    expect(cue, 'cue POST fired').to.not.equal(undefined);
    const cueBody = JSON.parse(cue!.body!);
    expect(cueBody.to).to.equal('conductor');
    expect(cueBody.message).to.contain('tkt-xyz');
    expect(cueBody.message).to.contain('coat_check_get');
    expect(cueBody.message).to.not.contain('x'.repeat(200)); // body stayed out of the cue
  });

  it('cmdHandoff falls back to an INLINE cue when the stash fails (#713)', async () => {
    const fake = new FakeFetch();
    fake.nextStatus = 409; fake.nextText = JSON.stringify({ error: 'coat-check-slots-full' });
    const c = new Controller('ens', actions(fake));
    const bigPlan = '# Plan\n' + 'y'.repeat(10 * 1024);
    await c.cmdHandoff(bigPlan, fakeCtx());
    expect(fake.calls.some((x) => x.url.endsWith('/coat-check'))).to.equal(true); // stash attempted
    const cue = fake.calls.find((x) => x.url.endsWith('/cue'));
    expect(cue, 'fallback inline cue fired').to.not.equal(undefined);
    expect(JSON.parse(cue!.body!).message).to.contain('y'.repeat(200)); // full plan inlined as fallback
  });
});

describe('mission-control planner LLM tools (#700 P2)', () => {
  function fakePiTools(): { pi: McExtensionAPI; tools: Map<string, McToolDefinition> } {
    const tools = new Map<string, McToolDefinition>();
    const pi = {
      on: () => { /* no-op */ },
      registerCommand: () => { /* no-op */ },
      registerShortcut: () => { /* no-op */ },
      registerTool: (def: McToolDefinition) => { tools.set(def.name, def); },
    } as unknown as McExtensionAPI;
    return { pi, tools };
  }

  it('registers ask / handoff / cue / recruit / observe_board', () => {
    const { pi, tools } = fakePiTools();
    registerPlannerTools(pi, new Controller('ens', actions(new FakeFetch())));
    expect([...tools.keys()].sort()).to.deep.equal(['ask', 'cue', 'handoff', 'observe_board', 'recruit']);
  });

  it('observe_board returns the board as text', async () => {
    const c = new Controller('ens', actions(new FakeFetch()));
    addPlayer(c, 'eng');
    const { pi, tools } = fakePiTools();
    registerPlannerTools(pi, c);
    const r = await tools.get('observe_board')!.execute('id', {});
    expect(r.content[0].text).to.contain('eng');
  });

  it('ask tool dispatches + yields (POSTs /ask, no /answer poll in the tool path)', async () => {
    const fake = new FakeFetch();
    const c = new Controller('ens', actions(fake));
    const { pi, tools } = fakePiTools();
    registerPlannerTools(pi, c);
    const r = await tools.get('ask')!.execute('id', { target: 'eng', question: 'q?' });
    expect(fake.calls.some((x) => x.url.endsWith('/ask'))).to.equal(true);
    expect(fake.calls.some((x) => x.url.includes('/answer/'))).to.equal(false); // yield, not poll
    expect(r.content[0].text.toLowerCase()).to.contain('woken');
  });

  it('cue tool THROWS on failure (Pi sanctioned error path)', async () => {
    const fake = new FakeFetch();
    fake.nextStatus = 500;
    const { pi, tools } = fakePiTools();
    registerPlannerTools(pi, new Controller('ens', actions(fake)));
    let threw = false;
    try { await tools.get('cue')!.execute('id', { to: 'eng', message: 'hi' }); } catch { threw = true; }
    expect(threw).to.equal(true);
  });
});
