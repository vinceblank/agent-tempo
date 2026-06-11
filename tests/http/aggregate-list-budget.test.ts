/**
 * Aggregate per-tick visibility-list BUDGET + demand gate (#763 / #751).
 *
 * The #763 incident surfaced a test gap: nothing asserted how many
 * `client.workflow.list()` scans one aggregate tick performs, under either
 * cost profile. This file pins the budget so any change to per-tick scan
 * counts is a conscious, reviewed diff instead of a meter surprise.
 *
 * Budget per COMPLETED tick, ONE ensemble:
 *
 * | op                                   | local | cloud (#751) |
 * |--------------------------------------|-------|--------------|
 * | `listEnsemblesBounded` prelude       |   1   |      1       |
 * | snapshot `listEnsembles` exist gate  |   1   |  0 (prelude reused) |
 * | `isAnySessionHeld` scan              |   1 (cluster-wide) | 1 (ensemble-scoped) |
 * | confirm-on-change                    |   0   |      0       |
 * | **total**                            | **3** |    **2**     |
 *
 * Drives the REAL `createTempoClientCore` + `AggregateRunner` over a fake
 * raw Temporal Client that records every `workflow.list` query string and
 * answers every workflow query with healthy fixtures (so no soft-fail path
 * masks a scan).
 *
 * Also covers the #751 demand gate: cloud + zero SSE subscribers → the
 * next tick is scheduled at the idle reconcile interval; `wake()` cancels
 * the stretched timer and ticks immediately.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { Client } from '@temporalio/client';
import { createTempoClientCore } from '../../src/client/core';
import {
  AggregateRunner,
  AGGREGATE_IDLE_POLL_INTERVAL_MS,
  DEFAULT_POLL_INTERVAL_MS,
} from '../../src/http/aggregate';
import type { TempoClient } from '../../src/client/interface';
import { __resetInflightQueriesForTests } from '../../src/utils/query-timeout';

const ENSEMBLE = 'demo';
const ISO = new Date(0).toISOString();

const sessionWf = {
  workflowId: `agent-session-${ENSEMBLE}-alice`,
  searchAttributes: {
    AgentTempoEnsemble: [ENSEMBLE],
    AgentTempoPlayerId: ['alice'],
    AgentTempoHostname: ['h1'],
    AgentTempoAttachmentState: ['attached'],
    AgentTempoAttachedHost: ['h1'],
  },
  memo: {
    AgentTempoIsConductor: false,
    AgentTempoPart: 'doing things',
    AgentTempoWorkDir: '/repo',
    AgentTempoAgentType: 'claude',
  },
};

const maestroPlayer = {
  playerId: 'alice', ensemble: ENSEMBLE, part: 'doing things', hostname: 'h1',
  workDir: '/repo', isConductor: false, agentType: 'claude', phase: 'attached',
};

/** Fake raw Client: records list() query strings; answers queries with fixtures. */
function makeFakeRawClient() {
  const listQueries: string[] = [];
  const queryByName: Record<string, unknown> = {
    maestroPlayersByEnsemble: { [ENSEMBLE]: [maestroPlayer] },
    maestroPlayers: [maestroPlayer],
    maestroPaused: false,
    maestroEnsembleChat: { messages: [], total: 0, hasMore: false, hasConductor: true },
    getSchedules: [],
    getMetadata: {
      playerId: 'alice', ensemble: ENSEMBLE, hostname: 'h1', workDir: '/repo',
      isConductor: false, agentType: 'claude',
    },
    getPart: 'doing things',
    getActivityState: { activityCount: 0, lastActivityAt: ISO },
    outboxLocked: false,
    getEnsembleDescription: '',
    getEnsembleStartTime: ISO,
    getCurrentBpm: 0,
    getTempoSeries: [],
    getRunId: 'run-1',
    getMessagingState: { received: 0, sent: 0, outbox: 'empty' },
    getLeaseState: { expiresAt: null, leaseMs: null },
    getCoarseActivity: { currentTool: null },
    maestroGetAnswer: null,
    hostProfilesWithExistence: { exists: false, profiles: {} },
  };
  const fake = {
    options: { namespace: 'default' },
    workflow: {
      list: (opts?: { query?: string }) => {
        listQueries.push(opts?.query ?? '');
        return (async function* () { yield sessionWf; })();
      },
      getHandle: (workflowId: string) => ({
        workflowId,
        query: async (def: unknown) => {
          const name = typeof def === 'string' ? def : (def as { name?: string })?.name;
          if (name && name in queryByName) return queryByName[name];
          throw new Error(`fake client: unstubbed query "${String(name)}"`);
        },
      }),
    },
  };
  return {
    client: fake as unknown as Client,
    listQueries,
    resetListQueries: () => { listQueries.length = 0; },
  };
}

function makeRunner(
  fakeClient: Client,
  costProfile: 'local' | 'cloud',
  extra: { idlePollIntervalMs?: number } = {},
) {
  return new AggregateRunner({
    client: createTempoClientCore(fakeClient, { taskQueue: 'tq', costProfile }),
    bootEpoch: 1,
    costProfile,
    // Confirmer armed so the cloud confirm-on-change path is live —
    // proving it contributes zero lists.
    confirmPhase: async () => null,
    ...extra,
  });
}

beforeEach(() => __resetInflightQueriesForTests());

