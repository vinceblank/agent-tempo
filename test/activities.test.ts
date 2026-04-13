/**
 * Unit tests for activity functions with mocked Temporal client.
 *
 * These tests verify activity logic in isolation — no TestWorkflowEnvironment,
 * no Temporal dev server. They run in milliseconds by mocking the Client
 * interface that activities depend on.
 *
 * Covers:
 *   - deliverCue (outbox.ts)
 *   - deliverReport (outbox.ts)
 *   - terminateSession (outbox.ts)
 *   - performEncore (outbox.ts)
 *   - resolveSession (resolve.ts)
 *   - scanEnsembleSessions (resolve.ts)
 *   - fireSchedule (schedule-fire.ts)
 *   - computeNextCronFire (schedule-fire.ts)
 *   - maestro activities (maestro.ts)
 */
import { expect } from 'chai';
import { ApplicationFailure } from '@temporalio/activity';
import { createOutboxActivities, type OutboxActivities } from '../src/activities/outbox';
import { resolveSession, scanEnsembleSessions } from '../src/activities/resolve';
import { createScheduleActivities, type ScheduleActivities } from '../src/activities/schedule-fire';
import { createMaestroActivities, type MaestroActivities } from '../src/activities/maestro';
import { conductorWorkflowId } from '../src/config';
import type { Config } from '../src/config';
import type { SessionMetadata } from '../src/types';

// ── Mock helpers ──

/** Build a minimal mock Config. */
function mockConfig(overrides: Partial<Config> = {}): Config {
  return {
    temporalAddress: 'localhost:7233',
    temporalNamespace: 'default',
    defaultAgent: 'claude',
    taskQueue: 'claude-tempo',
    ensemble: 'test-ensemble',
    ...overrides,
  };
}

/** Create a mock workflow handle that records signal/query/update calls. */
function mockHandle(opts: {
  metadata?: Partial<SessionMetadata>;
  part?: string;
  messages?: Array<{ from: string; text: string; timestamp: string }>;
  history?: unknown[];
  /** Override the default `attachmentInfo` query result. Defaults to `{ phase: 'detached', inFlightCount: 0 }`. */
  attachmentInfo?: {
    phase: 'booting' | 'attached' | 'processing' | 'awaiting' | 'draining' | 'detached' | 'gone';
    currentAttachment?: { attachmentId: string; hostname: string; adapterId: string };
    preferredHost?: string;
    inFlightCount?: number;
  };
  signalFn?: (name: string, args: unknown) => void;
  queryFn?: (name: string) => unknown;
  updateFn?: (name: string, opts: { args: unknown[] }) => unknown;
} = {}) {
  const signals: Array<{ name: string; args: unknown }> = [];
  const updates: Array<{ name: string; args: unknown }> = [];

  const defaultMetadata: SessionMetadata = {
    playerId: 'player-1',
    ensemble: 'test-ensemble',
    hostname: 'test-host',
    workDir: '/tmp/work',
    isConductor: false,
    agentType: 'claude',
    status: 'active',
    ...opts.metadata,
  };

  // Normalize: callers may pass either a string or a typed constant from
  // `src/workflows/signals.ts` (signals are plain objects with a `.name`).
  const asName = (nameOrDef: unknown): string =>
    typeof nameOrDef === 'string' ? nameOrDef : (nameOrDef as { name: string }).name;

  // Default attachment phase — overridden by opts.attachmentInfo.
  const attachmentInfo = opts.attachmentInfo ?? { phase: 'detached', inFlightCount: 0 };

  return {
    workflowId: `claude-session-test-ensemble-${defaultMetadata.playerId}`,
    signals,
    updates,
    async signal(nameOrDef: unknown, args: unknown) {
      const name = asName(nameOrDef);
      if (opts.signalFn) opts.signalFn(name, args);
      signals.push({ name, args });
    },
    async query(nameOrDef: unknown) {
      const name = asName(nameOrDef);
      if (opts.queryFn) return opts.queryFn(name);
      if (name === 'getMetadata') return defaultMetadata;
      if (name === 'getPart') return opts.part ?? 'working on stuff';
      if (name === 'allMessages') return opts.messages ?? [];
      if (name === 'history') return opts.history ?? [];
      if (name === 'attachmentInfo') return attachmentInfo;
      return undefined;
    },
    async describe() {
      return { status: { name: 'RUNNING' }, workflowId: `claude-session-test-ensemble-${defaultMetadata.playerId}` };
    },
    async executeUpdate(nameOrDef: unknown, updateOpts: { args: unknown[] }) {
      const name = asName(nameOrDef);
      updates.push({ name, args: updateOpts.args[0] });
      if (opts.updateFn) return opts.updateFn(name, updateOpts);
      // Default: destroy returns void (matches V2 destroyUpdate signature)
      if (name === 'destroy') return undefined;
      // Default: forceDetach returns { reaped: false } (idempotent on detached)
      if (name === 'forceDetach') return { reaped: false };
      // Default: claimAttachment returns a synthetic token
      if (name === 'claimAttachment') {
        return {
          attachmentId: `attach-${Math.random().toString(36).slice(2, 10)}`,
          runId: `run-${Math.random().toString(36).slice(2, 10)}`,
          expiresAt: new Date(Date.now() + 90_000).toISOString(),
          leaseMs: 90_000,
        };
      }
      // Default: enqueueSpawn returns a synthetic entry id
      if (name === 'enqueueSpawn') return { spawnEntryId: `spawn-${Math.random().toString(36).slice(2, 10)}` };
      return undefined;
    },
  };
}

