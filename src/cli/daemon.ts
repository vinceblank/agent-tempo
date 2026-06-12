/**
 * Daemon process management utilities.
 *
 * The daemon runs Temporal workers in a detached background process,
 * replacing the per-session workers. MCP sessions become pure clients.
 */
import * as fs from 'fs';
import * as path from 'path';
import { spawn, spawnSync, execFileSync } from 'child_process';
import { homedir } from 'os';
import {
  AGENT_TEMPO_HOME,
  Config,
  DEV_DAEMON_PORT,
  DEV_HOME_DIR_NAME,
  ENV,
  PROD_DAEMON_PORT,
  PROD_HOME_DIR_NAME,
  isDevMode,
} from '../config';
import { DAEMON_PORT_PATH, readPortFile } from '../http/port-file';

const log = (...args: unknown[]) => console.error('[agent-tempo:daemon]', ...args);

export const DAEMON_PID_PATH = path.join(AGENT_TEMPO_HOME, 'daemon.pid');
export const DAEMON_LOG_PATH = path.join(AGENT_TEMPO_HOME, 'daemon.log');
/**
 * Path to the daemon heartbeat file. The running daemon touches this file
 * on a {@link HEARTBEAT_INTERVAL_MS} cadence so `daemon status` can
 * distinguish "pid is alive AND main loop is serving" from "pid is alive
 * but something hung" (#157 diagnostic improvement).
 */
export const DAEMON_HEARTBEAT_PATH = path.join(AGENT_TEMPO_HOME, 'daemon.heartbeat');

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
 * to the "orphan" subset: matching processes that aren't tracked by any
 * known PID file. Used by `daemon start`'s pre-flight check (#157 PR B).
 *
 * Accepts a single tracked PID (existing call shape) OR an array of known
 * PIDs (ADR 0014 §5.6 — the dev profile passes the prod profile's PID
 * here too so dev + prod daemons can coexist on the same machine without
 * either misclassifying the other as an orphan).
 */
export function selectOrphans(
  scanned: DaemonProcessInfo[],
  trackedPid: number | undefined | ReadonlyArray<number | undefined>,
): DaemonProcessInfo[] {
  if (trackedPid === undefined) return scanned;
  if (Array.isArray(trackedPid)) {
    const known = new Set(
      (trackedPid as ReadonlyArray<number | undefined>).filter(
        (p): p is number => typeof p === 'number',
      ),
    );
    if (known.size === 0) return scanned;
    return scanned.filter((p) => !known.has(p.pid));
  }
  return scanned.filter((p) => p.pid !== trackedPid);
}

/**
 * Resolve the OPPOSITE profile's home directory. Used by cross-profile
 * coexistence checks (ADR 0014 §5.6). Returns the prod home in dev mode
 * and the dev home in prod mode.
 *
 * Exported so tests can verify the swap logic without fixture homedirs.
 */
export function otherProfileHome(): string {
  const base = isDevMode() ? PROD_HOME_DIR_NAME : DEV_HOME_DIR_NAME;
  return path.join(homedir(), base);
}

/**
 * Return the live PID (if any) of the OPPOSITE profile's daemon.
 *
 * In dev mode, this returns the prod daemon's PID; in prod mode, the dev
 * daemon's PID. Used by orphan detection to keep dev and prod daemons
 * from misclassifying each other (ADR 0014 §5.6 — "they naturally
 * coexist"). Returns `undefined` when no PID file exists, the contents
 * are unparseable, or the recorded process is dead.
 *
 * Exported for unit testing — can be stubbed alongside `getDaemonStatus`
 * in `evaluateStartPreflight` tests.
 */
