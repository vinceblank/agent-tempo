import * as path from 'path';
import * as fs from 'fs';
import { Worker, bundleWorkflowCode } from '@temporalio/worker';
import { Client } from '@temporalio/client';
import { Config } from './config';
import { createTemporalNativeConnection } from './connection';
import { createTemporalConnection } from './connection';
import { createScheduleActivities } from './activities/schedule-fire';

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

export async function createWorker(config: Config): Promise<Worker> {
  const connection = await createTemporalNativeConnection(config);

  // Create a Client connection for activities that need to interact with Temporal
  const clientConnection = await createTemporalConnection(config);
  const client = new Client({ connection: clientConnection, namespace: config.temporalNamespace });
  const scheduleActivities = createScheduleActivities(client);

  const workflowBundle = await getWorkflowBundle();

  return await Worker.create({
    connection,
    namespace: config.temporalNamespace,
    taskQueue: config.taskQueue,
    workflowBundle,
    activities: scheduleActivities,
  });
}
