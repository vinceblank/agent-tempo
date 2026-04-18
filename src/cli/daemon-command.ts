/**
 * Daemon CLI command handler — `claude-tempo daemon <start|stop|status|logs|install|uninstall>`.
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
import { CliOverrides, getConfig } from '../config';
import {
  isDaemonRunning,
  startDaemon,
  stopDaemon,
  getDaemonStatus,
  scanClaudeTempoDaemons,
  DAEMON_LOG_PATH,
} from './daemon';
import * as out from './output';

/** Package root is two levels up from dist/cli/ */
const PACKAGE_ROOT = resolve(__dirname, '..', '..');

function packagingFile(...segments: string[]): string {
  return join(PACKAGE_ROOT, 'packaging', ...segments);
}

export interface DaemonOpts extends CliOverrides {
  subcommand?: string;
}

export async function daemon(opts: DaemonOpts): Promise<void> {
  const config = getConfig(opts);

  switch (opts.subcommand) {
    case 'start': {
      if (isDaemonRunning()) {
        const status = getDaemonStatus();
        out.success(`Daemon already running (pid ${status.pid})`);
        return;
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
      const scanned = scanClaudeTempoDaemons();

      if (status.running) {
        out.success(`Daemon running (pid ${status.pid})`);
        // Warn if the scanner reports extras the pid file doesn't know about —
        // orphans from a prior crashed run that never removed its pid file, or
        // a second daemon started by a stale concurrent CLI invocation (#157).
        const extras = scanned.filter((p) => p.pid !== status.pid);
        if (extras.length > 0) {
          out.warn(`Found ${extras.length} additional claude-tempo daemon process${extras.length === 1 ? '' : 'es'} not tracked by the pid file:`);
          for (const p of extras) out.log(`  pid ${p.pid}: ${p.commandLine}`);
          out.log(`  ${out.dim('See `claude-tempo daemon --help` or docs/troubleshooting.md for emergency cleanup.')}`);
        }
      } else {
        out.log('Daemon is not running');
        if (scanned.length > 0) {
          out.warn(`Found ${scanned.length} orphaned claude-tempo daemon process${scanned.length === 1 ? '' : 'es'} (no pid file):`);
          for (const p of scanned) out.log(`  pid ${p.pid}: ${p.commandLine}`);
          out.log(`  ${out.dim('These are untracked. See docs/troubleshooting.md → "Orphaned daemon processes" for emergency cleanup.')}`);
        }
      }
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
      out.error('Usage: claude-tempo daemon <start|stop|status|logs|install|uninstall>');
      out.log(`\n  ${out.dim('claude-tempo daemon start')}       Start the worker daemon`);
      out.log(`  ${out.dim('claude-tempo daemon stop')}        Stop the worker daemon`);
      out.log(`  ${out.dim('claude-tempo daemon status')}      Check daemon status + list any orphans`);
      out.log(`  ${out.dim('claude-tempo daemon logs')}        Tail daemon log output`);
      out.log(`  ${out.dim('claude-tempo daemon install')}     Install as a system service`);
      out.log(`  ${out.dim('claude-tempo daemon uninstall')}   Uninstall the system service`);
      process.exit(1);
  }

  // Used only to silence "config declared but never used" when a branch exits early.
  void config;
}

async function daemonInstall(): Promise<void> {
  const platform = process.platform;
  if (platform === 'linux') {
    const src = packagingFile('systemd', 'claude-tempo.service');
    const dstDir = join(homedir(), '.config', 'systemd', 'user');
    const dst = join(dstDir, 'claude-tempo.service');
    mkdirSync(dstDir, { recursive: true });
    copyFileSync(src, dst);
    out.success(`Installed systemd --user unit: ${dst}`);
    // Try to enable + start. User may still need `systemctl --user daemon-reload`.
    try {
      execFileSync('systemctl', ['--user', 'daemon-reload'], { stdio: 'ignore' });
      execFileSync('systemctl', ['--user', 'enable', '--now', 'claude-tempo'], { stdio: 'ignore' });
      out.log('  Enabled + started: systemctl --user enable --now claude-tempo');
    } catch {
      out.warn('  systemctl invocation failed — run manually:');
      out.log(`    ${out.dim('systemctl --user daemon-reload')}`);
      out.log(`    ${out.dim('systemctl --user enable --now claude-tempo')}`);
    }
    return;
  }

  if (platform === 'darwin') {
    const src = packagingFile('launchd', 'com.claude.tempo.plist');
    const dstDir = join(homedir(), 'Library', 'LaunchAgents');
    const dst = join(dstDir, 'com.claude.tempo.plist');
    mkdirSync(dstDir, { recursive: true });
    copyFileSync(src, dst);
    out.success(`Installed launchd agent: ${dst}`);
    out.warn('  NOTE: macOS launchd integration is untested in v0.25.0-beta.1 — feedback welcome.');
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
    const dst = join(homedir(), '.config', 'systemd', 'user', 'claude-tempo.service');
    try { execFileSync('systemctl', ['--user', 'disable', '--now', 'claude-tempo'], { stdio: 'ignore' }); } catch { /* may not be running */ }
    try {
      if (existsSync(dst)) {
        unlinkSync(dst);
        out.success(`Removed ${dst}`);
      } else {
        out.log('No systemd unit file found.');
      }
    } catch (err: any) {
      out.error(`Failed to remove systemd unit: ${err?.message ?? err}`);
      process.exit(1);
    }
    return;
  }

  if (platform === 'darwin') {
    const dst = join(homedir(), 'Library', 'LaunchAgents', 'com.claude.tempo.plist');
    try { execFileSync('launchctl', ['unload', dst], { stdio: 'ignore' }); } catch { /* may not be loaded */ }
    if (existsSync(dst)) {
      unlinkSync(dst);
      out.success(`Removed ${dst}`);
    } else {
      out.log('No launchd plist found.');
    }
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
