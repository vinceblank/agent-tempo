#!/usr/bin/env node
/**
 * Daemon entry point — runs Temporal workers in a detached background process.
 *
 * Started by `startDaemon()` in `src/cli/daemon.ts`.
 * Config is passed via environment variables set by the parent.
 *
 * Writes its PID to ~/.claude-tempo/daemon.pid on startup and removes it
 * on graceful shutdown (SIGTERM/SIGINT).
 */
import * as fs from 'fs';
import { Client } from '@temporalio/client';
import { WorkflowIdConflictPolicy } from '@temporalio/client';
import { getConfig, CLAUDE_TEMPO_HOME, GLOBAL_MAESTRO_WORKFLOW_ID } from './config';
import { createWorkers } from './worker';
import { createTemporalConnection } from './connection';
import { DAEMON_PID_PATH, DAEMON_LOG_PATH } from './cli/daemon';
import type { GlobalMaestroInput } from './types';

const log = (...args: unknown[]) => console.error(`[claude-tempo:daemon ${new Date().toISOString()}]`, ...args);

/**
 * Ensure the global Maestro workflow is running.
 * Uses USE_EXISTING conflict policy so it's safe to call on every daemon start.
 */
async function ensureGlobalMaestro(config: ReturnType<typeof getConfig>): Promise<void> {
  try {
    const connection = await createTemporalConnection(config);
    const client = new Client({ connection, namespace: config.temporalNamespace });

    const input: GlobalMaestroInput = {};
    await client.workflow.start('claudeGlobalMaestroWorkflow', {
      workflowId: GLOBAL_MAESTRO_WORKFLOW_ID,
      taskQueue: config.taskQueue,
      args: [input],
      workflowIdConflictPolicy: WorkflowIdConflictPolicy.USE_EXISTING,
    });
    log(`Global Maestro ensured (id: ${GLOBAL_MAESTRO_WORKFLOW_ID})`);
  } catch (err) {
    // Non-fatal — the global maestro is optional for basic operation
    log('Failed to ensure global Maestro (non-fatal):', err instanceof Error ? err.message : String(err));
  }
}

async function main() {
  // Ensure daemon directory exists
  fs.mkdirSync(CLAUDE_TEMPO_HOME, { recursive: true });

  // Write PID file — the parent polls for this to confirm startup
  fs.writeFileSync(DAEMON_PID_PATH, String(process.pid));
  log(`Daemon started (pid ${process.pid})`);
  log(`PID file: ${DAEMON_PID_PATH}`);
  log(`Log file: ${DAEMON_LOG_PATH}`);

  // Get config from env vars (passed by startDaemon via spawn env)
  const config = getConfig({});

  // Use mutable refs so signal handlers can be registered before workers
  // are created — closes the narrow window where a SIGTERM during
  // createWorkers() would be missed.
  let sharedWorker: Awaited<ReturnType<typeof createWorkers>>['sharedWorker'] | null = null;
  let hostWorker: Awaited<ReturnType<typeof createWorkers>>['hostWorker'] | null = null;

  // Register signal handlers first — idempotent, drain-only (no process.exit).
  let shuttingDown = false;
  const hardExit = () => {
    log('Shutdown timeout — forcing exit');
    try { fs.unlinkSync(DAEMON_PID_PATH); } catch { /* ignore */ }
    process.exit(1);
  };
  const shutdown = () => {
    if (shuttingDown) return;
    shuttingDown = true;
    log('Shutting down (draining in-flight activities)...');
    // Safety net: force exit if workers don't stop within 15s
    const timer = setTimeout(hardExit, 15_000);
    timer.unref();
    sharedWorker?.shutdown();
    hostWorker?.shutdown();
  };
  process.on('SIGTERM', shutdown);
  process.on('SIGINT', shutdown);

  // Create workers (signal handlers already active via mutable refs)
  log(`Connecting to Temporal at ${config.temporalAddress} (namespace: ${config.temporalNamespace})`);
  const workers = await createWorkers(config);
  sharedWorker = workers.sharedWorker;
  hostWorker = workers.hostWorker;
  log('Workers created — processing tasks');

  // Auto-start the global Maestro workflow (non-blocking, non-fatal)
  ensureGlobalMaestro(config).catch((err) => {
    log('ensureGlobalMaestro background error:', err);
  });

  // Run both workers — blocks until shutdown + drain completes
  try {
    await Promise.all([sharedWorker.run(), hostWorker.run()]);
  } catch (err) {
    log('Worker error:', err);
  }

  // Workers have stopped — clean up PID file and exit
  try { fs.unlinkSync(DAEMON_PID_PATH); } catch { /* ignore */ }
  log('Daemon stopped');
  process.exit(0);
}

main().catch((err) => {
  log('Fatal error:', err);
  try { fs.unlinkSync(DAEMON_PID_PATH); } catch { /* ignore */ }
  process.exit(1);
});
