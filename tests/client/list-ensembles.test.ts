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
}): FakeWorkflow {
  return {
    workflowId: opts.workflowId,
    searchAttributes: {
      ClaudeTempoEnsemble: [opts.ensemble],
      ClaudeTempoAttachmentState: [opts.phase],
      ClaudeTempoIsConductor: [!!opts.isConductor],
    },
  };
}

function makeClient(workflows: FakeWorkflow[]): any {
  return {
    workflow: {
      getHandle() {
        return { async query() { return undefined; } };
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
});
