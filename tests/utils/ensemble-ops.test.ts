/**
 * Direct unit tests for `src/utils/ensemble-ops.ts` — the shared fan-out /
 * toggle module used by five MCP verbs (pause, play, shutdown, restore,
 * destroy) and their TempoClient counterparts.
 *
 * Flagged as **regression risk #1** in the #306 holistic review: a bug here
 * silently breaks all five verbs at once. These tests pin the module's
 * externally-observable contract so a future refactor can't quietly regress
 * signal cardinality, skip logic, or best-effort tolerance without a red test.
 *
 * Harness: fake Temporal Client — same shape as `tests/client/ensemble-verbs.test.ts`.
 * `scanEnsembleSessions` reads through `client.workflow.list()` + `getMetadata`
 * query, so we satisfy it with a stub generator and stubbed handles.
 * No vi.mock needed — the dependency is injected via the `client` argument.
 */
import { describe, it, expect } from 'vitest';
import {
  pauseMaestroAndScheduler,
  unpauseMaestroAndScheduler,
  signalAllSessions,
} from '../../src/utils/ensemble-ops';

// ── Fake client harness ──────────────────────────────────────────────────────

interface RecordedCall {
  workflowId: string;
  kind: 'signal' | 'query';
  name: string;
  payload?: unknown;
}

const asName = (n: unknown): string =>
  typeof n === 'string' ? n : (n as { name: string }).name;

/**
 * Build a fake Temporal Client covering the surface used by `ensemble-ops`:
 *   - `workflow.list()` — async generator yielding session workflow descriptors
 *   - `workflow.getHandle(id).signal(name, payload)` — captured in `calls`
 *   - `workflow.getHandle(id).query('getMetadata')` — returns minimal metadata
 *
 * `failOnSignal` lists workflow IDs whose `signal()` should throw — used to
 * exercise the best-effort / error-tolerance paths.
 */
function makeClient(opts: {
  ensemble: string;
  players: string[];
  failOnSignal?: Set<string>;
  hasScheduler?: boolean;
  hasMaestroHub?: boolean;
}) {
  const { ensemble, players } = opts;
  const failOnSignal = opts.failOnSignal ?? new Set<string>();
  const hasScheduler = opts.hasScheduler ?? true;
  const hasMaestroHub = opts.hasMaestroHub ?? true;

  const calls: RecordedCall[] = [];

  const sessionIds = players.map((p) => ({
    workflowId: `claude-session-${ensemble}-${p}`,
    playerId: p,
  }));

  const makeHandle = (workflowId: string) => ({
    workflowId,
    async query(nameOrDef: unknown) {
      const n = asName(nameOrDef);
      calls.push({ workflowId, kind: 'query', name: n });
      if (n === 'getMetadata') {
        const session = sessionIds.find((s) => s.workflowId === workflowId);
        if (!session) return undefined;
        return {
          ensemble,
          playerId: session.playerId,
          hostname: 'test-host',
          workDir: '/w',
          isConductor: false,
          agentType: 'claude',
        };
      }
      if (n === 'getPart') return '';
      return undefined;
    },
    async signal(nameOrDef: unknown, payload?: unknown) {
      const name = asName(nameOrDef);
      calls.push({ workflowId, kind: 'signal', name, payload });
      if (failOnSignal.has(workflowId)) {
        throw new Error(`signal to ${workflowId} failed`);
      }
    },
  });

  const client = {
    workflow: {
      getHandle(workflowId: string) {
        // Scheduler/maestro "not running" simulation.
        if (!hasScheduler && workflowId === `claude-scheduler-${ensemble}`) {
          return {
            workflowId,
            async query() { return undefined; },
            async signal() { throw new Error('workflow not found'); },
          };
        }
        if (!hasMaestroHub && workflowId === `claude-maestro-${ensemble}`) {
          return {
            workflowId,
            async query() { return undefined; },
            async signal() { throw new Error('workflow not found'); },
          };
        }
        return makeHandle(workflowId);
      },
      async *list() {
        for (const s of sessionIds) yield { workflowId: s.workflowId };
      },
    },
  };

  return { client: client as any, calls, sessionIds };
}

// ── pauseMaestroAndScheduler / unpauseMaestroAndScheduler ─────────────────

