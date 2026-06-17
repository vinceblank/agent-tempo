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
import { spawn, execFileSync } from 'child_process';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { hardTerminateAttachment } from '../src/activities/hard-terminate';

const isWindows = process.platform === 'win32';

/**
 * Read the Win32_Process CommandLine for a given PID via PowerShell CIM.
 * Returns the empty string if the process is gone or the query fails. Used by
 * the Windows fixtures to assert the production-quoted `"-n" "<name>"` topology
 * actually shows up in the OS process table — if it doesn't, the fixture is
 * not exercising the real bug and the test is a false negative.
 */
function readWindowsCommandLine(pid: number): string {
  try {
    const out = execFileSync(
      'powershell',
      [
        '-NoProfile',
        '-Command',
        `(Get-CimInstance Win32_Process -Filter "ProcessId=${pid}").CommandLine`,
      ],
      { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] },
    );
    return out.trim();
  } catch {
    return '';
  }
}

/**
 * Reap any stale test-victim processes left behind by a crashed prior run.
 * Matches on the unique markers this suite puts in argv (`--tempo-test-marker`,
 * `--tempo-165-probe`) — no production process uses those tokens, so the reap
 * is safe. Idempotent and best-effort.
 */
function reapStaleTestVictims(): void {
  if (isWindows) {
    try {
      execFileSync(
        'powershell',
        [
          '-NoProfile',
          '-Command',
          `Get-CimInstance Win32_Process | Where-Object { $_.CommandLine -match '--tempo-test-marker' -or $_.CommandLine -match '--tempo-165-probe' } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }`,
        ],
        { encoding: 'utf8', stdio: ['ignore', 'ignore', 'ignore'] },
      );
    } catch { /* best-effort */ }
    return;
  }
  try {
    execFileSync('pkill', ['-f', '--tempo-test-marker'], { stdio: 'ignore' });
  } catch { /* no match or pkill absent */ }
  try {
    execFileSync('pkill', ['-f', '--tempo-165-probe'], { stdio: 'ignore' });
  } catch { /* best-effort */ }
}

/**
 * Launch a real subprocess that will outlive us unless killed. Returns the PID.
 *
 * On Windows, the real production spawn path (`src/spawn.ts` §WT branch) builds
 * the inner command as a single string with EVERY arg explicitly wrapped in
 * double quotes — e.g.
 *     "C:\...\claude.exe" "server:agent-tempo" "-n" "<playerName>" "--session-id" ...
 * Between `-n` and `<playerName>` is literally `" "` (close-quote, space,
 * open-quote). That's the topology the old `-n\s+<name>` regex failed to match,
 * making the whole kill path a silent no-op in production.
 *
 * Node's default argv serializer does NOT produce this shape — it only quotes
 * args that contain whitespace or quotes, leaving bare tokens like `-n` and
 * `tempo-test-xxx` unquoted. To reproduce the production form faithfully we
 * build the inner command ourselves and invoke it via `cmd.exe /c` (Windows)
 * or pass it through a shell (Unix). This forces the CommandLine visible to
 * Win32_Process to contain the quoted sentinel exactly as production does.
 */
