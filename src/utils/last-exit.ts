/**
 * `daemon.last-exit.json` — one-shot post-mortem marker for an abnormal
 * daemon exit, surfaced once on the next CLI invocation and then deleted.
 *
 * Schema owned by devops (see docs/design/daemon-last-exit-schema.md);
 * ratified by the architect ruling (docs/research/daemon-resilience-architect-ruling.md
 * §2 Q3, §4.4) as the required companion of the daemon-supervision program —
 * without it, a 5-minute periodic re-trigger + a give-up-exit-1 supervisor
 * hides a permanent crash-loop behind a green PID file.
 *
 * TEMPORAL-FREE by design (precedent: src/upgrade/snapshot-v1.ts) — this
 * module is imported from BOTH the crash-proof CLI surface
 * (src/cli/daemon.ts, src/cli/ensure-infra.ts — CLAUDE.md pins these as "no
 * Temporal deps") AND src/daemon.ts (the worker supervisor, PR-D). Keep it
 * that way: no imports beyond `fs`/`path`/`os` and `../config`.
 *
 * Two writers, one file:
 *  - the daemon itself, on give-up / boot-guard-refusal / drain-timeout /
 *    any unhandled fatal, via {@link writeLastExitSync} — BEFORE its own
 *    process.exit(1).
 *  - the CLI, via {@link writeLastExitSync} with `reason: 'stale-pid-unexplained'`,
 *    when it finds a dead PID in daemon.pid that no marker already explains
 *    (OOM-kill, `taskkill`, power loss, or any fatal that skipped the
 *    daemon's own write). See src/cli/daemon.ts::getDaemonStatus().
 *
 * WRITE-ONCE, FIRST-WRITER-WINS (architect ruling §Q2/§two-writer-race): if
 * the daemon already explained its own death, the CLI's generic
 * "unexplained" fallback must never clobber that forensic detail. This is
 * enforced INSIDE {@link writeLastExitSync} — callers don't need their own
 * existence check.
 *
 * A clean exit (code 0 — SIGTERM/SIGINT with a completed drain) writes
 * NOTHING. Absence of this file IS the "daemon shut down cleanly" signal.
 */
import * as fs from 'fs';
import * as path from 'path';
import { AGENT_TEMPO_HOME } from '../config';

/** Path to the marker file. Derives from {@link AGENT_TEMPO_HOME} so dev mode
 *  (`~/.agent-tempo-dev/`) is automatically isolated from prod — never
 *  hardcode `~/.agent-tempo`. */
export const LAST_EXIT_PATH = path.join(AGENT_TEMPO_HOME, 'daemon.last-exit.json');

/**
 * `daemon.last-exit.json` — the wire shape. `schemaVersion` bumps ONLY on a
 * removed/renamed/retyped REQUIRED field (snapshot-v1.ts convention);
 * additive optional fields never bump it.
 */
export interface DaemonLastExit {
  schemaVersion: 1;

  /** Coarse cause bucket — closed enum so the CLI notice can render a
   *  specific, actionable line per reason instead of a generic message. */
  reason:
    | 'worker-give-up'        // worker supervisor exhausted its restart budget (PR-D)
    | 'boot-guard-refused'    // search-attribute / #786 protocol-guard refusal
    | 'unhandled-fatal'       // top-level main().catch()
    | 'drain-timeout'         // the 15s hardExit safety-net timer fired
    | 'stale-pid-unexplained'; // CLI found a dead PID with no self-written marker

  /** Which worker died, when `reason === 'worker-give-up'`. Single value —
   *  FIRST-to-die wins on a genuine dual give-up (architect ruling §Q2): a
   *  shared-Temporal-outage never produces a give-up at all (connect/create
   *  failures reconnect indefinitely per ruling §2 Q1), so a real dual
   *  give-up is two independent poison workloads; the first is causal, a
   *  second write during teardown is likely collateral — and first-writer-
   *  wins already excludes it from ever landing here. */
  worker?: 'shared' | 'host';

  /** Restart attempts made before giving up. 0 for reasons that don't retry
   *  (e.g. boot-guard-refused fires on the first attempt; stale-pid-unexplained
   *  has no attempt count to report). */
  restarts: number;

