import { expect } from 'chai';
import {
  setupTestEnv,
  teardownTestEnv,
  withWorker,
  getClient,
  startSession,
  sendMessage,
  playerMetadata,
  conductorMetadata,
  listEnsemble,
  resolveByName,
  setNameSignal,
  setPartSignal,
  shutdownSignal,
  getMetadataQuery,
  getPartQuery,
  pendingMessagesQuery,
  playerReportSignal,
} from './helpers';

describe('multi-session integration', function () {
  before(async function () {
    this.timeout(60_000);
    await setupTestEnv();
  });

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

        const members = await listEnsemble(getClient(), ensemble);
        const ids = members.map((m) => m.playerId).sort();
        expect(ids).to.deep.equal(['p1', 'p2']);

        await h1.signal(shutdownSignal);
        await h2.signal(shutdownSignal);
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

        const members = await listEnsemble(getClient(), 'ens-A');
        expect(members).to.have.lengthOf(1);
        expect(members[0].playerId).to.equal('in-scope');

        await h1.signal(shutdownSignal);
        await h2.signal(shutdownSignal);
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

        const members = await listEnsemble(getClient(), ensemble);
        expect(members).to.have.lengthOf(2);

        const conductor = members.find((m) => m.isConductor);
        expect(conductor).to.exist;
        expect(conductor!.playerId).to.equal('conductor');

        await hCond.signal(shutdownSignal);
        await hPlayer.signal(shutdownSignal);
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

        const resolved = await resolveByName(getClient(), ensemble, 'findme');
        expect(resolved).to.not.be.null;

        const meta = await resolved!.query(getMetadataQuery);
        expect(meta.playerId).to.equal('findme');

        await handle.signal(shutdownSignal);
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

        await handle.signal(shutdownSignal);
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
        const members = await listEnsemble(getClient(), ensemble);
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
        await hCond.signal(shutdownSignal);
        await hPlayer.signal(shutdownSignal);
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

        await hCond.signal(shutdownSignal);
        await hPlayer.signal(shutdownSignal);
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

        await h1.signal(shutdownSignal);
        await h2.signal(shutdownSignal);
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
        const members = await listEnsemble(getClient(), ensemble);
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
          await h.signal(shutdownSignal);
        }
        await Promise.all(handles.map((h) => h.result()));
      });
    });
  });
});