async function spawnTestVictim(opts: {
  binaryArg: string;
  playerName: string;
  tmpDir?: string;
  /**
   * Ensemble name to embed as `--remote-control-session-name-prefix <ensemble>` in
   * the victim's argv. Defaults to 'test-ensemble-hardterm-fixture' to match the common-case callers
   * that pass `ensemble: 'test-ensemble-hardterm-fixture'` to `hardTerminateAttachment`. Tests that
   * exercise cross-ensemble scoping (#180) pass distinct values per victim.
   */
  ensemble?: string;
}): Promise<{
  pid: number;
  waitForExit: () => Promise<number | null>;
}> {
  const ensemble = opts.ensemble ?? 'test-ensemble-hardterm-fixture';
  // Node one-liner that keeps the event loop alive forever. Process title isn't used
  // for command-line matching — we rely on the `-n <playerName>` marker in argv.
  const nodeScript = `setInterval(() => {}, 60000); process.on('SIGTERM', () => process.exit(0)); process.on('SIGINT', () => process.exit(0));`;
  if (isWindows) {
    // Production (`src/spawn.ts` §WT branch) ships innerCmd to `cmd /k` as a
    // single string with every token hand-wrapped in double quotes:
    //   "<nodeBin>" "-e" "<script>" "--" "-n" "<playerName>" "--tempo-test-marker"
    // That literal string ends up in cmd.exe's CommandLine, and when cmd
    // dispatches node.exe it preserves those quotes, so node's CommandLine
    // also carries the quoted `"-n" "<playerName>"` sentinel.
    //
    // To reproduce the shape faithfully in a test we write a one-line .bat
    // containing exactly the pre-quoted tokens and spawn `cmd.exe /c <bat>`.
    // cmd interprets each quoted token as a separate arg and hands them to
    // node.exe; node's CRT re-quotes argv on startup, producing the exact
    // production-shaped CommandLine. A detached batch spawn avoids all the
    // argv-serialization gotchas of Node's spawn on Windows.
    const tmpDir = opts.tmpDir || tmpdir();
    const batPath = join(tmpDir, `victim-${opts.playerName}.bat`);
    const q = (s: string) => `"${s.replace(/"/g, '""')}"`;
    // Prefix with `start /B ""` so the child node.exe is launched without a
    // visible console window. Without /B, node inherits no console from the
    // windowsHide'd cmd parent and Windows creates a fresh one, causing a
    // visible popup. /B = run in background, no new window. The empty ""
    // after /B is required — it's the window title arg (never shown) that
    // start consumes before the actual command.
    writeFileSync(
      batPath,
      [
        '@echo off',
        [
          'start', '/B', '""',
          q(process.execPath),
          q('-e'),
          q(nodeScript),
          q('--'),
          q('--remote-control-session-name-prefix'),
          q(ensemble),
          q('-n'),
          q(opts.playerName),
          q('--tempo-test-marker'),
        ].join(' '),
        '',
      ].join('\r\n'),
    );
    const cmdChild = spawn('cmd.exe', ['/c', batPath], {
      stdio: 'ignore',
      detached: true,
      windowsHide: true,
    });
    cmdChild.unref();
    // cmd /c exits after spawning node; resolve the node child by its quoted
    // sentinels. Async polling so we don't block the event loop — the earlier
    // busy-wait variant starved spawn callbacks and the child never appeared.
    //
    // Both the playerName AND the ensemble sentinel are required to identify a
    // unique spawn: cross-ensemble tests (#180) spawn two victims with the same
    // playerName but distinct ensembles, so matching on playerName alone would
    // return the first-spawned PID for both calls.
    const escName = opts.playerName.replace(/[.-]/g, (c) => `\\${c}`);
    const escEnsemble = ensemble.replace(/[.-]/g, (c) => `\\${c}`);
    const quotedNameSentinel = new RegExp(`"-n"\\s+"${escName}"`);
    const quotedEnsembleSentinel = new RegExp(`"--remote-control-session-name-prefix"\\s+"${escEnsemble}"`);
    let victimPid = -1;
    for (let i = 0; i < 60 && victimPid === -1; i++) {
      await new Promise((r) => setTimeout(r, 100));
      try {
        const out = execFileSync(
          'powershell',
          [
            '-NoProfile',
            '-Command',
            `Get-CimInstance Win32_Process -Filter "Name='node.exe'" | ForEach-Object { Write-Output "$($_.ProcessId)|$($_.CommandLine)" }`,
          ],
          { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] },
        );
        for (const line of out.split(/\r?\n/)) {
          const sep = line.indexOf('|');
          if (sep === -1) continue;
          const pidStr = line.slice(0, sep);
          const cmdLine = line.slice(sep + 1);
          if (quotedNameSentinel.test(cmdLine) && quotedEnsembleSentinel.test(cmdLine)) {
            victimPid = parseInt(pidStr, 10);
            break;
          }
        }
      } catch { /* retry */ }
    }
    if (victimPid === -1) {
      throw new Error(
        `spawnTestVictim: could not locate node.exe child with quoted sentinels for playerName=${opts.playerName} ensemble=${ensemble}`,
      );
    }
    const waitForExit = () =>
      new Promise<number | null>((resolve) => {
        const timer = setInterval(() => {
          try {
            process.kill(victimPid, 0);
          } catch {
            clearInterval(timer);
            resolve(null);
          }
        }, 100);
      });
    return { pid: victimPid, waitForExit };
  }
  const args = [
    '-e',
    nodeScript,
    '--',
    '--remote-control-session-name-prefix',
    ensemble,
    '-n',
    opts.playerName,
    '--tempo-test-marker',
  ];
  const child = spawn(process.execPath, args, {
    stdio: 'ignore',
    detached: true,
    windowsHide: true,
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

  // On Windows, this suite's fixtures spawn `cmd.exe /c .bat → node.exe` to
  // reproduce the production-quoted `"-n" "<playerName>"` CommandLine topology.
  // Even with `windowsHide: true` on cmd, Windows allocates a console for the
  // grandchild node.exe because `CREATE_NO_WINDOW` does not propagate through
  // cmd's internal CreateProcess. Result: every `npm test` run flashes console
  // windows on Windows, which is disruptive when a player (e.g. tempo-devops)
  // runs `npm test` on a recurring schedule. Gate the Windows suite behind
  // `AGENT_TEMPO_RUN_WIN_INTEGRATION=1` (or `CI=true` in CI pipelines) so
  // ambient local runs skip it. CI and manual opt-in still exercise it.
  if (isWindows && !process.env.CI && !process.env.AGENT_TEMPO_RUN_WIN_INTEGRATION) {
    it.skip('Windows hard-terminate integration tests — set AGENT_TEMPO_RUN_WIN_INTEGRATION=1 to run', () => {});
    return;
  }

  let tmpWorkDir: string;
  const spawnedPids: number[] = [];

  before(function () {
    tmpWorkDir = mkdtempSync(join(tmpdir(), 'tempo-hardterm-'));
    // Belt & suspenders: reap any stale victims left over from prior crashed runs.
    // Each victim carries a marker token in its argv that is unique to this test
    // suite and has no production analogue, so matching on it is safe.
    reapStaleTestVictims();
  });

  afterEach(function () {
    // Kill any victim this test spawned that is still alive. Tests that spawn
    // via spawnTestVictim push onto `spawnedPids`; cleanup is best-effort so
    // a missing PID (already killed) does not fail the suite.
    // On Windows, use taskkill /F which can terminate cmd.exe processes that
    // process.kill(pid, 'SIGKILL') would fail on with EPERM.
    while (spawnedPids.length > 0) {
      const pid = spawnedPids.pop()!;
      if (isWindows) {
        try { execFileSync('taskkill', ['/F', '/PID', String(pid)], { stdio: 'ignore' }); } catch { /* already gone */ }
      } else {
        try { process.kill(pid, 'SIGKILL'); } catch { /* already gone */ }
      }
    }
  });

  after(function () {
    try { rmSync(tmpWorkDir, { recursive: true, force: true }); } catch { /* best-effort */ }
    reapStaleTestVictims();
  });

  it('finds and kills processes matching -n <playerName> on the command line', async function () {
    // Unique playerName so we don't collide with concurrent test runs or stray processes.
    const playerName = `tempo-test-${process.pid}-${Date.now()}`;
    const victim = await spawnTestVictim({ binaryArg: 'node', playerName, tmpDir: tmpWorkDir });
    spawnedPids.push(victim.pid);
    // Give the OS a moment to show the process in the table so the search sees it.
    await new Promise((r) => setTimeout(r, 300));
    expect(isAlive(victim.pid), 'victim should be alive after spawn').to.equal(true);

    // On Windows the fixture spawn flow is self-guarding: `spawnTestVictim`
    // resolves the PID by scanning for the quoted `"-n" "<playerName>"`
    // sentinel, so getting here at all proves the CommandLine is in the
    // production shape. The regex-quoting fix is what lets hardTerminate
    // match that same CommandLine — without the fix, the kill below no-ops.
    if (isWindows) {
      const cmdline = readWindowsCommandLine(victim.pid);
      expect(
        cmdline,
        `Windows fixture invariant: victim PID=${victim.pid} CommandLine should include quoted "-n" "<playerName>". Actual: ${cmdline}`,
      ).to.match(new RegExp(`"-n"\\s+"${playerName.replace(/[.-]/g, (c) => `\\${c}`)}"`));
    }

    const result = await hardTerminateAttachment({
      ensemble: 'test-ensemble-hardterm-fixture',
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
      ensemble: 'test-ensemble-hardterm-fixture',
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
      ? spawn('ping.exe', ['-n', '60', '127.0.0.1'], { stdio: 'ignore', detached: true, windowsHide: true })
      : spawn('sleep', ['60'], { stdio: 'ignore', detached: true });
    bystander.unref();
    spawnedPids.push(bystander.pid!);
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
        ensemble: 'test-ensemble-hardterm-fixture',
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

  it('#690: locates a LEGACY <workDir>/logs pid file when no central pid exists (transitional fallback)', async function () {
    // Pre-upgrade (≤v1.6.1) bridges wrote their pid to <workDir>/logs. Post-#690
    // the reader checks the central ~/.agent-tempo/logs/<ensemble>/ first, then
    // falls back (read-only) to the legacy per-cwd dir. This proves the fallback
    // still finds an orphan from a pre-upgrade spawn. Use the wrong-image bystander
    // so the guard SKIPS the kill — we only need to prove the pid file was LOCATED
    // (strategy='pidfile') via the legacy path, with NO logDir override.
    const bystander = isWindows
      ? spawn('ping.exe', ['-n', '60', '127.0.0.1'], { stdio: 'ignore', detached: true, windowsHide: true })
      : spawn('sleep', ['60'], { stdio: 'ignore', detached: true });
    bystander.unref();
    spawnedPids.push(bystander.pid!);
    await new Promise((r) => setTimeout(r, 400));
    const wrongPid = bystander.pid!;

    try {
      const playerName = `legacy-copilot-${process.pid}-${Date.now()}`;
      // A unique ensemble whose CENTRAL dir (~/.agent-tempo/logs/<ensemble>) won't
      // exist, so the central check misses and the legacy fallback must engage.
      const ensemble = `legacy-ens-${process.pid}-${Date.now()}`;
      const legacyLogDir = join(tmpWorkDir, 'logs');
      mkdirSync(legacyLogDir, { recursive: true });
      writeFileSync(join(legacyLogDir, `${playerName}.pid`), String(wrongPid));

      const result = await hardTerminateAttachment({
        ensemble,
        playerName,
        agent: 'copilot',
        workDir: tmpWorkDir,
        // NO logDir override — central default is used, then the legacy <workDir>/logs.
      });

      // The legacy pid file was FOUND (strategy=pidfile); the wrong-image guard then
      // refused the kill (bystander still alive).
      expect(result.strategy, 'legacy fallback should locate the pid file').to.equal('pidfile');
      expect(isAlive(wrongPid), 'bystander should survive the sanity guard').to.equal(true);
    } finally {
      try { process.kill(wrongPid); } catch { /* already gone */ }
    }
  });

  it('also kills parent cmd.exe when it matches the -n sentinel (#165 — WT orphan tab fix)', async function () {
    // This test reproduces the production WT spawn topology:
    //   cmd.exe /k "<nodeBin> -e '...' -- -n <playerName>"
    // Before #165, hardTerminate killed only the node child, leaving the parent
    // cmd.exe alive in the Windows Terminal tab. The one-level parent-walk in
    // `findProcessesByCommandLine` now identifies that cmd.exe (same `-n` sentinel
    // in its own CommandLine) and adds it to the kill list, so WT closes the tab
    // when the shell exits.
    if (!isWindows) this.skip(); // SKIP-REASON: Windows-only test — spawns Windows Terminal tab and uses win32 FindWindow/SendMessage APIs (#157)
    if (process.env.CI) {
      // SKIP-REASON: parent cmd.exe assertion fails on Windows GitHub Actions runners (passes on dev Windows). Surfaced by #150's new windows-latest CI matrix; not a regression of that PR. Investigate separately if the underlying detached-cmd-exe lifetime semantics differ on hosted Windows runners.
      this.skip();
    }

    const playerName = `tempo165-${process.pid}-${Date.now()}`;
    // Set up the WT orphan topology:
    //   cmd.exe /k <bat>
    // where <bat>'s single line is `"<nodeBin>" "-e" "<script>" "--" "-n" "<playerName>" "--tempo-165-probe"`.
    // This reproduces the production `src/spawn.ts` §WT branch exactly:
    // production builds innerCmd with every token hand-wrapped in double
    // quotes before passing it to `cmd /k`. Using a .bat indirection sidesteps
    // Node's Windows argv-serialization (which would otherwise need verbatim
    // mode + careful quoting) and still delivers the exact CommandLine shape
    // to Win32_Process: the parent cmd.exe's own CommandLine is `cmd.exe /k
    // <bat>`, but cmd /k's executed line matches the quoted sentinel — and
    // more importantly, the parent cmd.exe's CommandLine needs to contain the
    // sentinel too for parent-walk to pick it up. We achieve that by passing
    // `-n <playerName>` as additional /k args so cmd.exe's argv literally
    // includes them alongside the .bat path.
    //
    // Running a batch file from cmd does NOT spawn a nested cmd.exe — the
    // batch interprets inline, so node.exe's actual parent IS the outer
    // cmd.exe, and the parent-walk + sentinel check then engages correctly.
    const nodeScript = `setInterval(function(){},60000);process.on('SIGTERM',function(){process.exit(0)});process.on('SIGINT',function(){process.exit(0)});`;
    const q = (s: string) => `"${s.replace(/"/g, '""')}"`;
    const probeBat = join(tmpWorkDir, `probe-${playerName}.bat`);
    // Both the parent cmd.exe and the child node.exe must carry the ensemble
    // sentinel so the per-ensemble scoping (#180) lets hard-terminate match them.
    const probeEnsemble = 'test-ensemble-hardterm-fixture';
    writeFileSync(
      probeBat,
      [
        '@echo off',
        // Prefix with `start /B ""` so node.exe is launched without a visible
        // console window. Matches the pattern in `spawnTestVictim` (same fix).
        [
          'start', '/B', '""',
          q(process.execPath),
          q('-e'),
          q(nodeScript),
          q('--'),
          q('--remote-control-session-name-prefix'),
          q(probeEnsemble),
          q('-n'),
          q(playerName),
          q('--tempo-165-probe'),
        ].join(' '),
        '',
      ].join('\r\n'),
    );
    // Spawn cmd.exe with `/k <bat> "--remote-control-session-name-prefix" "<ensemble>" "-n" "<playerName>"` —
    // Node's default argv serializer wraps each argument that contains no whitespace
    // with... well, actually `-n` and `<playerName>` are bare tokens and Node will leave
    // them unquoted. We need the parent cmd.exe's CommandLine to explicitly carry
    // BOTH the quoted `-n` sentinel and the quoted ensemble sentinel so parent-walk
    // engages with the #180 AND guard. Build the full command line as a pre-quoted
    // string and use verbatim mode so cmd receives it as-is.
    const parentCmdTail = `${probeBat} "--remote-control-session-name-prefix" "${probeEnsemble}" "-n" "${playerName}" "--tempo-165-probe"`;
    // #694 — keep the parent cmd.exe's stdin OPEN (a pipe we never write to / never
    // end) instead of `stdio: 'ignore'`. `cmd /k` is interactive: after running the
    // /k command line it reads the NEXT command from stdin — and an ignored stdin is
    // at EOF immediately, so cmd would exit right after launching the node child,
    // making the "parent cmd.exe should be alive after spawn" precondition flake
    // (deterministically fail on some boxes). Holding stdin open blocks that read so
    // the parent stays alive — faithfully matching PRODUCTION, where the WT path's
    // `cmd /k` lives in a real Windows Terminal tab whose stdin is the live terminal.
    // The CommandLine/topology is otherwise identical, so parent-walk still engages.
    const cmdProc = spawn('cmd.exe', ['/k', parentCmdTail], {
      detached: true,
      stdio: ['pipe', 'ignore', 'ignore'],
      windowsHide: true,
      windowsVerbatimArguments: true,
    });
    cmdProc.unref();
    // The held-open stdin write end is destroyed in the `finally` below (and the
    // mocha runner is configured `exit: true`), so it can't keep the loop alive.
    const cmdPid = cmdProc.pid!;
    spawnedPids.push(cmdPid);

    // Poll until the node.exe child is visible in the process table — same 60x100ms
    // pattern as spawnTestVictim. Replaces a fixed 1.5s sleep that could flake on CI.
    const quotedSentinelPoll = new RegExp(`"-n"\\s+"${playerName.replace(/[.-]/g, (c) => `\\${c}`)}"`);
    let nodeChildVisible = false;
    for (let i = 0; i < 60 && !nodeChildVisible; i++) {
      await new Promise((r) => setTimeout(r, 100));
      try {
        const out = execFileSync(
          'powershell',
          [
            '-NoProfile',
            '-Command',
            `Get-CimInstance Win32_Process -Filter "Name='node.exe' AND ParentProcessId=${cmdPid}" | ForEach-Object { $_.CommandLine }`,
          ],
          { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] },
        );
        if (quotedSentinelPoll.test(out)) {
          nodeChildVisible = true;
        }
      } catch { /* retry */ }
    }
    if (!nodeChildVisible) {
      throw new Error(
        `parent-walk test: could not locate node.exe child of cmd.exe PID=${cmdPid} with sentinel for playerName=${playerName}`,
      );
    }
    expect(isAlive(cmdPid), 'parent cmd.exe should be alive after spawn').to.equal(true);

    // Fixture-invariant guards: both the parent cmd.exe and (if present) the node
    // child must carry the production-quoted `"-n" "<playerName>"` topology. If
    // either doesn't, this test cannot exercise the regex-quoting fix — we'd rather
    // fail loudly than pass against the wrong shape.
    const quotedSentinel = new RegExp(`"-n"\\s+"${playerName.replace(/[.-]/g, (c) => `\\${c}`)}"`);
    const parentCmdline = readWindowsCommandLine(cmdPid);
    expect(
      parentCmdline,
      `Windows fixture invariant: parent cmd.exe PID=${cmdPid} CommandLine should include quoted "-n" "<playerName>". Actual: ${parentCmdline}`,
    ).to.match(quotedSentinel);
    // Try to find the node child by asking wmic for all node.exe children of this cmd.
    let sawNodeChildQuoted = false;
    try {
      const allNodeCmdlines = execFileSync(
        'powershell',
        [
          '-NoProfile',
          '-Command',
          `Get-CimInstance Win32_Process -Filter "Name='node.exe' AND ParentProcessId=${cmdPid}" | ForEach-Object { $_.CommandLine }`,
        ],
        { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] },
      );
      sawNodeChildQuoted = quotedSentinel.test(allNodeCmdlines);
    } catch { /* best-effort probe */ }
    expect(
      sawNodeChildQuoted,
      'Windows fixture invariant: node.exe child of cmd.exe should have "-n" "<playerName>" in its CommandLine',
    ).to.equal(true);

    try {
      const result = await hardTerminateAttachment({
        ensemble: 'test-ensemble-hardterm-fixture',
        playerName,
        // 'copilot' routes to node.exe search (no PID file exists → falls through).
        // The parent-walk applies regardless of binaryName — it only triggers when
        // the parent image is cmd.exe AND carries the same `-n <playerName>` sentinel.
        agent: 'copilot',
        workDir: tmpWorkDir,
      });

      // Allow a grace period for taskkill /T /F to cascade — both node and cmd.
      for (let i = 0; i < 50 && isAlive(cmdPid); i++) {
        await new Promise((r) => setTimeout(r, 100));
      }
      expect(
        isAlive(cmdPid),
        `parent cmd.exe pid ${cmdPid} should be dead via parent-walk (killedPids=${result.killedPids.join(',')})`,
      ).to.equal(false);
      expect(
        result.killedPids,
        `returned killedPids should include parent cmd.exe pid ${cmdPid}`,
      ).to.include(cmdPid);
      expect(result.strategy).to.equal('search');
    } finally {
      // #694 — release the held-open stdin pipe (a `cmd /k` that survived the kill
      // would otherwise keep blocking on it), then the safety-net kill.
      try { cmdProc.stdin?.destroy(); } catch { /* already gone */ }
      // Safety net — clean up anything the parent-walk missed so CI doesn't leak procs.
      try { process.kill(cmdPid); } catch { /* already gone */ }
    }
  });

  it('kills a process whose playerName contains dots (regex-escape coverage)', async function () {
    // Exercises the `replace(/[.-]/g, ...)` regex-escape path in findProcessesByCommandLine
    // with a name containing dots — the hyphen path is already covered by every other test,
    // but dots were untested and could break the WMI/pgrep pattern if not escaped.
    const playerName = `tempo.player-1.test-${process.pid}-${Date.now()}`;
    const victim = await spawnTestVictim({ binaryArg: 'node', playerName, tmpDir: tmpWorkDir });
    spawnedPids.push(victim.pid);
    await new Promise((r) => setTimeout(r, 300));
    expect(isAlive(victim.pid), 'victim should be alive after spawn').to.equal(true);

    if (isWindows) {
      const cmdline = readWindowsCommandLine(victim.pid);
      expect(
        cmdline,
        `Windows fixture invariant: victim PID=${victim.pid} CommandLine should include quoted "-n" "<playerName>". Actual: ${cmdline}`,
      ).to.match(new RegExp(`"-n"\\s+"${playerName.replace(/[.-]/g, (c) => `\\${c}`)}"`));
    }

    const result = await hardTerminateAttachment({
      ensemble: 'test-ensemble-hardterm-fixture',
      playerName,
      agent: 'copilot',
      workDir: tmpWorkDir,
    });

    for (let i = 0; i < 30 && isAlive(victim.pid); i++) {
      await new Promise((r) => setTimeout(r, 100));
    }
    expect(isAlive(victim.pid), 'victim should be dead after hardTerminate').to.equal(false);
    expect(result.killedPids, 'returned killedPids should include the victim').to.include(victim.pid);
    expect(result.strategy).to.equal('search');
  });

  it('refuses to search when playerName fails the regex guard (injection defense)', async function () {
    // The search function rejects any playerName with shell-special characters; callers
    // that pass junk should get back an empty result instead of arbitrary command
    // execution via the PowerShell/pgrep pattern.
    const result = await hardTerminateAttachment({
      ensemble: 'test-ensemble-hardterm-fixture',
      playerName: `bad; rm -rf /; $(echo pwned)`,
      agent: 'claude',
      workDir: tmpWorkDir,
    });
    expect(result.killedPids).to.deep.equal([]);
    expect(result.strategy).to.equal('none');
  });

  it('scopes kill to the target ensemble when two ensembles share a player name (#180)', async function () {
    // Reproduces the cross-ensemble destroy bug: two ensembles using the same
    // lineup template spawn sessions with identical player names. Before #180,
    // `destroy --all` in ensembleA would find and kill claude.exe processes in
    // BOTH ensembles because the kill regex only matched on `-n <playerName>`.
    //
    // With the ensemble sentinel injected by outbox.ts and the AND guard in
    // findProcessesByCommandLine, only the ensembleA victim should die — the
    // ensembleB victim carries a different sentinel and must survive.
    const sharedName = `smoke-${process.pid}-${Date.now()}`;
    const victimA = await spawnTestVictim({
      binaryArg: 'node',
      playerName: sharedName,
      ensemble: 'ensembleA',
      tmpDir: tmpWorkDir,
    });
    spawnedPids.push(victimA.pid);
    const victimB = await spawnTestVictim({
      binaryArg: 'node',
      playerName: sharedName,
      ensemble: 'ensembleB',
      tmpDir: tmpWorkDir,
    });
    spawnedPids.push(victimB.pid);

    // Give the OS a moment so both processes are visible in the table.
    await new Promise((r) => setTimeout(r, 300));
    expect(isAlive(victimA.pid), 'victim A should be alive after spawn').to.equal(true);
    expect(isAlive(victimB.pid), 'victim B should be alive after spawn').to.equal(true);

    // Fixture invariants on Windows: confirm each CommandLine carries BOTH the
    // `-n <sharedName>` and the distinct ensemble sentinel. Without this, the
    // test cannot exercise the #180 AND guard.
    if (isWindows) {
      const cmdA = readWindowsCommandLine(victimA.pid);
      const cmdB = readWindowsCommandLine(victimB.pid);
      const escName = sharedName.replace(/[.-]/g, (c) => `\\${c}`);
      expect(cmdA, `victim A CommandLine: ${cmdA}`).to.match(new RegExp(`"-n"\\s+"${escName}"`));
      expect(cmdA, `victim A CommandLine: ${cmdA}`).to.match(/"--remote-control-session-name-prefix"\s+"ensembleA"/);
      expect(cmdB, `victim B CommandLine: ${cmdB}`).to.match(new RegExp(`"-n"\\s+"${escName}"`));
      expect(cmdB, `victim B CommandLine: ${cmdB}`).to.match(/"--remote-control-session-name-prefix"\s+"ensembleB"/);
    }

    // Call hardTerminate scoped to ensembleA only.
    const result = await hardTerminateAttachment({
      ensemble: 'ensembleA',
      playerName: sharedName,
      // 'copilot' routes the search to `node`/`node.exe` (same as other tests);
      // the AND guard is identical for both adapters.
      agent: 'copilot',
      workDir: tmpWorkDir,
    });

    // Wait for victim A to actually die.
    for (let i = 0; i < 30 && isAlive(victimA.pid); i++) {
      await new Promise((r) => setTimeout(r, 100));
    }
    expect(isAlive(victimA.pid), 'victim A (ensembleA) should be dead').to.equal(false);
    expect(
      isAlive(victimB.pid),
      `victim B (ensembleB) should still be alive — cross-ensemble kill regression`,
    ).to.equal(true);
    expect(result.killedPids, 'killedPids should contain A only').to.deep.equal([victimA.pid]);
    expect(result.strategy).to.equal('search');
  });

  it('refuses to search when ensemble fails the regex guard (injection defense)', async function () {
    // Symmetric with the playerName injection guard: ensemble names with shell-special
    // chars must not be interpolated into the PowerShell/pgrep pattern. The search
    // should return empty with strategy 'none' — no kill attempted.
    const result = await hardTerminateAttachment({
      ensemble: `bad; $(echo pwned)`,
      playerName: `benign-name-${process.pid}`,
      agent: 'claude',
      workDir: tmpWorkDir,
    });
    expect(result.killedPids).to.deep.equal([]);
    expect(result.strategy).to.equal('none');
  });
});
