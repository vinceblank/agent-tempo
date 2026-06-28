/**
 * Test helpers for agent-tempo workflow tests.
 *
 * **Shared TestWorkflowEnvironment (#210 Phase 1)**:
 * Environment creation is process-wide singleton. The first `setupTestEnv()`
 * call builds a `TestWorkflowEnvironment`; subsequent calls reuse it and only
 * re-seed a per-file random ensemble prefix (`test-ensemble-<suffix>`). The
 * real teardown runs once at process exit via the global `after` hook in
 * `test/root-hooks.ts`; per-file `after()` / `teardownTestEnv()` calls are
 * no-ops in shared mode.
 *
 * Auto-namespacing: `playerMetadata()` / `conductorMetadata()` default
 * `ensemble` to the per-file random prefix, so the 8+ test files that just
 * call `playerMetadata()` without overriding ensemble automatically get
 * their own isolated namespace under the shared env — no per-test edits.
 *
 * Fallback: set `TEMPO_TEST_ISOLATED=1` to restore per-file environments
 * (each file creates + tears down its own env). Useful when debugging a
 * flake you suspect is a cross-file state leak.
 */
import { TestWorkflowEnvironment } from '@temporalio/testing';
import { Worker } from '@temporalio/worker';
import { Client, WorkflowHandle, WorkflowIdConflictPolicy } from '@temporalio/client';
import { execFileSync } from 'child_process';
import * as path from 'path';
import * as fs from 'fs';
import * as os from 'os';
import * as crypto from 'crypto';
import { SessionInput, SessionMetadata, MaestroPlayerInfo } from '../src/types';
import {
  receiveMessageSignal,
  setPartSignal,
  setNameSignal,
  markDeliveredSignal,
  recordSentMessageSignal,
  updateMetadataSignal,
  getPartQuery,
  getMetadataQuery,
  pendingMessagesQuery,
  allMessagesQuery,
  allSentMessagesQuery,
  commandSignal,
  playerReportSignal,
  historyQuery,
  submitOutboxUpdate,
  outboxQuery,
  setQualityGateSignal,
  evaluateGateCriteriaSignal,
  qualityGatesQuery,
  setWorktreeSignal,
  removeWorktreeSignal,
  worktreesQuery,
  processingStartUpdate,
  processingEndUpdate,
  inFlightMessagesQuery,
  destroyUpdate,
  isDestroyedQuery,
  attachmentInfoQuery,
  claimAttachmentUpdate,
  forceDetachUpdate,
  adapterExitedSignal,
} from '../src/workflows/signals';

// Re-export signals/queries for convenience in test files
export {
  receiveMessageSignal,
  setPartSignal,
  setNameSignal,
  markDeliveredSignal,
  recordSentMessageSignal,
  updateMetadataSignal,
  getPartQuery,
  getMetadataQuery,
  pendingMessagesQuery,
  allMessagesQuery,
  allSentMessagesQuery,
  commandSignal,
  playerReportSignal,
  historyQuery,
  submitOutboxUpdate,
  outboxQuery,
  setQualityGateSignal,
  evaluateGateCriteriaSignal,
  qualityGatesQuery,
  setWorktreeSignal,
  removeWorktreeSignal,
  worktreesQuery,
  processingStartUpdate,
  processingEndUpdate,
  inFlightMessagesQuery,
  destroyUpdate,
  isDestroyedQuery,
  attachmentInfoQuery,
  claimAttachmentUpdate,
  forceDetachUpdate,
  adapterExitedSignal,
};

// Re-export PROTOCOL_VERSION so test files can import it alongside
// claimAttachmentUpdate (claimAttachment requires it as of #786 part 1).
export { PROTOCOL_VERSION } from '../src/constants';

// ─────────────────────────────────────────────────────────────────────────
// Reap orphan temporal-sdk-typescript ephemeral servers from prior crashed
// runs. Wired into Mocha as a global setup fixture from `root-hooks.ts`
// (helpers.ts is `require`d before Mocha installs BDD globals, so the
// hook itself can't live here — only the function it calls).
//
// Symptom: every `setupTestEnv` after the crash fails with
//   `Failed to start ephemeral server: Access is denied. (os error 5)`
// because the dead-but-still-running server still holds the spawn lock.
// (Observed Apr 19 — two zombies sat for a week before anyone noticed.)
//
// Filter is keyed on the binary name (`temporal-sdk-typescript`) so we
// never touch any other process. Failures are non-fatal — a cleanup hiccup
// must not block the suite from starting.
// ─────────────────────────────────────────────────────────────────────────
function findOrphanTemporalServers(): number[] {
  if (process.platform === 'win32') {
    // tasklist /FO CSV /NH /FI "IMAGENAME eq temporal-sdk-typescript*"
    const out = execFileSync(
      'tasklist',
      ['/FO', 'CSV', '/NH', '/FI', 'IMAGENAME eq temporal-sdk-typescript*'],
      { encoding: 'utf-8' },
    );
    const pids: number[] = [];
    for (const line of out.split(/\r?\n/)) {
      if (!line.trim()) continue;
      const cells = line.split(',').map((c) => c.replace(/^"|"$/g, ''));
      if (cells.length < 2) continue;
      const name = cells[0];
      const pid = Number(cells[1]);
      // Belt-and-suspenders: tasklist's filter is fuzzy on some Windows
      // builds — re-check the binary name client-side.
      if (Number.isFinite(pid) && name.startsWith('temporal-sdk-typescript')) {
        pids.push(pid);
      }
    }
    return pids;
  }
  // POSIX (macOS, Linux): pgrep returns exit 1 when no matches, which
  // execFileSync surfaces as a thrown error. That's the no-orphans case,
  // not a failure.
  try {
    const out = execFileSync('pgrep', ['-f', 'temporal-sdk-typescript'], { encoding: 'utf-8' });
    return out
      .split(/\r?\n/)
      .map((s) => Number(s.trim()))
      .filter((n) => Number.isFinite(n) && n > 0);
  } catch {
    return [];
  }
}

/**
 * Synchronous reap, suitable for `process.on('exit')` handlers (which
 * can't await). Returns the PIDs that were successfully killed so callers
 * can log/report. Never throws — a failed reap must not block exit.
 *
 * Implementation note: `process.kill(pid, 'SIGKILL')` is synchronous on
 * both POSIX and Windows (Node maps it to `TerminateProcess` on Win),
 * and `execFileSync` is — by definition — synchronous. So the whole loop
 * runs to completion before `process.on('exit')` returns.
 */
function reapOrphanTemporalServersSync(): number[] {
  const reaped: number[] = [];
  let pids: number[] = [];
  try {
    pids = findOrphanTemporalServers();
  } catch {
    return reaped;
  }
  for (const pid of pids) {
    try {
      process.kill(pid, 'SIGKILL');
      reaped.push(pid);
    } catch {
      // Already dead, perms denied, etc. Try Windows taskkill /F as a
      // last-resort fallback before giving up on this PID.
      if (process.platform === 'win32') {
        try {
          execFileSync('taskkill', ['/PID', String(pid), '/F'], { stdio: 'ignore' });
          reaped.push(pid);
          continue;
        } catch {
          /* give up on this pid; loop continues */
        }
      }
      // Don't warn from sync reap — the exit handler runs in contexts
      // (e.g. SIGINT during teardown) where stderr writes can race the
      // shutdown. The async wrapper below logs the per-pid attempt.
    }
  }
  return reaped;
}

/**
 * Kill any pre-existing `temporal-sdk-typescript-*` processes that survived
 * a prior crashed Mocha run, OR any leftover spawned by the current run that
 * haven't been torn down yet. Called from:
 *   - `mochaGlobalSetup` (pre-suite — clears prior crashes)
 *   - `mochaGlobalTeardown` (post-suite — clears normal-exit leftovers)
 *
 * Never throws — a failed reap must not block the test suite from starting
 * or finishing.
 */
/**
 * A `temporal-sdk-typescript-*.downloading` lock older than this is an orphaned
 * extraction (a crashed/killed prior run) and is safe to remove. Anything
 * younger may be an ACTIVE download by a concurrent shard on the same machine —
 * left untouched. The SDK's own download-acquire wait is ~90s, so a 2-minute
 * floor comfortably exceeds any legitimate in-progress download.
 */
const STALE_DOWNLOAD_LOCK_MS = 2 * 60 * 1000;

/**
 * Remove stale `temporal-sdk-typescript-*.downloading` lock files left in the OS
 * temp dir by a crashed/killed binary extraction (#694 symptom 1/3 defense).
 *
 * When a prior run dies mid-download, the `.downloading` lock lingers; the NEXT
 * acquirer blocks on it (the SDK waits ~90s for the lock to clear, but the local
 * `createLocal` retry's ~20s window times out first → an "Access is denied" /
 * server-start flake). Clearing orphaned locks at suite start closes that window.
 *
 * Age-gated (see {@link STALE_DOWNLOAD_LOCK_MS}) so a concurrent shard's active
 * download is never disturbed. Never throws — a cleanup hiccup must not block the
 * suite from starting or finishing.
 */
