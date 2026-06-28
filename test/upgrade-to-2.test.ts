/**
 * Integration coverage for the `upgrade-to-2` cutover engine (#785) against a
 * real `TestWorkflowEnvironment`: full protocol, mid-phase crash + resume,
 * --force-drain (and the drain-stop refusal), and the multi-host /
 * same-host-stale-daemon version refusal (#801).
 *
 * The pure version-floor + schema logic is unit-tested under `tests/upgrade/`;
 * this suite drives the orchestration end-to-end through real session /
 * scheduler / global-maestro workflows.
 *
 * Heavyweight (full worker + workflow lifecycle) → pinned to shard-1 in
 * `test/shard-config.json`.
 */
import { expect } from 'chai';
import { mkdtempSync, rmSync } from 'fs';
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
  withWorkerAndGlobalMaestroActivities,
  pollWithTimeout,
  CURRENT_TEST_HOSTNAME,
} from './helpers';
import {
  schedulerWorkflowId,
  GLOBAL_MAESTRO_WORKFLOW_ID,
} from '../src/config';
import {
  savePlayerStateUpdate,
  setPausedSignal,
  pausedQuery,
  submitOutboxUpdate,
  destroyUpdate,
} from '../src/workflows/signals';
import { addScheduleSignal, getSchedulesQuery } from '../src/workflows/scheduler-signals';
import type { ScheduleEntry } from '../src/types';
import {
  runUpgradeToV2,
  enumerateEnsembleNames,
  type UpgradeDeps,
} from '../src/upgrade/phase-engine';
import { readSnapshot } from '../src/upgrade/snapshot-v1';
import { runFromUpgrade } from '../src/upgrade/from-upgrade';

const SILENT = (..._args: unknown[]): void => {};

