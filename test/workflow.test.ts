import { expect } from 'chai';
import {
  setupTestEnv,
  teardownTestEnv,
  withWorker,
  startSession,
  sendMessage,
  playerMetadata,
  conductorMetadata,
  receiveMessageSignal,
  setPartSignal,
  setNameSignal,
  shutdownSignal,
  markDeliveredSignal,
  recordSentMessageSignal,
  updateMetadataSignal,
  getPartQuery,
  getMetadataQuery,
  pendingMessagesQuery,
  allMessagesQuery,
  allSentMessagesQuery,
  commandSignal,
  playerReportSignal,
  historyQuery,
} from './helpers';

describe('claudeSessionWorkflow', function () {
  before(async function () {
    this.timeout(60_000);
    await setupTestEnv();
  });

  after(async function () {
    await teardownTestEnv();
  });

  // ── Lifecycle ──

  describe('lifecycle', function () {
    it('starts and responds to metadata query', async function () {
      const meta = playerMetadata({ playerId: 'lifecycle-1' });
      await withWorker(async () => {
        const handle = await startSession({ metadata: meta });
        const result = await handle.query(getMetadataQuery);

        expect(result.playerId).to.equal('lifecycle-1');
        expect(result.ensemble).to.equal('test-ensemble');
        expect(result.hostname).to.equal('test-host');
        expect(result.isConductor).to.equal(false);

        await handle.signal(shutdownSignal);
        await handle.result();
      });
    });

    it('returns autoSummary as initial part', async function () {
      await withWorker(async () => {
        const handle = await startSession({
          metadata: playerMetadata({ playerId: 'part-init' }),
          autoSummary: 'Working on feature X',
        });
        const part = await handle.query(getPartQuery);
        expect(part).to.equal('Working on feature X');

        await handle.signal(shutdownSignal);
        await handle.result();
      });
    });

    it('shuts down cleanly on shutdown signal', async function () {
      await withWorker(async () => {
        const handle = await startSession({
          metadata: playerMetadata({ playerId: 'shutdown-1' }),
        });
        await handle.signal(shutdownSignal);
        // Should complete without error
        await handle.result();
      });
    });
  });

  // ── set_name ──

  describe('setName', function () {
    it('updates playerId in metadata', async function () {
      await withWorker(async () => {
        const handle = await startSession({
          metadata: playerMetadata({ playerId: 'temp-id' }),
        });

        await handle.signal(setNameSignal, 'alice');
        const meta = await handle.query(getMetadataQuery);
        expect(meta.playerId).to.equal('alice');

        await handle.signal(shutdownSignal);
        await handle.result();
      });
    });
  });

  // ── set_part ──

  describe('setPart', function () {
    it('updates the part description', async function () {
      await withWorker(async () => {
        const handle = await startSession({
          metadata: playerMetadata({ playerId: 'part-1' }),
        });

        await handle.signal(setPartSignal, 'Refactoring auth module');
        const part = await handle.query(getPartQuery);
        expect(part).to.equal('Refactoring auth module');

        await handle.signal(shutdownSignal);
        await handle.result();
      });
    });
  });

  // ── Messages ──

  describe('messages', function () {
    it('receives messages and marks them as pending', async function () {
      await withWorker(async () => {
        const handle = await startSession({
          metadata: playerMetadata({ playerId: 'msg-1' }),
        });

        await sendMessage(handle, 'bob', 'Hello from bob');
        const pending = await handle.query(pendingMessagesQuery);

        expect(pending).to.have.lengthOf(1);
        expect(pending[0].from).to.equal('bob');
        expect(pending[0].text).to.equal('Hello from bob');
        expect(pending[0].delivered).to.equal(false);

        await handle.signal(shutdownSignal);
        await handle.result();
      });
    });

    it('marks messages as delivered', async function () {
      await withWorker(async () => {
        const handle = await startSession({
          metadata: playerMetadata({ playerId: 'msg-2' }),
        });

        await sendMessage(handle, 'bob', 'message 1');
        const pending = await handle.query(pendingMessagesQuery);
        expect(pending).to.have.lengthOf(1);

        await handle.signal(markDeliveredSignal, [pending[0].id]);

        const afterDelivery = await handle.query(pendingMessagesQuery);
        expect(afterDelivery).to.have.lengthOf(0);

        const all = await handle.query(allMessagesQuery);
        expect(all).to.have.lengthOf(1);
        expect(all[0].delivered).to.equal(true);

        await handle.signal(shutdownSignal);
        await handle.result();
      });
    });

    it('tracks multiple messages in order', async function () {
      await withWorker(async () => {
        const handle = await startSession({
          metadata: playerMetadata({ playerId: 'msg-3' }),
        });

        await sendMessage(handle, 'alice', 'first');
        await sendMessage(handle, 'bob', 'second');
        await sendMessage(handle, 'charlie', 'third');

        const all = await handle.query(allMessagesQuery);
        expect(all).to.have.lengthOf(3);
        expect(all[0].from).to.equal('alice');
        expect(all[1].from).to.equal('bob');
        expect(all[2].from).to.equal('charlie');

        await handle.signal(shutdownSignal);
        await handle.result();
      });
    });

    it('records sent messages', async function () {
      await withWorker(async () => {
        const handle = await startSession({
          metadata: playerMetadata({ playerId: 'msg-4' }),
        });

        await handle.signal(recordSentMessageSignal, { to: 'bob', text: 'Hi bob' });
        const sent = await handle.query(allSentMessagesQuery);

        expect(sent).to.have.lengthOf(1);
        expect(sent[0].to).to.equal('bob');
        expect(sent[0].text).to.equal('Hi bob');

        await handle.signal(shutdownSignal);
        await handle.result();
      });
    });
  });

  // ── Conductor ──

  describe('conductor', function () {
    it('starts as conductor with isConductor flag', async function () {
      await withWorker(async () => {
        const handle = await startSession({
          metadata: conductorMetadata({ playerId: 'cond-1' }),
        });

        const meta = await handle.query(getMetadataQuery);
        expect(meta.isConductor).to.equal(true);
        expect(meta.playerId).to.equal('cond-1');

        await handle.signal(shutdownSignal);
        await handle.result();
      });
    });

    it('receives commands and exposes them via history query', async function () {
      await withWorker(async () => {
        const handle = await startSession({
          metadata: conductorMetadata(),
        });

        await handle.signal(commandSignal, {
          text: 'Deploy to staging',
          source: 'maestro',
        });

        const history = await handle.query(historyQuery);
        expect(history).to.have.lengthOf(1);
        expect(history[0].type).to.equal('command');
        expect((history[0].data as any).text).to.equal('Deploy to staging');

        await handle.signal(shutdownSignal);
        await handle.result();
      });
    });

    it('receives player reports and exposes them via history query', async function () {
      await withWorker(async () => {
        const handle = await startSession({
          metadata: conductorMetadata(),
        });

        await handle.signal(playerReportSignal, {
          playerId: 'alice',
          text: 'Task complete',
          type: 'result',
        });

        const history = await handle.query(historyQuery);
        expect(history).to.have.lengthOf(1);
        expect(history[0].type).to.equal('report');
        expect((history[0].data as any).playerId).to.equal('alice');

        await handle.signal(shutdownSignal);
        await handle.result();
      });
    });

    it('delivers commands as messages to conductor session', async function () {
      await withWorker(async () => {
        const handle = await startSession({
          metadata: conductorMetadata(),
        });

        await handle.signal(commandSignal, {
          text: 'Run tests',
          source: 'maestro',
        });

        const pending = await handle.query(pendingMessagesQuery);
        expect(pending).to.have.lengthOf(1);
        expect(pending[0].from).to.equal('maestro');
        expect(pending[0].text).to.equal('Run tests');

        await handle.signal(shutdownSignal);
        await handle.result();
      });
    });

    it('delivers player reports as messages to conductor session', async function () {
      await withWorker(async () => {
        const handle = await startSession({
          metadata: conductorMetadata(),
        });

        await handle.signal(playerReportSignal, {
          playerId: 'bob',
          text: 'Blocked on API key',
          type: 'blocker',
        });

        const pending = await handle.query(pendingMessagesQuery);
        expect(pending).to.have.lengthOf(1);
        expect(pending[0].from).to.equal('bob');
        expect(pending[0].text).to.include('blocker');

        await handle.signal(shutdownSignal);
        await handle.result();
      });
    });

    it('non-conductor does not handle command signals', async function () {
      await withWorker(async () => {
        const handle = await startSession({
          metadata: playerMetadata({ playerId: 'not-cond' }),
        });

        // Sending a command to a non-conductor should not create history entries
        await handle.signal(commandSignal, {
          text: 'Should be ignored',
          source: 'test',
        });

        // historyQuery handler is only registered for conductors, so this
        // should return undefined or throw. We just verify no pending messages.
        const pending = await handle.query(pendingMessagesQuery);
        expect(pending).to.have.lengthOf(0);

        await handle.signal(shutdownSignal);
        await handle.result();
      });
    });
  });

  // ── Pre-created workflow (recruit pre-load) ──

  describe('pre-created workflow', function () {
    it('delivers pre-loaded initial message when session starts', async function () {
      await withWorker(async () => {
        // Simulate what recruit does: start workflow with pre-loaded messages
        const handle = await startSession({
          metadata: playerMetadata({ playerId: 'precreated-1', status: 'pending' }),
          messages: [{
            id: 'pre-msg-1',
            from: 'conductor',
            text: 'Review the auth module',
            timestamp: new Date().toISOString(),
            delivered: false,
          }],
        });

        // The pre-loaded message should be pending immediately
        const pending = await handle.query(pendingMessagesQuery);
        expect(pending).to.have.lengthOf(1);
        expect(pending[0].from).to.equal('conductor');
        expect(pending[0].text).to.equal('Review the auth module');
        expect(pending[0].delivered).to.equal(false);

        // All messages should include the pre-loaded one
        const all = await handle.query(allMessagesQuery);
        expect(all).to.have.lengthOf(1);
        expect(all[0].id).to.equal('pre-msg-1');

        await handle.signal(shutdownSignal);
        await handle.result();
      });
    });

    it('pre-loaded message can be delivered alongside new messages', async function () {
      await withWorker(async () => {
        const handle = await startSession({
          metadata: playerMetadata({ playerId: 'precreated-2', status: 'pending' }),
          messages: [{
            id: 'pre-msg-2',
            from: 'conductor',
            text: 'Initial task',
            timestamp: new Date().toISOString(),
            delivered: false,
          }],
        });

        // Send an additional message after startup
        await sendMessage(handle, 'alice', 'Follow-up question');

        const pending = await handle.query(pendingMessagesQuery);
        expect(pending).to.have.lengthOf(2);
        expect(pending[0].text).to.equal('Initial task');
        expect(pending[1].text).to.equal('Follow-up question');

        // Deliver the pre-loaded message
        await handle.signal(markDeliveredSignal, ['pre-msg-2']);

        const afterDelivery = await handle.query(pendingMessagesQuery);
        expect(afterDelivery).to.have.lengthOf(1);
        expect(afterDelivery[0].from).to.equal('alice');

        await handle.signal(shutdownSignal);
        await handle.result();
      });
    });
  });

  // ── Session status lifecycle ──

  describe('session status lifecycle', function () {
    it('starts with status from metadata', async function () {
      await withWorker(async () => {
        const handle = await startSession({
          metadata: playerMetadata({ playerId: 'status-init', status: 'pending' }),
        });

        const meta = await handle.query(getMetadataQuery);
        expect(meta.status).to.equal('pending');

        await handle.signal(shutdownSignal);
        await handle.result();
      });
    });

    it('defaults to active status when not specified', async function () {
      await withWorker(async () => {
        const handle = await startSession({
          metadata: playerMetadata({ playerId: 'status-default' }),
        });

        // The workflow upserts ClaudeTempoStatus with input.metadata.status || 'active'
        // but metadata.status itself remains undefined unless set
        const meta = await handle.query(getMetadataQuery);
        // status is undefined in metadata but search attribute defaults to 'active'
        expect(meta.status).to.satisfy((s: string | undefined) => s === undefined || s === 'active');

        await handle.signal(shutdownSignal);
        await handle.result();
      });
    });

    it('transitions from pending to active via updateMetadata signal', async function () {
      await withWorker(async () => {
        const handle = await startSession({
          metadata: playerMetadata({ playerId: 'status-transition', status: 'pending' }),
        });

        // Verify starts as pending
        let meta = await handle.query(getMetadataQuery);
        expect(meta.status).to.equal('pending');

        // Transition to active (simulates what server.ts does when session connects)
        await handle.signal(updateMetadataSignal, { status: 'active' });

        meta = await handle.query(getMetadataQuery);
        expect(meta.status).to.equal('active');

        await handle.signal(shutdownSignal);
        await handle.result();
      });
    });
  });

  // ── updateMetadata signal ──

  describe('updateMetadata', function () {
    it('updates hostname', async function () {
      await withWorker(async () => {
        const handle = await startSession({
          metadata: playerMetadata({ playerId: 'meta-host' }),
        });

        await handle.signal(updateMetadataSignal, { hostname: 'new-host' });
        const meta = await handle.query(getMetadataQuery);
        expect(meta.hostname).to.equal('new-host');

        await handle.signal(shutdownSignal);
        await handle.result();
      });
    });

    it('updates gitBranch and gitRoot', async function () {
      await withWorker(async () => {
        const handle = await startSession({
          metadata: playerMetadata({ playerId: 'meta-git' }),
        });

        await handle.signal(updateMetadataSignal, {
          gitBranch: 'feature/new',
          gitRoot: '/repos/project',
        });

        const meta = await handle.query(getMetadataQuery);
        expect(meta.gitBranch).to.equal('feature/new');
        expect(meta.gitRoot).to.equal('/repos/project');

        await handle.signal(shutdownSignal);
        await handle.result();
      });
    });

    it('updates multiple fields in a single signal', async function () {
      await withWorker(async () => {
        const handle = await startSession({
          metadata: playerMetadata({ playerId: 'meta-multi', status: 'pending' }),
        });

        await handle.signal(updateMetadataSignal, {
          hostname: 'prod-host',
          status: 'active',
          gitBranch: 'main',
        });

        const meta = await handle.query(getMetadataQuery);
        expect(meta.hostname).to.equal('prod-host');
        expect(meta.status).to.equal('active');
        expect(meta.gitBranch).to.equal('main');

        await handle.signal(shutdownSignal);
        await handle.result();
      });
    });

    it('does not overwrite fields not included in the update', async function () {
      await withWorker(async () => {
        const handle = await startSession({
          metadata: playerMetadata({ playerId: 'meta-partial' }),
        });

        // Update only hostname
        await handle.signal(updateMetadataSignal, { hostname: 'updated-host' });

        const meta = await handle.query(getMetadataQuery);
        expect(meta.hostname).to.equal('updated-host');
        // Original fields should be preserved
        expect(meta.playerId).to.equal('meta-partial');
        expect(meta.ensemble).to.equal('test-ensemble');
        expect(meta.isConductor).to.equal(false);

        await handle.signal(shutdownSignal);
        await handle.result();
      });
    });
  });
});
