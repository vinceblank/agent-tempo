/**
 * Test helpers for claude-tempo workflow tests.
 *
 * Provides a shared TestWorkflowEnvironment and convenience functions
 * for common multi-step scenarios (start session, send message, etc.).
 */
import { TestWorkflowEnvironment } from '@temporalio/testing';
import { Worker } from '@temporalio/worker';
import { Client, WorkflowHandle, WorkflowIdConflictPolicy } from '@temporalio/client';
import * as path from 'path';
import * as fs from 'fs';
import { SessionInput, SessionMetadata, MaestroPlayerInfo } from '../src/types';
import {
  receiveMessageSignal,
  setPartSignal,
  setNameSignal,
  markDeliveredSignal,
  recordSentMessageSignal,
  updateMetadataSignal,
  getPartQuery,
  getMetadataQuery,
  pendingMessagesQuery,
  allMessagesQuery,
  allSentMessagesQuery,
  commandSignal,
  playerReportSignal,
  historyQuery,
  submitOutboxUpdate,
  outboxQuery,
  setQualityGateSignal,
  evaluateGateCriteriaSignal,
  qualityGatesQuery,
  setWorktreeSignal,
  removeWorktreeSignal,
  worktreesQuery,
} from '../src/workflows/signals';

// Re-export signals/queries for convenience in test files
export {
  receiveMessageSignal,
  setPartSignal,
  setNameSignal,
  markDeliveredSignal,
  recordSentMessageSignal,
  updateMetadataSignal,
  getPartQuery,
  getMetadataQuery,
  pendingMessagesQuery,
  allMessagesQuery,
  allSentMessagesQuery,
  commandSignal,
  playerReportSignal,
  historyQuery,
  submitOutboxUpdate,
  outboxQuery,
  setQualityGateSignal,
  evaluateGateCriteriaSignal,
  qualityGatesQuery,
  setWorktreeSignal,
  removeWorktreeSignal,
  worktreesQuery,
};

let testEnv: TestWorkflowEnvironment;
let workflowBundle: { code: string };

export const TASK_QUEUE = 'test-claude-tempo';

/**
 * Per-host task queue for spawnProcess activities.
 * The workflow routes spawnProcess to `claude-tempo-{hostname}`.
 * Tests use hostname 'test-host', so the queue is `claude-tempo-test-host`.
 */
const HOST_TASK_QUEUE = 'claude-tempo-test-host';

/**
 * Locate the pre-built workflow bundle. `npm run build` must be run first.
 * We walk up from __dirname until we find `workflow-bundle.js` at the project root.
 */
function findWorkflowBundle(): string {
  let dir = __dirname;
  for (let i = 0; i < 5; i++) {
    const candidate = path.join(dir, 'workflow-bundle.js');
    if (fs.existsSync(candidate)) return candidate;
    dir = path.dirname(dir);
  }
  throw new Error(
    'workflow-bundle.js not found. Run `npm run build` before running tests.',
  );
}

/**
 * Initialize the shared test environment. Call once in the top-level
 * before() hook.
 */
export async function setupTestEnv(): Promise<void> {
  testEnv = await TestWorkflowEnvironment.createLocal({
    server: {
      // Register custom search attributes at server startup
      extraArgs: [
        '--search-attribute', 'ClaudeTempoEnsemble=Keyword',
        '--search-attribute', 'ClaudeTempoPlayerId=Keyword',
        '--search-attribute', 'ClaudeTempoHostname=Keyword',
        '--search-attribute', 'ClaudeTempoGitRoot=Keyword',
        '--search-attribute', 'ClaudeTempoStatus=Keyword',
        '--search-attribute', 'ClaudeTempoPlayerType=Keyword',
      ],
    },
  });
  const bundlePath = findWorkflowBundle();
  workflowBundle = { code: fs.readFileSync(bundlePath, 'utf-8') };
}

/**
 * Tear down the shared test environment. Call once in the top-level
 * after() hook.
 */
export async function teardownTestEnv(): Promise<void> {
  await testEnv?.teardown();
}

/** Get the Temporal client from the test environment. */
export function getClient(): Client {
  return testEnv.client;
}

/**
 * Fast-forward the test environment's clock without waiting real time.
 * Uses Temporal's time-skipping test server — workflow timers and
 * `condition(..., timeout)` calls see the skipped time immediately.
 */
