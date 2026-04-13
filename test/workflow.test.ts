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
  markDeliveredSignal,
  recordSentMessageSignal,
  updateMetadataSignal,

  destroyUpdate,
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

        await handle.executeUpdate(destroyUpdate, { args: [{}] });
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

        await handle.executeUpdate(destroyUpdate, { args: [{}] });
        await handle.result();
      });
    });

    it('shuts down cleanly on shutdown signal', async function () {
      await withWorker(async () => {
        const handle = await startSession({
          metadata: playerMetadata({ playerId: 'shutdown-1' }),
        });
        await handle.executeUpdate(destroyUpdate, { args: [{}] });
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

        await handle.executeUpdate(destroyUpdate, { args: [{}] });
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

        await handle.executeUpdate(destroyUpdate, { args: [{}] });
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

        await handle.executeUpdate(destroyUpdate, { args: [{}] });
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

        await handle.executeUpdate(destroyUpdate, { args: [{}] });
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

        await handle.executeUpdate(destroyUpdate, { args: [{}] });
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

        await handle.executeUpdate(destroyUpdate, { args: [{}] });
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

        await handle.executeUpdate(destroyUpdate, { args: [{}] });
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

        await handle.executeUpdate(destroyUpdate, { args: [{}] });
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

        await handle.executeUpdate(destroyUpdate, { args: [{}] });
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

        await handle.executeUpdate(destroyUpdate, { args: [{}] });
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

        await handle.executeUpdate(destroyUpdate, { args: [{}] });
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

        await handle.executeUpdate(destroyUpdate, { args: [{}] });
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

        await handle.executeUpdate(destroyUpdate, { args: [{}] });
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

        await handle.executeUpdate(destroyUpdate, { args: [{}] });
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

        await handle.executeUpdate(destroyUpdate, { args: [{}] });
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

        await handle.executeUpdate(destroyUpdate, { args: [{}] });
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

        await handle.executeUpdate(destroyUpdate, { args: [{}] });
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

        await handle.executeUpdate(destroyUpdate, { args: [{}] });
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

        await handle.executeUpdate(destroyUpdate, { args: [{}] });
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

        await handle.executeUpdate(destroyUpdate, { args: [{}] });
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

        await handle.executeUpdate(destroyUpdate, { args: [{}] });
        await handle.result();
      });
    });
  });

  // ── Player type metadata (v0.10.0) ──

  describe('player type metadata', function () {
    it('stores playerType and playerTypeDescription from initial metadata', async function () {
      await withWorker(async () => {
        const handle = await startSession({
          metadata: playerMetadata({
            playerId: 'typed-player',
            playerType: 'tempo-soloist',
            playerTypeDescription: 'Senior engineer — implements features and fixes bugs',
          }),
        });

        const meta = await handle.query(getMetadataQuery);
        expect(meta.playerType).to.equal('tempo-soloist');
        expect(meta.playerTypeDescription).to.equal('Senior engineer — implements features and fixes bugs');

        await handle.executeUpdate(destroyUpdate, { args: [{}] });
        await handle.result();
      });
    });

    it('stores recruitedBy from initial metadata', async function () {
      await withWorker(async () => {
        const handle = await startSession({
          metadata: playerMetadata({
            playerId: 'recruited-player',
            recruitedBy: 'conductor',
          }),
        });

        const meta = await handle.query(getMetadataQuery);
        expect(meta.recruitedBy).to.equal('conductor');

        await handle.executeUpdate(destroyUpdate, { args: [{}] });
        await handle.result();
      });
    });

    it('updates playerType via updateMetadata signal', async function () {
      await withWorker(async () => {
        const handle = await startSession({
          metadata: playerMetadata({ playerId: 'type-update' }),
        });

        // Initially no playerType
        let meta = await handle.query(getMetadataQuery);
        expect(meta.playerType).to.be.undefined;

        // Update it
        await handle.signal(updateMetadataSignal, {
          playerType: 'tempo-critic',
          playerTypeDescription: 'Code reviewer',
        });

        meta = await handle.query(getMetadataQuery);
        expect(meta.playerType).to.equal('tempo-critic');
        expect(meta.playerTypeDescription).to.equal('Code reviewer');

        await handle.executeUpdate(destroyUpdate, { args: [{}] });
        await handle.result();
      });
    });

    it('does not overwrite unrelated metadata when updating playerType', async function () {
      await withWorker(async () => {
        const handle = await startSession({
          metadata: playerMetadata({
            playerId: 'type-partial-update',
            ensemble: 'test-ensemble',
          }),
        });

        await handle.signal(updateMetadataSignal, { playerType: 'tempo-tuner' });

        const meta = await handle.query(getMetadataQuery);
        expect(meta.playerType).to.equal('tempo-tuner');
        // Original fields preserved
        expect(meta.playerId).to.equal('type-partial-update');
        expect(meta.ensemble).to.equal('test-ensemble');
        expect(meta.isConductor).to.equal(false);

        await handle.executeUpdate(destroyUpdate, { args: [{}] });
        await handle.result();
      });
    });
  });

  // ── ClaudeTempoPlayerType search attribute ──

  describe('ClaudeTempoPlayerType search attribute', function () {
    /**
     * Poll describe() until the expected search attribute value appears.
     * The local TestWorkflowEnvironment propagates upsertSearchAttributes
     * asynchronously, so describe() can lag briefly after the workflow
     * executes the upsert call.
     */
    async function pollSearchAttr(
      handle: ReturnType<typeof startSession> extends Promise<infer H> ? H : never,
      attrName: string,
      expected: string[],
      maxMs = 5000,
    ): Promise<string[] | undefined> {
      const deadline = Date.now() + maxMs;
      while (Date.now() < deadline) {
        const desc = await handle.describe();
        const value = desc.searchAttributes?.[attrName] as string[] | undefined;
        if (value && value.length > 0) return value;
        await new Promise<void>((r) => setTimeout(r, 250));
      }
      // Final read — let the assertion produce the failure message
      const desc = await handle.describe();
      return desc.searchAttributes?.[attrName] as string[] | undefined;
    }

    it('sets ClaudeTempoPlayerType search attribute when playerType is in initial metadata', async function () {
      this.timeout(15_000);
      await withWorker(async () => {
        const handle = await startSession({
          metadata: playerMetadata({
            playerId: 'search-attr-init',
            playerType: 'tempo-soloist',
          }),
        });

        // Ensure the workflow has started by querying metadata first
        await handle.query(getMetadataQuery);

        // Poll until the search attribute propagates to describe()
        const value = await pollSearchAttr(handle, 'ClaudeTempoPlayerType', ['tempo-soloist']);
        expect(value).to.deep.equal(['tempo-soloist']);

        await handle.executeUpdate(destroyUpdate, { args: [{}] });
        await handle.result();
      });
    });

    it('updates ClaudeTempoPlayerType search attribute via updateMetadata signal', async function () {
      this.timeout(15_000);
      await withWorker(async () => {
        const handle = await startSession({
          metadata: playerMetadata({ playerId: 'search-attr-update' }),
        });

        // Ensure workflow is running, then update playerType
        await handle.query(getMetadataQuery);
        await handle.signal(updateMetadataSignal, { playerType: 'tempo-critic' });

        // Verify the update appears in metadata immediately (query round-trip)
        const meta = await handle.query(getMetadataQuery);
        expect(meta.playerType).to.equal('tempo-critic');

        // Poll until the search attribute propagates to describe()
        const value = await pollSearchAttr(handle, 'ClaudeTempoPlayerType', ['tempo-critic']);
        expect(value).to.deep.equal(['tempo-critic']);

        await handle.executeUpdate(destroyUpdate, { args: [{}] });
        await handle.result();
      });
    });
  });

  // ── Termination message (PR-H #132) ──
  //
  // v0.25.1 `updateMetadata({ status: 'terminated' })` compat shim is gone.
  // Destroy-audit-message semantics are covered by destroy.test.ts.

  // ── isMaestro flag (P2) ──

  describe('isMaestro flag on messages', function () {
    it('preserves isMaestro=true flag when set on incoming message', async function () {
      await withWorker(async () => {
        const handle = await startSession({
          metadata: playerMetadata({ playerId: 'maestro-flag-test' }),
        });

        await handle.signal(receiveMessageSignal, {
          from: 'maestro-dashboard',
          text: 'Attention: new task assigned',
          isMaestro: true,
        });
        await handle.signal(receiveMessageSignal, {
          from: 'alice',
          text: 'Regular peer message',
        });

        const messages = await handle.query(allMessagesQuery);
        expect(messages).to.have.lengthOf(2);

        const maestroMsg = messages.find((m) => m.from === 'maestro-dashboard');
        expect(maestroMsg!.isMaestro).to.equal(true);

        const peerMsg = messages.find((m) => m.from === 'alice');
        expect(peerMsg!.isMaestro).to.be.undefined;

        await handle.executeUpdate(destroyUpdate, { args: [{}] });
        await handle.result();
      });
    });
  });

  // ── recall — underlying query behavior ──
  //
  // The `recall` tool builds its timeline by querying `allMessages` and
  // `allSentMessages` directly. These tests verify the shape and ordering
  // that recall depends on — separate from the tool-layer filtering tests
  // in tools.test.ts.

  describe('recall — message query behavior', function () {
    it('allMessagesQuery returns empty array when no messages have been received', async function () {
      await withWorker(async () => {
        const handle = await startSession({
          metadata: playerMetadata({ playerId: 'recall-empty' }),
        });

        const msgs = await handle.query(allMessagesQuery);
        expect(msgs).to.be.an('array').with.lengthOf(0);

        await handle.executeUpdate(destroyUpdate, { args: [{}] });
        await handle.result();
      });
    });

    it('message entries have all fields recall needs: id, from, text, timestamp, delivered', async function () {
      await withWorker(async () => {
        const handle = await startSession({
          metadata: playerMetadata({ playerId: 'recall-shape' }),
        });

        await sendMessage(handle, 'alice', 'test message');
        const msgs = await handle.query(allMessagesQuery);

        expect(msgs).to.have.lengthOf(1);
        const m = msgs[0];
        expect(m).to.have.property('id').that.is.a('string').with.length.greaterThan(0);
        expect(m).to.have.property('from', 'alice');
        expect(m).to.have.property('text', 'test message');
        expect(m).to.have.property('timestamp').that.is.a('string');
        expect(m).to.have.property('delivered').that.is.a('boolean');
        // timestamp must be a valid ISO string — recall's "since" filter depends on it
        expect(Date.parse(m.timestamp)).to.not.be.NaN;

        await handle.executeUpdate(destroyUpdate, { args: [{}] });
        await handle.result();
      });
    });

    it('allMessagesQuery preserves insertion order (oldest first) — recall sorts from this', async function () {
      await withWorker(async () => {
        const handle = await startSession({
          metadata: playerMetadata({ playerId: 'recall-order' }),
        });

        await sendMessage(handle, 'a', 'first');
        await sendMessage(handle, 'b', 'second');
        await sendMessage(handle, 'c', 'third');

        const msgs = await handle.query(allMessagesQuery);
        expect(msgs).to.have.lengthOf(3);
        expect(msgs[0].text).to.equal('first');
        expect(msgs[1].text).to.equal('second');
        expect(msgs[2].text).to.equal('third');
        // Timestamps are non-decreasing — recall's sort relies on valid timestamps
        expect(Date.parse(msgs[2].timestamp)).to.be.at.least(Date.parse(msgs[0].timestamp));

        await handle.executeUpdate(destroyUpdate, { args: [{}] });
        await handle.result();
      });
    });

    it('allMessagesQuery includes both delivered and undelivered messages', async function () {
      await withWorker(async () => {
        const handle = await startSession({
          metadata: playerMetadata({ playerId: 'recall-delivery-mix' }),
        });

        await sendMessage(handle, 'alice', 'message 1');
        await sendMessage(handle, 'bob', 'message 2');

        // Deliver only the first message
        const before = await handle.query(allMessagesQuery);
        await handle.signal(markDeliveredSignal, [before[0].id]);

        const all = await handle.query(allMessagesQuery);
        expect(all).to.have.lengthOf(2);
        expect(all.find((m) => m.text === 'message 1')!.delivered).to.equal(true);
        expect(all.find((m) => m.text === 'message 2')!.delivered).to.equal(false);

        await handle.executeUpdate(destroyUpdate, { args: [{}] });
        await handle.result();
      });
    });

    it('allSentMessagesQuery returns sent messages with id, to, text, timestamp fields', async function () {
      await withWorker(async () => {
        const handle = await startSession({
          metadata: playerMetadata({ playerId: 'recall-sent-shape' }),
        });

        await handle.signal(recordSentMessageSignal, { to: 'bob', text: 'outgoing 1' });
        await handle.signal(recordSentMessageSignal, { to: 'carol', text: 'outgoing 2' });

        const sent = await handle.query(allSentMessagesQuery);
        expect(sent).to.have.lengthOf(2);
        const s = sent[0];
        expect(s).to.have.property('id').that.is.a('string');
        expect(s).to.have.property('to', 'bob');
        expect(s).to.have.property('text', 'outgoing 1');
        expect(s).to.have.property('timestamp').that.is.a('string');
        expect(Date.parse(s.timestamp)).to.not.be.NaN;

        await handle.executeUpdate(destroyUpdate, { args: [{}] });
        await handle.result();
      });
    });
  });

  // ── enableStaleDetection (P2) ──

  describe('enableStaleDetection flag', function () {
    it('re-enables stale detection via updateMetadata signal without disrupting other fields', async function () {
      this.timeout(15_000);
      await withWorker(async () => {
        const handle = await startSession({
          metadata: playerMetadata({ playerId: 'stale-enable-test' }),
          disableStaleDetection: true,
        });

        // Send the enableStaleDetection signal alongside a status update
        await handle.signal(updateMetadataSignal, {
          status: 'active',
          enableStaleDetection: true,
        });

        // Workflow should still be running and queryable
        const meta = await handle.query(getMetadataQuery);
        expect(meta.status).to.equal('active');
        expect(meta.playerId).to.equal('stale-enable-test');

        // Terminate — PR-C commit 4 retired the v0.24 drain-wait semantic. The
        // `updateMetadata({ status: 'terminated' })` shim now routes onto §2.5 destroy
        // (abandon in-flight, COMPLETE immediately). The post-terminate delivery poll
        // that the original test ran is no longer needed.
        await handle.executeUpdate(destroyUpdate, { args: [{ terminatedBy: 'test' }] });
        await handle.result();
      });
    });
  });

  describe('sessionId metadata', function () {
    it('stores sessionId via updateMetadata signal', async function () {
      await withWorker(async () => {
        const handle = await startSession({
          metadata: playerMetadata({ playerId: 'uuid-test' }),
        });

        const testUuid = '550e8400-e29b-41d4-a716-446655440000';
        await handle.signal(updateMetadataSignal, { sessionId: testUuid });

        const metadata = await handle.query(getMetadataQuery);
        expect(metadata.sessionId).to.equal(testUuid);

        await handle.executeUpdate(destroyUpdate, { args: [{}] });
        await handle.result();
      });
    });

    it('preserves sessionId from initial metadata', async function () {
      await withWorker(async () => {
        const testUuid = 'a1b2c3d4-e5f6-7890-abcd-ef1234567890';
        const handle = await startSession({
          metadata: playerMetadata({ playerId: 'uuid-init', sessionId: testUuid }),
        });

        const metadata = await handle.query(getMetadataQuery);
        expect(metadata.sessionId).to.equal(testUuid);

        // Other metadata updates should not clear sessionId
        await handle.signal(updateMetadataSignal, { hostname: 'new-host' });
        const updated = await handle.query(getMetadataQuery);
        expect(updated.sessionId).to.equal(testUuid);
        expect(updated.hostname).to.equal('new-host');

        await handle.executeUpdate(destroyUpdate, { args: [{}] });
        await handle.result();
      });
    });
  });
});
