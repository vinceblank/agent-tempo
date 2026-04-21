/**
 * Vitest tests for #287 ensemble-scope TempoClient verbs:
 *   - pause / play
 *   - shutdown (fan-out detach + pause scheduler/maestro)
 *   - restore (delegate to restoreOrphansOnce + unpause)
 *   - destroy(ensemble, playerId?) — the ensemble-scope branch when playerId
 *     is omitted
 *
 * Harness pattern mirrors `tests/client/pr-d-verbs.test.ts`: fake Temporal
 * Client whose `getHandle` returns handles that capture signal/update calls
 * + a `scanEnsembleSessions`-style `workflow.list` yield.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { createTempoClient } from '../../src/client';

const asName = (n: unknown): string =>
  typeof n === 'string' ? n : (n as { name: string }).name;

interface Call {
  workflowId: string;
  kind: 'signal' | 'update' | 'terminate';
  name: string;
  payload?: unknown;
}

/**
 * Build a fake client with N sessions in `ensemble`. Each session's workflowId
 * follows the production convention `claude-session-{ens}-{playerId}`; the
 * conductor ID uses the `-conductor` suffix. `getHandle` returns a handle
 * that captures calls by workflowId. `scanEnsembleSessions` resolves via
 * `workflow.list` + the stubbed `getMetadata` query.
 */
function makeClient(opts: {
  ensemble: string;
  players: string[];
  includeConductor?: boolean;
  hasScheduler?: boolean;
  hasMaestroHub?: boolean;
  failOnUpdate?: Set<string>;
}) {
  const { ensemble, players, includeConductor = false } = opts;
  const hasScheduler = opts.hasScheduler ?? true;
  const hasMaestroHub = opts.hasMaestroHub ?? true;
  const failOnUpdate = opts.failOnUpdate ?? new Set<string>();

  const calls: Call[] = [];

  // Session workflow IDs (including conductor if requested).
  const sessionIds: Array<{ workflowId: string; playerId: string }> = players.map((p) => ({
    workflowId: `claude-session-${ensemble}-${p}`,
    playerId: p,
  }));
  if (includeConductor) {
    sessionIds.push({ workflowId: `claude-session-${ensemble}-conductor`, playerId: 'conductor' });
  }

  const makeHandle = (workflowId: string) => ({
    workflowId,
    async query(nameOrDef: unknown) {
      const n = asName(nameOrDef);
      if (n === 'getMetadata') {
        const session = sessionIds.find((s) => s.workflowId === workflowId);
        return {
          ensemble,
          playerId: session?.playerId ?? workflowId,
          hostname: 'test-host',
          workDir: '/w',
          isConductor: session?.playerId === 'conductor',
          agentType: 'claude',
        };
      }
      if (n === 'getPart') return '';
      return undefined;
    },
    async signal(nameOrDef: unknown, payload?: unknown) {
      calls.push({ workflowId, kind: 'signal', name: asName(nameOrDef), payload });
    },
    async executeUpdate(nameOrDef: unknown, updateOpts: { args: unknown[] }) {
      const name = asName(nameOrDef);
      calls.push({ workflowId, kind: 'update', name, payload: updateOpts.args[0] });
      if (failOnUpdate.has(workflowId)) throw new Error(`update ${name} failed`);
      return `entry-${calls.length}`;
    },
    async terminate(reason?: string) {
      calls.push({ workflowId, kind: 'terminate', name: 'terminate', payload: reason });
    },
  });

  const client = {
    workflow: {
      getHandle(workflowId: string) {
        // Scheduler / maestro are "not running" when the test opts them out.
        if (!hasScheduler && workflowId === `claude-scheduler-${ensemble}`) {
          return {
            workflowId,
            async signal() { throw new Error('workflow not found'); },
            async terminate() { throw new Error('workflow not found'); },
            async executeUpdate() { throw new Error('workflow not found'); },
          };
        }
        if (!hasMaestroHub && workflowId === `claude-maestro-${ensemble}`) {
          return {
            workflowId,
            async signal() { throw new Error('workflow not found'); },
            async terminate() { throw new Error('workflow not found'); },
            async executeUpdate() { throw new Error('workflow not found'); },
          };
        }
        return makeHandle(workflowId);
      },
      async *list() {
        for (const s of sessionIds) yield { workflowId: s.workflowId };
      },
    },
  };

  return { client, calls, sessionIds };
}

