/**
 * Daemon process management utilities.
 *
 * The daemon runs Temporal workers in a detached background process,
 * replacing the per-session workers. MCP sessions become pure clients.
 */
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { spawn } from 'child_process';
import { CLAUDE_TEMPO_HOME, Config, ENV } from '../config';

const log = (...args: unknown[]) => console.error('[claude-tempo:daemon]', ...args);

export const DAEMON_PID_PATH = path.join(CLAUDE_TEMPO_HOME, 'daemon.pid');
export const DAEMON_LOG_PATH = path.join(CLAUDE_TEMPO_HOME, 'daemon.log');

/** Entry point for the daemon process (compiled JS). */
const DAEMON_ENTRY_PATH = path.resolve(__dirname, '..', 'daemon.js');

export interface DaemonStatus {
  running: boolean;
  pid?: number;
}

/**
 * Check if the daemon is running by reading the PID file and probing the process.
 * Cleans up stale PID files automatically.
 */
export function isDaemonRunning(): boolean {
  return getDaemonStatus().running;
}

/**
 * Get daemon status: running state and PID (if available).
 */
export function getDaemonStatus(): DaemonStatus {
  if (!fs.existsSync(DAEMON_PID_PATH)) {
    return { running: false };
  }

  let pid: number;
  try {
    pid = parseInt(fs.readFileSync(DAEMON_PID_PATH, 'utf8').trim(), 10);
    if (isNaN(pid)) {
      // Corrupt PID file
      fs.unlinkSync(DAEMON_PID_PATH);
      return { running: false };
    }
  } catch {
    return { running: false };
  }

  // Probe the process — kill(pid, 0) checks existence without sending a signal
  try {
    process.kill(pid, 0);
    return { running: true, pid };
  } catch {
    // Process is dead — clean up stale PID file
    try { fs.unlinkSync(DAEMON_PID_PATH); } catch { /* ignore */ }
    return { running: false };
  }
}

/**
 * Start the daemon process. If already running, returns the existing PID.
 *
 * The daemon is spawned as a detached child process with stdout/stderr
 * redirected to a log file. Config is passed via environment variables.
 */
export async function startDaemon(config: Config): Promise<number> {
  // Check if already running
  const status = getDaemonStatus();
  if (status.running && status.pid) {
    log(`Daemon already running (pid ${status.pid})`);
    return status.pid;
  }

  // Ensure daemon directory exists
  fs.mkdirSync(CLAUDE_TEMPO_HOME, { recursive: true });

  // Open log file for daemon stdout/stderr
  const logFd = fs.openSync(DAEMON_LOG_PATH, 'a');

  // Pass Temporal config to daemon via environment variables
  const env: Record<string, string> = {
    ...process.env as Record<string, string>,
    [ENV.TEMPORAL_ADDRESS]: config.temporalAddress,
    [ENV.TEMPORAL_NAMESPACE]: config.temporalNamespace,
    [ENV.TASK_QUEUE]: config.taskQueue,
  };
  if (config.temporalApiKey) env[ENV.TEMPORAL_API_KEY] = config.temporalApiKey;
  if (config.temporalTlsCertPath) env[ENV.TEMPORAL_TLS_CERT_PATH] = config.temporalTlsCertPath;
  if (config.temporalTlsKeyPath) env[ENV.TEMPORAL_TLS_KEY_PATH] = config.temporalTlsKeyPath;

  const child = spawn(process.execPath, [DAEMON_ENTRY_PATH], {
    detached: true,
    stdio: ['ignore', logFd, logFd],
    env,
  });
  child.unref();
  fs.closeSync(logFd);

  log(`Spawned daemon process (pid ${child.pid})`);

  // Wait for PID file to appear (daemon writes it on startup)
  const TIMEOUT_MS = 10_000;
  const POLL_MS = 200;
  const deadline = Date.now() + TIMEOUT_MS;

  while (Date.now() < deadline) {
    await new Promise(resolve => setTimeout(resolve, POLL_MS));
    if (fs.existsSync(DAEMON_PID_PATH)) {
      const daemonStatus = getDaemonStatus();
      if (daemonStatus.running && daemonStatus.pid) {
        return daemonStatus.pid;
      }
    }
  }

  throw new Error('Daemon did not start within 10 seconds. Check logs: ' + DAEMON_LOG_PATH);
}

/**
 * Stop the daemon process by sending SIGTERM (or killing on Windows).
 * Returns true if the daemon was stopped, false if it wasn't running.
 */
export function stopDaemon(): boolean {
  const status = getDaemonStatus();
  if (!status.running || !status.pid) {
    return false;
  }

  try {
    if (process.platform === 'win32') {
      // Windows doesn't support SIGTERM — just kill the process
      process.kill(status.pid);
    } else {
      process.kill(status.pid, 'SIGTERM');
    }
  } catch {
    // Process may have already exited
  }

  // Clean up PID file
  try { fs.unlinkSync(DAEMON_PID_PATH); } catch { /* ignore */ }

  return true;
}