describe('aggregate per-tick visibility-list budget (#763)', () => {
  it('LOCAL profile: one completed tick = exactly 3 lists (pre-#751 budget, byte-identical)', async () => {
    const fake = makeFakeRawClient();
    const runner = makeRunner(fake.client, 'local');
    await runner.tick();
    expect(fake.listQueries, 'list query strings in one local tick').toHaveLength(3);
    runner.close();
  });

  it('CLOUD profile (#751): one completed tick = exactly 2 lists — prelude + scoped held scan', async () => {
    const fake = makeFakeRawClient();
    const runner = makeRunner(fake.client, 'cloud');
    await runner.tick();

    expect(fake.listQueries, 'list query strings in one cloud tick').toHaveLength(2);
    // 1) the prelude's session enumeration (cluster-wide, bounded);
    // 2) isAnySessionHeld's ENSEMBLE-SCOPED scan — never cluster-wide.
    const heldScan = fake.listQueries.find((q) => q.includes('AgentTempoEnsemble'));
    expect(heldScan, 'held scan must be ensemble-scoped').toContain(
      `AgentTempoEnsemble = "${ENSEMBLE}"`,
    );

    // Steady state costs the same — no per-tick growth, and the armed
    // confirm-on-change path adds no lists with a populated track.
    fake.resetListQueries();
    __resetInflightQueriesForTests();
    await runner.tick();
    expect(fake.listQueries, 'lists in a steady-state cloud tick').toHaveLength(2);
    runner.close();
  });
});

describe('aggregate demand gate (#751)', () => {
  it('nextDelayMs: cloud + zero subscribers → idle interval; any subscriber → full cadence', () => {
    const fake = makeFakeRawClient();
    const runner = makeRunner(fake.client, 'cloud');
    const subs = vi.spyOn(runner, 'totalSubscriberCount');

    subs.mockReturnValue(0);
    expect(runner.nextDelayMs()).toBe(AGGREGATE_IDLE_POLL_INTERVAL_MS);
    subs.mockReturnValue(1);
    expect(runner.nextDelayMs()).toBe(DEFAULT_POLL_INTERVAL_MS);
    runner.close();
  });

  it('nextDelayMs: LOCAL profile never stretches, even with zero subscribers', () => {
    const fake = makeFakeRawClient();
    const runner = makeRunner(fake.client, 'local');
    vi.spyOn(runner, 'totalSubscriberCount').mockReturnValue(0);
    expect(runner.nextDelayMs()).toBe(DEFAULT_POLL_INTERVAL_MS);
    runner.close();
  });

  it('wake(): cancels an idle-stretched timer and ticks immediately', async () => {
    vi.useFakeTimers();
    try {
      const fake = makeFakeRawClient();
      const runner = makeRunner(fake.client, 'cloud', { idlePollIntervalMs: 60_000 });
      const subs = vi.spyOn(runner, 'totalSubscriberCount').mockReturnValue(0);

      runner.start(); // immediate first tick, then schedules at the IDLE interval
      await vi.advanceTimersByTimeAsync(0); // let the first tick's promises settle
      const listsAfterFirstTick = fake.listQueries.length;
      expect(listsAfterFirstTick).toBeGreaterThan(0);

      // 5s pass — far short of the 60s idle interval: no second tick.
      await vi.advanceTimersByTimeAsync(5_000);
      expect(fake.listQueries.length).toBe(listsAfterFirstTick);

      // A board connects: wake() must tick NOW, not at the 60s boundary.
      subs.mockReturnValue(1);
      runner.wake();
      await vi.advanceTimersByTimeAsync(0);
      expect(fake.listQueries.length).toBeGreaterThan(listsAfterFirstTick);

      runner.close();
    } finally {
      vi.useRealTimers();
    }
  });

  it('wake() boosts the NEXT link to full cadence even when the subscriber registers after wake (missed-wake wrinkle)', async () => {
    vi.useFakeTimers();
    try {
      const fake = makeFakeRawClient();
      const runner = makeRunner(fake.client, 'cloud', { idlePollIntervalMs: 60_000 });
      // Worst case: subscriberCount is STILL 0 when the wake-triggered link
      // reschedules — wake() runs before handleSseRequest registers the
      // subscriber. Without the one-shot boost, the chain would re-idle
      // for a full 60s after the wake-tick.
      const subs = vi.spyOn(runner, 'totalSubscriberCount').mockReturnValue(0);

      runner.start();
      await vi.advanceTimersByTimeAsync(0);
      await vi.advanceTimersByTimeAsync(5_000);
      runner.wake(); // immediate tick; reschedule consumes the boost (750ms)
      await vi.advanceTimersByTimeAsync(0);
      const afterWakeTick = fake.listQueries.length;

      // Subscriber registration lands AFTER the boosted link was scheduled.
      subs.mockReturnValue(1);

      // The tick AFTER the wake-tick must arrive at full cadence (750ms),
      // not at the 60s idle boundary.
      await vi.advanceTimersByTimeAsync(DEFAULT_POLL_INTERVAL_MS + 10);
      expect(fake.listQueries.length, 'tick after wake-tick at full cadence').toBeGreaterThan(afterWakeTick);
      runner.close();
    } finally {
      vi.useRealTimers();
    }
  });

  it('wake() is a no-op at full cadence (subscriber already present)', async () => {
    vi.useFakeTimers();
    try {
      const fake = makeFakeRawClient();
      const runner = makeRunner(fake.client, 'cloud');
      vi.spyOn(runner, 'totalSubscriberCount').mockReturnValue(1);

      runner.start();
      await vi.advanceTimersByTimeAsync(0);
      const after = fake.listQueries.length;
      runner.wake(); // full cadence — must not double-tick
      await vi.advanceTimersByTimeAsync(0);
      expect(fake.listQueries.length).toBe(after);
      runner.close();
    } finally {
      vi.useRealTimers();
    }
  });
});
