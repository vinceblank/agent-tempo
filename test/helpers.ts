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
import { SessionInput, SessionMetadata } from '../src/types';
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
};

let testEnv: TestWorkflowEnvironment;
let workflowBundle: { code: string };

const TASK_QUEUE = 'test-claude-tempo';

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