describe('upgrade-to-2 cutover engine (#785)', function () {
  before(setupSharedEnv);
  after(teardownTestEnv);

  let home: string;
  beforeEach(function () {
    home = mkdtempSync(join(tmpdir(), 'tempo-upgrade-it-'));
  });
  afterEach(function () {
    rmSync(home, { recursive: true, force: true });
  });

  function deps(overrides: Partial<UpgradeDeps> = {}): UpgradeDeps {
    return {
      client: getClient(),
      home,
      cliVersion: '1.7.0-test',
      log: SILENT,
      ...overrides,
    };
  }

  /** Wait until visibility reflects the ensemble's sessions for the engine. */
  async function waitForVisibility(ensemble: string): Promise<void> {
    await pollWithTimeout(
      async () => (await enumerateEnsembleNames(deps())).includes(ensemble),
      15_000,
      100,
    );
  }

  it('full protocol: pause → drain → snapshot (captures state + schedules) → destroy → done', async function () {
    this.timeout(90_000);
    const ensemble = `${getTestEnsemble()}-full`;

    await withWorkerAndRecruitActivities(async () => {
      const conductor = await startSession({ metadata: conductorMetadata({ ensemble }) });
      const soloist = await startSession({
        metadata: playerMetadata({
          ensemble,
          playerId: 'soloist',
          playerType: 'tempo-soloist',
          sessionId: 'sess-xyz',
          model: 'anthropic/claude-opus-4-7', // non-default recruit model (#785 freeze-fix)
        }),
      });

      // #334 saveable-state slot — the continuity story.
      await soloist.executeUpdate(savePlayerStateUpdate, {
        args: [{ key: 'handoff', content: 'resume at phase 4', savedBy: 'soloist' }],
      });

      // A durable schedule — must survive the cutover.
      const scheduler = await getClient().workflow.start('agentSchedulerWorkflow', {
        workflowId: schedulerWorkflowId(ensemble),
        taskQueue: TASK_QUEUE,
        args: [{ ensemble, entries: [] }],
      });
      const entry: ScheduleEntry = {
        name: 'standup',
        message: 'daily standup',
        target: 'soloist',
        createdBy: 'operator',
        type: 'cron',
        nextFireAt: new Date(Date.now() + 3_600_000).toISOString(),
        cronExpression: '0 9 * * 1-5',
        timezone: 'America/New_York',
        firedCount: 0,
      };
      await scheduler.signal(addScheduleSignal, entry);

      await waitForVisibility(ensemble);

      const result = await runUpgradeToV2(deps(), {
        yes: true,
        drainTimeoutMs: 3_000,
        drainPollIntervalMs: 50,
      });

      expect(result.status).to.equal('done');
      expect(result.phase).to.equal('done');

      // ── Snapshot fidelity ──
      const snap = readSnapshot(home);
      expect(snap, 'snapshot file written').to.not.be.null;
      expect(snap!.version).to.equal(1);
      expect(snap!.phase).to.equal('done');
      expect(snap!.cliVersion).to.equal('1.7.0-test');

      const ens = snap!.ensembles.find((e) => e.name === ensemble);
      expect(ens, 'ensemble captured').to.exist;

      const soloistSnap = ens!.players.find((p) => p.playerId === 'soloist');
      expect(soloistSnap, 'soloist captured').to.exist;
      expect(soloistSnap!.stateSlots.handoff).to.equal('resume at phase 4');
      expect(soloistSnap!.sessionId).to.equal('sess-xyz');
      expect(soloistSnap!.playerType).to.equal('tempo-soloist');
      expect(soloistSnap!.model).to.equal('anthropic/claude-opus-4-7');
      expect(soloistSnap!.isConductor).to.equal(false);

      const conductorSnap = ens!.players.find((p) => p.isConductor);
      expect(conductorSnap, 'conductor captured').to.exist;

      const sched = ens!.schedules.find((s) => s.name === 'standup');
      expect(sched, 'schedule captured').to.exist;
      expect(sched!.cronExpression).to.equal('0 9 * * 1-5');
      expect(sched!.timezone).to.equal('America/New_York');
      expect(sched!.target).to.equal('soloist');

      // ── Destroy: sessions COMPLETE; ensemble gone from visibility ──
      await conductor.result();
      await soloist.result();
      await pollWithTimeout(
        async () => !(await enumerateEnsembleNames(deps())).includes(ensemble),
        15_000,
        100,
      );
    });
  });

  it('mid-phase crash + resume: a durable snapshot (phase=snapshot) skips capture and continues destroy', async function () {
    this.timeout(90_000);
    const ensemble = `${getTestEnsemble()}-resume`;

    await withWorkerAndRecruitActivities(async () => {
      const player = await startSession({
        metadata: playerMetadata({ ensemble, playerId: 'resumer' }),
      });
      await waitForVisibility(ensemble);

      // Simulate a crash AFTER snapshot, BEFORE destroy completed: a durable
      // snapshot stamped `snapshot` already on disk.
      const { writeSnapshot } = await import('../src/upgrade/snapshot-v1');
      const preservedCreatedAt = '2020-01-01T00:00:00.000Z';
      writeSnapshot(home, {
        version: 1,
        createdAt: preservedCreatedAt,
        cliVersion: '1.7.0-test',
        phase: 'snapshot',
        ensembles: [
          {
            name: ensemble,
            schedules: [],
            players: [
              {
                playerId: 'resumer',
                agentType: 'claude',
                part: 'x',
                workDir: '/tmp/test',
                hostname: 'test-host',
                isConductor: false,
                stateSlots: {},
                undeliveredMessages: [],
              },
            ],
          },
        ],
      });

      const result = await runUpgradeToV2(deps(), { yes: true, drainTimeoutMs: 3_000 });

      expect(result.status).to.equal('done');
      // createdAt preserved across the resume re-write (not re-stamped).
      expect(result.snapshot!.createdAt).to.equal(preservedCreatedAt);
      expect(readSnapshot(home)!.phase).to.equal('done');

      // The session was destroyed even though capture was skipped.
      await player.result();
    });
  });

  it('--force-drain: proceeds past a non-empty outbox, recording stragglers in the snapshot', async function () {
    this.timeout(90_000);
    const ensemble = `${getTestEnsemble()}-forcedrain`;

    await withWorkerAndRecruitActivities(async () => {
      const a = await startSession({ metadata: playerMetadata({ ensemble, playerId: 'stuck' }) });
      const b = await startSession({ metadata: playerMetadata({ ensemble, playerId: 'peer' }) });

      // Pause A's dispatch FIRST so the entry we enqueue can never drain.
      await a.signal(setPausedSignal, true);
      await pollWithTimeout(async () => (await a.query(pausedQuery)) === true, 10_000, 50);
      await a.executeUpdate(submitOutboxUpdate, {
        args: [{ type: 'cue', targetPlayerId: 'peer', message: 'never delivered' }],
      });

      await waitForVisibility(ensemble);

      const result = await runUpgradeToV2(deps(), {
        yes: true,
        forceDrain: true,
        drainTimeoutMs: 1_500,
        drainPollIntervalMs: 50,
      });

      expect(result.status).to.equal('done');
      const ens = readSnapshot(home)!.ensembles.find((e) => e.name === ensemble);
      expect(ens!.forceDrainedStragglers, 'stragglers recorded').to.exist;
      const straggler = ens!.forceDrainedStragglers!.find((s) => s.playerId === 'stuck');
      expect(straggler, 'stuck entry recorded').to.exist;
      expect(straggler!.entryType).to.equal('cue');

      await a.result();
      await b.result();
    });
  });

  it('drain stop (no --force-drain): stops loudly, writes NO snapshot, destroys nothing', async function () {
    this.timeout(90_000);
    const ensemble = `${getTestEnsemble()}-drainstop`;

    await withWorkerAndRecruitActivities(async () => {
      const a = await startSession({ metadata: playerMetadata({ ensemble, playerId: 'blocker' }) });

      await a.signal(setPausedSignal, true);
      await pollWithTimeout(async () => (await a.query(pausedQuery)) === true, 10_000, 50);
      await a.executeUpdate(submitOutboxUpdate, {
        args: [{ type: 'cue', targetPlayerId: 'nobody', message: 'stuck' }],
      });

      await waitForVisibility(ensemble);

      const result = await runUpgradeToV2(deps(), {
        yes: true,
        forceDrain: false,
        drainTimeoutMs: 1_500,
        drainPollIntervalMs: 50,
      });

      expect(result.status).to.equal('drain-stopped');
      expect(result.phase).to.equal('drain');
      expect(result.stragglers).to.have.length.greaterThan(0);
      // Snapshot-precedes-destroy: nothing captured, nothing destroyed.
      expect(readSnapshot(home), 'no snapshot written before destroy').to.be.null;

      // Session is still alive — clean it up manually.
      await a.executeUpdate(destroyUpdate, { args: [{}] });
      await a.result();
    });
  });

  it('version refusal: refuses (no pause/snapshot/destroy) when a daemon is below the floor — same-host-stale-daemon (#801)', async function () {
    this.timeout(90_000);

    await withWorkerAndGlobalMaestroActivities({}, async () => {
      // Defensive: terminate any leftover global maestro from a prior test.
      try {
        await getClient().workflow.getHandle(GLOBAL_MAESTRO_WORKFLOW_ID).terminate('test reset');
      } catch {
        /* none running */
      }

      const gm = await getClient().workflow.start('agentGlobalMaestroWorkflow', {
        workflowId: GLOBAL_MAESTRO_WORKFLOW_ID,
        taskQueue: TASK_QUEUE,
        args: [
          {
            pollIntervalMs: 60_000,
            // A single host (this host) advertising a stale daemon below the
            // 1.7.0 floor — the same-host-stale-daemon case from #801.
            hostProfiles: { 'test-host': { hostname: 'test-host', version: '1.6.2' } },
          },
        ],
      });

      try {
        const result = await runUpgradeToV2(deps(), { yes: true });
        expect(result.status).to.equal('refused');
        expect(result.refusals, 'refusal listed').to.have.length(1);
        expect(result.refusals![0].hostname).to.equal('test-host');
        expect(result.refusals![0].version).to.equal('1.6.2');
        // Refused BEFORE writing anything.
        expect(readSnapshot(home)).to.be.null;
      } finally {
        await gm.terminate('test cleanup').catch(() => {});
      }
    });
  });

  it('schedule capture: once + interval types round-trip through snapshot → recreated scheduler', async function () {
    this.timeout(90_000);
    const ensemble = `${getTestEnsemble()}-sched-types`;

    await withWorkerAndRecruitActivities(async () => {
      // A conductor session is required for the ensemble to be visible to the
      // enumerateEnsembleNames scan that drives the upgrade preflight.
      const conductor = await startSession({ metadata: conductorMetadata({ ensemble }) });

      const scheduler = await getClient().workflow.start('agentSchedulerWorkflow', {
        workflowId: schedulerWorkflowId(ensemble),
        taskQueue: TASK_QUEUE,
        args: [{ ensemble, entries: [] }],
      });

      // Set nextFireAt 1 hour ahead so neither schedule fires during the test.
      const nextHour = new Date(Date.now() + 3_600_000).toISOString();

      // Once schedule: fires exactly once (remainingCount=1).
      const onceEntry: ScheduleEntry = {
        name: 'one-shot-ping',
        message: 'ping once',
        target: 'conductor',
        createdBy: 'operator',
        type: 'once',
        nextFireAt: nextHour,
        remainingCount: 1,
        firedCount: 0,
      };
      await scheduler.signal(addScheduleSignal, onceEntry);

      // Interval schedule: repeating at a fixed millisecond cadence.
      // firedCount=2 is intentional — the snapshot drops firedCount (it is a
      // runtime accumulator, not durable intent) and from-upgrade always resets
      // it to 0. This assertion proves the reset is correct.
      const intervalEntry: ScheduleEntry = {
        name: 'hourly-check',
        message: 'check in',
        target: 'conductor',
        createdBy: 'operator',
        type: 'interval',
        nextFireAt: nextHour,
        interval: 3_600_000, // 1 hour in ms
        firedCount: 2,
      };
      await scheduler.signal(addScheduleSignal, intervalEntry);

      await waitForVisibility(ensemble);

      // ── Phase B: full upgrade ──
      const result = await runUpgradeToV2(deps(), {
        yes: true,
        drainTimeoutMs: 3_000,
        drainPollIntervalMs: 50,
      });
      expect(result.status).to.equal('done');

      // ── Snapshot fidelity: type + type-specific fields captured correctly ──
      const snap = readSnapshot(home)!;
      const ens = snap.ensembles.find((e) => e.name === ensemble)!;

      const onceSched = ens.schedules.find((s) => s.name === 'one-shot-ping')!;
      expect(onceSched, 'once schedule captured').to.exist;
      expect(onceSched.type, 'type=once captured').to.equal('once');
      expect(onceSched.remainingCount, 'remainingCount=1 captured').to.equal(1);
      // firedCount is intentionally NOT in SnapshotSchedule (runtime accumulator,
      // not durable intent). The field must be absent from the captured shape.
      expect(
        (onceSched as unknown as Record<string, unknown>).firedCount,
        'firedCount absent from SnapshotSchedule (not captured)',
      ).to.equal(undefined);
      expect(onceSched.interval, 'interval absent on once schedule').to.equal(undefined);
      expect(onceSched.cronExpression, 'cronExpression absent on once schedule').to.equal(undefined);

      const intervalSched = ens.schedules.find((s) => s.name === 'hourly-check')!;
      expect(intervalSched, 'interval schedule captured').to.exist;
      expect(intervalSched.type, 'type=interval captured').to.equal('interval');
      expect(intervalSched.interval, 'interval=3_600_000 captured').to.equal(3_600_000);
      expect(intervalSched.cronExpression, 'cronExpression absent on interval schedule').to.equal(undefined);

      // Destroy completed — conductor session gone.
      await conductor.result();
      await pollWithTimeout(
        async () => !(await enumerateEnsembleNames(deps())).includes(ensemble),
        15_000,
        100,
      );

      // ── Phase C: from-upgrade recreates scheduler with both schedule types ──
      const fromResult = await runFromUpgrade(getClient(), {
        home,
        hostname: CURRENT_TEST_HOSTNAME, // #772 — match per-invocation host queue
        taskQueue: TASK_QUEUE,
        temporalAddress: 'localhost:7233',
        temporalNamespace: 'default',
      });
      expect(fromResult.ok, 'from-upgrade ok').to.be.true;
      expect(fromResult.failures, 'no recreation failures').to.be.empty;

      // Poll until the recreated scheduler workflow is running and has processed
      // its seeded entries (both schedule types must be visible).
      const recreatedSched = getClient().workflow.getHandle(schedulerWorkflowId(ensemble));
      await pollWithTimeout(
        async () => {
          try {
            const entries = await recreatedSched.query(getSchedulesQuery);
            return entries.length >= 2;
          } catch {
            return false;
          }
        },
        15_000,
        100,
      );

      const recreatedEntries = await recreatedSched.query(getSchedulesQuery);

      // ── Once schedule: type + remainingCount preserved; firedCount reset ──
      const onceRecreated = recreatedEntries.find((e) => e.name === 'one-shot-ping')!;
      expect(onceRecreated, 'once schedule recreated').to.exist;
      expect(onceRecreated.type, 'recreated type=once').to.equal('once');
      expect(onceRecreated.remainingCount, 'remainingCount=1 preserved through round-trip').to.equal(1);
      expect(onceRecreated.firedCount, 'firedCount reset to 0 on recreation').to.equal(0);

      // ── Interval schedule: type + interval preserved; firedCount reset from 2 ──
      const intervalRecreated = recreatedEntries.find((e) => e.name === 'hourly-check')!;
      expect(intervalRecreated, 'interval schedule recreated').to.exist;
      expect(intervalRecreated.type, 'recreated type=interval').to.equal('interval');
      expect(intervalRecreated.interval, 'interval=3_600_000 preserved through round-trip').to.equal(3_600_000);
      expect(intervalRecreated.firedCount, 'firedCount reset to 0 (was 2)').to.equal(0);
    });
  });

  // ── Gap 1: multi-ensemble round-trip ────────────────────────────────────────
  // Real deployments always have 2+ ensembles. Validates that `runUpgradeToV2`
  // discovers and captures all of them, and `runFromUpgrade` recreates each
  // independently with no cross-ensemble contamination.
  it('multi-ensemble round-trip: two ensembles captured + recreated independently', async function () {
    this.timeout(120_000);
    const base = getTestEnsemble();
    const ensAlpha = `${base}-multi-alpha`;
    const ensBeta = `${base}-multi-beta`;

    await withWorkerAndRecruitActivities(async () => {
      // ── Alpha: conductor + soloist + cron schedule ──
      const alphaConductor = await startSession({ metadata: conductorMetadata({ ensemble: ensAlpha }) });
      const alphaSoloist = await startSession({
        metadata: playerMetadata({ ensemble: ensAlpha, playerId: 'analyst' }),
      });

      const alphaScheduler = await getClient().workflow.start('agentSchedulerWorkflow', {
        workflowId: schedulerWorkflowId(ensAlpha),
        taskQueue: TASK_QUEUE,
        args: [{ ensemble: ensAlpha, entries: [] }],
      });
      const alphaEntry: ScheduleEntry = {
        name: 'alpha-check',
        message: 'alpha ping',
        target: 'analyst',
        createdBy: 'conductor',
        type: 'cron',
        nextFireAt: new Date(Date.now() + 3_600_000).toISOString(),
        cronExpression: '0 10 * * *',
        firedCount: 0,
      };
      await alphaScheduler.signal(addScheduleSignal, alphaEntry);

      // ── Beta: conductor only, no schedule ──
      const betaConductor = await startSession({ metadata: conductorMetadata({ ensemble: ensBeta }) });

      // Wait until both ensembles are visible to the upgrade engine.
      await Promise.all([
        waitForVisibility(ensAlpha),
        waitForVisibility(ensBeta),
      ]);

      // ── Run upgrade: must capture both ensembles in one pass ──
      const result = await runUpgradeToV2(deps(), {
        yes: true,
        drainTimeoutMs: 3_000,
        drainPollIntervalMs: 50,
      });
      expect(result.status, 'upgrade done').to.equal('done');

      // ── Snapshot fidelity: both ensembles present and isolated ──
      const snap = readSnapshot(home)!;
      const snapAlpha = snap.ensembles.find((e) => e.name === ensAlpha);
      const snapBeta = snap.ensembles.find((e) => e.name === ensBeta);
      expect(snapAlpha, 'alpha captured in snapshot').to.exist;
      expect(snapBeta, 'beta captured in snapshot').to.exist;

      // Alpha has schedule; beta does not.
      expect(snapAlpha!.schedules, 'alpha schedule captured').to.have.lengthOf(1);
      expect(snapAlpha!.schedules[0].name, 'alpha schedule name').to.equal('alpha-check');
      expect(snapBeta!.schedules, 'beta has no schedules').to.have.lengthOf(0);

      // Alpha has conductor + soloist; beta has conductor only.
      expect(snapAlpha!.players, 'alpha: conductor + analyst').to.have.lengthOf(2);
      expect(snapBeta!.players, 'beta: conductor only').to.have.lengthOf(1);

      // No cross-contamination: alpha's schedule absent from beta; alpha's unique soloist
      // player absent from beta. (Conductors in both ensembles share the 'conductor'
      // playerId by convention — that's correct; isolation is by ensemble name, not ID.)
      expect(
        snapBeta!.schedules.some((s) => s.name === 'alpha-check'),
        'alpha schedule absent from beta snapshot',
      ).to.be.false;
      expect(
        snapBeta!.players.some((p) => p.playerId === 'analyst'),
        'alpha soloist absent from beta player list',
      ).to.be.false;
      expect(
        snapBeta!.players.find((p) => p.isConductor),
        'beta conductor captured',
      ).to.exist;

      // ── Destroy: verify sessions gone via bounded visibility check ──
      // result() has no timeout — hangs indefinitely if executeUpdate(destroyUpdate)
      // fails silently on a slow CI runner (caught in destroyEnsemble's allSettled).
      // waitForInvisibility with a 15-second bound is the correct verification shape.
      await Promise.all([
        pollWithTimeout(
          async () => !(await enumerateEnsembleNames(deps())).includes(ensAlpha),
          15_000, 100,
        ),
        pollWithTimeout(
          async () => !(await enumerateEnsembleNames(deps())).includes(ensBeta),
          15_000, 100,
        ),
      ]);

      // ── From-upgrade: both ensembles recreated independently ──
      const fromResult = await runFromUpgrade(getClient(), {
        home,
        hostname: CURRENT_TEST_HOSTNAME, // #772 — match per-invocation host queue
        taskQueue: TASK_QUEUE,
        temporalAddress: 'localhost:7233',
        temporalNamespace: 'default',
      });
      expect(fromResult.ok, 'from-upgrade ok').to.be.true;
      expect(fromResult.failures, 'no recreation failures').to.be.empty;
      expect(fromResult.ensemblesRecreated, 'two ensembles recreated').to.equal(2);

      // Alpha scheduler must be recreated and hold its entry.
      const alphaSchedHandle = getClient().workflow.getHandle(schedulerWorkflowId(ensAlpha));
      await pollWithTimeout(
        async () => {
          try {
            const entries = await alphaSchedHandle.query(getSchedulesQuery);
            return entries.length >= 1;
          } catch { return false; }
        },
        15_000, 100,
      );
      const alphaEntries = await alphaSchedHandle.query(getSchedulesQuery);
      expect(alphaEntries.find((e) => e.name === 'alpha-check'), 'alpha schedule recreated').to.exist;

      // Beta scheduler must NOT be recreated (no schedules were captured).
      let betaSchedulerRecreated = false;
      try {
        const betaSchedHandle = getClient().workflow.getHandle(schedulerWorkflowId(ensBeta));
        const betaEntries = await betaSchedHandle.query(getSchedulesQuery);
        betaSchedulerRecreated = betaEntries.length > 0;
      } catch {
        betaSchedulerRecreated = false;
      }
      expect(betaSchedulerRecreated, 'beta scheduler NOT recreated (no schedules to restore)').to.be.false;
    });
  });
});
