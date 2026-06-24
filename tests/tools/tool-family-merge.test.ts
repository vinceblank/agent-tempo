/**
 * #793 tool-family merge — canonical multi-action tools + forwarding aliases.
 *
 * Pure-logic unit tests over the descriptor handlers (no Temporal worker, no
 * network). A single fake handle records every executeUpdate / query / signal
 * so we can assert:
 *   - canonical `action` dispatch routes to the right underlying operation
 *   - per-action runtime guards reject missing required fields (friendly error,
 *     no Temporal call)
 *   - unknown actions are rejected
 *   - each legacy alias forwards to the same underlying op + payload as the
 *     canonical tool with `action` injected (alias parity)
 *   - reused-name canonicals (`schedule`, `stage`) default to `create` when
 *     `action` is omitted (backward-compat)
 */
import { describe, it, expect, vi } from 'vitest';
import { buildCoatCheckTool, buildCoatCheckAliasTools } from '../../src/tools/coat-check';
import { buildStateTool, buildStateAliasTools } from '../../src/tools/state';
import { buildScheduleTool, buildScheduleAliasTools } from '../../src/tools/schedule';
import { buildStageTool, buildStageAliasTools } from '../../src/tools/stage';
import { buildGateTool, buildGateAliasTools } from '../../src/tools/gate';

type Call = { kind: 'update' | 'query' | 'signal'; name: string; payload?: any };

function defName(def: any): string {
  return typeof def === 'string' ? def : def?.name ?? 'unknown';
}

/** Fake WorkflowHandle recording every interaction; canned responses by op name. */
function makeHandle(responses: Record<string, any> = {}) {
  const calls: Call[] = [];
  const handle = {
    executeUpdate: vi.fn(async (def: any, opts: any) => {
      calls.push({ kind: 'update', name: defName(def), payload: opts?.args?.[0] });
      return responses[defName(def)] ?? {};
    }),
    query: vi.fn(async (def: any, arg: any) => {
      calls.push({ kind: 'query', name: defName(def), payload: arg });
      return responses[defName(def)] ?? [];
    }),
    signal: vi.fn(async (def: any, arg: any) => {
      calls.push({ kind: 'signal', name: defName(def), payload: arg });
    }),
    describe: vi.fn(async () => ({})),
  } as any;
  return { handle, calls };
}

function makeClient(handle: any) {
  return { workflow: { getHandle: () => handle, start: vi.fn(async () => ({})) } } as any;
}

const config = { ensemble: 'test-ens', taskQueue: 'tq' } as any;
const pid = () => 'tester';

// ── coat_check (net-new name → action required) ────────────────────────────

describe('#793 coat_check canonical', () => {
  const responses = {
    coatCheckPut: { ticket: 'tkt-1', expiresAt: '2026-07-01', slotsUsed: 1, slotsTotal: 20 },
    coatCheckGet: { putBy: 'a', putAt: 't', expiresAt: 't', summary: 's', size: 3, fetchCount: 0, content: 'BODY' },
    coatCheckEvict: { evicted: true },
  };

  it('routes action="put" to the put update with the right payload', async () => {
    const { handle, calls } = makeHandle(responses);
    const tool = buildCoatCheckTool(makeClient(handle), config, pid);
    const r = await tool.handler({ action: 'put', summary: 's', content: 'c' });
    expect(r.isError).toBeFalsy();
    expect(calls).toEqual([{ kind: 'update', name: 'coatCheckPut', payload: { summary: 's', content: 'c', putBy: 'tester' } }]);
  });

  it('routes action="get" / "list" / "evict"', async () => {
    const { handle, calls } = makeHandle(responses);
    const tool = buildCoatCheckTool(makeClient(handle), config, pid);
    await tool.handler({ action: 'get', ticket: 'tkt-1' });
    await tool.handler({ action: 'list' });
    await tool.handler({ action: 'evict', ticket: 'tkt-1' });
    expect(calls.map((c) => c.name)).toEqual(['coatCheckGet', 'coatCheckList', 'coatCheckEvict']);
  });

  it('runtime-guards missing fields without touching Temporal', async () => {
    const { handle, calls } = makeHandle(responses);
    const tool = buildCoatCheckTool(makeClient(handle), config, pid);
    const noContent = await tool.handler({ action: 'put', summary: 's' });
    expect(noContent.isError).toBe(true);
    expect(noContent.text).toContain('action="put" requires "content"');
    const noTicket = await tool.handler({ action: 'get' });
    expect(noTicket.text).toContain('action="get" requires "ticket"');
    expect(calls).toHaveLength(0);
  });

  it('rejects an unknown action', async () => {
    const { handle } = makeHandle(responses);
    const tool = buildCoatCheckTool(makeClient(handle), config, pid);
    const r = await tool.handler({ action: 'nope' });
    expect(r.isError).toBe(true);
    expect(r.text).toContain('Unknown coat_check action');
  });

  it('alias parity: coat_check_put forwards identically to action="put"', async () => {
    const a = makeHandle(responses);
    const b = makeHandle(responses);
    const canonical = buildCoatCheckTool(makeClient(a.handle), config, pid);
    const aliases = buildCoatCheckAliasTools(makeClient(b.handle), config, pid);
    const put = aliases.find((t) => t.name === 'coat_check_put')!;
    expect(put.description).toContain('DEPRECATED');
    const viaCanonical = await canonical.handler({ action: 'put', summary: 's', content: 'c' });
    const viaAlias = await put.handler({ summary: 's', content: 'c' });
    expect(viaAlias.text).toEqual(viaCanonical.text);
    expect(b.calls).toEqual(a.calls);
  });

  it('exposes all four aliases', () => {
    const aliases = buildCoatCheckAliasTools(makeClient(makeHandle().handle), config, pid);
    expect(aliases.map((t) => t.name).sort()).toEqual(['coat_check_evict', 'coat_check_get', 'coat_check_list', 'coat_check_put']);
  });
});

