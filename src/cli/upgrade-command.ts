/**
 * `claude-tempo upgrade` CLI handler.
 *
 * **Critical constraint**: this module must NOT statically import from
 * `@temporalio/*`, `../workflows/*`, `../adapters/*`, `../spawn`, `../client`,
 * `./commands`, `./preflight`, or any module that transitively pulls in the
 * Temporal SDK. The `upgrade` command must remain operable when the Temporal
 * SDK itself is broken — that's the entire point of upgrading (users invoke
 * `upgrade` precisely when the installed SDK is failing).
 *
 * Temporal connection is used ONLY for the optional "warn about active
 * sessions" informational step. It's dynamic-imported inside the existing
 * try/catch — if the SDK fails to load, the warning is silently skipped
 * (strictly better than a crash). The user is already getting fresh binaries
 * via `npm install -g claude-tempo`.
 *
 * Extracted from `src/cli/commands.ts` in issue #157 PR C.
 */
import { readFileSync, writeFileSync } from 'fs';
import { join, resolve } from 'path';
import { execFileSync, spawn as cpSpawn } from 'child_process';
import { getConfig, CliOverrides, AGENT_TEMPO_HOME } from '../config';
import { isDaemonRunning, stopDaemon } from './daemon';
import * as out from './output';

/** Package root is two levels up from dist/cli/ */
const PACKAGE_ROOT = resolve(__dirname, '..', '..');

export interface UpgradeOpts extends CliOverrides {
  version?: string; // target version (e.g. "0.20.0", "latest"); defaults to "latest"
}

