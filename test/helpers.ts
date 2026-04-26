/**
 * Test helpers for claude-tempo workflow tests.
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
export async function reapOrphanTemporalServers(): Promise<void> {
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
 * `claude-session-${getTestEnsemble()}-custom-id`).
 */
export function getTestEnsemble(): string {
  return currentEnsemblePrefix;
}

export const TASK_QUEUE = 'test-claude-tempo';

/**
 * Per-host task queue for spawnProcess activities.
 * The workflow routes spawnProcess to `claude-tempo-{hostname}`.
 * Tests use hostname 'test-host', so the queue is `claude-tempo-test-host`.
 */
const HOST_TASK_QUEUE = 'claude-tempo-test-host';

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
    testEnv = await createLocalWithRetry({
      server: {
        // Register custom search attributes at server startup.
        // `ClaudeTempoStatus` removed in v0.26 (#175 / #178).
        extraArgs: [
          '--search-attribute', 'ClaudeTempoEnsemble=Keyword',
          '--search-attribute', 'ClaudeTempoPlayerId=Keyword',
          '--search-attribute', 'ClaudeTempoHostname=Keyword',
          '--search-attribute', 'ClaudeTempoGitRoot=Keyword',
          '--search-attribute', 'ClaudeTempoPlayerType=Keyword',
          '--search-attribute', 'ClaudeTempoIsConductor=Bool',
          // v0.25 attachment lifecycle search attrs (§9, §11.2)
          '--search-attribute', 'ClaudeTempoAttachedHost=Keyword',
          '--search-attribute', 'ClaudeTempoAttachmentState=Keyword',
          '--search-attribute', 'ClaudeTempoAttachmentId=Keyword',
        ],
      },
    });
    const bundlePath = findWorkflowBundle();
    workflowBundle = { code: fs.readFileSync(bundlePath, 'utf-8') };
  }
  // Re-seed per-file suffix. Short hex keeps workflow IDs readable in Temporal UI.
  currentEnsemblePrefix = `test-ensemble-${crypto.randomBytes(4).toString('hex')}`;
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
 * Also spins up a tiny per-host worker on `claude-tempo-test-host` that stubs
 * `hardTerminateAttachment` — needed by `forceDetachUpdate` and the fire-and-forget
 * `destroyUpdate` (#164) which schedule the activity on the per-host queue.
 */
export async function withWorker<T>(fn: () => Promise<T>): Promise<T> {
  const worker = await Worker.create({
    connection: requireTestEnv().nativeConnection,
    taskQueue: TASK_QUEUE,
    workflowBundle,
  });
  const hostWorker = await Worker.create({
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
  return worker.runUntil(async () => {
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
  const { createScheduleActivities } = await import('../src/activities/schedule-fire');
  const scheduleActivities = createScheduleActivities(requireTestEnv().client);
  const worker = await Worker.create({
    connection: requireTestEnv().nativeConnection,
    taskQueue: TASK_QUEUE,
    workflowBundle,
    activities: scheduleActivities,
  });
  return worker.runUntil(fn);
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
  // 'claude-session-{ensemble}-conductor' ID unchanged. Callers that pass a
  // non-default playerId (e.g. stages.test.ts uses 'stage-cond-N') get a
  // unique ID per test, preventing WorkflowExecutionAlreadyStartedError
  // cascades when a test fails before its cleanup destroyUpdate runs.
  const workflowId = `claude-session-${metadata.ensemble}-${metadata.playerId}`;

  return requireTestEnv().client.workflow.start('claudeSessionWorkflow', {
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
  const query = `WorkflowType = "claudeSessionWorkflow" AND ExecutionStatus = "Running"`;

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
  const query = `WorkflowType = "claudeSessionWorkflow" AND ExecutionStatus = "Running"`;

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
  return `claude-session-${ensemble}-conductor`;
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
  const { createScheduleActivities } = await import('../src/activities/schedule-fire');
  const { createOutboxActivities } = await import('../src/activities/outbox');

  const scheduleActivities = createScheduleActivities(requireTestEnv().client);
  const outboxActivities = createOutboxActivities(requireTestEnv().client, {
    temporalAddress: '',
    temporalNamespace: 'default',
    taskQueue: TASK_QUEUE,
    ensemble: currentEnsemblePrefix,
    defaultAgent: 'claude',
  });

  const worker = await Worker.create({
    connection: requireTestEnv().nativeConnection,
    taskQueue: TASK_QUEUE,
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
  const hostWorker = await Worker.create({
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
  return worker.runUntil(async () => {
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
 * The session workflow routes `spawnProcess` to `claude-tempo-{hostname}`.
 * Tests use hostname 'test-host' (see playerMetadata), so we need a worker on
 * `claude-tempo-test-host` with a stubbed spawnProcess to avoid launching real terminals.
 */
export async function withWorkerAndRecruitActivities<T>(fn: () => Promise<T>): Promise<T> {
  const { createScheduleActivities } = await import('../src/activities/schedule-fire');
  const { createOutboxActivities } = await import('../src/activities/outbox');

  const scheduleActivities = createScheduleActivities(requireTestEnv().client);
  const outboxActivities = createOutboxActivities(requireTestEnv().client, {
    temporalAddress: '',
    temporalNamespace: 'default',
    taskQueue: TASK_QUEUE,
    ensemble: currentEnsemblePrefix,
    defaultAgent: 'claude',
  });

  // Main worker: workflow execution + all outbox + schedule activities
  const mainWorker = await Worker.create({
    connection: requireTestEnv().nativeConnection,
    taskQueue: TASK_QUEUE,
    workflowBundle,
    activities: {
      ...scheduleActivities,
      ...outboxActivities,
      spawnProcess: async () => ({ success: true }),
    },
  });

  // Per-host worker: handles spawnProcess for the 'test-host' hostname.
  // spawnProcess is routed to `claude-tempo-{hostname}` by the session workflow.
  // No workflowBundle — this worker only polls for activity tasks, matching
  // the production per-host worker config in src/worker.ts.
  const hostWorker = await Worker.create({
    connection: requireTestEnv().nativeConnection,
    taskQueue: `claude-tempo-test-host`,
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

  return mainWorker.runUntil(async () => {
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
 * Like withWorkerAndRecruitActivities, but captures spawnProcess inputs
 * so tests can verify arguments passed through the recruit pipeline.
 */
export async function withWorkerAndRecruitCapture<T>(
  spawnInputs: Array<Record<string, unknown>>,
  fn: () => Promise<T>,
): Promise<T> {
  const { createScheduleActivities } = await import('../src/activities/schedule-fire');
  const { createOutboxActivities } = await import('../src/activities/outbox');

  const scheduleActivities = createScheduleActivities(requireTestEnv().client);
  const outboxActivities = createOutboxActivities(requireTestEnv().client, {
    temporalAddress: '',
    temporalNamespace: 'default',
    taskQueue: TASK_QUEUE,
    ensemble: currentEnsemblePrefix,
    defaultAgent: 'claude',
  });

  const capturingSpawn = async (input: Record<string, unknown>) => {
    spawnInputs.push(input);
    return { success: true };
  };

  const mainWorker = await Worker.create({
    connection: requireTestEnv().nativeConnection,
    taskQueue: TASK_QUEUE,
    workflowBundle,
    activities: {
      ...scheduleActivities,
      ...outboxActivities,
      spawnProcess: capturingSpawn,
    },
  });

  const hostWorker = await Worker.create({
    connection: requireTestEnv().nativeConnection,
    taskQueue: `claude-tempo-test-host`,
    activities: {
      spawnProcess: capturingSpawn,
      hardTerminateAttachment: async () => ({
        killedPids: [],
        strategy: 'none' as const,
        notes: ['test stub'],
      }),
    },
  });

  return mainWorker.runUntil(async () => {
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

  const { createScheduleActivities } = await import('../src/activities/schedule-fire');
  const scheduleActivities = createScheduleActivities(requireTestEnv().client);

  const worker = await Worker.create({
    connection: requireTestEnv().nativeConnection,
    taskQueue: TASK_QUEUE,
    workflowBundle,
    activities: {
      ...scheduleActivities,
      refreshEnsembleState: async (_ensemble: string) => mockPlayers(),
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
  return worker.runUntil(() => fn(relayedCommands));
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

  const { createScheduleActivities } = await import('../src/activities/schedule-fire');
  const scheduleActivities = createScheduleActivities(requireTestEnv().client);

  const worker = await Worker.create({
    connection: requireTestEnv().nativeConnection,
    taskQueue: TASK_QUEUE,
    workflowBundle,
    activities: {
      ...scheduleActivities,
      discoverEnsembles: async () => mockEnsembles(),
      refreshEnsembleState: async (ensemble: string) => mockPlayersByEnsemble(ensemble),
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
  return worker.runUntil(() => fn(relayedCommands));
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
    ? `claude-session-${metadata.ensemble}-conductor`
    : `claude-session-${metadata.ensemble}-${metadata.playerId}`;

  return requireTestEnv().client.workflow.start('claudeSessionWorkflow', {
    workflowId,
    taskQueue: TASK_QUEUE,
    args: [input],
    workflowIdConflictPolicy: WorkflowIdConflictPolicy.USE_EXISTING,
  });
}
