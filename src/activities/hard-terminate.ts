/**
 * OS-level process-tree termination for a detaching session.
 *
 * Fix for issue #159 Gap 2: workflow-side `forceDetach` / drainingDeadline only flip the
 * phase — they do *not* kill the child process that adapter was driving. On Windows that
 * leaves an orphaned `claude.exe` holding the session ID, and the next `-n <name>` spawn
 * collides with its own past self ("Error: Session ID <uuid> is already in use").
 *
 * This activity runs on the target's per-host task queue (`agent-tempo-{hostname}`) so
 * the kill happens on the machine where the process actually lives. Callers:
 *   - workflow main-loop §9.5.c drainingDeadline (best-effort, workflow keeps flipping state
 *     on failure so it doesn't get wedged in `draining` forever)
 *   - `deliverRestart` activity on the force path — strict "kill first, then flip state"
 *     order per the conductor's steering on #159.
 *
 * Strategy per adapter:
 *   - **Copilot bridge**: PID file at `<logDir>/<playerName>.pid` is authoritative.
 *     Verifies the PID still resolves to `node`/`node.exe` before firing (guard against
 *     PID reuse after the bridge already exited).
 *   - **Claude Code (interactive)**: no useful PID is captured at spawn time — the spawn
 *     returns the transient `cmd.exe` / `osascript` / `bash` launcher, not the eventual
 *     `claude.exe`. Search running processes for `claude` (or `.exe` on Windows) whose
 *     command line contains `-n <playerName>`. This is the operator workaround from #159
 *     ("Get-CimInstance ... Where CommandLine -match '<session-name>'") turned into
 *     automation.
 */
import { execFileSync, spawnSync } from 'child_process';
import { existsSync, readFileSync, unlinkSync } from 'fs';
import type { AgentType } from '../types';
import { bridgeLogPaths } from '../config';
import { ENSEMBLE_SENTINEL_FLAG, escapeNameForRegex } from '../constants';

const log = (...args: unknown[]) => console.error('[agent-tempo:hard-terminate]', ...args);

export interface HardTerminateInput {
  /**
   * Ensemble name. Load-bearing: matched against the `ENSEMBLE_SENTINEL_FLAG
   * <ensemble>` pair in each candidate's CommandLine so two ensembles sharing a
   * lineup template (identical player names) don't kill each other's processes
   * on `destroy --all` (issue #180). The sentinel is injected by
   * `src/activities/outbox.ts` on every Claude Code spawn. See src/constants.ts.
   */
  ensemble: string;
  /** Player name the session was spawned as. Matched against `claude.exe -n <name>` in the search path. */
  playerName: string;
  /** Adapter type — controls PID-file lookup and expected process-name verification. */
  agent: AgentType;
  /** Session's workDir — carried on the activity input as a session attribute. */
  workDir: string;
  /** Optional explicit logDir override for the central bridge log path. */
  logDir?: string;
}

export interface HardTerminateResult {
  /** PIDs that were signaled/taskkilled. Empty on the "nothing to do" path. */
  killedPids: number[];
  /** Which code path produced the kill: PID-file lookup, command-line search, or no-op. */
  strategy: 'pidfile' | 'search' | 'none';
  /** Short human-readable notes recorded by the activity — surfaced in workflow logs. */
  notes: string[];
}

/**
 * Best-effort OS-level process-tree termination. Never throws — returns a result describing
 * what happened so callers can record it in workflow history without blocking state flips.
 */
