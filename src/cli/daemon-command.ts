/**
 * Daemon CLI command handler — `agent-tempo daemon <start|stop|status|logs|install|uninstall>`.
 *
 * **Critical constraint**: this module must NOT import from `@temporalio/*`,
 * `../workflows/*`, `../adapters/*`, `../spawn`, `../client`, or any module
 * that transitively pulls in the Temporal SDK or rxjs. The daemon CLI must
 * remain operable even when the Temporal SDK itself is broken (e.g. a
 * `@temporalio/core-bridge` native-module build failure on an unsupported
 * Node version — see issue #157: users were stranded with orphan processes
 * they couldn't stop because `daemon stop` crashed before executing).
 *
 * Keeping this module's dep graph minimal also avoids pulling ~250MB of
 * Temporal SDK code + workflow bundle parsing into every CLI invocation.
 *
 * ## Test guarantee
 *
 * `test/daemon-command-isolation.test.ts` spawns a child Node process that
 * requires the compiled `dist/cli/daemon-command.js` and asserts that
 * `require.cache` contains zero entries matching `@temporalio|rxjs|@grpc`.
 * If you add an import here that transitively leaks Temporal deps, that
 * test will fail.
 */
import { existsSync, readFileSync, mkdirSync, unlinkSync, copyFileSync, statSync, openSync, readSync, closeSync } from 'fs';
import { join, resolve } from 'path';
import { homedir } from 'os';
import { execFileSync, spawn as cpSpawn } from 'child_process';
import * as http from 'http';
import { CliOverrides, getConfig } from '../config';
import { readPortFile } from '../http/port-file';
import {
  isDaemonRunning,
  isOtherProfileLikelyRunning,
  startDaemon,
  stopDaemon,
  getDaemonStatus,
  getOtherProfilePid,
  scanAgentTempoDaemons,
  selectOrphans,
  resolveDaemonPort,
  findPortOwnerPid,
  DAEMON_PID_PATH,
  DAEMON_LOG_PATH,
  HEARTBEAT_INTERVAL_MS,
  HEARTBEAT_STALE_MULTIPLIER,
  type DaemonProcessInfo,
  type DaemonStatus,
} from './daemon';
import * as out from './output';

/**
 * Discriminated union describing the outcome of the `daemon start` pre-flight
 * check. Exported for direct unit testing of the decision logic — the handler
 * just maps these actions to console output + `process.exit` / spawn.
 *
 *   already-running — pid file is valid, no-op (not an error)
 *   abort           — orphan daemons detected and `force` is false; caller
 *                     should print the list + exit 1
 *   spawn           — safe to proceed with `startDaemon`; caller should
 *                     delete a stale pid file first when `cleanupStalePid`
 *                     is true (only set on the `force` path)
 *
 * @internal
 */
export type StartPreflight =
  | { action: 'already-running'; pid: number }
  | { action: 'abort'; orphans: DaemonProcessInfo[] }
  | { action: 'spawn'; cleanupStalePid: boolean };

/**
 * Pure decision function for `daemon start`. Given a scanner result and the
 * current daemon status, computes whether to no-op, abort with orphans, or
 * spawn. `force` bypasses the orphan check and signals that a stale pid file
 * (if any) should be cleared before the spawn.
 *
 * `otherProfilePid` is the live PID (if any) of the opposite profile's
 * daemon (dev's prod sibling, or prod's dev sibling). Including it in the
 * known-PID set keeps cross-profile coexistence working (ADR 0014 §5.6) —
 * starting the dev daemon must not flag the prod daemon as an orphan, and
 * vice versa.
 *
 * @internal — exported for unit tests in test/daemon-start-orphan-check.test.ts.
 */
export function evaluateStartPreflight(
  scanned: DaemonProcessInfo[],
  status: DaemonStatus,
  force: boolean,
  otherProfilePid?: number,
): StartPreflight {
  if (status.running && typeof status.pid === 'number') {
    return { action: 'already-running', pid: status.pid };
  }
  if (!force) {
    const orphans = selectOrphans(scanned, [status.pid, otherProfilePid]);
    if (orphans.length > 0) return { action: 'abort', orphans };
  }
  return { action: 'spawn', cleanupStalePid: force };
}