export async function skipTime(durationMs: number): Promise<void> {
  await testEnv.sleep(durationMs);
}

/**
 * Create and start a Worker that runs for the duration of `fn`.
 * The worker is shut down when `fn` resolves or rejects.
 */
export async function withWorker<T>(fn: () => Promise<T>): Promise<T> {
  const worker = await Worker.create({
    connection: testEnv.nativeConnection,
    taskQueue: TASK_QUEUE,
    workflowBundle,
  });
  return worker.runUntil(fn);
}

/**
 * Like withWorker, but also registers the schedule-fire activities
 * so the scheduler workflow can cue target players.
 */
export async function withWorkerAndActivities<T>(fn: () => Promise<T>): Promise<T> {
  const { createScheduleActivities } = await import('../src/activities/schedule-fire');
  const scheduleActivities = createScheduleActivities(testEnv.client);
  const worker = await Worker.create({
    connection: testEnv.nativeConnection,
    taskQueue: TASK_QUEUE,
    workflowBundle,
    activities: scheduleActivities,
  });
  return worker.runUntil(fn);
}

/** Default metadata for a player session. Override fields as needed. */
export function playerMetadata(overrides: Partial<SessionMetadata> = {}): SessionMetadata {
  return {
    playerId: `player-${Date.now()}`,
    ensemble: 'test-ensemble',
    hostname: 'test-host',
    workDir: '/tmp/test',
    isConductor: false,
    agentType: 'claude',
    ...overrides,
  };
}

/** Default metadata for a conductor session. Override fields as needed. */
export function conductorMetadata(overrides: Partial<SessionMetadata> = {}): SessionMetadata {
  return playerMetadata({
    playerId: 'conductor',
    isConductor: true,
    ...overrides,
  });
}

/**
 * Start a session workflow and return its handle.
 *
 * Usage:
 *   const handle = await startSession({ metadata: playerMetadata({ playerId: 'alice' }) });
 */
export async function startSession(
  inputOverrides: Partial<SessionInput> = {},
): Promise<WorkflowHandle> {
  const metadata = inputOverrides.metadata ?? playerMetadata();
  const input: SessionInput = {
    metadata,
    autoSummary: `Session in test`,
    disableStaleDetection: true, // prevent stale exits during tests
    ...inputOverrides,
    // Ensure metadata is always set (overrides above may have replaced it)
    ...(inputOverrides.metadata ? {} : { metadata }),
  };

  const workflowId = metadata.isConductor
    ? `claude-session-${metadata.ensemble}-conductor`
    : `claude-session-${metadata.ensemble}-${metadata.playerId}`;

  return testEnv.client.workflow.start('claudeSessionWorkflow', {
    workflowId,
    taskQueue: TASK_QUEUE,
    args: [input],
  });
}

/**
 * Send a message to a session and return the handle.
 */
export async function sendMessage(
  handle: WorkflowHandle,
  from: string,
  text: string,
): Promise<void> {
  await handle.signal(receiveMessageSignal, { from, text });
}

/**
 * Poll listEnsemble until at least `expectedCount` members are visible, or
 * the timeout elapses. Temporal's visibility store is eventually consistent —
 * a workflow that has just started may not appear in list queries immediately.
 * Use this in tests that start multiple sessions and then assert the count.
 */
export async function waitForEnsembleMembers(
  client: Client,
  ensemble: string,
  expectedCount: number,
  timeoutMs = 5000,
): Promise<SessionMetadata[]> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const members = await listEnsemble(client, ensemble);
    if (members.length >= expectedCount) return members;
    await new Promise<void>((r) => setTimeout(r, 100));
  }
  // Final attempt — let the caller's assertion produce the failure message
  return listEnsemble(client, ensemble);
}

/**
 * Query all running session workflows and return those matching the
 * given ensemble — mirrors the production ensemble tool logic.
 */
export async function listEnsemble(
  client: Client,
  ensemble: string,
): Promise<SessionMetadata[]> {
  const results: SessionMetadata[] = [];
  const query = `WorkflowType = "claudeSessionWorkflow" AND ExecutionStatus = "Running"`;

  for await (const wf of client.workflow.list({ query })) {
    try {
      const handle = client.workflow.getHandle(wf.workflowId);
      const metadata: SessionMetadata = await handle.query(getMetadataQuery);
      if (metadata.ensemble === ensemble) {
        results.push(metadata);
      }
    } catch {
      // skip completed workflows
    }
  }

  return results;
}