function reapStaleTemporalDownloadLocks(): void {
  const dir = os.tmpdir();
  let entries: string[];
  try {
    entries = fs.readdirSync(dir);
  } catch {
    return; // tmpdir unreadable — nothing we can (or should) do
  }
  const now = Date.now();
  for (const name of entries) {
    if (!/^temporal-sdk-typescript-.*\.downloading$/.test(name)) continue;
    const full = path.join(dir, name);
    try {
      const age = now - fs.statSync(full).mtimeMs;
      if (age < STALE_DOWNLOAD_LOCK_MS) continue; // possibly an active download — leave it
      fs.rmSync(full, { force: true });
      console.log(
        `[test:cleanup] removed stale temporal download lock: ${name} ` +
        `(age ${Math.round(age / 1000)}s)`,
      );
    } catch {
      /* racing another reaper / perms / vanished — non-fatal */
    }
  }
}

export async function reapOrphanTemporalServers(): Promise<void> {
  // #694 — clear orphaned `.downloading` extraction locks before reaping orphan
  // server processes, so a stale lock from a crashed run can't wedge the next
  // ephemeral-server start.
  reapStaleTemporalDownloadLocks();
  try {
    const pids = findOrphanTemporalServers();
    if (pids.length === 0) return;
    console.log(
      `[test:cleanup] reaping ${pids.length} orphan temporal-sdk-typescript ` +
      `process(es): ${pids.join(', ')}`,
    );
    for (const pid of pids) {
      try {
        process.kill(pid, 'SIGKILL');
      } catch (err) {
        // Already dead, perms denied, etc. Try Windows taskkill /F as a
        // last-resort fallback before giving up on this PID.
        if (process.platform === 'win32') {
          try {
            execFileSync('taskkill', ['/PID', String(pid), '/F'], { stdio: 'ignore' });
            continue;
          } catch {
            /* fall through to warn */
          }
        }
        console.warn(`[test:cleanup] failed to kill PID ${pid}:`, err);
      }
    }
  } catch (err) {
    console.warn('[test:cleanup] orphan reap failed (non-fatal):', err);
  }
}

// ─────────────────────────────────────────────────────────────────────────
// v2: last-ditch zombie reaper for crash exits + SIGINT/SIGTERM (#306).
//
// v1 (`fa3a96d`) reaps only BEFORE the suite. If a test crashes mid-flow
// or `teardown()` is skipped — the exact "Failed to start ephemeral
// server: Access is denied. (os error 5)" failure mode that blocked the
// full Mocha suite during #306 smoke-testing — fresh ephemerals from THIS
// run orphan and the next `npm test` invocation hits the same wall until
// the next pre-suite reap fires.
//
// v2 closes the gap: register `process.on('exit')` so any exit path that
// reaches Node's normal teardown (clean exit, `process.exit()`, unhandled
// exception, mocha's signal-handler chain calling exit) reaps zombies
// synchronously before the process is reaped itself. SIGINT/SIGTERM
// listeners are belt-and-suspenders for the case where mocha doesn't
// install its own — they reap then call `process.exit()` with the
// canonical signal exit code.
//
// SIGKILL is the irreducible gap: by OS contract, no userland handler
// runs. The pre-suite reap (v1, kept) catches those leftovers next run.
//
// Gated to Windows because POSIX doesn't hit the spawn-lock bug — the
// reap is harmless there but the registration is unnecessary noise.
// ─────────────────────────────────────────────────────────────────────────
let zombieReaperInstalled = false;

/**
 * Install last-ditch process-exit handlers that reap orphan
 * `temporal-sdk-typescript-*` zombies synchronously. Idempotent — repeat
 * calls are no-ops. Called once from `mochaGlobalSetup` in
 * `test/root-hooks.ts`.
 *
 * No-op on POSIX (`process.platform !== 'win32'`).
 */
export function installTemporalZombieReaper(): void {
  if (zombieReaperInstalled) return;
  zombieReaperInstalled = true;
  if (process.platform !== 'win32') return;

  // `exit` — synchronous, runs on clean exit + `process.exit()` +
  // unhandled exception + mocha-driven signal handlers that call exit.
  // Sync reap is the right shape: handlers can't await.
  process.on('exit', () => {
    try {
      const reaped = reapOrphanTemporalServersSync();
      if (reaped.length > 0) {
        console.log(
          `[test:cleanup] exit handler reaped ${reaped.length} ` +
          `temporal-sdk-typescript zombie(s): ${reaped.join(', ')}`,
        );
      }
    } catch {
      /* swallow — process is already exiting */
    }
  });

  // SIGINT / SIGTERM — defensive. Mocha typically installs its own
  // SIGINT handler that triggers a graceful test abort + `process.exit`,
  // which our `exit` handler above catches. These run BEFORE mocha's
  // chain (Node fires listeners in registration order — we register at
  // suite setup, mocha at run start), so we reap first then re-emit
  // `process.exit` with the canonical exit code so any later listener
  // sees a definitively-terminating process.
  for (const sig of ['SIGINT', 'SIGTERM'] as const) {
    process.on(sig, () => {
      try {
        const reaped = reapOrphanTemporalServersSync();
        if (reaped.length > 0) {
          console.log(
            `[test:cleanup] ${sig} reaped ${reaped.length} ` +
            `temporal-sdk-typescript zombie(s): ${reaped.join(', ')}`,
          );
        }
      } catch {
        /* swallow — we're shutting down */
      }
      // POSIX-canonical signal exit codes (128 + signal number).
      process.exit(sig === 'SIGINT' ? 130 : 143);
    });
  }
}

let testEnv: TestWorkflowEnvironment | undefined;
let workflowBundle: { code: string } | undefined;

/** Opt-out switch — each `setupTestEnv` re-creates a fresh env when set. */
const ISOLATED_MODE = process.env.TEMPO_TEST_ISOLATED === '1';

/**
 * Per-file random ensemble prefix. Re-seeded at every `setupTestEnv()` call
 * (which Mocha invokes once per test file's top-level `before()` hook). Under
 * shared env this gives each file its own workflow-ID namespace without any
 * per-test edits. Default falls back to the pre-#210 literal for defensive
 * safety if someone imports and uses `playerMetadata()` without calling
 * `setupTestEnv()` first.
 */
let currentEnsemblePrefix = 'test-ensemble';

/**
 * The prefix derived by the most recent `setupTestEnv()` invocation. Exposed
 * for tests that need to build their own IDs with the same namespace (e.g.
 * `agent-session-${getTestEnsemble()}-custom-id`).
 */
export function getTestEnsemble(): string {
  return currentEnsemblePrefix;
}

/** Base prefix for every minted test task queue. */
const TASK_QUEUE_BASE = 'test-agent-tempo';

/**
 * #721 — the CURRENT per-worker task queue, as a **live binding**.
 *
 * Every `withWorker*` helper (and `startWorkerPair`) mints a fresh
 * process-unique queue via {@link mintTaskQueue} before creating its
 * worker(s), so no two worker creations in the same process ever share a
 * SlotKey — structurally eliminating the Rust core-bridge slot-release race
 * (#642) that `createWorkerWithSlotRetry` only papers over.
 *
 * Tests compile to CommonJS (`dist-test/`), so importers read
 * `helpers_1.TASK_QUEUE` at every use site — `taskQueue: TASK_QUEUE` inside a
 * `withWorker` callback always resolves to the queue that callback's worker
 * is polling, with zero call-site edits.
 *
 * **SERIAL-WITHWORKER CONSTRAINT (#721)**: this mutable module global is
 * safe because no two `withWorker*` invocations ever run concurrently
 * WITHIN one process — no `Promise.all`/`allSettled` wraps a `withWorker*`
 * call anywhere in `test/` (standing invariant, enforced by
 * `tests/conformance/serial-withworker-fence.test.ts`). Note the precise
 * boundary: parallel-Mocha with per-FILE worker processes would be safe
 * as-is (module state is per-process); only INTRA-process concurrent
 * `withWorker*` calls are forbidden — concurrent mints would make live-
 * binding reads timing-dependent.
 *
 * Initial value is the pre-#721 literal as a defensive fallback for any read
 * before the first `setupTestEnv()`/`withWorker*` call.
 */
export let TASK_QUEUE = TASK_QUEUE_BASE;

/** Monotonic counter — per-invocation uniqueness within the process. */
let taskQueueCounter = 0;

/**
 * Mint a fresh process-unique main task queue and publish it as the live
 * {@link TASK_QUEUE} binding. Called by `setupTestEnv()` (file granularity)
 * and at the entry of every worker-creating helper (invocation granularity).
 *
 * Shape: `test-agent-tempo-<fileHex>-<n>` — the per-file random suffix ties
 * Temporal-UI entries back to their test file; the counter isolates
 * consecutive `withWorker` calls within a file.
 *
 * Exported for tests that inline their own worker setup instead of going
 * through a `withWorker*` helper (e.g. `destroy.test.ts`'s capturing
 * variant) — they must mint too, or they'd reuse the previous mint and
 * race its just-released SlotKey without the retry backstop.
 */