/** Package root is two levels up from dist/cli/ */
const PACKAGE_ROOT = resolve(__dirname, '..', '..');

function packagingFile(...segments: string[]): string {
  return join(PACKAGE_ROOT, 'packaging', ...segments);
}

export interface DaemonOpts extends CliOverrides {
  subcommand?: string;
  /**
   * Only meaningful for the `start` subcommand. Skips the orphan-process
   * pre-flight check and spawns a daemon even if scanner-matched processes
   * are found. Also cleans up a stale pid file if present. Use only when
   * you've verified no conflicting agent-tempo daemons exist — or in CI
   * scripts where idempotent-start is required (see `daemon status` first).
   */
  force?: boolean;
}

export async function daemon(opts: DaemonOpts): Promise<void> {
  const config = getConfig(opts);

  switch (opts.subcommand) {
    case 'start': {
      const status = getDaemonStatus();
      // ADR 0014 §5.6 — if the OPPOSITE profile's daemon is running on this
      // machine, exclude its PID from the orphan set. Dev + prod daemons
      // are designed to coexist (different home dir / port / namespace).
      // When the other profile shows weak evidence of running (port file
      // exists but PID file doesn't / PID is unparseable), skip the orphan
      // scan entirely — see also `stopDaemon`'s mirroring behavior.
      const otherPid = getOtherProfilePid();
      const skipOrphanScan =
        isOtherProfileLikelyRunning() && otherPid === undefined;
      if (skipOrphanScan) {
        out.warn(
          'Skipping orphan-process scan — the other profile (dev/prod) appears to be running ' +
          'without a PID file. Re-run with `daemon start --force` if you have already verified ' +
          'no rogue daemon for THIS profile is present.',
        );
      }
      const preflight = evaluateStartPreflight(
        // Skip the actual OS scan when we're already-running, force is set,
        // or we're suppressing for cross-profile safety.
        status.running || opts.force || skipOrphanScan ? [] : scanAgentTempoDaemons(),
        status,
        Boolean(opts.force) || skipOrphanScan,
        otherPid,
      );

      switch (preflight.action) {
        case 'already-running':
          out.success(`Daemon already running (pid ${preflight.pid})`);
          return;

        case 'abort':
          // Piling a new daemon on top of orphans is the original #157 user-pain
          // scenario. User must clean up first — see troubleshooting docs.
          out.error(`Found ${preflight.orphans.length} orphaned agent-tempo daemon process${preflight.orphans.length === 1 ? '' : 'es'} — daemon start aborted.`);
          for (const p of preflight.orphans) out.log(`  pid ${p.pid}: ${p.commandLine}`);
          out.log('');
          out.log(`  ${out.dim('Emergency cleanup: see docs/troubleshooting.md → "Orphaned daemon processes"')}`);
          out.log(`  ${out.dim('Override (use only after confirming): agent-tempo daemon start --force')}`);
          process.exit(1);
          break;

        case 'spawn':
          if (preflight.cleanupStalePid && existsSync(DAEMON_PID_PATH)) {
            // Force path — clean up a stale pid file if present.
            // `getDaemonStatus` already unlinks the file when it detects a
            // dead pid; this handles the rarer "file exists, contents
            // unparseable OR fs error" branch.
            try { unlinkSync(DAEMON_PID_PATH); } catch { /* ignore */ }
          }
          out.log('Starting daemon...');
          try {
            const pid = await startDaemon(config);
            out.success(`Daemon started (pid ${pid})`);
            out.log(`  ${out.dim('Logs: ' + DAEMON_LOG_PATH)}`);
          } catch (err: any) {
            out.error(err.message || String(err));
            process.exit(1);
          }
          break;
      }
      break;
    }

    case 'stop': {
      if (stopDaemon()) {
        out.success('Daemon stopped');
      } else {
        out.warn('Daemon is not running');
      }
      break;
    }

    case 'status': {
      const status = getDaemonStatus();
      const scanned = scanAgentTempoDaemons();

      if (status.running) {
        out.success(`Daemon running (pid ${status.pid})`);
        // Heartbeat diagnostic — distinguishes "pid alive AND main loop
        // serving" from "pid alive but something hung" (#157 PR B).
        const staleThresholdMs = HEARTBEAT_INTERVAL_MS * HEARTBEAT_STALE_MULTIPLIER;
        if (status.heartbeatAge !== undefined && status.heartbeatAge !== null) {
          const ageSec = Math.round(status.heartbeatAge / 1000);
          if (status.heartbeatAge > staleThresholdMs) {
            out.warn(`  Last heartbeat: ${ageSec}s ago — STALE (threshold ${staleThresholdMs / 1000}s). The daemon's main loop may be hung.`);
          } else {
            out.log(`  ${out.dim(`Last heartbeat: ${ageSec}s ago`)}`);
          }
        } else if (status.heartbeatAge === null) {
          out.log(`  ${out.dim('Last heartbeat: (not yet written — daemon just started or pre-heartbeat version)')}`);
        }
        // Warn if the scanner reports extras the pid file doesn't know about —
        // orphans from a prior crashed run that never removed its pid file, or
        // a second daemon started by a stale concurrent CLI invocation (#157).
        // The opposite profile's daemon (if running) also gets excluded so
        // prod doesn't flag dev as an orphan / vice versa (ADR 0014 §5.6).
        const extras = selectOrphans(scanned, [status.pid, getOtherProfilePid()]);
        if (extras.length > 0) {
          out.warn(`Found ${extras.length} additional agent-tempo daemon process${extras.length === 1 ? '' : 'es'} not tracked by the pid file:`);
          for (const p of extras) out.log(`  pid ${p.pid}: ${p.commandLine}`);
          out.log(`  ${out.dim('See `agent-tempo daemon --help` or docs/troubleshooting.md for emergency cleanup.')}`);
        }
      } else {
        out.log('Daemon is not running');
        if (scanned.length > 0) {
          out.warn(`Found ${scanned.length} orphaned agent-tempo daemon process${scanned.length === 1 ? '' : 'es'} (no pid file):`);
          for (const p of scanned) out.log(`  pid ${p.pid}: ${p.commandLine}`);
          out.log(`  ${out.dim('These are untracked. See docs/troubleshooting.md → "Orphaned daemon processes" for emergency cleanup.')}`);
        }
      }

      // #758 — port-ownership cross-check: the PID file is a hint, the
      // port is the ground truth. A divergence is exactly the phantom/
      // ghost condition that made `daemon status` report a healthy pid
      // while ALL HTTP traffic hit a different, stale process.
      {
        const port = resolveDaemonPort();
        const portOwner = findPortOwnerPid(port);
        if (status.running && status.pid !== undefined) {
          if (portOwner === status.pid) {
            out.log(`  ${out.dim(`Port ${port}: owned by tracked pid ${status.pid}`)}`);
          } else if (portOwner === null) {
            out.warn(
              `Port ${port}: NOT bound — the tracked daemon (pid ${status.pid}) is not serving HTTP ` +
              `(failed bind at boot, or still starting). HTTP surfaces (/v1/*, SSE, dashboard) are down.`,
            );
          } else {
            out.warn(
              `PHANTOM DAEMON: the pid file says ${status.pid}, but port ${port} is owned by pid ${portOwner}. ` +
              `All HTTP traffic is hitting the OLD process (likely on a stale build). ` +
              `Run \`agent-tempo daemon stop\` (ghost-aware) then \`daemon start\`.`,
            );
          }
        } else if (portOwner !== null) {
          out.warn(
            `GHOST DAEMON: no tracked daemon, but port ${port} is owned by pid ${portOwner}. ` +
            `Run \`agent-tempo daemon stop\` to terminate it (port-based; works without a pid file).`,
          );
        }
      }
      break;
    }

    case 'stats': {
      await daemonStats();
      break;
    }

    case 'logs': {
      if (!existsSync(DAEMON_LOG_PATH)) {
        out.warn('No daemon log file found');
        return;
      }
      // Tail the log file
      if (process.platform === 'win32') {
        // On Windows, read the last 32KB of the log (size-capped to avoid OOM on large logs)
        const MAX_TAIL_BYTES = 32 * 1024;
        const stat = statSync(DAEMON_LOG_PATH);
        const fd = openSync(DAEMON_LOG_PATH, 'r');
        const readStart = Math.max(0, stat.size - MAX_TAIL_BYTES);
        const buf = Buffer.alloc(Math.min(stat.size, MAX_TAIL_BYTES));
        readSync(fd, buf, 0, buf.length, readStart);
        closeSync(fd);
        const chunk = buf.toString('utf8');
        // Skip partial first line if we didn't read from the start
        const lines = readStart > 0 ? chunk.split('\n').slice(1) : chunk.split('\n');
        console.log(lines.slice(-50).join('\n'));
      } else {
        // On Unix, use tail -f for live following
        const child = cpSpawn('tail', ['-f', '-n', '50', DAEMON_LOG_PATH], {
          stdio: 'inherit',
        });
        child.on('error', () => {
          // Fallback: just read the file
          const content = readFileSync(DAEMON_LOG_PATH, 'utf8');
          const lines = content.split('\n');
          console.log(lines.slice(-50).join('\n'));
        });
        // Keep running until user presses Ctrl+C
        await new Promise<void>((resolve) => {
          child.on('exit', () => resolve());
          process.on('SIGINT', () => { child.kill(); resolve(); });
        });
      }
      break;
    }

    case 'install':
      await daemonInstall();
      break;

    case 'uninstall':
      await daemonUninstall();
      break;

    default:
      out.error('Usage: agent-tempo daemon <start|stop|status|stats|logs|install|uninstall>');
      out.log(`\n  ${out.dim('agent-tempo daemon start [--force]')}  Start the worker daemon`);
      out.log(`  ${out.dim('                           --force: skip orphan-process check + clear stale pid file')}`);
      out.log(`  ${out.dim('agent-tempo daemon stop')}              Stop the worker daemon`);
      out.log(`  ${out.dim('agent-tempo daemon status')}            Check daemon status + heartbeat + orphans`);
      out.log(`  ${out.dim('agent-tempo daemon stats')}             Show memory + uptime + ensemble count`);
      out.log(`  ${out.dim('agent-tempo daemon logs')}              Tail daemon log output`);
      out.log(`  ${out.dim('agent-tempo daemon install')}           Install as a system service`);
      out.log(`  ${out.dim('agent-tempo daemon uninstall')}         Uninstall the system service`);
      process.exit(1);
  }

  // Used only to silence "config declared but never used" when a branch exits early.
  void config;
}

