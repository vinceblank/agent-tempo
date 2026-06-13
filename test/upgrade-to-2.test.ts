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
import { addScheduleSignal } from '../src/workflows/scheduler-signals';
import type { ScheduleEntry } from '../src/types';
import {
  runUpgradeToV2,
  enumerateEnsembleNames,
  type UpgradeDeps,
} from '../src/upgrade/phase-engine';
import { readSnapshot } from '../src/upgrade/snapshot-v1';

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
      cliVersion: '1.8.0-test',
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
      expect(snap!.cliVersion).to.equal('1.8.0-test');

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
        cliVersion: '1.8.0-test',
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
            // A single host (this host) advertising a stale daemon — the
            // same-host-stale-daemon case from #801.
            hostProfiles: { 'test-host': { hostname: 'test-host', version: '1.7.0' } },
          },
        ],
      });

      try {
        const result = await runUpgradeToV2(deps(), { yes: true });
        expect(result.status).to.equal('refused');
        expect(result.refusals, 'refusal listed').to.have.length(1);
        expect(result.refusals![0].hostname).to.equal('test-host');
        expect(result.refusals![0].version).to.equal('1.7.0');
        // Refused BEFORE writing anything.
        expect(readSnapshot(home)).to.be.null;
      } finally {
        await gm.terminate('test cleanup').catch(() => {});
      }
    });
  });
});