export function mintTaskQueue(): string {
  taskQueueCounter += 1;
  const fileSuffix = currentEnsemblePrefix.replace(/^test-ensemble-/, '');
  TASK_QUEUE = `${TASK_QUEUE_BASE}-${fileSuffix}-${taskQueueCounter}`;
  return TASK_QUEUE;
}

/**
 * Per-host task queue for spawnProcess activities.
 * The workflow routes spawnProcess to `agent-tempo-{hostname}`.
 * Tests use hostname 'test-host', so the queue is `agent-tempo-test-host`.
 */
const HOST_TASK_QUEUE = 'agent-tempo-test-host';

/**
 * Locate the pre-built workflow bundle. `npm run build` must be run first.
 * We walk up from __dirname until we find `workflow-bundle.js` at the project root.
 */
function findWorkflowBundle(): string {
  let dir = __dirname;
  for (let i = 0; i < 5; i++) {
    const candidate = path.join(dir, 'workflow-bundle.js');
    if (fs.existsSync(candidate)) return candidate;
    dir = path.dirname(dir);
  }
  throw new Error(
    'workflow-bundle.js not found. Run `npm run build` before running tests.',
  );
}

// ── createLocal retry helper (#150) ─────────────────────────────────────
//
// On Windows, `TestWorkflowEnvironment.createLocal()` periodically fails with
// `Failed to start ephemeral server: Access is denied. (os error 5)`. The
// underlying causes are intermittent and out-of-process:
//
//   1. **Orphan PID from a crashed prior run** — the .exe at
//      `%TEMP%\temporal-sdk-typescript-<version>.exe` is still memory-mapped,
//      blocking re-spawn. #312's `mochaGlobalSetup` reap mostly handles this,
//      but a force-killed-mid-extraction prior run can leave a fresh orphan
//      between the reap and the create call.
//   2. **Windows Defender real-time scan** — AV locks the freshly-extracted
//      .exe for 100 ms – 2 s during scan; spawn during the lock window
//      throws EACCES.
//   3. **Stale OS file handle** — Windows holds the .exe open as a memory-
//      mapped image until the kernel reclaims; another process trying to
//      overwrite/spawn gets EACCES until that happens.
//
// All three are transient. Wrapping the create call with a retry loop +
// EACCES-triggered orphan reap covers (1) and (2) cheaply, and lets (3)
// resolve naturally during backoff. Defaults: 3 attempts, exponential
// backoff (1 s / 2 s / 4 s) plus 0–200 ms jitter. The retry surfaces every
// failed attempt as a `[test:setupTestEnv]` log line so flakes are
// observable in CI.

const RETRY_DEFAULT_ATTEMPTS = 3;
const RETRY_DEFAULT_BASE_MS = 1_000;
const RETRY_DEFAULT_FACTOR = 2;
const RETRY_DEFAULT_JITTER_MS = 200;

/**
 * Errors that match this regex trigger an orphan reap before the retry.
 * Specifically the Rust core bridge's "Failed to start ephemeral server:
 * Access is denied. (os error 5)" — but tolerant to phrasing drift across
 * `@temporalio/testing` versions.
 */
const ACCESS_DENIED_RE = /access is denied|os error 5\b/i;

export interface CreateLocalRetryOpts {
  attempts?: number;
  baseDelayMs?: number;
  factor?: number;
  jitterMs?: number;
  /** Dep injection — production passes `TestWorkflowEnvironment.createLocal`. */
  create?: (
    opts?: Parameters<typeof TestWorkflowEnvironment.createLocal>[0],
  ) => Promise<TestWorkflowEnvironment>;
  /** Dep injection — production passes `reapOrphanTemporalServers`. */
  reapOrphans?: () => Promise<void>;
  /** Dep injection — production uses `setTimeout`. */
  sleep?: (ms: number) => Promise<void>;
  /** Dep injection — production uses `console.error`. */
  log?: (msg: string) => void;
  /** Deterministic jitter for tests; defaults to `Math.random`. */
  random?: () => number;
}

function isAccessDeniedError(err: unknown): boolean {
  const msg = err instanceof Error ? err.message : String(err);
  return ACCESS_DENIED_RE.test(msg);
}

/**
 * Retry-wrapped `TestWorkflowEnvironment.createLocal`. Exported for unit
 * testing (`test/setup-retry.test.ts`). Production callers use
 * {@link setupTestEnv}.
 *
 * Resolves with the env on first success. Rejects with the last attempt's
 * error if all attempts fail.
 */
export async function createLocalWithRetry(
  envOpts: Parameters<typeof TestWorkflowEnvironment.createLocal>[0],
  retryOpts: CreateLocalRetryOpts = {},
): Promise<TestWorkflowEnvironment> {
  const attempts = retryOpts.attempts ?? RETRY_DEFAULT_ATTEMPTS;
  const baseMs = retryOpts.baseDelayMs ?? RETRY_DEFAULT_BASE_MS;
  const factor = retryOpts.factor ?? RETRY_DEFAULT_FACTOR;
  const jitterMs = retryOpts.jitterMs ?? RETRY_DEFAULT_JITTER_MS;
  const create = retryOpts.create
    ?? ((o) => TestWorkflowEnvironment.createLocal(o));
  const reap = retryOpts.reapOrphans ?? reapOrphanTemporalServers;
  const sleep = retryOpts.sleep
    ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const log = retryOpts.log ?? ((m: string) => console.error(m));
  const random = retryOpts.random ?? Math.random;

  let lastErr: unknown;
  for (let i = 0; i < attempts; i++) {
    try {
      const env = await create(envOpts);
      if (i > 0) {
        log(`[test:setupTestEnv] succeeded on attempt ${i + 1}/${attempts}`);
      }
      return env;
    } catch (err) {
      lastErr = err;
      const isLast = i === attempts - 1;
      const reason = err instanceof Error ? err.message : String(err);
      const isEACCES = isAccessDeniedError(err);
      log(
        `[test:setupTestEnv] attempt ${i + 1}/${attempts} failed: ${reason}` +
        (isLast ? '' : isEACCES ? '; reaping orphans + retrying' : '; retrying'),
      );
      if (isLast) break;

      // EACCES — orphan PID is the most likely cause. Reap before sleeping
      // so the next attempt sees a clean process table. Non-fatal: a reap
      // failure shouldn't block the retry path.
      if (isEACCES) {
        try {
          await reap();
        } catch (reapErr) {
          log(
            `[test:setupTestEnv] reap during retry failed (non-fatal): ` +
            (reapErr instanceof Error ? reapErr.message : String(reapErr)),
          );
        }
      }

      const backoff = baseMs * Math.pow(factor, i);
      const jitter = jitterMs > 0 ? Math.floor(random() * jitterMs) : 0;
      await sleep(backoff + jitter);
    }
  }
  throw lastErr;
}

/** Test-only — exposed for the unit test's exhaustive failure-path coverage. */
export const _ACCESS_DENIED_RE = ACCESS_DENIED_RE;
export const _isAccessDeniedError = isAccessDeniedError;

// ── #642: worker-slot-overlap retry ──────────────────────────────────────
//
// Under CPU starvation (a busy multi-process box) the Rust core bridge's
// SlotKey release LAGS past the prior worker's run-promise resolution, so the
// next describe's `Worker.create` races the not-yet-released slot and throws
// "Registration of multiple workers with overlapping worker task types …".
// It's a within-process timing race on the SHARED env's fixed task queue — NOT
// a real conflict — so a short backoff rides out exactly that release lag. We
// retry ONLY this signature and RETHROW everything else immediately so genuine
// worker-init failures are never masked. (Researcher-pinned root cause, #642.)

// #694 symptom 2 (beta.4 band-aid) — budget bumped 4→6 attempts / 100→200ms base
// per QA's diagnosis. Old max wait ~900ms (100+200+400+jitter); new max ~6.6s
// (200+400+800+1600+3200 + jitter×5) — covers the Rust-bridge slot-release lag on
// a loaded Windows runner.
//
// #721 landed the structural fix for the MAIN queue (unique mint per
// withWorker) — this retry is now the HOST-QUEUE BACKSTOP only (the shared
// `agent-tempo-test-host` queue still carries the #642 race). Do NOT retire
// it before #772 (per-test unique host queues) lands + the CI soak there
// passes.
const SLOT_RETRY_DEFAULT_ATTEMPTS = 6;
const SLOT_RETRY_DEFAULT_BASE_MS = 200;
const SLOT_RETRY_DEFAULT_FACTOR = 2;
const SLOT_RETRY_DEFAULT_JITTER_MS = 100;