/**
 * Resolve a session by player name within an ensemble — mirrors
 * the production resolveSession logic.
 */
export async function resolveByName(
  client: Client,
  ensemble: string,
  playerName: string,
): Promise<WorkflowHandle | null> {
  const query = `WorkflowType = "claudeSessionWorkflow" AND ExecutionStatus = "Running"`;

  for await (const wf of client.workflow.list({ query })) {
    try {
      const handle = client.workflow.getHandle(wf.workflowId);
      const metadata: SessionMetadata = await handle.query(getMetadataQuery);
      if (metadata.ensemble === ensemble && metadata.playerId === playerName) {
        return handle;
      }
    } catch {
      // skip
    }
  }

  return null;
}

/**
 * Build the deterministic conductor workflow ID for an ensemble.
 */
export function conductorWorkflowId(ensemble: string): string {
  return `claude-session-${ensemble}-conductor`;
}

/**
 * Check if a conductor workflow is running for the given ensemble.
 */
export async function isConductorRunning(
  client: Client,
  ensemble: string,
): Promise<boolean> {
  try {
    const handle = client.workflow.getHandle(conductorWorkflowId(ensemble));
    const desc = await handle.describe();
    return desc.status.name === 'RUNNING';
  } catch {
    return false;
  }
}

/**
 * Start a session with USE_EXISTING policy — simulates what the MCP server
 * does when reconnecting to an existing workflow (e.g., conductor resume).
 */
/**
 * Like withWorker, but registers both schedule-fire and outbox activities.
 * spawnProcess is stubbed to avoid launching real terminals in tests.
 */
export async function withWorkerAndOutboxActivities<T>(fn: () => Promise<T>): Promise<T> {
  const { createScheduleActivities } = await import('../src/activities/schedule-fire');
  const { createOutboxActivities } = await import('../src/activities/outbox');

  const scheduleActivities = createScheduleActivities(testEnv.client);
  const outboxActivities = createOutboxActivities(testEnv.client, {
    temporalAddress: '',
    temporalNamespace: 'default',
    taskQueue: TASK_QUEUE,
    ensemble: 'test-ensemble',
    defaultAgent: 'claude',
  });

  const worker = await Worker.create({
    connection: testEnv.nativeConnection,
    taskQueue: TASK_QUEUE,
    workflowBundle,
    activities: {
      ...scheduleActivities,
      ...outboxActivities,
      // Stub spawnProcess to avoid launching real terminals
      spawnProcess: async () => ({ success: true }),
    },
  });
  return worker.runUntil(fn);
}

/**
 * Like withWorkerAndOutboxActivities, but also registers a second worker on the
 * per-host task queue used by `spawnProcess` during recruit dispatch.
 *
 * The session workflow routes `spawnProcess` to `claude-tempo-{hostname}`.
 * Tests use hostname 'test-host' (see playerMetadata), so we need a worker on
 * `claude-tempo-test-host` with a stubbed spawnProcess to avoid launching real terminals.
 */
export async function withWorkerAndRecruitActivities<T>(fn: () => Promise<T>): Promise<T> {
  const { createScheduleActivities } = await import('../src/activities/schedule-fire');
  const { createOutboxActivities } = await import('../src/activities/outbox');

  const scheduleActivities = createScheduleActivities(testEnv.client);
  const outboxActivities = createOutboxActivities(testEnv.client, {
    temporalAddress: '',
    temporalNamespace: 'default',
    taskQueue: TASK_QUEUE,
    ensemble: 'test-ensemble',
    defaultAgent: 'claude',
  });

  // Main worker: workflow execution + all outbox + schedule activities
  const mainWorker = await Worker.create({
    connection: testEnv.nativeConnection,
    taskQueue: TASK_QUEUE,
    workflowBundle,
    activities: {
      ...scheduleActivities,
      ...outboxActivities,
      spawnProcess: async () => ({ success: true }),
    },
  });

  // Per-host worker: handles spawnProcess for the 'test-host' hostname.
  // spawnProcess is routed to `claude-tempo-{hostname}` by the session workflow.
  // No workflowBundle — this worker only polls for activity tasks, matching
  // the production per-host worker config in src/worker.ts.
  const hostWorker = await Worker.create({
    connection: testEnv.nativeConnection,
    taskQueue: `claude-tempo-test-host`,
    activities: {
      spawnProcess: async () => ({ success: true }),
    },
  });

  return mainWorker.runUntil(async () => {
    const hostWorkerPromise = hostWorker.run();
    try {
      return await fn();
    } finally {
      hostWorker.shutdown();
      await hostWorkerPromise.catch(() => { /* cleanup */ });
    }
  });
}

