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

  // Register signal handlers BEFORE running workers — ensures we catch
  // signals even during worker startup. Handlers just trigger graceful
  // drain; they do NOT call process.exit() — that happens after workers
  // finish processing in-flight activities below.
  const hardExit = () => {
    log('Shutdown timeout — forcing exit');
    try { fs.unlinkSync(DAEMON_PID_PATH); } catch { /* ignore */ }
    process.exit(1);
  };
  const shutdown = () => {
    log('Shutting down (draining in-flight activities)...');
    // Safety net: force exit if workers don't stop within 15s
    const timer = setTimeout(hardExit, 15_000);
    timer.unref();
    sharedWorker.shutdown();
    hostWorker.shutdown();
  };
  process.on('SIGTERM', shutdown);
  process.on('SIGINT', shutdown);

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