export async function upgrade(opts: UpgradeOpts): Promise<void> {
  const config = getConfig(opts);
  const targetVersion = opts.version || 'latest';
  const installSpec = targetVersion === 'latest' ? 'claude-tempo' : `claude-tempo@${targetVersion}`;

  // Read current version
  let currentVersion = 'unknown';
  try {
    const pkg = JSON.parse(readFileSync(join(PACKAGE_ROOT, 'package.json'), 'utf8'));
    currentVersion = pkg.version || 'unknown';
  } catch { /* ignore */ }

  out.heading('claude-tempo upgrade');
  out.log(`  Current: v${currentVersion}`);
  out.log(`  Target:  ${targetVersion}`);
  console.log();

  // Check for active sessions — warn the user.
  //
  // #157 PR C: Temporal bits are dynamic-imported so the whole check path
  // crash-proofs under a broken SDK install. Previously a top-level
  // `@temporalio/client` import crashed `upgrade` before the npm install
  // ever ran — exactly the scenario the user was trying to recover from.
  // Now: broken SDK → silently skip warning, continue with upgrade. The
  // warning is a courtesy, not a safety gate.
  let activeSessions = 0;
  try {
    const { Client } = await import('@temporalio/client');
    const { createTemporalConnection } = await import('../connection');
    const connection = await Promise.race([
      createTemporalConnection(config),
      new Promise<never>((_, reject) => setTimeout(() => reject(new Error('timeout')), 3000)),
    ]);
    const client = new Client({ connection, namespace: config.temporalNamespace });
    const query = 'WorkflowType = "agentSessionWorkflow" AND ExecutionStatus = "Running"';
    for await (const _wf of client.workflow.list({ query })) {
      activeSessions++;
    }
  } catch {
    // Either Temporal SDK failed to load (broken install — the scenario we're
    // trying to upgrade out of), or connection failed (server down). Either
    // way: skip the warning, proceed with upgrade.
  }

  if (activeSessions > 0) {
    out.warn(`${activeSessions} active session(s) detected. They will lose daemon connectivity during upgrade.`);
    out.log(`  ${out.dim('Consider running: claude-tempo stop --all')}`);
    console.log();
  }

  // Stop the daemon gracefully (releases .node file locks)
  const daemonWasRunning = isDaemonRunning();
  if (daemonWasRunning) {
    out.log('Stopping daemon...');
    stopDaemon();
    // Wait for process to exit — important on Windows for file lock release
    const deadline = Date.now() + 5000;
    while (Date.now() < deadline && isDaemonRunning()) {
      await new Promise((r) => setTimeout(r, 200));
    }
    if (isDaemonRunning()) {
      out.error('Daemon did not stop in time. Try: claude-tempo daemon stop');
      process.exit(1);
    }
    out.success('Daemon stopped');
  }

  // Build the detached updater script.
  // This is a self-contained Node.js script (no native module deps) that:
  //   1. Waits for the CLI process to exit (by PID)
  //   2. Runs npm install -g
  //   3. Verifies the install
  //   4. Restarts the daemon
  const cliPid = process.pid;
  const isWin = process.platform === 'win32';

  const updaterScript = `
const { execFileSync } = require('child_process');
const fs = require('fs');

const PID = ${cliPid};
const INSTALL_SPEC = ${JSON.stringify(installSpec)};
const TARGET = ${JSON.stringify(targetVersion)};
const IS_WIN = ${isWin};
const LOG_PATH = ${JSON.stringify(join(AGENT_TEMPO_HOME, 'upgrade.log'))};

function log(msg) {
  const line = new Date().toISOString() + ' ' + msg;
  try { fs.appendFileSync(LOG_PATH, line + '\\n'); } catch {}
  console.log(msg);
}

function isPidAlive(pid) {
  try { process.kill(pid, 0); return true; }
  catch { return false; }
}

async function main() {
  // Wait for CLI process to exit (up to 10s)
  log('Waiting for CLI process (pid ' + PID + ') to exit...');
  const deadline = Date.now() + 10000;
  while (Date.now() < deadline && isPidAlive(PID)) {
    await new Promise(r => setTimeout(r, 300));
  }
  if (isPidAlive(PID)) {
    log('WARNING: CLI process still alive after 10s, proceeding anyway');
  }

  // Run npm install -g
  log('Installing ' + INSTALL_SPEC + '...');
  try {
    const npmCmd = IS_WIN ? 'npm.cmd' : 'npm';
    execFileSync(npmCmd, ['install', '-g', INSTALL_SPEC], {
      stdio: 'inherit',
      timeout: 120000,
    });
    log('Install completed');
  } catch (err) {
    log('Install FAILED: ' + err.message);
    log('Recovery: npm install -g ' + INSTALL_SPEC);
    process.exit(1);
  }

  // Verify installation
  try {
    const tempoCmd = IS_WIN ? 'claude-tempo.cmd' : 'claude-tempo';
    const ver = execFileSync(tempoCmd, ['--version'], {
      encoding: 'utf8',
      timeout: 10000,
    }).trim();
    log('Verified: ' + ver);
  } catch (err) {
    log('WARNING: Could not verify installation: ' + err.message);
    log('Recovery: npm install -g claude-tempo');
  }

  // Restart the daemon
  log('Restarting daemon...');
  try {
    const tempoCmd = IS_WIN ? 'claude-tempo.cmd' : 'claude-tempo';
    execFileSync(tempoCmd, ['daemon', 'start'], {
      stdio: 'inherit',
      timeout: 30000,
    });
    log('Daemon restarted');
  } catch (err) {
    log('WARNING: Daemon restart failed: ' + err.message);
    log('Run manually: claude-tempo daemon start');
  }

  log('Upgrade complete!');
}

main().catch(err => {
  log('Upgrade failed: ' + err.message);
  process.exit(1);
});
`.trim();

  // Clear previous upgrade log before spawning
  const logPath = join(AGENT_TEMPO_HOME, 'upgrade.log');
  try { writeFileSync(logPath, ''); } catch { /* ignore */ }

  // Spawn the updater as a detached child process
  out.log(`Spawning upgrade process for ${out.cyan(installSpec)}...`);

  const child = cpSpawn(process.execPath, ['-e', updaterScript], {
    detached: true,
    stdio: 'ignore',
    env: { ...process.env },
  });
  child.unref();

  console.log();
  out.success('Upgrade started in background');
  out.log(`  ${out.dim('Monitor progress: ')}`);
  if (isWin) {
    out.log(`    ${out.dim('powershell Get-Content -Wait "' + logPath + '"')}`);
  } else {
    out.log(`    ${out.dim('tail -f ' + logPath)}`);
  }
  out.log(`  ${out.dim('If it fails, run manually: npm install -g ' + installSpec)}`);
}
