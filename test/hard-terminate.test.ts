/**
 * Integration test for the #159 Gap 2 hard-terminate activity.
 *
 * This test bypasses Temporal entirely and exercises the activity implementation
 * directly — it spawns a real long-running subprocess on the host, calls
 * `hardTerminateAttachment`, and asserts the PID is gone. We intentionally avoid
 * the test server here because the thing we need to verify is the OS-level kill
 * path, not the workflow glue (that's covered by the phase-machine suite).
 *
 * Scenarios:
 *   1. Command-line search path (no PID file) — mirrors the interactive
 *      claude.exe case.
 *   2. PID-file sanity guard — when the PID file points at a process whose image
 *      name doesn't match `node`, we skip the kill instead of nuking a bystander.
 *   3. No-op path — when there's nothing matching, the activity returns cleanly
 *      with `strategy: 'none'`.
 */
import { expect } from 'chai';
import { spawn } from 'child_process';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { hardTerminateAttachment } from '../src/activities/hard-terminate';

const isWindows = process.platform === 'win32';

/** Launch a real subprocess that will outlive us unless killed. Returns the PID. */
function spawnTestVictim(opts: { binaryArg: string; playerName: string }): {
  pid: number;
  waitForExit: () => Promise<number | null>;
} {
  // Node one-liner that keeps the event loop alive forever. Process title isn't used
  // for command-line matching — we rely on the `-n <playerName>` marker in argv.
  const args = [
    '-e',
    `setInterval(() => {}, 60000); process.on('SIGTERM', () => process.exit(0)); process.on('SIGINT', () => process.exit(0));`,
    '--',
    '-n',
    opts.playerName,
    '--tempo-test-marker',
  ];
  const child = spawn(process.execPath, args, {
    stdio: 'ignore',
    detached: true,
  });
  child.unref();
  const waitForExit = () =>
    new Promise<number | null>((resolve) => {
      if (child.exitCode !== null) return resolve(child.exitCode);
      child.once('exit', (code) => resolve(code));
      // Poll-fallback: on Windows, detached processes sometimes don't surface exit events to the parent.
      const timer = setInterval(() => {
        try {
          process.kill(child.pid!, 0);
        } catch {
          clearInterval(timer);
          resolve(null);
        }
      }, 100);
    });
  return { pid: child.pid!, waitForExit };
}

/** True if a process with this PID is currently running. */
function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

describe('hardTerminateAttachment — OS kill (#159 Gap 2)', function () {
  // Each case spawns a real process; allow generous timeout for slow CI + kill-grace.
  this.timeout(30_000);

  let tmpWorkDir: string;

  before(function () {
    tmpWorkDir = mkdtempSync(join(tmpdir(), 'tempo-hardterm-'));
  });

  after(function () {
    try { rmSync(tmpWorkDir, { recursive: true, force: true }); } catch { /* best-effort */ }
  });

  it('finds and kills processes matching -n <playerName> on the command line', async function () {
    // Unique playerName so we don't collide with concurrent test runs or stray processes.
    const playerName = `tempo-test-${process.pid}-${Date.now()}`;
    const victim = spawnTestVictim({ binaryArg: 'node', playerName });
    // Give the OS a moment to show the process in the table so the search sees it.
    await new Promise((r) => setTimeout(r, 300));
    expect(isAlive(victim.pid), 'victim should be alive after spawn').to.equal(true);

    const result = await hardTerminateAttachment({
      ensemble: 'test-ensemble',
      playerName,
      // 'copilot' bypasses the PID-file miss and still falls through to the search path
      // for `node` processes. We use copilot here intentionally: the test victim is `node`,
      // not `claude`, and 'claude' would search for `claude.exe` which wouldn't match.
      // The command-line matcher itself is identical for both adapters.
      agent: 'copilot',
      workDir: tmpWorkDir,
    });

    // Give the kill a moment to land (taskkill /T /F / SIGTERM → SIGKILL grace).
    for (let i = 0; i < 30 && isAlive(victim.pid); i++) {
      await new Promise((r) => setTimeout(r, 100));
    }
    expect(isAlive(victim.pid), 'victim should be dead after hardTerminate').to.equal(false);
    expect(result.killedPids, 'returned killedPids should include the victim').to.include(victim.pid);
    expect(result.strategy).to.equal('search');
  });

  it('returns strategy=none + empty killedPids when no matching process exists', async function () {
    const playerName = `nonexistent-${process.pid}-${Date.now()}`;
    const result = await hardTerminateAttachment({
      ensemble: 'test-ensemble',
      playerName,
      agent: 'claude',
      workDir: tmpWorkDir,
    });
    expect(result.killedPids).to.deep.equal([]);
    expect(result.strategy).to.equal('none');
  });

  it('skips killing when the copilot PID file points at a process with the wrong image name', async function () {
    // Spawn a non-node bystander (cmd.exe / sleep) and write its PID into a copilot-bridge
    // PID file. The sanity guard should read the file, see the process is NOT node/node.exe,
    // and refuse to kill it — defending against PID reuse after the real bridge exited and
    // the OS handed its PID to something unrelated.
    // `ping -n 60 localhost` lives for ~60s without needing a TTY — unlike timeout.exe,
    // which exits immediately when stdio is ignored. Image name reports as 'ping.exe'
    // which is distinctly NOT 'node.exe', so the sanity guard must refuse.
    const bystander = isWindows
      ? spawn('ping.exe', ['-n', '60', '127.0.0.1'], { stdio: 'ignore', detached: true })
      : spawn('sleep', ['60'], { stdio: 'ignore', detached: true });
    bystander.unref();
    await new Promise((r) => setTimeout(r, 400));
    const wrongPid = bystander.pid!;

    try {
      expect(isAlive(wrongPid), 'bystander should be alive after spawn').to.equal(true);

      const playerName = `copilot-guard-${process.pid}-${Date.now()}`;
      const logDir = join(tmpWorkDir, 'logs');
      mkdirSync(logDir, { recursive: true });
      const pidPath = join(logDir, `${playerName}.pid`);
      writeFileSync(pidPath, String(wrongPid));

      const result = await hardTerminateAttachment({
        ensemble: 'test-ensemble',
        playerName,
        agent: 'copilot',
        workDir: tmpWorkDir,
        logDir,
      });

      // Critical invariant: we did NOT kill the bystander PID.
      expect(isAlive(wrongPid), `bystander ${wrongPid} should still be alive after sanity guard`).to.equal(true);
      expect(result.killedPids).to.deep.equal([]);
      expect(result.strategy).to.equal('pidfile');
      // The notes array should carry the "skipped — PID reuse guard" reason.
      expect(result.notes.join('\n')).to.match(/skipped|reuse|no longer matches/i);
    } finally {
      // Clean up bystander so it doesn't linger after the test.
      try { process.kill(wrongPid); } catch { /* already gone */ }
    }
  });

  it('refuses to search when playerName fails the regex guard (injection defense)', async function () {
    // The search function rejects any playerName with shell-special characters; callers
    // that pass junk should get back an empty result instead of arbitrary command
    // execution via the PowerShell/pgrep pattern.
    const result = await hardTerminateAttachment({
      ensemble: 'test-ensemble',
      playerName: `bad; rm -rf /; $(echo pwned)`,
      agent: 'claude',
      workDir: tmpWorkDir,
    });
    expect(result.killedPids).to.deep.equal([]);
    expect(result.strategy).to.equal('none');
  });
});
