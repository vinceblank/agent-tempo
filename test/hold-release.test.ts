import { expect } from 'chai';
import {
  setupTestEnv,
  teardownTestEnv,
  withWorkerAndRecruitActivities,
  withWorkerAndRecruitCapture,
  startSession,
  playerMetadata,
  getMetadataQuery,
  pendingMessagesQuery,
  allMessagesQuery,
  submitOutboxUpdate,
  outboxQuery,
  updateMetadataSignal,
  allSentMessagesQuery,
  getClient,
  TASK_QUEUE,
} from './helpers';
import { outboxLockedQuery, releaseHeldSignal } from '../src/workflows/signals';

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

describe('hold and release (warm hold)', function () {
  before(async function () {
    this.timeout(60_000);
    await setupTestEnv();
  });

  after(async function () {
    await teardownTestEnv();
  });

  describe('recruit with held flag (warm hold)', function () {
    it('creates workflow with outboxLocked and spawns process', async function () {
      this.timeout(30_000);
      const spawnInputs: Array<Record<string, unknown>> = [];
      await withWorkerAndRecruitCapture(spawnInputs, async () => {
        const ensemble = `warm-hold-${Date.now()}`;

        const handle = await startSession({
          metadata: playerMetadata({ playerId: 'recruiter-warm', ensemble }),
          temporalConfig: {
            temporalAddress: '',
            temporalNamespace: 'default',
            taskQueue: TASK_QUEUE,
          },
        });

        // Submit recruit with held: true
        await handle.executeUpdate(submitOutboxUpdate, {
          args: [{
            type: 'recruit',
            targetName: 'warm-held-player',
            workDir: '/tmp/test',
            isConductor: false,
            agent: 'claude',
            held: true,
            initialMessage: 'Do this task',
          }],
        });

        // Wait for outbox dispatch
        await sleep(2000);

        // Verify outbox entry was delivered
        const entries = await handle.query(outboxQuery);
        const recruitEntry = entries.find(
          (e) => e.type === 'recruit' && (e as any).targetName === 'warm-held-player',
        );
        expect(recruitEntry).to.exist;
        expect(recruitEntry!.status).to.equal('delivered');

        // Verify the recruited workflow exists and is pending (process spawned)
        const recruitedHandle = getClient().workflow.getHandle(
          `claude-session-${ensemble}-warm-held-player`,
        );
        const metadata = await recruitedHandle.query(getMetadataQuery);
        expect(metadata.status).to.equal('pending'); // not 'held' — process spawned

        // Verify outbox IS locked
        const isLocked = await recruitedHandle.query(outboxLockedQuery);
        expect(isLocked).to.be.true;

        // Verify spawnProcess WAS called (warm hold spawns immediately)
        const spawnForPlayer = spawnInputs.filter(
          (s) => (s as any).targetName === 'warm-held-player',
        );
        expect(spawnForPlayer).to.have.lengthOf(1);

        // Verify standby message was delivered, NOT the initial message
        const pending = await recruitedHandle.query(pendingMessagesQuery);
        expect(pending).to.have.lengthOf(1);
        expect(pending[0].text).to.include('standby');
        expect(pending[0].text).to.not.equal('Do this task');

        // Cleanup
        await handle.signal(updateMetadataSignal, { status: 'terminated' });
        await handle.result();
        await recruitedHandle.signal(updateMetadataSignal, { status: 'terminated' });
        try { await recruitedHandle.result(); } catch { /* cleanup */ }
      });
    });

    it('recruit without held flag works normally (no outbox lock)', async function () {
      this.timeout(30_000);
      const spawnInputs: Array<Record<string, unknown>> = [];
      await withWorkerAndRecruitCapture(spawnInputs, async () => {
        const ensemble = `no-hold-${Date.now()}`;

        const handle = await startSession({
          metadata: playerMetadata({ playerId: 'recruiter-normal', ensemble }),
          temporalConfig: {
            temporalAddress: '',
            temporalNamespace: 'default',
            taskQueue: TASK_QUEUE,
          },
        });

        await handle.executeUpdate(submitOutboxUpdate, {
          args: [{
            type: 'recruit',
            targetName: 'normal-player',
            workDir: '/tmp/test',
            isConductor: false,
            agent: 'claude',
            initialMessage: 'Start working',
          }],
        });

        await sleep(2000);

        const recruitedHandle = getClient().workflow.getHandle(
          `claude-session-${ensemble}-normal-player`,
        );

        // Outbox should NOT be locked
        const isLocked = await recruitedHandle.query(outboxLockedQuery);
        expect(isLocked).to.be.false;

        // Initial message should be directly in pending messages
        const pending = await recruitedHandle.query(pendingMessagesQuery);
        expect(pending).to.have.lengthOf(1);
        expect(pending[0].text).to.equal('Start working');

        // Cleanup
        await handle.signal(updateMetadataSignal, { status: 'terminated' });
        await handle.result();
        await recruitedHandle.signal(updateMetadataSignal, { status: 'terminated' });
        try { await recruitedHandle.result(); } catch { /* cleanup */ }
      });
    });
  });

  describe('release dispatch', function () {
    it('release unlocks outbox and delivers held message', async function () {
      this.timeout(30_000);
      await withWorkerAndRecruitActivities(async () => {
        const ensemble = `release-warm-${Date.now()}`;

        const handle = await startSession({
          metadata: playerMetadata({ playerId: 'releaser', ensemble }),
          temporalConfig: {
            temporalAddress: '',
            temporalNamespace: 'default',
            taskQueue: TASK_QUEUE,
          },
        });

        // Recruit a held player
        await handle.executeUpdate(submitOutboxUpdate, {
          args: [{
            type: 'recruit',
            targetName: 'release-target',
            workDir: '/tmp/test',
            isConductor: false,
            agent: 'claude',
            held: true,
            initialMessage: 'Your actual task',
          }],
        });

        await sleep(2000);

        // Verify it's locked
        const recruitedHandle = getClient().workflow.getHandle(
          `claude-session-${ensemble}-release-target`,
        );
        expect(await recruitedHandle.query(outboxLockedQuery)).to.be.true;

        // Now release it
        await handle.executeUpdate(submitOutboxUpdate, {
          args: [{
            type: 'release',
            targetPlayerId: 'release-target',
          }],
        });

        await sleep(2000);

        // Verify outbox release entry was delivered
        const entries = await handle.query(outboxQuery);
        const releaseEntry = entries.find((e) => e.type === 'release');
        expect(releaseEntry).to.exist;
        expect(releaseEntry!.status).to.equal('delivered');

        // Verify outbox is now unlocked
        expect(await recruitedHandle.query(outboxLockedQuery)).to.be.false;

        // Verify the held initial message was delivered
        const allMsgs = await recruitedHandle.query(allMessagesQuery);
        const taskMsg = allMsgs.find((m) => m.text === 'Your actual task');
        expect(taskMsg).to.exist;

        // Cleanup
        await handle.signal(updateMetadataSignal, { status: 'terminated' });
        await handle.result();
        await recruitedHandle.signal(updateMetadataSignal, { status: 'terminated' });
        try { await recruitedHandle.result(); } catch { /* cleanup */ }
      });
    });

    it('release records in sentMessages', async function () {
      this.timeout(30_000);
      await withWorkerAndRecruitActivities(async () => {
        const ensemble = `release-sent-${Date.now()}`;

        const handle = await startSession({
          metadata: playerMetadata({ playerId: 'releaser-sent', ensemble }),
          temporalConfig: {
            temporalAddress: '',
            temporalNamespace: 'default',
            taskQueue: TASK_QUEUE,
          },
        });

        // Recruit held, then release
        await handle.executeUpdate(submitOutboxUpdate, {
          args: [{
            type: 'recruit',
            targetName: 'release-sent-target',
            workDir: '/tmp/test',
            isConductor: false,
            agent: 'claude',
            held: true,
          }],
        });

        await sleep(2000);

        const releaseId = await handle.executeUpdate(submitOutboxUpdate, {
          args: [{
            type: 'release',
            targetPlayerId: 'release-sent-target',
          }],
        });

        const sent = await handle.query(allSentMessagesQuery);
        const match = sent.find((s) => s.id === releaseId);
        expect(match).to.exist;
        expect(match!.to).to.equal('release-sent-target');
        expect(match!.text).to.equal('[release requested]');

        // Cleanup
        await handle.signal(updateMetadataSignal, { status: 'terminated' });
        await handle.result();
        const recruitedHandle = getClient().workflow.getHandle(
          `claude-session-${ensemble}-release-sent-target`,
        );
        await recruitedHandle.signal(updateMetadataSignal, { status: 'terminated' });
        try { await recruitedHandle.result(); } catch { /* cleanup */ }
      });
    });

    it('release fails for non-held session', async function () {
      this.timeout(30_000);
      await withWorkerAndRecruitActivities(async () => {
        const ensemble = `release-fail-${Date.now()}`;

        // Create an active (non-held) session
        const activeHandle = await startSession({
          metadata: playerMetadata({ playerId: 'active-player', ensemble, status: 'active' }),
        });

        const handle = await startSession({
          metadata: playerMetadata({ playerId: 'releaser-fail', ensemble }),
          temporalConfig: {
            temporalAddress: '',
            temporalNamespace: 'default',
            taskQueue: TASK_QUEUE,
          },
        });

        // Try to release an active session — should fail
        await handle.executeUpdate(submitOutboxUpdate, {
          args: [{
            type: 'release',
            targetPlayerId: 'active-player',
          }],
        });

        await sleep(2000);

        // Verify the outbox entry failed
        const entries = await handle.query(outboxQuery);
        const releaseEntry = entries.find((e) => e.type === 'release');
        expect(releaseEntry).to.exist;
        expect(releaseEntry!.status).to.equal('failed');
        // Temporal wraps ApplicationFailure in ActivityFailure; verify a non-empty error was recorded
        expect(releaseEntry!.error).to.be.a('string').with.length.greaterThan(0);

        // Cleanup
        await handle.signal(updateMetadataSignal, { status: 'terminated' });
        await handle.result();
        await activeHandle.signal(updateMetadataSignal, { status: 'terminated' });
        try { await activeHandle.result(); } catch { /* cleanup */ }
      });
    });
  });

  describe('outbox lock behavior', function () {
    it('outbox entries are buffered while locked and dispatched after release', async function () {
      this.timeout(30_000);
      await withWorkerAndRecruitActivities(async () => {
        const ensemble = `lock-buffer-${Date.now()}`;

        // Create a session with outboxLocked: true directly
        const heldHandle = await startSession({
          metadata: playerMetadata({
            playerId: 'locked-player',
            ensemble,
            recruitedBy: 'test',
          }),
          outboxLocked: true,
          heldMessage: 'Deferred task',
        });

        // Submit an outbox entry while locked — should buffer
        await heldHandle.executeUpdate(submitOutboxUpdate, {
          args: [{ type: 'cue', targetPlayerId: 'nobody', message: 'buffered msg' }],
        });

        await sleep(1000);

        // Entry should still be pending (not dispatched due to lock)
        let entries = await heldHandle.query(outboxQuery);
        const bufferedEntry = entries.find(
          (e) => e.type === 'cue' && (e as any).message === 'buffered msg',
        );
        expect(bufferedEntry).to.exist;
        expect(bufferedEntry!.status).to.equal('pending');

        // Release the hold
        await heldHandle.signal(releaseHeldSignal);

        await sleep(2000);

        // After release, the buffered entry should be dispatched (will fail since 'nobody' doesn't exist, but status should be 'failed' not 'pending')
        entries = await heldHandle.query(outboxQuery);
        const afterRelease = entries.find(
          (e) => e.type === 'cue' && (e as any).message === 'buffered msg',
        );
        expect(afterRelease).to.exist;
        expect(afterRelease!.status).to.not.equal('pending');

        // The held message should have been injected
        const allMsgs = await heldHandle.query(allMessagesQuery);
        const deferredMsg = allMsgs.find((m) => m.text === 'Deferred task');
        expect(deferredMsg).to.exist;

        // outboxLocked should now be false
        expect(await heldHandle.query(outboxLockedQuery)).to.be.false;

        // Cleanup
        await heldHandle.signal(updateMetadataSignal, { status: 'terminated' });
        await heldHandle.result();
      });
    });
  });

  describe('selective release', function () {
    it('releases one held player while another remains locked', async function () {
      this.timeout(30_000);
      await withWorkerAndRecruitActivities(async () => {
        const ensemble = `selective-warm-${Date.now()}`;

        const handle = await startSession({
          metadata: playerMetadata({ playerId: 'selective-releaser', ensemble }),
          temporalConfig: {
            temporalAddress: '',
            temporalNamespace: 'default',
            taskQueue: TASK_QUEUE,
          },
        });

        // Recruit two held players
        await handle.executeUpdate(submitOutboxUpdate, {
          args: [{
            type: 'recruit',
            targetName: 'held-a',
            workDir: '/tmp/test',
            isConductor: false,
            agent: 'claude',
            held: true,
            initialMessage: 'Task A',
          }],
        });
        await handle.executeUpdate(submitOutboxUpdate, {
          args: [{
            type: 'recruit',
            targetName: 'held-b',
            workDir: '/tmp/test',
            isConductor: false,
            agent: 'claude',
            held: true,
            initialMessage: 'Task B',
          }],
        });

        await sleep(3000);

        // Verify both are locked
        const handleA = getClient().workflow.getHandle(`claude-session-${ensemble}-held-a`);
        const handleB = getClient().workflow.getHandle(`claude-session-${ensemble}-held-b`);
        expect(await handleA.query(outboxLockedQuery)).to.be.true;
        expect(await handleB.query(outboxLockedQuery)).to.be.true;

        // Release only held-a
        await handle.executeUpdate(submitOutboxUpdate, {
          args: [{
            type: 'release',
            targetPlayerId: 'held-a',
          }],
        });

        await sleep(2000);

        // held-a should be unlocked with task message, held-b still locked
        expect(await handleA.query(outboxLockedQuery)).to.be.false;
        expect(await handleB.query(outboxLockedQuery)).to.be.true;

        // held-a should have received its task message
        const msgsA = await handleA.query(allMessagesQuery);
        expect(msgsA.some((m) => m.text === 'Task A')).to.be.true;

        // held-b should NOT have its task message yet
        const msgsB = await handleB.query(allMessagesQuery);
        expect(msgsB.some((m) => m.text === 'Task B')).to.be.false;

        // Cleanup
        await handle.signal(updateMetadataSignal, { status: 'terminated' });
        await handle.result();
        await handleA.signal(updateMetadataSignal, { status: 'terminated' });
        await handleB.signal(updateMetadataSignal, { status: 'terminated' });
        try { await handleA.result(); } catch { /* cleanup */ }
        try { await handleB.result(); } catch { /* cleanup */ }
      });
    });
  });
});