/**
 * #694 symptom 2 — post-`runUntil` slot-release barrier (~20ms wall-clock).
 *
 * After a worker reaches STOPPED, the Rust core bridge's Tokio runtime releases
 * the SlotKey on ANOTHER thread — so a `setImmediate`/microtask (one Node
 * event-loop cycle) is NOT enough; a real wall-clock delay is required to let the
 * cross-thread deallocation land before the next `Worker.create` on the same task
 * queue. 20ms also clears the Windows timer resolution (~15ms) with margin. The
 * `withWorker*` helpers await this right after their `runUntil` resolves, so the
 * NEXT caller's create is far less likely to race the not-yet-released slot (the
 * retry above is the backstop). ~223 withWorker calls × 20ms ≈ 4.5s/shard —
 * negligible vs. total test runtime. Not injectable: always wanted post-shutdown.
 *
 * Post-#721 the main queue is minted unique per withWorker, so this barrier
 * serves the shared HOST queue (`agent-tempo-test-host`) only. Do NOT retire
 * before #772 lands + its CI soak passes.
 */
const SLOT_RELEASE_BARRIER_MS = 20;
async function awaitWorkerSlotRelease(): Promise<void> {
  await new Promise<void>((resolve) => setTimeout(resolve, SLOT_RELEASE_BARRIER_MS));
}

/**
 * Run `fn` under `worker` (`worker.runUntil`), then await the slot-release
 * barrier before resolving — the single shared definition every `withWorker*`
 * helper routes through, so the post-`runUntil` barrier is applied uniformly
 * (#694 symptom 2). `runUntil` already awaits the full STOPPED transition; the
 * barrier just follows it, on the success path (a rejecting `fn` propagates
 * immediately — that test is already failing, and the next create still has the
 * widened slot-retry as its backstop).
 */
export async function runWorkerUntil<T>(worker: Worker, fn: () => Promise<T>): Promise<T> {
  const result = await worker.runUntil(fn);
  await awaitWorkerSlotRelease();
  return result;
}

/**
 * The pre-built workflow bundle loaded by `setupTestEnv` — exported (#760)
 * so test files composing their own worker with custom counting activity
 * stubs (e.g. test/maestro-chat-gate.test.ts) don't re-read the bundle.
 * Throws before `setupTestEnv` for the same fail-loud reason as
 * `requireTestEnv`.
 */
export function getWorkflowBundle(): { code: string } {
  if (!workflowBundle) {
    throw new Error('getWorkflowBundle() called before setupTestEnv()');
  }
  return workflowBundle;
}