describe('pauseMaestroAndScheduler', () => {
  it('signals maestroSetPaused=true and setSchedulerPaused=true', async () => {
    const { client, calls } = makeClient({ ensemble: 'ens-pause', players: [] });
    const result = await pauseMaestroAndScheduler(client, 'ens-pause');

    expect(result.maestro).toBe(true);
    expect(result.scheduler).toBe(true);

    const maestroSignal = calls.find(
      (c) => c.workflowId === 'claude-maestro-ens-pause' && c.kind === 'signal',
    );
    expect(maestroSignal?.name).toBe('maestroSetPaused');
    expect(maestroSignal?.payload).toBe(true);

    const schedulerSignal = calls.find(
      (c) => c.workflowId === 'claude-scheduler-ens-pause' && c.kind === 'signal',
    );
    expect(schedulerSignal?.name).toBe('setSchedulerPaused');
    expect(schedulerSignal?.payload).toBe(true);
  });

  it('returns { maestro: false } when maestro workflow is not running', async () => {
    const { client, calls } = makeClient({
      ensemble: 'ens-no-maestro',
      players: [],
      hasMaestroHub: false,
    });
    const result = await pauseMaestroAndScheduler(client, 'ens-no-maestro');

    expect(result.maestro).toBe(false);
    expect(result.scheduler).toBe(true); // scheduler still reached
    // Scheduler signal still fired despite maestro being absent.
    expect(calls.some((c) => c.name === 'setSchedulerPaused')).toBe(true);
  });

  it('returns { scheduler: false } when scheduler workflow is not running', async () => {
    const { client, calls } = makeClient({
      ensemble: 'ens-no-sched',
      players: [],
      hasScheduler: false,
    });
    const result = await pauseMaestroAndScheduler(client, 'ens-no-sched');

    expect(result.maestro).toBe(true); // maestro still reached
    expect(result.scheduler).toBe(false);
    expect(calls.some((c) => c.name === 'maestroSetPaused')).toBe(true);
  });

  it('returns { maestro: false, scheduler: false } when both absent', async () => {
    const { client } = makeClient({
      ensemble: 'ens-bare',
      players: [],
      hasScheduler: false,
      hasMaestroHub: false,
    });
    const result = await pauseMaestroAndScheduler(client, 'ens-bare');
    expect(result.maestro).toBe(false);
    expect(result.scheduler).toBe(false);
  });

  it('does NOT throw when a signal fails — best-effort contract', async () => {
    // Simulate an arbitrary RPC error (not just "not found").
    const { client } = makeClient({
      ensemble: 'ens-rpc-err',
      players: [],
      failOnSignal: new Set(['claude-maestro-ens-rpc-err']),
    });
    await expect(pauseMaestroAndScheduler(client, 'ens-rpc-err')).resolves.not.toThrow();
  });
});

describe('unpauseMaestroAndScheduler', () => {
  it('signals maestroSetPaused=false and setSchedulerPaused=false', async () => {
    const { client, calls } = makeClient({ ensemble: 'ens-unpause', players: [] });
    const result = await unpauseMaestroAndScheduler(client, 'ens-unpause');

    expect(result.maestro).toBe(true);
    expect(result.scheduler).toBe(true);

    expect(calls.find((c) => c.name === 'maestroSetPaused')?.payload).toBe(false);
    expect(calls.find((c) => c.name === 'setSchedulerPaused')?.payload).toBe(false);
  });

  it('returns { maestro: false } when maestro is absent (best-effort)', async () => {
    const { client } = makeClient({
      ensemble: 'ens-unpause-no-m',
      players: [],
      hasMaestroHub: false,
    });
    const result = await unpauseMaestroAndScheduler(client, 'ens-unpause-no-m');
    expect(result.maestro).toBe(false);
    expect(result.scheduler).toBe(true);
  });
});

// ── signalAllSessions ────────────────────────────────────────────────────────