  /** ISO-8601 UTC timestamp of the exit (or of CLI detection, for
   *  stale-pid-unexplained — the best available signal in that case). */
  at: string;

  /** PID of the process that died. Lets the reader sanity-check against a
   *  (possibly already-replaced) daemon.pid. */
  pid: number;

  /** Free-text tail of the fatal error, if one was captured. Truncated to
   *  ~2KB by the writer — this is a human-readable breadcrumb, not a
   *  structured payload; keep the file small and diff-friendly. */
  lastFatalMessage?: string;

  /**
   * mtime of `daemon.heartbeat` at the moment of writing, ISO-8601 UTC.
   * This is what makes "daemon was down for ~Xh" computable at all —
   * `bootedAt` alone gives uptime-before-death, not downtime-after.
   *
   * LOAD-BEARING WRITE-SITE CONSTRAINT: the daemon truncates
   * `daemon.heartbeat` on its OWN next boot (src/daemon.ts, `fs.writeFileSync
   * (DAEMON_HEARTBEAT_PATH, '')`), destroying the mtime. The CLI's
   * stale-pid-unexplained writer MUST capture this at stale-PID-detection
   * time — inside `getDaemonStatus()`, before `startDaemon()` boots the
   * replacement — never in the later notice-display path, by which point
   * the number is already gone.
   */
  lastHeartbeatAt?: string;

  /** ISO-8601 UTC timestamp of the daemon's own boot that then died. Gives
   *  uptime-before-death as a secondary, complementary number to
   *  `lastHeartbeatAt`'s downtime-after. Optional — the CLI's
   *  stale-pid-unexplained write has no clean handoff from the dead process
   *  to know this. */
  bootedAt?: string;

  /** agent-tempo package version of the process that died. Answers "did the
   *  upgrade fix it" for free on the next CLI invocation's notice. */
  version?: string;
}

const MAX_FATAL_MESSAGE_LEN = 2048;

/** Synchronous blocking sleep via `Atomics.wait` — usable from contexts
 *  (uncaughtException handlers, the hardExit safety-net timer) where an
 *  awaited async write would never flush before `process.exit()`. */
