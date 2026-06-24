/**
 * #793 tool-family merge — mocha/chai counterpart to
 * tests/tools/tool-family-merge.test.ts (vitest). Pure-logic: invoke the
 * canonical descriptor handlers directly with a hand-rolled fake handle (no
 * Temporal worker, no network).
 *
 * Asserts canonical `action` dispatch, per-action runtime guards, alias parity
 * (legacy name forwards to the same underlying op + payload as the canonical
 * with `action` injected), and reused-name backward-compat (omitted `action`
 * defaults to `create`).
 */
import { expect } from 'chai';
import { buildCoatCheckTool, buildCoatCheckAliasTools } from '../src/tools/coat-check';
import { buildStateTool, buildStateAliasTools } from '../src/tools/state';
import { buildScheduleTool, buildScheduleAliasTools } from '../src/tools/schedule';
import { buildStageTool, buildStageAliasTools } from '../src/tools/stage';
import { buildGateTool, buildGateAliasTools } from '../src/tools/gate';

type Call = { kind: 'update' | 'query' | 'signal'; name: string; payload?: any };
const defName = (def: any): string => (typeof def === 'string' ? def : def?.name ?? 'unknown');

function makeHandle(responses: Record<string, any> = {}) {
  const calls: Call[] = [];
  const handle = {
    executeUpdate: async (def: any, opts: any) => {
      calls.push({ kind: 'update', name: defName(def), payload: opts?.args?.[0] });
      return responses[defName(def)] ?? {};
    },
    query: async (def: any, arg: any) => {
      calls.push({ kind: 'query', name: defName(def), payload: arg });
      return responses[defName(def)] ?? [];
    },
    signal: async (def: any, arg: any) => {
      calls.push({ kind: 'signal', name: defName(def), payload: arg });
    },
    describe: async () => ({}),
  } as any;
  return { handle, calls };
}
const makeClient = (handle: any) => ({ workflow: { getHandle: () => handle, start: async () => ({}) } } as any);

const config = { ensemble: 'test-ens', taskQueue: 'tq' } as any;
const pid = () => 'tester';

