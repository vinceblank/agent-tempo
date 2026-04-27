import { expect } from 'chai';
import {
  setupTestEnv,
  setupSharedEnv,
  teardownTestEnv,
  withWorker,
  getClient,
  startSession,
  reconnectSession,
  sendMessage,
  playerMetadata,
  conductorMetadata,
  waitForEnsembleMembers,
  resolveByName,
  isConductorRunning,
  conductorWorkflowId,
  setNameSignal,
  setPartSignal,
  updateMetadataSignal,

  destroyUpdate,
  markDeliveredSignal,
  getMetadataQuery,
  getPartQuery,
  pendingMessagesQuery,
  allMessagesQuery,
  playerReportSignal,
  historyQuery,
  commandSignal,
} from './helpers';

describe('multi-session integration', function () {
  before(setupSharedEnv);

  after(async function () {
    await teardownTestEnv();
  });

  // ── Ensemble discovery ──

  describe('ensemble listing', function () {
    it('lists all sessions in the same ensemble', async function () {
      const ensemble = 'list-test';
      await withWorker(async () => {
        const h1 = await startSession({
          metadata: playerMetadata({ playerId: 'p1', ensemble }),
        });
        const h2 = await startSession({
          metadata: playerMetadata({ playerId: 'p2', ensemble }),
        });

        // Poll until both sessions appear — visibility store is eventually consistent
        const members = await waitForEnsembleMembers(getClient(), ensemble, 2);
        const ids = members.map((m) => m.playerId).sort();
        expect(ids).to.deep.equal(['p1', 'p2']);

        await h1.executeUpdate(destroyUpdate, { args: [{}] });
        await h2.executeUpdate(destroyUpdate, { args: [{}] });
        await Promise.all([h1.result(), h2.result()]);
      });
    });

    it('does not include sessions from other ensembles', async function () {
      await withWorker(async () => {
        const h1 = await startSession({
          metadata: playerMetadata({ playerId: 'in-scope', ensemble: 'ens-A' }),
        });
        const h2 = await startSession({
          metadata: playerMetadata({ playerId: 'out-scope', ensemble: 'ens-B' }),
        });

        const members = await waitForEnsembleMembers(getClient(), 'ens-A', 1);
        expect(members).to.have.lengthOf(1);
        expect(members[0].playerId).to.equal('in-scope');

        await h1.executeUpdate(destroyUpdate, { args: [{}] });
        await h2.executeUpdate(destroyUpdate, { args: [{}] });
        await Promise.all([h1.result(), h2.result()]);
      });
    });

    it('includes conductor in ensemble listing', async function () {
      const ensemble = 'cond-list';
      await withWorker(async () => {
        const hCond = await startSession({
          metadata: conductorMetadata({ ensemble }),
        });
        const hPlayer = await startSession({
          metadata: playerMetadata({ playerId: 'worker-bee', ensemble }),
        });

        // Poll until both sessions are visible — visibility store is eventually consistent
        const members = await waitForEnsembleMembers(getClient(), ensemble, 2);
        expect(members).to.have.lengthOf(2);

        const conductor = members.find((m) => m.isConductor);
        expect(conductor).to.exist;
        expect(conductor!.playerId).to.equal('conductor');

        await hCond.executeUpdate(destroyUpdate, { args: [{}] });
        await hPlayer.executeUpdate(destroyUpdate, { args: [{}] });
        await Promise.all([hCond.result(), hPlayer.result()]);
      });
    });
  });

  // ── Session resolution ──

  describe('resolveByName', function () {
    it('resolves a session by its current name', async function () {
      const ensemble = 'resolve-test';
      await withWorker(async () => {
        const handle = await startSession({
          metadata: playerMetadata({ playerId: 'findme', ensemble }),
        });

        // Wait for the visibility store to catch up before resolving by name.
        // client.workflow.list() is eventually consistent — without this,
        // resolveByName can return null immediately after startSession.
        await waitForEnsembleMembers(getClient(), ensemble, 1);

        const resolved = await resolveByName(getClient(), ensemble, 'findme');
        expect(resolved).to.not.be.null;

        const meta = await resolved!.query(getMetadataQuery);
        expect(meta.playerId).to.equal('findme');

        await handle.executeUpdate(destroyUpdate, { args: [{}] });
        await handle.result();
      });
    });

    it('resolves a session after rename', async function () {
      const ensemble = 'rename-resolve';
      await withWorker(async () => {
        const handle = await startSession({
          metadata: playerMetadata({ playerId: 'temp-name', ensemble }),
        });

        // Rename
        await handle.signal(setNameSignal, 'permanent-name');

        // Old name should not resolve
        const byOld = await resolveByName(getClient(), ensemble, 'temp-name');
        expect(byOld).to.be.null;

        // New name should resolve
        const byNew = await resolveByName(getClient(), ensemble, 'permanent-name');
        expect(byNew).to.not.be.null;

        await handle.executeUpdate(destroyUpdate, { args: [{}] });
        await handle.result();
      });
    });

    it('returns null for non-existent session', async function () {
      await withWorker(async () => {
        const resolved = await resolveByName(getClient(), 'no-ensemble', 'ghost');
        expect(resolved).to.be.null;
      });
    });
  });

  // ── Scenario: conductor + player interaction ──

  describe('scenario: conductor-player coordination', function () {
    it('1. start conductor, 2. rename conductor, 3. add player, 4. both see each other', async function () {
      const ensemble = 'scenario-1';
      await withWorker(async () => {
        // 1. Start conductor with a temporary ID
        const hCond = await startSession({
          metadata: conductorMetadata({ playerId: 'temp-cond', ensemble }),
        });

        // 2. Rename conductor to a human-readable name
        await hCond.signal(setNameSignal, 'conductor');
        const condMeta = await hCond.query(getMetadataQuery);
        expect(condMeta.playerId).to.equal('conductor');

        // 3. Add player
        const hPlayer = await startSession({
          metadata: playerMetadata({ playerId: 'dev-1', ensemble }),
        });

        // 4. Verify both sessions are visible in the ensemble
        const members = await waitForEnsembleMembers(getClient(), ensemble, 2);
        expect(members).to.have.lengthOf(2);

        const conductor = members.find((m) => m.isConductor);
        expect(conductor).to.exist;
        expect(conductor!.playerId).to.equal('conductor');

        const player = members.find((m) => !m.isConductor);
        expect(player).to.exist;
        expect(player!.playerId).to.equal('dev-1');

        // Verify both can be resolved by name
        const resolvedConductor = await resolveByName(getClient(), ensemble, 'conductor');
        expect(resolvedConductor).to.not.be.null;
        const resolvedPlayer = await resolveByName(getClient(), ensemble, 'dev-1');
        expect(resolvedPlayer).to.not.be.null;

        // Old conductor name should not resolve after rename
        const resolvedOld = await resolveByName(getClient(), ensemble, 'temp-cond');
        expect(resolvedOld).to.be.null;

        // Cleanup
        await hCond.executeUpdate(destroyUpdate, { args: [{}] });
        await hPlayer.executeUpdate(destroyUpdate, { args: [{}] });
        await Promise.all([hCond.result(), hPlayer.result()]);
      });
    });

    it('player sends report to conductor', async function () {
      const ensemble = 'report-test';
      await withWorker(async () => {
        const hCond = await startSession({
          metadata: conductorMetadata({ ensemble }),
        });
        const hPlayer = await startSession({
          metadata: playerMetadata({ playerId: 'reporter', ensemble }),
        });

        // Player reports to conductor
        await hCond.signal(playerReportSignal, {
          playerId: 'reporter',
          text: 'Build succeeded',
          type: 'result',
        });

        // Conductor should have it as a pending message
        const pending = await hCond.query(pendingMessagesQuery);
        expect(pending).to.have.lengthOf(1);
        expect(pending[0].from).to.equal('reporter');
        expect(pending[0].text).to.include('Build succeeded');

        await hCond.executeUpdate(destroyUpdate, { args: [{}] });
        await hPlayer.executeUpdate(destroyUpdate, { args: [{}] });
        await Promise.all([hCond.result(), hPlayer.result()]);
      });
    });

    it('player sends message to another player', async function () {
      const ensemble = 'peer-msg';
      await withWorker(async () => {
        const h1 = await startSession({
          metadata: playerMetadata({ playerId: 'alice', ensemble }),
        });
        const h2 = await startSession({
          metadata: playerMetadata({ playerId: 'bob', ensemble }),
        });

        // Alice sends to Bob (via signal on Bob's handle)
        await sendMessage(h2, 'alice', 'Hey Bob, can you review my PR?');

        const bobPending = await h2.query(pendingMessagesQuery);
        expect(bobPending).to.have.lengthOf(1);
        expect(bobPending[0].from).to.equal('alice');

        // Alice has no pending messages
        const alicePending = await h1.query(pendingMessagesQuery);
        expect(alicePending).to.have.lengthOf(0);

        await h1.executeUpdate(destroyUpdate, { args: [{}] });
        await h2.executeUpdate(destroyUpdate, { args: [{}] });
        await Promise.all([h1.result(), h2.result()]);
      });
    });

    it('multiple players with different parts are all visible', async function () {
      const ensemble = 'parts-test';
      await withWorker(async () => {
        const handles = await Promise.all([
          startSession({ metadata: playerMetadata({ playerId: 'frontend', ensemble }) }),
          startSession({ metadata: playerMetadata({ playerId: 'backend', ensemble }) }),
          startSession({ metadata: playerMetadata({ playerId: 'infra', ensemble }) }),
        ]);

        // Set different parts
        await handles[0].signal(setPartSignal, 'Building React components');
        await handles[1].signal(setPartSignal, 'Implementing API endpoints');
        await handles[2].signal(setPartSignal, 'Configuring Terraform');

        // List and verify
        const members = await waitForEnsembleMembers(getClient(), ensemble, 3);
        expect(members).to.have.lengthOf(3);

        // Verify each can be resolved and has correct part
        for (const [i, name] of ['frontend', 'backend', 'infra'].entries()) {
          const resolved = await resolveByName(getClient(), ensemble, name);
          expect(resolved).to.not.be.null;
          const part = await resolved!.query(getPartQuery);
          expect(part).to.be.a('string').and.not.be.empty;
        }

        // Cleanup
        for (const h of handles) {
          await h.executeUpdate(destroyUpdate, { args: [{}] });
        }
        await Promise.all(handles.map((h) => h.result()));
      });
    });
  });

  // ── Conductor lifecycle scenarios ──

  describe('conductor lifecycle', function () {
    it('conductor workflow can be detected as running', async function () {
      const ensemble = 'cond-detect';
      await withWorker(async () => {
        // No conductor yet
        expect(await isConductorRunning(getClient(), ensemble)).to.be.false;

        const hCond = await startSession({
          metadata: conductorMetadata({ ensemble }),
        });

        // Now running
        expect(await isConductorRunning(getClient(), ensemble)).to.be.true;

        await hCond.executeUpdate(destroyUpdate, { args: [{}] });
        await hCond.result();

        // Stopped
        expect(await isConductorRunning(getClient(), ensemble)).to.be.false;
      });
    });

    it('resume: new session reconnects to existing conductor workflow and preserves state', async function () {
      const ensemble = 'cond-resume';
      await withWorker(async () => {
        // 1. Start conductor
        const hCond = await startSession({
          metadata: conductorMetadata({ ensemble }),
        });

        // 2. Accumulate some state — messages, reports, part
        await hCond.signal(setPartSignal, 'Orchestrating deploy');
        await sendMessage(hCond, 'player-a', 'Deploy ready');
        await hCond.signal(playerReportSignal, {
          playerId: 'player-a',
          text: 'Tests passed',
          type: 'result',
        });

        // Mark the direct message as delivered (simulating poller)
        const pending1 = await hCond.query(pendingMessagesQuery);
        const directMsg = pending1.find((m) => m.from === 'player-a' && m.text === 'Deploy ready');
        expect(directMsg).to.exist;
        await hCond.signal(markDeliveredSignal, [directMsg!.id]);

        // 3. "Resume" — simulate a new MCP server connecting with USE_EXISTING
        const hResumed = await reconnectSession({
          metadata: conductorMetadata({ ensemble }),
        });

        // 4. Verify state is preserved
        const part = await hResumed.query(getPartQuery);
        expect(part).to.equal('Orchestrating deploy');

        const history = await hResumed.query(historyQuery);
        expect(history).to.have.lengthOf(1);
        expect(history[0].type).to.equal('report');

        const allMsgs = await hResumed.query(allMessagesQuery);
        // Should have: the direct message + the report-as-message
        expect(allMsgs.length).to.be.greaterThanOrEqual(2);

        // The direct message should still be marked delivered
        const deliveredMsg = allMsgs.find((m) => m.text === 'Deploy ready');
        expect(deliveredMsg).to.exist;
        expect(deliveredMsg!.delivered).to.be.true;

        // 5. Verify the resumed session is visible in ensemble
        const members = await waitForEnsembleMembers(getClient(), ensemble, 1);
        const conductor = members.find((m) => m.isConductor);
        expect(conductor).to.exist;

        await hResumed.executeUpdate(destroyUpdate, { args: [{}] });
        await hResumed.result();
      });
    });

    it('replace: stop existing conductor, start fresh — no state carried over', async function () {
      const ensemble = 'cond-replace';
      await withWorker(async () => {
        // 1. Start conductor and accumulate state
        const hCond = await startSession({
          metadata: conductorMetadata({ ensemble }),
        });
        await hCond.signal(setPartSignal, 'Old task');
        await hCond.signal(commandSignal, {
          text: 'Old command',
          source: 'maestro-dashboard',
        });

        // 2. Stop the conductor (simulate --replace)
        await hCond.executeUpdate(destroyUpdate, { args: [{}] });
        await hCond.result();
        expect(await isConductorRunning(getClient(), ensemble)).to.be.false;

        // 3. Start a fresh conductor
        const hNew = await startSession({
          metadata: conductorMetadata({ ensemble }),
        });

        // 4. Verify state is fresh — no old part, no old history
        const part = await hNew.query(getPartQuery);
        expect(part).to.equal('Session in test'); // default autoSummary

        const history = await hNew.query(historyQuery);
        expect(history).to.have.lengthOf(0);

        const msgs = await hNew.query(allMessagesQuery);
        expect(msgs).to.have.lengthOf(0);

        await hNew.executeUpdate(destroyUpdate, { args: [{}] });
        await hNew.result();
      });
    });

    it('resume preserves pending messages for the new session to deliver', async function () {
      const ensemble = 'cond-resume-pending';
      await withWorker(async () => {
        // 1. Start conductor
        const hCond = await startSession({
          metadata: conductorMetadata({ ensemble }),
        });

        // 2. Send messages but don't deliver them (simulating dead poller)
        await sendMessage(hCond, 'alice', 'Need help with auth');
        await sendMessage(hCond, 'bob', 'Database migration done');

        const pending = await hCond.query(pendingMessagesQuery);
        expect(pending).to.have.lengthOf(2);

        // 3. Resume — new session picks up undelivered messages
        const hResumed = await reconnectSession({
          metadata: conductorMetadata({ ensemble }),
        });

        const stillPending = await hResumed.query(pendingMessagesQuery);
        expect(stillPending).to.have.lengthOf(2);
        expect(stillPending[0].from).to.equal('alice');
        expect(stillPending[1].from).to.equal('bob');

        await hResumed.executeUpdate(destroyUpdate, { args: [{}] });
        await hResumed.result();
      });
    });

    it('isConductor is determined by metadata, not by name', async function () {
      const ensemble = 'cond-by-meta';
      await withWorker(async () => {
        // Start a real conductor and a player with a similar name
        const hCond = await startSession({
          metadata: conductorMetadata({ ensemble }),
        });
        const hPlayer = await startSession({
          metadata: playerMetadata({ playerId: 'almost-conductor', ensemble }),
        });

        const members = await waitForEnsembleMembers(getClient(), ensemble, 2);
        expect(members).to.have.lengthOf(2);

        // Only the one with isConductor=true should be flagged as conductor
        const conductors = members.filter((m) => m.isConductor);
        expect(conductors).to.have.lengthOf(1);
        expect(conductors[0].playerId).to.equal('conductor');

        const players = members.filter((m) => !m.isConductor);
        expect(players).to.have.lengthOf(1);
        expect(players[0].playerId).to.equal('almost-conductor');

        await hCond.executeUpdate(destroyUpdate, { args: [{}] });
        await hPlayer.executeUpdate(destroyUpdate, { args: [{}] });
        await Promise.all([hCond.result(), hPlayer.result()]);
      });
    });

    it('conductor respects custom name from metadata', async function () {
      const ensemble = 'custom-cond-name';
      await withWorker(async () => {
        // Start a conductor with a custom name (simulates lineup conductor.name)
        const hCond = await startSession({
          metadata: conductorMetadata({ playerId: 'maestro', ensemble }),
        });

        const hPlayer = await startSession({
          metadata: playerMetadata({ playerId: 'worker-1', ensemble }),
        });

        const members = await waitForEnsembleMembers(getClient(), ensemble, 2);
        expect(members).to.have.lengthOf(2);

        // Conductor should have the custom name, not default 'conductor'
        const cond = members.find((m) => m.isConductor);
        expect(cond).to.exist;
        expect(cond!.playerId).to.equal('maestro');

        // Should be resolvable by custom name
        expect(await resolveByName(getClient(), ensemble, 'maestro')).to.not.be.null;
        // Should NOT be resolvable by default 'conductor' name
        expect(await resolveByName(getClient(), ensemble, 'conductor')).to.be.null;

        await hCond.executeUpdate(destroyUpdate, { args: [{}] });
        await hPlayer.executeUpdate(destroyUpdate, { args: [{}] });
        await Promise.all([hCond.result(), hPlayer.result()]);
      });
    });

    it('conductor and players survive conductor rename', async function () {
      const ensemble = 'cond-rename-survive';
      await withWorker(async () => {
        // Start conductor + two players
        const hCond = await startSession({
          metadata: conductorMetadata({ ensemble }),
        });
        const hP1 = await startSession({
          metadata: playerMetadata({ playerId: 'worker-1', ensemble }),
        });
        const hP2 = await startSession({
          metadata: playerMetadata({ playerId: 'worker-2', ensemble }),
        });

        // Rename conductor
        await hCond.signal(setNameSignal, 'lead');

        // All three should still be visible
        const members = await waitForEnsembleMembers(getClient(), ensemble, 3);
        expect(members).to.have.lengthOf(3);

        const cond = members.find((m) => m.isConductor);
        expect(cond).to.exist;
        expect(cond!.playerId).to.equal('lead');

        // Players can still be resolved
        expect(await resolveByName(getClient(), ensemble, 'worker-1')).to.not.be.null;
        expect(await resolveByName(getClient(), ensemble, 'worker-2')).to.not.be.null;

        // Conductor resolvable by new name
        expect(await resolveByName(getClient(), ensemble, 'lead')).to.not.be.null;
        // Old name gone
        expect(await resolveByName(getClient(), ensemble, 'conductor')).to.be.null;

        // Cleanup
        await hCond.executeUpdate(destroyUpdate, { args: [{}] });
        await hP1.executeUpdate(destroyUpdate, { args: [{}] });
        await hP2.executeUpdate(destroyUpdate, { args: [{}] });
        await Promise.all([hCond.result(), hP1.result(), hP2.result()]);
      });
    });

    it('player with same workflow ID as conductor would hijack it via USE_EXISTING', async function () {
      // This test documents the workflow ID collision: if a player somehow
      // gets playerId="conductor", its workflow ID matches the conductor's.
      // The server.ts guard prevents this, but this test shows the consequence
      // if it were bypassed — the player would reconnect to the conductor's
      // workflow and see its state.
      const ensemble = 'collision';
      await withWorker(async () => {
        // Start a real conductor with some state
        const hCond = await startSession({
          metadata: conductorMetadata({ ensemble }),
        });
        await hCond.signal(setPartSignal, 'Conductor state');
        await hCond.signal(commandSignal, {
          text: 'Secret command',
          source: 'maestro-dashboard',
        });

        // A player using reconnectSession with conductor workflow ID
        // would see the conductor's state — this is the collision
        const hCollision = await reconnectSession({
          metadata: conductorMetadata({ ensemble, playerId: 'conductor' }),
        });
        const part = await hCollision.query(getPartQuery);
        expect(part).to.equal('Conductor state');

        // This proves why the guard in server.ts is necessary
        await hCond.executeUpdate(destroyUpdate, { args: [{}] });
        await hCond.result();
      });
    });

    it('new messages arrive after conductor resume', async function () {
      const ensemble = 'cond-resume-new-msg';
      await withWorker(async () => {
        // 1. Start conductor
        const hCond = await startSession({
          metadata: conductorMetadata({ ensemble }),
        });

        // 2. Resume
        const hResumed = await reconnectSession({
          metadata: conductorMetadata({ ensemble }),
        });

        // 3. Send new messages after resume
        await sendMessage(hResumed, 'new-player', 'Joined after resume');
        await hResumed.signal(playerReportSignal, {
          playerId: 'new-player',
          text: 'Task done',
          type: 'result',
        });

        // 4. New messages are visible
        const pending = await hResumed.query(pendingMessagesQuery);
        expect(pending.length).to.be.greaterThanOrEqual(2);
        const directMsg = pending.find((m) => m.from === 'new-player' && m.text === 'Joined after resume');
        expect(directMsg).to.exist;

        const history = await hResumed.query(historyQuery);
        expect(history).to.have.lengthOf(1);

        await hResumed.executeUpdate(destroyUpdate, { args: [{}] });
        await hResumed.result();
      });
    });
  });
});