function sleepSync(ms: number): void {
  if (ms <= 0) return;
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

/** Retry codes + backoffs mirroring `writePidFileAtomic` (src/daemon.ts),
 *  but synchronous — same Windows AV-scanner-holds-a-handle rationale. */
const RETRYABLE_CODES = new Set(['EPERM', 'EBUSY', 'EACCES']);
const RETRY_BACKOFFS_MS = [10, 20, 40, 80];

/**
 * Atomic, synchronous, first-writer-wins write of the last-exit marker.
 *
 * No-ops silently if a marker already exists — this is the enforcement
 * point for "first writer wins" (architect ruling §Q2 + the two-writer-race
 * fix): whichever of the daemon's own give-up path or the CLI's
 * stale-pid-unexplained fallback observes the death FIRST owns the
 * forensic record; the other must not clobber it.
 *
 * MECHANISM (QA finding on #934 gate 2 — fixed here, before PR-D's
 * daemon-side writers land and create the first genuine two-process race):
 * write the full payload to a `.tmp.<pid>` file, then commit it into place
 * with `fs.linkSync(tmp, filePath)` — a hardlink is an atomic,
 * **exclusive** operation that fails with `EEXIST` if `filePath` already
 * exists. This is deliberately NOT `fs.renameSync`, which unconditionally
 * REPLACES its target — an earlier revision used rename and was a
 * check-then-act race (`existsSync` then `renameSync`): two genuinely
 * concurrent writers could both pass the `existsSync` check before either
 * renamed, and since rename always wins, the actual winner would be
 * "whoever renamed last," not "whoever wrote first." `linkSync` closes
 * that gap — the OS itself refuses the second writer's commit.
 *
 * Never throws — a failure to write the marker (disk full, permissions)
 * must not block whatever exit/cleanup path called this. Logged via the
 * caller's own logger if desired (this module stays log-sink-agnostic to
 * keep it dependency-light); check the return value if you want to know
 * whether the write actually landed.
 *
 * @param filePath Test seam — defaults to {@link LAST_EXIT_PATH}. Production
 *   callers omit this.
 * @returns `true` if this call wrote the marker, `false` if one already
 *   existed (first-writer-wins no-op) or the write failed.
 */
export function writeLastExitSync(
  marker: Omit<DaemonLastExit, 'schemaVersion'>,
  filePath: string = LAST_EXIT_PATH,
): boolean {
  const payload: DaemonLastExit = {
    schemaVersion: 1,
    ...marker,
    lastFatalMessage: marker.lastFatalMessage?.slice(0, MAX_FATAL_MESSAGE_LEN),
  };

  let tmp: string;
  try {
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    tmp = `${filePath}.tmp.${process.pid}`;
    fs.writeFileSync(tmp, JSON.stringify(payload));
  } catch {
    return false;
  }

  for (let attempt = 0; attempt <= RETRY_BACKOFFS_MS.length; attempt++) {
    try {
      // Atomic exclusive commit — fails EEXIST if another writer already
      // committed. The tmp file's content now also lives at `filePath` (two
      // hardlinks, same inode); unlinking `tmp` just drops the extra name.
      fs.linkSync(tmp, filePath);
      try { fs.unlinkSync(tmp); } catch { /* best-effort — filePath already has the content */ }
      return true;
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      if (code === 'EEXIST') {
        // First-writer-wins: someone else's marker already landed. NOT a
        // failure — this is the expected, load-bearing outcome for the
        // CLI's generic fallback racing a daemon-authored write.
        try { fs.unlinkSync(tmp); } catch { /* ignore */ }
        return false;
      }
      if (!code || !RETRYABLE_CODES.has(code) || attempt === RETRY_BACKOFFS_MS.length) {
        try { fs.unlinkSync(tmp); } catch { /* ignore */ }
        return false;
      }
      sleepSync(RETRY_BACKOFFS_MS[attempt]);
    }
  }
  try { fs.unlinkSync(tmp); } catch { /* ignore */ }
  return false;
}

/**
 * Read the marker (if any), then delete it.
 *
 * ATOMICITY NOTE (QA finding on #934 gate 3): this is read-THEN-unlink, not
 * claim-then-read — there is no lock. Two CLI invocations racing (two
 * terminals, or a script firing two `agent-tempo` commands back to back)
 * can both `readFileSync` the same marker before either unlinks it, so the
 * notice can print **more than once**. It cannot print **zero** times for
 * an existing marker (a read always succeeds before either side deletes),
 * so the actual guarantee is "at-least-once, usually exactly-once" — not
 * the strict one-shot the name implies. This is tolerated, not a bug: it
 * never throws, never corrupts, and self-heals within one extra CLI
 * invocation. If exactly-once ever becomes load-bearing, the fix is to
 * `renameSync` the marker to a per-pid claim path first and have only the
 * renaming process read/report — mirrors the write side's own
 * `linkSync`-based exclusivity.
 *
 * NEVER throws: a malformed file, an unreadable file, or an unrecognized
 * `schemaVersion` all degrade to "nothing to report" rather than bricking
 * the CLI invocation that called this. This is a hard requirement
 * (architect ruling §Q1) — the crash-notice path runs on EVERY CLI
 * invocation via `ensureInfra()`, so a single malformed marker must never
 * be able to break every verb.
 *
 * Delete is best-effort — a failure to delete (Windows EPERM from a
 * lingering handle) is swallowed rather than thrown; the notice may repeat
 * on a subsequent invocation, which is a far better failure mode than
 * crashing the CLI.
 *
 * @param filePath Test seam — defaults to {@link LAST_EXIT_PATH}. Production
 *   callers omit this.
 */
export function readAndClearLastExit(filePath: string = LAST_EXIT_PATH): DaemonLastExit | null {
  let marker: DaemonLastExit | null = null;
  try {
    const raw = fs.readFileSync(filePath, 'utf8');
    const parsed = JSON.parse(raw);
    if (parsed && typeof parsed === 'object' && parsed.schemaVersion === 1) {
      marker = parsed as DaemonLastExit;
    }
  } catch {
    // Missing file, unreadable, or malformed JSON — nothing to report.
    marker = null;
  }

  try { fs.unlinkSync(filePath); } catch { /* best-effort; tolerate EPERM etc. */ }

  return marker;
}