export async function hardTerminateAttachment(input: HardTerminateInput): Promise<HardTerminateResult> {
  const { ensemble, playerName, agent, logDir } = input;
  const notes: string[] = [];
  const killedPids: number[] = [];

  log(`hardTerminate start — ensemble=${ensemble} player=${playerName} agent=${agent}`);

  // ── Copilot bridge: PID file is authoritative ──
  if (agent === 'copilot') {
    // #690 — pid lives at the CENTRAL ~/.agent-tempo/logs/<ensemble>/ path.
    const pidPath = bridgeLogPaths(ensemble, playerName, logDir).pidPath;
    if (existsSync(pidPath)) {
      try {
        const pidStr = readFileSync(pidPath, 'utf8').trim();
        const pid = parseInt(pidStr, 10);
        if (Number.isFinite(pid) && pid > 0) {
          const expected = process.platform === 'win32' ? 'node.exe' : 'node';
          if (processMatchesExpected(pid, expected)) {
            const killed = await killProcessTree(pid);
            if (killed) {
              killedPids.push(pid);
              notes.push(`Killed copilot bridge PID ${pid}`);
            } else {
              notes.push(`kill of copilot PID ${pid} reported non-fatal error; process may have self-exited mid-call`);
            }
          } else {
            notes.push(`Skipped copilot PID ${pid} — process no longer matches "${expected}" (likely already exited; PID-reuse guard).`);
          }
        } else {
          notes.push(`Copilot PID file contained invalid value "${pidStr}"`);
        }
        try { unlinkSync(pidPath); } catch { /* best-effort cleanup */ }
      } catch (err) {
        notes.push(`Copilot PID-file handling failed: ${errMsg(err)}`);
      }
      log(`hardTerminate done (pidfile) — killedPids=[${killedPids.join(',')}]`);
      return { killedPids, strategy: 'pidfile', notes };
    }
    notes.push(`No copilot PID file at ${pidPath}; falling through to command-line search.`);
  }

  // ── Command-line search path (interactive claude.exe, or copilot fallback) ──
  const binaryName = agent === 'copilot'
    ? (process.platform === 'win32' ? 'node.exe' : 'node')
    : (process.platform === 'win32' ? 'claude.exe' : 'claude');
  const pids = findProcessesByCommandLine(binaryName, playerName, ensemble);
  if (pids.length === 0) {
    notes.push(`No ${binaryName} processes found matching playerName="${playerName}" ensemble="${ensemble}" — nothing to kill.`);
    log(`hardTerminate done (none) — nothing to kill`);
    return { killedPids, strategy: 'none', notes };
  }
  for (const pid of pids) {
    try {
      if (await killProcessTree(pid)) killedPids.push(pid);
    } catch (err) {
      notes.push(`kill(${pid}) failed: ${errMsg(err)}`);
    }
  }
  notes.push(`Killed ${killedPids.length} ${binaryName} process(es) matching "${playerName}" in ensemble "${ensemble}": [${killedPids.join(', ')}]`);
  log(`hardTerminate done (search) — killedPids=[${killedPids.join(',')}]`);
  return { killedPids, strategy: 'search', notes };
}

// ────────────────────────────────────────────────────────────────────────────────────────────
// Platform helpers
// ────────────────────────────────────────────────────────────────────────────────────────────

/**
 * Verify that `pid` resolves to a process whose executable image name matches `expected`.
 * Guards against Windows PID reuse after the target bridge/claude process has already exited
 * — without this check, we might taskkill an unrelated process that happened to inherit the PID.
 */
function processMatchesExpected(pid: number, expected: string): boolean {
  try {
    if (process.platform === 'win32') {
      // `tasklist /FI "PID eq <pid>" /FO CSV /NH` prints a single CSV line naming the image,
      // or "INFO: No tasks running" when the PID is gone. No PowerShell dependency required.
      const out = execFileSync('tasklist', ['/FI', `PID eq ${pid}`, '/FO', 'CSV', '/NH'], {
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'ignore'],
        windowsHide: true,
      });
      // First CSV field is the image name, quoted.
      const m = out.match(/^"([^"]+)"/);
      if (!m) return false;
      return m[1].toLowerCase() === expected.toLowerCase();
    }
    // Unix: liveness probe first, then /proc/<pid>/comm if available.
    process.kill(pid, 0); // throws if the pid doesn't exist
    try {
      const comm = readFileSync(`/proc/${pid}/comm`, 'utf8').trim();
      if (comm) return comm === expected;
    } catch {
      // /proc not available (macOS, BSD) — fall back to `ps` lookup.
    }
    const psOut = execFileSync('ps', ['-p', String(pid), '-o', 'comm='], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
    return psOut === expected || psOut.endsWith(`/${expected}`);
  } catch {
    return false;
  }
}

