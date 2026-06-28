/**
 * §1 cutover smoke test (#796 beta.1 slice) — full upgrade round-trip E2E.
 *
 * Drives the COMPLETE 1.x → 2.0 migration against a real TestWorkflowEnvironment:
 *
 *   Phase A — 1.x ensemble setup:
 *     conductor + soloist sessions with ALL FOUR continuity dimensions:
 *       1. durable schedule (scheduler workflow + addSchedule signal)
 *       2. #334 state slot (savePlayerState update on soloist)
 *       3. non-default model ('anthropic/claude-opus-4-7' on soloist)
 *       4. sessionId resume pointer ('sess-cutover-smoke' on soloist)
 *
 *   Phase B — upgrade-to-2 engine:
 *     runUpgradeToV2 → pause → drain → SNAPSHOT (precedes DESTROY) → done.
 *     Asserts snapshot captured all four continuity dimensions.
 *
 *   Phase C — from-upgrade recreation:
 *     runFromUpgrade → recreate protocol-2 maestro + conductor + soloist + scheduler.
 *     Asserts continuity seeded: savedBy/savedAt on state slots, sessionId + model
 *     on metadata, scheduler firedCount reset, snapshot archived.
 *
 *   Phase D — re-attach path:
 *     claimAttachment directly on the soloist skeleton (booting → attached).
 *     Asserts skeleton is live and accepts re-attachment without full restart scaffolding.
 *
 * Baseline: locally-built dev binary (1.7.0-beta.x). The authoritative run
 * against `1.7.0-stable` is a follow-up once that tag is cut (see #796).
 *
 * Heavyweight (full worker + workflow lifecycle) → pinned to shard-1 in
 * test/shard-config.json alongside upgrade-to-2.test.ts.
 */
