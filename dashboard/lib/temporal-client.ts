import { Connection, Client } from '@temporalio/client';
import { Worker, NativeConnection } from '@temporalio/worker';
import * as path from 'path';
import * as fs from 'fs';

const TEMPORAL_ADDRESS = process.env.TEMPORAL_ADDRESS ?? 'localhost:7233';
const TEMPORAL_NAMESPACE = process.env.TEMPORAL_NAMESPACE ?? 'default';
const TASK_QUEUE = process.env.CLAUDE_TEMPO_TASK_QUEUE ?? 'claude-tempo';

// Singleton cached on globalThis to survive HMR
declare global {
  // eslint-disable-next-line no-var
  var __temporal_client__: Client | undefined;
  // eslint-disable-next-line no-var
  var __temporal_worker__: Worker | undefined;
}

export async function getTemporalClient(): Promise<Client> {
  if (globalThis.__temporal_client__) {
    return globalThis.__temporal_client__;
  }

  const connection = await Connection.connect({
    address: TEMPORAL_ADDRESS,
  });

  const client = new Client({
    connection,
    namespace: TEMPORAL_NAMESPACE,
  });

  globalThis.__temporal_client__ = client;
  return client;
}

export function getTaskQueue(): string {
  return TASK_QUEUE;
}

export async function ensureWorkerRunning(): Promise<void> {
  if (globalThis.__temporal_worker__) {
    return;
  }

  const bundlePath = path.resolve(process.cwd(), '..', 'workflow-bundle.js');
  if (!fs.existsSync(bundlePath)) {
    throw new Error(
      `Workflow bundle not found at ${bundlePath}. Run "npm run build" in the parent project first.`
    );
  }

  const connection = await NativeConnection.connect({
    address: TEMPORAL_ADDRESS,
  });

  const worker = await Worker.create({
    connection,
    namespace: TEMPORAL_NAMESPACE,
    taskQueue: TASK_QUEUE,
    workflowBundle: { code: fs.readFileSync(bundlePath, 'utf-8') },
  });

  globalThis.__temporal_worker__ = worker;

  // Run worker in background — don't block the server
  worker.run().catch((err) => {
    console.error('[temporal-worker] Worker stopped:', err);
    globalThis.__temporal_worker__ = undefined;
  });
}