/** The SlotKey-overlap signature — retryable. Tolerant to phrasing drift. */
const SLOT_OVERLAP_RE = /Registration of multiple workers with overlapping worker task types|SlotKey \{/;

function isSlotOverlapError(err: unknown): boolean {
  const msg = err instanceof Error ? err.message : String(err);
  return SLOT_OVERLAP_RE.test(msg);
}

export interface CreateWorkerRetryOpts {
  attempts?: number;
  baseDelayMs?: number;
  factor?: number;
  jitterMs?: number;
  /** Dep injection — production passes `Worker.create`. */
  create?: (opts: Parameters<typeof Worker.create>[0]) => Promise<Worker>;
  /** Dep injection — production uses `setTimeout`. */
  sleep?: (ms: number) => Promise<void>;
  /** Dep injection — production uses `console.error`. */
  log?: (msg: string) => void;
  /** Deterministic jitter for tests; defaults to `Math.random`. */
  random?: () => number;
}

/**
 * Retry-wrapped `Worker.create` (#642). Retries ONLY on the SlotKey-overlap
 * signature (the within-process slot-release lag under CPU starvation), with
 * exponential backoff + jitter; RETHROWS any other error immediately so real
 * worker-init failures surface unmasked. Exported for unit testing
 * (`test/worker-slot-retry.test.ts`); all `withWorker*` helpers call it.
 *
 * Host-queue backstop — see #772 before retiring (main-queue collisions are
 * structurally gone since #721's per-withWorker mint).
 *
 * Resolves with the worker on first success. Rejects with the last attempt's
 * error if every attempt hits the overlap.
 */
/**
 * ── STANDING RULE (#777, architect-adopted): poll budgets vs bounded waits ──
 *
 * Any polling/retry budget in a test must STRICTLY dominate — rule of thumb
 * ≥2× — the longest server-side timeout in the awaited path. Budget==timeout
 * EQUALITY is a flake generator: the awaited task recovers at exactly the
 * moment the assertion gives up. The #178→#181 lineage kept reintroducing
 * this shape (5s→10s "to absorb CI latency" landed precisely ON the 10s
 * sticky failover + workflowTaskTimeout defaults). Relevant bounds for test
 * workers: sticky failover 1s (below), workflowTaskTimeout 10s (SDK default)
 * — so transition-poll budgets should be ≥20s.
 */

/**
 * #777 — test-wide sticky-queue failover bound. The SDK default is 10s: a
 * workflow task dispatched to a worker's sticky queue that the worker misses
 * (worker churn — tests create one short-lived worker per `withWorker` — plus
 * CI CPU contention) sits server-side, SILENTLY, for the full
 * `stickyQueueScheduleToStartTimeout` before re-dispatch on the normal queue.
 * That 10s stall was exactly equal to `stages.test.ts`'s 10s `retry()`
 * budget, so any sticky miss failed the assertion at the precise moment the
 * task would have recovered ('waiting'≠'reported' / 'active'≠'failed' — the
 * #181-class flake, evidence on #777). 1s bounds the worst-case stall to
 * noise while keeping sticky-cache performance for the common hit path.
 * One choke point (the #721 philosophy): every test worker inherits it;
 * callers can still override via their own `workerOpts`.
 */
const STICKY_SCHEDULE_TO_START_TIMEOUT = '1s';

export async function createWorkerWithSlotRetry(
  workerOpts: Parameters<typeof Worker.create>[0],
  retryOpts: CreateWorkerRetryOpts = {},
): Promise<Worker> {
  // `shutdownGraceTime` bounds the graceful-drain window: after Worker.shutdown()
  // is called, in-flight activities get 2s to finish before being force-cancelled.
  // Without this, the drain is unbounded — on loaded CI runners where activity
  // tasks stall or retry, `worker.runUntil()` / `runWorkerUntil()` hangs forever.
  // 2s is generous for test stubs (which return immediately) and short enough to
  // keep the overall suite fast even if a stray activity is in-flight at teardown.
  workerOpts = {
    stickyQueueScheduleToStartTimeout: STICKY_SCHEDULE_TO_START_TIMEOUT,
    shutdownGraceTime: '2s',
    ...workerOpts,
  };
  const attempts = retryOpts.attempts ?? SLOT_RETRY_DEFAULT_ATTEMPTS;
  const baseMs = retryOpts.baseDelayMs ?? SLOT_RETRY_DEFAULT_BASE_MS;
  const factor = retryOpts.factor ?? SLOT_RETRY_DEFAULT_FACTOR;
  const jitterMs = retryOpts.jitterMs ?? SLOT_RETRY_DEFAULT_JITTER_MS;
  const create = retryOpts.create ?? ((o) => Worker.create(o));
  const sleep = retryOpts.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const log = retryOpts.log ?? ((m: string) => console.error(m));
  const random = retryOpts.random ?? Math.random;

  let lastErr: unknown;
  for (let i = 0; i < attempts; i++) {
    try {
      const worker = await create(workerOpts);
      if (i > 0) {
        log(`[test:createWorker] succeeded on attempt ${i + 1}/${attempts} (rode out slot-overlap lag)`);
      }
      return worker;
    } catch (err) {
      // Only the SlotKey-overlap race is retryable — rethrow everything else
      // immediately so a genuine worker-init failure is never masked by retries.
      if (!isSlotOverlapError(err)) throw err;
      lastErr = err;
      const isLast = i === attempts - 1;
      const reason = err instanceof Error ? err.message : String(err);
      log(
        `[test:createWorker] attempt ${i + 1}/${attempts} hit worker-slot overlap` +
        (isLast ? `: ${reason}` : '; retrying'),
      );
      if (isLast) break;
      const backoff = baseMs * Math.pow(factor, i);
      const jitter = jitterMs > 0 ? Math.floor(random() * jitterMs) : 0;
      await sleep(backoff + jitter);
    }
  }
  throw lastErr;
}

/** Test-only — exposed for the unit test's signature-match coverage. */
export const _SLOT_OVERLAP_RE = SLOT_OVERLAP_RE;
export const _isSlotOverlapError = isSlotOverlapError;

/**
 * Initialize the test environment. In shared mode (default), the first call
 * creates a process-wide `TestWorkflowEnvironment` that all subsequent test
 * files reuse; later calls only re-seed the per-file random ensemble prefix.
 * In isolated mode (`TEMPO_TEST_ISOLATED=1`), every call tears down the
 * previous env and builds a fresh one.
 *
 * Call from each test file's top-level `before()` hook — no change to the
 * existing calling convention.
 *
 * **#150 retry layer**: the underlying `createLocal` call is wrapped in
 * `createLocalWithRetry` to ride out transient Windows EACCES from
 * Defender scans + orphan PID locks. See {@link createLocalWithRetry}.
 */
export async function setupTestEnv(): Promise<void> {
  if (ISOLATED_MODE && testEnv) {
    await testEnv.teardown();
    testEnv = undefined;
    workflowBundle = undefined;
  }
  if (!testEnv) {
    // #694 symptom 4 — ATOMIC init. Load + read the workflow bundle FIRST, into a
    // local, BEFORE booting Temporal or assigning `testEnv`. The two module
    // globals (`testEnv`, `workflowBundle`) are then assigned together only after
    // BOTH succeed — so any failure leaves BOTH undefined and the next file's
    // `if (!testEnv)` re-runs init (failing loudly + repeatably) instead of
    // skipping it.
    //
    // The old order — assign `testEnv`, THEN load the bundle — left `testEnv` set
    // with `workflowBundle` undefined whenever the bundle was missing: every later
    // file saw `testEnv` truthy, skipped this block, and called `Worker.create`
    // with neither `workflowBundle` nor activities → the cascading, opaque
    // "task_types: At least one task type must be enabled in `task_types`" worker
    // error that masked the real cause. Loading the bundle first also means a
    // missing build fails BEFORE booting a Temporal env (nothing to leak/teardown).
    let loadedBundle: { code: string };
    try {
      loadedBundle = { code: fs.readFileSync(findWorkflowBundle(), 'utf-8') };
    } catch (err) {
      throw new Error(
        '[test:setupTestEnv] workflow-bundle.js is missing or unreadable — run `npm run build` ' +
        'before the tests (worktree builders need BOTH: `npm run build && npm run build:test`). ' +
        `Underlying: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
    const env = await createLocalWithRetry({
      server: {
        // Register custom search attributes at server startup.
        // `AgentTempoStatus` removed in v0.26 (#175 / #178).
        extraArgs: [
          '--search-attribute', 'AgentTempoEnsemble=Keyword',
          '--search-attribute', 'AgentTempoPlayerId=Keyword',
          '--search-attribute', 'AgentTempoHostname=Keyword',
          '--search-attribute', 'AgentTempoGitRoot=Keyword',
          '--search-attribute', 'AgentTempoPlayerType=Keyword',
          '--search-attribute', 'AgentTempoIsConductor=Bool',
          // v0.25 attachment lifecycle search attrs (§9, §11.2)
          '--search-attribute', 'AgentTempoAttachedHost=Keyword',
          '--search-attribute', 'AgentTempoAttachmentState=Keyword',
          '--search-attribute', 'AgentTempoAttachmentId=Keyword',
        ],
      },
    });
    // Commit both module globals together — atomic, after env + bundle succeeded.
    testEnv = env;
    workflowBundle = loadedBundle;
  }
  // #721 — terminate workflows leaked by prior files BEFORE this file runs.
  // Under per-worker unique queues a leaked Running workflow is pinned to a
  // queue no future worker will ever poll, so every later `resolveSession`
  // scan pays the full 2s `queryHandleWithTimeout` budget per leak when it
  // probes the leak's `getMetadata` (the pre-#721 shared queue let any live
  // worker serve those queries, masking the leaks). Server-side terminate
  // needs no worker; per-file random ensembles mean nothing legitimately
  // spans files.
  await sweepLeakedWorkflows();
  // Re-seed per-file suffix. Short hex keeps workflow IDs readable in Temporal UI.
  currentEnsemblePrefix = `test-ensemble-${crypto.randomBytes(4).toString('hex')}`;
  // #721 — re-mint so file-scope TASK_QUEUE reads (before the first
  // withWorker) already see this file's namespace, not the previous file's.
  mintTaskQueue();
}

/**
 * Best-effort terminate of every still-Running workflow in the shared env.
 * Called from `setupTestEnv()` at each file boundary (#721) — see the call
 * site for why leaks must not survive into the next file. Best-effort: a
 * workflow finishing between list and terminate, or a visibility hiccup,
 * must never fail a file's `before()` hook.
 */
async function sweepLeakedWorkflows(): Promise<void> {
  if (!testEnv) return;
  const client = testEnv.client;
  let swept = 0;
  try {
    for await (const wf of client.workflow.list({ query: 'ExecutionStatus = "Running"' })) {
      try {
        await client.workflow.getHandle(wf.workflowId).terminate('test harness per-file leak sweep (#721)');
        swept += 1;
      } catch {
        // Completed/terminated since listing — already gone, ignore.
      }
    }
  } catch {
    // Visibility scan failed — best-effort only; the file can still run.
  }
  if (swept > 0) {
    console.log(`[test:setupTestEnv] #721 leak sweep terminated ${swept} workflow(s) left Running by prior files`);
  }
}

/**
 * Drop-in replacement for the standard `before(async function () {
 * this.timeout(60_000); await setupTestEnv(); })` boilerplate that ~32 test
 * files repeat verbatim. Bumps the hook timeout to **120 s** so contended
 * runners (Windows shard, busy GH Actions windows) have headroom — the
 * historical 60 s cap routinely tipped over on Windows under matrix
 * contention even though `setupTestEnv()` itself is a cache hit after the
 * first call. The retry budget added by #150's `createLocalWithRetry`
 * machinery alone now eats the original 60 s when the first call has to
 * boot a fresh `TestWorkflowEnvironment`.
 *
 * Centralising the timeout here means individual files can't drift back to
 * a smaller value, and a future bump can be one-line.
 *
 * Usage (replace `before(async function () { this.timeout(60_000); await setupTestEnv(); })`):
 *
 *     before(setupSharedEnv);
 *
 * Filed under issue #383 P1.
 */
export async function setupSharedEnv(this: Mocha.Context): Promise<void> {
  this.timeout(120_000);
  await setupTestEnv();
}

/**
 * Poll until `predicate()` returns truthy or `timeoutMs` elapses. Returns
 * resolved when truthy; rejects with a documented error on timeout.
 *
 * Use for "wait for state X to become true" — e.g. assert a workflow
 * signal landed by polling its query rather than racing a single
 * `setTimeout` + assertion. The previous local `retry()` in
 * `test/stages.test.ts` (#190) used the throw-based assertion shape;
 * this is the predicate-returns-boolean shape, which is cleaner for
 * "did the signal land yet?" patterns where the caller just wants to
 * know when the workflow flipped.
 *
 * On timeout, the error message includes the `timeoutMs` and the
 * `intervalMs` so a CI failure log immediately reveals whether the
 * timeout was tight or the interval was coarse — same pattern as the
 * `waitForPhase` helpers in `test/adapter-claude-code-lifecycle-v2.test.ts`.
 *
 * Filed under issue #383 P2.
 */
export async function pollWithTimeout(
  predicate: () => boolean | Promise<boolean>,
  timeoutMs: number,
  intervalMs = 50,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await predicate()) return;
    await new Promise((r) => setTimeout(r, intervalMs));
  }
  throw new Error(
    `pollWithTimeout: predicate never returned true within ${timeoutMs}ms ` +
    `(polling every ${intervalMs}ms)`,
  );
}

/**
 * Inverse of {@link pollWithTimeout}: assert `predicate()` stays truthy for
 * the full `durationMs` window. Use for "confirm state X is stable" — e.g.
 * after pausing the outbox, assert that an entry stays `pending` for ~1s
 * (proving dispatch is actually paused), instead of `await sleep(1500)` +
 * single-shot assertion.
 *
 * The `await sleep(1500)` pattern is brittle on contended runners — a
 * scheduler hiccup can leave the test waiting longer than 1500 ms,
 * during which the workflow can fully drain the outbox even though it's
 * "supposed to be paused." `holdAssertion` polls the predicate at
 * `intervalMs` cadence so the failure mode "predicate flipped to false
 * mid-window" is observable, with a precise log of WHEN it flipped.
 *
 * Filed under issue #383 P2.
 */
export async function holdAssertion(
  predicate: () => boolean | Promise<boolean>,
  durationMs: number,
  intervalMs = 50,
): Promise<void> {
  const start = Date.now();
  const deadline = start + durationMs;
  while (Date.now() < deadline) {
    if (!(await predicate())) {
      const elapsedMs = Date.now() - start;
      throw new Error(
        `holdAssertion: predicate became false at ${elapsedMs}ms into the ` +
        `${durationMs}ms hold window (polling every ${intervalMs}ms)`,
      );
    }
    await new Promise((r) => setTimeout(r, intervalMs));
  }
  // Final check at the deadline — covers the edge where the predicate
  // happens to flip just after the last in-loop check.
  if (!(await predicate())) {
    throw new Error(
      `holdAssertion: predicate flipped to false at the ${durationMs}ms ` +
      `hold deadline (final post-loop check)`,
    );
  }
}

/**
 * Tear down the test environment. In isolated mode, tears down immediately.
 * In shared mode (default), this is a no-op — the real teardown runs once at
 * process exit via `mochaGlobalTeardown` in `test/root-hooks.ts`.
 */
export async function teardownTestEnv(): Promise<void> {
  if (ISOLATED_MODE) {
    await testEnv?.teardown();
    testEnv = undefined;
    workflowBundle = undefined;
  }
  // Shared mode: intentionally no-op. See `teardownSharedTestEnv()` below.
}

/**
 * Process-wide teardown. Invoked once by the Mocha global `after` hook in
 * `test/root-hooks.ts` after all spec files have finished. Not part of the
 * public test API — do not call from individual test files.
 *
 * @internal
 */
export async function teardownSharedTestEnv(): Promise<void> {
  if (testEnv) {
    await testEnv.teardown();
    testEnv = undefined;
    workflowBundle = undefined;
  }
}

/** Get the Temporal client from the test environment. Call `setupTestEnv()` first. */
export function getClient(): Client {
  if (!testEnv) {
    throw new Error('getClient() called before setupTestEnv() — make sure your before() hook awaits setupTestEnv()');
  }
  return testEnv.client;
}

/**
 * Get the shared `NativeConnection` for `Worker.create(...)`. Tests that need
 * a custom Worker topology — for example, a per-host worker with a capturing
 * `hardTerminateAttachment` stub (#227) — use this to build their own workers
 * instead of going through `withWorker` / `withWorkerAndRecruitActivities`.
 * Call `setupTestEnv()` first.
 */
export function getNativeConnection(): TestWorkflowEnvironment['nativeConnection'] {
  if (!testEnv) {
    throw new Error('getNativeConnection() called before setupTestEnv() — make sure your before() hook awaits setupTestEnv()');
  }
  return testEnv.nativeConnection;
}

/** Internal — resolves the current test env; for helpers only. */
function requireTestEnv(): TestWorkflowEnvironment {
  if (!testEnv) {
    throw new Error('Test env not initialized — call setupTestEnv() from a before() hook');
  }
  return testEnv;
}

/** Internal — resolves the current workflow bundle. */
function requireWorkflowBundle(): { code: string } {
  if (!workflowBundle) {
    throw new Error('Workflow bundle not loaded — call setupTestEnv() from a before() hook');
  }
  return workflowBundle;
}

/**
 * Sleep `durationMs` milliseconds of **real wall-clock time**.
 *
 * Despite the name, this is NOT Temporal time-skipping — `setupTestEnv` uses
 * `TestWorkflowEnvironment.createLocal()`, not `createTimeSkipping()`, so
 * `testEnv.sleep(ms)` is a real sleep. Workflow timers and
 * `condition(..., timeout)` calls do not see skipped time.
 *
 * **Do not use `skipTime(1)` (or other short sleeps) to flush a pending
 * workflow task before querying** — that is a race against the dispatch
 * loop and fails intermittently on slow CI runners (see #190). Use a
 * poll-with-timeout helper that retries the assertion until it passes.
 *
 * Kept for tests that legitimately need to exercise a real timeout window
 * (e.g. verifying behavior over a bounded duration).
 */
export async function skipTime(durationMs: number): Promise<void> {
  await requireTestEnv().sleep(durationMs);
}

/**
 * Create and start a Worker that runs for the duration of `fn`.
 * The worker is shut down when `fn` resolves or rejects.
 *
 * Also spins up a tiny per-host worker on `agent-tempo-test-host` that stubs
 * `hardTerminateAttachment` — needed by `forceDetachUpdate` and the fire-and-forget
 * `destroyUpdate` (#164) which schedule the activity on the per-host queue.
 */
export async function withWorker<T>(fn: () => Promise<T>): Promise<T> {
  const taskQueue = mintTaskQueue(); // #721 — unique SlotKey per invocation
  const worker = await createWorkerWithSlotRetry({
    connection: requireTestEnv().nativeConnection,
    taskQueue,
    workflowBundle,
  });
  const hostWorker = await createWorkerWithSlotRetry({
    connection: requireTestEnv().nativeConnection,
    taskQueue: HOST_TASK_QUEUE,
    activities: {
      hardTerminateAttachment: async () => ({
        killedPids: [],
        strategy: 'none' as const,
        notes: ['test stub — no real process to kill'],
      }),
    },
  });
  return runWorkerUntil(worker, async () => {
    const hostWorkerPromise = hostWorker.run();
    try {
      return await fn();
    } finally {
      hostWorker.shutdown();
      await hostWorkerPromise.catch(() => { /* cleanup */ });
    }
  });
}

/**
 * Like withWorker, but also registers the schedule-fire activities
 * so the scheduler workflow can cue target players.
 *
 * The host-queue worker for `hardTerminateAttachment` is provided globally
 * by `setupTestEnv` — no per-test host worker is needed here.
 */
export async function withWorkerAndActivities<T>(fn: () => Promise<T>): Promise<T> {
  const taskQueue = mintTaskQueue(); // #721 — unique SlotKey per invocation
  const { createScheduleActivities } = await import('../src/activities/schedule-fire');
  const scheduleActivities = createScheduleActivities(requireTestEnv().client);
  const worker = await createWorkerWithSlotRetry({
    connection: requireTestEnv().nativeConnection,
    taskQueue,
    workflowBundle,
    activities: scheduleActivities,
  });
  return runWorkerUntil(worker, fn);
}

/**
 * Default metadata for a player session. Override fields as needed.
 *
 * `ensemble` defaults to the per-file random prefix seeded by the most recent
 * `setupTestEnv()` call — auto-namespaces default callers under the shared
 * `TestWorkflowEnvironment` (#210).
 */
export function playerMetadata(overrides: Partial<SessionMetadata> = {}): SessionMetadata {
  return {
    playerId: `player-${Date.now()}`,
    ensemble: currentEnsemblePrefix,
    hostname: 'test-host',
    workDir: '/tmp/test',
    isConductor: false,
    agentType: 'claude',
    ...overrides,
  };
}

/** Default metadata for a conductor session. Override fields as needed. */
export function conductorMetadata(overrides: Partial<SessionMetadata> = {}): SessionMetadata {
  return playerMetadata({
    playerId: 'conductor',
    isConductor: true,
    ...overrides,
  });
}

/**
 * Start a session workflow and return its handle.
 *
 * Usage:
 *   const handle = await startSession({ metadata: playerMetadata({ playerId: 'alice' }) });
 */
export async function startSession(
  inputOverrides: Partial<SessionInput> = {},
): Promise<WorkflowHandle> {
  const metadata = inputOverrides.metadata ?? playerMetadata();
  const input: SessionInput = {
    metadata,
    autoSummary: `Session in test`,
    disableStaleDetection: true, // prevent stale exits during tests
    ...inputOverrides,
    // Ensure metadata is always set (overrides above may have replaced it)
    ...(inputOverrides.metadata ? {} : { metadata }),
  };

  // Always use playerId in the workflow ID. conductorMetadata() defaults
  // playerId to 'conductor', so callers that don't override get the canonical
  // 'agent-session-{ensemble}-conductor' ID unchanged. Callers that pass a
  // non-default playerId (e.g. stages.test.ts uses 'stage-cond-N') get a
  // unique ID per test, preventing WorkflowExecutionAlreadyStartedError
  // cascades when a test fails before its cleanup destroyUpdate runs.
  const workflowId = `agent-session-${metadata.ensemble}-${metadata.playerId}`;

  return requireTestEnv().client.workflow.start('agentSessionWorkflow', {
    workflowId,
    taskQueue: TASK_QUEUE,
    args: [input],
  });
}

/**
 * Send a message to a session and return the handle.
 */
export async function sendMessage(
  handle: WorkflowHandle,
  from: string,
  text: string,
): Promise<void> {
  await handle.signal(receiveMessageSignal, { from, text });
}

/**
 * Poll listEnsemble until at least `expectedCount` members are visible, or
 * the timeout elapses. Temporal's visibility store is eventually consistent —
 * a workflow that has just started may not appear in list queries immediately.
 * Use this in tests that start multiple sessions and then assert the count.
 */
export async function waitForEnsembleMembers(
  client: Client,
  ensemble: string,
  expectedCount: number,
  timeoutMs = 5000,
): Promise<SessionMetadata[]> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const members = await listEnsemble(client, ensemble);
    if (members.length >= expectedCount) return members;
    await new Promise<void>((r) => setTimeout(r, 100));
  }
  // Final attempt — let the caller's assertion produce the failure message
  return listEnsemble(client, ensemble);
}