// ── state (net-new name → action required) ─────────────────────────────────

describe('#793 state canonical', () => {
  const responses = { savePlayerState: { saved: true, savedAt: 't' }, clearPlayerState: { cleared: true } };

  it('routes save → update, clear → update, fetch → query', async () => {
    const { handle, calls } = makeHandle({ ...responses, playerState: { savedBy: 'tester', savedAt: 't', content: 'X' } });
    const tool = buildStateTool(makeClient(handle), config, handle, pid);
    await tool.handler({ action: 'save', content: 'c' });
    await tool.handler({ action: 'fetch' });
    await tool.handler({ action: 'clear' });
    expect(calls.map((c) => `${c.kind}:${c.name}`)).toEqual(['update:savePlayerState', 'query:playerState', 'update:clearPlayerState']);
  });

  it('runtime-guards save without content', async () => {
    const { handle, calls } = makeHandle(responses);
    const tool = buildStateTool(makeClient(handle), config, handle, pid);
    const r = await tool.handler({ action: 'save' });
    expect(r.isError).toBe(true);
    expect(r.text).toContain('action="save" requires "content"');
    expect(calls).toHaveLength(0);
  });

  it('alias parity: save_state forwards identically to action="save"', async () => {
    const a = makeHandle(responses);
    const b = makeHandle(responses);
    const canonical = buildStateTool(makeClient(a.handle), config, a.handle, pid);
    const aliases = buildStateAliasTools(makeClient(b.handle), config, b.handle, pid);
    const save = aliases.find((t) => t.name === 'save_state')!;
    expect(save.description).toContain('DEPRECATED');
    const viaCanonical = await canonical.handler({ action: 'save', content: 'c' });
    const viaAlias = await save.handler({ content: 'c' });
    expect(viaAlias.text).toEqual(viaCanonical.text);
    expect(b.calls).toEqual(a.calls);
  });
});

// ── schedule (reused name → action defaults to create) ─────────────────────

describe('#793 schedule canonical', () => {
  it('defaults to create when action omitted (backward-compat)', async () => {
    const { handle, calls } = makeHandle();
    const tool = buildScheduleTool(makeClient(handle), config, pid);
    const r = await tool.handler({ name: 's1', message: 'hi', target: 'all', delay: '10m' });
    expect(r.isError).toBeFalsy();
    expect(calls.some((c) => c.kind === 'signal' && c.name === 'addSchedule')).toBe(true);
  });

  it('routes action="cancel" → removeSchedule, action="list" → getSchedules', async () => {
    const { handle, calls } = makeHandle();
    const tool = buildScheduleTool(makeClient(handle), config, pid);
    await tool.handler({ action: 'cancel', name: 's1' });
    await tool.handler({ action: 'list' });
    expect(calls.some((c) => c.name === 'removeSchedule')).toBe(true);
    expect(calls.some((c) => c.name === 'getSchedules')).toBe(true);
  });

  it('runtime-guards create without name/message/target', async () => {
    const { handle } = makeHandle();
    const tool = buildScheduleTool(makeClient(handle), config, pid);
    const r = await tool.handler({ action: 'create', message: 'hi', target: 'all', delay: '10m' });
    expect(r.isError).toBe(true);
    expect(r.text).toContain('action="create" requires "name"');
  });

  it('alias parity: unschedule → cancel, schedules → list', async () => {
    const a = makeHandle();
    const b = makeHandle();
    const canonical = buildScheduleTool(makeClient(a.handle), config, pid);
    const aliases = buildScheduleAliasTools(makeClient(b.handle), config);
    const unsched = aliases.find((t) => t.name === 'unschedule')!;
    expect(unsched.description).toContain('DEPRECATED');
    const viaCanonical = await canonical.handler({ action: 'cancel', name: 's1' });
    const viaAlias = await unsched.handler({ name: 's1' });
    expect(viaAlias.text).toEqual(viaCanonical.text);
    expect(b.calls).toEqual(a.calls);
  });
});

