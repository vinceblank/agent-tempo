/**
 * Unit tests for `TempoClient.listEnsembles`. Mocks the Temporal Client so
 * we never touch a live server; the goal is to lock in the three-state
 * online/paused/offline classification that the TUI home view relies on.
 */
import { describe, it, expect } from 'vitest';
import { createTempoClient } from '../../src/client';
import type { AttachmentPhase } from '../../src/types';

interface FakeWorkflow {
  workflowId: string;
  searchAttributes: Record<string, unknown[]>;
}

function wf(opts: {
  workflowId: string;
  ensemble: string;
  phase: AttachmentPhase;
  isConductor?: boolean;
  playerType?: string;
}): FakeWorkflow {
  return {
    workflowId: opts.workflowId,
    searchAttributes: {
      AgentTempoEnsemble: [opts.ensemble],
      AgentTempoAttachmentState: [opts.phase],
      AgentTempoIsConductor: [!!opts.isConductor],
      ...(opts.playerType ? { AgentTempoPlayerType: [opts.playerType] } : {}),
    },
  };
}

/**
 * Build a fake Temporal Client. `pausedByEnsemble` populates the
 * `maestroPaused` query result for each ensemble's maestro hub workflow
 * (id pattern: `agent-maestro-{ensemble}`). Hubs not listed throw on
 * query — same shape as a real "workflow not running" failure, which the
 * client treats as "fall through to the phase heuristic".
 */
function makeClient(
  workflows: FakeWorkflow[],
  pausedByEnsemble: Record<string, boolean> = {},
): any {
  return {
    workflow: {
      getHandle(workflowId: string) {
        return {
          async query(nameOrDef: any) {
            // Temporal's `handle.query()` accepts either a string name or a
            // QueryDefinition object — mirror both shapes here.
            const name = typeof nameOrDef === 'string' ? nameOrDef : nameOrDef?.name;
            if (name === 'maestroPaused') {
              const m = workflowId.match(/^agent-maestro-(.+)$/);
              if (m && m[1] in pausedByEnsemble) return pausedByEnsemble[m[1]];
              throw new Error('workflow not found');
            }
            return undefined;
          },
        };
      },
      async *list() {
        for (const w of workflows) yield w;
      },
    },
  };
}