type MockHandle = ReturnType<typeof mockHandle>;

/** Create a mock Temporal Client with configurable handles. */
function mockClient(handles: MockHandle[] = []) {
  const handleMap = new Map<string, MockHandle>();
  for (const h of handles) {
    handleMap.set(h.workflowId, h);
  }

  return {
    workflow: {
      getHandle(workflowId: string) {
        const h = handleMap.get(workflowId);
        if (!h) throw new Error(`Workflow not found: ${workflowId}`);
        return h;
      },
      list(_opts: { query: string }) {
        // Return an async iterable over all handles
        return {
          [Symbol.asyncIterator]() {
            let i = 0;
            return {
              async next() {
                if (i < handles.length) {
                  return { value: { workflowId: handles[i++].workflowId }, done: false };
                }
                return { value: undefined, done: true as const };
              },
            };
          },
        };
      },
      async start() {
        return {} as unknown;
      },
    },
  } as unknown;
}

// ── resolveSession ──

describe('resolveSession', function () {
  it('returns handle when player matches ensemble and name', async function () {
    const handle = mockHandle({ metadata: { playerId: 'alice', ensemble: 'e1' } });
    const client = mockClient([handle]);
    const result = await resolveSession(client as any, 'e1', 'alice');
    expect(result).to.not.be.null;
    expect(result!.workflowId).to.equal(handle.workflowId);
  });

  it('returns null when no player matches', async function () {
    const handle = mockHandle({ metadata: { playerId: 'alice', ensemble: 'e1' } });
    const client = mockClient([handle]);
    const result = await resolveSession(client as any, 'e1', 'bob');
    expect(result).to.be.null;
  });

  it('returns null when ensemble does not match', async function () {
    const handle = mockHandle({ metadata: { playerId: 'alice', ensemble: 'e1' } });
    const client = mockClient([handle]);
    const result = await resolveSession(client as any, 'e2', 'alice');
    expect(result).to.be.null;
  });

  it('selects correct player among multiple sessions', async function () {
    const h1 = mockHandle({ metadata: { playerId: 'alice', ensemble: 'e1' } });
    const h2 = mockHandle({ metadata: { playerId: 'bob', ensemble: 'e1' } });
    const h3 = mockHandle({ metadata: { playerId: 'alice', ensemble: 'e2' } });
    const client = mockClient([h1, h2, h3]);

    const result = await resolveSession(client as any, 'e1', 'bob');
    expect(result).to.not.be.null;
    expect(result!.workflowId).to.equal(h2.workflowId);
  });

  it('skips workflows that throw on query (completed/terminated)', async function () {
    const badHandle = mockHandle({
      metadata: { playerId: 'ghost', ensemble: 'e1' },
      queryFn() { throw new Error('workflow completed'); },
    });
    const goodHandle = mockHandle({ metadata: { playerId: 'alice', ensemble: 'e1' } });
    const client = mockClient([badHandle, goodHandle]);

    const result = await resolveSession(client as any, 'e1', 'alice');
    expect(result).to.not.be.null;
    expect(result!.workflowId).to.equal(goodHandle.workflowId);
  });

  it('returns null when all workflows throw on query', async function () {
    const badHandle = mockHandle({
      metadata: { playerId: 'ghost', ensemble: 'e1' },
      queryFn() { throw new Error('workflow completed'); },
    });
    const client = mockClient([badHandle]);

    const result = await resolveSession(client as any, 'e1', 'ghost');
    expect(result).to.be.null;
  });
});