/**
 * Query all running session workflows and return those matching the
 * given ensemble — mirrors the production ensemble tool logic.
 */
export async function listEnsemble(
  client: Client,
  ensemble: string,
): Promise<SessionMetadata[]> {
  const results: SessionMetadata[] = [];
  const query = `WorkflowType = "agentSessionWorkflow" AND ExecutionStatus = "Running"`;

  for await (const wf of client.workflow.list({ query })) {
    try {
      const handle = client.workflow.getHandle(wf.workflowId);
      const metadata: SessionMetadata = await handle.query(getMetadataQuery);
      if (metadata.ensemble === ensemble) {
        results.push(metadata);
      }
    } catch {
      // skip completed workflows
    }
  }

  return results;
}

/**
 * Resolve a session by player name within an ensemble — mirrors
 * the production resolveSession logic.
 */
export async function resolveByName(
  client: Client,
  ensemble: string,
  playerName: string,
): Promise<WorkflowHandle | null> {
  const query = `WorkflowType = "agentSessionWorkflow" AND ExecutionStatus = "Running"`;

  for await (const wf of client.workflow.list({ query })) {
    try {
      const handle = client.workflow.getHandle(wf.workflowId);
      const metadata: SessionMetadata = await handle.query(getMetadataQuery);
      if (metadata.ensemble === ensemble && metadata.playerId === playerName) {
        return handle;
      }
    } catch {
      // skip
    }
  }

  return null;
}

