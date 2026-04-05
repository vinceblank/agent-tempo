/**
 * Tests for the Maestro workflow — ensemble monitoring and command relay.
 * Follows the scheduler.test.ts pattern: shared testEnv, withWorkerAndMaestroActivities helper.
 *
 * Uses pollIntervalMs: 500 so the workflow refreshes every 0.5s instead of 10s,
 * making tests fast without needing time-skipping.
 */
import { expect } from 'chai';
import { Client, WorkflowHandle } from '@temporalio/client';
import {
  setupTestEnv,
  teardownTestEnv,
  getClient,
  TASK_QUEUE,
  withWorkerAndMaestroActivities,
} from './helpers';
import {
  maestroShutdownSignal,
  maestroPlayersQuery,
  maestroEventsQuery,
  maestroPendingCommandsQuery,
  maestroSendCommandUpdate,
} from '../src/workflows/maestro-signals';
import type { MaestroPlayerInfo } from '../src/types';

const ENSEMBLE = 'test-ensemble';
/** Fast poll for tests — 500ms instead of the default 10s. */
const FAST_POLL_MS = 500;

function maestroWorkflowId(ensemble: string): string {
  return `claude-maestro-${ensemble}`;
}

async function startMaestro(
  client: Client,
  overrides: { ensemble?: string; players?: MaestroPlayerInfo[] } = {},
): Promise<WorkflowHandle> {
  const input = {
    ensemble: overrides.ensemble ?? ENSEMBLE,
    players: overrides.players,
    pollIntervalMs: FAST_POLL_MS,
  };
  return client.workflow.start('claudeMaestroWorkflow', {
    workflowId: maestroWorkflowId(input.ensemble),
    taskQueue: TASK_QUEUE,
    args: [input],
  });
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

describe('claudeMaestroWorkflow', function () {
  before(async function () {
    this.timeout(60_000);
    await setupTestEnv();
  });

  after(async function () {
    await teardownTestEnv();
  });

  describe('initial state and queries', function () {
    it('starts with empty state and responds to queries', async function () {
      this.timeout(10_000);
      await withWorkerAndMaestroActivities({}, async () => {
        const handle = await startMaestro(getClient());

        const players = await handle.query(maestroPlayersQuery);
        expect(players).to.have.lengthOf(0);

        const events = await handle.query(maestroEventsQuery);
        expect(events).to.have.lengthOf(0);

        const cmds = await handle.query(maestroPendingCommandsQuery);
        expect(cmds).to.have.lengthOf(0);

        await handle.signal(maestroShutdownSignal);
        await handle.result();
      });
    });
  });

  describe('snapshot diffing', function () {
    it('detects player_joined and player_left events', async function () {
      this.timeout(15_000);

      let currentPlayers: MaestroPlayerInfo[] = [];

      await withWorkerAndMaestroActivities(
        { mockPlayers: () => currentPlayers },
        async () => {
          const handle = await startMaestro(getClient());

          // Wait for first refresh cycle (fast poll = 500ms + activity time)
          await sleep(2000);

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

          // Wait for next refresh cycle
          await sleep(2000);

          const events = await handle.query(maestroEventsQuery);
          const joinEvents = events.filter(e => e.type === 'player_joined');
          expect(joinEvents).to.have.length.greaterThanOrEqual(1);
          expect(joinEvents[0].playerId).to.equal('alice');

          // Now remove the player
          currentPlayers = [];
          await sleep(2000);

          const events2 = await handle.query(maestroEventsQuery);
          const leftEvents = events2.filter(e => e.type === 'player_left');
          expect(leftEvents).to.have.length.greaterThanOrEqual(1);
          expect(leftEvents[0].playerId).to.equal('alice');

          await handle.signal(maestroShutdownSignal);
          await handle.result();
        },
      );
    });

    it('detects status_changed and part_changed events', async function () {
      this.timeout(15_000);

      const initialPlayer: MaestroPlayerInfo = {
        playerId: 'bob',
        part: 'Initial part',
        hostname: 'test-host',
        workDir: '/tmp/test',
        isConductor: false,
        agentType: 'claude',
        status: 'active',
      };

      let currentPlayers: MaestroPlayerInfo[] = [{ ...initialPlayer }];

      await withWorkerAndMaestroActivities(
        { mockPlayers: () => currentPlayers },
        async () => {
          // Start with bob already in the snapshot to avoid a player_joined on first diff
          const handle = await startMaestro(getClient(), {
            players: [{ ...initialPlayer }],
          });

          // Wait for a refresh cycle
          await sleep(2000);

          // Change status and part
          currentPlayers = [{
            ...initialPlayer,
            part: 'Updated part',
            status: 'stale',
          }];

          await sleep(2000);

          const events = await handle.query(maestroEventsQuery);

          const statusEvents = events.filter(e => e.type === 'status_changed' && e.playerId === 'bob');
          expect(statusEvents).to.have.length.greaterThanOrEqual(1);
          expect(statusEvents[0].oldValue).to.equal('active');
          expect(statusEvents[0].newValue).to.equal('stale');

          const partEvents = events.filter(e => e.type === 'part_changed' && e.playerId === 'bob');
          expect(partEvents).to.have.length.greaterThanOrEqual(1);
          expect(partEvents[0].oldValue).to.equal('Initial part');
          expect(partEvents[0].newValue).to.equal('Updated part');

          await handle.signal(maestroShutdownSignal);
          await handle.result();
        },
      );
    });
  });

  describe('command relay', function () {
    it('queues and dispatches commands via maestroSendCommand update', async function () {
      this.timeout(15_000);

      await withWorkerAndMaestroActivities({}, async (relayedCommands) => {
        const handle = await startMaestro(getClient());

        // Send a command via update
        const cmdId = await handle.executeUpdate(maestroSendCommandUpdate, {
          args: [{ text: 'recruit a reviewer', source: 'maestro-ui' }],
        });
        expect(cmdId).to.be.a('string');
        expect(cmdId).to.have.length.greaterThan(0);

        // Wait for dispatch (update sets commandQueued flag, wakes the loop immediately)
        await sleep(2000);

        // Verify the command was relayed
        expect(relayedCommands).to.have.length.greaterThanOrEqual(1);
        expect(relayedCommands[0].text).to.equal('recruit a reviewer');
        expect(relayedCommands[0].source).to.equal('maestro-ui');

        // Check pending commands query shows it as delivered
        const cmds = await handle.query(maestroPendingCommandsQuery);
        const delivered = cmds.filter(c => c.id === cmdId);
        expect(delivered).to.have.lengthOf(1);
        expect(delivered[0].status).to.equal('delivered');

        await handle.signal(maestroShutdownSignal);
        await handle.result();
      });
    });

    it('rejects empty command text in update validator', async function () {
      this.timeout(10_000);
      await withWorkerAndMaestroActivities({}, async () => {
        const handle = await startMaestro(getClient());

        try {
          await handle.executeUpdate(maestroSendCommandUpdate, {
            args: [{ text: '', source: 'test' }],
          });
          expect.fail('Should have thrown');
        } catch (err: any) {
          expect(err.message).to.include('Command text must not be empty');
        }

        await handle.signal(maestroShutdownSignal);
        await handle.result();
      });
    });

    it('marks commands as failed when relay fails', async function () {
      this.timeout(15_000);

      await withWorkerAndMaestroActivities(
        { relayResult: () => ({ success: false, error: 'No conductor found' }) },
        async () => {
          const handle = await startMaestro(getClient());

          const cmdId = await handle.executeUpdate(maestroSendCommandUpdate, {
            args: [{ text: 'do something', source: 'test' }],
          });

          // Wait for dispatch
          await sleep(2000);

          const cmds = await handle.query(maestroPendingCommandsQuery);
          const cmd = cmds.find(c => c.id === cmdId);
          expect(cmd).to.exist;
          expect(cmd!.status).to.equal('failed');
          expect(cmd!.error).to.include('No conductor found');

          await handle.signal(maestroShutdownSignal);
          await handle.result();
        },
      );
    });
  });

  describe('lifecycle', function () {
    it('shuts down gracefully on maestroShutdown signal', async function () {
      this.timeout(10_000);
      await withWorkerAndMaestroActivities({}, async () => {
        const handle = await startMaestro(getClient());

        await handle.signal(maestroShutdownSignal);
        await handle.result();

        const desc = await handle.describe();
        expect(desc.status.name).to.equal('COMPLETED');
      });
    });

    it('handles activity failures gracefully without crashing', async function () {
      this.timeout(15_000);

      let callCount = 0;

      await withWorkerAndMaestroActivities(
        {
          mockPlayers: () => {
            callCount++;
            if (callCount <= 2) throw new Error('Simulated failure');
            return [];
          },
        },
        async () => {
          const handle = await startMaestro(getClient());

          // Wait for a few cycles — some will fail (retries exhausted), some will succeed
          await sleep(5000);

          // Workflow should still be running despite activity failures
          const desc = await handle.describe();
          expect(desc.status.name).to.equal('RUNNING');

          await handle.signal(maestroShutdownSignal);
          await handle.result();
        },
      );
    });
  });
});