// ── scanEnsembleSessions ──

describe('scanEnsembleSessions', function () {
  it('returns sessions matching the ensemble', async function () {
    const h1 = mockHandle({ metadata: { playerId: 'alice', ensemble: 'e1', hostname: 'h1', workDir: '/a' }, part: 'coding' });
    const h2 = mockHandle({ metadata: { playerId: 'bob', ensemble: 'e2', hostname: 'h2', workDir: '/b' } });
    const client = mockClient([h1, h2]);

    const sessions = await scanEnsembleSessions(client as any, 'e1');
    expect(sessions).to.have.length(1);
    expect(sessions[0].playerId).to.equal('alice');
    expect(sessions[0].part).to.equal('coding');
    expect(sessions[0].hostname).to.equal('h1');
  });

  it('returns empty array when no sessions in ensemble', async function () {
    const h1 = mockHandle({ metadata: { playerId: 'alice', ensemble: 'other' } });
    const client = mockClient([h1]);

    const sessions = await scanEnsembleSessions(client as any, 'e1');
    expect(sessions).to.have.length(0);
  });

  it('skips workflows that throw on query', async function () {
    const bad = mockHandle({
      metadata: { playerId: 'ghost', ensemble: 'e1' },
      queryFn() { throw new Error('gone'); },
    });
    const good = mockHandle({ metadata: { playerId: 'alice', ensemble: 'e1' } });
    const client = mockClient([bad, good]);

    const sessions = await scanEnsembleSessions(client as any, 'e1');
    expect(sessions).to.have.length(1);
    expect(sessions[0].playerId).to.equal('alice');
  });

  it('includes conductor and agent type info', async function () {
    const h = mockHandle({
      metadata: {
        playerId: 'lead',
        ensemble: 'e1',
        isConductor: true,
        agentType: 'copilot',
        playerType: 'tempo-conductor',
        status: 'active',
      },
    });
    const client = mockClient([h]);

    const sessions = await scanEnsembleSessions(client as any, 'e1');
    expect(sessions[0].isConductor).to.be.true;
    expect(sessions[0].agentType).to.equal('copilot');
    expect(sessions[0].playerType).to.equal('tempo-conductor');
    expect(sessions[0].status).to.equal('active');
  });
});

// ── deliverCue ──

describe('deliverCue', function () {
  let activities: OutboxActivities;

  it('signals the target with from and text', async function () {
    const targetHandle = mockHandle({ metadata: { playerId: 'bob', ensemble: 'e1' } });
    const client = mockClient([targetHandle]);
    activities = createOutboxActivities(client as any, mockConfig());

    const result = await activities.deliverCue({
      ensemble: 'e1',
      fromPlayerId: 'alice',
      targetPlayerId: 'bob',
      message: 'hello',
    });

    expect(result.success).to.be.true;
    expect(targetHandle.signals).to.have.length(1);
    expect(targetHandle.signals[0].name).to.equal('receiveMessage');
    expect(targetHandle.signals[0].args).to.deep.include({ from: 'alice', text: 'hello' });
  });

  it('throws nonRetryable when target not found', async function () {
    const client = mockClient([]);
    activities = createOutboxActivities(client as any, mockConfig());

    try {
      await activities.deliverCue({
        ensemble: 'e1',
        fromPlayerId: 'alice',
        targetPlayerId: 'nonexistent',
        message: 'hello',
      });
      expect.fail('should have thrown');
    } catch (err) {
      expect(err).to.be.instanceOf(ApplicationFailure);
      expect((err as ApplicationFailure).message).to.include('nonexistent');
    }
  });
});

