import { describe, it, before, after } from 'mocha';
import { strict as assert } from 'assert';
import { Worker } from '@temporalio/worker';
import { WorkflowHandle } from '@temporalio/client';
import {
  setupTestEnv,
  teardownTestEnv,
  getClient,
  TASK_QUEUE,
  startSession,
  playerMetadata,
  conductorMetadata,
  updateMetadataSignal,
} from './helpers';
import {
  maestroShutdownSignal,
  maestroPlayersQuery,
  maestroEventsQuery,
  maestroPendingCommandsQuery,
  maestroSendCommandUpdate,
} from '../src/workflows/maestro-signals';
import type { MaestroPlayerInfo } from '../src/types';

// ── Test helpers ──

let workflowBundle: { code: string };

/**
 * Create a worker with mocked Maestro activities.
 * refreshEnsembleState returns whatever `mockPlayers` is set to.
 * relayCommandToConductor records calls in `relayedCommands`.
 */
function createMaestroTestWorker(
  nativeConnection: any,
  opts: {
    mockPlayers?: () => MaestroPlayerInfo[];
    relayResult?: () => { success: boolean; error?: string };
  } = {},
) {
  const relayedCommands: Array<{ text: string; source: string; replyTo?: string }> = [];
  const mockPlayers = opts.mockPlayers ?? (() => []);
  const relayResult = opts.relayResult ?? (() => ({ success: true }));

  return {
    relayedCommands,
    createWorker: async () => {
      const fs = require('fs');
      const path = require('path');
      // Find bundle
      let dir = __dirname;
      for (let i = 0; i < 5; i++) {
        const candidate = path.join(dir, 'workflow-bundle.js');
        if (fs.existsSync(candidate)) {
          workflowBundle = { code: fs.readFileSync(candidate, 'utf-8') };
          break;
        }
        dir = path.dirname(dir);
      }
      if (!workflowBundle) throw new Error('workflow-bundle.js not found');

      return Worker.create({
        connection: nativeConnection,
        taskQueue: TASK_QUEUE,
        workflowBundle,
        activities: {
          refreshEnsembleState: async (_ensemble: string) => mockPlayers(),
          relayCommandToConductor: async (input: { text: string; source: string; replyTo?: string }) => {
            relayedCommands.push(input);
            return relayResult();
          },
          fetchConductorHistory: async () => ({ success: true, history: [] }),
          // Session workflow activities (stubbed for session workflows started as fixtures)
          deliverCue: async () => {},
          deliverReport: async () => {},
          terminateSession: async () => {},
          startRecruitedSession: async () => ({ claudeSessionId: 'test' }),
          performEncore: async () => ({ hostname: 'test-host', workDir: '/tmp', isConductor: false, agent: 'claude', temporalAddress: '', temporalNamespace: 'default' }),
          spawnProcess: async () => ({ success: true }),
          fireSchedule: async () => ({ success: true }),
          computeNextCronFire: async () => null,
        },
      });
    },
  };
}

