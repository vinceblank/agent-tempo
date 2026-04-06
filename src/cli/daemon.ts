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
  } catch (err: any) {
    // EPERM means the process exists but we lack permission (e.g., Windows UAC).
    // Treat it as running — the daemon is alive, we just can't signal it.
    if (err.code === 'EPERM') {
      return { running: true, pid };
    }
    // ESRCH or other errors mean the process is dead — clean up stale PID file
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
/** Lock file path for preventing concurrent daemon starts. */
const DAEMON_LOCK_PATH = DAEMON_PID_PATH + '.lock';

/**
 * Wait for the PID file to appear and contain a valid, live PID.
 * Used both by the spawning process and by processes waiting on the lock.
 */
async function waitForDaemonPid(timeoutMs: number): Promise<number> {
  const POLL_MS = 200;
  const deadline = Date.now() + timeoutMs;

  while (Date.now() < deadline) {
    await new Promise(resolve => setTimeout(resolve, POLL_MS));
    if (fs.existsSync(DAEMON_PID_PATH)) {
      const status = getDaemonStatus();
      if (status.running && status.pid) {
        return status.pid;
      }
    }
  }
  throw new Error('Daemon did not start within timeout. Check logs: ' + DAEMON_LOG_PATH);
}

export async function startDaemon(config: Config): Promise<number> {
  // Check if already running
  const status = getDaemonStatus();
  if (status.running && status.pid) {
    log(`Daemon already running (pid ${status.pid})`);
    return status.pid;
  }

  // Ensure daemon directory exists
  fs.mkdirSync(CLAUDE_TEMPO_HOME, { recursive: true });

  // Acquire exclusive lock to prevent concurrent daemon starts.
  // If another process is already starting the daemon, wait for the PID file.
  let lockFd: number;
  try {
    lockFd = fs.openSync(DAEMON_LOCK_PATH, 'wx'); // atomic create-or-fail
  } catch (err: any) {
    if (err.code === 'EEXIST') {
      // Another process is starting the daemon — wait for PID file
      log('Another process is starting the daemon — waiting...');
      return waitForDaemonPid(10_000);
    }
    throw err;
  }

  try {
    // Re-check after acquiring lock — daemon may have started between our
    // initial check and lock acquisition
    const recheck = getDaemonStatus();
    if (recheck.running && recheck.pid) {
      log(`Daemon already running (pid ${recheck.pid})`);
      return recheck.pid;
    }

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
    return await waitForDaemonPid(10_000);
  } finally {
    // Release lock
    fs.closeSync(lockFd);
    try { fs.unlinkSync(DAEMON_LOCK_PATH); } catch { /* ignore */ }
  }
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
