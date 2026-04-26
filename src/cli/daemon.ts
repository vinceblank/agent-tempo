/**
 * Daemon process management utilities.
 *
 * The daemon runs Temporal workers in a detached background process,
 * replacing the per-session workers. MCP sessions become pure clients.
 */
import * as fs from 'fs';
import * as path from 'path';
import { spawn, execFileSync } from 'child_process';
import { CLAUDE_TEMPO_HOME, Config, ENV } from '../config';

const log = (...args: unknown[]) => console.error('[claude-tempo:daemon]', ...args);

export const DAEMON_PID_PATH = path.join(CLAUDE_TEMPO_HOME, 'daemon.pid');
export const DAEMON_LOG_PATH = path.join(CLAUDE_TEMPO_HOME, 'daemon.log');
/**
 * Path to the daemon heartbeat file. The running daemon touches this file
 * on a {@link HEARTBEAT_INTERVAL_MS} cadence so `daemon status` can
 * distinguish "pid is alive AND main loop is serving" from "pid is alive
 * but something hung" (#157 diagnostic improvement).
 */
export const DAEMON_HEARTBEAT_PATH = path.join(CLAUDE_TEMPO_HOME, 'daemon.heartbeat');

/** How often the daemon touches {@link DAEMON_HEARTBEAT_PATH}. */
export const HEARTBEAT_INTERVAL_MS = 60_000;

/**
 * Multiplier applied to {@link HEARTBEAT_INTERVAL_MS} to decide whether a
 * heartbeat is stale. A 2x buffer tolerates one missed tick (brief GC pause,
 * synchronous activity) without false-flagging a healthy daemon.
 */
export const HEARTBEAT_STALE_MULTIPLIER = 2;

/** Entry point for the daemon process (compiled JS). */
const DAEMON_ENTRY_PATH = path.resolve(__dirname, '..', 'daemon.js');

export interface DaemonStatus {
  running: boolean;
  pid?: number;
  /**
   * Milliseconds since the daemon last touched {@link DAEMON_HEARTBEAT_PATH}.
   * `null` when no heartbeat file exists (fresh daemon hasn't ticked yet, or
   * pre-heartbeat daemon). `undefined` when the daemon is not running at all.
   * See {@link HEARTBEAT_STALE_MULTIPLIER} for the staleness threshold.
   */
  heartbeatAge?: number | null;
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
    return { running: true, pid, heartbeatAge: readHeartbeatAge() };
  }
  // Process is dead — clean up stale PID file.
  try { fs.unlinkSync(DAEMON_PID_PATH); } catch { /* ignore */ }
  return { running: false };
}

/**
 * Read the heartbeat file and return milliseconds since its mtime, or `null`
 * if the file doesn't exist. Used by {@link getDaemonStatus} when the daemon
 * is running — see the `heartbeatAge` field on {@link DaemonStatus}.
 *
 * Any other read/stat error is treated as "unknown" (`null`) rather than
 * propagating — `daemon status` should degrade to silent-unknown rather than
 * crash on an unexpected filesystem condition.
 */
function readHeartbeatAge(): number | null {
  try {
    const mtimeMs = fs.statSync(DAEMON_HEARTBEAT_PATH).mtimeMs;
    const age = Date.now() - mtimeMs;
    return age >= 0 ? age : 0;
  } catch {
    return null;
  }
}

/**
 * @internal — exported for unit testing {@link DAEMON_CMDLINE_RE} edge cases
 * without needing to spin up a real child process. Filters a scanner result
 * to the "orphan" subset: matching processes that aren't the one the pid
 * file is tracking. Used by `daemon start`'s pre-flight check (#157 PR B).
 */
