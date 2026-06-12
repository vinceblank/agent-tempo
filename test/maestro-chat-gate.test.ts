/**
 * T0.6 (#760) — presence-gate `fetchEnsembleChat` on `v2.observersPresent`.
 *
 * The post-T0.1 meter (window B) showed the chat fetch running on every
 * maestro tick regardless of subscribers — the largest line in the
 * unwatched regime. These tests drive the REAL maestro workflow with
 * counting activity stubs and assert:
 *
 *   1. cloud + zero observers → the chat fetch is SKIPPED (while the V2
 *      refresh keeps ticking);
 *   2. observers appear → the chat fetch resumes on the next tick (the
 *      durable high-water marks make the catch-up fetch complete);
 *   3. local profile → byte-identical: V1 refresh + chat fetch every tick,
 *      presence never consulted.
 *
 * Determinism note encoded here for reviewers: the gate sits behind
 * `patched('v1.8-t06-chat-gate')` — post-#759 cloud maestros RECORDED chat
 * activities on unwatched ticks, so an ungated skip would mismatch their
 * replay (input-driven gating only protects pre-#748 runs).
 */
import { expect } from 'chai';
import {
  setupTestEnv,
  teardownTestEnv,
  getClient,
  getTestEnsemble,
  getNativeConnection,
  pollWithTimeout,
  TASK_QUEUE,
  createWorkerWithSlotRetry,
  getWorkflowBundle,
  runWorkerUntil,
} from './helpers';
import { maestroShutdownSignal } from '../src/workflows/maestro-signals';
import type { WorkflowHandle } from '@temporalio/client';

const FAST_POLL_MS = 300;
let testCounter = 0;

interface Counters {
  v1: number;
  v2: number;
  chat: number;
  observersPresent: boolean;
}

async function withChatGateWorker<T>(
  counters: Counters,
  fn: () => Promise<T>,
): Promise<T> {
  const worker = await createWorkerWithSlotRetry({
    connection: getNativeConnection(),
    taskQueue: TASK_QUEUE,
    workflowBundle: getWorkflowBundle(),
    activities: {
      refreshEnsembleState: async () => { counters.v1++; return []; },
      refreshEnsembleStateV2: async () => {
        counters.v2++;
        return { players: [], observersPresent: counters.observersPresent };
      },
      fetchEnsembleChat: async () => {
        counters.chat++;
        return {
          success: true,
          newMessages: [],
          currentCounts: { maestroRecv: 0, maestroSent: 0, conductorRecv: 0, conductorSent: 0 },
          hasConductor: false,
        };
      },
      relayCommandToConductor: async () => ({ success: true }),
      fetchConductorHistory: async () => ({ success: true, history: [] }),
      discoverEnsembles: async () => [],
      deliverMaestroMessage: async () => ({ success: true }),
      fetchPlayerMessages: async () => ({ success: true, messages: [] }),
    },
  });
  return runWorkerUntil(worker, fn);
}

async function startMaestro(costProfile?: 'cloud'): Promise<WorkflowHandle> {
  const client = getClient();
  const ensemble = getTestEnsemble();
  return client.workflow.start('agentMaestroWorkflow', {
    workflowId: `agent-maestro-chatgate-${ensemble}-${++testCounter}`,
    taskQueue: TASK_QUEUE,
    args: [{
      ensemble,
      pollIntervalMs: FAST_POLL_MS,
      ...(costProfile ? { costProfile } : {}),
    }],
  });
}

async function shutdown(handle: WorkflowHandle): Promise<void> {
  try {
    await handle.signal(maestroShutdownSignal);
    await handle.result();
  } catch { /* already gone */ }
}

describe('T0.6 maestro chat gate (#760)', function () {
  before(async function () {
    this.timeout(120_000);
    await setupTestEnv();
  });
  after(async function () {
    await teardownTestEnv();
  });

  it('cloud + zero observers: V2 keeps ticking, chat fetch is SKIPPED; observers appearing resumes it', async function () {
    this.timeout(60_000);
    const counters: Counters = { v1: 0, v2: 0, chat: 0, observersPresent: false };
    await withChatGateWorker(counters, async () => {
      const handle = await startMaestro('cloud');
      try {
        // Unwatched phase: at least 3 refresh ticks, zero chat fetches.
        await pollWithTimeout(() => counters.v2 >= 3, 20_000, 100);
        expect(counters.chat, 'chat fetches while unwatched').to.equal(0);
        expect(counters.v1, 'V1 must not run under cloud input').to.equal(0);

        // A board connects: the next recorded V2 result flips presence —
        // the chat fetch resumes the same tick.
        counters.observersPresent = true;
        await pollWithTimeout(() => counters.chat >= 2, 20_000, 100);

        // And disconnecting gates it again (allowing the in-flight tick).
        counters.observersPresent = false;
        const chatAtDisconnect = counters.chat;
        const v2AtDisconnect = counters.v2;
        await pollWithTimeout(() => counters.v2 >= v2AtDisconnect + 3, 20_000, 100);
        expect(counters.chat, 'chat fetches after observers left').to.be.at.most(chatAtDisconnect + 1);
      } finally {
        await shutdown(handle);
      }
    });
  });

  it('LOCAL profile byte-identity: V1 refresh + chat fetch every tick, presence never consulted', async function () {
    this.timeout(60_000);
    const counters: Counters = { v1: 0, v2: 0, chat: 0, observersPresent: false };
    await withChatGateWorker(counters, async () => {
      const handle = await startMaestro(/* no costProfile */);
      try {
        await pollWithTimeout(() => counters.v1 >= 3, 20_000, 100);
        // Chat ran alongside every completed tick (allow the off-by-one of
        // an in-flight tick) DESPITE observersPresent=false — local ignores it.
        expect(counters.chat, 'local chat fetches').to.be.at.least(counters.v1 - 1);
        expect(counters.v2, 'V2 must not run under local input').to.equal(0);
      } finally {
        await shutdown(handle);
      }
    });
  });
});
