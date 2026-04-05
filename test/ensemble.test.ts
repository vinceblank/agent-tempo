/**
 * Tests for the ensemble lineups feature: loading, validation, saving, and fan-out.
 */
import { expect } from 'chai';
import { existsSync, mkdirSync, readFileSync, writeFileSync, rmSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { Client, WorkflowHandle } from '@temporalio/client';
import {
  setupTestEnv,
  teardownTestEnv,
  getClient,
  withWorkerAndActivities,
  startSession,
  playerMetadata,
  conductorMetadata,
  updateMetadataSignal,
  allMessagesQuery,
} from './helpers';
import {
  addScheduleSignal,
  getSchedulesQuery,
} from '../src/workflows/scheduler-signals';
import { ScheduleEntry } from '../src/types';
import { loadLineup } from '../src/ensemble/loader';
import { listLineups } from '../src/ensemble/saver';

const ENSEMBLE = 'test-ensemble';
const SCHEDULER_TASK_QUEUE = 'test-claude-tempo';

function schedulerWorkflowId(ensemble: string): string {
  return `claude-scheduler-${ensemble}`;
}

/** Create a temporary directory for test files. */
function makeTmpDir(): string {
  const dir = join(tmpdir(), `claude-tempo-test-${Date.now()}`);
  mkdirSync(dir, { recursive: true });
  return dir;
}

describe('ensemble lineups', function () {
  let tmpDir: string;

  before(async function () {
    this.timeout(60_000);
    await setupTestEnv();
    tmpDir = makeTmpDir();
  });

  after(async function () {
    await teardownTestEnv();
    try { rmSync(tmpDir, { recursive: true, force: true }); } catch { /* cleanup best effort */ }
  });

  // ── Lineup loading ──

  describe('loadLineup', function () {
    it('loads a valid YAML lineup and returns correct structure', function () {
      const yamlContent = `
name: my-ensemble
description: A test ensemble
conductor:
  agent: copilot
  instructions: Coordinate the team
players:
  - name: alice
    workDir: /tmp/alice
    instructions: Work on frontend
  - name: bob
    agent: copilot
    instructions: Work on backend
schedules:
  - name: standup
    message: Time for standup
    target: all
    every: 1h
    count: 5
`;
      const filePath = join(tmpDir, 'valid.yaml');
      writeFileSync(filePath, yamlContent);

      const lineup = loadLineup(filePath);

      expect(lineup.name).to.equal('my-ensemble');
      expect(lineup.description).to.equal('A test ensemble');
      expect(lineup.conductor).to.deep.include({ agent: 'copilot', instructions: 'Coordinate the team' });
      expect(lineup.players).to.have.lengthOf(2);
      expect(lineup.players[0].name).to.equal('alice');
      expect(lineup.players[0].workDir).to.equal('/tmp/alice');
      expect(lineup.players[0].instructions).to.equal('Work on frontend');
      expect(lineup.players[1].name).to.equal('bob');
      expect(lineup.players[1].agent).to.equal('copilot');
      expect(lineup.schedules).to.have.lengthOf(1);
      expect(lineup.schedules![0].name).to.equal('standup');
      expect(lineup.schedules![0].target).to.equal('all');
      expect(lineup.schedules![0].every).to.equal('1h');
      expect(lineup.schedules![0].count).to.equal(5);
    });

    it('loads a minimal lineup with only name and players', function () {
      const yamlContent = `
name: minimal
players:
  - name: solo-player
`;
      const filePath = join(tmpDir, 'minimal.yaml');
      writeFileSync(filePath, yamlContent);

      const lineup = loadLineup(filePath);

      expect(lineup.name).to.equal('minimal');
      expect(lineup.players).to.have.lengthOf(1);
      expect(lineup.players[0].name).to.equal('solo-player');
      expect(lineup.conductor).to.be.undefined;
      expect(lineup.schedules).to.be.undefined;
    });
  });

  // ── Lineup validation ──

  describe('loadLineup validation', function () {
    it('rejects lineup with missing name', function () {
      const filePath = join(tmpDir, 'no-name.yaml');
      writeFileSync(filePath, `players:\n  - name: test\n`);

      expect(() => loadLineup(filePath)).to.throw('"name" is required');
    });

    it('rejects lineup with missing players', function () {
      const filePath = join(tmpDir, 'no-players.yaml');
      writeFileSync(filePath, `name: test\n`);

      expect(() => loadLineup(filePath)).to.throw('"players" must be an array');
    });

    it('rejects lineup with invalid player name', function () {
      const filePath = join(tmpDir, 'bad-player-name.yaml');
      writeFileSync(filePath, `name: test\nplayers:\n  - name: "bad name!"\n`);

      expect(() => loadLineup(filePath)).to.throw('invalid characters');
    });

    it('rejects lineup with empty player name', function () {
      const filePath = join(tmpDir, 'empty-player-name.yaml');
      writeFileSync(filePath, `name: test\nplayers:\n  - name: ""\n`);

      expect(() => loadLineup(filePath)).to.throw('players[0].name is required');
    });

    it('rejects schedule missing timing fields', function () {
      const filePath = join(tmpDir, 'bad-schedule.yaml');
      writeFileSync(filePath, `name: test\nplayers:\n  - name: p1\nschedules:\n  - name: sched\n    message: hello\n    target: p1\n`);

      expect(() => loadLineup(filePath)).to.throw('at least one of: at, delay, every, cron');
    });

    it('accepts schedule with cron timing', function () {
      const filePath = join(tmpDir, 'cron-schedule.yaml');
      writeFileSync(filePath, `name: test\nplayers:\n  - name: p1\nschedules:\n  - name: nightly\n    message: run\n    target: p1\n    cron: "0 2 * * *"\n    timezone: America/Detroit\n`);

      const lineup = loadLineup(filePath);
      expect(lineup.schedules).to.have.lengthOf(1);
      expect(lineup.schedules![0].cron).to.equal('0 2 * * *');
      expect(lineup.schedules![0].timezone).to.equal('America/Detroit');
    });

    it('accepts schedule with at + every combination', function () {
      const filePath = join(tmpDir, 'at-every-schedule.yaml');
      writeFileSync(filePath, `name: test\nplayers:\n  - name: p1\nschedules:\n  - name: nightly-triage\n    message: run triage\n    target: p1\n    at: "2026-04-05T02:00:00Z"\n    every: 24h\n`);

      const lineup = loadLineup(filePath);
      expect(lineup.schedules).to.have.lengthOf(1);
      expect(lineup.schedules![0].at).to.equal('2026-04-05T02:00:00Z');
      expect(lineup.schedules![0].every).to.equal('24h');
    });

    it('rejects schedule missing message', function () {
      const filePath = join(tmpDir, 'sched-no-msg.yaml');
      writeFileSync(filePath, `name: test\nplayers:\n  - name: p1\nschedules:\n  - name: sched\n    target: p1\n    every: 1h\n`);

      expect(() => loadLineup(filePath)).to.throw('schedules[0].message is required');
    });

    it('rejects schedule missing target', function () {
      const filePath = join(tmpDir, 'sched-no-target.yaml');
      writeFileSync(filePath, `name: test\nplayers:\n  - name: p1\nschedules:\n  - name: sched\n    message: hello\n    every: 1h\n`);

      expect(() => loadLineup(filePath)).to.throw('schedules[0].target is required');
    });
  });

  // ── Lineup saving ──

  describe('saveLineup', function () {
    it('saves live ensemble state to YAML', async function () {
      this.timeout(30_000);
      await withWorkerAndActivities(async () => {
        // Start a player session
        const handle = await startSession({
          metadata: playerMetadata({ playerId: 'save-test-player', ensemble: ENSEMBLE }),
        });

        // Import saveLineup here to use the test client
        const { saveLineup } = await import('../src/ensemble/saver');
        const outputPath = join(tmpDir, 'saved-ensemble.yaml');
        const resultPath = await saveLineup(getClient(), ENSEMBLE, outputPath);

        expect(resultPath).to.equal(outputPath);
        expect(existsSync(outputPath)).to.be.true;

        const content = readFileSync(outputPath, 'utf8');
        expect(content).to.include('save-test-player');
        expect(content).to.include(ENSEMBLE);

        // Cleanup
        await handle.signal(updateMetadataSignal, { status: 'terminated' });
        try { await handle.result(); } catch { /* shutdown */ }
      });
    });
  });

  // ── listLineups ──

  describe('listLineups', function () {
    it('lists YAML files in the ensembles directory', function () {
      // We need to use the actual ensembles dir for this test
      const { CLAUDE_TEMPO_HOME } = require('../src/config');
      const ensemblesDir = join(CLAUDE_TEMPO_HOME, 'ensembles');
      mkdirSync(ensemblesDir, { recursive: true });

      const testFile = join(ensemblesDir, 'list-test.yaml');
      writeFileSync(testFile, 'name: list-test\nplayers:\n  - name: p1\n');

      try {
        const lineups = listLineups();
        const found = lineups.find(l => l.name === 'list-test');
        expect(found).to.not.be.undefined;
        expect(found!.path).to.equal(testFile);
      } finally {
        // Cleanup
        try { rmSync(testFile); } catch { /* best effort */ }
      }
    });
  });

  // ── Schedule fan-out with target "all" ──

  describe('schedule fire with target "all"', function () {
    it('delivers to all players but skips conductor', async function () {
      this.timeout(30_000);
      await withWorkerAndActivities(async () => {
        const fanoutEnsemble = `fanout-${Date.now()}`;

        // Start conductor + 2 players
        const conductorHandle = await startSession({
          metadata: conductorMetadata({ ensemble: fanoutEnsemble }),
        });
        const player1Handle = await startSession({
          metadata: playerMetadata({ playerId: 'fanout-p1', ensemble: fanoutEnsemble }),
        });
        const player2Handle = await startSession({
          metadata: playerMetadata({ playerId: 'fanout-p2', ensemble: fanoutEnsemble }),
        });

        // Start scheduler and add a schedule targeting "all" that fires soon
        const schedulerHandle = await getClient().workflow.start('claudeSchedulerWorkflow', {
          workflowId: schedulerWorkflowId(fanoutEnsemble),
          taskQueue: SCHEDULER_TASK_QUEUE,
          args: [{ ensemble: fanoutEnsemble, entries: [] }],
        });

        const entry: ScheduleEntry = {
          name: 'fanout-test',
          message: 'hello everyone',
          target: 'all',
          createdBy: 'test-creator',
          nextFireAt: new Date(Date.now() + 1000).toISOString(),
          firedCount: 0,
          type: 'once',
        };
        await schedulerHandle.signal(addScheduleSignal, entry);

        // Wait for the schedule to fire (1s delay + processing time)
        await new Promise(r => setTimeout(r, 4000));

        // Verify both players received the message
        const p1Messages = await player1Handle.query(allMessagesQuery);
        const p2Messages = await player2Handle.query(allMessagesQuery);
        const conductorMessages = await conductorHandle.query(allMessagesQuery);

        const p1Scheduled = p1Messages.filter(m => m.text.includes('[scheduled: fanout-test]'));
        const p2Scheduled = p2Messages.filter(m => m.text.includes('[scheduled: fanout-test]'));
        const conductorScheduled = conductorMessages.filter(m => m.text.includes('[scheduled: fanout-test]'));

        expect(p1Scheduled).to.have.lengthOf(1, 'player1 should receive the scheduled message');
        expect(p2Scheduled).to.have.lengthOf(1, 'player2 should receive the scheduled message');
        expect(conductorScheduled).to.have.lengthOf(0, 'conductor should NOT receive the scheduled message');

        // Cleanup
        await schedulerHandle.cancel();
        try { await schedulerHandle.result(); } catch { /* cancelled */ }
        for (const h of [conductorHandle, player1Handle, player2Handle]) {
          await h.signal(updateMetadataSignal, { status: 'terminated' });
          try { await h.result(); } catch { /* shutdown */ }
        }
      });
    });
  });
});