// ── deliverReport ──

describe('deliverReport', function () {
  it('signals the conductor with playerReport', async function () {
    const conductorId = conductorWorkflowId('e1');
    const conductorHandle = mockHandle({ metadata: { playerId: 'conductor', ensemble: 'e1', isConductor: true } });
    // Override the workflowId to match what conductorWorkflowId returns
    (conductorHandle as any).workflowId = conductorId;

    const client = mockClient([conductorHandle]);
    const activities = createOutboxActivities(client as any, mockConfig());

    const result = await activities.deliverReport({
      ensemble: 'e1',
      fromPlayerId: 'alice',
      text: 'task done',
      reportType: 'result',
    });

    expect(result.success).to.be.true;
    expect(conductorHandle.signals).to.have.length(1);
    expect(conductorHandle.signals[0].name).to.equal('playerReport');
    expect(conductorHandle.signals[0].args).to.deep.equal({
      playerId: 'alice',
      text: 'task done',
      type: 'result',
    });
  });

  it('throws nonRetryable when conductor workflow not found', async function () {
    const client = mockClient([]);
    const activities = createOutboxActivities(client as any, mockConfig());

    try {
      await activities.deliverReport({
        ensemble: 'e1',
        fromPlayerId: 'alice',
        text: 'help',
        reportType: 'blocker',
      });
      expect.fail('should have thrown');
    } catch (err) {
      expect(err).to.be.instanceOf(ApplicationFailure);
      expect((err as ApplicationFailure).message).to.include('conductor');
    }
  });
});

// ── terminateSession ──

describe('terminateSession', function () {
  it('sends destroy update to target and notifies conductor', async function () {
    const targetHandle = mockHandle({ metadata: { playerId: 'bob', ensemble: 'e1' } });
    const conductorId = conductorWorkflowId('e1');
    const conductorHandle = mockHandle({ metadata: { playerId: 'conductor', ensemble: 'e1' } });
    (conductorHandle as any).workflowId = conductorId;

    const client = mockClient([targetHandle, conductorHandle]);
    const activities = createOutboxActivities(client as any, mockConfig());

    const result = await activities.terminateSession({
      ensemble: 'e1',
      targetPlayerId: 'bob',
      terminatedBy: 'alice',
    });

    expect(result.success).to.be.true;
    // PR-C commit 4: target receives V2 destroy update (was legacy updateMetadata signal).
    expect(targetHandle.updates).to.have.length(1);
    expect(targetHandle.updates[0].name).to.equal('destroy');
    expect(targetHandle.updates[0].args).to.deep.include({ terminatedBy: 'alice' });
    // Conductor should be notified
    expect(conductorHandle.signals).to.have.length(1);
    expect(conductorHandle.signals[0].name).to.equal('receiveMessage');
  });

  it('throws nonRetryable when target not found', async function () {
    const client = mockClient([]);
    const activities = createOutboxActivities(client as any, mockConfig());

    try {
      await activities.terminateSession({
        ensemble: 'e1',
        targetPlayerId: 'ghost',
        terminatedBy: 'alice',
      });
      expect.fail('should have thrown');
    } catch (err) {
      expect(err).to.be.instanceOf(ApplicationFailure);
      expect((err as ApplicationFailure).message).to.include('ghost');
    }
  });

  it('succeeds even when conductor notification fails', async function () {
    const targetHandle = mockHandle({ metadata: { playerId: 'bob', ensemble: 'e1' } });
    // No conductor handle — notification will fail silently
    const client = mockClient([targetHandle]);
    const activities = createOutboxActivities(client as any, mockConfig());

    const result = await activities.terminateSession({
      ensemble: 'e1',
      targetPlayerId: 'bob',
      terminatedBy: 'alice',
    });

    expect(result.success).to.be.true;
    expect(targetHandle.updates[0].name).to.equal('destroy');
  });
});