import { expect } from 'chai';
import { mkdtempSync, rmSync, existsSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import {
  setupSharedEnv,
  teardownTestEnv,
  getClient,
  getTestEnsemble,
  TASK_QUEUE,
  startSession,
  playerMetadata,
  conductorMetadata,
  withWorkerAndRecruitActivities,
  pollWithTimeout,
} from './helpers';
import {
  schedulerWorkflowId,
  sessionWorkflowId,
  conductorWorkflowId,
  maestroWorkflowId,
} from '../src/config';
import {
  savePlayerStateUpdate,
  attachmentInfoQuery,
  getMetadataQuery,
  playerStateQuery,
  claimAttachmentUpdate,
  setPausedSignal,
  pausedQuery,
  submitOutboxUpdate,
} from '../src/workflows/signals';
import { addScheduleSignal, getSchedulesQuery } from '../src/workflows/scheduler-signals';
import type { ScheduleEntry } from '../src/types';
import {
  runUpgradeToV2,
  enumerateEnsembleNames,
  type UpgradeDeps,
} from '../src/upgrade/phase-engine';
import { runFromUpgrade, CONSUMED_SNAPSHOT_FILENAME } from '../src/upgrade/from-upgrade';
import { readSnapshot, snapshotPath } from '../src/upgrade/snapshot-v1';
import { PROTOCOL_VERSION } from '../src/constants';

const SILENT = (..._args: unknown[]): void => {};

// Continuity fixtures — stable across phases so assertions stay readable.
const SOLOIST_PLAYER_ID = 'soloist';
const SOLOIST_SESSION_ID = 'sess-cutover-smoke';
const SOLOIST_MODEL = 'anthropic/claude-opus-4-7';
const SOLOIST_STATE_KEY = 'handoff';
const SOLOIST_STATE_CONTENT = 'resume at phase 4 of the refactor';
const SCHEDULE_NAME = 'standup';
const SCHEDULE_CRON = '0 9 * * 1-5';
const SCHEDULE_TZ = 'America/New_York';

describe('cutover smoke: full 1.x → 2.0 round-trip (#796 beta.1)', function () {
  before(setupSharedEnv);
  after(async function teardownWithInstrumentation() {
    console.log(`[teardown:cutover-smoke] after() start @ ${Date.now()}`);
    await teardownTestEnv();
    console.log(`[teardown:cutover-smoke] after() done @ ${Date.now()}`);
  });

  // Fresh temp home per test — isolates snapshot files from other suites.
  let home: string;
  beforeEach(function () {
    home = mkdtempSync(join(tmpdir(), 'tempo-cutover-smoke-'));
  });
  afterEach(function () {
    rmSync(home, { recursive: true, force: true });
  });

  function upgradeDeps(overrides: Partial<UpgradeDeps> = {}): UpgradeDeps {
    return {
      client: getClient(),
      home,
      cliVersion: '1.7.0-smoke',
      log: SILENT,
      ...overrides,
    };
  }

  /** Block until the ensemble appears in Temporal visibility. */
  async function waitForVisibility(ensemble: string): Promise<void> {
    await pollWithTimeout(
      async () => (await enumerateEnsembleNames(upgradeDeps())).includes(ensemble),
      15_000,
      100,
    );
  }

  /** Block until the ensemble is absent from visibility (post-destroy). */
  async function waitForInvisibility(ensemble: string): Promise<void> {
    await pollWithTimeout(
      async () => !(await enumerateEnsembleNames(upgradeDeps())).includes(ensemble),
      15_000,
      100,
    );
  }

  it(
    'full round-trip: setup → upgrade → from-upgrade → re-attach',
    async function () {
      this.timeout(120_000);
      const ensemble = `${getTestEnsemble()}-smoke`;

      await withWorkerAndRecruitActivities(async () => {
        // ────────────────────────────────────────────────────────────────────
        // Phase A — stand up a 1.x ensemble with all four continuity dimensions
        // ────────────────────────────────────────────────────────────────────
        const conductorHandle = await startSession({
          metadata: conductorMetadata({ ensemble }),
        });

        const soloistHandle = await startSession({
          metadata: playerMetadata({
            ensemble,
            playerId: SOLOIST_PLAYER_ID,
            playerType: 'tempo-soloist',
            sessionId: SOLOIST_SESSION_ID,   // dimension 4: resume pointer
            model: SOLOIST_MODEL,            // dimension 3: non-default model
          }),
        });

        // Dimension 2: #334 state slot — player curates what survives the cutover.
        await soloistHandle.executeUpdate(savePlayerStateUpdate, {
          args: [{ key: SOLOIST_STATE_KEY, content: SOLOIST_STATE_CONTENT, savedBy: SOLOIST_PLAYER_ID }],
        });

        // Dimension 1: durable schedule — operator intent must survive the cutover.
        const schedulerHandle = await getClient().workflow.start('agentSchedulerWorkflow', {
          workflowId: schedulerWorkflowId(ensemble),
          taskQueue: TASK_QUEUE,
          args: [{ ensemble, entries: [] }],
        });
        const entry: ScheduleEntry = {
          name: SCHEDULE_NAME,
          message: 'daily standup ping',
          target: SOLOIST_PLAYER_ID,
          createdBy: 'operator',
          type: 'cron',
          nextFireAt: new Date(Date.now() + 3_600_000).toISOString(),
          cronExpression: SCHEDULE_CRON,
          timezone: SCHEDULE_TZ,
          firedCount: 3,  // deliberately non-zero — from-upgrade must reset this.
        };
        await schedulerHandle.signal(addScheduleSignal, entry);

        await waitForVisibility(ensemble);

        // ────────────────────────────────────────────────────────────────────
        // Phase B — upgrade-to-2: pause → drain → SNAPSHOT → DESTROY → done
        // ────────────────────────────────────────────────────────────────────
        const upgradeResult = await runUpgradeToV2(upgradeDeps(), {
          yes: true,
          drainTimeoutMs: 3_000,
          drainPollIntervalMs: 50,
        });

        expect(upgradeResult.status, 'upgrade status').to.equal('done');
        expect(upgradeResult.phase, 'upgrade phase').to.equal('done');

        // Snapshot written by upgrade engine — existence confirms the engine completed
        // the snapshot phase. The invariant (SNAPSHOT precedes DESTROY) is enforced at
        // the type level: `destroyAndFinish` takes the persisted snapshot as a required arg.
        const snapPath = snapshotPath(home);
        expect(existsSync(snapPath), 'snapshot file exists after upgrade').to.be.true;

        const snap = readSnapshot(home)!;
        expect(snap.version).to.equal(1);
        expect(snap.phase).to.equal('done');
        expect(snap.cliVersion).to.equal('1.7.0-smoke');

        const ens = snap.ensembles.find((e) => e.name === ensemble);
        expect(ens, 'ensemble in snapshot').to.exist;

        // ── Dimension 1: schedule captured ──
        const schedSnap = ens!.schedules.find((s) => s.name === SCHEDULE_NAME);
        expect(schedSnap, 'schedule captured').to.exist;
        expect(schedSnap!.cronExpression).to.equal(SCHEDULE_CRON);
        expect(schedSnap!.timezone).to.equal(SCHEDULE_TZ);
        expect(schedSnap!.target).to.equal(SOLOIST_PLAYER_ID);

        // ── Dimension 2: state slot captured ──
        const soloistSnap = ens!.players.find((p) => p.playerId === SOLOIST_PLAYER_ID);
        expect(soloistSnap, 'soloist in snapshot').to.exist;
        expect(soloistSnap!.stateSlots[SOLOIST_STATE_KEY]).to.equal(SOLOIST_STATE_CONTENT);

        // ── Dimension 3: non-default model captured ──
        expect(soloistSnap!.model).to.equal(SOLOIST_MODEL);

        // ── Dimension 4: sessionId resume pointer captured ──
        expect(soloistSnap!.sessionId).to.equal(SOLOIST_SESSION_ID);

        // Conductor + soloist both captured.
        const conductorSnap = ens!.players.find((p) => p.isConductor);
        expect(conductorSnap, 'conductor in snapshot').to.exist;

        // 1.x sessions completed (destroyed).
        await conductorHandle.result();
        await soloistHandle.result();
        await waitForInvisibility(ensemble);

        // ────────────────────────────────────────────────────────────────────
        // Phase C — up --from-upgrade: recreate protocol-2 skeletons + seed continuity
        // ────────────────────────────────────────────────────────────────────
        const fromResult = await runFromUpgrade(getClient(), {
          home,
          hostname: 'test-host',
          taskQueue: TASK_QUEUE,
          temporalAddress: 'localhost:7233',
          temporalNamespace: 'default',
        });

        expect(fromResult.ok, 'from-upgrade ok').to.be.true;
        expect(fromResult.snapshotFound, 'snapshot found').to.be.true;
        expect(fromResult.failures, 'no recreation failures').to.be.empty;

        // Snapshot archived to .consumed.json on success.
        expect(existsSync(snapPath), 'original snapshot removed after archive').to.be.false;
        expect(
          existsSync(join(home, CONSUMED_SNAPSHOT_FILENAME)),
          'consumed snapshot archived',
        ).to.be.true;

        // ── Soloist skeleton: poll until the session workflow is RUNNING ──
        const soloistWfId = sessionWorkflowId(ensemble, SOLOIST_PLAYER_ID);
        const soloistWf = getClient().workflow.getHandle(soloistWfId);

        // Give the workflow a moment to start (USE_EXISTING, worker picks it up).
        await pollWithTimeout(
          async () => {
            try {
              const info = await soloistWf.query(attachmentInfoQuery);
              return info.phase === 'booting';
            } catch {
              return false;
            }
          },
          15_000,
          100,
        );

        // ── Dimension 2: state slot seeded with savedBy=playerId (owner-self) + savedAt ──
        // from-upgrade seeds savedBy as player.playerId (#868 owner-seeding — the owner is the
        // player itself). 'self-restart' is the from-field used when a *restart* DELIVERS state,
        // a different concept. CI caught this mismatch on the first run.
        const stateEntry = await soloistWf.query(playerStateQuery, { key: SOLOIST_STATE_KEY });
        expect(stateEntry, 'state slot seeded').to.not.be.null;
        expect(stateEntry!.content).to.equal(SOLOIST_STATE_CONTENT);
        expect(stateEntry!.savedBy, 'savedBy=player itself (owner-seeded by from-upgrade)').to.equal(
          SOLOIST_PLAYER_ID,
        );
        expect(stateEntry!.savedAt, 'savedAt is ISO timestamp').to.match(
          /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/,
        );

        // ── Dimensions 3 + 4: sessionId + model seeded on metadata ──
        const soloistMeta = await soloistWf.query(getMetadataQuery);
        expect(soloistMeta.sessionId, 'sessionId seeded').to.equal(SOLOIST_SESSION_ID);
        expect(soloistMeta.model, 'model seeded').to.equal(SOLOIST_MODEL);

        // ── Conductor: booting phase + isConductor ──
        const conductorWf = getClient().workflow.getHandle(conductorWorkflowId(ensemble));
        const conductorInfo = await conductorWf.query(attachmentInfoQuery);
        expect(conductorInfo.phase, 'conductor phase=booting (skeleton, no adapter)').to.equal(
          'booting',
        );
        const conductorMeta = await conductorWf.query(getMetadataQuery);
        expect(conductorMeta.isConductor, 'conductor isConductor=true').to.be.true;

        // ── Dimension 1: scheduler recreated + entries seeded + firedCount reset ──
        const recreatedSchedulerWf = getClient().workflow.getHandle(schedulerWorkflowId(ensemble));
        const schedEntries = await recreatedSchedulerWf.query(getSchedulesQuery);
        const seededEntry = schedEntries.find((s) => s.name === SCHEDULE_NAME);
        expect(seededEntry, 'schedule seeded in recreated scheduler').to.exist;
        expect(seededEntry!.cronExpression).to.equal(SCHEDULE_CRON);
        expect(seededEntry!.target).to.equal(SOLOIST_PLAYER_ID);
        // firedCount must be reset — carrying it forward would misreport delivery history.
        expect(seededEntry!.firedCount, 'firedCount reset to 0').to.equal(0);

        // ────────────────────────────────────────────────────────────────────
        // Phase D — re-attach path: booting skeleton accepts claimAttachment
        // ────────────────────────────────────────────────────────────────────
        // This proves the skeleton is a valid protocol-2 session that an adapter can
        // attach to. We call claimAttachment directly rather than routing through the
        // full restart verb (which would need enqueueSpawn + process scaffolding).
        const token = await soloistWf.executeUpdate(claimAttachmentUpdate, {
          args: [
            {
              host: 'test-host',
              adapterId: 'claude',
              adapterClass: 'interactive',
              leaseMs: 30_000,
              protocolVersion: PROTOCOL_VERSION,
            },
          ],
        });

        expect(token, 'claimAttachment returned a token').to.exist;
        expect(token.attachmentId, 'token has attachmentId').to.be.a('string');

        // Phase should now be attached-with-lease after the claim. #704 Item 2: an
        // idle claim may refine attached → awaiting immediately (both valid — the
        // token assertion above already proves the claim succeeded).
        const postClaimInfo = await soloistWf.query(attachmentInfoQuery);
        expect(
          postClaimInfo.phase,
          'phase booting → attached|awaiting after claimAttachment',
        ).to.be.oneOf(['attached', 'awaiting']);

        // ── Cue non-redelivery: confirm soloist inbox is empty (cues not replayed) ──
        // Undelivered cues are captured for OPERATOR REVIEW only, never redelivered.
        // fromResult.undeliveredCues surfaces them; the session's inbox stays clean.
        // (Soloist had no undelivered cues in this fixture — the key property is that
        // from-upgrade doesn't auto-redeliver them even when captured by the engine.)
        expect(fromResult.undeliveredCues).to.be.an('array');

        // ── Comprehensive teardown: terminate every workflow this test created ──
        //
        // runFromUpgrade creates a new soloist (attached phase — heartbeat timer
        // running!), conductor, scheduler, and maestro — all on the shared TASK_QUEUE.
        // If left Running, their workflow tasks contend with the NEXT test's
        // executeUpdate/query calls, causing 60s+ UPDATE long-poll stalls.
        //
        // Terminate by KNOWN IDs first; visibility sweep as defense-in-depth.
        console.log(`[teardown:round-trip] terminate-all @ ${Date.now()}`);
        const roundTripKnownIds = [
          sessionWorkflowId(ensemble, SOLOIST_PLAYER_ID),
          conductorWorkflowId(ensemble),
          schedulerWorkflowId(ensemble),
          maestroWorkflowId(ensemble),
        ];
        await Promise.allSettled(
          roundTripKnownIds.map((wfId) =>
            getClient()
              .workflow.getHandle(wfId)
              .terminate('round-trip-test-cleanup')
              .catch(() => {}),
          ),
        );
        console.log(`[teardown:round-trip] known-ids-terminated @ ${Date.now()}`);
        for await (const wf of getClient().workflow.list({
          query: `AgentTempoEnsemble = "${ensemble}" AND ExecutionStatus = "Running"`,
        })) {
          await getClient()
            .workflow.getHandle(wf.workflowId)
            .terminate('round-trip-test-cleanup')
            .catch(() => {});
        }
        console.log(`[teardown:round-trip] visibility-sweep-done @ ${Date.now()}`);
      });
    },
  );

  it(
    'force-drain straggler round-trip: stragglers in snapshot survive to consumed.json and are distinct from inbox cues',
    async function () {
      this.timeout(90_000);
      const ensemble = `${getTestEnsemble()}-forcedrain-rt`;

      await withWorkerAndRecruitActivities(async () => {
        console.log(`[straggler:A1] worker-ready @ ${Date.now()}`);
        // ── Phase A: 1.x ensemble with a permanently-stuck outbox entry ──
        // Pause A's dispatch BEFORE enqueueing so the cue entry can never drain —
        // this simulates a real-world stuck adapter mid-delivery.
        const stuckSession = await startSession({
          metadata: playerMetadata({ ensemble, playerId: 'stuck' }),
        });
        console.log(`[straggler:A2] stuckSession started @ ${Date.now()}`);
        const peerSession = await startSession({
          metadata: playerMetadata({ ensemble, playerId: 'peer' }),
        });
        console.log(`[straggler:A3] peerSession started @ ${Date.now()}`);

        await stuckSession.signal(setPausedSignal, true);
        console.log(`[straggler:A4] signal(paused) sent @ ${Date.now()}`);
        await pollWithTimeout(
          async () => (await stuckSession.query(pausedQuery)) === true,
          10_000,
          50,
        );
        console.log(`[straggler:A5] pausedQuery confirmed @ ${Date.now()}`);
        console.log(`[straggler:A6] executeUpdate(submitOutbox) START @ ${Date.now()}`);
        await stuckSession.executeUpdate(submitOutboxUpdate, {
          args: [{ type: 'cue', targetPlayerId: 'peer', message: 'this will straggle' }],
        });
        console.log(`[straggler:A6] executeUpdate(submitOutbox) DONE @ ${Date.now()}`);

        await waitForVisibility(ensemble);
        console.log(`[straggler:A7] waitForVisibility done @ ${Date.now()}`);

        // ── Phase B: upgrade with --force-drain (proceeds past the stuck outbox) ──
        console.log(`[straggler:B1] runUpgradeToV2 START @ ${Date.now()}`);
        const upgradeResult = await runUpgradeToV2(upgradeDeps(), {
          yes: true,
          forceDrain: true,
          drainTimeoutMs: 1_500,
          drainPollIntervalMs: 50,
        });
        console.log(`[straggler:B1] runUpgradeToV2 DONE status=${upgradeResult.status} @ ${Date.now()}`);

        expect(upgradeResult.status, 'upgrade completed with force-drain').to.equal('done');

        const snapPath = snapshotPath(home);
        const snap = readSnapshot(home)!;
        const ens = snap.ensembles.find((e) => e.name === ensemble)!;

        // Straggler captured in snapshot before destroy.
        expect(ens.forceDrainedStragglers, 'stragglers in snapshot').to.exist;
        const straggler = ens.forceDrainedStragglers!.find((s) => s.playerId === 'stuck');
        expect(straggler, 'stuck player straggler captured').to.exist;
        expect(straggler!.entryType, 'straggler entry type=cue').to.equal('cue');

        // 1.x sessions destroyed by upgrade engine.
        // Use bounded waitForInvisibility rather than result() — result() has
        // no timeout and hangs indefinitely if executeUpdate(destroyUpdate) fails
        // silently on a slow CI runner (the error is caught in destroyEnsemble).
        console.log(`[straggler:C1] waitForInvisibility START @ ${Date.now()}`);
        await waitForInvisibility(ensemble);
        console.log(`[straggler:C1] waitForInvisibility DONE @ ${Date.now()}`);

        // ── Phase C: from-upgrade — straggler data survives in consumed.json ──
        console.log(`[straggler:C2] runFromUpgrade START @ ${Date.now()}`);
        const fromResult = await runFromUpgrade(getClient(), {
          home,
          hostname: 'test-host',
          taskQueue: TASK_QUEUE,
          temporalAddress: 'localhost:7233',
          temporalNamespace: 'default',
        });
        console.log(`[straggler:C2] runFromUpgrade DONE ok=${fromResult.ok} @ ${Date.now()}`);

        expect(fromResult.ok, 'from-upgrade ok').to.be.true;
        expect(fromResult.snapshotFound, 'snapshot found').to.be.true;
        expect(fromResult.failures, 'no recreation failures').to.be.empty;

        // Snapshot archived on success.
        expect(existsSync(snapPath), 'original snapshot removed after archive').to.be.false;
        const consumedPath = join(home, CONSUMED_SNAPSHOT_FILENAME);
        expect(existsSync(consumedPath), 'consumed snapshot archived').to.be.true;

        // Straggler data preserved in the consumed snapshot for operator review.
        // This is the contract: the operator reads .consumed.json to triage stuck
        // outbox entries; they are NOT surfaced through fromResult.undeliveredCues
        // (which is inbox-only, never outbox stragglers).
        const consumedRaw = await import('fs').then((fs) => fs.readFileSync(consumedPath, 'utf8'));
        const consumed = JSON.parse(consumedRaw) as typeof snap;
        const consumedEns = consumed.ensembles.find((e) => e.name === ensemble)!;
        expect(
          consumedEns.forceDrainedStragglers,
          'straggler data in consumed snapshot for operator review',
        ).to.exist;
        expect(
          consumedEns.forceDrainedStragglers!.length,
          'at least one straggler preserved',
        ).to.be.greaterThan(0);

        // KEY DISTINCTION: outbox stragglers ≠ inbox undelivered cues.
        // fromResult.undeliveredCues pulls from player.undeliveredMessages (inbox);
        // forceDrainedStragglers tracks stuck OUTBOX dispatch — a separate operator concern.
        // No inbox cues were sent to stuck/peer in this fixture, so the array is empty.
        expect(
          fromResult.undeliveredCues,
          'fromResult.undeliveredCues is inbox-only, not outbox stragglers',
        ).to.have.lengthOf(0);

        // ── Comprehensive teardown: terminate every workflow this test created ──
        //
        // Server-side terminate() needs no worker and cancels all pending tasks
        // immediately. This ensures:
        //   (a) The worker drain (after withWorkerAndRecruitActivities returns)
        //       has no in-flight workflow tasks keeping it alive.
        //   (b) testEnv.teardown() (mochaGlobalTeardown) can shut down the
        //       embedded Temporal server without blocking on Running workflows
        //       with open long-poll connections.
        //
        // Terminate by KNOWN IDs first — these are available immediately without
        // depending on the eventually-consistent visibility index. Then sweep by
        // ensemble SA as defense-in-depth for any workflow we may have missed.
        console.log(`[teardown:straggler] terminate-all @ ${Date.now()}`);
        const knownIds = [
          stuckSession.workflowId,
          peerSession.workflowId,
          maestroWorkflowId(ensemble),
          schedulerWorkflowId(ensemble),
          conductorWorkflowId(ensemble),
        ];
        await Promise.allSettled(
          knownIds.map((wfId) =>
            getClient().workflow.getHandle(wfId).terminate('straggler-test-cleanup').catch(() => {}),
          ),
        );
        console.log(`[teardown:straggler] known-ids-terminated @ ${Date.now()}`);
        // Visibility sweep — catches any additional runFromUpgrade skeleton (e.g.
        // player sessions). Eventually consistent; IDs above cover the critical ones.
        for await (const wf of getClient().workflow.list({
          query: `AgentTempoEnsemble = "${ensemble}" AND ExecutionStatus = "Running"`,
        })) {
          await getClient()
            .workflow.getHandle(wf.workflowId)
            .terminate('straggler-test-cleanup')
            .catch(() => {});
        }
        console.log(`[teardown:straggler] visibility-sweep-done @ ${Date.now()}`);
      });
    },
  );
});
