/**
 * #786 — unit tests for the 2.0 cutover BOOT GUARD (`checkProtocolGuard`).
 *
 * Pure: no Temporal test environment. The guard's only external dependency is
 * the visibility iterable, which we inject via `deps.listWorkflows` with crafted
 * `WorkflowExecutionInfo`-shaped rows (only `workflowId` / `type` / `memo` are
 * read). The fail-closed timeout path is driven by an injected `now` clock.
 */
import { expect } from 'chai';
import {
  checkProtocolGuard,
  buildProtocolGuardQuery,
  AGENT_TEMPO_WORKFLOW_TYPES,
} from '../src/upgrade/boot-guard';
import { MEMO_KEYS } from '../src/utils/search-attributes';
import { PROTOCOL_VERSION } from '../src/constants';

/** Build a fake visibility row. `protocol === undefined` ⇒ an un-stamped 1.x run. */
function row(workflowId: string, type: string, protocol?: number) {
  return {
    workflowId,
    type,
    memo: protocol === undefined ? {} : { [MEMO_KEYS.protocol]: protocol },
  };
}

/** A `listWorkflows` dep that yields the given rows. */
function listOf(rows: ReturnType<typeof row>[]) {
  return () =>
    (async function* () {
      for (const r of rows) yield r as never;
    })();
}

// The guard never touches a real client when `listWorkflows` is injected.
const NO_CLIENT = {} as never;

describe('#786 protocol boot guard', () => {
  it('boots clean when every Running workflow is protocol-2 stamped', async () => {
    const res = await checkProtocolGuard(NO_CLIENT, {
      listWorkflows: listOf([
        row('agent-session-team-alice', 'agentSessionWorkflow', PROTOCOL_VERSION),
        row('agent-maestro-team', 'agentMaestroWorkflow', PROTOCOL_VERSION),
        row('agent-maestro-global', 'agentGlobalMaestroWorkflow', PROTOCOL_VERSION),
      ]),
    });
    expect(res.ok).to.equal(true);
    expect(res.scanned).to.equal(3);
    expect(res.offenders).to.be.empty;
  });

  it('boots clean when there are no agent-tempo workflows at all', async () => {
    const res = await checkProtocolGuard(NO_CLIENT, { listWorkflows: listOf([]) });
    expect(res.ok).to.equal(true);
    expect(res.scanned).to.equal(0);
  });

  it('REFUSES when any Running workflow is un-stamped (1.x)', async () => {
    const res = await checkProtocolGuard(NO_CLIENT, {
      listWorkflows: listOf([
        row('agent-session-team-alice', 'agentSessionWorkflow', PROTOCOL_VERSION),
        row('agent-session-team-bob', 'agentSessionWorkflow', undefined), // 1.x — no stamp
      ]),
    });
    expect(res.ok).to.equal(false);
    expect(res.reason).to.equal('unstamped');
    expect(res.offenders).to.have.lengthOf(1);
    expect(res.offenders[0].workflowId).to.equal('agent-session-team-bob');
    expect(res.offenders[0].protocol).to.equal(undefined);
    expect(res.message).to.contain('upgrade-to-2');
  });

  it('REFUSES on a wrong (non-2) stamp value', async () => {
    const res = await checkProtocolGuard(NO_CLIENT, {
      listWorkflows: listOf([row('agent-scheduler-team', 'agentSchedulerWorkflow', 99)]),
    });
    expect(res.ok).to.equal(false);
    expect(res.reason).to.equal('unstamped');
    expect(res.offenders[0].protocol).to.equal(99);
  });

  it('FAILS CLOSED on a scan timeout (partial scan must never read as clean)', async () => {
    // Injected clock: first call sets the deadline (t=1000, deadline=1100);
    // the check before the 1st yield (t=1050) passes → 1 row scanned; the check
    // before the 2nd yield (t=1200 > 1100) trips the deadline.
    const ticks = [1000, 1050, 1200];
    let i = 0;
    const now = () => ticks[Math.min(i++, ticks.length - 1)];
    const res = await checkProtocolGuard(NO_CLIENT, {
      deadlineMs: 100,
      now,
      listWorkflows: listOf([
        row('agent-session-team-a', 'agentSessionWorkflow', PROTOCOL_VERSION),
        row('agent-session-team-b', 'agentSessionWorkflow', PROTOCOL_VERSION),
      ]),
    });
    expect(res.ok).to.equal(false);
    expect(res.reason).to.equal('scan-incomplete');
    expect(res.scanned).to.equal(1);
    expect(res.message).to.match(/could NOT verify|fail-closed/i);
  });

  it('FAILS CLOSED when the visibility scan throws', async () => {
    const res = await checkProtocolGuard(NO_CLIENT, {
      listWorkflows: () =>
        (async function* () {
          throw new Error('visibility backend unreachable');
          // eslint-disable-next-line no-unreachable
          yield undefined as never;
        })(),
    });
    expect(res.ok).to.equal(false);
    expect(res.reason).to.equal('scan-incomplete');
  });

  it('query targets all four agent-tempo workflow types, Running only', () => {
    const q = buildProtocolGuardQuery();
    for (const t of AGENT_TEMPO_WORKFLOW_TYPES) expect(q).to.contain(`"${t}"`);
    expect(q).to.contain('ExecutionStatus = "Running"');
  });
});