// ── performEncore ──

describe('performEncore', function () {
  it('runs the §8.2 restart algorithm — claim + context + enqueueSpawn', async function () {
    const targetHandle = mockHandle({
      metadata: {
        playerId: 'bob',
        ensemble: 'e1',
        hostname: 'host1',
        workDir: '/work/dir',
        isConductor: false,
        agentType: 'claude',
        status: 'stale',
        sessionId: 'uuid-123',
      },
      attachmentInfo: { phase: 'detached', inFlightCount: 0 },
      part: 'was refactoring code',
      messages: [
        { from: 'alice', text: 'check the tests', timestamp: '2026-01-01T00:00:00Z' },
        { from: 'bob', text: 'on it', timestamp: '2026-01-01T00:01:00Z' },
      ],
    });
    const client = mockClient([targetHandle]);
    const activities = createOutboxActivities(client as any, mockConfig());

    const result = await activities.performEncore({
      ensemble: 'e1',
      targetPlayerId: 'bob',
      fromPlayerId: 'alice',
    });

    expect(result.success).to.be.true;
    expect(result.attachmentId).to.match(/^attach-/);
    expect(result.spawnEntryId).to.match(/^spawn-/);

    // Should have claimed an attachment + enqueued a spawn on the target.
    const claim = targetHandle.updates.find((u) => u.name === 'claimAttachment');
    expect(claim).to.exist;
    expect((claim!.args as any).host).to.equal('host1');
    expect((claim!.args as any).adapterClass).to.equal('interactive');

    const spawn = targetHandle.updates.find((u) => u.name === 'enqueueSpawn');
    expect(spawn).to.exist;
    expect((spawn!.args as any).resume).to.be.true;
    expect((spawn!.args as any).sessionId).to.equal('uuid-123');
    expect((spawn!.args as any).host).to.equal('host1');

    // Context message injected via `receiveMessage` signal.
    const contextSignal = targetHandle.signals.find((s) => s.name === 'receiveMessage');
    expect(contextSignal).to.exist;
    const text = (contextSignal!.args as any).text as string;
    expect(text).to.include('Encore');
    expect(text).to.include('alice');
    expect(text).to.include('was refactoring code');
  });

  it('forceDetaches an existing attachment before claiming a fresh one', async function () {
    const targetHandle = mockHandle({
      metadata: { playerId: 'bob', ensemble: 'e1', hostname: 'host1', workDir: '/w' },
      attachmentInfo: {
        phase: 'attached',
        inFlightCount: 0,
        currentAttachment: { attachmentId: 'old-attach', hostname: 'host1', adapterId: 'claude-code' },
      },
    });
    const client = mockClient([targetHandle]);
    const activities = createOutboxActivities(client as any, mockConfig());

    await activities.performEncore({
      ensemble: 'e1',
      targetPlayerId: 'bob',
      fromPlayerId: 'alice',
    });

    // Expect forceDetach BEFORE claim, with expectedAttachmentId guard.
    const forceDetach = targetHandle.updates.find((u) => u.name === 'forceDetach');
    expect(forceDetach).to.exist;
    expect((forceDetach!.args as any).expectedAttachmentId).to.equal('old-attach');
    expect((forceDetach!.args as any).gracePeriodMs).to.equal(0);

    const claim = targetHandle.updates.find((u) => u.name === 'claimAttachment');
    expect(claim).to.exist;
    // Ordering: detach first, then claim.
    const detachIdx = targetHandle.updates.findIndex((u) => u.name === 'forceDetach');
    const claimIdx = targetHandle.updates.findIndex((u) => u.name === 'claimAttachment');
    expect(detachIdx).to.be.lessThan(claimIdx);
  });

  it('rejects encore on destroyed (phase=gone) session', async function () {
    const targetHandle = mockHandle({
      metadata: { playerId: 'bob', ensemble: 'e1', status: 'terminated' },
      attachmentInfo: { phase: 'gone', inFlightCount: 0 },
    });
    const client = mockClient([targetHandle]);
    const activities = createOutboxActivities(client as any, mockConfig());

    try {
      await activities.performEncore({
        ensemble: 'e1',
        targetPlayerId: 'bob',
        fromPlayerId: 'alice',
      });
      expect.fail('should have thrown');
    } catch (err) {
      expect(err).to.be.instanceOf(ApplicationFailure);
      expect((err as ApplicationFailure).message).to.include('destroyed');
      expect((err as ApplicationFailure).message.toLowerCase()).to.include('recruit');
    }

    // Must not have claimed or enqueued on a destroyed target.
    expect(targetHandle.updates.find((u) => u.name === 'claimAttachment')).to.be.undefined;
    expect(targetHandle.updates.find((u) => u.name === 'enqueueSpawn')).to.be.undefined;
  });

  it('throws nonRetryable when target not found', async function () {
    const client = mockClient([]);
    const activities = createOutboxActivities(client as any, mockConfig());

    try {
      await activities.performEncore({
        ensemble: 'e1',
        targetPlayerId: 'ghost',
        fromPlayerId: 'alice',
      });
      expect.fail('should have thrown');
    } catch (err) {
      expect(err).to.be.instanceOf(ApplicationFailure);
      expect((err as ApplicationFailure).message).to.include('ghost');
    }
  });

  it('handles empty message history gracefully', async function () {
    const targetHandle = mockHandle({
      metadata: { playerId: 'bob', ensemble: 'e1', workDir: '/work', hostname: 'h1' },
      attachmentInfo: { phase: 'detached', inFlightCount: 0 },
      messages: [],
    });
    const client = mockClient([targetHandle]);
    const activities = createOutboxActivities(client as any, mockConfig());

    const result = await activities.performEncore({
      ensemble: 'e1',
      targetPlayerId: 'bob',
      fromPlayerId: 'alice',
    });

    expect(result.success).to.be.true;
    const contextSignal = targetHandle.signals.find((s) => s.name === 'receiveMessage');
    expect(contextSignal).to.exist;
    const text = (contextSignal!.args as any).text as string;
    expect(text).to.include('no recent messages');
  });

  it('skips forceDetach when already detached (phase=detached)', async function () {
    const targetHandle = mockHandle({
      metadata: { playerId: 'bob', ensemble: 'e1', workDir: '/w' },
      attachmentInfo: { phase: 'detached', inFlightCount: 0 },
    });
    const client = mockClient([targetHandle]);
    const activities = createOutboxActivities(client as any, mockConfig());

    await activities.performEncore({
      ensemble: 'e1',
      targetPlayerId: 'bob',
      fromPlayerId: 'alice',
    });

    // Already detached — no need to forceDetach.
    expect(targetHandle.updates.find((u) => u.name === 'forceDetach')).to.be.undefined;
    expect(targetHandle.updates.find((u) => u.name === 'claimAttachment')).to.exist;
  });
});