describe('TempoClient.pause / play (#287)', () => {
  it('pause signals setPaused=true on every session + maestro + scheduler', async () => {
    const { client, calls } = makeClient({ ensemble: 'e1', players: ['alice', 'bob'] });
    await createTempoClient(client as any).pause('e1');

    const setPausedTrue = calls.filter((c) => c.name === 'setPaused' && c.payload === true);
    expect(setPausedTrue).toHaveLength(2);
    expect(calls.some((c) => c.name === 'maestroSetPaused' && c.payload === true)).toBe(true);
    expect(calls.some((c) => c.name === 'setSchedulerPaused' && c.payload === true)).toBe(true);
  });

  it('play without release: setPaused=false only, no releaseHeld', async () => {
    const { client, calls } = makeClient({ ensemble: 'e1', players: ['alice'] });
    await createTempoClient(client as any).play('e1');

    const setPausedFalse = calls.filter((c) => c.name === 'setPaused' && c.payload === false);
    expect(setPausedFalse).toHaveLength(1);
    expect(calls.some((c) => c.name === 'releaseHeld')).toBe(false);
  });

  it('play with release: true: fans out releaseHeld to every session after unpause', async () => {
    const { client, calls } = makeClient({ ensemble: 'e1', players: ['alice', 'bob'] });
    await createTempoClient(client as any).play('e1', { release: true });

    const releases = calls.filter((c) => c.name === 'releaseHeld');
    expect(releases).toHaveLength(2);
    // Ordering invariant: setPaused(false) precedes releaseHeld per session.
    const firstSetPaused = calls.findIndex((c) => c.name === 'setPaused');
    const firstRelease = calls.findIndex((c) => c.name === 'releaseHeld');
    expect(firstSetPaused).toBeLessThan(firstRelease);
  });

  it('pause is best-effort when scheduler/maestro are not running', async () => {
    const { client, calls } = makeClient({
      ensemble: 'e1', players: ['alice'], hasScheduler: false, hasMaestroHub: false,
    });
    await expect(createTempoClient(client as any).pause('e1')).resolves.not.toThrow();
    // Session signal still fires.
    expect(calls.filter((c) => c.name === 'setPaused')).toHaveLength(1);
    // No maestro / scheduler signal landed.
    expect(calls.some((c) => c.name === 'maestroSetPaused')).toBe(false);
    expect(calls.some((c) => c.name === 'setSchedulerPaused')).toBe(false);
  });
});

describe('TempoClient.shutdown (#287)', () => {
  it('signals requestDetach on every session + pauses scheduler + maestro', async () => {
    const { client, calls } = makeClient({ ensemble: 'e1', players: ['alice', 'bob'] });
    const summary = await createTempoClient(client as any).shutdown('e1');

    expect(summary.detached).toBe(2);
    expect(summary.failed).toBe(0);
    expect(summary.maestroPaused).toBe(true);
    expect(summary.schedulerPaused).toBe(true);

    const detachCalls = calls.filter((c) => c.name === 'requestDetach');
    expect(detachCalls).toHaveLength(2);
    expect((detachCalls[0].payload as any).reason).toBe('user-stop');
  });

  it('forwards custom deadlineMs on each requestDetach signal', async () => {
    const { client, calls } = makeClient({ ensemble: 'e1', players: ['alice'] });
    await createTempoClient(client as any).shutdown('e1', { deadlineMs: 12_000 });
    const detach = calls.find((c) => c.name === 'requestDetach');
    expect((detach!.payload as any).deadlineMs).toBe(12_000);
  });

  it('counts per-session signal failures without aborting the loop', async () => {
    const { client } = makeClient({ ensemble: 'e1', players: ['alice', 'bob'] });
    // Override alice's handle to fail on signal.
    const origGetHandle = client.workflow.getHandle.bind(client.workflow);
    client.workflow.getHandle = (wfId: string) => {
      const h = origGetHandle(wfId);
      if (wfId.endsWith('-alice')) {
        return { ...h, async signal() { throw new Error('session gone'); } };
      }
      return h;
    };
    const summary = await createTempoClient(client as any).shutdown('e1');
    expect(summary.detached).toBe(1);
    expect(summary.failed).toBe(1);
    expect(summary.details.find((d) => d.playerId === 'alice')?.outcome).toBe('failed');
  });

  it('marks maestroPaused=false when maestro is not running', async () => {
    const { client } = makeClient({ ensemble: 'e1', players: ['alice'], hasMaestroHub: false });
    const summary = await createTempoClient(client as any).shutdown('e1');
    expect(summary.maestroPaused).toBe(false);
  });
});

