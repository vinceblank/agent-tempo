/**
 * #596 / ADR 0016 — workflow-side coverage for bg-spawn integration:
 *
 *   1. Destroy on a session with `spawnMode: 'bg'` + `bgShortId` fires the
 *      `claudeStop` activity (mocked) and SKIPS `hardTerminateAttachment`
 *      when `claudeStop` reports `outcome: 'stopped'`.
 *   2. Destroy on a session with `bgShortId` falls back to
 *      `hardTerminateAttachment` when `claudeStop` returns
 *      `outcome: 'error'`.
 *   3. Destroy on a session WITHOUT `bgShortId` skips `claudeStop` entirely
 *      and runs only `hardTerminateAttachment` (existing behavior).
 *   4. `claude --bg --resume` is broken upstream, so `restart` with
 *      `transcript: 'replay'` on a `spawnMode: 'bg'` session must throw
 *      `BgSpawnReplayUnsupported` from `deliverRestart`. We test the
 *      ApplicationFailure shape directly via the activity rather than
 *      threading a full restart workflow round-trip.
 */
import { expect } from 'chai';
import { Worker } from '@temporalio/worker';
import { ApplicationFailure } from '@temporalio/common';
import {
  setupSharedEnv,
  teardownTestEnv,
  startSession,
  playerMetadata,
  destroyUpdate,
  attachmentInfoQuery,
  getClient,
  getNativeConnection,
  TASK_QUEUE,
  getWorkflowBundle,
} from './helpers';

