/**
 * Daemon process management utilities.
 *
 * The daemon runs Temporal workers in a detached background process,
 * replacing the per-session workers. MCP sessions become pure clients.
 */
import * as fs from 'fs';
import * as path from 'path';
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
 * Probe whether a PID refers to a live process using `kill(pid, 0)`.
 *
 * EPERM is reported on Windows for foreign (UAC-isolated) processes and
 * must be treated as "alive" — we just can't signal it. Anything else
 * (ESRCH, ENOENT, invalid-pid) means the process is gone.
 */
function isPidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === 'EPERM';
  }
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
      fs.unlinkSync(DAEMON_PID_PATH);
      return { running: false };
    }
  } catch {
    return { running: false };
  }

  if (isPidAlive(pid)) {
    return { running: true, pid };
  }
  // Process is dead — clean up stale PID file.
  try { fs.unlinkSync(DAEMON_PID_PATH); } catch { /* ignore */ }
  return { running: false };
}

/**
 * Start the daemon process. If already running, returns the existing PID.
 *
 * The daemon is spawned as a detached child process with stdout/stderr
 * redirected to a log file. Config is passed via environment variables.
 */
/** Lock file path for preventing concurrent daemon starts. */
export const DAEMON_LOCK_PATH = DAEMON_PID_PATH + '.lock';

/**
 * How long a start lock can sit on disk before we treat it as abandoned
 * regardless of whether the recorded PID appears alive. Daemon startup
 * should never take this long; longer values just delay recovery after a
 * crashed starter (see issue #182).
 */
export const STALE_LOCK_MS = 30_000;

/**
 * Timeout for waiting on another starter's PID file — generous window for
 * cold-start slack on fresh installs (npm-global, uncompiled native deps).
 * Bumped from 10s per researcher recommendation for issue #182.
 */
export const DAEMON_START_TIMEOUT_MS = 30_000;

/** Shape of the JSON persisted inside the start lock. */
export interface LockFileContent {
  /** PID of the process that acquired the lock. */
  pid: number;
  /** ms-since-epoch when the lock was acquired — used for age-based staleness. */
  mtime: number;
}

/**
 * Attempt to atomically create the start lock with {pid, mtime} contents.
 *
 * Returns `true` on success, `false` if the lock already exists. Any other
 * error (EACCES, ENOSPC, …) propagates. Exported for unit testing the
 * acquire path without spawning a real daemon.
 */
export function tryAcquireLockFile(
  lockPath: string,
  pid: number = process.pid,
  now: number = Date.now(),
): boolean {
  try {
    const content: LockFileContent = { pid, mtime: now };
    // `wx` = atomic create-or-fail with EEXIST on conflict. Combined with
    // writeFileSync, this writes the content in the same syscall sequence,
    // so a racing reader never observes a zero-byte lock.
    fs.writeFileSync(lockPath, JSON.stringify(content), { flag: 'wx' });
    return true;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'EEXIST') return false;
    throw err;
  }
}

/**
 * Inspect a start lock and decide whether it's abandoned.
 *
 * A lock is stale when any of:
 *  - the file is missing (treat as stale so callers retry immediately)
 *  - the contents are malformed (not JSON, missing pid/mtime)
 *  - mtime is older than {@link STALE_LOCK_MS}
 *  - `process.kill(pid, 0)` reports ESRCH (or anything other than EPERM)
 *
 * EPERM on the PID probe is treated as "alive" to match
 * {@link getDaemonStatus} — on Windows, UAC-isolated foreign processes
 * return EPERM for a running PID, so we must not interpret it as dead.
 *
 * Exported for unit testing.
 */
export function checkLockFileStale(
  lockPath: string,
  now: number = Date.now(),
): {
  stale: boolean;
  reason: string;
  content: LockFileContent | null;
} {
  let raw: string;
  try {
    raw = fs.readFileSync(lockPath, 'utf8');
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === 'ENOENT') {
      return { stale: true, reason: 'lock file missing', content: null };
    }
    return { stale: true, reason: `lock file unreadable (${code ?? 'unknown'})`, content: null };
  }

  let content: LockFileContent | null = null;
  try {
    const parsed = JSON.parse(raw);
    if (typeof parsed?.pid === 'number' && typeof parsed?.mtime === 'number') {
      content = { pid: parsed.pid, mtime: parsed.mtime };
    }
  } catch {
    // fall through — malformed
  }
  if (!content) {
    const preview = raw.length > 80 ? raw.slice(0, 80) + '…' : raw;
    return {
      stale: true,
      reason: `malformed lock content: ${JSON.stringify(preview)}`,
      content: null,
    };
  }

  const ageMs = now - content.mtime;
  if (ageMs > STALE_LOCK_MS) {
    return {
      stale: true,
      reason: `mtime ${Math.round(ageMs / 1000)}s old (>${STALE_LOCK_MS / 1000}s threshold)`,
      content,
    };
  }

  if (isPidAlive(content.pid)) {
    return {
      stale: false,
      reason: `pid ${content.pid} alive, mtime ${ageMs}ms old`,
      content,
    };
  }
  return {
    stale: true,
    reason: `pid ${content.pid} not alive`,
    content,
  };
}

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

  // Acquire exclusive start lock. If another process holds the lock, decide
  // whether to wait for it (live starter) or auto-repair it (stale from a
  // crashed prior attempt — issue #182).
  let acquired = tryAcquireLockFile(DAEMON_LOCK_PATH);
  if (!acquired) {
    const state = checkLockFileStale(DAEMON_LOCK_PATH);
    if (state.stale) {
      // Loud log — silent self-healing hides bugs. If this fires repeatedly
      // it's a signal that daemon startup is crashing before PID-file write.
      log(`⚠️  Stale daemon start lock detected — auto-repairing (${state.reason})`);
      if (state.content) {
        log(`⚠️  Lock contents: pid=${state.content.pid}, mtime=${new Date(state.content.mtime).toISOString()}`);
      }
      log('⚠️  If this repeats, inspect ' + DAEMON_LOG_PATH + ' for startup crashes.');
      try { fs.unlinkSync(DAEMON_LOCK_PATH); } catch { /* already gone */ }
      // Retry once. If we still lose, another process won the recovery race —
      // fall through to the wait path.
      acquired = tryAcquireLockFile(DAEMON_LOCK_PATH);
      if (!acquired) {
        log('Lost stale-lock recovery race to another starter — waiting for its daemon...');
        return waitForDaemonPid(DAEMON_START_TIMEOUT_MS);
      }
    } else {
      // Healthy concurrent starter — wait for its PID file.
      log(`Another process is starting the daemon (${state.reason}) — waiting...`);
      return waitForDaemonPid(DAEMON_START_TIMEOUT_MS);
    }
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

    // Wait for PID file to appear (daemon writes it on startup). Generous
    // timeout for cold-start slack on fresh installs (#182).
    return await waitForDaemonPid(DAEMON_START_TIMEOUT_MS);
  } finally {
    // Release lock. We no longer hold an fd — writeFileSync closed it for us.
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