describe('TempoClient.destroy (ensemble scope, #287)', () => {
  it('destroys peer sessions, terminates scheduler + maestro, destroys conductor last', async () => {
    const { client, calls } = makeClient({
      ensemble: 'e1', players: ['alice', 'bob'], includeConductor: true,
    });
    const summary = await createTempoClient(client as any).destroy('e1');
    if (summary === undefined) throw new Error('expected ensemble-scope summary');
    // Narrow: we know summary is EnsembleDestroySummary here.

    // destroyUpdate fired per peer + conductor = 3; terminate fired for scheduler + maestro = 2.
    const destroyCalls = calls.filter((c) => c.kind === 'update' && c.name === 'destroy');
    expect(destroyCalls).toHaveLength(3);
    expect(calls.filter((c) => c.kind === 'terminate')).toHaveLength(2);
    expect(summary.destroyed).toBe(3);
    expect(summary.terminated).toBe(2);

    // Ordering invariant: conductor destroy is the LAST update call.
    const updateNames = calls
      .filter((c) => c.kind === 'update' || c.kind === 'terminate')
      .map((c) => c.workflowId);
    expect(updateNames.at(-1)).toBe(`claude-session-e1-conductor`);
  });

  it('single-player mode (playerId given) still enqueues outbox entry', async () => {
    const { client, calls } = makeClient({ ensemble: 'e1', players: ['alice'] });
    // Make the maestro session workflow (`claude-session-e1-maestro`) capture
    // the outbox update. The harness getHandle already returns a handle that
    // records executeUpdate for every workflowId, so this path exercises the
    // existing single-player branch.
    await createTempoClient(client as any).destroy('e1', 'alice', 'cleanup');

    const outboxCall = calls.find((c) => c.name === 'submitOutbox');
    expect(outboxCall).toBeDefined();
    expect((outboxCall!.payload as any).type).toBe('destroy');
    expect((outboxCall!.payload as any).targetPlayerId).toBe('alice');
    expect((outboxCall!.payload as any).reason).toBe('cleanup');
  });
});

describe('TempoClient.restore (#287)', () => {
  let mod: typeof import('../../src/reconcile/orphans');

  beforeEach(async () => {
    mod = await import('../../src/reconcile/orphans');
    vi.spyOn(mod, 'restoreOrphansOnce').mockResolvedValue({
      reattached: 2,
      skipped: 1,
      failed: 0,
      details: [
        { playerId: 'alice', ensemble: 'e1', outcome: { kind: 'queued', entryId: 'entry-1' } },
        { playerId: 'bob', ensemble: 'e1', outcome: { kind: 'queued', entryId: 'entry-2' } },
        { playerId: 'stale', ensemble: 'e1', outcome: { kind: 'skipped', reason: 'ageWindow' } },
      ],
    });
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('delegates to restoreOrphansOnce + unpauses scheduler + maestro', async () => {
    const { client, calls } = makeClient({ ensemble: 'e1', players: [] });
    const summary = await createTempoClient(client as any).restore('e1');

    expect(mod.restoreOrphansOnce).toHaveBeenCalledOnce();
    const [, opts] = vi.mocked(mod.restoreOrphansOnce).mock.calls[0];
    expect(opts.invokerPlayerId).toBe('tempo-client');
    expect(opts.policy).toBe('auto');

    expect(summary.reattached).toBe(2);
    expect(summary.skipped).toBe(1);

    // Post-delegate unpause fires on scheduler + maestro.
    expect(calls.some((c) => c.name === 'setSchedulerPaused' && c.payload === false)).toBe(true);
    expect(calls.some((c) => c.name === 'maestroSetPaused' && c.payload === false)).toBe(true);
  });

  it('tolerates missing scheduler + maestro (best-effort unpause)', async () => {
    const { client } = makeClient({ ensemble: 'e1', players: [], hasScheduler: false, hasMaestroHub: false });
    await expect(createTempoClient(client as any).restore('e1')).resolves.toMatchObject({
      reattached: 2,
    });
  });
});