/**
 * Build the deterministic conductor workflow ID for an ensemble.
 */
export function conductorWorkflowId(ensemble: string): string {
  return `agent-session-${ensemble}-conductor`;
}

/**
 * Check if a conductor workflow is running for the given ensemble.
 */
export async function isConductorRunning(
  client: Client,
  ensemble: string,
): Promise<boolean> {
  try {
    const handle = client.workflow.getHandle(conductorWorkflowId(ensemble));
    const desc = await handle.describe();
    return desc.status.name === 'RUNNING';
  } catch {
    return false;
  }
}

/**
 * Start a session with USE_EXISTING policy — simulates what the MCP server
 * does when reconnecting to an existing workflow (e.g., conductor resume).
 */
/**
 * Like withWorker, but registers both schedule-fire and outbox activities.
 * spawnProcess is stubbed to avoid launching real terminals in tests.
 */
export async function withWorkerAndOutboxActivities<T>(fn: () => Promise<T>): Promise<T> {
  const taskQueue = mintTaskQueue(); // #721 — unique SlotKey per invocation
  const { createScheduleActivities } = await import('../src/activities/schedule-fire');
  const { createOutboxActivities } = await import('../src/activities/outbox');

  const scheduleActivities = createScheduleActivities(requireTestEnv().client);
  const outboxActivities = createOutboxActivities(requireTestEnv().client, {
    temporalAddress: '',
    temporalNamespace: 'default',
    taskQueue, // recruited workflows must start on the queue this worker polls
    ensemble: currentEnsemblePrefix,
    defaultAgent: 'claude',
  });

  const worker = await createWorkerWithSlotRetry({
    connection: requireTestEnv().nativeConnection,
    taskQueue,
    workflowBundle,
    activities: {
      ...scheduleActivities,
      ...outboxActivities,
      // Stub spawnProcess to avoid launching real terminals
      spawnProcess: async () => ({ success: true }),
      // Stub hardTerminate as a no-op so forceDetachUpdate can resolve without actually
      // probing the live process table in a unit-test scenario.
      hardTerminateAttachment: async () => ({
        killedPids: [],
        strategy: 'none' as const,
        notes: ['test stub'],
      }),
    },
  });
  // Per-host worker — same stub so activities routed via the per-host queue also resolve.
  const hostWorker = await createWorkerWithSlotRetry({
    connection: requireTestEnv().nativeConnection,
    taskQueue: HOST_TASK_QUEUE,
    activities: {
      spawnProcess: async () => ({ success: true }),
      hardTerminateAttachment: async () => ({
        killedPids: [],
        strategy: 'none' as const,
        notes: ['test stub'],
      }),
    },
  });
  return runWorkerUntil(worker, async () => {
    const hostWorkerPromise = hostWorker.run();
    try {
      return await fn();
    } finally {
      hostWorker.shutdown();
      await hostWorkerPromise.catch(() => { /* cleanup */ });
    }
  });
}

/**
 * Like withWorkerAndOutboxActivities, but also registers a second worker on the
 * per-host task queue used by `spawnProcess` during recruit dispatch.
 *
 * The session workflow routes `spawnProcess` to `agent-tempo-{hostname}`.
 * Tests use hostname 'test-host' (see playerMetadata), so we need a worker on
 * `agent-tempo-test-host` with a stubbed spawnProcess to avoid launching real terminals.
 */
export async function withWorkerAndRecruitActivities<T>(fn: () => Promise<T>): Promise<T> {
  const taskQueue = mintTaskQueue(); // #721 — unique SlotKey per invocation
  const { createScheduleActivities } = await import('../src/activities/schedule-fire');
  const { createOutboxActivities } = await import('../src/activities/outbox');

  const scheduleActivities = createScheduleActivities(requireTestEnv().client);
  const outboxActivities = createOutboxActivities(requireTestEnv().client, {
    temporalAddress: '',
    temporalNamespace: 'default',
    taskQueue, // recruited workflows must start on the queue this worker polls
    ensemble: currentEnsemblePrefix,
    defaultAgent: 'claude',
  });

  // Main worker: workflow execution + all outbox + schedule activities
  const mainWorker = await createWorkerWithSlotRetry({
    connection: requireTestEnv().nativeConnection,
    taskQueue,
    workflowBundle,
    activities: {
      ...scheduleActivities,
      ...outboxActivities,
      spawnProcess: async () => ({ success: true }),
    },
  });

  // Per-host worker: handles spawnProcess for the 'test-host' hostname.
  // spawnProcess is routed to `agent-tempo-{hostname}` by the session workflow.
  // No workflowBundle — this worker only polls for activity tasks, matching
  // the production per-host worker config in src/worker.ts.
  const hostWorker = await createWorkerWithSlotRetry({
    connection: requireTestEnv().nativeConnection,
    taskQueue: `agent-tempo-test-host`,
    activities: {
      spawnProcess: async () => ({ success: true }),
      // #159 Gap 2: stub hardTerminate alongside spawnProcess on the per-host queue.
      hardTerminateAttachment: async () => ({
        killedPids: [],
        strategy: 'none' as const,
        notes: ['test stub'],
      }),
    },
  });

  return runWorkerUntil(mainWorker, async () => {
    const hostWorkerPromise = hostWorker.run();
    try {
      return await fn();
    } finally {
      hostWorker.shutdown();
      await hostWorkerPromise.catch(() => { /* cleanup */ });
    }
  });
}

/**
 * Describe-level companion to {@link withWorkerAndOutboxActivities} and
 * {@link withWorkerAndRecruitActivities}. Starts a main + per-host worker
 * pair, returns an async teardown function. A `describe` of N tests pays
 * spin-up once instead of N times — the heaviest cost #383 P3 audit
 * identified.
 *
 * The two callers are kept in lockstep with the existing wrappers; any
 * drift in the activity stub sets would surface as a "works under wrapper,
 * fails under shared worker" anomaly — see also {@link useSharedWorker}.
 *
 * Filed under issue #383 P3.1.
 */
async function startWorkerPair(
  opts: { includeHardTerminateOnMain: boolean },
): Promise<() => Promise<void>> {
  // #721 — one queue per describe-level worker pair; tests inside the
  // describe read the live TASK_QUEUE binding and land on this queue.
  const taskQueue = mintTaskQueue();
  const { createScheduleActivities } = await import('../src/activities/schedule-fire');
  const { createOutboxActivities } = await import('../src/activities/outbox');

  const scheduleActivities = createScheduleActivities(requireTestEnv().client);
  const outboxActivities = createOutboxActivities(requireTestEnv().client, {
    temporalAddress: '',
    temporalNamespace: 'default',
    taskQueue, // recruited workflows must start on the queue this worker polls
    ensemble: currentEnsemblePrefix,
    defaultAgent: 'claude',
  });

  const hardTerminateStub = async () => ({
    killedPids: [],
    strategy: 'none' as const,
    notes: ['test stub'],
  });

  const mainWorker = await createWorkerWithSlotRetry({
    connection: requireTestEnv().nativeConnection,
    taskQueue,
    workflowBundle,
    activities: {
      ...scheduleActivities,
      ...outboxActivities,
      spawnProcess: async () => ({ success: true }),
      ...(opts.includeHardTerminateOnMain ? { hardTerminateAttachment: hardTerminateStub } : {}),
    },
  });
  const hostWorker = await createWorkerWithSlotRetry({
    connection: requireTestEnv().nativeConnection,
    taskQueue: HOST_TASK_QUEUE,
    activities: {
      spawnProcess: async () => ({ success: true }),
      hardTerminateAttachment: hardTerminateStub,
    },
  });

  const mainRun = mainWorker.run();
  const hostRun = hostWorker.run();

  return async () => {
    mainWorker.shutdown();
    hostWorker.shutdown();
    await Promise.allSettled([mainRun, hostRun]);
  };
}

/** Outbox-flavor variant — main worker stubs `hardTerminateAttachment`. */
export function startOutboxWorker(): Promise<() => Promise<void>> {
  return startWorkerPair({ includeHardTerminateOnMain: true });
}

/** Recruit-flavor variant — main worker omits `hardTerminateAttachment` (matches `withWorkerAndRecruitActivities`). */
export function startRecruitWorker(): Promise<() => Promise<void>> {
  return startWorkerPair({ includeHardTerminateOnMain: false });
}

/**
 * Mocha hook helper: registers `before` / `after` for a describe-level
 * shared worker. Call inside a `describe` block:
 *
 * ```ts
 * describe('outbox-activities flavor', function () {
 *   useSharedWorker(startOutboxWorker);
 *   // its with bodies un-wrapped
 * });
 * ```
 *
 * Eliminates the `let stopWorker; before(...); after(...);` boilerplate
 * the flavor describes would otherwise repeat. Mocha's BDD `before` /
 * `after` globals attach to the lexically active describe at call time,
 * so this works regardless of which describe invokes it.
 *
 * Filed under issue #383 P3.1.
 */