// ── computeNextCronFire ──

describe('computeNextCronFire', function () {
  let activities: ScheduleActivities;

  before(function () {
    activities = createScheduleActivities(mockClient() as any);
  });

  it('returns ISO datetime for valid cron expression', async function () {
    const result = await activities.computeNextCronFire({
      cronExpression: '0 12 * * *', // daily at noon UTC
    });
    expect(result).to.be.a('string');
    // Should be a valid ISO date
    const date = new Date(result!);
    expect(date.getTime()).to.be.greaterThan(Date.now());
    expect(date.getUTCHours()).to.equal(12);
    expect(date.getUTCMinutes()).to.equal(0);
  });

  it('respects timezone parameter', async function () {
    const result = await activities.computeNextCronFire({
      cronExpression: '0 9 * * *',
      timezone: 'America/New_York',
    });
    expect(result).to.be.a('string');
    expect(new Date(result!).getTime()).to.be.greaterThan(Date.now());
  });

  it('returns non-null for every-minute cron', async function () {
    const result = await activities.computeNextCronFire({
      cronExpression: '* * * * *',
    });
    expect(result).to.not.be.null;
  });
});

// ── fireSchedule ──

describe('fireSchedule', function () {
  it('delivers scheduled message to a named target', async function () {
    const targetHandle = mockHandle({ metadata: { playerId: 'bob', ensemble: 'e1' } });
    const client = mockClient([targetHandle]);
    const activities = createScheduleActivities(client as any);

    const result = await activities.fireSchedule({
      ensemble: 'e1',
      scheduleName: 'daily-standup',
      message: 'time for standup!',
      target: 'bob',
      createdBy: 'alice',
    });

    expect(result.success).to.be.true;
    expect(targetHandle.signals).to.have.length(1);
    expect(targetHandle.signals[0].name).to.equal('receiveMessage');
    const args = targetHandle.signals[0].args as any;
    expect(args.text).to.include('[scheduled: daily-standup]');
    expect(args.text).to.include('time for standup!');
    expect(args.from).to.equal('alice');
    expect(args.isScheduled).to.be.true;
    expect(args.scheduleName).to.equal('daily-standup');
  });

  it('returns failure when single target not found', async function () {
    // Creator exists to receive failure notification
    const creatorHandle = mockHandle({ metadata: { playerId: 'alice', ensemble: 'e1' } });
    const client = mockClient([creatorHandle]);
    const activities = createScheduleActivities(client as any);

    const result = await activities.fireSchedule({
      ensemble: 'e1',
      scheduleName: 'reminder',
      message: 'hey',
      target: 'ghost',
      createdBy: 'alice',
    });

    expect(result.success).to.be.false;
    expect(result.error).to.include('ghost');

    // Creator should have been notified of the failure
    expect(creatorHandle.signals.length).to.be.greaterThan(0);
    const failureNotification = creatorHandle.signals.find(
      s => ((s.args as any).text as string).includes('failed'),
    );
    expect(failureNotification).to.exist;
  });

  it('delivers to all non-conductor sessions when target is "all"', async function () {
    const player1 = mockHandle({ metadata: { playerId: 'p1', ensemble: 'e1', isConductor: false, status: 'active' } });
    const player2 = mockHandle({ metadata: { playerId: 'p2', ensemble: 'e1', isConductor: false, status: 'active' } });
    const conductor = mockHandle({ metadata: { playerId: 'cond', ensemble: 'e1', isConductor: true, status: 'active' } });
    const client = mockClient([player1, player2, conductor]);
    const activities = createScheduleActivities(client as any);

    const result = await activities.fireSchedule({
      ensemble: 'e1',
      scheduleName: 'broadcast',
      message: 'check in',
      target: 'all',
      createdBy: 'cond',
    });

    expect(result.success).to.be.true;
    // Players should receive messages, conductor should not
    expect(player1.signals).to.have.length(1);
    expect(player2.signals).to.have.length(1);
    expect(conductor.signals).to.have.length(0);
  });

  it('returns failure when target is "all" but no players exist', async function () {
    // Only a conductor in the ensemble — should be skipped by fireSchedule
    const conductor = mockHandle({ metadata: { playerId: 'cond', ensemble: 'e1', isConductor: true } });
    // Conductor workflow handle for failure notification (same handle, different lookup)
    (conductor as any).workflowId = conductorWorkflowId('e1');

    const client = mockClient([conductor]);
    const activities = createScheduleActivities(client as any);

    const result = await activities.fireSchedule({
      ensemble: 'e1',
      scheduleName: 'broadcast',
      message: 'anyone there?',
      target: 'all',
      createdBy: 'cond',
    });

    expect(result.success).to.be.false;
    expect(result.error).to.include('No active players');
  });

  it('skips sessions from other ensembles when target is "all"', async function () {
    const sameEnsemble = mockHandle({ metadata: { playerId: 'p1', ensemble: 'e1', isConductor: false } });
    const otherEnsemble = mockHandle({ metadata: { playerId: 'p2', ensemble: 'e2', isConductor: false } });
    const client = mockClient([sameEnsemble, otherEnsemble]);
    const activities = createScheduleActivities(client as any);

    const result = await activities.fireSchedule({
      ensemble: 'e1',
      scheduleName: 'test',
      message: 'msg',
      target: 'all',
      createdBy: 'admin',
    });

    expect(result.success).to.be.true;
    expect(sameEnsemble.signals).to.have.length(1);
    expect(otherEnsemble.signals).to.have.length(0);
  });
});