/**
 * Like withWorkerAndRecruitActivities, but captures spawnProcess inputs
 * so tests can verify arguments passed through the recruit pipeline.
 */
export async function withWorkerAndRecruitCapture<T>(
  spawnInputs: Array<Record<string, unknown>>,
  fn: () => Promise<T>,
): Promise<T> {
  const { createScheduleActivities } = await import('../src/activities/schedule-fire');
  const { createOutboxActivities } = await import('../src/activities/outbox');

  const scheduleActivities = createScheduleActivities(testEnv.client);
  const outboxActivities = createOutboxActivities(testEnv.client, {
    temporalAddress: '',
    temporalNamespace: 'default',
    taskQueue: TASK_QUEUE,
    ensemble: 'test-ensemble',
    defaultAgent: 'claude',
  });

  const capturingSpawn = async (input: Record<string, unknown>) => {
    spawnInputs.push(input);
    return { success: true };
  };

  const mainWorker = await Worker.create({
    connection: testEnv.nativeConnection,
    taskQueue: TASK_QUEUE,
    workflowBundle,
    activities: {
      ...scheduleActivities,
      ...outboxActivities,
      spawnProcess: capturingSpawn,
    },
  });

  const hostWorker = await Worker.create({
    connection: testEnv.nativeConnection,
    taskQueue: `claude-tempo-test-host`,
    activities: {
      spawnProcess: capturingSpawn,
    },
  });

  return mainWorker.runUntil(async () => {
    const hostWorkerPromise = hostWorker.run();
    try {
      return await fn();
    } finally {
      hostWorker.shutdown();
      await hostWorkerPromise.catch(() => { /* cleanup */ });
    }
  });
}

/**
 * Like withWorkerAndActivities, but registers mocked Maestro activities.
 * The `mockPlayers` callback controls what `refreshEnsembleState` returns.
 * The `relayedCommands` array captures relayed command inputs.
 */
export async function withWorkerAndMaestroActivities<T>(
  opts: {
    mockPlayers?: () => MaestroPlayerInfo[];
    relayResult?: () => { success: boolean; error?: string };
  },
  fn: (relayedCommands: Array<{ text: string; source: string; replyTo?: string }>) => Promise<T>,
): Promise<T> {
  const mockPlayers = opts.mockPlayers ?? (() => []);
  const relayResult = opts.relayResult ?? (() => ({ success: true }));
  const relayedCommands: Array<{ text: string; source: string; replyTo?: string }> = [];

  const { createScheduleActivities } = await import('../src/activities/schedule-fire');
  const scheduleActivities = createScheduleActivities(testEnv.client);

  const worker = await Worker.create({
    connection: testEnv.nativeConnection,
    taskQueue: TASK_QUEUE,
    workflowBundle,
    activities: {
      ...scheduleActivities,
      refreshEnsembleState: async (_ensemble: string) => mockPlayers(),
      relayCommandToConductor: async (input: { text: string; source: string; replyTo?: string }) => {
        relayedCommands.push(input);
        return relayResult();
      },
      fetchConductorHistory: async () => ({ success: true, history: [] }),
      discoverEnsembles: async () => [],
      deliverMaestroMessage: async () => ({ success: true }),
      fetchPlayerMessages: async () => ({ success: true, messages: [] }),
      fetchEnsembleChat: async () => ({ success: true, newMessages: [], currentCounts: { maestroRecv: 0, maestroSent: 0, conductorRecv: 0, conductorSent: 0 }, hasConductor: false }),
      deliverCue: async () => {},
      deliverReport: async () => {},
      terminateSession: async () => {},
      startRecruitedSession: async () => ({ claudeSessionId: 'test' }),
      performEncore: async () => ({ hostname: 'test-host', workDir: '/tmp', isConductor: false, agent: 'claude', temporalAddress: '', temporalNamespace: 'default' }),
      spawnProcess: async () => ({ success: true }),
    },
  });
  return worker.runUntil(() => fn(relayedCommands));
}