describe('TempoClient.listEnsembles', () => {
  it('classifies an ensemble with any live session as online (no hub)', async () => {
    const tempo = createTempoClient(makeClient([
      wf({ workflowId: 'agent-session-alpha-conductor', ensemble: 'alpha', phase: 'attached', isConductor: true }),
      wf({ workflowId: 'agent-session-alpha-p1', ensemble: 'alpha', phase: 'detached' }),
    ]) as any);
    const list = await tempo.listEnsembles();
    expect(list).toHaveLength(1);
    expect(list[0]).toMatchObject({ name: 'alpha', state: 'online', hasConductor: true, playerCount: 2 });
  });

  it('classifies an all-detached ensemble as offline (no hub)', async () => {
    const tempo = createTempoClient(makeClient([
      wf({ workflowId: 'agent-session-beta-conductor', ensemble: 'beta', phase: 'detached', isConductor: true }),
      wf({ workflowId: 'agent-session-beta-p1', ensemble: 'beta', phase: 'detached' }),
    ]) as any);
    const list = await tempo.listEnsembles();
    expect(list).toHaveLength(1);
    expect(list[0]).toMatchObject({ name: 'beta', state: 'offline', hasConductor: true, playerCount: 2 });
  });

  it('skips ensembles with no live or detached sessions', async () => {
    const tempo = createTempoClient(makeClient([
      wf({ workflowId: 'agent-session-gone-conductor', ensemble: 'gone', phase: 'gone', isConductor: true }),
    ]) as any);
    const list = await tempo.listEnsembles();
    expect(list).toEqual([]);
  });

  it('falls back gracefully on workflow.list error', async () => {
    const brokenClient: any = {
      workflow: {
        getHandle() { return { async query() { return undefined; } }; },
        async *list() { throw new Error('boom'); },
      },
    };
    const tempo = createTempoClient(brokenClient);
    const list = await tempo.listEnsembles();
    expect(list).toEqual([]);
  });

  // ── Maestro session is excluded from headline player counts ──────────────
  // The maestro session is the TUI's own dashboard attachment, not a peer
  // agent. Counting it produced confusing "(2 players)" rows on a fresh
  // ensemble with one real player. Detected via `AgentTempoPlayerType`
  // search attribute (canonical) or workflow-id-suffix fallback.

  it('excludes the maestro session from playerCount (by playerType search attr)', async () => {
    const tempo = createTempoClient(makeClient([
      wf({ workflowId: 'agent-session-gamma-conductor', ensemble: 'gamma', phase: 'attached', isConductor: true }),
      wf({ workflowId: 'agent-session-gamma-alice', ensemble: 'gamma', phase: 'attached' }),
      wf({ workflowId: 'agent-session-gamma-maestro', ensemble: 'gamma', phase: 'attached', playerType: 'maestro' }),
    ]) as any);
    const list = await tempo.listEnsembles();
    expect(list).toHaveLength(1);
    expect(list[0].playerCount).toBe(2); // conductor + alice; maestro excluded
  });

  it('excludes the maestro session by workflow-id suffix when search attr missing', async () => {
    // Brief post-start window where AgentTempoPlayerType hasn't propagated.
    const tempo = createTempoClient(makeClient([
      wf({ workflowId: 'agent-session-delta-alice', ensemble: 'delta', phase: 'attached' }),
      wf({ workflowId: 'agent-session-delta-maestro', ensemble: 'delta', phase: 'booting' /* no playerType */ }),
    ]) as any);
    const list = await tempo.listEnsembles();
    expect(list).toHaveLength(1);
    expect(list[0].playerCount).toBe(1); // only alice
  });

  // ── Online / Paused / Offline driven by maestro hub `paused` query ──────
  // After `/pause` or `/shutdown`, maestroSetPausedSignal flips the hub's
  // `paused` flag. The hub's `maestroPaused` query is the authoritative
  // classifier; the live-adapter count distinguishes paused (resume in
  // place via `/play`) from offline (needs `/restore`). The phase
  // heuristic is the fallback when the hub doesn't answer.

  it('classifies a paused hub with a live peer adapter as `paused` (resume in place)', async () => {
    // Mirrors the `/pause` flow: hub paused, but every peer adapter is
    // still attached — `/play` will fan unpause back out without needing
    // a restore. The dashboard maestro session is excluded from the
    // live-adapter count so its always-attached phase doesn't flip the
    // verdict.
    const tempo = createTempoClient(
      makeClient(
        [
          wf({ workflowId: 'agent-session-eps-alice', ensemble: 'eps', phase: 'attached' }),
          wf({ workflowId: 'agent-session-eps-maestro', ensemble: 'eps', phase: 'attached', playerType: 'maestro' }),
        ],
        { eps: true },
      ) as any,
    );
    const list = await tempo.listEnsembles();
    expect(list).toHaveLength(1);
    expect(list[0]).toMatchObject({ name: 'eps', state: 'paused', playerCount: 1 });
  });

  it('classifies a paused hub with no live peer adapters as `offline` (needs restore)', async () => {
    // Mirrors the `/shutdown` flow: hub paused and every peer session is
    // detached. The dashboard maestro keeps its attached phase but is
    // excluded from the live-adapter count, so the verdict is offline.
    const tempo = createTempoClient(
      makeClient(
        [
          wf({ workflowId: 'agent-session-shut-alice', ensemble: 'shut', phase: 'detached' }),
          wf({ workflowId: 'agent-session-shut-maestro', ensemble: 'shut', phase: 'attached', playerType: 'maestro' }),
        ],
        { shut: true },
      ) as any,
    );
    const list = await tempo.listEnsembles();
    expect(list).toHaveLength(1);
    expect(list[0]).toMatchObject({ name: 'shut', state: 'offline', playerCount: 1 });
  });

  it('classifies an ensemble as online when maestro hub reports paused=false', async () => {
    const tempo = createTempoClient(
      makeClient(
        [
          // Even if every session were detached, an unpaused hub means the
          // user has explicitly resumed (`/play`) — honor the hub's truth.
          wf({ workflowId: 'agent-session-zeta-alice', ensemble: 'zeta', phase: 'detached' }),
        ],
        { zeta: false },
      ) as any,
    );
    const list = await tempo.listEnsembles();
    expect(list).toHaveLength(1);
    expect(list[0]).toMatchObject({ name: 'zeta', state: 'online', playerCount: 1 });
  });

  it('falls back to the phase heuristic when the maestro hub does not exist', async () => {
    // Bare ensemble with no hub (pre-#287 / pre-conductor / pre-TUI). The
    // hub query throws; the phase heuristic decides — a live adapter
    // present means online.
    const tempo = createTempoClient(
      makeClient([
        wf({ workflowId: 'agent-session-eta-alice', ensemble: 'eta', phase: 'attached' }),
      ]) as any,
    );
    const list = await tempo.listEnsembles();
    expect(list).toHaveLength(1);
    expect(list[0]).toMatchObject({ name: 'eta', state: 'online' });
  });
});