export function useSharedWorker(starter: () => Promise<() => Promise<void>>): void {
  let stop: (() => Promise<void>) | undefined;
  before(async function () {
    this.timeout(60_000);
    stop = await starter();
  });
  after(async function () {
    if (stop) await stop();
  });
}

/**
 * Like withWorkerAndRecruitActivities, but captures spawnProcess inputs
 * so tests can verify arguments passed through the recruit pipeline.
 */
export async function withWorkerAndRecruitCapture<T>(
  spawnInputs: Array<Record<string, unknown>>,
  fn: () => Promise<T>,
): Promise<T> {
  const taskQueue = mintTaskQueue(); // #721 — unique SlotKey per invocation
  const { createScheduleActivities } = await import('../src/activities/schedule-fire');
  const { createOutboxActivities } = await import('../src/activities/outbox');

  const scheduleActivities = createScheduleActivities(requireTestEnv().client);
  const outboxActivities = createOutboxActivities(requireTestEnv().client, {
    temporalAddress: '',
    temporalNamespace: 'default',
    taskQueue, // recruited workflows must start on the queue this worker polls
    ensemble: currentEnsemblePrefix,
    defaultAgent: 'claude',
  });

  const capturingSpawn = async (input: Record<string, unknown>) => {
    spawnInputs.push(input);
    return { success: true };
  };

  const mainWorker = await createWorkerWithSlotRetry({
    connection: requireTestEnv().nativeConnection,
    taskQueue,
    workflowBundle,
    activities: {
      ...scheduleActivities,
      ...outboxActivities,
      spawnProcess: capturingSpawn,
    },
  });

  const hostWorker = await createWorkerWithSlotRetry({
    connection: requireTestEnv().nativeConnection,
    taskQueue: `agent-tempo-test-host`,
    activities: {
      spawnProcess: capturingSpawn,
      hardTerminateAttachment: async () => ({
        killedPids: [],
        strategy: 'none' as const,
        notes: ['test stub'],
      }),
    },
  });

  return runWorkerUntil(mainWorker, async () => {
    const hostWorkerPromise = hostWorker.run();
    try {
      return await fn();
    } finally {
      hostWorker.shutdown();
      await hostWorkerPromise.catch(() => { /* cleanup */ });
    }
  });
}

/**
 * Like withWorkerAndActivities, but registers mocked Maestro activities.
 * The `mockPlayers` callback controls what `refreshEnsembleState` returns.
 * The `relayedCommands` array captures relayed command inputs.
 */
export async function withWorkerAndMaestroActivities<T>(
  opts: {
    mockPlayers?: () => MaestroPlayerInfo[];
    relayResult?: () => { success: boolean; error?: string };
  },
  fn: (relayedCommands: Array<{ text: string; source: string; replyTo?: string }>) => Promise<T>,
): Promise<T> {
  const mockPlayers = opts.mockPlayers ?? (() => []);
  const relayResult = opts.relayResult ?? (() => ({ success: true }));
  const relayedCommands: Array<{ text: string; source: string; replyTo?: string }> = [];

  const taskQueue = mintTaskQueue(); // #721 — unique SlotKey per invocation
  const { createScheduleActivities } = await import('../src/activities/schedule-fire');
  const scheduleActivities = createScheduleActivities(requireTestEnv().client);

  const worker = await createWorkerWithSlotRetry({
    connection: requireTestEnv().nativeConnection,
    taskQueue,
    workflowBundle,
    activities: {
      ...scheduleActivities,
      // 2.0 (#788): the maestro workflow calls refreshEnsembleStateV2 for both
      // cost profiles (V1 removed). Mock returns the same players + a present
      // observer (local profile never gates cadence on it).
      refreshEnsembleStateV2: async (_input: { ensemble: string }) => ({ players: mockPlayers(), observersPresent: true }),
      relayCommandToConductor: async (input: { text: string; source: string; replyTo?: string }) => {
        relayedCommands.push(input);
        return relayResult();
      },
      fetchConductorHistory: async () => ({ success: true, history: [] }),
      discoverEnsembles: async () => [],
      deliverMaestroMessage: async () => ({ success: true }),
      fetchPlayerMessages: async () => ({ success: true, messages: [] }),
      fetchEnsembleChat: async () => ({ success: true, newMessages: [], currentCounts: { maestroRecv: 0, maestroSent: 0, conductorRecv: 0, conductorSent: 0 }, hasConductor: false }),
      deliverCue: async () => {},
      deliverReport: async () => {},
      terminateSession: async () => {},
      startRecruitedSession: async () => ({ sessionId: 'test' }),
      releasePlayer: async () => ({ success: true }),
      spawnProcess: async () => ({ success: true }),
    },
  });
  return runWorkerUntil(worker, () => fn(relayedCommands));
}

/**
 * Like withWorkerAndMaestroActivities, but for the global Maestro workflow.
 * Supports multiple ensembles via the `mockEnsembles` and `mockPlayersByEnsemble` callbacks.
 */
export async function withWorkerAndGlobalMaestroActivities<T>(
  opts: {
    mockEnsembles?: () => string[];
    mockPlayersByEnsemble?: (ensemble: string) => MaestroPlayerInfo[];
    relayResult?: () => { success: boolean; error?: string };
    deliverResult?: () => { success: boolean; error?: string };
    fetchMessagesResult?: () => { success: boolean; messages: any[]; error?: string };
    fetchHistoryResult?: () => { success: boolean; history: any[]; error?: string };
  },
  fn: (relayedCommands: Array<{ ensemble: string; text: string; source: string; replyTo?: string }>) => Promise<T>,
): Promise<T> {
  const mockEnsembles = opts.mockEnsembles ?? (() => []);
  const mockPlayersByEnsemble = opts.mockPlayersByEnsemble ?? (() => []);
  const relayResult = opts.relayResult ?? (() => ({ success: true }));
  const deliverResult = opts.deliverResult ?? (() => ({ success: true }));
  const fetchMessagesResult = opts.fetchMessagesResult ?? (() => ({ success: true, messages: [] }));
  const fetchHistoryResult = opts.fetchHistoryResult ?? (() => ({ success: true, history: [] }));
  const relayedCommands: Array<{ ensemble: string; text: string; source: string; replyTo?: string }> = [];

  const taskQueue = mintTaskQueue(); // #721 — unique SlotKey per invocation
  const { createScheduleActivities } = await import('../src/activities/schedule-fire');
  const scheduleActivities = createScheduleActivities(requireTestEnv().client);

  const worker = await createWorkerWithSlotRetry({
    connection: requireTestEnv().nativeConnection,
    taskQueue,
    workflowBundle,
    activities: {
      ...scheduleActivities,
      discoverEnsembles: async () => mockEnsembles(),
      // 2.0 (#788): global maestro calls refreshEnsembleStateV2 for both profiles (V1 removed).
      refreshEnsembleStateV2: async (input: { ensemble: string }) => ({ players: mockPlayersByEnsemble(input.ensemble), observersPresent: true }),
      relayCommandToConductor: async (input: { ensemble: string; text: string; source: string; replyTo?: string }) => {
        relayedCommands.push(input);
        return relayResult();
      },
      deliverMaestroMessage: async () => deliverResult(),
      fetchPlayerMessages: async () => fetchMessagesResult(),
      fetchConductorHistory: async () => fetchHistoryResult(),
      fetchEnsembleChat: async () => ({ success: true, newMessages: [], currentCounts: { maestroRecv: 0, maestroSent: 0, conductorRecv: 0, conductorSent: 0 }, hasConductor: false }),
      deliverCue: async () => {},
      deliverReport: async () => {},
      terminateSession: async () => {},
      startRecruitedSession: async () => ({ sessionId: 'test' }),
      releasePlayer: async () => ({ success: true }),
      spawnProcess: async () => ({ success: true }),
    },
  });
  return runWorkerUntil(worker, () => fn(relayedCommands));
}

export async function reconnectSession(
  inputOverrides: Partial<SessionInput> = {},
): Promise<WorkflowHandle> {
  const metadata = inputOverrides.metadata ?? playerMetadata();
  const input: SessionInput = {
    metadata,
    autoSummary: `Session in test`,
    disableStaleDetection: true,
    ...inputOverrides,
    ...(inputOverrides.metadata ? {} : { metadata }),
  };

  const workflowId = metadata.isConductor
    ? `agent-session-${metadata.ensemble}-conductor`
    : `agent-session-${metadata.ensemble}-${metadata.playerId}`;

  return requireTestEnv().client.workflow.start('agentSessionWorkflow', {
    workflowId,
    taskQueue: TASK_QUEUE,
    args: [input],
    workflowIdConflictPolicy: WorkflowIdConflictPolicy.USE_EXISTING,
  });
}
