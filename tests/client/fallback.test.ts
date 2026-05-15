/**
 * Unit tests for TempoClient query fallback precedence.
 * See src/client/index.ts. Issue #105, Phase 1.
 *
 * The client tries, in order:
 *   1. Global Maestro workflow query
 *   2. Per-ensemble Maestro workflow query
 *   3. Direct workflow-list scan
 * These tests mock the Temporal Client to exercise each fallback level
 * deterministically without spinning up a Temporal test env.
 */
import { describe, it, expect, vi } from 'vitest';
import { createTempoClient } from '../../src/client';
import type { AttachmentPhase, MaestroPlayerInfo } from '../../src/types';

// ── Helpers ──

/** Build a minimal fake Temporal Client. */
function makeFakeClient(opts: {
  /** Map of workflowId → query handler (name → result or error fn). */
  handlers: Record<string, Record<string, (...args: unknown[]) => unknown>>;
  /** Async iterator of workflow descriptions for `workflow.list`. */
  listItems?: Array<{ workflowId: string; searchAttributes?: Record<string, unknown[]> }>;
  /** If set, workflow.list throws this error instead of yielding. */
  listError?: Error;
}): any {
  return {
    workflow: {
      getHandle(workflowId: string) {
        return {
          workflowId,
          async query(name: string, ...args: unknown[]) {
            const wf = opts.handlers[workflowId];
            if (!wf || !wf[name]) {
              throw new Error(`No handler for ${workflowId}.query(${name})`);
            }
            const result = wf[name](...args);
            if (result instanceof Error) throw result;
            return result;
          },
          async executeUpdate(name: string, ...args: unknown[]) {
            const wf = opts.handlers[workflowId];
            if (!wf || !wf[name]) {
              throw new Error(`No handler for ${workflowId}.executeUpdate(${name})`);
            }
            const result = wf[name](...args);
            if (result instanceof Error) throw result;
            return result;
          },
          async signal() { /* noop */ },
          async describe() { return { status: { name: 'RUNNING' } }; },
        };
      },
      async *list() {
        if (opts.listError) throw opts.listError;
        for (const item of opts.listItems ?? []) {
          yield item;
        }
      },
    },
  };
}

function p(id: string, ensemble = 'demo', phase: AttachmentPhase = 'attached'): MaestroPlayerInfo {
  return {
    playerId: id,
    ensemble,
    part: '',
    hostname: 'test-host',
    workDir: '/tmp',
    isConductor: false,
    agentType: 'claude',
    phase,
  };
}

// ── getPlayers fallback precedence ──

describe('TempoClient.getPlayers — fallback precedence', () => {
  it('uses Global Maestro first when available', async () => {
    const globalResult = { demo: [p('alice'), p('bob')] };
    const fake = makeFakeClient({
      handlers: {
        'agent-maestro-global': {
          maestroPlayersByEnsemble: () => globalResult,
        },
      },
    });
    const spy = vi.spyOn(fake.workflow, 'getHandle');
    const client = createTempoClient(fake);

    const players = await client.getPlayers('demo');

    expect(players.map((x) => x.playerId)).toEqual(['alice', 'bob']);
    // Should have hit the global maestro handle
    expect(spy).toHaveBeenCalledWith('agent-maestro-global');
  });

  it('falls back to per-ensemble Maestro when Global Maestro fails', async () => {
    const fake = makeFakeClient({
      handlers: {
        'agent-maestro-global': {
          maestroPlayersByEnsemble: () => new Error('global maestro unavailable'),
        },
        'agent-maestro-demo': {
          maestroPlayers: () => [p('carol')],
        },
      },
    });
    const client = createTempoClient(fake);

    const players = await client.getPlayers('demo');
    expect(players.map((x) => x.playerId)).toEqual(['carol']);
  });

  it('falls back to direct workflow-list scan when both Maestro tiers fail', async () => {
    const fake = makeFakeClient({
      handlers: {
        'agent-maestro-global': {
          maestroPlayersByEnsemble: () => new Error('unavailable'),
        },
        'agent-maestro-demo': {
          maestroPlayers: () => new Error('unavailable'),
        },
      },
      listItems: [
        {
          workflowId: 'agent-session-demo-dave',
          searchAttributes: {
            AgentTempoEnsemble: ['demo'],
            AgentTempoPlayerId: ['dave'],
            AgentTempoHostname: ['host-1'],
            AgentTempoAttachmentState: ['attached'],
          },
        },
      ],
    });
    const client = createTempoClient(fake);

    const players = await client.getPlayers('demo');
    expect(players).toHaveLength(1);
    expect(players[0].playerId).toBe('dave');
    // Post-#177: `MaestroPlayerInfo.phase` (renamed from `.status` in #177).
    expect(players[0].phase).toBe('attached');
  });

  it('returns empty array when all three tiers fail', async () => {
    const fake = makeFakeClient({
      handlers: {
        'agent-maestro-global': { maestroPlayersByEnsemble: () => new Error('x') },
        'agent-maestro-demo': { maestroPlayers: () => new Error('x') },
      },
      listError: new Error('list failed'),
    });
    const client = createTempoClient(fake);
    expect(await client.getPlayers('demo')).toEqual([]);
  });

  it('uses per-ensemble Maestro when global has no entry for the ensemble', async () => {
    // Global Maestro is alive but doesn't know about "demo" yet
    // (maestroPlayersByEnsemble returns an empty record for demo).
    const fake = makeFakeClient({
      handlers: {
        'agent-maestro-global': {
          maestroPlayersByEnsemble: () => ({ /* no demo key */ }),
        },
        'agent-maestro-demo': {
          maestroPlayers: () => [p('eve')],
        },
      },
    });
    const client = createTempoClient(fake);
    const players = await client.getPlayers('demo');
    expect(players.map((x) => x.playerId)).toEqual(['eve']);
  });
});