async function daemonInstall(): Promise<void> {
  const platform = process.platform;
  if (platform === 'linux') {
    const src = packagingFile('systemd', 'agent-tempo.service');
    const dstDir = join(homedir(), '.config', 'systemd', 'user');
    const dst = join(dstDir, 'agent-tempo.service');
    mkdirSync(dstDir, { recursive: true });
    copyFileSync(src, dst);
    out.success(`Installed systemd --user unit: ${dst}`);
    // Try to enable + start. User may still need `systemctl --user daemon-reload`.
    try {
      execFileSync('systemctl', ['--user', 'daemon-reload'], { stdio: 'ignore' });
      execFileSync('systemctl', ['--user', 'enable', '--now', 'agent-tempo'], { stdio: 'ignore' });
      out.log('  Enabled + started: systemctl --user enable --now agent-tempo');
    } catch {
      out.warn('  systemctl invocation failed — run manually:');
      out.log(`    ${out.dim('systemctl --user daemon-reload')}`);
      out.log(`    ${out.dim('systemctl --user enable --now agent-tempo')}`);
    }
    return;
  }

  if (platform === 'darwin') {
    const src = packagingFile('launchd', 'com.agent.tempo.plist');
    const dstDir = join(homedir(), 'Library', 'LaunchAgents');
    const dst = join(dstDir, 'com.agent.tempo.plist');
    mkdirSync(dstDir, { recursive: true });
    copyFileSync(src, dst);
    out.success(`Installed launchd agent: ${dst}`);
    out.warn('  NOTE: macOS launchd integration is best-effort — feedback welcome.');
    try {
      execFileSync('launchctl', ['load', dst], { stdio: 'ignore' });
      out.log('  Loaded: launchctl load ' + dst);
    } catch {
      out.warn('  launchctl invocation failed — run manually:');
      out.log(`    ${out.dim(`launchctl load ${dst}`)}`);
    }
    return;
  }

  if (platform === 'win32') {
    const script = packagingFile('windows', 'install-task.ps1');
    try {
      execFileSync(
        'powershell',
        ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', script],
        { stdio: 'inherit' },
      );
    } catch (err: any) {
      out.error(`Failed to register scheduled task: ${err?.message ?? err}`);
      process.exit(1);
    }
    return;
  }

  out.error(`Unsupported platform: ${platform}`);
  out.log('  Supported: linux (systemd --user), darwin (launchd), win32 (Task Scheduler).');
  process.exit(1);
}

