/**
 * OS-level process-tree termination for a detaching session.
 *
 * Fix for issue #159 Gap 2: workflow-side `forceDetach` / drainingDeadline only flip the
 * phase — they do *not* kill the child process that adapter was driving. On Windows that
 * leaves an orphaned `claude.exe` holding the session ID, and the next `-n <name>` spawn
 * collides with its own past self ("Error: Session ID <uuid> is already in use").
 *
 * This activity runs on the target's per-host task queue (`claude-tempo-{hostname}`) so
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
import { join } from 'path';
import type { AgentType } from '../types';

const log = (...args: unknown[]) => console.error('[claude-tempo:hard-terminate]', ...args);

export interface HardTerminateInput {
  /** Ensemble name — log context only. */
  ensemble: string;
  /** Player name the session was spawned as. Matched against `claude.exe -n <name>` in the search path. */
  playerName: string;
  /** Adapter type — controls PID-file lookup and expected process-name verification. */
  agent: AgentType;
  /** Session's workDir — used to locate the copilot bridge PID file (`<workDir>/logs/<playerName>.pid`). */
  workDir: string;
  /** Optional explicit logDir override; falls back to `<workDir>/logs`. */
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
  const { ensemble, playerName, agent, workDir, logDir } = input;
  const notes: string[] = [];
  const killedPids: number[] = [];

  log(`hardTerminate start — ensemble=${ensemble} player=${playerName} agent=${agent}`);

  // ── Copilot bridge: PID file is authoritative ──
  if (agent === 'copilot') {
    const pidDir = logDir || join(workDir, 'logs');
    const pidPath = join(pidDir, `${playerName}.pid`);
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
  const pids = findProcessesByCommandLine(binaryName, playerName);
  if (pids.length === 0) {
    notes.push(`No ${binaryName} processes found matching playerName="${playerName}" — nothing to kill.`);
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
  notes.push(`Killed ${killedPids.length} ${binaryName} process(es) matching "${playerName}": [${killedPids.join(', ')}]`);
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
    });
    if (result.status === 0) return true;
    const stderr = (result.stderr || '').toString();
    if (/not found|not running|no tasks/i.test(stderr)) return false;
    log(`taskkill /T /F /PID ${pid} → status ${result.status}, stderr: ${stderr.trim()}`);
    return result.status === 0;
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
 * line contains `-n <playerName>`. Returns the set of matching PIDs, or `[]` when nothing
 * matches (including when the native lookup tool is missing).
 *
 * The command-line match mirrors the operator workaround documented in #159 — every spawn
 * we care about passes `-n <playerName>` (see `src/activities/outbox.ts` spawnArgs).
 */
function findProcessesByCommandLine(binaryName: string, playerName: string): number[] {
  // Defensive: bail out on absurd inputs so we never inject into the PowerShell/pgrep expression.
  if (!playerName || !/^[A-Za-z0-9._\-]+$/.test(playerName)) {
    log(`findProcessesByCommandLine: refusing lookup for playerName="${playerName}" (failed regex guard)`);
    return [];
  }

  if (process.platform === 'win32') {
    // Prefer PowerShell's CIM provider — reliable CommandLine access without admin.
    // Fall back to wmic if PowerShell is missing (older Windows without it).
    //
    // The regex matches `-n <name>` followed by the playerName with optional surrounding
    // quotes. The regex guard at the top of this function has already established that
    // `playerName` is `[A-Za-z0-9._-]+`, so direct interpolation into the PowerShell
    // string is safe. We delimit the PowerShell regex literal with double-quoted `@(...)`
    // style via a here-string to avoid nesting single-quote hell with the `["']?` chunk.
    try {
      // Build the PowerShell regex using PowerShell char-class syntax — `["''']?` inside a
      // single-quoted PowerShell string (single-quote is the safer delimiter since our
      // embedded Name='claude.exe' filter uses single quotes). Use `''` (two singles) to
      // escape a single-quote inside a single-quoted PS literal. We don't need to match
      // double-quotes around playerName in practice (taskline args aren't wrapped in DQ
      // by our spawn path), so the simpler pattern `-n\s+<name>` suffices.
      const escapedName = playerName.replace(/[.-]/g, (c) => `\\${c}`);
      const psScript =
        `$procs = Get-CimInstance Win32_Process -Filter "Name='${binaryName}'"; ` +
        `$pattern = '-n\\s+${escapedName}(\\s|$)'; ` +
        `$procs | Where-Object { $_.CommandLine -match $pattern } | Select-Object -ExpandProperty ProcessId`;
      const out = execFileSync('powershell', ['-NoProfile', '-Command', psScript], {
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'ignore'],
      });
      return parsePids(out);
    } catch (err) {
      log(`powershell lookup failed (${errMsg(err)}); falling back to wmic`);
    }
    try {
      const out = execFileSync(
        'wmic',
        [
          'process',
          'where',
          `Name='${binaryName}' and CommandLine like '%-n ${playerName}%'`,
          'get',
          'ProcessId',
          '/format:value',
        ],
        { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] },
      );
      return parsePids(out);
    } catch (err) {
      log(`wmic lookup failed (${errMsg(err)}); giving up on Windows search`);
      return [];
    }
  }

  // Unix: pgrep -fa returns lines like "<pid> <cmd>". Filter by binary and playerName match.
  try {
    const pattern = `${binaryName}.*-n ${playerName}(\\b|$)`;
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

function errMsg(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
