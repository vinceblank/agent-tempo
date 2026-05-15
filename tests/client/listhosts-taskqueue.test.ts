/**
 * Regression test for #437 — `TempoClient.listHosts()` must thread the
 * construction-time `taskQueue` through to the underlying `listHosts`
 * helper in `src/utils/hosts.ts`.
 *
 * The bug: `listHosts` defaults `taskQueue ?? 'agent-tempo'`, so when
 * the dev daemon polls `'agent-tempo-dev'`, the TempoClient API silently
 * returned `[]` because it queried the wrong queue's pollers in the
 * `agent-tempo-dev` namespace. Both `namespace` AND `taskQueue` must
 * match the daemon's config for poller discovery to land on the right
 * queue. Dashboard, snapshot.hostProfiles, AggregateRunner, and the TUI
 * `/hosts` slash command all flow through this path.
 *
 * The fix adds `taskQueue?: string` to `CreateTempoClientOpts` and
 * threads it from the daemon (`config.taskQueue`) → TempoClient →
 * `listHosts`. This test pins that contract by recording every
 * `describeTaskQueue` call the helper makes and asserting the queue name
 * matches the construction-time value.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { createTempoClient } from '../../src/client';
import { __resetHostsCacheForTests } from '../../src/utils/hosts';

interface DescribeCall {
  namespace: string;
  taskQueue: string;
  taskQueueType: number;
}

/** Build a fake Temporal Client that records `describeTaskQueue` invocations. */
function makeFakeClient(namespace: string, calls: DescribeCall[]): any {
  return {
    options: { namespace },
    workflowService: {
      describeTaskQueue: async (req: {
        namespace: string;
        taskQueue: { name: string };
        taskQueueType: number;
      }) => {
        calls.push({
          namespace: req.namespace,
          taskQueue: req.taskQueue.name,
          taskQueueType: req.taskQueueType,
        });
        // No pollers — listHosts will short-circuit to []. We only care
        // about WHICH queue it asked about, not what it did with the
        // response.
        return { pollers: [] };
      },
    },
    workflow: {
      // The fetchProfiles path also calls workflow.getHandle on the
      // global maestro. Return a handle whose query throws so listHosts
      // treats profiles as missing — this test isn't about profile
      // fetching, only about which queue is probed.
      getHandle() {
        return {
          async query() { throw new Error('not under test'); },
        };
      },
    },
  };
}

describe('TempoClient.listHosts — taskQueue plumbing (#437)', () => {
  beforeEach(() => {
    // The 3-second cache would mask cross-test interference. Reset it
    // before each case so every assertion sees a fresh fanout.
    __resetHostsCacheForTests();
  });

  it('uses the construction-time taskQueue when provided', async () => {
    const calls: DescribeCall[] = [];
    const fake = makeFakeClient('agent-tempo-dev', calls);
    const tempo = createTempoClient(fake, { taskQueue: 'agent-tempo-dev' });

    await tempo.listHosts({ force: true });

    // listHosts probes the shared queue twice (workflow + activity types).
    // Both must hit the dev queue, in the dev namespace.
    expect(calls.length).toBeGreaterThanOrEqual(2);
    for (const c of calls) {
      expect(c.namespace).toBe('agent-tempo-dev');
      expect(c.taskQueue).toBe('agent-tempo-dev');
    }
  });

  it('defaults to "agent-tempo" when no taskQueue is passed (prod path)', async () => {
    const calls: DescribeCall[] = [];
    const fake = makeFakeClient('default', calls);
    const tempo = createTempoClient(fake); // no taskQueue → utils/hosts default

    await tempo.listHosts({ force: true });

    expect(calls.length).toBeGreaterThanOrEqual(2);
    for (const c of calls) {
      expect(c.taskQueue).toBe('agent-tempo');
    }
  });

  it('threads a custom taskQueue through (e.g. AGENT_TEMPO_TASK_QUEUE override)', async () => {
    const calls: DescribeCall[] = [];
    const fake = makeFakeClient('default', calls);
    const tempo = createTempoClient(fake, { taskQueue: 'my-custom-queue' });

    await tempo.listHosts({ force: true });

    expect(calls.length).toBeGreaterThanOrEqual(2);
    for (const c of calls) {
      expect(c.taskQueue).toBe('my-custom-queue');
    }
  });
});
