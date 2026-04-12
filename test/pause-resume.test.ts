import { expect } from 'chai';
import {
  setupTestEnv,
  teardownTestEnv,
  withWorkerAndOutboxActivities,
  withWorker,
  startSession,
  playerMetadata,
  submitOutboxUpdate,
  outboxQuery,
  updateMetadataSignal,
  getClient,
  TASK_QUEUE,
} from './helpers';
import { setPausedSignal, pausedQuery, outboxLockedQuery } from '../src/workflows/signals';

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

describe('pause and resume', function () {
  before(async function () {
    this.timeout(60_000);
    await setupTestEnv();
  });

  after(async function () {
    await teardownTestEnv();
  });

  describe('session pause behavior', function () {
    it('pause blocks outbox dispatch', async function () {
      this.timeout(30_000);
      await withWorkerAndOutboxActivities(async () => {
        const ensemble = `pause-block-${Date.now()}`;

        const handle = await startSession({
          metadata: playerMetadata({ playerId: 'paused-player', ensemble }),
        });

        // Pause the session
        await handle.signal(setPausedSignal, true);

        // Verify paused
        expect(await handle.query(pausedQuery)).to.be.true;

        // Submit a cue — should buffer, not dispatch
        await handle.executeUpdate(submitOutboxUpdate, {
          args: [{ type: 'cue', targetPlayerId: 'nobody', message: 'paused msg' }],
        });

        await sleep(1500);

        // Entry should still be pending (paused blocks dispatch)
        const entries = await handle.query(outboxQuery);
        const entry = entries.find((e) => e.type === 'cue' && (e as any).message === 'paused msg');
        expect(entry).to.exist;
        expect(entry!.status).to.equal('pending');

        // Cleanup
        await handle.signal(updateMetadataSignal, { status: 'terminated' });
        await handle.result();
      });
    });

    it('resume unblocks dispatch and flushes buffered entries', async function () {
      this.timeout(30_000);
      await withWorkerAndOutboxActivities(async () => {
        const ensemble = `resume-flush-${Date.now()}`;

        const handle = await startSession({
          metadata: playerMetadata({ playerId: 'resume-player', ensemble }),
        });

        // Pause
        await handle.signal(setPausedSignal, true);

        // Submit entry while paused
        await handle.executeUpdate(submitOutboxUpdate, {
          args: [{ type: 'cue', targetPlayerId: 'nobody', message: 'buffered' }],
        });

        await sleep(1000);

        // Verify still pending
        let entries = await handle.query(outboxQuery);
        expect(entries[0].status).to.equal('pending');

        // Resume
        await handle.signal(setPausedSignal, false);

        await sleep(2000);

        // After resume, entry should be dispatched (will fail since target doesn't exist, but status != pending)
        entries = await handle.query(outboxQuery);
        const entry = entries.find((e) => e.type === 'cue');
        expect(entry).to.exist;
        expect(entry!.status).to.not.equal('pending');

        // Cleanup
        await handle.signal(updateMetadataSignal, { status: 'terminated' });
        await handle.result();
      });
    });

    it('stop entries bypass pause', async function () {
      this.timeout(30_000);
      await withWorkerAndOutboxActivities(async () => {
        const ensemble = `stop-bypass-${Date.now()}`;

        // Create a target session to stop
        const targetHandle = await startSession({
          metadata: playerMetadata({ playerId: 'stop-target', ensemble }),
        });

        const handle = await startSession({
          metadata: playerMetadata({ playerId: 'stopper', ensemble }),
        });

        // Pause the stopper
        await handle.signal(setPausedSignal, true);

        // Submit a stop — should bypass pause
        await handle.executeUpdate(submitOutboxUpdate, {
          args: [{ type: 'stop', targetPlayerId: 'stop-target' }],
        });

        await sleep(2000);

        // Stop entry should be delivered despite pause
        const entries = await handle.query(outboxQuery);
        const stopEntry = entries.find((e) => e.type === 'stop');
        expect(stopEntry).to.exist;
        expect(stopEntry!.status).to.equal('delivered');

        // Cleanup
        await handle.signal(updateMetadataSignal, { status: 'terminated' });
        await handle.result();
        try { await targetHandle.result(); } catch { /* cleanup */ }
      });
    });

    it('pause and outboxLocked are independent', async function () {
      this.timeout(30_000);
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
        await handle.signal(updateMetadataSignal, { status: 'terminated' });
        await handle.result();
      });
    });
  });

  describe('maestro pause state', function () {
    it('maestro tracks paused state', async function () {
      this.timeout(30_000);
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
      this.timeout(30_000);
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
        await targetHandle.signal(updateMetadataSignal, { status: 'terminated' });
        try { await targetHandle.result(); } catch { /* cleanup */ }
        // Scheduler self-terminates when entries are exhausted
      });
    });
  });
});