export function selectOrphans(
  scanned: DaemonProcessInfo[],
  trackedPid: number | undefined,
): DaemonProcessInfo[] {
  if (trackedPid === undefined) return scanned;
  return scanned.filter((p) => p.pid !== trackedPid);
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
 * Info about a running claude-tempo daemon process discovered via OS process
 * listing. Returned by {@link scanClaudeTempoDaemons}.
 */
export interface DaemonProcessInfo {
  pid: number;
  /** Full command line as reported by the OS. */
  commandLine: string;
}

/**
 * Matches a node process running the compiled daemon entry — both global-install
 * paths (`...\claude-tempo\dist\daemon.js`) and dev-tree paths. Narrow enough to
 * exclude unrelated `node` processes on the system; never force-kills based on
 * this match alone (self-healing is gated by explicit user action per #157).
 */
const DAEMON_CMDLINE_RE = /\bnode(?:\.exe)?\b.*\bclaude-tempo\b.*[\\/]dist[\\/]daemon\.js\b/i;

/**
 * Shell out to the platform process list and return any matching daemon
 * processes. Hand-rolled per-platform to avoid a new dependency:
 *  - Windows: PowerShell `Get-CimInstance Win32_Process` (modern, robust) with a
 *    `tasklist` fallback for environments without PowerShell on PATH
 *  - POSIX: `ps -eo pid,command` (portable across macOS + Linux)
 *
 * Returns `[]` on any scanner failure — this is a best-effort observability
 * helper, not a correctness guarantee. Errors are swallowed so a broken
 * scanner can't itself take down `daemon status`.
 *
 * Exported for testing with a stubbed executor.
 */
export function scanClaudeTempoDaemons(
  exec: (cmd: string, args: readonly string[]) => string = (cmd, args) =>
    execFileSync(cmd, args as string[], { encoding: 'utf8', windowsHide: true, stdio: ['ignore', 'pipe', 'ignore'] }),
  platform: NodeJS.Platform = process.platform,
): DaemonProcessInfo[] {
  try {
    if (platform === 'win32') {
      return scanWindows(exec);
    }
    return scanPosix(exec);
  } catch {
    return [];
  }
}

/** Windows scan via PowerShell → CSV. Falls back to `wmic` if PowerShell is missing. */
function scanWindows(exec: (cmd: string, args: readonly string[]) => string): DaemonProcessInfo[] {
  // PowerShell CSV output puts ProcessId in col 0, CommandLine in col 1.
  // `-NoProfile` avoids loading user profile scripts that would slow startup.
  const ps =
    "Get-CimInstance -ClassName Win32_Process -Filter \"Name='node.exe'\" | " +
    'Select-Object ProcessId,CommandLine | ConvertTo-Csv -NoTypeInformation';
  try {
    const out = exec('powershell', ['-NoProfile', '-NonInteractive', '-Command', ps]);
    return parseCsvMatches(out);
  } catch {
    // Fall through to wmic — legacy, still present on most Windows SKUs.
    const out = exec('wmic', ['process', 'where', "name='node.exe'", 'get', 'ProcessId,CommandLine', '/format:csv']);
    return parseCsvMatches(out);
  }
}

/** POSIX scan via `ps -eo pid,command`. */
function scanPosix(exec: (cmd: string, args: readonly string[]) => string): DaemonProcessInfo[] {
  const out = exec('ps', ['-eo', 'pid,command']);
  const matches: DaemonProcessInfo[] = [];
  for (const line of out.split('\n')) {
    // Skip header row ("  PID COMMAND").
    const trimmed = line.trim();
    if (!trimmed || /^pid\b/i.test(trimmed)) continue;
    const m = /^(\d+)\s+(.+)$/.exec(trimmed);
    if (!m) continue;
    const pid = parseInt(m[1], 10);
    const commandLine = m[2];
    if (!isNaN(pid) && DAEMON_CMDLINE_RE.test(commandLine) && pid !== process.pid) {
      matches.push({ pid, commandLine });
    }
  }
  return matches;
}

/** Parse CSV output from PowerShell's ConvertTo-Csv or wmic and filter matches. */
function parseCsvMatches(csv: string): DaemonProcessInfo[] {
  const matches: DaemonProcessInfo[] = [];
  for (const line of csv.split(/\r?\n/)) {
    // CSV rows: quoted fields separated by commas. Both PowerShell and wmic
    // emit a header row + blank lines. Keep the parser permissive — we only
    // need ProcessId (numeric) and a line that contains the daemon signature.
    if (!line || /^"?ProcessId\b/i.test(line) || /^Node,Command/i.test(line)) continue;
    // Find a plausible ProcessId (column order differs between PS and wmic:
    // PS puts it first, wmic puts it last). Take the first numeric token
    // that isn't obviously part of the command line (i.e. inside a long
    // quoted path). In practice both formats surface the pid as a bare or
    // single-quoted token unadjacent to path-like text.
    const pidMatch = line.match(/(?:^|,)"?(\d+)"?(?=,|$)/);
    if (!pidMatch) continue;
    const pid = parseInt(pidMatch[1], 10);
    if (isNaN(pid) || pid === process.pid) continue;
    // Match the daemon signature against the FULL LINE. CSV quoting (both
    // PowerShell's doubled-quote `""` form and backslash-escape variants)
    // doesn't hide the literal `node.exe` and `claude-tempo\dist\daemon.js`
    // substrings from a substring regex — splitting into quoted fields would
    // wrongly separate `node.exe` from `claude-tempo\dist\daemon.js` when
    // they're in different CSV columns (e.g. `"node.exe" "...\daemon.js"`).
    if (DAEMON_CMDLINE_RE.test(line)) {
      matches.push({ pid, commandLine: line });
    }
  }
  return matches;
}

/**
 * Send the platform-appropriate stop signal to a single daemon PID.
 * Swallows errors — the process may have already exited, or be UAC-isolated
 * on Windows. Returns `true` if `process.kill` succeeded, `false` otherwise.
 */
function killDaemonPid(
  pid: number,
  killer: (pid: number, signal?: NodeJS.Signals | number) => void = process.kill.bind(process),
  platform: NodeJS.Platform = process.platform,
): boolean {
  try {
    if (platform === 'win32') {
      // Windows doesn't support SIGTERM — just kill the process.
      killer(pid);
    } else {
      killer(pid, 'SIGTERM');
    }
    return true;
  } catch {
    return false;
  }
}

/**
 * Options for {@link stopDaemon} — exported for unit tests so we can inject
 * a stub scanner and killer without spawning real processes. Production
 * callers should pass no arguments and accept the defaults (real OS scan +
 * `process.kill`).
 *
 * @internal
 */
export interface StopDaemonOpts {
  /** Process scanner — defaults to {@link scanClaudeTempoDaemons}. */
  scan?: () => DaemonProcessInfo[];
  /** Signal sender — defaults to `process.kill`. */
  killer?: (pid: number, signal?: NodeJS.Signals | number) => void;
  /** Platform override — defaults to `process.platform`. */
  platform?: NodeJS.Platform;
}

/**
 * Stop the daemon process by sending SIGTERM (or killing on Windows). In
 * addition to the daemon tracked by the PID file, this also reaps any
 * **zombie** daemons — `node dist/daemon.js` processes detected by
 * {@link scanClaudeTempoDaemons} that the PID file doesn't know about.
 *
 * Why reap zombies on every stop? When a prior daemon loses PID-file
 * tracking (crashed `daemon stop`, manual PID-file delete, surviving across
 * a `down --destroy` from before this fix), the orphan keeps polling
 * Temporal task queues and executing activities — sometimes with stale code
 * from before the most recent rebuild. That has caused real user-visible
 * incidents where activities ran the pre-fix `resume: true` spawn path
 * because a zombie daemon held the cached pre-rebuild code in memory.
 *
 * Returns `true` if at least one process (tracked or zombie) was stopped.
 */
export function stopDaemon(opts: StopDaemonOpts = {}): boolean {
  const scan = opts.scan ?? scanClaudeTempoDaemons;
  const killer = opts.killer ?? process.kill.bind(process);
  const platform = opts.platform ?? process.platform;

  const status = getDaemonStatus();
  let stopped = false;

  // Kill the tracked daemon first (if any). We do this even if `kill` fails —
  // the PID file is invariant we own, so we always clean it up.
  if (status.running && status.pid !== undefined) {
    killDaemonPid(status.pid, killer, platform);
    try { fs.unlinkSync(DAEMON_PID_PATH); } catch { /* ignore */ }
    stopped = true;
  }

  // Now reap any zombies. `selectOrphans` filters the scan to "everything
  // except the PID we already killed", so we don't double-signal the tracked
  // daemon (which would be harmless, but the bookkeeping is clearer this way).
  let zombies: DaemonProcessInfo[] = [];
  try {
    zombies = selectOrphans(scan(), status.pid);
  } catch {
    // Scanner failures are non-fatal — we already did the primary stop above.
    zombies = [];
  }
  for (const z of zombies) {
    if (killDaemonPid(z.pid, killer, platform)) {
      stopped = true;
    }
  }

  return stopped;
}
