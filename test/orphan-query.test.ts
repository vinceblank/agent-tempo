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
    const q = buildOrphanQuery({ hostname: 'host-1' });
    expect(q).to.include('WorkflowType = "agentSessionWorkflow"');
    expect(q).to.include('ExecutionStatus = "Running"');
    expect(q).to.include('AgentTempoAttachedHost = "host-1"');
    expect(q).to.include('AgentTempoAttachmentState IN ("attached","processing","awaiting","draining")');
    expect(q).to.include('AgentTempoAttachmentState = "detached"');
    expect(q).to.include('AgentTempoHostname = "host-1"');
  });

  it('sanitizes quote/backslash/newline chars out of the hostname', function () {
    const q = buildOrphanQuery({ hostname: 'host"with\nquotes' });
    expect(q).to.not.include('host"with');
    expect(q).to.not.include('\n');
    expect(q).to.include('hostwithquotes');
  });

  // #306: user-invoked `/restore` narrows the visibility query to
  // `detached`-only so a healthy live session is never flagged as an
  // orphan candidate.
  describe('phases filter', function () {
    it('with phases=["detached"] — emits only the detached clause, no live-phase IN clause', function () {
      const q = buildOrphanQuery({ hostname: 'host-1', phases: ['detached'] });
      expect(q).to.include('AgentTempoAttachmentState = "detached"');
      expect(q).to.include('AgentTempoHostname = "host-1"');
      // Live-phase clause must NOT appear — that's the whole point of the
      // narrowing (live sessions are not orphan candidates for user /restore).
      expect(q).to.not.include('AgentTempoAttachmentState IN (');
      expect(q).to.not.include('AgentTempoAttachedHost = "host-1"');
    });

    it('with phases unset — defaults to the broad live-phase + detached set (daemon reconcile semantics)', function () {
      const q = buildOrphanQuery({ hostname: 'host-1' });
      expect(q).to.include('AgentTempoAttachmentState IN ("attached","processing","awaiting","draining")');
      expect(q).to.include('AgentTempoAttachmentState = "detached"');
    });

    it('with phases=["attached"] — emits only the live-phase clause, no detached clause', function () {
      const q = buildOrphanQuery({ hostname: 'host-1', phases: ['attached'] });
      expect(q).to.include('AgentTempoAttachmentState IN ("attached")');
      expect(q).to.include('AgentTempoAttachedHost = "host-1"');
      // No `= "detached"` anywhere (the standalone detached clause is gone).
      expect(q).to.not.include('AgentTempoAttachmentState = "detached"');
    });

    it('with phases=[] — falls back to the broad default (safety net against empty array)', function () {
      const q = buildOrphanQuery({ hostname: 'host-1', phases: [] });
      expect(q).to.include('AgentTempoAttachmentState IN ("attached","processing","awaiting","draining")');
      expect(q).to.include('AgentTempoAttachmentState = "detached"');
    });

    it('opts-object form also accepts ensemble narrowing', function () {
      const q = buildOrphanQuery({
        hostname: 'host-1',
        ensemble: 'band-a',
        phases: ['detached'],
      });
      expect(q).to.include('AgentTempoAttachmentState = "detached"');
      expect(q).to.include('AgentTempoEnsemble = "band-a"');
      expect(q).to.not.include('AgentTempoAttachmentState IN (');
    });
  });

  // #151 — cluster-view: `allHosts: true` drops the per-host predicates so
  // the visibility query spans every host's orphans. Powers `agent-tempo
  // restore --all-hosts`.
  describe('allHosts axis (#151)', function () {
    it('with allHosts=true — emits state-only clauses, no hostname predicates', function () {
      const q = buildOrphanQuery({ hostname: 'host-1', allHosts: true });
      expect(q).to.include('WorkflowType = "agentSessionWorkflow"');
      expect(q).to.include('ExecutionStatus = "Running"');
      // Default phase set is preserved — every live phase + detached, but
      // each clause is a bare `AgentTempoAttachmentState ...` predicate
      // with no hostname AND.
      expect(q).to.include('AgentTempoAttachmentState IN ("attached","processing","awaiting","draining")');
      expect(q).to.include('AgentTempoAttachmentState = "detached"');
      // No hostname predicates anywhere in the query.
      expect(q).to.not.include('AgentTempoAttachedHost');
      expect(q).to.not.include('AgentTempoHostname');
    });

    it('with allHosts=true + phases=["detached"] — only the bare detached state clause', function () {
      const q = buildOrphanQuery({ hostname: 'host-1', allHosts: true, phases: ['detached'] });
      expect(q).to.include('AgentTempoAttachmentState = "detached"');
      expect(q).to.not.include('AgentTempoAttachmentState IN (');
      expect(q).to.not.include('AgentTempoAttachedHost');
      expect(q).to.not.include('AgentTempoHostname');
    });

    it('with allHosts=true + ensemble — keeps the ensemble clause', function () {
      const q = buildOrphanQuery({ hostname: 'host-1', allHosts: true, ensemble: 'band-a' });
      expect(q).to.include('AgentTempoEnsemble = "band-a"');
      expect(q).to.not.include('AgentTempoAttachedHost');
      expect(q).to.not.include('AgentTempoHostname');
    });

    it('with allHosts=false (or unset) — preserves the existing per-host predicate form', function () {
      const q = buildOrphanQuery({ hostname: 'host-1' });
      expect(q).to.include('AgentTempoAttachedHost = "host-1"');
      expect(q).to.include('AgentTempoHostname = "host-1"');
    });
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
            if (n === 'orphanSummary') return wf?.summary ?? { ensemble: '', playerId: '' };
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
          workflowId: 'agent-session-e1-alice',
          info: { phase: 'detached', inFlightCount: 0 },
          summary: { ensemble: 'e1', playerId: 'alice', detachedSince: '2026-04-01T00:00:00Z', preferredHost: 'host-1' },
        },
      ],
    });
    const orphans = await queryOrphanedSessions(client, { hostname: 'host-1' });
    expect(orphans).to.have.length(1);
    expect(orphans[0].workflowId).to.equal('agent-session-e1-alice');
    expect(orphans[0].info.phase).to.equal('detached');
    expect(orphans[0].summary.detachedSince).to.equal('2026-04-01T00:00:00Z');
    expect(orphans[0].summary.ensemble).to.equal('e1');
    expect(orphans[0].summary.playerId).to.equal('alice');
  });

  it('resolves dashed player names via OrphanSummary (regression: #143 regex dropped dashes)', async function () {
    // Workflow id is `agent-session-{ensemble}-{playerId}`. The legacy
    // regex `/^agent-session-.+-([^-]+)$/` greedily captured ensemble and
    // took the last dash-delimited segment as playerId — for a workflow
    // `agent-session-tempo-impl-tempo-eng` it produced
    //   ensemble = "tempo-impl-tempo", playerId = "eng"
    // instead of the canonical
    //   ensemble = "tempo-impl",       playerId = "tempo-eng"
    //
    // Post-#143: consumers read ensemble/playerId directly from
    // OrphanSummary (sourced from `input.metadata` in the workflow handler),
    // so dashed names round-trip correctly.
    const client = makeFakeClient({
      workflows: [
        {
          workflowId: 'agent-session-tempo-impl-tempo-eng',
          info: { phase: 'detached', inFlightCount: 0 },
          summary: { ensemble: 'tempo-impl', playerId: 'tempo-eng' },
        },
      ],
    });
    const orphans = await queryOrphanedSessions(client, { hostname: 'host-1' });
    expect(orphans).to.have.length(1);
    expect(orphans[0].summary.ensemble).to.equal('tempo-impl');
    expect(orphans[0].summary.playerId).to.equal('tempo-eng');
  });

  it('skips candidates whose adapter process the predicate reports alive', async function () {
    const client = makeFakeClient({
      workflows: [
        {
          workflowId: 'agent-session-e1-alive',
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
          workflowId: 'agent-session-e1-dead',
          info: { phase: 'detached', inFlightCount: 0 },
          summary: { ensemble: 'e1', playerId: 'dead' },
        },
      ],
    });
    const orphans = await queryOrphanedSessions(client, {
      hostname: 'host-1',
      isAdapterProcessAlive: (_host, workflowId) => workflowId === 'agent-session-e1-alive',
    });
    expect(orphans.map((o) => o.workflowId)).to.deep.equal(['agent-session-e1-dead']);
  });

  it('skips candidates whose query handler throws (workflow gone, race)', async function () {
    const client = makeFakeClient({
      workflows: [
        {
          workflowId: 'agent-session-e1-gone',
          info: { phase: 'gone', inFlightCount: 0 }, // unused
          queryError: new Error('WorkflowNotFound'),
        },
        {
          workflowId: 'agent-session-e1-ok',
          info: { phase: 'detached', inFlightCount: 0 },
          summary: { ensemble: 'e1', playerId: 'ok' },
        },
      ],
    });
    const orphans = await queryOrphanedSessions(client, { hostname: 'host-1' });
    expect(orphans.map((o) => o.workflowId)).to.deep.equal(['agent-session-e1-ok']);
  });

  it('returns empty array when workflow.list yields nothing', async function () {
    const client = makeFakeClient({ workflows: [] });
    const orphans = await queryOrphanedSessions(client, { hostname: 'host-1' });
    expect(orphans).to.deep.equal([]);
  });

  // ── Issue #433 — hung-query timeout ────────────────────────────────

  describe('hung-query timeout (#433)', function () {
    /** Fake client whose `query()` never resolves for the listed workflowIds. */
    function clientWithHangs(hangIds: Set<string>, healthy: Array<{
      workflowId: string;
      info: AttachmentInfo;
      summary?: OrphanSummary;
    }>): any {
      const byId: Record<string, typeof healthy[number]> = {};
      for (const w of healthy) byId[w.workflowId] = w;
      const allIds = [...hangIds, ...healthy.map((w) => w.workflowId)];
      return {
        workflow: {
          getHandle(workflowId: string) {
            return {
              workflowId,
              async query(name: unknown) {
                if (hangIds.has(workflowId)) {
                  return new Promise(() => {}); // never resolves
                }
                const wf = byId[workflowId];
                const n = typeof name === 'string' ? name : (name as any).name;
                if (n === 'attachmentInfo') return wf?.info;
                if (n === 'orphanSummary') return wf?.summary ?? { ensemble: '', playerId: '' };
                return undefined;
              },
            };
          },
          async *list() {
            for (const id of allIds) yield { workflowId: id };
          },
        },
      };
    }

    it('skips a hung-query candidate without blocking the rest of the scan', async function () {
      // Healthy fast wf + one whose attachmentInfoQuery hangs forever.
      // Without the timeout wrapper, `await handle.query(...)` for the
      // wedged workflow would hang the scan permanently.
      this.timeout(5_000);
      const client = clientWithHangs(
        new Set(['agent-session-e1-wedged']),
        [
          {
            workflowId: 'agent-session-e1-ok',
            info: { phase: 'detached', inFlightCount: 0 },
            summary: { ensemble: 'e1', playerId: 'ok' },
          },
        ],
      );
      const skipMessages: string[] = [];
      const start = Date.now();
      const orphans = await queryOrphanedSessions(
        client,
        { hostname: 'host-1' },
        (...args) => skipMessages.push(args.map(String).join(' ')),
      );
      const elapsed = Date.now() - start;

      // Healthy candidate still returned.
      expect(orphans.map((o) => o.workflowId)).to.deep.equal(['agent-session-e1-ok']);
      // Wedged candidate was skipped via the existing log path.
      expect(skipMessages.some((m) => m.includes('agent-session-e1-wedged'))).to.equal(true);
      // Bounded by DEFAULT_QUERY_TIMEOUT_MS (2000ms) — never the
      // pre-fix "hang forever".
      expect(elapsed).to.be.lessThan(3_500);
    });
  });
});
