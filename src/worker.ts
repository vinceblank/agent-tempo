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

const BUNDLE_PATH = path.resolve(__dirname, '..', 'workflow-bundle.js');

async function getWorkflowBundle(): Promise<{ code: string }> {
  // Use pre-built bundle if it exists, otherwise bundle from source
  if (fs.existsSync(BUNDLE_PATH)) {
    return { code: fs.readFileSync(BUNDLE_PATH, 'utf-8') };
  }
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

  const sharedWorker = await Worker.create({
    connection,
    namespace: config.temporalNamespace,
    taskQueue: config.taskQueue,
    workflowBundle,
    activities: {
      ...scheduleActivities,
      // Shared-queue delivery activities (everything except spawnProcess)
      deliverCue: outboxActivities.deliverCue,
      deliverReport: outboxActivities.deliverReport,
      terminateSession: outboxActivities.terminateSession,
      startRecruitedSession: outboxActivities.startRecruitedSession,
    },
  });

  // Per-host worker — spawnProcess only, no workflow bundle
  const hostConnection = await createTemporalNativeConnection(config);
  const hostWorker = await Worker.create({
    connection: hostConnection,
    namespace: config.temporalNamespace,
    taskQueue: hostTaskQueue(config.taskQueue, os.hostname()),
    activities: {
      spawnProcess: outboxActivities.spawnProcess,
    },
  });

  return { sharedWorker, hostWorker };
}

/** @deprecated Use createWorkers() instead — kept for backward compat during migration */
export async function createWorker(config: Config): Promise<Worker> {
  const { sharedWorker } = await createWorkers(config);
  return sharedWorker;
}
