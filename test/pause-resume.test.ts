import { expect } from 'chai';
import {
  setupTestEnv,
  setupSharedEnv,
  teardownTestEnv,
  withWorkerAndOutboxActivities,
  withWorker,
  startSession,
  playerMetadata,
  submitOutboxUpdate,
  outboxQuery,
  updateMetadataSignal,
  destroyUpdate,
  getClient,
  TASK_QUEUE,
  pollWithTimeout,
  holdAssertion,
} from './helpers';
import { setPausedSignal, pausedQuery, outboxLockedQuery } from '../src/workflows/signals';

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

describe('pause and resume', function () {
  before(setupSharedEnv);

  after(async function () {
    await teardownTestEnv();
  });

  describe('session pause behavior', function () {
    it('pause blocks outbox dispatch', async function () {
      this.timeout(45_000);
      await withWorkerAndOutboxActivities(async () => {
        const ensemble = `pause-block-${Date.now()}`;

        const handle = await startSession({
          metadata: playerMetadata({ playerId: 'paused-player', ensemble }),
        });

        // Pause the session — poll until the workflow flips its paused flag
        // rather than racing the next signal-task on a single immediate query
        // (issue #383 P2 — researcher's audit point #4).
        await handle.signal(setPausedSignal, true);
        await pollWithTimeout(async () => (await handle.query(pausedQuery)) === true, 5000);

        // Submit a cue — should buffer, not dispatch
        await handle.executeUpdate(submitOutboxUpdate, {
          args: [{ type: 'cue', targetPlayerId: 'nobody', message: 'paused msg' }],
        });

        // Hold-assert that the entry stays `pending` for the full 800ms
        // window — proves dispatch is actually paused. Pre-#383 used
        // `await sleep(1500); expect(status).to.equal('pending')` which on a
        // contended runner could miss a leak that flipped status mid-sleep.
        await holdAssertion(async () => {
          const entries = await handle.query(outboxQuery);
          const entry = entries.find((e) => e.type === 'cue' && (e as any).message === 'paused msg');
          return entry?.status === 'pending';
        }, 800);

        const entries = await handle.query(outboxQuery);
        const entry = entries.find((e) => e.type === 'cue' && (e as any).message === 'paused msg');
        expect(entry).to.exist;
        expect(entry!.status).to.equal('pending');

        // Cleanup
        await handle.executeUpdate(destroyUpdate, { args: [{}] });
        await handle.result();
      });
    });

    it('resume unblocks dispatch and flushes buffered entries', async function () {
      this.timeout(45_000);
      await withWorkerAndOutboxActivities(async () => {
        const ensemble = `resume-flush-${Date.now()}`;

        const handle = await startSession({
          metadata: playerMetadata({ playerId: 'resume-player', ensemble }),
        });

        // Pause + wait for flag flip (#383 P2)
        await handle.signal(setPausedSignal, true);
        await pollWithTimeout(async () => (await handle.query(pausedQuery)) === true, 5000);

        // Submit entry while paused
        await handle.executeUpdate(submitOutboxUpdate, {
          args: [{ type: 'cue', targetPlayerId: 'nobody', message: 'buffered' }],
        });

        // Hold-assert: entry stays pending for the 800ms window — replaces
        // `await sleep(1000)` + single-shot status check.
        await holdAssertion(async () => {
          const entries = await handle.query(outboxQuery);
          return entries[0]?.status === 'pending';
        }, 800);

        // Resume
        await handle.signal(setPausedSignal, false);

        // Poll for the entry's status to flip away from pending. Replaces
        // `await sleep(2000)` — bounded wait that exits on first success.
        // 5s budget covers Windows-shard worst-case scheduler latency.
        await pollWithTimeout(async () => {
          const entries = await handle.query(outboxQuery);
          const entry = entries.find((e) => e.type === 'cue');
          return entry !== undefined && entry.status !== 'pending';
        }, 5000);

        const entries = await handle.query(outboxQuery);
        const entry = entries.find((e) => e.type === 'cue');
        expect(entry).to.exist;
        expect(entry!.status).to.not.equal('pending');

        // Cleanup
        await handle.executeUpdate(destroyUpdate, { args: [{}] });
        await handle.result();
      });
    });

    it('stop entries bypass pause', async function () {
      this.timeout(45_000);
      await withWorkerAndOutboxActivities(async () => {
        const ensemble = `stop-bypass-${Date.now()}`;

        // Create a target session to stop
        const targetHandle = await startSession({
          metadata: playerMetadata({ playerId: 'stop-target', ensemble }),
        });

        const handle = await startSession({
          metadata: playerMetadata({ playerId: 'stopper', ensemble }),
        });

        // Pause the stopper + wait for flag flip (#383 P2)
        await handle.signal(setPausedSignal, true);
        await pollWithTimeout(async () => (await handle.query(pausedQuery)) === true, 5000);

        // Submit a stop — should bypass pause
        await handle.executeUpdate(submitOutboxUpdate, {
          args: [{ type: 'stop', targetPlayerId: 'stop-target' }],
        });

        // Stop bypasses pause — poll for delivered status. Replaces
        // `await sleep(2000)` — bounded wait that exits on first success.
        await pollWithTimeout(async () => {
          const entries = await handle.query(outboxQuery);
          const stopEntry = entries.find((e) => e.type === 'stop');
          return stopEntry?.status === 'delivered';
        }, 5000);

        const entries = await handle.query(outboxQuery);
        const stopEntry = entries.find((e) => e.type === 'stop');
        expect(stopEntry).to.exist;
        expect(stopEntry!.status).to.equal('delivered');

        // Cleanup
        await handle.executeUpdate(destroyUpdate, { args: [{}] });
        await handle.result();
        try { await targetHandle.result(); } catch { /* cleanup */ }
      });
    });

    it('pause and outboxLocked are independent', async function () {
      this.timeout(45_000);
      await withWorker(async () => {
        const ensemble = `independent-${Date.now()}`;

        // Create session with outboxLocked (warm hold) AND paused
        const handle = await startSession({
          metadata: playerMetadata({ playerId: 'dual-lock', ensemble }),
          outboxLocked: true,
          paused: true,
        });

        expect(await handle.query(outboxLockedQuery)).to.be.true;
        expect(await handle.query(pausedQuery)).to.be.true;

        // Resume (unpause) — outboxLocked should still be true
        await handle.signal(setPausedSignal, false);
        expect(await handle.query(pausedQuery)).to.be.false;
        expect(await handle.query(outboxLockedQuery)).to.be.true;

        // Cleanup
        await handle.executeUpdate(destroyUpdate, { args: [{}] });
        await handle.result();
      });
    });
  });

  describe('maestro pause state', function () {
    it('maestro tracks paused state', async function () {
      this.timeout(45_000);
      const { withWorkerAndMaestroActivities } = await import('./helpers');
      await withWorkerAndMaestroActivities({}, async () => {
        const ensemble = `maestro-pause-${Date.now()}`;

        const maestroHandle = await getClient().workflow.start('claudeMaestroWorkflow', {
          workflowId: `claude-maestro-${ensemble}`,
          taskQueue: TASK_QUEUE,
          args: [{ ensemble, pollIntervalMs: 200 }],
        });

        // Initially not paused
        const initialPaused = await maestroHandle.query('maestroPaused') as boolean;
        expect(initialPaused).to.be.false;

        // Pause
        await maestroHandle.signal('maestroSetPaused', true);
        expect(await maestroHandle.query('maestroPaused') as boolean).to.be.true;

        // Resume
        await maestroHandle.signal('maestroSetPaused', false);
        expect(await maestroHandle.query('maestroPaused') as boolean).to.be.false;

        // Cleanup
        await maestroHandle.signal('maestroShutdown');
        await maestroHandle.result();
      });
    });
  });

  describe('scheduler pause', function () {
    it('scheduler skips fires while paused', async function () {
      this.timeout(45_000);
      const { withWorkerAndActivities, skipTime } = await import('./helpers');
      await withWorkerAndActivities(async () => {
        const ensemble = `sched-pause-${Date.now()}`;

        // Create a target session for the schedule
        const targetHandle = await startSession({
          metadata: playerMetadata({ playerId: 'sched-target', ensemble }),
        });

        // Start scheduler with a schedule that fires soon
        const schedulerHandle = await getClient().workflow.start('claudeSchedulerWorkflow', {
          workflowId: `claude-scheduler-${ensemble}`,
          taskQueue: TASK_QUEUE,
          args: [{
            ensemble,
            entries: [{
              name: 'test-sched',
              message: 'fire!',
              target: 'sched-target',
              createdBy: 'test',
              nextFireAt: new Date(Date.now() + 2000).toISOString(),
              firedCount: 0,
              type: 'once' as const,
            }],
          }],
        });

        // Pause the scheduler immediately
        await schedulerHandle.signal('setSchedulerPaused', true);

        // Wait past the fire time
        await skipTime(5000);
        await sleep(500);

        // The schedule should still exist (not removed after fire) because it was skipped
        // Actually for 'once' type, it gets removed after processing regardless of pause.
        // The key point is the fire activity was NOT called.
        // We can verify by checking the target didn't receive the message.
        const { pendingMessagesQuery } = await import('./helpers');
        const pending = await targetHandle.query(pendingMessagesQuery);
        // No message should have been delivered since scheduler was paused
        const fireMsg = pending.find((m) => m.text === 'fire!');
        expect(fireMsg).to.not.exist;

        // Cleanup
        await targetHandle.executeUpdate(destroyUpdate, { args: [{}] });
        try { await targetHandle.result(); } catch { /* cleanup */ }
        // Scheduler self-terminates when entries are exhausted
      });
    });
  });
});
