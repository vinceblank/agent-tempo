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
import { getConfig, CLAUDE_TEMPO_HOME } from './config';
import { createWorkers } from './worker';
import { DAEMON_PID_PATH, DAEMON_LOG_PATH } from './cli/daemon';

const log = (...args: unknown[]) => console.error(`[claude-tempo:daemon ${new Date().toISOString()}]`, ...args);

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

  // Create and run both workers
  log(`Connecting to Temporal at ${config.temporalAddress} (namespace: ${config.temporalNamespace})`);
  const { sharedWorker, hostWorker } = await createWorkers(config);
  log('Workers created — processing tasks');

  // Graceful shutdown handler
  let shuttingDown = false;
  const shutdown = async () => {
    if (shuttingDown) return;
    shuttingDown = true;
    log('Shutting down...');

    // Hard exit safety net
    const hardExit = setTimeout(() => {
      log('Shutdown timeout — forcing exit');
      process.exit(1);
    }, 15_000);
    hardExit.unref();

    sharedWorker.shutdown();
    hostWorker.shutdown();

    // Remove PID file
    try { fs.unlinkSync(DAEMON_PID_PATH); } catch { /* ignore */ }

    log('Daemon stopped');
    process.exit(0);
  };

  process.on('SIGTERM', shutdown);
  process.on('SIGINT', shutdown);

  // Run both workers — blocks until shutdown
  try {
    await Promise.all([sharedWorker.run(), hostWorker.run()]);
  } catch (err) {
    log('Worker error:', err);
    try { fs.unlinkSync(DAEMON_PID_PATH); } catch { /* ignore */ }
    process.exit(1);
  }
}

main().catch((err) => {
  log('Fatal error:', err);
  try { fs.unlinkSync(DAEMON_PID_PATH); } catch { /* ignore */ }
  process.exit(1);
});
