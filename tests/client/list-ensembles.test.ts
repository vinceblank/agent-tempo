/**
 * Unit tests for `TempoClient.listEnsembles`. Mocks the Temporal Client so
 * we never touch a live server; the goal is to lock in the running-vs-parked
 * split that the TUI home view relies on.
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
      ClaudeTempoEnsemble: [opts.ensemble],
      ClaudeTempoAttachmentState: [opts.phase],
      ClaudeTempoIsConductor: [!!opts.isConductor],
      ...(opts.playerType ? { ClaudeTempoPlayerType: [opts.playerType] } : {}),
    },
  };
}

/**
 * Build a fake Temporal Client. `pausedByEnsemble` populates the
 * `maestroPaused` query result for each ensemble's maestro hub workflow
 * (id pattern: `claude-maestro-{ensemble}`). Hubs not listed throw on
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
              const m = workflowId.match(/^claude-maestro-(.+)$/);
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
  it('classifies an ensemble with any live session as running', async () => {
    const tempo = createTempoClient(makeClient([
      wf({ workflowId: 'claude-session-alpha-conductor', ensemble: 'alpha', phase: 'attached', isConductor: true }),
      wf({ workflowId: 'claude-session-alpha-p1', ensemble: 'alpha', phase: 'detached' }),
    ]) as any);
    const list = await tempo.listEnsembles();
    expect(list).toHaveLength(1);
    expect(list[0]).toMatchObject({ name: 'alpha', state: 'running', hasConductor: true, playerCount: 2 });
  });

  it('classifies an all-detached ensemble as parked', async () => {
    const tempo = createTempoClient(makeClient([
      wf({ workflowId: 'claude-session-beta-conductor', ensemble: 'beta', phase: 'detached', isConductor: true }),
      wf({ workflowId: 'claude-session-beta-p1', ensemble: 'beta', phase: 'detached' }),
    ]) as any);
    const list = await tempo.listEnsembles();
    expect(list).toHaveLength(1);
    expect(list[0]).toMatchObject({ name: 'beta', state: 'parked', hasConductor: true, playerCount: 2 });
  });

  it('skips ensembles with no live or detached sessions', async () => {
    const tempo = createTempoClient(makeClient([
      wf({ workflowId: 'claude-session-gone-conductor', ensemble: 'gone', phase: 'gone', isConductor: true }),
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
  // ensemble with one real player. Detected via `ClaudeTempoPlayerType`
  // search attribute (canonical) or workflow-id-suffix fallback.

  it('excludes the maestro session from playerCount (by playerType search attr)', async () => {
    const tempo = createTempoClient(makeClient([
      wf({ workflowId: 'claude-session-gamma-conductor', ensemble: 'gamma', phase: 'attached', isConductor: true }),
      wf({ workflowId: 'claude-session-gamma-alice', ensemble: 'gamma', phase: 'attached' }),
      wf({ workflowId: 'claude-session-gamma-maestro', ensemble: 'gamma', phase: 'attached', playerType: 'maestro' }),
    ]) as any);
    const list = await tempo.listEnsembles();
    expect(list).toHaveLength(1);
    expect(list[0].playerCount).toBe(2); // conductor + alice; maestro excluded
  });

  it('excludes the maestro session by workflow-id suffix when search attr missing', async () => {
    // Brief post-start window where ClaudeTempoPlayerType hasn't propagated.
    const tempo = createTempoClient(makeClient([
      wf({ workflowId: 'claude-session-delta-alice', ensemble: 'delta', phase: 'attached' }),
      wf({ workflowId: 'claude-session-delta-maestro', ensemble: 'delta', phase: 'booting' /* no playerType */ }),
    ]) as any);
    const list = await tempo.listEnsembles();
    expect(list).toHaveLength(1);
    expect(list[0].playerCount).toBe(1); // only alice
  });

  // ── Running vs Parked driven by maestro hub `paused` query ───────────────
  // After `/shutdown`, maestroSetPausedSignal flips the hub's `paused`
  // flag. The session phases stay attached/processing for the dashboard
  // maestro session — relying on phase alone misclassified shut-down
  // ensembles as Running. The hub's `maestroPaused` query is now the
  // authoritative classifier; the phase heuristic is the fallback.

  it('classifies an ensemble as parked when maestro hub reports paused=true', async () => {
    const tempo = createTempoClient(
      makeClient(
        [
          // The dashboard maestro session keeps an attached phase even after
          // shutdown — only peer sessions get `requestDetach`. Pre-#306 this
          // ran as Running because `hasLive` was true.
          wf({ workflowId: 'claude-session-eps-alice', ensemble: 'eps', phase: 'attached' }),
          wf({ workflowId: 'claude-session-eps-maestro', ensemble: 'eps', phase: 'attached', playerType: 'maestro' }),
        ],
        { eps: true },
      ) as any,
    );
    const list = await tempo.listEnsembles();
    expect(list).toHaveLength(1);
    expect(list[0]).toMatchObject({ name: 'eps', state: 'parked', playerCount: 1 });
  });

  it('classifies an ensemble as running when maestro hub reports paused=false', async () => {
    const tempo = createTempoClient(
      makeClient(
        [
          // Even if every session were detached, an unpaused hub means the
          // user has explicitly resumed (`/play`) — honor the hub's truth.
          wf({ workflowId: 'claude-session-zeta-alice', ensemble: 'zeta', phase: 'detached' }),
        ],
        { zeta: false },
      ) as any,
    );
    const list = await tempo.listEnsembles();
    expect(list).toHaveLength(1);
    expect(list[0]).toMatchObject({ name: 'zeta', state: 'running', playerCount: 1 });
  });

  it('falls back to the phase heuristic when the maestro hub does not exist', async () => {
    // Bare ensemble with no hub (pre-#287 / pre-conductor / pre-TUI). The
    // hub query throws; the phase heuristic decides.
    const tempo = createTempoClient(
      makeClient([
        wf({ workflowId: 'claude-session-eta-alice', ensemble: 'eta', phase: 'attached' }),
      ]) as any,
    );
    const list = await tempo.listEnsembles();
    expect(list).toHaveLength(1);
    expect(list[0]).toMatchObject({ name: 'eta', state: 'running' });
  });
});