// ── Maestro activities ──

describe('maestro activities', function () {
  describe('refreshEnsembleState', function () {
    it('returns player info for sessions in the ensemble', async function () {
      const h = mockHandle({
        metadata: {
          playerId: 'alice',
          ensemble: 'e1',
          hostname: 'h1',
          workDir: '/work',
          isConductor: false,
          agentType: 'claude',
          playerType: 'tempo-soloist',
          status: 'active',
        },
        part: 'coding features',
      });
      const client = mockClient([h]);
      const activities = createMaestroActivities(client as any);

      const players = await activities.refreshEnsembleState('e1');
      expect(players).to.have.length(1);
      expect(players[0].playerId).to.equal('alice');
      expect(players[0].ensemble).to.equal('e1');
      expect(players[0].part).to.equal('coding features');
      expect(players[0].hostname).to.equal('h1');
      expect(players[0].playerType).to.equal('tempo-soloist');
    });

    it('returns empty array when no sessions match', async function () {
      const h = mockHandle({ metadata: { playerId: 'bob', ensemble: 'other' } });
      const client = mockClient([h]);
      const activities = createMaestroActivities(client as any);

      const players = await activities.refreshEnsembleState('e1');
      expect(players).to.have.length(0);
    });
  });

  describe('fetchConductorHistory', function () {
    it('returns history from conductor workflow', async function () {
      const historyData = [{ type: 'message', text: 'hello', timestamp: '2026-01-01T00:00:00Z' }];
      const conductorHandle = mockHandle({ history: historyData });
      (conductorHandle as any).workflowId = conductorWorkflowId('e1');
      const client = mockClient([conductorHandle]);
      const activities = createMaestroActivities(client as any);

      const result = await activities.fetchConductorHistory({ ensemble: 'e1' });
      expect(result.success).to.be.true;
      expect(result.history).to.deep.equal(historyData);
    });

    it('returns soft failure when conductor not found', async function () {
      const client = mockClient([]);
      const activities = createMaestroActivities(client as any);

      const result = await activities.fetchConductorHistory({ ensemble: 'e1' });
      expect(result.success).to.be.false;
      expect(result.history).to.deep.equal([]);
      expect(result.error).to.be.a('string');
    });
  });

  describe('relayCommandToConductor', function () {
    it('signals the conductor with command', async function () {
      const conductorHandle = mockHandle({ metadata: { playerId: 'cond', ensemble: 'e1' } });
      (conductorHandle as any).workflowId = conductorWorkflowId('e1');
      const client = mockClient([conductorHandle]);
      const activities = createMaestroActivities(client as any);

      const result = await activities.relayCommandToConductor({
        ensemble: 'e1',
        text: 'deploy now',
        source: 'dashboard',
      });

      expect(result.success).to.be.true;
      expect(conductorHandle.signals).to.have.length(1);
      expect(conductorHandle.signals[0].name).to.equal('command');
      expect(conductorHandle.signals[0].args).to.deep.include({
        text: 'deploy now',
        source: 'dashboard',
      });
    });

    it('includes replyTo when provided', async function () {
      const conductorHandle = mockHandle({ metadata: { playerId: 'cond', ensemble: 'e1' } });
      (conductorHandle as any).workflowId = conductorWorkflowId('e1');
      const client = mockClient([conductorHandle]);
      const activities = createMaestroActivities(client as any);

      const result = await activities.relayCommandToConductor({
        ensemble: 'e1',
        text: 'status?',
        source: 'ui',
        replyTo: 'cmd-123',
      });

      expect(result.success).to.be.true;
      expect(conductorHandle.signals[0].args).to.deep.include({ replyTo: 'cmd-123' });
    });

    it('returns soft failure when conductor not found', async function () {
      const client = mockClient([]);
      const activities = createMaestroActivities(client as any);

      const result = await activities.relayCommandToConductor({
        ensemble: 'e1',
        text: 'hello',
        source: 'test',
      });

      expect(result.success).to.be.false;
      expect(result.error).to.be.a('string');
    });
  });
});