describe('ADR 0016 — bg-spawn destroy + restart guard', function () {
  before(setupSharedEnv);
  after(async function () { await teardownTestEnv(); });

  // ── Destroy paths ────────────────────────────────────────────────────

  it('destroy on a bg-spawned session fires claudeStop and SKIPS hardTerminate when success', async function () {
    this.timeout(20_000);

    const claudeStopCalls: Array<{ shortId: string }> = [];
    const hardTerminateCalls: Array<unknown> = [];

    const mainWorker = await Worker.create({
      connection: getNativeConnection(),
      taskQueue: TASK_QUEUE,
      workflowBundle: getWorkflowBundle(),
      activities: {
        spawnProcess: async () => ({ success: true }),
      },
    });

    const hostWorker = await Worker.create({
      connection: getNativeConnection(),
      taskQueue: `agent-tempo-test-host`,
      activities: {
        spawnProcess: async () => ({ success: true }),
        hardTerminateAttachment: async (input: unknown) => {
          hardTerminateCalls.push(input);
          return { killedPids: [], strategy: 'none' as const, notes: ['stub'] };
        },
        claudeStop: async (input: { shortId: string }) => {
          claudeStopCalls.push({ shortId: input.shortId });
          return { success: true, outcome: 'stopped' as const, exitCode: 0 };
        },
      },
    });

    await mainWorker.runUntil(async () => {
      const hostRun = hostWorker.run();
      try {
        const ensemble = `bg-stop-${Date.now()}`;
        const fullUuid = '550e8400-e29b-41d4-a716-446655440000';
        const handle = await startSession({
          metadata: playerMetadata({
            playerId: 'bg-bob',
            ensemble,
            agentType: 'claude',
            spawnMode: 'bg',
            bgFullUuid: fullUuid,
            bgShortId: fullUuid.slice(0, 8),
          }),
        });
        await handle.executeUpdate(destroyUpdate, { args: [{ reason: 'test' }] });
        const info = await handle.query(attachmentInfoQuery);
        expect(info.phase).to.equal('gone');
        await handle.result();

        expect(claudeStopCalls).to.have.length(1, 'claudeStop must fire on bg-spawned destroy');
        expect(claudeStopCalls[0].shortId).to.equal('550e8400');
        expect(hardTerminateCalls).to.have.length(0, 'hardTerminate must be skipped when claudeStop succeeded');
      } finally {
        hostWorker.shutdown();
        await hostRun.catch(() => {});
      }
    });
  });

  it('destroy on a bg-spawned session falls back to hardTerminate when claudeStop errors', async function () {
    this.timeout(20_000);

    const claudeStopCalls: Array<{ shortId: string }> = [];
    const hardTerminateCalls: Array<unknown> = [];

    const mainWorker = await Worker.create({
      connection: getNativeConnection(),
      taskQueue: TASK_QUEUE,
      workflowBundle: getWorkflowBundle(),
      activities: {
        spawnProcess: async () => ({ success: true }),
      },
    });

    const hostWorker = await Worker.create({
      connection: getNativeConnection(),
      taskQueue: `agent-tempo-test-host`,
      activities: {
        spawnProcess: async () => ({ success: true }),
        hardTerminateAttachment: async (input: unknown) => {
          hardTerminateCalls.push(input);
          return { killedPids: [], strategy: 'none' as const, notes: ['stub'] };
        },
        claudeStop: async (input: { shortId: string }) => {
          claudeStopCalls.push({ shortId: input.shortId });
          return {
            success: false,
            outcome: 'error' as const,
            detail: 'simulated supervisor failure',
            exitCode: 2,
          };
        },
      },
    });

    await mainWorker.runUntil(async () => {
      const hostRun = hostWorker.run();
      try {
        const ensemble = `bg-fallback-${Date.now()}`;
        const handle = await startSession({
          metadata: playerMetadata({
            playerId: 'bg-frank',
            ensemble,
            agentType: 'claude',
            spawnMode: 'bg',
            bgFullUuid: 'cafef00d-1234-5678-9abc-def012345678',
            bgShortId: 'cafef00d',
          }),
        });
        await handle.executeUpdate(destroyUpdate, { args: [{ reason: 'test' }] });
        await handle.result();

        expect(claudeStopCalls).to.have.length(1);
        expect(hardTerminateCalls).to.have.length(1, 'hardTerminate must be invoked when claudeStop errored');
      } finally {
        hostWorker.shutdown();
        await hostRun.catch(() => {});
      }
    });
  });

  it('destroy on a non-bg session skips claudeStop and runs hardTerminate only', async function () {
    this.timeout(20_000);

    const claudeStopCalls: Array<unknown> = [];
    const hardTerminateCalls: Array<unknown> = [];

    const mainWorker = await Worker.create({
      connection: getNativeConnection(),
      taskQueue: TASK_QUEUE,
      workflowBundle: getWorkflowBundle(),
      activities: {
        spawnProcess: async () => ({ success: true }),
      },
    });

    const hostWorker = await Worker.create({
      connection: getNativeConnection(),
      taskQueue: `agent-tempo-test-host`,
      activities: {
        spawnProcess: async () => ({ success: true }),
        hardTerminateAttachment: async (input: unknown) => {
          hardTerminateCalls.push(input);
          return { killedPids: [], strategy: 'none' as const, notes: ['stub'] };
        },
        claudeStop: async (input: unknown) => {
          claudeStopCalls.push(input);
          return { success: true, outcome: 'stopped' as const };
        },
      },
    });

    await mainWorker.runUntil(async () => {
      const hostRun = hostWorker.run();
      try {
        const ensemble = `bg-terminal-${Date.now()}`;
        const handle = await startSession({
          metadata: playerMetadata({
            playerId: 'terminal-tina',
            ensemble,
            agentType: 'claude',
            // no spawnMode + no bgShortId → terminal path
          }),
        });
        await handle.executeUpdate(destroyUpdate, { args: [{ reason: 'test' }] });
        await handle.result();

        expect(claudeStopCalls).to.have.length(0, 'claudeStop must not fire on terminal-spawned destroy');
        expect(hardTerminateCalls).to.have.length(1);
      } finally {
        hostWorker.shutdown();
        await hostRun.catch(() => {});
      }
    });
  });

  // ── Restart-replay guard ─────────────────────────────────────────────

  it('deliverRestart rejects spawn:bg + transcript:replay with BgSpawnReplayUnsupported', async function () {
    this.timeout(20_000);

    // Build a session with spawnMode='bg' on durable metadata. Use the
    // same worker scaffolding as destroy tests so the workflow is real.
    const mainWorker = await Worker.create({
      connection: getNativeConnection(),
      taskQueue: TASK_QUEUE,
      workflowBundle: getWorkflowBundle(),
      activities: {
        spawnProcess: async () => ({ success: true }),
      },
    });

    await mainWorker.runUntil(async () => {
      const ensemble = `bg-guard-${Date.now()}`;
      const playerId = 'guard-grace';
      await startSession({
        metadata: playerMetadata({
          playerId,
          ensemble,
          agentType: 'claude',
          spawnMode: 'bg',
          bgFullUuid: 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee',
          bgShortId: 'aaaaaaaa',
        }),
      });

      // Invoke deliverRestart directly via the activity factory — same
      // request shape `restart` tool builds. ApplicationFailure should
      // surface with type 'BgSpawnReplayUnsupported'.
      const { createOutboxActivities } = await import('../src/activities/outbox');
      const acts = createOutboxActivities(getClient(), {
        temporalAddress: '',
        temporalNamespace: 'default',
        taskQueue: TASK_QUEUE,
        ensemble,
        defaultAgent: 'claude',
      });

      let caught: unknown;
      try {
        await acts.deliverRestart({
          ensemble,
          targetPlayerId: playerId,
          invokerPlayerId: 'tester',
          transcript: 'replay',
        });
      } catch (err) {
        caught = err;
      }
      expect(caught, 'deliverRestart should throw for bg + replay').to.be.instanceOf(ApplicationFailure);
      const af = caught as ApplicationFailure;
      expect(af.type).to.equal('BgSpawnReplayUnsupported');
      expect(af.nonRetryable).to.equal(true);
      expect(String(af.message)).to.match(/upstream CLI limitation/i);
    });
  });
});