/**
 * Kill the process whose PID is `pid` AND all of its descendants. Returns `true` when the
 * process is dead or was never running by the time this returns; `false` when the kill
 * command ran but the process stubbornly refused to exit within the grace window.
 *
 * On Windows `taskkill /T /F` is synchronous and walks PPID → children; callers can rely on
 * the return value. On Unix we SIGTERM the process group first (since spawns use
 * `detached: true`), poll for exit for 500ms, then SIGKILL, poll again — so by the time
 * this function returns the process really is gone, not "scheduled to die soon". That
 * matters for the `forceDetachUpdate` strict-ordering path: a fresh `recruit` immediately
 * after must see the session ID unlocked.
 */
async function killProcessTree(pid: number): Promise<boolean> {
  if (process.platform === 'win32') {
    // /T walks PPID → children; /F forces immediate termination. 128 = not found,
    // 255 = already gone. Treat those as success for idempotence.
    const result = spawnSync('taskkill', ['/T', '/F', '/PID', String(pid)], {
      stdio: ['ignore', 'ignore', 'pipe'],
      encoding: 'utf8',
      windowsHide: true,
    });
    if (result.status === 0) return true;
    const stderr = (result.stderr || '').toString();
    if (/not found|not running|no tasks/i.test(stderr)) return false;
    log(`taskkill /T /F /PID ${pid} → status ${result.status}, stderr: ${stderr.trim()}`);
    // status is known to be non-zero here (line 184 handled the 0 case) and not a recognized
    // "already gone" signature — report kill failure to the caller.
    return false;
  }

  // Unix: SIGTERM → brief poll → SIGKILL → brief poll. Process-group signal first
  // (negative pid) because spawnInTerminal uses `detached: true`; fall back to the bare pid.
  // Catch ESRCH (already gone) and EPERM (permission) silently — both mean "nothing more to do".
  const killPair = (sig: NodeJS.Signals) => {
    try { process.kill(-pid, sig); } catch { /* process-group not applicable */ }
    try { process.kill(pid, sig); } catch { /* already gone */ }
  };
  const pollUntilDead = async (maxMs: number): Promise<boolean> => {
    const deadline = Date.now() + maxMs;
    while (Date.now() < deadline) {
      try { process.kill(pid, 0); } catch { return true; }
      await new Promise((r) => setTimeout(r, 50));
    }
    try { process.kill(pid, 0); return false; } catch { return true; }
  };

  killPair('SIGTERM');
  if (await pollUntilDead(500)) return true;
  killPair('SIGKILL');
  return pollUntilDead(500);
}

/**
 * Search the live process table for entries whose image matches `binaryName` and whose command
 * line contains BOTH `-n <playerName>` AND `--remote-control-session-name-prefix <ensemble>`.
 * Returns the set of matching PIDs, or `[]` when nothing matches (including when the native
 * lookup tool is missing).
 *
 * The command-line match mirrors the operator workaround documented in #159 — every spawn
 * we care about passes `-n <playerName>` (see `src/activities/outbox.ts` spawnArgs). The
 * ensemble-prefix sentinel was added in #180 so two ensembles sharing a lineup template
 * (identical player names) don't clobber each other on `destroy --all`.
 */