// ── discoverEnsembles fallback ──

describe('TempoClient.discoverEnsembles — fallback precedence', () => {
  it('prefers Global Maestro and returns all ensembles it knows', async () => {
    const fake = makeFakeClient({
      handlers: {
        'agent-maestro-global': {
          maestroPlayersByEnsemble: () => ({
            demo: [p('alice'), { ...p('conductor'), isConductor: true }],
            other: [p('bob')],
          }),
        },
      },
    });
    const client = createTempoClient(fake);
    const ensembles = await client.discoverEnsembles();
    expect(ensembles.map((e) => e.name).sort()).toEqual(['demo', 'other']);
    const demo = ensembles.find((e) => e.name === 'demo')!;
    expect(demo.playerCount).toBe(2);
    expect(demo.hasConductor).toBe(true);
    const other = ensembles.find((e) => e.name === 'other')!;
    expect(other.hasConductor).toBe(false);
  });

  it('falls through to workflow list when Global Maestro returns empty', async () => {
    const fake = makeFakeClient({
      handlers: {
        'agent-maestro-global': {
          maestroPlayersByEnsemble: () => ({}),
        },
      },
      listItems: [
        {
          workflowId: 'agent-session-mine-conductor',
          searchAttributes: {
            AgentTempoEnsemble: ['mine'],
            AgentTempoIsConductor: [true],
            AgentTempoAttachmentState: ['attached'],
          },
        },
        {
          workflowId: 'agent-session-mine-alice',
          searchAttributes: {
            AgentTempoEnsemble: ['mine'],
            AgentTempoIsConductor: [false],
          },
        },
      ],
    });
    const client = createTempoClient(fake);
    const ensembles = await client.discoverEnsembles();
    expect(ensembles).toHaveLength(1);
    expect(ensembles[0].name).toBe('mine');
    expect(ensembles[0].playerCount).toBe(2);
    expect(ensembles[0].hasConductor).toBe(true);
    // Post-#176: `conductorStatus` reads attachment phase from
    // `AgentTempoAttachmentState` (mock returns 'attached' above).
    expect(ensembles[0].conductorStatus).toBe('attached');
  });

  it('returns empty array when both Global Maestro and workflow list fail', async () => {
    const fake = makeFakeClient({
      handlers: {
        'agent-maestro-global': {
          maestroPlayersByEnsemble: () => new Error('down'),
        },
      },
      listError: new Error('list failed'),
    });
    const client = createTempoClient(fake);
    expect(await client.discoverEnsembles()).toEqual([]);
  });
});

// ── getMessages (Global Maestro only, no fallback) ──

describe('TempoClient.getMessages', () => {
  it('filters ring-buffer messages by ensemble', async () => {
    const fake = makeFakeClient({
      handlers: {
        'agent-maestro-global': {
          maestroRecentMessages: () => [
            { id: 'a', ensemble: 'demo', from: 'alice', to: 'maestro', text: 'hi', timestamp: '', direction: 'inbound' },
            { id: 'b', ensemble: 'other', from: 'bob', to: 'maestro', text: 'other', timestamp: '', direction: 'inbound' },
            { id: 'c', ensemble: 'demo', from: 'carol', to: 'maestro', text: 'hi2', timestamp: '', direction: 'inbound' },
          ],
        },
      },
    });
    const client = createTempoClient(fake);
    const msgs = await client.getMessages('demo');
    expect(msgs.map((m) => m.id)).toEqual(['a', 'c']);
  });

  it('applies limit as a tail slice', async () => {
    const fake = makeFakeClient({
      handlers: {
        'agent-maestro-global': {
          maestroRecentMessages: () => Array.from({ length: 5 }, (_, i) => ({
            id: `m${i}`, ensemble: 'demo', from: 'alice', to: 'maestro',
            text: '', timestamp: '', direction: 'inbound' as const,
          })),
        },
      },
    });
    const client = createTempoClient(fake);
    const msgs = await client.getMessages('demo', 2);
    expect(msgs.map((m) => m.id)).toEqual(['m3', 'm4']);
  });

  it('returns empty array when Global Maestro query fails', async () => {
    const fake = makeFakeClient({
      handlers: {
        'agent-maestro-global': {
          maestroRecentMessages: () => new Error('x'),
        },
      },
    });
    const client = createTempoClient(fake);
    expect(await client.getMessages('demo')).toEqual([]);
  });
});

// ── getEnsembleChat (per-ensemble Maestro only) ──

describe('TempoClient.getEnsembleChat', () => {
  it('returns chat from per-ensemble Maestro', async () => {
    const fake = makeFakeClient({
      handlers: {
        'agent-maestro-demo': {
          maestroEnsembleChat: () => ({
            messages: [{ id: '1', from: 'alice', to: 'conductor', text: 'hi', timestamp: '', role: 'conductor-in' }],
            total: 1,
            hasMore: false,
            hasConductor: true,
          }),
        },
      },
    });
    const client = createTempoClient(fake);
    const chat = await client.getEnsembleChat('demo');
    expect(chat.total).toBe(1);
    expect(chat.hasConductor).toBe(true);
  });

  it('returns empty result when Maestro is unavailable', async () => {
    const fake = makeFakeClient({
      handlers: {
        'agent-maestro-demo': {
          maestroEnsembleChat: () => new Error('down'),
        },
      },
    });
    const client = createTempoClient(fake);
    const chat = await client.getEnsembleChat('demo');
    expect(chat).toEqual({ messages: [], total: 0, hasMore: false, hasConductor: false });
  });
});