describe('Maestro Workflow', () => {
  before(async function () {
    this.timeout(30_000);
    await setupTestEnv();
  });

  after(async () => {
    await teardownTestEnv();
  });

  it('starts with empty state and responds to queries', async function () {
    this.timeout(15_000);
    const client = getClient();
    const { createWorker } = createMaestroTestWorker(
      (client as any).connection.nativeConnection ?? (await import('@temporalio/testing')).TestWorkflowEnvironment.createLocal().then(e => e.nativeConnection),
    );

    // We need to get native connection from the test env
    const { TestWorkflowEnvironment } = await import('@temporalio/testing');
    const testEnv = await TestWorkflowEnvironment.createLocal();

    const worker = await Worker.create({
      connection: testEnv.nativeConnection,
      taskQueue: TASK_QUEUE,
      workflowBundle,
      activities: {
        refreshEnsembleState: async () => [],
        relayCommandToConductor: async () => ({ success: true }),
        fetchConductorHistory: async () => ({ success: true, history: [] }),
        deliverCue: async () => {},
        deliverReport: async () => {},
        terminateSession: async () => {},
        startRecruitedSession: async () => ({ claudeSessionId: 'test' }),
        performEncore: async () => ({}),
        spawnProcess: async () => ({ success: true }),
        fireSchedule: async () => ({ success: true }),
        computeNextCronFire: async () => null,
      },
    });

    await worker.runUntil(async () => {
      const handle = await testEnv.client.workflow.start('claudeMaestroWorkflow', {
        workflowId: 'maestro-test-empty',
        taskQueue: TASK_QUEUE,
        args: [{ ensemble: 'test-ensemble' }],
      });

      // Query initial state
      const players = await handle.query(maestroPlayersQuery);
      assert.deepEqual(players, []);

      const events = await handle.query(maestroEventsQuery);
      assert.deepEqual(events, []);

      const cmds = await handle.query(maestroPendingCommandsQuery);
      assert.deepEqual(cmds, []);

      // Shutdown
      await handle.signal(maestroShutdownSignal);
      await handle.result();
    });

    await testEnv.teardown();
  });

  it('detects player_joined and player_left events via snapshot diffing', async function () {
    this.timeout(30_000);
    const { TestWorkflowEnvironment } = await import('@temporalio/testing');
    const testEnv = await TestWorkflowEnvironment.createLocal();

    let currentPlayers: MaestroPlayerInfo[] = [];

    const worker = await Worker.create({
      connection: testEnv.nativeConnection,
      taskQueue: TASK_QUEUE,
      workflowBundle,
      activities: {
        refreshEnsembleState: async () => currentPlayers,
        relayCommandToConductor: async () => ({ success: true }),
        fetchConductorHistory: async () => ({ success: true, history: [] }),
        deliverCue: async () => {},
        deliverReport: async () => {},
        terminateSession: async () => {},
        startRecruitedSession: async () => ({ claudeSessionId: 'test' }),
        performEncore: async () => ({}),
        spawnProcess: async () => ({ success: true }),
        fireSchedule: async () => ({ success: true }),
        computeNextCronFire: async () => null,
      },
    });

    await worker.runUntil(async () => {
      const handle = await testEnv.client.workflow.start('claudeMaestroWorkflow', {
        workflowId: 'maestro-test-diff',
        taskQueue: TASK_QUEUE,
        args: [{ ensemble: 'test-ensemble' }],
      });

      // Wait for first refresh cycle (empty)
      await new Promise(r => setTimeout(r, 12_000));

      // Simulate a player joining
      currentPlayers = [{
        playerId: 'alice',
        part: 'Working on feature',
        hostname: 'test-host',
        workDir: '/tmp/test',
        isConductor: false,
        agentType: 'claude',
        status: 'active',
      }];

      // Wait for another refresh cycle
      await new Promise(r => setTimeout(r, 12_000));

      const events = await handle.query(maestroEventsQuery);
      const joinEvents = events.filter(e => e.type === 'player_joined');
      assert.ok(joinEvents.length >= 1, `Expected at least 1 player_joined event, got ${joinEvents.length}`);
      assert.equal(joinEvents[0].playerId, 'alice');

      // Now remove the player
      currentPlayers = [];
      await new Promise(r => setTimeout(r, 12_000));

      const events2 = await handle.query(maestroEventsQuery);
      const leftEvents = events2.filter(e => e.type === 'player_left');
      assert.ok(leftEvents.length >= 1, `Expected at least 1 player_left event, got ${leftEvents.length}`);
      assert.equal(leftEvents[0].playerId, 'alice');

      await handle.signal(maestroShutdownSignal);
      await handle.result();
    });

    await testEnv.teardown();
  });

  it('detects status_changed and part_changed events', async function () {
    this.timeout(30_000);
    const { TestWorkflowEnvironment } = await import('@temporalio/testing');
    const testEnv = await TestWorkflowEnvironment.createLocal();

    let currentPlayers: MaestroPlayerInfo[] = [{
      playerId: 'bob',
      part: 'Initial part',
      hostname: 'test-host',
      workDir: '/tmp/test',
      isConductor: false,
      agentType: 'claude',
      status: 'active',
    }];

    const worker = await Worker.create({
      connection: testEnv.nativeConnection,
      taskQueue: TASK_QUEUE,
      workflowBundle,
      activities: {
        refreshEnsembleState: async () => currentPlayers,
        relayCommandToConductor: async () => ({ success: true }),
        fetchConductorHistory: async () => ({ success: true, history: [] }),
        deliverCue: async () => {},
        deliverReport: async () => {},
        terminateSession: async () => {},
        startRecruitedSession: async () => ({ claudeSessionId: 'test' }),
        performEncore: async () => ({}),
        spawnProcess: async () => ({ success: true }),
        fireSchedule: async () => ({ success: true }),
        computeNextCronFire: async () => null,
      },
    });

    await worker.runUntil(async () => {
      // Start with bob already in the snapshot
      const handle = await testEnv.client.workflow.start('claudeMaestroWorkflow', {
        workflowId: 'maestro-test-changes',
        taskQueue: TASK_QUEUE,
        args: [{ ensemble: 'test-ensemble', players: [...currentPlayers] }],
      });

      // Wait for a refresh
      await new Promise(r => setTimeout(r, 12_000));

      // Change status and part
      currentPlayers = [{
        playerId: 'bob',
        part: 'Updated part',
        hostname: 'test-host',
        workDir: '/tmp/test',
        isConductor: false,
        agentType: 'claude',
        status: 'stale',
      }];

      await new Promise(r => setTimeout(r, 12_000));

      const events = await handle.query(maestroEventsQuery);
      const statusEvents = events.filter(e => e.type === 'status_changed' && e.playerId === 'bob');
      const partEvents = events.filter(e => e.type === 'part_changed' && e.playerId === 'bob');

      assert.ok(statusEvents.length >= 1, `Expected status_changed event for bob`);
      assert.equal(statusEvents[0].oldValue, 'active');
      assert.equal(statusEvents[0].newValue, 'stale');

      assert.ok(partEvents.length >= 1, `Expected part_changed event for bob`);
      assert.equal(partEvents[0].oldValue, 'Initial part');
      assert.equal(partEvents[0].newValue, 'Updated part');

      await handle.signal(maestroShutdownSignal);
      await handle.result();
    });

    await testEnv.teardown();
  });

  it('queues and dispatches commands via maestroSendCommand update', async function () {
    this.timeout(20_000);
    const { TestWorkflowEnvironment } = await import('@temporalio/testing');
    const testEnv = await TestWorkflowEnvironment.createLocal();

    const relayedCommands: Array<{ text: string; source: string }> = [];

    const worker = await Worker.create({
      connection: testEnv.nativeConnection,
      taskQueue: TASK_QUEUE,
      workflowBundle,
      activities: {
        refreshEnsembleState: async () => [{ playerId: 'cond', part: 'test', hostname: 'h', workDir: '/tmp', isConductor: true, agentType: 'claude', status: 'active' }],
        relayCommandToConductor: async (input: any) => {
          relayedCommands.push(input);
          return { success: true };
        },
        fetchConductorHistory: async () => ({ success: true, history: [] }),
        deliverCue: async () => {},
        deliverReport: async () => {},
        terminateSession: async () => {},
        startRecruitedSession: async () => ({ claudeSessionId: 'test' }),
        performEncore: async () => ({}),
        spawnProcess: async () => ({ success: true }),
        fireSchedule: async () => ({ success: true }),
        computeNextCronFire: async () => null,
      },
    });

    await worker.runUntil(async () => {
      const handle = await testEnv.client.workflow.start('claudeMaestroWorkflow', {
        workflowId: 'maestro-test-cmd',
        taskQueue: TASK_QUEUE,
        args: [{ ensemble: 'test-ensemble' }],
      });

      // Send a command
      const cmdId = await handle.executeUpdate(maestroSendCommandUpdate, {
        args: [{ text: 'recruit a reviewer', source: 'maestro-ui' }],
      });
      assert.ok(typeof cmdId === 'string');
      assert.ok(cmdId.length > 0);

      // Wait for dispatch
      await new Promise(r => setTimeout(r, 12_000));

      // Verify the command was relayed
      assert.ok(relayedCommands.length >= 1, `Expected at least 1 relayed command`);
      assert.equal(relayedCommands[0].text, 'recruit a reviewer');
      assert.equal(relayedCommands[0].source, 'maestro-ui');

      // Check pending commands query shows it as delivered
      const cmds = await handle.query(maestroPendingCommandsQuery);
      const delivered = cmds.filter(c => c.id === cmdId);
      assert.ok(delivered.length === 1);
      assert.equal(delivered[0].status, 'delivered');

      await handle.signal(maestroShutdownSignal);
      await handle.result();
    });

    await testEnv.teardown();
  });

  it('rejects empty command text in update validator', async function () {
    this.timeout(15_000);
    const { TestWorkflowEnvironment } = await import('@temporalio/testing');
    const testEnv = await TestWorkflowEnvironment.createLocal();

    const worker = await Worker.create({
      connection: testEnv.nativeConnection,
      taskQueue: TASK_QUEUE,
      workflowBundle,
      activities: {
        refreshEnsembleState: async () => [],
        relayCommandToConductor: async () => ({ success: true }),
        fetchConductorHistory: async () => ({ success: true, history: [] }),
        deliverCue: async () => {},
        deliverReport: async () => {},
        terminateSession: async () => {},
        startRecruitedSession: async () => ({ claudeSessionId: 'test' }),
        performEncore: async () => ({}),
        spawnProcess: async () => ({ success: true }),
        fireSchedule: async () => ({ success: true }),
        computeNextCronFire: async () => null,
      },
    });

    await worker.runUntil(async () => {
      const handle = await testEnv.client.workflow.start('claudeMaestroWorkflow', {
        workflowId: 'maestro-test-validate',
        taskQueue: TASK_QUEUE,
        args: [{ ensemble: 'test-ensemble' }],
      });

      // Empty text should be rejected by validator
      await assert.rejects(
        () => handle.executeUpdate(maestroSendCommandUpdate, {
          args: [{ text: '', source: 'test' }],
        }),
        /Command text must not be empty/,
      );

      await handle.signal(maestroShutdownSignal);
      await handle.result();
    });

    await testEnv.teardown();
  });

  it('shuts down gracefully on maestroShutdown signal', async function () {
    this.timeout(15_000);
    const { TestWorkflowEnvironment } = await import('@temporalio/testing');
    const testEnv = await TestWorkflowEnvironment.createLocal();

    const worker = await Worker.create({
      connection: testEnv.nativeConnection,
      taskQueue: TASK_QUEUE,
      workflowBundle,
      activities: {
        refreshEnsembleState: async () => [],
        relayCommandToConductor: async () => ({ success: true }),
        fetchConductorHistory: async () => ({ success: true, history: [] }),
        deliverCue: async () => {},
        deliverReport: async () => {},
        terminateSession: async () => {},
        startRecruitedSession: async () => ({ claudeSessionId: 'test' }),
        performEncore: async () => ({}),
        spawnProcess: async () => ({ success: true }),
        fireSchedule: async () => ({ success: true }),
        computeNextCronFire: async () => null,
      },
    });

    await worker.runUntil(async () => {
      const handle = await testEnv.client.workflow.start('claudeMaestroWorkflow', {
        workflowId: 'maestro-test-shutdown',
        taskQueue: TASK_QUEUE,
        args: [{ ensemble: 'test-ensemble' }],
      });

      // Signal shutdown
      await handle.signal(maestroShutdownSignal);

      // Should complete cleanly
      await handle.result();

      const desc = await handle.describe();
      assert.equal(desc.status.name, 'COMPLETED');
    });

    await testEnv.teardown();
  });

  it('handles activity failures gracefully without crashing', async function () {
    this.timeout(20_000);
    const { TestWorkflowEnvironment } = await import('@temporalio/testing');
    const testEnv = await TestWorkflowEnvironment.createLocal();

    let callCount = 0;

    const worker = await Worker.create({
      connection: testEnv.nativeConnection,
      taskQueue: TASK_QUEUE,
      workflowBundle,
      activities: {
        refreshEnsembleState: async () => {
          callCount++;
          if (callCount <= 2) throw new Error('Simulated failure');
          return [];
        },
        relayCommandToConductor: async () => ({ success: true }),
        fetchConductorHistory: async () => ({ success: true, history: [] }),
        deliverCue: async () => {},
        deliverReport: async () => {},
        terminateSession: async () => {},
        startRecruitedSession: async () => ({ claudeSessionId: 'test' }),
        performEncore: async () => ({}),
        spawnProcess: async () => ({ success: true }),
        fireSchedule: async () => ({ success: true }),
        computeNextCronFire: async () => null,
      },
    });

    await worker.runUntil(async () => {
      const handle = await testEnv.client.workflow.start('claudeMaestroWorkflow', {
        workflowId: 'maestro-test-resilient',
        taskQueue: TASK_QUEUE,
        args: [{ ensemble: 'test-ensemble' }],
      });

      // Wait for a few cycles (some will fail, some will succeed)
      await new Promise(r => setTimeout(r, 15_000));

      // Workflow should still be running
      const desc = await handle.describe();
      assert.equal(desc.status.name, 'RUNNING');

      await handle.signal(maestroShutdownSignal);
      await handle.result();
    });

    await testEnv.teardown();
  });

  it('marks commands as failed when relay fails', async function () {
    this.timeout(20_000);
    const { TestWorkflowEnvironment } = await import('@temporalio/testing');
    const testEnv = await TestWorkflowEnvironment.createLocal();

    const worker = await Worker.create({
      connection: testEnv.nativeConnection,
      taskQueue: TASK_QUEUE,
      workflowBundle,
      activities: {
        refreshEnsembleState: async () => [],
        relayCommandToConductor: async () => ({ success: false, error: 'No conductor found' }),
        fetchConductorHistory: async () => ({ success: true, history: [] }),
        deliverCue: async () => {},
        deliverReport: async () => {},
        terminateSession: async () => {},
        startRecruitedSession: async () => ({ claudeSessionId: 'test' }),
        performEncore: async () => ({}),
        spawnProcess: async () => ({ success: true }),
        fireSchedule: async () => ({ success: true }),
        computeNextCronFire: async () => null,
      },
    });

    await worker.runUntil(async () => {
      const handle = await testEnv.client.workflow.start('claudeMaestroWorkflow', {
        workflowId: 'maestro-test-fail-relay',
        taskQueue: TASK_QUEUE,
        args: [{ ensemble: 'test-ensemble' }],
      });

      const cmdId = await handle.executeUpdate(maestroSendCommandUpdate, {
        args: [{ text: 'do something', source: 'test' }],
      });

      // Wait for dispatch
      await new Promise(r => setTimeout(r, 12_000));

      const cmds = await handle.query(maestroPendingCommandsQuery);
      const cmd = cmds.find(c => c.id === cmdId);
      assert.ok(cmd, 'Command should exist');
      assert.equal(cmd!.status, 'failed');
      assert.ok(cmd!.error?.includes('No conductor found'));

      await handle.signal(maestroShutdownSignal);
      await handle.result();
    });

    await testEnv.teardown();
  });
});
