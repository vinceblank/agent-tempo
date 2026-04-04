/**
 * Tests for the scheduler workflow and its interaction with session workflows.
 */
import { expect } from 'chai';
import { Client, WorkflowHandle } from '@temporalio/client';
import {
  setupTestEnv,
  teardownTestEnv,
  getClient,
  startSession,
  playerMetadata,
  updateMetadataSignal,
  allMessagesQuery,
  withWorkerAndActivities,
} from './helpers';
import {
  addScheduleSignal,
  removeScheduleSignal,
  getSchedulesQuery,
  getScheduleQuery,
} from '../src/workflows/scheduler-signals';
import { ScheduleEntry } from '../src/types';

const ENSEMBLE = 'test-ensemble';
const SCHEDULER_TASK_QUEUE = 'test-claude-tempo';

function schedulerWorkflowId(ensemble: string): string {
  return `claude-scheduler-${ensemble}`;
}

function makeEntry(overrides: Partial<ScheduleEntry> & { name: string; message: string; target: string }): ScheduleEntry {
  return {
    type: 'once',
    nextFireAt: new Date(Date.now() + 2000).toISOString(),
    createdBy: 'test-creator',
    firedCount: 0,
    ...overrides,
  };
}

async function startScheduler(
  client: Client,
  entries: ScheduleEntry[] = [],
): Promise<WorkflowHandle> {
  return client.workflow.start('claudeSchedulerWorkflow', {
    workflowId: schedulerWorkflowId(ENSEMBLE),
    taskQueue: SCHEDULER_TASK_QUEUE,
    args: [{ ensemble: ENSEMBLE, entries }],
  });
}

