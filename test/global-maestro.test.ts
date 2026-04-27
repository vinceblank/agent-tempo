/**
 * Tests for the Global Maestro workflow — single instance handling ALL ensembles.
 * Follows the maestro.test.ts pattern with mocked activities.
 */
import { expect } from 'chai';
import { Client, WorkflowHandle, WorkflowUpdateFailedError } from '@temporalio/client';
import {
  setupTestEnv,
  setupSharedEnv,
  teardownTestEnv,
  getClient,
  TASK_QUEUE,
  withWorkerAndGlobalMaestroActivities,
} from './helpers';
import {
  maestroShutdownSignal,
  maestroEnsemblesQuery,
  maestroPlayersByEnsembleQuery,
  maestroRecentMessagesQuery,
  maestroEventsQuery,
  maestroPendingCommandsQuery,
  maestroSendMessageUpdate,
  maestroFetchPlayerMessagesUpdate,
  maestroFetchConductorHistoryUpdate,
  maestroGlobalSendCommandUpdate,
  hostProfileSignal,
  hostProfilesQuery,
  hostProfilesWithExistenceQuery,
} from '../src/workflows/maestro-signals';
import type { MaestroPlayerInfo, HostProfile } from '../src/types';

const FAST_POLL_MS = 500;
let testCounter = 0;

/**
 * Active handles registered during each `it()` body. Cleared + destroyed in
 * `afterEach` to prevent Global Maestro instances leaking across files under
 * the shared `TestWorkflowEnvironment` (#210).
 */
const pendingHandles: WorkflowHandle[] = [];