describe('#793 tool-family merge', function () {
  describe('coat_check canonical (net-new, action required)', function () {
    const responses = {
      coatCheckPut: { ticket: 'tkt-1', expiresAt: 'e', slotsUsed: 1, slotsTotal: 20 },
      coatCheckGet: { putBy: 'a', putAt: 't', expiresAt: 't', summary: 's', size: 3, fetchCount: 0, content: 'B' },
      coatCheckEvict: { evicted: true },
    };

    it('routes each action to its underlying op', async function () {
      const { handle, calls } = makeHandle(responses);
      const tool = buildCoatCheckTool(makeClient(handle), config, pid);
      await tool.handler({ action: 'put', summary: 's', content: 'c' });
      await tool.handler({ action: 'get', ticket: 'tkt-1' });
      await tool.handler({ action: 'list' });
      await tool.handler({ action: 'evict', ticket: 'tkt-1' });
      expect(calls.map((c) => c.name)).to.deep.equal(['coatCheckPut', 'coatCheckGet', 'coatCheckList', 'coatCheckEvict']);
    });

    it('runtime-guards missing fields and rejects unknown actions', async function () {
      const { handle, calls } = makeHandle(responses);
      const tool = buildCoatCheckTool(makeClient(handle), config, pid);
      const g = await tool.handler({ action: 'put', summary: 's' });
      expect(g.isError).to.equal(true);
      expect(g.text).to.contain('requires "content"');
      const u = await tool.handler({ action: 'bogus' });
      expect(u.text).to.contain('Unknown coat_check action');
      expect(calls).to.have.length(0);
    });

    it('alias parity: coat_check_put === action="put"', async function () {
      const a = makeHandle(responses);
      const b = makeHandle(responses);
      const canonical = buildCoatCheckTool(makeClient(a.handle), config, pid);
      const put = buildCoatCheckAliasTools(makeClient(b.handle), config, pid).find((t) => t.name === 'coat_check_put')!;
      expect(put.description).to.contain('DEPRECATED');
      const c1 = await canonical.handler({ action: 'put', summary: 's', content: 'c' });
      const c2 = await put.handler({ summary: 's', content: 'c' });
      expect(c2.text).to.equal(c1.text);
      expect(b.calls).to.deep.equal(a.calls);
    });
  });

  describe('state canonical (net-new, action required)', function () {
    const responses = { savePlayerState: { saved: true, savedAt: 't' }, clearPlayerState: { cleared: true }, playerState: { savedBy: 'tester', savedAt: 't', content: 'X' } };

    it('routes save/fetch/clear and guards save', async function () {
      const { handle, calls } = makeHandle(responses);
      const tool = buildStateTool(makeClient(handle), config, handle, pid);
      await tool.handler({ action: 'save', content: 'c' });
      await tool.handler({ action: 'fetch' });
      await tool.handler({ action: 'clear' });
      expect(calls.map((c) => `${c.kind}:${c.name}`)).to.deep.equal(['update:savePlayerState', 'query:playerState', 'update:clearPlayerState']);
      const g = await tool.handler({ action: 'save' });
      expect(g.text).to.contain('requires "content"');
    });

    it('alias parity: save_state === action="save"', async function () {
      const a = makeHandle(responses);
      const b = makeHandle(responses);
      const canonical = buildStateTool(makeClient(a.handle), config, a.handle, pid);
      const save = buildStateAliasTools(makeClient(b.handle), config, b.handle, pid).find((t) => t.name === 'save_state')!;
      expect(save.description).to.contain('DEPRECATED');
      const c1 = await canonical.handler({ action: 'save', content: 'c' });
      const c2 = await save.handler({ content: 'c' });
      expect(c2.text).to.equal(c1.text);
      expect(b.calls).to.deep.equal(a.calls);
    });
  });

  describe('schedule canonical (reused name, defaults to create)', function () {
    it('omitted action defaults to create (backward-compat)', async function () {
      const { handle, calls } = makeHandle();
      const tool = buildScheduleTool(makeClient(handle), config, pid);
      const r = await tool.handler({ name: 's1', message: 'hi', target: 'all', delay: '10m' });
      expect(r.isError).to.not.equal(true);
      expect(calls.some((c) => c.name === 'addSchedule')).to.equal(true);
    });

    it('routes cancel/list and guards create', async function () {
      const { handle, calls } = makeHandle();
      const tool = buildScheduleTool(makeClient(handle), config, pid);
      await tool.handler({ action: 'cancel', name: 's1' });
      await tool.handler({ action: 'list' });
      expect(calls.some((c) => c.name === 'removeSchedule')).to.equal(true);
      expect(calls.some((c) => c.name === 'getSchedules')).to.equal(true);
      const g = await tool.handler({ action: 'create', message: 'hi', target: 'all', delay: '10m' });
      expect(g.text).to.contain('requires "name"');
    });

    it('alias parity: unschedule === action="cancel"', async function () {
      const a = makeHandle();
      const b = makeHandle();
      const canonical = buildScheduleTool(makeClient(a.handle), config, pid);
      const unsched = buildScheduleAliasTools(makeClient(b.handle), config).find((t) => t.name === 'unschedule')!;
      expect(unsched.description).to.contain('DEPRECATED');
      const c1 = await canonical.handler({ action: 'cancel', name: 's1' });
      const c2 = await unsched.handler({ name: 's1' });
      expect(c2.text).to.equal(c1.text);
      expect(b.calls).to.deep.equal(a.calls);
    });
  });

  describe('stage canonical (reused name, defaults to create)', function () {
    it('omitted action defaults to create; routes list/cancel; guards create', async function () {
      const { handle, calls } = makeHandle();
      const tool = buildStageTool(handle, pid);
      await tool.handler({ name: 'st1', players: ['a', 'b'] });
      await tool.handler({ action: 'list' });
      await tool.handler({ action: 'cancel', name: 'st1' });
      expect(calls.map((c) => `${c.kind}:${c.name}`)).to.deep.equal(['signal:setStage', 'query:stages', 'signal:cancelStage']);
      const g = await tool.handler({ action: 'create', name: 'st1' });
      expect(g.text).to.contain('requires "players"');
    });

    it('alias parity: cancel_stage === action="cancel"', async function () {
      const a = makeHandle();
      const b = makeHandle();
      const canonical = buildStageTool(a.handle, pid);
      const cancelStage = buildStageAliasTools(b.handle).find((t) => t.name === 'cancel_stage')!;
      expect(cancelStage.description).to.contain('DEPRECATED');
      const c1 = await canonical.handler({ action: 'cancel', name: 'st1' });
      const c2 = await cancelStage.handler({ name: 'st1' });
      expect(c2.text).to.equal(c1.text);
      expect(b.calls).to.deep.equal(a.calls);
    });
  });

  describe('gate canonical (net-new, partial merge — evaluate_gate stays separate)', function () {
    it('routes define/list, guards define, and exposes only define|list', async function () {
      const { handle, calls } = makeHandle();
      const tool = buildGateTool(handle, pid);
      await tool.handler({ action: 'define', task: 't', criteria: ['c1'] });
      await tool.handler({ action: 'list' });
      expect(calls.map((c) => `${c.kind}:${c.name}`)).to.deep.equal(['signal:setQualityGate', 'query:qualityGates']);
      const g = await tool.handler({ action: 'define', task: 't' });
      expect(g.text).to.contain('requires "criteria"');
      expect(((tool.params.action as any)._def.values)).to.deep.equal(['define', 'list']);
    });

    it('alias parity: quality_gate === action="define"', async function () {
      const a = makeHandle();
      const b = makeHandle();
      const canonical = buildGateTool(a.handle, pid);
      const qg = buildGateAliasTools(b.handle, pid).find((t) => t.name === 'quality_gate')!;
      expect(qg.description).to.contain('DEPRECATED');
      const c1 = await canonical.handler({ action: 'define', task: 't', criteria: ['c1'] });
      const c2 = await qg.handler({ task: 't', criteria: ['c1'] });
      expect(c2.text).to.equal(c1.text);
      expect(b.calls).to.deep.equal(a.calls);
    });
  });
});
