import { expect } from 'chai';
import {
  setupSharedEnv,
  teardownTestEnv,
  withWorkerAndRecruitCapture,
  startOutboxWorker,
  startRecruitWorker,
  startSession,
  playerMetadata,
  conductorMetadata,
  getMetadataQuery,
  pendingMessagesQuery,
  allMessagesQuery,
  allSentMessagesQuery,
  submitOutboxUpdate,
  outboxQuery,
  attachmentInfoQuery,
  destroyUpdate,
  getClient,
  TASK_QUEUE,
} from './helpers';

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

describe('outbox', function () {
  before(setupSharedEnv);

  after(async function () {
    await teardownTestEnv();
  });

  // ────────────────────────────────────────────────────────────────────────
  // Flavor A — outbox-activities (12 tests share one worker)
  //
  // Every test in this block exercises the outbox-dispatch loop without
  // needing the recruit-side per-host stub set. Sharing one worker across
  // the whole describe drops 11×~2s of repeat spin-up under contended CI
  // runners — the heaviest cost #383 P3 audit identified.
  // ────────────────────────────────────────────────────────────────────────

  describe('outbox-activities flavor', function () {
    let stopWorker: () => Promise<void>;
    before(async function () {
      this.timeout(60_000);
      stopWorker = await startOutboxWorker();
    });
    after(async function () {
      await stopWorker();
    });

    // ── submitOutboxUpdate basics ──

    describe('submitOutboxUpdate basics', function () {
      it('returns an entry ID and records entry as pending', async function () {
        this.timeout(45_000);
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
        await handle.executeUpdate(destroyUpdate, { args: [{}] });
        await handle.result();
      });

      it('records cue in sentMessages', async function () {
        this.timeout(45_000);
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

        await handle.executeUpdate(destroyUpdate, { args: [{}] });
        await handle.result();
      });
    });

    // ── Outbox cue delivery ──

    describe('cue delivery', function () {
      it('delivers a cue message to the target session', async function () {
        this.timeout(45_000);
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
        await alice.executeUpdate(destroyUpdate, { args: [{}] });
        await bob.executeUpdate(destroyUpdate, { args: [{}] });
        await alice.result();
        await bob.result();
      });
    });

    // ── Outbox report delivery ──

    describe('report delivery', function () {
      it('delivers a report to the conductor', async function () {
        this.timeout(45_000);
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

        await player.executeUpdate(destroyUpdate, { args: [{}] });
        await conductor.executeUpdate(destroyUpdate, { args: [{}] });
        await player.result();
        await conductor.result();
      });
    });

    // ── Outbox stop delivery ──

    describe('stop delivery', function () {
      it('terminates the target session', async function () {
        this.timeout(45_000);
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

        // Bob's attachment phase transitions to `gone` via the `stop` outbox entry
        // triggering `destroyUpdate` on the target. Read the phase from the
        // `ClaudeTempoAttachmentState` search attribute — it persists on the
        // workflow description even after the workflow completes.
        const bobDesc = await bob.describe();
        const bobPhase = (bobDesc.searchAttributes?.ClaudeTempoAttachmentState as string[] | undefined)?.[0];
        expect(bobPhase).to.equal('gone');

        const aliceOutbox = await alice.query(outboxQuery);
        expect(aliceOutbox[0].status).to.equal('delivered');

        await alice.executeUpdate(destroyUpdate, { args: [{}] });
        // Bob is already terminated, just wait for completion
        await alice.result();
        await bob.result();
      });
    });

    // ── PR-D verb delivery (QA B1/B2/B3) ──

    describe('detach delivery (PR-D)', function () {
      it('dispatches deliverDetach and marks entry delivered', async function () {
        this.timeout(45_000);
        const alice = await startSession({ metadata: playerMetadata({ playerId: 'alice-detach' }) });
        const bob = await startSession({ metadata: playerMetadata({ playerId: 'bob-detach' }) });

        await alice.executeUpdate(submitOutboxUpdate, {
          args: [{ type: 'detach', targetPlayerId: 'bob-detach', deadlineMs: 1000 }],
        });

        await sleep(2000);

        const aliceOutbox = await alice.query(outboxQuery);
        const entry = aliceOutbox.find((e) => e.type === 'detach');
        expect(entry, 'detach entry exists').to.exist;
        expect(entry!.status).to.equal('delivered');

        await alice.executeUpdate(destroyUpdate, { args: [{}] });
        await bob.executeUpdate(destroyUpdate, { args: [{}] });
        await alice.result();
        await bob.result();
      });
    });

    describe('destroy delivery (PR-D)', function () {
      it('dispatches deliverDestroy and terminates the target', async function () {
        this.timeout(45_000);
        const alice = await startSession({ metadata: playerMetadata({ playerId: 'alice-destroy' }) });
        const bob = await startSession({ metadata: playerMetadata({ playerId: 'bob-destroy' }) });

        await alice.executeUpdate(submitOutboxUpdate, {
          args: [{ type: 'destroy', targetPlayerId: 'bob-destroy', reason: 'test', notifyConductor: false }],
        });

        await sleep(2000);

        const aliceOutbox = await alice.query(outboxQuery);
        const entry = aliceOutbox.find((e) => e.type === 'destroy');
        expect(entry, 'destroy entry exists').to.exist;
        expect(entry!.status).to.equal('delivered');

        // Bob should be destroyed — `isDestroyed` query returns true.
        const bobDestroyed = await bob.query('isDestroyed') as boolean;
        expect(bobDestroyed).to.be.true;

        await alice.executeUpdate(destroyUpdate, { args: [{}] });
        await alice.result();
        await bob.result();
      });
    });

    // ── Failure handling ──

    describe('failure handling', function () {
      it('marks entry as failed when target does not exist', async function () {
        this.timeout(60_000);
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

        await handle.executeUpdate(destroyUpdate, { args: [{}] });
        await handle.result();
      });
    });

    // ── Multiple entries ──

    describe('outboxQuery returns all entries', function () {
      it('returns entries of different types', async function () {
        this.timeout(45_000);
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

        await handle.executeUpdate(destroyUpdate, { args: [{}] });
        await handle.result();
      });
    });

    // ── Stop delivery with conductor notification ──

    describe('stop delivery (conductor notification)', function () {
      it('notifies conductor with a system message when a session is terminated', async function () {
        this.timeout(45_000);
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

        // Target's phase transitions to `gone` via the stop-delivery's destroyUpdate.
        // Read from the `ClaudeTempoAttachmentState` search attribute — survives completion.
        const targetDesc = await target.describe();
        const targetPhase = (targetDesc.searchAttributes?.ClaudeTempoAttachmentState as string[] | undefined)?.[0];
        expect(targetPhase).to.equal('gone');

        // Conductor should receive the system notification about the termination
        const conductorMessages = await conductor.query(allMessagesQuery);
        const notification = conductorMessages.find(
          (m) => m.from === 'system'
            && m.text.includes('stop-target')
            && m.text.includes('terminated'),
        );
        expect(notification).to.exist;

        await stopper.executeUpdate(destroyUpdate, { args: [{}] });
        await conductor.executeUpdate(destroyUpdate, { args: [{}] });
        await stopper.result();
        await conductor.result();
        // target already terminated — just await completion
        await target.result();
      });
    });

    // ── Report delivery failure (no conductor) ──

    describe('report delivery failure', function () {
      it('marks report entry as failed when no conductor is running', async function () {
        this.timeout(60_000);
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

        await handle.executeUpdate(destroyUpdate, { args: [{}] });
        await handle.result();
      });
    });

    // ── broadcast delivery (fan-out) ──

    describe('broadcast delivery', function () {
      it('delivers a broadcast message to all 3 target sessions via outbox fan-out', async function () {
        this.timeout(45_000);
        const ensemble = `broadcast-${Date.now()}`;

        const sender = await startSession({
          metadata: playerMetadata({ playerId: 'broadcaster', ensemble }),
        });
        const alice = await startSession({
          metadata: playerMetadata({ playerId: 'alice-bc', ensemble }),
        });
        const bob = await startSession({
          metadata: playerMetadata({ playerId: 'bob-bc', ensemble }),
        });
        const carol = await startSession({
          metadata: playerMetadata({ playerId: 'carol-bc', ensemble }),
        });

        // Submit 3 cue outbox entries (simulating what the broadcast tool does)
        for (const target of ['alice-bc', 'bob-bc', 'carol-bc']) {
          await sender.executeUpdate(submitOutboxUpdate, {
            args: [{ type: 'cue', targetPlayerId: target, message: 'broadcast hello' }],
          });
        }

        // Wait for dispatch loop to deliver all
        await sleep(3000);

        // Verify all 3 recipients received the message
        for (const [name, handle] of [['alice-bc', alice], ['bob-bc', bob], ['carol-bc', carol]] as const) {
          const msgs = await handle.query(pendingMessagesQuery);
          const match = msgs.find((m) => m.from === 'broadcaster' && m.text === 'broadcast hello');
          expect(match, `${name} should have received broadcast`).to.exist;
        }

        // Verify all outbox entries are delivered
        const outbox = await sender.query(outboxQuery);
        const cueEntries = outbox.filter((e) => e.type === 'cue');
        expect(cueEntries).to.have.length(3);
        for (const entry of cueEntries) {
          expect(entry.status).to.equal('delivered');
        }

        // Clean up
        await sender.executeUpdate(destroyUpdate, { args: [{}] });
        await alice.executeUpdate(destroyUpdate, { args: [{}] });
        await bob.executeUpdate(destroyUpdate, { args: [{}] });
        await carol.executeUpdate(destroyUpdate, { args: [{}] });
        await sender.result();
        await alice.result();
        await bob.result();
        await carol.result();
      });
    });
  });

  // ────────────────────────────────────────────────────────────────────────
  // Flavor B — recruit-activities (3 tests share one worker)
  //
  // These tests need the per-host stub for `spawnProcess` (recruit pipeline
  // routes activities to `claude-tempo-{hostname}`). They share a single
  // recruit-stub worker the same way Flavor A shares its outbox-stub one.
  // ────────────────────────────────────────────────────────────────────────

  describe('recruit-activities flavor', function () {
    let stopWorker: () => Promise<void>;
    before(async function () {
      this.timeout(60_000);
      stopWorker = await startRecruitWorker();
    });
    after(async function () {
      await stopWorker();
    });

    describe('restart delivery (PR-D)', function () {
      it('dispatches deliverRestart and marks entry delivered', async function () {
        this.timeout(45_000);
        const alice = await startSession({ metadata: playerMetadata({ playerId: 'alice-restart' }) });
        const bob = await startSession({ metadata: playerMetadata({ playerId: 'bob-restart' }) });

        await alice.executeUpdate(submitOutboxUpdate, {
          args: [{
            type: 'restart',
            targetPlayerId: 'bob-restart',
            invokerPlayerId: 'alice-restart',
            fresh: true,
          }],
        });

        await sleep(3000);

        const aliceOutbox = await alice.query(outboxQuery);
        const entry = aliceOutbox.find((e) => e.type === 'restart');
        expect(entry, 'restart entry exists').to.exist;
        expect(entry!.status).to.equal('delivered');

        await alice.executeUpdate(destroyUpdate, { args: [{}] });
        await bob.executeUpdate(destroyUpdate, { args: [{}] });
        await alice.result();
        await bob.result();
      });
    });

    describe('recruit delivery', function () {
      it('pre-creates session workflow with initial message, playerType, and recruitedBy', async function () {
        this.timeout(45_000);
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
        // Newly-recruited session boots in `booting` phase (no adapter attached yet).
        const info = await recruitedHandle.query(attachmentInfoQuery);
        expect(info.phase).to.equal('booting');
        expect(meta.ensemble).to.equal(ensemble);
        expect(meta.isConductor).to.equal(false);

        // Cleanup
        await handle.executeUpdate(destroyUpdate, { args: [{}] });
        await handle.result();
        await recruitedHandle.executeUpdate(destroyUpdate, { args: [{}] });
        try { await recruitedHandle.result(); } catch { /* cleanup */ }
      });

      it('recruit without initialMessage starts session with empty inbox', async function () {
        this.timeout(45_000);
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

        await handle.executeUpdate(destroyUpdate, { args: [{}] });
        await handle.result();
        await recruitedHandle.executeUpdate(destroyUpdate, { args: [{}] });
        try { await recruitedHandle.result(); } catch { /* cleanup */ }
      });
    });
  });

  // ────────────────────────────────────────────────────────────────────────
  // Flavor C — recruit-capture (3 tests stay per-it)
  //
  // Each of these tests needs a per-test `spawnInputs[]` closure passed
  // through `withWorkerAndRecruitCapture` so the test can assert on the
  // exact arguments passed to `spawnProcess`. Promoting to a shared worker
  // would require sharing the closure — which loses isolation between
  // tests and risks cross-test contamination — for ~6s residual savings.
  // Worth keeping per-it.
  // ────────────────────────────────────────────────────────────────────────

  describe('recruit-capture flavor', function () {
    describe('restart delivery (PR-D)', function () {
      it('#183 fresh restart regenerates sessionId and persists it to target metadata', async function () {
        this.timeout(45_000);
        const spawnInputs: Array<Record<string, unknown>> = [];
        await withWorkerAndRecruitCapture(spawnInputs, async () => {
          const ensemble = `fresh-sid-${Date.now()}`;
          const originalSessionId = 'original-uuid-from-a-failed-spawn';

          const alice = await startSession({
            metadata: playerMetadata({ playerId: 'alice-fresh-sid', ensemble }),
          });
          const bob = await startSession({
            metadata: playerMetadata({
              playerId: 'bob-fresh-sid',
              ensemble,
              sessionId: originalSessionId,
            }),
          });

          // Sanity: bob starts with the original sessionId.
          const before = await bob.query(getMetadataQuery) as { sessionId?: string };
          expect(before.sessionId).to.equal(originalSessionId);

          await alice.executeUpdate(submitOutboxUpdate, {
            args: [{
              type: 'restart',
              targetPlayerId: 'bob-fresh-sid',
              invokerPlayerId: 'alice-fresh-sid',
              fresh: true,
            }],
          });

          await sleep(3000);

          const aliceOutbox = await alice.query(outboxQuery);
          const entry = aliceOutbox.find((e) => e.type === 'restart');
          expect(entry, 'restart entry exists').to.exist;
          expect(entry!.status).to.equal('delivered');

          // The spawn should have received a NEW sessionId, not the collided one.
          expect(spawnInputs, 'spawnProcess was called').to.have.lengthOf.at.least(1);
          const spawn = spawnInputs[spawnInputs.length - 1];
          expect(spawn.sessionId, 'spawn sessionId set').to.be.a('string');
          expect(spawn.sessionId, 'spawn sessionId regenerated').to.not.equal(originalSessionId);
          expect(spawn.resume, 'fresh restart does not resume').to.equal(false);

          // Target's metadata should now reflect the new sessionId so future
          // (non-fresh) restarts resume against the new transcript.
          const after = await bob.query(getMetadataQuery) as { sessionId?: string };
          expect(after.sessionId).to.equal(spawn.sessionId);
          expect(after.sessionId).to.not.equal(originalSessionId);

          await alice.executeUpdate(destroyUpdate, { args: [{}] });
          await bob.executeUpdate(destroyUpdate, { args: [{}] });
          await alice.result();
          await bob.result();
        });
      });

      it('#183 non-fresh restart no longer special — also fresh after 17a7858 (#306)', async function () {
        this.timeout(45_000);
        // Pre-#306 this case was the inverse of the test above: a non-fresh
        // restart was supposed to preserve the stored sessionId and pass
        // `resume: true` so Claude Code could `--resume <uuid>` against the
        // existing transcript. Commit `17a7858` removed that branch — the
        // prior spawn's `.jsonl` is not guaranteed to have flushed before the
        // hard-terminate (Windows `taskkill /T /F` is synchronous), so resume
        // was failing with "No conversation found with session ID" and
        // dropping the new terminal to a shell.
        //
        // Now `deliverRestart` mints a fresh UUID and passes `resume: false`
        // on EVERY call regardless of `fresh`. The `fresh` flag's only
        // remaining effect is gating the Step 5 context-replay signal —
        // spawn-side state is identical. This test pins that invariant so a
        // future refactor can't silently re-introduce the `--resume` path.
        const spawnInputs: Array<Record<string, unknown>> = [];
        await withWorkerAndRecruitCapture(spawnInputs, async () => {
          const ensemble = `non-fresh-sid-${Date.now()}`;
          const originalSessionId = 'stored-uuid-pre-restart';

          const alice = await startSession({
            metadata: playerMetadata({ playerId: 'alice-non-fresh-sid', ensemble }),
          });
          const bob = await startSession({
            metadata: playerMetadata({
              playerId: 'bob-non-fresh-sid',
              ensemble,
              sessionId: originalSessionId,
            }),
          });

          await alice.executeUpdate(submitOutboxUpdate, {
            args: [{
              type: 'restart',
              targetPlayerId: 'bob-non-fresh-sid',
              invokerPlayerId: 'alice-non-fresh-sid',
              // no `fresh` — default (context replay still happens, but the
              // spawn is fresh).
            }],
          });

          await sleep(3000);

          const aliceOutbox = await alice.query(outboxQuery);
          const entry = aliceOutbox.find((e) => e.type === 'restart');
          expect(entry!.status).to.equal('delivered');

          // Even without `fresh: true`, the spawn gets a NEW sessionId and
          // resume=false — matches the fresh-restart test above.
          expect(spawnInputs).to.have.lengthOf.at.least(1);
          const spawn = spawnInputs[spawnInputs.length - 1];
          expect(spawn.sessionId, 'spawn sessionId set').to.be.a('string');
          expect(spawn.sessionId, 'non-fresh restart also regenerates sessionId').to.not.equal(originalSessionId);
          expect(spawn.resume, 'non-fresh restart no longer resumes').to.equal(false);

          // Metadata is updated to the new sessionId, same as the fresh case.
          const after = await bob.query(getMetadataQuery) as { sessionId?: string };
          expect(after.sessionId).to.equal(spawn.sessionId);
          expect(after.sessionId).to.not.equal(originalSessionId);

          await alice.executeUpdate(destroyUpdate, { args: [{}] });
          await bob.executeUpdate(destroyUpdate, { args: [{}] });
          await alice.result();
          await bob.result();
        });
      });
    });

    describe('recruit delivery', function () {
      it('forwards claudeBin from outbox entry to spawnProcess', async function () {
        this.timeout(45_000);
        const spawnInputs: Array<Record<string, unknown>> = [];
        await withWorkerAndRecruitCapture(spawnInputs, async () => {
          const ensemble = `recruit-bin-${Date.now()}`;

          const handle = await startSession({
            metadata: playerMetadata({ playerId: 'recruiter-bin', ensemble }),
            temporalConfig: {
              temporalAddress: '',
              temporalNamespace: 'default',
              taskQueue: TASK_QUEUE,
            },
          });

          await handle.executeUpdate(submitOutboxUpdate, {
            args: [{
              type: 'recruit',
              targetName: 'bin-player',
              workDir: '/tmp/test',
              isConductor: false,
              agent: 'claude',
              claudeBin: '/custom/path/to/claude',
            }],
          });

          // Wait for dispatch loop to process the recruit entry
          await sleep(3000);

          // Outbox entry should be delivered
          const outboxEntries = await handle.query(outboxQuery);
          const recruitEntry = outboxEntries.find((e) => e.type === 'recruit');
          expect(recruitEntry).to.exist;
          expect(recruitEntry!.status).to.equal('delivered');

          // spawnProcess should have been called with claudeBin
          expect(spawnInputs).to.have.lengthOf(1);
          expect(spawnInputs[0].claudeBin).to.equal('/custom/path/to/claude');

          // Cleanup
          await handle.executeUpdate(destroyUpdate, { args: [{}] });
          await handle.result();
          const recruitedHandle = getClient().workflow.getHandle(
            `claude-session-${ensemble}-bin-player`,
          );
          await recruitedHandle.executeUpdate(destroyUpdate, { args: [{}] });
          try { await recruitedHandle.result(); } catch { /* cleanup */ }
        });
      });
    });
  });

});