async function daemonUninstall(): Promise<void> {
  const platform = process.platform;
  if (platform === 'linux') {
    // Backward-compat: clean up either the new (`agent-tempo.service`) or
    // legacy (`agent-tempo.service`) unit so v0.x installs migrate cleanly.
    const dirSystemd = join(homedir(), '.config', 'systemd', 'user');
    const dstNew = join(dirSystemd, 'agent-tempo.service');
    const dstLegacy = join(dirSystemd, 'agent-tempo.service');
    for (const svc of ['agent-tempo', 'agent-tempo']) {
      try { execFileSync('systemctl', ['--user', 'disable', '--now', svc], { stdio: 'ignore' }); } catch { /* may not be running */ }
    }
    let removed = false;
    try {
      for (const dst of [dstNew, dstLegacy]) {
        if (existsSync(dst)) {
          unlinkSync(dst);
          out.success(`Removed ${dst}`);
          removed = true;
        }
      }
      if (!removed) out.log('No systemd unit file found.');
    } catch (err: any) {
      out.error(`Failed to remove systemd unit: ${err?.message ?? err}`);
      process.exit(1);
    }
    return;
  }

  if (platform === 'darwin') {
    // Backward-compat: clean up either the new (`com.agent.tempo.plist`) or
    // legacy (`com.claude.tempo.plist`) plist so v0.x installs migrate cleanly.
    const dstNew = join(homedir(), 'Library', 'LaunchAgents', 'com.agent.tempo.plist');
    const dstLegacy = join(homedir(), 'Library', 'LaunchAgents', 'com.claude.tempo.plist');
    let removed = false;
    for (const dst of [dstNew, dstLegacy]) {
      try { execFileSync('launchctl', ['unload', dst], { stdio: 'ignore' }); } catch { /* may not be loaded */ }
      if (existsSync(dst)) {
        unlinkSync(dst);
        out.success(`Removed ${dst}`);
        removed = true;
      }
    }
    if (!removed) out.log('No launchd plist found.');
    return;
  }

  if (platform === 'win32') {
    const script = packagingFile('windows', 'install-task.ps1');
    try {
      execFileSync(
        'powershell',
        ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', script, '-Uninstall'],
        { stdio: 'inherit' },
      );
    } catch (err: any) {
      out.error(`Failed to unregister scheduled task: ${err?.message ?? err}`);
      process.exit(1);
    }
    return;
  }

  out.error(`Unsupported platform: ${platform}`);
  process.exit(1);
}