function findProcessesByCommandLine(binaryName: string, playerName: string, ensemble: string): number[] {
  // Defensive: bail out on absurd inputs so we never inject into the PowerShell/pgrep expression.
  if (!playerName || !/^[A-Za-z0-9._\-]+$/.test(playerName)) {
    log(`findProcessesByCommandLine: refusing lookup for playerName="${playerName}" (failed regex guard)`);
    return [];
  }
  if (!ensemble || !/^[A-Za-z0-9._\-]+$/.test(ensemble)) {
    log(`findProcessesByCommandLine: refusing lookup for ensemble="${ensemble}" (failed regex guard)`);
    return [];
  }

  if (process.platform === 'win32') {
    // Prefer PowerShell's CIM provider — reliable CommandLine access without admin.
    // Fall back to wmic if PowerShell is missing (older Windows without it).
    //
    // The regex matches `-n` followed by the playerName, tolerant of the Windows quoted
    // arg form. In production the spawned `claude.exe` receives argv re-serialized with
    // CRT-style quoting, so its CommandLine as visible to Win32_Process looks like:
    //   ... "server:agent-tempo" "-n" "<playerName>" "--session-id" ...
    // Between `-n` and `<playerName>` there is literally `" "` — close-quote, space,
    // open-quote — which `\s+` alone does NOT match. The character class `[\s"']+`
    // accepts any combination of whitespace and quote characters, covering both the
    // bare `-n <name>` form (used by tests and some launchers) and the quoted
    // `"-n" "<name>"` form (real production). Same treatment on the trailing boundary
    // so `"<name>"` terminates cleanly. This was the root cause of the smoke-run
    // failure discovered behind #164+#165: the activity compiled and ran, but its
    // regex never matched any real `claude.exe`, making the whole #159 kill path a
    // silent no-op in production.
    //
    // The regex guard at the top of this function has already established that
    // `playerName` is `[A-Za-z0-9._-]+`, so direct interpolation into the PowerShell
    // string is safe. `.` and `-` are escaped as regex metachars before embedding
    // into the `-match` pattern.
    //
    // Parent-walk (issue #165): for each matched process, look up its parent exactly one
    // level via `ParentProcessId`. If that parent is `cmd.exe` AND its own CommandLine
    // contains the same `-n <playerName>` sentinel, include the parent PID in the kill
    // list. This clears the Windows Terminal tab when sessions are spawned via
    // `cmd.exe /c start "" wt.exe ... cmd /k <innerCmd>` (see spawn.ts WT branch) — the
    // inner `cmd /k` shell is the claude.exe parent; without killing it, WT leaves an
    // unresponsive tab with cmd.exe alive on the prompt. Scope is strictly one level:
    // grandparents are WT.exe / conhost.exe and must not be touched. The sentinel check
    // reuses the same regex pattern used for the primary match — only cmd.exe shells
    // that we spawned via the #159 pipeline can match.
    const escapedName = escapeNameForRegex(playerName);
    const escapedEnsemble = escapeNameForRegex(ensemble);
    try {
      // Emit PARENT PIDs before child PIDs. taskkill /T /F cascades to descendants,
      // so killing cmd.exe first also kills its claude.exe child in the same call —
      // fewer WMI round-trips, and we correctly credit the parent kill instead of
      // losing it to a race where claude.exe dies first and cmd.exe exits on its
      // own (e.g. when its console has no more input). Ordering here flows directly
      // into the kill loop via `parsePids`, which preserves insertion order.
      //
      // PS single-quoted string literal escapes `'` by doubling it: `''`. The bracket
      // class `[\s"'']` therefore denotes the set { whitespace, `"`, `'` } in the
      // compiled regex. Double-quote needs no escaping inside a PS single-quoted
      // literal.
      //
      // Two patterns are required to match (both AND-ed in the Where clause) so we
      // never kill a process from a sibling ensemble that happens to share the same
      // player name (#180). The ensemble sentinel is
      // `--remote-control-session-name-prefix <ensemble>`, injected by outbox.ts.
      // The parent-walk check applies the same pair so parent cmd.exe wrappers that
      // don't carry the ensemble sentinel are left alone.
      const psScript = [
        `$procs = Get-CimInstance Win32_Process -Filter "Name='${binaryName}'";`,
        `$pattern = '-n[\\s"'']+${escapedName}([\\s"'']|$)';`,
        `$ensemblePattern = '${ENSEMBLE_SENTINEL_FLAG}[\\s"'']+${escapedEnsemble}([\\s"'']|$)';`,
        `$matched = $procs | Where-Object { $_.CommandLine -match $pattern -and $_.CommandLine -match $ensemblePattern };`,
        `$result = @();`,
        `foreach ($p in @($matched)) {`,
        `  $ppid = $p.ParentProcessId;`,
        `  if ($ppid) {`,
        `    $parent = Get-CimInstance Win32_Process -Filter "ProcessId=$ppid" -ErrorAction SilentlyContinue;`,
        `    if ($parent -and $parent.Name -ieq 'cmd.exe' -and $parent.CommandLine -match $pattern -and $parent.CommandLine -match $ensemblePattern) {`,
        `      $result += [int]$parent.ProcessId;`,
        `    }`,
        `  }`,
        `  $result += [int]$p.ProcessId;`,
        `}`,
        `$result | Select-Object -Unique`,
      ].join(' ');
      const out = execFileSync('powershell', ['-NoProfile', '-Command', psScript], {
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'ignore'],
        windowsHide: true,
      });
      return parsePids(out);
    } catch (err) {
      log(`powershell lookup failed (${errMsg(err)}); falling back to wmic`);
    }
    // wmic fallback — older Windows without PowerShell. Parent-walk is best-effort here:
    // we do a second wmic call to resolve parents for any matched child PIDs. If wmic
    // itself is missing (Windows 11 24H2+ removed it), we return the child PIDs only —
    // the WT orphan-tab fix won't engage, but the primary #159 kill still works.
    //
    // LIKE uses a single `%` between `-n` and `<playerName>` so the filter accepts any
    // intervening characters (space, `" "`, `' '`). This intentionally overmatches —
    // we then pull CommandLine back and post-filter with the same tolerate-quotes
    // regex used in the PowerShell path so non-ours matches are rejected. Without
    // this widening, the quoted production form (`"-n" "<name>"`) slips past the
    // stricter `%-n <name>%` LIKE pattern entirely, which is the root cause this
    // fix addresses.
    //
    // Both patterns (player name AND ensemble sentinel) must match for the block to
    // survive the filter — mirrors the PowerShell path's AND guard for #180.
    const tolerantPatterns = [
      new RegExp(`-n[\\s"']+${escapedName}(?:[\\s"']|$)`),
      new RegExp(`${ENSEMBLE_SENTINEL_FLAG}[\\s"']+${escapedEnsemble}(?:[\\s"']|$)`),
    ];
    try {
      const out = execFileSync(
        'wmic',
        [
          'process',
          'where',
          `Name='${binaryName}' and CommandLine like '%-n%${playerName}%' and CommandLine like '%${ENSEMBLE_SENTINEL_FLAG}%${ensemble}%'`,
          'get',
          'CommandLine,ProcessId,ParentProcessId',
          '/format:value',
        ],
        { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], windowsHide: true },
      );
      const { pids: childPids, ppids } = parseWmicPidPpidFiltered(out, tolerantPatterns);
      const parentPids: number[] = [];
      for (const ppid of ppids) {
        try {
          const parentOut = execFileSync(
            'wmic',
            [
              'process',
              'where',
              `ProcessId=${ppid} and Name='cmd.exe' and CommandLine like '%-n%${playerName}%' and CommandLine like '%${ENSEMBLE_SENTINEL_FLAG}%${ensemble}%'`,
              'get',
              'CommandLine,ProcessId,ParentProcessId',
              '/format:value',
            ],
            { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] },
          );
          const { pids: matched } = parseWmicPidPpidFiltered(parentOut, tolerantPatterns);
          parentPids.push(...matched);
        } catch {
          /* no matching parent — leave it */
        }
      }
      // Parents first so `taskkill /T /F` cascades to children in one call.
      return [...new Set([...parentPids, ...childPids])];
    } catch (err) {
      log(`wmic lookup failed (${errMsg(err)}); giving up on Windows search`);
      return [];
    }
  }

  // Unix: pgrep -f returns PIDs whose full cmdline matches the pattern.
  // pgrep uses POSIX ERE — `\s` is NOT a metacharacter (it matches literal 's').
  // Use `[[:space:]"']` for the whitespace/quote class instead.
  //
  // The combined pattern requires BOTH `-n <playerName>` AND
  // `--remote-control-session-name-prefix <ensemble>` to be present, matching the
  // Windows AND guard for #180. argv order is deterministic because spawnArgs in
  // src/activities/outbox.ts places the ensemble sentinel before the name args.
  try {
    const escapedNameU = escapeNameForRegex(playerName);
    const escapedEnsembleU = escapeNameForRegex(ensemble);
    const pattern =
      `${binaryName}.*${ENSEMBLE_SENTINEL_FLAG}[[:space:]"']+${escapedEnsembleU}([[:space:]"']|$)` +
      `.*-n[[:space:]"']+${escapedNameU}([[:space:]"']|$)`;
    const out = execFileSync('pgrep', ['-f', pattern], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    });
    return parsePids(out);
  } catch {
    // pgrep exits non-zero when no matches.
    return [];
  }
}