describe('signalAllSessions', () => {
  it('fans out a named signal to every session in the ensemble', async () => {
    const { client, calls } = makeClient({
      ensemble: 'ens-fanout',
      players: ['alice', 'bob', 'charlie'],
    });
    const result = await signalAllSessions(client, 'ens-fanout', 'setPaused', true);

    expect(result.sent).toBe(3);
    expect(result.skipped).toBe(0);
    expect(result.failed).toBe(0);

    const setPausedCalls = calls.filter((c) => c.kind === 'signal' && c.name === 'setPaused');
    expect(setPausedCalls).toHaveLength(3);
    // Every call carries the correct payload.
    expect(setPausedCalls.every((c) => c.payload === true)).toBe(true);
    // Every session's workflowId received the signal.
    const signalledIds = setPausedCalls.map((c) => c.workflowId);
    expect(signalledIds).toContain('claude-session-ens-fanout-alice');
    expect(signalledIds).toContain('claude-session-ens-fanout-bob');
    expect(signalledIds).toContain('claude-session-ens-fanout-charlie');
  });

  it('passes the payload through unchanged (false, objects, undefined)', async () => {
    const { client, calls } = makeClient({ ensemble: 'ens-payload', players: ['alice'] });

    await signalAllSessions(client, 'ens-payload', 'someSignal', false);
    expect(calls.find((c) => c.name === 'someSignal')?.payload).toBe(false);
  });

  it('returns empty result for an ensemble with no sessions', async () => {
    const { client } = makeClient({ ensemble: 'ens-empty', players: [] });
    const result = await signalAllSessions(client, 'ens-empty', 'setPaused', true);

    expect(result.sent).toBe(0);
    expect(result.skipped).toBe(0);
    expect(result.failed).toBe(0);
    expect(result.perSession).toHaveLength(0);
  });

  it('respects the skip predicate — skipped sessions receive no signal', async () => {
    const { client, calls } = makeClient({
      ensemble: 'ens-skip',
      players: ['alice', 'bob', 'caller'],
    });
    const result = await signalAllSessions(
      client,
      'ens-skip',
      'setPaused',
      true,
      { skip: (playerId) => playerId === 'caller' },
    );

    expect(result.sent).toBe(2);
    expect(result.skipped).toBe(1);
    expect(result.failed).toBe(0);

    // Caller's signal was never dispatched.
    const callerSignals = calls.filter(
      (c) => c.workflowId === 'claude-session-ens-skip-caller' && c.kind === 'signal',
    );
    expect(callerSignals).toHaveLength(0);
  });

  it('skip predicate receives the correct playerId (not the workflowId)', async () => {
    const { client } = makeClient({ ensemble: 'ens-skip-id', players: ['alice', 'bob'] });
    const seen: string[] = [];
    await signalAllSessions(client, 'ens-skip-id', 'sig', null, {
      skip: (id) => { seen.push(id); return false; },
    });
    // The IDs passed to skip() are short player names, not workflow IDs.
    expect(seen).toContain('alice');
    expect(seen).toContain('bob');
    expect(seen.every((id) => !id.startsWith('claude-session-'))).toBe(true);
  });

  it('tolerates individual session signal failures — others still succeed', async () => {
    const { client } = makeClient({
      ensemble: 'ens-fail-one',
      players: ['alice', 'bob', 'charlie'],
      failOnSignal: new Set(['claude-session-ens-fail-one-bob']),
    });
    const result = await signalAllSessions(client, 'ens-fail-one', 'setPaused', true);

    expect(result.sent).toBe(2);   // alice + charlie
    expect(result.failed).toBe(1); // bob
    expect(result.skipped).toBe(0);
    // The failing session is recorded in perSession with outcome 'failed'.
    const failedEntry = result.perSession.find((p) => p.playerId === 'bob');
    expect(failedEntry?.outcome).toBe('failed');
    expect('error' in failedEntry! && failedEntry.error).toContain('bob');
  });

  it('records per-session outcomes in perSession with correct shape', async () => {
    const { client } = makeClient({
      ensemble: 'ens-per-session',
      players: ['alice', 'bob'],
      failOnSignal: new Set(['claude-session-ens-per-session-bob']),
    });
    const result = await signalAllSessions(client, 'ens-per-session', 'sig', 'x');

    const alice = result.perSession.find((p) => p.playerId === 'alice');
    expect(alice?.outcome).toBe('sent');
    expect(alice?.workflowId).toBe('claude-session-ens-per-session-alice');

    const bob = result.perSession.find((p) => p.playerId === 'bob');
    expect(bob?.outcome).toBe('failed');
    expect(bob?.workflowId).toBe('claude-session-ens-per-session-bob');
  });

  it('perSession skipped entry has workflowId + outcome (no error field)', async () => {
    const { client } = makeClient({ ensemble: 'ens-skip-shape', players: ['alice', 'bob'] });
    const result = await signalAllSessions(
      client,
      'ens-skip-shape',
      'sig',
      null,
      { skip: (id) => id === 'alice' },
    );

    const aliceEntry = result.perSession.find((p) => p.playerId === 'alice');
    expect(aliceEntry?.outcome).toBe('skipped');
    expect('error' in aliceEntry!).toBe(false);
  });

  it('does not throw when all sessions fail — returns failed count only', async () => {
    const ensemble = 'ens-all-fail';
    const { client } = makeClient({
      ensemble,
      players: ['alice', 'bob'],
      failOnSignal: new Set([
        'claude-session-ens-all-fail-alice',
        'claude-session-ens-all-fail-bob',
      ]),
    });
    const result = await signalAllSessions(client, ensemble, 'sig', null);

    expect(result.sent).toBe(0);
    expect(result.failed).toBe(2);
    expect(result.skipped).toBe(0);
  });

  it('uses the correct workflow IDs (claude-session-{ensemble}-{player})', async () => {
    const { client, calls } = makeClient({
      ensemble: 'my-ens',
      players: ['player-a'],
    });
    await signalAllSessions(client, 'my-ens', 'testSignal', 42);

    const sig = calls.find((c) => c.kind === 'signal' && c.name === 'testSignal');
    expect(sig?.workflowId).toBe('claude-session-my-ens-player-a');
  });
});