// ── stage (reused name → action defaults to create, conductor-only) ────────

describe('#793 stage canonical', () => {
  it('defaults to create when action omitted (backward-compat)', async () => {
    const { handle, calls } = makeHandle();
    const tool = buildStageTool(handle, pid);
    const r = await tool.handler({ name: 'st1', players: ['a', 'b'] });
    expect(r.isError).toBeFalsy();
    expect(calls).toEqual([{ kind: 'signal', name: 'setStage', payload: { name: 'st1', players: ['a', 'b'], failurePolicy: undefined, createdBy: 'tester' } }]);
  });

  it('routes list → stages query, cancel → cancelStage signal', async () => {
    const { handle, calls } = makeHandle();
    const tool = buildStageTool(handle, pid);
    await tool.handler({ action: 'list' });
    await tool.handler({ action: 'cancel', name: 'st1' });
    expect(calls.map((c) => `${c.kind}:${c.name}`)).toEqual(['query:stages', 'signal:cancelStage']);
  });

  it('runtime-guards create without players', async () => {
    const { handle } = makeHandle();
    const tool = buildStageTool(handle, pid);
    const r = await tool.handler({ action: 'create', name: 'st1' });
    expect(r.isError).toBe(true);
    expect(r.text).toContain('action="create" requires "players"');
  });

  it('alias parity: stages → list, cancel_stage → cancel', async () => {
    const a = makeHandle();
    const b = makeHandle();
    const canonical = buildStageTool(a.handle, pid);
    const aliases = buildStageAliasTools(b.handle);
    const cancelStage = aliases.find((t) => t.name === 'cancel_stage')!;
    expect(cancelStage.description).toContain('DEPRECATED');
    const viaCanonical = await canonical.handler({ action: 'cancel', name: 'st1' });
    const viaAlias = await cancelStage.handler({ name: 'st1' });
    expect(viaAlias.text).toEqual(viaCanonical.text);
    expect(b.calls).toEqual(a.calls);
  });
});

// ── gate (net-new name → action required, partial merge) ───────────────────

describe('#793 gate canonical', () => {
  it('routes define → setQualityGate signal, list → qualityGates query', async () => {
    const { handle, calls } = makeHandle();
    const tool = buildGateTool(handle, pid);
    await tool.handler({ action: 'define', task: 't', criteria: ['c1'] });
    await tool.handler({ action: 'list' });
    expect(calls.map((c) => `${c.kind}:${c.name}`)).toEqual(['signal:setQualityGate', 'query:qualityGates']);
  });

  it('runtime-guards define without task/criteria', async () => {
    const { handle } = makeHandle();
    const tool = buildGateTool(handle, pid);
    const r = await tool.handler({ action: 'define', task: 't' });
    expect(r.isError).toBe(true);
    expect(r.text).toContain('action="define" requires "criteria"');
  });

  it('does NOT fold in evaluate_gate (only define|list exposed)', () => {
    const tool = buildGateTool(makeHandle().handle, pid);
    const actionField: any = tool.params.action;
    expect(actionField._def.values).toEqual(['define', 'list']);
  });

  it('alias parity: quality_gate → define, gates → list', async () => {
    const a = makeHandle();
    const b = makeHandle();
    const canonical = buildGateTool(a.handle, pid);
    const aliases = buildGateAliasTools(b.handle, pid);
    const qg = aliases.find((t) => t.name === 'quality_gate')!;
    expect(qg.description).toContain('DEPRECATED');
    const viaCanonical = await canonical.handler({ action: 'define', task: 't', criteria: ['c1'] });
    const viaAlias = await qg.handler({ task: 't', criteria: ['c1'] });
    expect(viaAlias.text).toEqual(viaCanonical.text);
    expect(b.calls).toEqual(a.calls);
  });
});