/**
 * Like withWorkerAndMaestroActivities, but for the global Maestro workflow.
 * Supports multiple ensembles via the `mockEnsembles` and `mockPlayersByEnsemble` callbacks.
 */
export async function withWorkerAndGlobalMaestroActivities<T>(
  opts: {
    mockEnsembles?: () => string[];
    mockPlayersByEnsemble?: (ensemble: string) => MaestroPlayerInfo[];
    relayResult?: () => { success: boolean; error?: string };
    deliverResult?: () => { success: boolean; error?: string };
    fetchMessagesResult?: () => { success: boolean; messages: any[]; error?: string };
    fetchHistoryResult?: () => { success: boolean; history: any[]; error?: string };
  },
  fn: (relayedCommands: Array<{ ensemble: string; text: string; source: string; replyTo?: string }>) => Promise<T>,
): Promise<T> {
  const mockEnsembles = opts.mockEnsembles ?? (() => []);
  const mockPlayersByEnsemble = opts.mockPlayersByEnsemble ?? (() => []);
  const relayResult = opts.relayResult ?? (() => ({ success: true }));
  const deliverResult = opts.deliverResult ?? (() => ({ success: true }));
  const fetchMessagesResult = opts.fetchMessagesResult ?? (() => ({ success: true, messages: [] }));
  const fetchHistoryResult = opts.fetchHistoryResult ?? (() => ({ success: true, history: [] }));
  const relayedCommands: Array<{ ensemble: string; text: string; source: string; replyTo?: string }> = [];

  const { createScheduleActivities } = await import('../src/activities/schedule-fire');
  const scheduleActivities = createScheduleActivities(testEnv.client);

  const worker = await Worker.create({
    connection: testEnv.nativeConnection,
    taskQueue: TASK_QUEUE,
    workflowBundle,
    activities: {
      ...scheduleActivities,
      discoverEnsembles: async () => mockEnsembles(),
      refreshEnsembleState: async (ensemble: string) => mockPlayersByEnsemble(ensemble),
      relayCommandToConductor: async (input: { ensemble: string; text: string; source: string; replyTo?: string }) => {
        relayedCommands.push(input);
        return relayResult();
      },
      deliverMaestroMessage: async () => deliverResult(),
      fetchPlayerMessages: async () => fetchMessagesResult(),
      fetchConductorHistory: async () => fetchHistoryResult(),
      fetchEnsembleChat: async () => ({ success: true, newMessages: [], currentCounts: { maestroRecv: 0, maestroSent: 0, conductorRecv: 0, conductorSent: 0 }, hasConductor: false }),
      deliverCue: async () => {},
      deliverReport: async () => {},
      terminateSession: async () => {},
      startRecruitedSession: async () => ({ claudeSessionId: 'test' }),
      performEncore: async () => ({ hostname: 'test-host', workDir: '/tmp', isConductor: false, agent: 'claude', temporalAddress: '', temporalNamespace: 'default' }),
      spawnProcess: async () => ({ success: true }),
    },
  });
  return worker.runUntil(() => fn(relayedCommands));
}

export async function reconnectSession(
  inputOverrides: Partial<SessionInput> = {},
): Promise<WorkflowHandle> {
  const metadata = inputOverrides.metadata ?? playerMetadata();
  const input: SessionInput = {
    metadata,
    autoSummary: `Session in test`,
    disableStaleDetection: true,
    ...inputOverrides,
    ...(inputOverrides.metadata ? {} : { metadata }),
  };

  const workflowId = metadata.isConductor
    ? `claude-session-${metadata.ensemble}-conductor`
    : `claude-session-${metadata.ensemble}-${metadata.playerId}`;

  return testEnv.client.workflow.start('claudeSessionWorkflow', {
    workflowId,
    taskQueue: TASK_QUEUE,
    args: [input],
    workflowIdConflictPolicy: WorkflowIdConflictPolicy.USE_EXISTING,
  });
}