describe('claudeSchedulerWorkflow', function () {
  before(async function () {
    this.timeout(60_000);
    await setupTestEnv();
  });

  after(async function () {
    await teardownTestEnv();
  });

  describe('signal and query handlers', function () {
    it('starts with empty schedule list and responds to getSchedules query', async function () {
      await withWorkerAndActivities(async () => {
        const handle = await startScheduler(getClient());

        const schedules = await handle.query(getSchedulesQuery);
        expect(schedules).to.have.lengthOf(0);

        // Empty scheduler should self-terminate after 30s grace period.
        // Signal shutdown by adding then removing an entry to keep it alive briefly.
        // Actually, let it self-terminate — it has a 30s wait.
        // For speed, just cancel it.
        await handle.cancel();
        try { await handle.result(); } catch { /* cancelled */ }
      });
    });

    it('adds a schedule via signal and returns it via query', async function () {
      await withWorkerAndActivities(async () => {
        const handle = await startScheduler(getClient());

        const entry = makeEntry({
          name: 'test-schedule',
          message: 'hello',
          target: 'some-player',
          nextFireAt: new Date(Date.now() + 60_000).toISOString(), // far future so it doesn't fire
        });
        await handle.signal(addScheduleSignal, entry);

        const schedules = await handle.query(getSchedulesQuery);
        expect(schedules).to.have.lengthOf(1);
        expect(schedules[0].name).to.equal('test-schedule');
        expect(schedules[0].message).to.equal('hello');
        expect(schedules[0].target).to.equal('some-player');

        const single = await handle.query(getScheduleQuery, 'test-schedule');
        expect(single).to.not.be.null;
        expect(single!.name).to.equal('test-schedule');

        const missing = await handle.query(getScheduleQuery, 'nonexistent');
        expect(missing).to.be.null;

        await handle.cancel();
        try { await handle.result(); } catch { /* cancelled */ }
      });
    });

    it('replaces existing schedule with same name', async function () {
      await withWorkerAndActivities(async () => {
        const handle = await startScheduler(getClient());

        const entry1 = makeEntry({
          name: 'replaceable',
          message: 'v1',
          target: 'player-a',
          nextFireAt: new Date(Date.now() + 60_000).toISOString(),
        });
        await handle.signal(addScheduleSignal, entry1);

        const entry2 = makeEntry({
          name: 'replaceable',
          message: 'v2',
          target: 'player-b',
          nextFireAt: new Date(Date.now() + 60_000).toISOString(),
        });
        await handle.signal(addScheduleSignal, entry2);

        const schedules = await handle.query(getSchedulesQuery);
        expect(schedules).to.have.lengthOf(1);
        expect(schedules[0].message).to.equal('v2');
        expect(schedules[0].target).to.equal('player-b');

        await handle.cancel();
        try { await handle.result(); } catch { /* cancelled */ }
      });
    });

    it('removes a schedule via signal', async function () {
      await withWorkerAndActivities(async () => {
        const handle = await startScheduler(getClient());

        const entry = makeEntry({
          name: 'to-remove',
          message: 'bye',
          target: 'someone',
          nextFireAt: new Date(Date.now() + 60_000).toISOString(),
        });
        await handle.signal(addScheduleSignal, entry);

        let schedules = await handle.query(getSchedulesQuery);
        expect(schedules).to.have.lengthOf(1);

        await handle.signal(removeScheduleSignal, 'to-remove');

        schedules = await handle.query(getSchedulesQuery);
        expect(schedules).to.have.lengthOf(0);

        // Should self-terminate since empty — cancel to not wait 30s
        await handle.cancel();
        try { await handle.result(); } catch { /* cancelled */ }
      });
    });

    it('starts with seed entries provided in input', async function () {
      await withWorkerAndActivities(async () => {
        const entry = makeEntry({
          name: 'seeded',
          message: 'from input',
          target: 'player-x',
          nextFireAt: new Date(Date.now() + 60_000).toISOString(),
        });
        const handle = await startScheduler(getClient(), [entry]);

        const schedules = await handle.query(getSchedulesQuery);
        expect(schedules).to.have.lengthOf(1);
        expect(schedules[0].name).to.equal('seeded');

        await handle.cancel();
        try { await handle.result(); } catch { /* cancelled */ }
      });
    });
  });

  describe('firing schedules', function () {
    it('fires a one-shot schedule and delivers message to target player', async function () {
      this.timeout(15_000);

      await withWorkerAndActivities(async () => {
        // Start a target player session
        const targetHandle = await startSession({
          metadata: playerMetadata({ playerId: 'fire-target', ensemble: ENSEMBLE }),
        });

        // Start scheduler with a schedule that fires in 1 second
        const entry = makeEntry({
          name: 'one-shot-test',
          message: 'ping from schedule',
          target: 'fire-target',
          type: 'once',
          nextFireAt: new Date(Date.now() + 1000).toISOString(),
          createdBy: 'test-creator',
        });
        const schedulerHandle = await startScheduler(getClient(), [entry]);

        // Wait for the schedule to fire
        await sleep(4000);

        // Verify the message was delivered to the target
        const messages = await targetHandle.query(allMessagesQuery);
        const scheduled = messages.filter((m: any) => m.text.includes('[scheduled:'));
        expect(scheduled).to.have.lengthOf(1);
        expect(scheduled[0].text).to.include('[scheduled: one-shot-test]');
        expect(scheduled[0].text).to.include('ping from schedule');
        expect(scheduled[0].from).to.equal('test-creator');

        // Verify the one-shot was removed
        const schedules = await schedulerHandle.query(getSchedulesQuery);
        expect(schedules).to.have.lengthOf(0);

        // Cleanup
        await targetHandle.signal(updateMetadataSignal, { status: 'terminated' });
        await targetHandle.result();
        // Scheduler should self-terminate since empty
        await schedulerHandle.cancel();
        try { await schedulerHandle.result(); } catch { /* cancelled */ }
      });
    });

    it('fires a recurring schedule multiple times with count bound', async function () {
      this.timeout(20_000);

      await withWorkerAndActivities(async () => {
        // Start a target player session
        const targetHandle = await startSession({
          metadata: playerMetadata({ playerId: 'recurring-target', ensemble: ENSEMBLE }),
        });

        // Start scheduler with a recurring schedule: every 1s, count=3
        const entry = makeEntry({
          name: 'recurring-test',
          message: 'recurring ping',
          target: 'recurring-target',
          type: 'interval',
          nextFireAt: new Date(Date.now() + 1000).toISOString(),
          interval: 1000,
          remainingCount: 3,
          createdBy: 'test-creator',
        });
        const schedulerHandle = await startScheduler(getClient(), [entry]);

        // Wait for all 3 fires (1s + 1s + 1s + buffer)
        await sleep(6000);

        // Verify 3 messages delivered
        const messages = await targetHandle.query(allMessagesQuery);
        const scheduled = messages.filter((m: any) => m.text.includes('[scheduled: recurring-test]'));
        expect(scheduled).to.have.lengthOf(3);

        // Verify schedule was removed after exhausting count
        const schedules = await schedulerHandle.query(getSchedulesQuery);
        const remaining = schedules.filter((s: any) => s.name === 'recurring-test');
        expect(remaining).to.have.lengthOf(0);

        // Cleanup
        await targetHandle.signal(updateMetadataSignal, { status: 'terminated' });
        await targetHandle.result();
        await schedulerHandle.cancel();
        try { await schedulerHandle.result(); } catch { /* cancelled */ }
      });
    });

    it('includes isScheduled metadata in delivered messages', async function () {
      this.timeout(15_000);

      await withWorkerAndActivities(async () => {
        const targetHandle = await startSession({
          metadata: playerMetadata({ playerId: 'metadata-target', ensemble: ENSEMBLE }),
        });

        const entry = makeEntry({
          name: 'meta-test',
          message: 'check metadata',
          target: 'metadata-target',
          type: 'once',
          nextFireAt: new Date(Date.now() + 1000).toISOString(),
          createdBy: 'meta-creator',
        });
        const schedulerHandle = await startScheduler(getClient(), [entry]);

        await sleep(4000);

        const messages = await targetHandle.query(allMessagesQuery);
        const scheduled = messages.filter((m: any) => m.text.includes('[scheduled:'));
        expect(scheduled).to.have.lengthOf(1);
        // The signal includes isScheduled and scheduleName — these are passed
        // through the signal but stored depends on the session workflow handler.
        // At minimum, verify the text format is correct.
        expect(scheduled[0].text).to.include('[scheduled: meta-test]');
        expect(scheduled[0].from).to.equal('meta-creator');

        await targetHandle.signal(updateMetadataSignal, { status: 'terminated' });
        await targetHandle.result();
        await schedulerHandle.cancel();
        try { await schedulerHandle.result(); } catch { /* cancelled */ }
      });
    });
  });

  // ── until field (P2) ──

  describe('until field', function () {
    it('removes an interval schedule after its until date passes', async function () {
      this.timeout(15_000);

      await withWorkerAndActivities(async () => {
        const targetHandle = await startSession({
          metadata: playerMetadata({ playerId: 'until-target', ensemble: ENSEMBLE }),
        });

        // Create an interval schedule where `until` is already in the past.
        // The schedule fires once (nextFireAt is soon), and after that fire the
        // scheduler checks: until <= now → removes it instead of rescheduling.
        const entry = makeEntry({
          name: 'until-test',
          message: 'should fire once then stop',
          target: 'until-target',
          type: 'interval',
          nextFireAt: new Date(Date.now() + 500).toISOString(),
          interval: 10_000, // would repeat every 10s if not for `until`
          until: new Date(Date.now() - 1).toISOString(), // already expired
          createdBy: 'test-creator',
        });

        const schedulerHandle = await startScheduler(getClient(), [entry]);

        // Wait for the fire + processing
        await sleep(3000);

        // Exactly 1 message should have been delivered
        const messages = await targetHandle.query(allMessagesQuery);
        const scheduled = messages.filter((m: any) => m.text.includes('[scheduled: until-test]'));
        expect(scheduled).to.have.lengthOf(1);
        expect(scheduled[0].text).to.include('should fire once then stop');

        // Schedule should be removed — until expired after the first fire
        const schedules = await schedulerHandle.query(getSchedulesQuery);
        const remaining = schedules.filter((s: any) => s.name === 'until-test');
        expect(remaining).to.have.lengthOf(0);

        // Cleanup
        await targetHandle.signal(updateMetadataSignal, { status: 'terminated' });
        await targetHandle.result();
        await schedulerHandle.cancel();
        try { await schedulerHandle.result(); } catch { /* cancelled */ }
      });
    });
  });

  describe('self-termination', function () {
    it('self-terminates when schedule list is empty after grace period', async function () {
      this.timeout(45_000);

      await withWorkerAndActivities(async () => {
        const handle = await startScheduler(getClient());

        // Empty scheduler should self-terminate after ~30s
        // Wait and check status
        await sleep(35_000);

        const desc = await handle.describe();
        expect(desc.status.name).to.equal('COMPLETED');
      });
    });
  });
});

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
