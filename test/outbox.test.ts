import { expect } from 'chai';
import {
  setupTestEnv,
  teardownTestEnv,
  withWorkerAndOutboxActivities,
  withWorkerAndRecruitActivities,
  startSession,
  playerMetadata,
  conductorMetadata,
  getMetadataQuery,
  pendingMessagesQuery,
  allMessagesQuery,
  allSentMessagesQuery,
  submitOutboxUpdate,
  outboxQuery,
  updateMetadataSignal,
  getClient,
  TASK_QUEUE,
} from './helpers';

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

describe('outbox', function () {
  before(async function () {
    this.timeout(60_000);
    await setupTestEnv();
  });

  after(async function () {
    await teardownTestEnv();
  });

  // ── submitOutboxUpdate basics ──

  describe('submitOutboxUpdate basics', function () {
    it('returns an entry ID and records entry as pending', async function () {
      this.timeout(30_000);
      await withWorkerAndOutboxActivities(async () => {
        const handle = await startSession({
          metadata: playerMetadata({ playerId: 'outbox-basic-1' }),
        });

        const entryId = await handle.executeUpdate(submitOutboxUpdate, {
          args: [{ type: 'cue', targetPlayerId: 'nobody', message: 'hello' }],
        });

        expect(entryId).to.be.a('string');
        expect(entryId.length).to.be.greaterThan(0);

        const entries = await handle.query(outboxQuery);
        const entry = entries.find((e) => e.id === entryId);
        expect(entry).to.exist;
        expect(entry!.type).to.equal('cue');

        // Terminate to clean up
        await handle.signal(updateMetadataSignal, { status: 'terminated' });
        await handle.result();
      });
    });

    it('records cue in sentMessages', async function () {
      this.timeout(30_000);
      await withWorkerAndOutboxActivities(async () => {
        const handle = await startSession({
          metadata: playerMetadata({ playerId: 'outbox-sent-1' }),
        });

        const entryId = await handle.executeUpdate(submitOutboxUpdate, {
          args: [{ type: 'cue', targetPlayerId: 'target-player', message: 'test msg' }],
        });

        const sent = await handle.query(allSentMessagesQuery);
        const match = sent.find((s) => s.id === entryId);
        expect(match).to.exist;
        expect(match!.to).to.equal('target-player');
        expect(match!.text).to.equal('test msg');

        await handle.signal(updateMetadataSignal, { status: 'terminated' });
        await handle.result();
      });
    });
  });

  // ── Outbox cue delivery ──

  describe('cue delivery', function () {
    it('delivers a cue message to the target session', async function () {
      this.timeout(30_000);
      await withWorkerAndOutboxActivities(async () => {
        const alice = await startSession({
          metadata: playerMetadata({ playerId: 'alice-cue' }),
        });
        const bob = await startSession({
          metadata: playerMetadata({ playerId: 'bob-cue' }),
        });

        await alice.executeUpdate(submitOutboxUpdate, {
          args: [{ type: 'cue', targetPlayerId: 'bob-cue', message: 'hi bob' }],
        });

        // Wait for dispatch loop to process
        await sleep(2000);

        const bobMessages = await bob.query(pendingMessagesQuery);
        expect(bobMessages.some((m) => m.from === 'alice-cue' && m.text === 'hi bob')).to.be.true;

        const aliceOutbox = await alice.query(outboxQuery);
        const delivered = aliceOutbox.find((e) => e.type === 'cue');
        expect(delivered).to.exist;
        expect(delivered!.status).to.equal('delivered');
        expect(delivered!.deliveredAt).to.be.a('string');

        // Clean up
        await alice.signal(updateMetadataSignal, { status: 'terminated' });
        await bob.signal(updateMetadataSignal, { status: 'terminated' });
        await alice.result();
        await bob.result();
      });
    });
  });

  // ── Outbox report delivery ──

  describe('report delivery', function () {
    it('delivers a report to the conductor', async function () {
      this.timeout(30_000);
      await withWorkerAndOutboxActivities(async () => {
        const conductor = await startSession({
          metadata: conductorMetadata(),
        });
        const player = await startSession({
          metadata: playerMetadata({ playerId: 'reporter-1' }),
        });

        await player.executeUpdate(submitOutboxUpdate, {
          args: [{ type: 'report', text: 'task done', reportType: 'result' }],
        });

        await sleep(2000);

        const conductorMessages = await conductor.query(allMessagesQuery);
        expect(conductorMessages.some(
          (m) => m.from === 'reporter-1' && m.text.includes('[result]') && m.text.includes('task done'),
        )).to.be.true;

        const playerOutbox = await player.query(outboxQuery);
        expect(playerOutbox[0].status).to.equal('delivered');

        await player.signal(updateMetadataSignal, { status: 'terminated' });
        await conductor.signal(updateMetadataSignal, { status: 'terminated' });
        await player.result();
        await conductor.result();
      });
    });
  });

  // ── Outbox stop delivery ──

  describe('stop delivery', function () {
    it('terminates the target session', async function () {
      this.timeout(30_000);
      await withWorkerAndOutboxActivities(async () => {
        const alice = await startSession({
          metadata: playerMetadata({ playerId: 'alice-stop' }),
        });
        const bob = await startSession({
          metadata: playerMetadata({ playerId: 'bob-stop' }),
        });

        await alice.executeUpdate(submitOutboxUpdate, {
          args: [{ type: 'stop', targetPlayerId: 'bob-stop' }],
        });

        await sleep(2000);

        const bobMeta = await bob.query(getMetadataQuery);
        expect(bobMeta.status).to.equal('terminated');

        const aliceOutbox = await alice.query(outboxQuery);
        expect(aliceOutbox[0].status).to.equal('delivered');

        await alice.signal(updateMetadataSignal, { status: 'terminated' });
        // Bob is already terminated, just wait for completion
        await alice.result();
        await bob.result();
      });
    });
  });

  // ── Failure handling ──

  describe('failure handling', function () {
    it('marks entry as failed when target does not exist', async function () {
      this.timeout(60_000);
      await withWorkerAndOutboxActivities(async () => {
        const handle = await startSession({
          metadata: playerMetadata({ playerId: 'outbox-fail-1' }),
        });

        await handle.executeUpdate(submitOutboxUpdate, {
          args: [{ type: 'cue', targetPlayerId: 'nonexistent-player', message: 'hello?' }],
        });

        // Wait for dispatch + retries (activity retries up to 3 times with backoff)
        for (let i = 0; i < 30; i++) {
          await sleep(1000);
          const entries = await handle.query(outboxQuery);
          const entry = entries.find((e) => e.type === 'cue');
          if (entry && entry.status === 'failed') break;
        }

        const entries = await handle.query(outboxQuery);
        const entry = entries.find((e) => e.type === 'cue');
        expect(entry).to.exist;
        expect(entry!.status).to.equal('failed');
        expect(entry!.error).to.be.a('string');
        expect(entry!.error!.length).to.be.greaterThan(0);

        await handle.signal(updateMetadataSignal, { status: 'terminated' });
        await handle.result();
      });
    });
  });

  // ── Multiple entries ──

  describe('outboxQuery returns all entries', function () {
    it('returns entries of different types', async function () {
      this.timeout(30_000);
      await withWorkerAndOutboxActivities(async () => {
        const handle = await startSession({
          metadata: playerMetadata({ playerId: 'outbox-multi-1' }),
        });

        await handle.executeUpdate(submitOutboxUpdate, {
          args: [{ type: 'cue', targetPlayerId: 'someone', message: 'msg1' }],
        });
        await handle.executeUpdate(submitOutboxUpdate, {
          args: [{ type: 'report', text: 'status update', reportType: 'blocker' }],
        });
        await handle.executeUpdate(submitOutboxUpdate, {
          args: [{ type: 'stop', targetPlayerId: 'someone-else' }],
        });

        const entries = await handle.query(outboxQuery);
        expect(entries).to.have.length(3);

        const types = entries.map((e) => e.type);
        expect(types).to.include('cue');
        expect(types).to.include('report');
        expect(types).to.include('stop');

        // Each has unique ID and createdAt
        const ids = entries.map((e) => e.id);
        expect(new Set(ids).size).to.equal(3);

        await handle.signal(updateMetadataSignal, { status: 'terminated' });
        await handle.result();
      });
    });
  });

  // ── Recruit delivery ──

  describe('recruit delivery', function () {
    it('pre-creates session workflow with initial message, playerType, and recruitedBy', async function () {
      this.timeout(30_000);
      await withWorkerAndRecruitActivities(async () => {
        const ensemble = `recruit-${Date.now()}`;

        // Pass temporalConfig so startRecruitedSession creates the recruited workflow
        // on the test task queue (default 'claude-tempo' would have no worker)
        const handle = await startSession({
          metadata: playerMetadata({ playerId: 'recruiter', ensemble }),
          temporalConfig: {
            temporalAddress: '',
            temporalNamespace: 'default',
            taskQueue: TASK_QUEUE,
          },
        });

        await handle.executeUpdate(submitOutboxUpdate, {
          args: [{
            type: 'recruit',
            targetName: 'new-player',
            workDir: '/tmp/test',
            isConductor: false,
            initialMessage: 'Welcome to the team',
            agent: 'claude',
            agentDefinition: 'tempo-soloist',
            agentDefinitionDescription: 'Senior engineer',
          }],
        });

        // Wait for dispatch loop to run both startRecruitedSession + spawnProcess
        await sleep(3000);

        // Outbox entry should be delivered
        const outboxEntries = await handle.query(outboxQuery);
        const recruitEntry = outboxEntries.find((e) => e.type === 'recruit');
        expect(recruitEntry).to.exist;
        expect(recruitEntry!.status).to.equal('delivered');

        // Pre-created workflow should have the initial message pending
        const recruitedHandle = getClient().workflow.getHandle(
          `claude-session-${ensemble}-new-player`,
        );
        const pending = await recruitedHandle.query(pendingMessagesQuery);
        expect(pending).to.have.lengthOf(1);
        expect(pending[0].from).to.equal('recruiter');
        expect(pending[0].text).to.equal('Welcome to the team');
        expect(pending[0].delivered).to.equal(false);

        // Metadata should reflect the agent definition and recruiter identity
        const meta = await recruitedHandle.query(getMetadataQuery);
        expect(meta.playerType).to.equal('tempo-soloist');
        expect(meta.playerTypeDescription).to.equal('Senior engineer');
        expect(meta.recruitedBy).to.equal('recruiter');
        expect(meta.status).to.equal('pending');
        expect(meta.ensemble).to.equal(ensemble);
        expect(meta.isConductor).to.equal(false);

        // Cleanup
        await handle.signal(updateMetadataSignal, { status: 'terminated' });
        await handle.result();
        await recruitedHandle.signal(updateMetadataSignal, { status: 'terminated' });
        try { await recruitedHandle.result(); } catch { /* cleanup */ }
      });
    });

    it('recruit without initialMessage starts session with empty inbox', async function () {
      this.timeout(30_000);
      await withWorkerAndRecruitActivities(async () => {
        const ensemble = `recruit2-${Date.now()}`;

        const handle = await startSession({
          metadata: playerMetadata({ playerId: 'recruiter2', ensemble }),
          temporalConfig: {
            temporalAddress: '',
            temporalNamespace: 'default',
            taskQueue: TASK_QUEUE,
          },
        });

        await handle.executeUpdate(submitOutboxUpdate, {
          args: [{
            type: 'recruit',
            targetName: 'silent-player',
            workDir: '/tmp/test',
            isConductor: false,
            agent: 'claude',
          }],
        });

        await sleep(3000);

        const outboxEntries = await handle.query(outboxQuery);
        const recruitEntry = outboxEntries.find((e) => e.type === 'recruit');
        expect(recruitEntry).to.exist;
        expect(recruitEntry!.status).to.equal('delivered');

        // No initialMessage — inbox should be empty
        const recruitedHandle = getClient().workflow.getHandle(
          `claude-session-${ensemble}-silent-player`,
        );
        const pending = await recruitedHandle.query(pendingMessagesQuery);
        expect(pending).to.have.lengthOf(0);

        await handle.signal(updateMetadataSignal, { status: 'terminated' });
        await handle.result();
        await recruitedHandle.signal(updateMetadataSignal, { status: 'terminated' });
        try { await recruitedHandle.result(); } catch { /* cleanup */ }
      });
    });
  });

  // ── Stop delivery with conductor notification ──

  describe('stop delivery (conductor notification)', function () {
    it('notifies conductor with a system message when a session is terminated', async function () {
      this.timeout(30_000);
      await withWorkerAndOutboxActivities(async () => {
        const ensemble = `stop-cond-${Date.now()}`;

        const conductor = await startSession({
          metadata: conductorMetadata({ ensemble }),
        });
        const target = await startSession({
          metadata: playerMetadata({ playerId: 'stop-target', ensemble }),
        });
        const stopper = await startSession({
          metadata: playerMetadata({ playerId: 'the-stopper', ensemble }),
        });

        await stopper.executeUpdate(submitOutboxUpdate, {
          args: [{ type: 'stop', targetPlayerId: 'stop-target' }],
        });

        await sleep(2000);

        // Target should be marked terminated
        const targetMeta = await target.query(getMetadataQuery);
        expect(targetMeta.status).to.equal('terminated');

        // Conductor should receive the system notification about the termination
        const conductorMessages = await conductor.query(allMessagesQuery);
        const notification = conductorMessages.find(
          (m) => m.from === 'system'
            && m.text.includes('stop-target')
            && m.text.includes('terminated'),
        );
        expect(notification).to.exist;

        await stopper.signal(updateMetadataSignal, { status: 'terminated' });
        await conductor.signal(updateMetadataSignal, { status: 'terminated' });
        await stopper.result();
        await conductor.result();
        // target already terminated — just await completion
        await target.result();
      });
    });
  });

  // ── Report delivery failure (no conductor) ──

  describe('report delivery failure', function () {
    it('marks report entry as failed when no conductor is running', async function () {
      this.timeout(60_000);
      await withWorkerAndOutboxActivities(async () => {
        // Use a unique ensemble with no conductor
        const ensemble = `no-cond-${Date.now()}`;

        const handle = await startSession({
          metadata: playerMetadata({ playerId: 'lonely-reporter', ensemble }),
        });

        await handle.executeUpdate(submitOutboxUpdate, {
          args: [{ type: 'report', text: 'orphan report', reportType: 'result' }],
        });

        // Poll until the outbox entry transitions to 'failed'.
        // deliverReport retries up to 3 times (~4s total) before giving up.
        for (let i = 0; i < 40; i++) {
          await sleep(1000);
          const entries = await handle.query(outboxQuery);
          const entry = entries.find((e) => e.type === 'report');
          if (entry && entry.status === 'failed') break;
        }

        const entries = await handle.query(outboxQuery);
        const entry = entries.find((e) => e.type === 'report');
        expect(entry).to.exist;
        expect(entry!.status).to.equal('failed');
        expect(entry!.error).to.be.a('string');
        expect(entry!.error!.length).to.be.greaterThan(0);

        await handle.signal(updateMetadataSignal, { status: 'terminated' });
        await handle.result();
      });
    });
  });
});
