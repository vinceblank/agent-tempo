import * as path from 'path';
import * as fs from 'fs';
import { Worker, bundleWorkflowCode } from '@temporalio/worker';
import { Config } from './config';
import { createTemporalNativeConnection } from './connection';

const BUNDLE_PATH = path.resolve(__dirname, '..', 'workflow-bundle.js');

async function getWorkflowBundle(): Promise<{ code: string }> {
  // Use pre-built bundle if it exists, otherwise bundle from source
  if (fs.existsSync(BUNDLE_PATH)) {
    return { code: fs.readFileSync(BUNDLE_PATH, 'utf-8') };
  }
  const bundle = await bundleWorkflowCode({
    workflowsPath: path.resolve(__dirname, 'workflows', 'session'),
  });
  // Cache for subsequent workers
  fs.writeFileSync(BUNDLE_PATH, bundle.code);
  return bundle;
}

export async function createWorker(config: Config): Promise<Worker> {
  const connection = await createTemporalNativeConnection(config);

  const workflowBundle = await getWorkflowBundle();

  return await Worker.create({
    connection,
    namespace: config.temporalNamespace,
    taskQueue: config.taskQueue,
    workflowBundle,
  });
}