export function getOtherProfilePid(): number | undefined {
  const otherPidPath = path.join(otherProfileHome(), 'daemon.pid');
  if (!fs.existsSync(otherPidPath)) return undefined;
  try {
    const pid = parseInt(fs.readFileSync(otherPidPath, 'utf8').trim(), 10);
    if (Number.isNaN(pid)) return undefined;
    return isPidAlive(pid) ? pid : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Best-effort signal that the OPPOSITE profile may have a running daemon
 * even if we couldn't pin a PID. Used by `stopDaemon` to suppress the
 * zombie reaper when there's a non-trivial chance of cross-profile
 * collateral damage (ADR 0014 §5.6).
 *
 * Returns true when either:
 *   - `daemon.pid` exists in the other profile's home AND contains a
 *     parseable, live PID (the strict case, also reported by
 *     {@link getOtherProfilePid}).
 *   - `daemon.port` exists in the other profile's home (weak signal:
 *     the file is written on daemon HTTP listener startup; it may
 *     linger across an uncleaned crash, but that's exactly the case
 *     where conservative behaviour matters).
 *
 * The heuristic deliberately errs on the side of NOT reaping. A false
 * positive (port file exists, daemon long dead) costs zombie cleanup;
 * a false negative (process killed because we missed evidence) costs
 * the user their other profile's daemon.
 */
export function isOtherProfileLikelyRunning(): boolean {
  if (getOtherProfilePid() !== undefined) return true;
  const otherPortPath = path.join(otherProfileHome(), 'daemon.port');
  return fs.existsSync(otherPortPath);
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

  // #758 — port pre-flight: refuse to spawn a daemon that cannot bind its
  // port. Pre-#758 this path happily spawned a new process that silently
  // failed to bind while a ghost daemon kept serving stale HTTP — the new
  // PID file then made `daemon status` track a phantom. Waits out a
  // draining prior daemon, then throws with the owning pid + remedy.
  await assertDaemonPortFree();

  // Ensure daemon directory exists
  fs.mkdirSync(AGENT_TEMPO_HOME, { recursive: true });

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
 * Info about a running agent-tempo daemon process discovered via OS process
 * listing. Returned by {@link scanAgentTempoDaemons}.
 */
export interface DaemonProcessInfo {
  pid: number;
  /** Full command line as reported by the OS. */
  commandLine: string;
}

/**
 * Matches a node process running the compiled daemon entry — both global-install
 * paths (`...\agent-tempo\dist\daemon.js`) and dev-tree paths. Narrow enough to
 * exclude unrelated `node` processes on the system; never force-kills based on
 * this match alone (self-healing is gated by explicit user action per #157).
 */
const DAEMON_CMDLINE_RE = /\bnode(?:\.exe)?\b.*\bagent-tempo\b.*[\\/]dist[\\/]daemon\.js\b/i;

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
export function scanAgentTempoDaemons(
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
    // doesn't hide the literal `node.exe` and `agent-tempo\dist\daemon.js`
    // substrings from a substring regex — splitting into quoted fields would
    // wrongly separate `node.exe` from `agent-tempo\dist\daemon.js` when
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
// ── #758 — port-ownership hygiene ───────────────────────────────────────
//
// The ghost-daemon incident class: a daemon without a PID file survives
// `daemon stop` (nothing knows its PID), `daemon start` spawns a NEW
// process that silently fails to bind the port, and `daemon status`
// tracks the phantom new PID while ALL HTTP traffic still hits the old
// process — which also keeps polling Temporal task queues on a stale
// bundle. The PID file is a hint; the PORT is the ground truth. Same
// port = same profile, so port-based hygiene never violates the
// ADR 0014 §5.6 cross-profile guard the way the cmdline-based zombie
// reaper could.

/**
 * The HTTP port the CURRENT profile's daemon should own:
 * `daemon.port` file (the port the daemon actually bound) → env override →
 * profile default (8473 prod / 8474 dev).
 */
export function resolveDaemonPort(): number {
  const fromFile = readPortFile(DAEMON_PORT_PATH);
  if (fromFile !== null) return fromFile;
  const fromEnv = Number(process.env[ENV.DAEMON_PORT]);
  if (Number.isInteger(fromEnv) && fromEnv > 0 && fromEnv <= 65535) return fromEnv;
  return isDevMode() ? DEV_DAEMON_PORT : PROD_DAEMON_PORT;
}

/**
 * Parse `netstat -ano -p tcp` output for the pid LISTENING on `port`.
 * Exported for unit testing against canned output (incl. the #758 repro's
 * `TCP 0.0.0.0:8473 ... LISTENING 2800` line).
 */
export function parseWindowsNetstatOwner(output: string, port: number): number | null {
  for (const line of output.split(/\r?\n/)) {
    const m = line.match(/^\s*TCP\s+\S+:(\d+)\s+\S+\s+LISTENING\s+(\d+)\s*$/i);
    if (m && Number(m[1]) === port) return Number(m[2]);
  }
  return null;
}

/**
 * The pid LISTENING on the given local TCP port, or `null` when the port is
 * free OR the probe is unavailable (probe failure degrades to pre-#758
 * behavior — never blocks a stop/start on a missing tool).
 */
export function findPortOwnerPid(
  port: number,
  platform: NodeJS.Platform = process.platform,
): number | null {
  try {
    if (platform === 'win32') {
      const out = execFileSync('netstat', ['-ano', '-p', 'tcp'], {
        encoding: 'utf8', windowsHide: true, timeout: 10_000,
      });
      return parseWindowsNetstatOwner(out, port);
    }
    // POSIX — lsof exits non-zero when nothing matches (caught below).
    const out = execFileSync('lsof', ['-nP', `-iTCP:${port}`, '-sTCP:LISTEN', '-t'], {
      encoding: 'utf8', timeout: 10_000,
    });
    const pid = parseInt(out.trim().split(/\s+/)[0] ?? '', 10);
    return Number.isInteger(pid) && pid > 0 ? pid : null;
  } catch {
    return null;
  }
}

/**
 * Forceful, platform-correct termination for ghost daemons (#758). The
 * incident's `bash kill <pid>` was a silent no-op on a Windows process —
 * Windows uses `taskkill /T /F` (tree + force; exit 128/255 = already gone,
 * mirroring `activities/hard-terminate.ts`), POSIX escalates SIGTERM →
 * SIGKILL. Distinct from {@link killDaemonPid} (the GRACEFUL path for the
 * tracked daemon): ghosts already missed their graceful window.
 */
export function forceKillPid(
  pid: number,
  platform: NodeJS.Platform = process.platform,
): boolean {
  try {
    if (platform === 'win32') {
      const r = spawnSync('taskkill', ['/T', '/F', '/PID', String(pid)], {
        windowsHide: true, timeout: 10_000,
      });
      return r.status === 0 || r.status === 128 || r.status === 255;
    }
    try { process.kill(pid, 'SIGTERM'); } catch { /* may already be gone */ }
    try { process.kill(pid, 'SIGKILL'); } catch { /* gone — fine */ }
    return true;
  } catch {
    return false;
  }
}

/** Deps for {@link assertDaemonPortFree} — injectable for unit tests. */
export interface PortPreflightDeps {
  resolvePort?: () => number;
  findPortOwner?: (port: number) => number | null;
  scan?: () => DaemonProcessInfo[];
  /** Total wait for a draining prior daemon to release the port. Default 10s. */
  waitMs?: number;
  /** Poll interval while waiting. Default 250ms. */
  pollMs?: number;
  /** Test seam — defaults to a real setTimeout sleep. */
  sleep?: (ms: number) => Promise<void>;
}

/**
 * #758 `daemon start` pre-flight: refuse to spawn a daemon that cannot bind
 * its port. WAITS briefly first — a legitimate stop→start flow probes while
 * the prior daemon is still draining (graceful shutdown holds the port for
 * up to ~15s), and pre-#758 that window produced exactly the silent
 * failed-bind degraded state this guard exists to prevent. If the port is
 * still owned at the deadline, throws with the owning pid and whether it
 * looks like an (untracked) agent-tempo daemon. No-op when the port is free
 * or the probe is unavailable.
 */
export async function assertDaemonPortFree(deps: PortPreflightDeps = {}): Promise<void> {
  const port = (deps.resolvePort ?? resolveDaemonPort)();
  const probe = deps.findPortOwner ?? findPortOwnerPid;
  const waitMs = deps.waitMs ?? 10_000;
  const pollMs = deps.pollMs ?? 250;
  const sleep = deps.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));

  let owner = probe(port);
  if (owner === null) return;
  log(`daemon port ${port} currently owned by pid ${owner} — waiting up to ${waitMs}ms for it to release (prior daemon may be draining)`);
  const deadline = Date.now() + waitMs;
  while (owner !== null && Date.now() < deadline) {
    await sleep(pollMs);
    owner = probe(port);
  }
  if (owner === null) return;

  let looksLikeDaemon = false;
  try {
    looksLikeDaemon = (deps.scan ?? scanAgentTempoDaemons)().some((p) => p.pid === owner);
  } catch { /* scanner unavailable — fall through with the generic message */ }
  throw new Error(
    `daemon port ${port} is already owned by pid ${owner}` +
    (looksLikeDaemon
      ? ' — an UNTRACKED agent-tempo daemon (ghost: running without a PID file). ' +
        'Run `agent-tempo daemon stop` (ghost-aware) and retry.'
      : ' — a process that does not look like an agent-tempo daemon. ' +
        `Free the port (or set ${ENV.DAEMON_PORT}) and retry.`),
  );
}

export interface StopDaemonOpts {
  /** Process scanner — defaults to {@link scanAgentTempoDaemons}. */
  scan?: () => DaemonProcessInfo[];
  /** Signal sender — defaults to `process.kill`. */
  killer?: (pid: number, signal?: NodeJS.Signals | number) => void;
  /** Platform override — defaults to `process.platform`. */
  platform?: NodeJS.Platform;
  /**
   * Cross-profile coexistence probe — defaults to
   * {@link isOtherProfileLikelyRunning}. Tests stub this so the zombie
   * reaper logic can be exercised without depending on disk state of the
   * developer's home dir.
   */
  isOtherProfileLikelyRunning?: () => boolean;
  /**
   * Cross-profile PID lookup — defaults to {@link getOtherProfilePid}.
   * Tests stub it for the same reason as `isOtherProfileLikelyRunning`.
   */
  getOtherProfilePid?: () => number | undefined;
  /** #758 — port resolver — defaults to {@link resolveDaemonPort}. */
  resolvePort?: () => number;
  /** #758 — port-owner probe — defaults to {@link findPortOwnerPid}. */
  findPortOwner?: (port: number) => number | null;
  /** #758 — forceful ghost terminator — defaults to {@link forceKillPid}. */
  forceKiller?: (pid: number, platform?: NodeJS.Platform) => boolean;
}

/**
 * Stop the daemon process by sending SIGTERM (or killing on Windows). In
 * addition to the daemon tracked by the PID file, this also reaps any
 * **zombie** daemons — `node dist/daemon.js` processes detected by
 * {@link scanAgentTempoDaemons} that the PID file doesn't know about.
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
  const scan = opts.scan ?? scanAgentTempoDaemons;
  const killer = opts.killer ?? process.kill.bind(process);
  const platform = opts.platform ?? process.platform;
  const otherLikelyRunning = opts.isOtherProfileLikelyRunning ?? isOtherProfileLikelyRunning;
  const otherPidLookup = opts.getOtherProfilePid ?? getOtherProfilePid;

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
  // except the PIDs we know about", so we don't double-signal the tracked
  // daemon (harmless but cleaner).
  //
  // ADR 0014 §5.6 — when cross-profile coexistence is plausible (the
  // OPPOSITE profile shows any sign of running: PID file, port file),
  // suppress the zombie reaper entirely. The reaper is a #157 safety
  // net for the SINGLE-profile case where a crashed daemon left an
  // untracked node process behind. With dev + prod coexisting on the
  // same machine, the reaper would happily kill the other profile's
  // daemon — losing the user's prod state because they ran
  // `--dev daemon stop`. The trade-off is acceptable: an actual zombie
  // can be reaped later (manual `kill <pid>` based on the printed
  // command line), but a wrongly-killed prod daemon costs the user
  // their state.
  let zombies: DaemonProcessInfo[] = [];
  if (otherLikelyRunning()) {
    log(
      'cross-profile coexistence detected — skipping zombie reaper to avoid touching the other profile (ADR 0014 §5.6)',
    );
  } else {
    try {
      zombies = selectOrphans(scan(), [status.pid, otherPidLookup()]);
    } catch {
      // Scanner failures are non-fatal — we already did the primary stop above.
      zombies = [];
    }
  }
  for (const z of zombies) {
    if (killDaemonPid(z.pid, killer, platform)) {
      stopped = true;
    }
  }

  // ── #758 ghost sweep — trust the PORT, not the PID file ──
  //
  // Runs UNCONDITIONALLY, including when the §5.6 cross-profile guard
  // skipped the zombie reaper above (exactly the incident path: no PID
  // file + reaper skipped → nothing ever reached the ghost). The port is
  // profile-scoped, so killing its owner can never touch the other
  // profile. Safety: only force-kill when the owner's command line
  // matches an agent-tempo daemon — an unrelated process squatting the
  // port gets a loud warning + the manual command instead.
  const port = (opts.resolvePort ?? resolveDaemonPort)();
  const owner = (opts.findPortOwner ?? findPortOwnerPid)(port);
  const signalledPids = new Set<number>([
    ...(status.pid !== undefined ? [status.pid] : []),
    ...zombies.map((z) => z.pid),
  ]);
  if (owner !== null && !signalledPids.has(owner)) {
    let looksLikeDaemon = false;
    try {
      looksLikeDaemon = scan().some((p) => p.pid === owner);
    } catch { /* scanner unavailable — treat as not-verified, warn below */ }
    if (looksLikeDaemon) {
      log(`ghost daemon (#758): port ${port} owned by untracked pid ${owner} — force-terminating`);
      if ((opts.forceKiller ?? forceKillPid)(owner, platform)) {
        stopped = true;
      } else {
        log(`WARNING: failed to terminate ghost pid ${owner} — free port ${port} manually`);
      }
    } else {
      log(
        `WARNING: daemon port ${port} is owned by pid ${owner}, which does not look like an ` +
        `agent-tempo daemon — NOT killing it. If it is a stale daemon, terminate it manually ` +
        `(Windows: taskkill /T /F /PID ${owner} · POSIX: kill ${owner}).`,
      );
    }
  }
  // owner ∈ signalledPids → we already signalled it; graceful shutdown
  // takes a moment to release the port — nothing more to do here.

  return stopped;
}