// ── #336: `daemon stats` — memory + uptime snapshot ────────────────────

/**
 * Shape of `/v1/health` we depend on. Mirrors the production
 * {@link HealthV1} interface but is duplicated here so this file's strict
 * "no Temporal-deps" import policy isn't violated by re-using the type
 * from `src/http/event-types.ts` (which itself transitively imports
 * Temporal-flavored types).
 *
 * The wire shape is the public contract; if the daemon ever drops the
 * `memory` field we want this CLI to render gracefully (n/a) rather
 * than crash.
 */
interface HealthResponseShape {
  ok?: unknown;
  namespace?: unknown;
  version?: unknown;
  uptimeMs?: unknown;
  ensembleCount?: unknown;
  subscriberCount?: unknown;
  memory?: {
    rss?: unknown;
    heapTotal?: unknown;
    heapUsed?: unknown;
    external?: unknown;
    arrayBuffers?: unknown;
  };
}

/** Pretty-print a byte count as MB (rounded). Pure helper, exported for tests. */
export function formatBytesAsMb(n: unknown): string {
  if (typeof n !== 'number' || !Number.isFinite(n)) return 'n/a';
  return `${Math.round(n / (1024 * 1024))} MB`;
}

/** Pretty-print a millisecond uptime as `Xh Ym Zs`. Pure helper, exported for tests. */
export function formatUptime(ms: unknown): string {
  if (typeof ms !== 'number' || !Number.isFinite(ms) || ms < 0) return 'n/a';
  const totalSec = Math.floor(ms / 1000);
  const hours = Math.floor(totalSec / 3600);
  const minutes = Math.floor((totalSec % 3600) / 60);
  const seconds = totalSec % 60;
  if (hours > 0) return `${hours}h ${minutes}m ${seconds}s`;
  if (minutes > 0) return `${minutes}m ${seconds}s`;
  return `${seconds}s`;
}