function parsePids(raw: string): number[] {
  const pids = new Set<number>();
  for (const line of raw.split(/\r?\n/)) {
    const m = line.match(/\b(\d{2,})\b/);
    if (!m) continue;
    const pid = parseInt(m[1], 10);
    if (Number.isFinite(pid) && pid > 0 && pid !== process.pid) pids.add(pid);
  }
  return [...pids];
}

/**
 * Parse wmic `/format:value` output that requested `CommandLine`, `ProcessId`, and
 * `ParentProcessId`, and retain only blocks whose CommandLine matches EVERY pattern
 * in `cmdPatterns`.
 *
 * The caller widens the LIKE filter to `%-n%<name>%` so the quoted production form
 * `"-n" "<name>"` passes the SQL-style match. Because that filter overmatches
 * (it would also accept e.g. `-name foo<name>bar`), we post-filter per-block here
 * using the same tolerate-quotes regex used in the PowerShell path. Blocks whose
 * CommandLine fails any pattern are discarded — their PID/PPID never enter the kill
 * list. Output blocks look like:
 *     CommandLine=<cmdline>\r\nParentProcessId=<n>\r\nProcessId=<m>\r\n\r\n
 * `wmic` key ordering is alphabetical so CommandLine always precedes the IDs.
 *
 * Multi-pattern matching supports the #180 AND guard: callers pass [`-n <name>`,
 * `--remote-control-session-name-prefix <ensemble>`] and both must match before
 * the block's PID is eligible to kill.
 */
function parseWmicPidPpidFiltered(
  raw: string,
  cmdPatterns: RegExp[],
): { pids: number[]; ppids: number[] } {
  const pids = new Set<number>();
  const ppids = new Set<number>();
  // Split on blank line separator — wmic uses \r\n\r\n between records.
  for (const block of raw.split(/\r?\n\r?\n/)) {
    if (!block.trim()) continue;
    const cmdLineMatch = block.match(/^CommandLine=(.*)$/m);
    const pidMatch = block.match(/^ProcessId=(\d+)$/m);
    const ppidMatch = block.match(/^ParentProcessId=(\d+)$/m);
    if (!cmdLineMatch || !pidMatch) continue;
    const cmdLine = cmdLineMatch[1];
    if (!cmdPatterns.every((p) => p.test(cmdLine))) continue;
    const pid = parseInt(pidMatch[1], 10);
    if (Number.isFinite(pid) && pid > 0 && pid !== process.pid) pids.add(pid);
    if (ppidMatch) {
      const ppid = parseInt(ppidMatch[1], 10);
      if (Number.isFinite(ppid) && ppid > 0 && ppid !== process.pid) ppids.add(ppid);
    }
  }
  return { pids: [...pids], ppids: [...ppids] };
}

function errMsg(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
