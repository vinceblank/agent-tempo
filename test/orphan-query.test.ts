/**
 * Unit tests for `queryOrphanedSessions` + `buildOrphanQuery` (PR-E §10.1).
 *
 * No Temporal connection — all inputs are mock Client objects that yield
 * fixture workflows from `workflow.list` and return fixture query results.
 */
import { expect } from 'chai';
import {
  queryOrphanedSessions,
  buildOrphanQuery,
  isAdapterProcessAliveStub,
} from '../src/reconcile/orphans';
import type { AttachmentInfo, OrphanSummary } from '../src/types';

describe('buildOrphanQuery', function () {
  it('produces the §10.1 visibility query for a given hostname', function () {
    const q = buildOrphanQuery('host-1');
    expect(q).to.include('WorkflowType = "claudeSessionWorkflow"');
    expect(q).to.include('ExecutionStatus = "Running"');
    expect(q).to.include('ClaudeTempoAttachedHost = "host-1"');
    expect(q).to.include('ClaudeTempoAttachmentState IN ("attached","processing","awaiting","draining")');
    expect(q).to.include('ClaudeTempoAttachmentState = "detached"');
    expect(q).to.include('ClaudeTempoHostname = "host-1"');
  });

  it('sanitizes quote/backslash/newline chars out of the hostname', function () {
    const q = buildOrphanQuery('host"with\nquotes');
    expect(q).to.not.include('host"with');
    expect(q).to.not.include('\n');
    expect(q).to.include('hostwithquotes');
  });
});

describe('isAdapterProcessAliveStub', function () {
  it('always returns false per §8 answer 1', function () {
    expect(isAdapterProcessAliveStub()).to.be.false;
  });
});

function makeWorkflow(workflowId: string) {
  return { workflowId };
}

function makeFakeClient(opts: {
  workflows: Array<{ workflowId: string; info: AttachmentInfo; summary?: OrphanSummary; queryError?: Error }>;
}): any {
  const asName = (n: unknown) => typeof n === 'string' ? n : (n as any).name;
  const byId: Record<string, typeof opts.workflows[number]> = {};
  for (const w of opts.workflows) byId[w.workflowId] = w;

  return {
    workflow: {
      getHandle(workflowId: string) {
        const wf = byId[workflowId];
        return {
          workflowId,
          async query(name: unknown) {
            if (wf?.queryError) throw wf.queryError;
            const n = asName(name);
            if (n === 'attachmentInfo') return wf?.info;
            if (n === 'orphanSummary') return wf?.summary ?? {};
            return undefined;
          },
        };
      },
      async *list() {
        for (const wf of opts.workflows) {
          yield makeWorkflow(wf.workflowId);
        }
      },
    },
  };
}

describe('queryOrphanedSessions', function () {
  it('returns orphan candidates from workflow.list + attachmentInfo + orphanSummary', async function () {
    const client = makeFakeClient({
      workflows: [
        {
          workflowId: 'claude-session-e1-alice',
          info: { phase: 'detached', inFlightCount: 0 },
          summary: { detachedSince: '2026-04-01T00:00:00Z', preferredHost: 'host-1' },
        },
      ],
    });
    const orphans = await queryOrphanedSessions(client, { hostname: 'host-1' });
    expect(orphans).to.have.length(1);
    expect(orphans[0].workflowId).to.equal('claude-session-e1-alice');
    expect(orphans[0].info.phase).to.equal('detached');
    expect(orphans[0].summary.detachedSince).to.equal('2026-04-01T00:00:00Z');
  });

  it('skips candidates whose adapter process the predicate reports alive', async function () {
    const client = makeFakeClient({
      workflows: [
        {
          workflowId: 'claude-session-e1-alive',
          info: {
            phase: 'attached',
            inFlightCount: 0,
            currentAttachment: {
              attachmentId: 'a1',
              hostname: 'host-1',
              adapterId: 'claude-code',
              adapterClass: 'interactive',
              claimedAt: '2026-04-12T00:00:00Z',
              lastHeartbeatAt: '2026-04-13T00:00:00Z',
              expiresAt: '2026-04-13T01:30:00Z',
              leaseMs: 90_000,
              runId: 'r1',
            },
          },
        },
        {
          workflowId: 'claude-session-e1-dead',
          info: { phase: 'detached', inFlightCount: 0 },
          summary: {},
        },
      ],
    });
    const orphans = await queryOrphanedSessions(client, {
      hostname: 'host-1',
      isAdapterProcessAlive: (_host, workflowId) => workflowId === 'claude-session-e1-alive',
    });
    expect(orphans.map((o) => o.workflowId)).to.deep.equal(['claude-session-e1-dead']);
  });

  it('skips candidates whose query handler throws (workflow gone, race)', async function () {
    const client = makeFakeClient({
      workflows: [
        {
          workflowId: 'claude-session-e1-gone',
          info: { phase: 'gone', inFlightCount: 0 }, // unused
          queryError: new Error('WorkflowNotFound'),
        },
        {
          workflowId: 'claude-session-e1-ok',
          info: { phase: 'detached', inFlightCount: 0 },
          summary: {},
        },
      ],
    });
    const orphans = await queryOrphanedSessions(client, { hostname: 'host-1' });
    expect(orphans.map((o) => o.workflowId)).to.deep.equal(['claude-session-e1-ok']);
  });

  it('returns empty array when workflow.list yields nothing', async function () {
    const client = makeFakeClient({ workflows: [] });
    const orphans = await queryOrphanedSessions(client, { hostname: 'host-1' });
    expect(orphans).to.deep.equal([]);
  });
});