/** GET `http://127.0.0.1:<port>/v1/health` and parse the JSON body. Used by `daemon stats`. */
function fetchHealth(port: number): Promise<HealthResponseShape> {
  return new Promise((resolve, reject) => {
    const req = http.request(
      { hostname: '127.0.0.1', port, path: '/v1/health', method: 'GET', timeout: 3000 },
      (res) => {
        const chunks: Buffer[] = [];
        res.on('data', (c) => chunks.push(c));
        res.on('end', () => {
          if (res.statusCode !== 200) {
            reject(new Error(`HTTP ${res.statusCode}`));
            return;
          }
          try {
            resolve(JSON.parse(Buffer.concat(chunks).toString('utf8')));
          } catch (err) {
            reject(err);
          }
        });
      },
    );
    req.on('error', reject);
    req.on('timeout', () => {
      req.destroy(new Error('request timed out after 3000ms'));
    });
    req.end();
  });
}

/**
 * Render the `daemon stats` payload to stdout. Filed under #336 — gives
 * operators a one-shot way to spot daemon memory growth without tailing
 * logs or attaching a debugger.
 */
async function daemonStats(): Promise<void> {
  // First check the daemon is even running — surface a friendlier message
  // than a raw ECONNREFUSED if not.
  const status = getDaemonStatus();
  if (!status.running) {
    out.warn('Daemon is not running — start it with `agent-tempo daemon start`');
    process.exit(1);
  }

  const port = readPortFile();
  if (port === null) {
    out.error('Daemon port file not found at ~/.agent-tempo/daemon.port');
    out.log(`  ${out.dim('The daemon may be from a pre-HTTP build. Restart it with `agent-tempo daemon stop && start`.')}`);
    process.exit(1);
  }

  let body: HealthResponseShape;
  try {
    body = await fetchHealth(port);
  } catch (err) {
    out.error(`Failed to query daemon at http://127.0.0.1:${port}/v1/health: ${err instanceof Error ? err.message : err}`);
    process.exit(1);
  }

  out.success(`Daemon stats (pid ${status.pid})`);
  out.log(`  ${out.dim('Version:        ')}${typeof body.version === 'string' ? body.version : 'n/a'}`);
  out.log(`  ${out.dim('Namespace:      ')}${typeof body.namespace === 'string' ? body.namespace : 'n/a'}`);
  out.log(`  ${out.dim('Uptime:         ')}${formatUptime(body.uptimeMs)}`);
  out.log(`  ${out.dim('Ensembles:      ')}${typeof body.ensembleCount === 'number' ? body.ensembleCount : 'n/a'}`);
  out.log(`  ${out.dim('SSE subscribers:')}${typeof body.subscriberCount === 'number' ? ` ${body.subscriberCount}` : ' n/a'}`);
  out.log('');
  if (body.memory) {
    out.log(`  ${out.dim('Memory (#336 diagnostic):')}`);
    out.log(`    ${out.dim('RSS:           ')}${formatBytesAsMb(body.memory.rss)}`);
    out.log(`    ${out.dim('Heap used:     ')}${formatBytesAsMb(body.memory.heapUsed)}`);
    out.log(`    ${out.dim('Heap total:    ')}${formatBytesAsMb(body.memory.heapTotal)}`);
    out.log(`    ${out.dim('External:      ')}${formatBytesAsMb(body.memory.external)}`);
    out.log(`    ${out.dim('Array buffers: ')}${formatBytesAsMb(body.memory.arrayBuffers)}`);
  } else {
    out.warn('Memory diagnostics not present in /v1/health response — daemon may be from a pre-#336 build.');
  }
}