async function startGlobalMaestro(
  client: Client,
  overrides: { knownEnsembles?: string[]; playersByEnsemble?: Record<string, MaestroPlayerInfo[]> } = {},
): Promise<WorkflowHandle> {
  const input = {
    knownEnsembles: overrides.knownEnsembles,
    playersByEnsemble: overrides.playersByEnsemble,
    pollIntervalMs: FAST_POLL_MS,
  };
  const uniqueId = `claude-maestro-global-test-${++testCounter}`;
  const handle = await client.workflow.start('claudeGlobalMaestroWorkflow', {
    workflowId: uniqueId,
    taskQueue: TASK_QUEUE,
    args: [input],
  });
  pendingHandles.push(handle);
  return handle;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

describe('claudeGlobalMaestroWorkflow', function () {
  before(setupSharedEnv);

  after(async function () {
    await teardownTestEnv();
  });

  // #210: best-effort shutdown of any Global Maestro handle started this test.
  // Under the shared env a leaked Global Maestro keeps polling
  // `discoverEnsembles` / `refreshEnsembleState` after the test's mocked
  // activity closures have exited, which surfaces as cross-file flakes.
  afterEach(async function () {
    const toClean = pendingHandles.splice(0);
    for (const handle of toClean) {
      try {
        await handle.signal(maestroShutdownSignal);
        await handle.result().catch(() => { /* COMPLETED */ });
      } catch {
        // Inline shutdown already happened, or workflow completed. Ignore.
      }
    }
  });

  describe('initial state and queries', function () {
    it('starts with empty state and responds to all queries', async function () {
      this.timeout(10_000);
      await withWorkerAndGlobalMaestroActivities({}, async () => {
        const handle = await startGlobalMaestro(getClient());

        const ensembles = await handle.query(maestroEnsemblesQuery);
        expect(ensembles).to.deep.equal([]);

        const players = await handle.query(maestroPlayersByEnsembleQuery);
        expect(players).to.deep.equal({});

        const messages = await handle.query(maestroRecentMessagesQuery);
        expect(messages).to.deep.equal([]);

        const events = await handle.query(maestroEventsQuery);
        expect(events).to.deep.equal([]);

        const cmds = await handle.query(maestroPendingCommandsQuery);
        expect(cmds).to.deep.equal([]);

        await handle.signal(maestroShutdownSignal);
        await handle.result();
      });
    });
  });

  describe('ensemble discovery and player refresh', function () {
    it('discovers ensembles and refreshes players per ensemble', async function () {
      this.timeout(15_000);

      const player1: MaestroPlayerInfo = {
        playerId: 'alice',
        ensemble: 'team-a',
        part: 'Working on feature',
        hostname: 'host-1',
        workDir: '/tmp/a',
        isConductor: false,
        agentType: 'claude',
        phase: 'attached',
      };

      const player2: MaestroPlayerInfo = {
        playerId: 'bob',
        ensemble: 'team-b',
        part: 'Reviewing PR',
        hostname: 'host-2',
        workDir: '/tmp/b',
        isConductor: true,
        agentType: 'claude',
        phase: 'attached',
      };

      await withWorkerAndGlobalMaestroActivities(
        {
          mockEnsembles: () => ['team-a', 'team-b'],
          mockPlayersByEnsemble: (ensemble) => {
            if (ensemble === 'team-a') return [player1];
            if (ensemble === 'team-b') return [player2];
            return [];
          },
        },
        async () => {
          const handle = await startGlobalMaestro(getClient());

          // Wait for refresh cycle
          await sleep(2000);

          const ensembles = await handle.query(maestroEnsemblesQuery);
          expect(ensembles).to.include('team-a');
          expect(ensembles).to.include('team-b');

          const playerMap = await handle.query(maestroPlayersByEnsembleQuery);
          expect(playerMap['team-a']).to.have.lengthOf(1);
          expect(playerMap['team-a'][0].playerId).to.equal('alice');
          expect(playerMap['team-b']).to.have.lengthOf(1);
          expect(playerMap['team-b'][0].playerId).to.equal('bob');

          // Events should show player_joined for both
          const events = await handle.query(maestroEventsQuery);
          const joinEvents = events.filter((e) => e.type === 'player_joined');
          expect(joinEvents).to.have.length.greaterThanOrEqual(2);

          await handle.signal(maestroShutdownSignal);
          await handle.result();
        },
      );
    });

    it('removes stale ensembles when no longer discovered', async function () {
      this.timeout(15_000);

      let currentEnsembles = ['team-a', 'team-b'];

      await withWorkerAndGlobalMaestroActivities(
        {
          mockEnsembles: () => currentEnsembles,
          mockPlayersByEnsemble: () => [],
        },
        async () => {
          const handle = await startGlobalMaestro(getClient());

          await sleep(2000);

          let ensembles = await handle.query(maestroEnsemblesQuery);
          expect(ensembles).to.include('team-a');
          expect(ensembles).to.include('team-b');

          // Remove team-b
          currentEnsembles = ['team-a'];
          await sleep(2000);

          ensembles = await handle.query(maestroEnsemblesQuery);
          expect(ensembles).to.include('team-a');
          expect(ensembles).to.not.include('team-b');

          // playersByEnsemble should also not have team-b
          const playerMap = await handle.query(maestroPlayersByEnsembleQuery);
          expect(playerMap).to.not.have.property('team-b');

          await handle.signal(maestroShutdownSignal);
          await handle.result();
        },
      );
    });
  });

  describe('message relay via maestroSendMessage', function () {
    it('delivers a message and records it in recent messages', async function () {
      this.timeout(15_000);

      await withWorkerAndGlobalMaestroActivities(
        { deliverResult: () => ({ success: true }) },
        async () => {
          const handle = await startGlobalMaestro(getClient());

          const msgId = await handle.executeUpdate(maestroSendMessageUpdate, {
            args: [{ ensemble: 'team-a', to: 'alice', text: 'Hello Alice!', source: 'dashboard' }],
          });
          expect(msgId).to.be.a('string').with.length.greaterThan(0);

          const messages = await handle.query(maestroRecentMessagesQuery);
          const sent = messages.find((m) => m.id === msgId);
          expect(sent).to.exist;
          expect(sent!.ensemble).to.equal('team-a');
          expect(sent!.from).to.equal('dashboard');
          expect(sent!.to).to.equal('alice');
          expect(sent!.direction).to.equal('outbound');

          await handle.signal(maestroShutdownSignal);
          await handle.result();
        },
      );
    });

    it('rejects empty fields in maestroSendMessage validator', async function () {
      this.timeout(10_000);

      await withWorkerAndGlobalMaestroActivities({}, async () => {
        const handle = await startGlobalMaestro(getClient());

        try {
          await handle.executeUpdate(maestroSendMessageUpdate, {
            args: [{ ensemble: '', to: 'alice', text: 'Hi', source: 'test' }],
          });
          expect.fail('Should have thrown');
        } catch (err: any) {
          expect(err).to.be.instanceOf(WorkflowUpdateFailedError);
          expect(err.cause?.message).to.include('Ensemble must not be empty');
        }

        try {
          await handle.executeUpdate(maestroSendMessageUpdate, {
            args: [{ ensemble: 'x', to: '', text: 'Hi', source: 'test' }],
          });
          expect.fail('Should have thrown');
        } catch (err: any) {
          expect(err).to.be.instanceOf(WorkflowUpdateFailedError);
          expect(err.cause?.message).to.include('Target player must not be empty');
        }

        await handle.signal(maestroShutdownSignal);
        await handle.result();
      });
    });
  });

  describe('maestroFetchPlayerMessages update', function () {
    it('returns merged message timeline via activity', async function () {
      this.timeout(10_000);

      const mockMessages = [
        { id: '1', from: 'bob', text: 'Hi', timestamp: '2026-01-01T00:00:00Z', delivered: true, direction: 'received' },
        { id: '2', to: 'bob', text: 'Hey', timestamp: '2026-01-01T00:01:00Z', direction: 'sent' },
      ];

      await withWorkerAndGlobalMaestroActivities(
        { fetchMessagesResult: () => ({ success: true, messages: mockMessages }) },
        async () => {
          const handle = await startGlobalMaestro(getClient());

          const result = await handle.executeUpdate(maestroFetchPlayerMessagesUpdate, {
            args: [{ ensemble: 'team-a', playerId: 'alice' }],
          });
          expect(result).to.have.lengthOf(2);

          await handle.signal(maestroShutdownSignal);
          await handle.result();
        },
      );
    });
  });

  describe('maestroFetchConductorHistory update', function () {
    it('returns conductor history via activity', async function () {
      this.timeout(10_000);

      const mockHistory = [
        { type: 'command', timestamp: '2026-01-01T00:00:00Z', data: { text: 'deploy', source: 'admin' } },
      ];

      await withWorkerAndGlobalMaestroActivities(
        { fetchHistoryResult: () => ({ success: true, history: mockHistory }) },
        async () => {
          const handle = await startGlobalMaestro(getClient());

          const result = await handle.executeUpdate(maestroFetchConductorHistoryUpdate, {
            args: [{ ensemble: 'team-a' }],
          });
          expect(result.success).to.be.true;
          expect(result.history).to.have.lengthOf(1);

          await handle.signal(maestroShutdownSignal);
          await handle.result();
        },
      );
    });
  });

  describe('global command relay', function () {
    it('queues and dispatches commands with ensemble routing', async function () {
      this.timeout(15_000);

      await withWorkerAndGlobalMaestroActivities(
        { mockEnsembles: () => ['team-a'] },
        async (relayedCommands) => {
          const handle = await startGlobalMaestro(getClient());

          const cmdId = await handle.executeUpdate(maestroGlobalSendCommandUpdate, {
            args: [{ ensemble: 'team-a', text: 'recruit a reviewer', source: 'maestro-ui' }],
          });
          expect(cmdId).to.be.a('string');

          // Wait for dispatch
          await sleep(2000);

          expect(relayedCommands).to.have.length.greaterThanOrEqual(1);
          expect(relayedCommands[0].ensemble).to.equal('team-a');
          expect(relayedCommands[0].text).to.equal('recruit a reviewer');

          const cmds = await handle.query(maestroPendingCommandsQuery);
          const delivered = cmds.find((c) => c.id === cmdId);
          expect(delivered).to.exist;
          expect(delivered!.status).to.equal('delivered');

          await handle.signal(maestroShutdownSignal);
          await handle.result();
        },
      );
    });

    it('rejects empty command text', async function () {
      this.timeout(10_000);

      await withWorkerAndGlobalMaestroActivities({}, async () => {
        const handle = await startGlobalMaestro(getClient());

        try {
          await handle.executeUpdate(maestroGlobalSendCommandUpdate, {
            args: [{ ensemble: 'x', text: '', source: 'test' }],
          });
          expect.fail('Should have thrown');
        } catch (err: any) {
          expect(err).to.be.instanceOf(WorkflowUpdateFailedError);
          expect(err.cause?.message).to.include('Command text must not be empty');
        }

        await handle.signal(maestroShutdownSignal);
        await handle.result();
      });
    });
  });

  describe('lifecycle', function () {
    it('shuts down gracefully on maestroShutdown signal', async function () {
      this.timeout(10_000);

      await withWorkerAndGlobalMaestroActivities({}, async () => {
        const handle = await startGlobalMaestro(getClient());

        await handle.signal(maestroShutdownSignal);
        await handle.result();

        const desc = await handle.describe();
        expect(desc.status.name).to.equal('COMPLETED');
      });
    });
  });

  // #274 — `hostProfile` signal + `hostProfiles` query surface.
  //
  // Architect QA invariant #1 (AC3c / M9): the signal handler accepts
  // payloads with unknown extra fields and treats everything except
  // `hostname` opaquely. These tests lock that contract in so a future
  // maestro version can't tighten per-field validation without breaking
  // forward/backward compat for daemons on different versions.
  describe('hostProfile signal + hostProfiles query (#274)', function () {
    // NB: every test must `signal(maestroShutdownSignal) + await result()`
    // INSIDE the `withWorkerAndGlobalMaestroActivities` callback so the
    // workflow completes while the test worker is still polling. Otherwise
    // the afterEach shutdown races an already-stopped worker and
    // `handle.result()` hangs (the signal never gets processed).

    it('starts with an empty hostProfiles map', async function () {
      this.timeout(10_000);
      await withWorkerAndGlobalMaestroActivities({}, async () => {
        const handle = await startGlobalMaestro(getClient());
        const profiles = await handle.query(hostProfilesQuery);
        expect(profiles).to.deep.equal({});
        await handle.signal(maestroShutdownSignal);
        await handle.result();
      });
    });

    it('accepts a full profile and round-trips it verbatim through the query', async function () {
      this.timeout(10_000);
      await withWorkerAndGlobalMaestroActivities({}, async () => {
        const handle = await startGlobalMaestro(getClient());

        const profile: HostProfile = {
          hostname: 'mac-alice',
          version: '0.26.0-beta.7',
          defaultAgent: 'claude',
          availableAgentTypes: ['tempo-soloist', 'tempo-critic'],
          availablePlayerTypes: ['tempo-soloist', 'tempo-critic', 'tempo-conductor'],
          claudeBin: 'claude',
          platform: 'darwin',
          capabilities: ['interactive'],
        };
        await handle.signal(hostProfileSignal, profile);

        const profiles = await handle.query(hostProfilesQuery);
        expect(profiles).to.have.property('mac-alice');
        expect(profiles['mac-alice']).to.deep.equal(profile);

        await handle.signal(maestroShutdownSignal);
        await handle.result();
      });
    });

    it('accepts a minimal profile (hostname only) — AC3c open-schema contract', async function () {
      this.timeout(10_000);
      await withWorkerAndGlobalMaestroActivities({}, async () => {
        const handle = await startGlobalMaestro(getClient());

        await handle.signal(hostProfileSignal, { hostname: 'bare-host' });

        const profiles = await handle.query(hostProfilesQuery);
        expect(profiles).to.have.property('bare-host');
        expect(profiles['bare-host'].hostname).to.equal('bare-host');
        // No other fields enforced; the rest of the shape is opaque.

        await handle.signal(maestroShutdownSignal);
        await handle.result();
      });
    });

    it('preserves unknown extra fields (additive forward-compat, M9)', async function () {
      this.timeout(10_000);
      await withWorkerAndGlobalMaestroActivities({}, async () => {
        const handle = await startGlobalMaestro(getClient());

        // Simulate a newer daemon advertising a field this maestro version
        // doesn't model. The payload must be stored intact; a future
        // `listHosts` join with a matching Zod guard will surface it.
        await handle.signal(hostProfileSignal, {
          hostname: 'future-host',
          version: '99.0.0',
          futureCapability: 'warp-drive',
          experimentalFlags: { nested: { deep: 'value' } },
        } as unknown as HostProfile);

        const profiles = await handle.query(hostProfilesQuery);
        expect(profiles['future-host']).to.have.property('futureCapability', 'warp-drive');
        expect(profiles['future-host']).to.have.nested.property(
          'experimentalFlags.nested.deep',
          'value',
        );

        await handle.signal(maestroShutdownSignal);
        await handle.result();
      });
    });

    it('drops signals with a missing or malformed hostname silently', async function () {
      this.timeout(10_000);
      await withWorkerAndGlobalMaestroActivities({}, async () => {
        const handle = await startGlobalMaestro(getClient());

        // None of these should throw, none should be stored.
        await handle.signal(hostProfileSignal, {} as unknown as HostProfile);
        await handle.signal(hostProfileSignal, { hostname: '' } as unknown as HostProfile);
        await handle.signal(hostProfileSignal, { hostname: 123 } as unknown as HostProfile);
        await handle.signal(hostProfileSignal, { hostname: 'bad/slash' } as unknown as HostProfile);
        await handle.signal(hostProfileSignal, {
          hostname: 'a'.repeat(65), // >64 char cap
        } as unknown as HostProfile);

        const profiles = await handle.query(hostProfilesQuery);
        expect(profiles).to.deep.equal({});

        await handle.signal(maestroShutdownSignal);
        await handle.result();
      });
    });

    it('latest signal for a given hostname wins (upsert semantics)', async function () {
      this.timeout(10_000);
      await withWorkerAndGlobalMaestroActivities({}, async () => {
        const handle = await startGlobalMaestro(getClient());

        await handle.signal(hostProfileSignal, {
          hostname: 'upsert-host',
          version: '0.26.0-beta.6',
          defaultAgent: 'claude',
        });
        await handle.signal(hostProfileSignal, {
          hostname: 'upsert-host',
          version: '0.26.0-beta.7',
          defaultAgent: 'copilot',
        });

        const profiles = await handle.query(hostProfilesQuery);
        expect(profiles['upsert-host'].version).to.equal('0.26.0-beta.7');
        expect(profiles['upsert-host'].defaultAgent).to.equal('copilot');

        await handle.signal(maestroShutdownSignal);
        await handle.result();
      });
    });

    // #280 — combined existence + profiles query.
    it('hostProfilesWithExistence returns exists:true plus the same profile map', async function () {
      this.timeout(10_000);
      await withWorkerAndGlobalMaestroActivities({}, async () => {
        const handle = await startGlobalMaestro(getClient());

        const profile: HostProfile = {
          hostname: 'combined-host',
          version: '0.27.0',
          defaultAgent: 'claude',
        };
        await handle.signal(hostProfileSignal, profile);

        const combined = await handle.query(hostProfilesWithExistenceQuery);
        expect(combined.exists).to.equal(true);
        expect(combined.profiles).to.have.property('combined-host');
        expect(combined.profiles['combined-host']).to.deep.equal(profile);

        // Result must agree with the legacy single-purpose query (back-compat).
        const legacy = await handle.query(hostProfilesQuery);
        expect(combined.profiles).to.deep.equal(legacy);

        await handle.signal(maestroShutdownSignal);
        await handle.result();
      });
    });

    it('hostProfilesWithExistence returns exists:true with empty profiles when no host has signaled', async function () {
      this.timeout(10_000);
      await withWorkerAndGlobalMaestroActivities({}, async () => {
        const handle = await startGlobalMaestro(getClient());
        const combined = await handle.query(hostProfilesWithExistenceQuery);
        expect(combined.exists).to.equal(true);
        expect(combined.profiles).to.deep.equal({});
        await handle.signal(maestroShutdownSignal);
        await handle.result();
      });
    });
  });
});
