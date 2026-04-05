import * as path from 'path';
import * as os from 'os';
import * as fs from 'fs';
import { Worker, bundleWorkflowCode } from '@temporalio/worker';
import { Client } from '@temporalio/client';
import { Config, hostTaskQueue } from './config';
import { createTemporalNativeConnection } from './connection';
import { createTemporalConnection } from './connection';
import { createScheduleActivities } from './activities/schedule-fire';
import { createOutboxActivities } from './activities/outbox';

const log = (...args: unknown[]) => console.error('[claude-tempo:worker]', ...args);

const BUNDLE_PATH = path.resolve(__dirname, '..', 'workflow-bundle.js');

async function getWorkflowBundle(): Promise<{ code: string }> {
  // Use pre-built bundle if it exists, otherwise bundle from source
  if (fs.existsSync(BUNDLE_PATH)) {
    log(`Loading pre-built workflow bundle from ${BUNDLE_PATH}`);
    return { code: fs.readFileSync(BUNDLE_PATH, 'utf-8') };
  }
  log('No pre-built workflow bundle found — bundling from source (run `npm run build` to avoid this)');
  const bundle = await bundleWorkflowCode({
    workflowsPath: path.resolve(__dirname, 'workflows', 'index'),
  });
  // Cache for subsequent workers
  fs.writeFileSync(BUNDLE_PATH, bundle.code);
  return bundle;
}

export interface DualWorkers {
  /** Shared queue worker: workflows + delivery activities + schedule activities */
  sharedWorker: Worker;
  /** Per-host queue worker: spawnProcess activity only */
  hostWorker: Worker;
}

/**
 * Create dual workers:
 * - Shared queue: workflows + all delivery activities (deliverCue, deliverReport, terminateSession, startRecruitedSession) + schedule activities
 * - Per-host queue: spawnProcess only (routes recruit spawns to the correct machine)
 */
export async function createWorkers(config: Config): Promise<DualWorkers> {
  const connection = await createTemporalNativeConnection(config);

  // Create a Client connection for activities that need to interact with Temporal
  const clientConnection = await createTemporalConnection(config);
  const client = new Client({ connection: clientConnection, namespace: config.temporalNamespace });
  const scheduleActivities = createScheduleActivities(client);
  const outboxActivities = createOutboxActivities(client, config);

  const workflowBundle = await getWorkflowBundle();

  const SHUTDOWN_GRACE_TIME = '10s';
  const SHUTDOWN_FORCE_TIME = '15s';

  const sharedWorker = await Worker.create({
    connection,
    namespace: config.temporalNamespace,
    taskQueue: config.taskQueue,
    workflowBundle,
    shutdownGraceTime: SHUTDOWN_GRACE_TIME,
    shutdownForceTime: SHUTDOWN_FORCE_TIME,
    activities: {
      ...scheduleActivities,
      // Shared-queue delivery activities (everything except spawnProcess)
      deliverCue: outboxActivities.deliverCue,
      deliverReport: outboxActivities.deliverReport,
      terminateSession: outboxActivities.terminateSession,
      startRecruitedSession: outboxActivities.startRecruitedSession,
      performEncore: outboxActivities.performEncore,
    },
  });

  // Per-host worker — spawnProcess only, no workflow bundle
  const hostConnection = await createTemporalNativeConnection(config);
  const hostWorker = await Worker.create({
    connection: hostConnection,
    namespace: config.temporalNamespace,
    taskQueue: hostTaskQueue(config.taskQueue, os.hostname()),
    shutdownGraceTime: SHUTDOWN_GRACE_TIME,
    shutdownForceTime: SHUTDOWN_FORCE_TIME,
    activities: {
      spawnProcess: outboxActivities.spawnProcess,
    },
  });

  return { sharedWorker, hostWorker };
}

/**
 * @deprecated Removed in v0.10 — use `createWorkers()` instead.
 * The old single-worker API silently leaked the hostWorker and broke
 * cross-machine recruiting.
 */
export async function createWorker(_config: Config): Promise<never> {
  throw new Error(
    'createWorker() has been removed. Use createWorkers() instead — it returns { sharedWorker, hostWorker } and both must be run.',
  );
}
