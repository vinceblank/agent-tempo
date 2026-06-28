/**
 * Reusable child-process CLI test harness — `test/helpers/cli-harness.ts`
 *
 * Spawns `node dist/cli.js <verb> [args]` against a provided
 * `TestWorkflowEnvironment` address and captures exit code + stdout/stderr.
 * Designed to be consumed by QA's gap-5/6 tests for #796:
 *   - CLI exit codes 0 / 1 / 2 / 3 (`upgrade-to-2` phase results)
 *   - `--dry-run` early-exit
 *   - crash-proof dynamic-import guard (`upgrade-to-2-command.ts`)
 *   - `up --from-upgrade` CLI path
 *
 * ## API
 *
 * ```ts
 * import { runCli, CliResult } from '../helpers/cli-harness';
 *
 * // Inside a TestWorkflowEnvironment-backed describe block:
 * const r = runCli(['upgrade-to-2', '--dry-run'], {
 *   temporalAddress: getTestEnvAddress(testEnv),
 * });
 * assert.equal(r.exitCode, 0);
 * assert.match(r.stdout, /Dry-run complete/);
 * ```
 *
 * ## Design decisions
 *
 * - **Child process, not in-process** — exercises the real `process.exitCode` /
 *   `process.exit()` paths. Mocking those in-process would defeat the purpose
 *   (e.g. a test that asserts exit-code 2 would terminate the Mocha runner).
 *
 * - **`dist/cli.js`, not `src/cli.ts`** — reflects the real install surface.
 *   Tests must be run after `npm run build` (or `npm run build:bundle` in a
 *   worktree). The harness emits a clear error if the dist file is missing.
 *
 * - **`TEMPORAL_NAMESPACE=default` by default** — matches the ephemeral server
 *   started by `TestWorkflowEnvironment.createLocal()`. Override via `env`.
 *
 * - **`AGENT_TEMPO_DEV_MODE` cleared** — prevents an inherited dev-mode env
 *   from leaking into test invocations. `AGENT_TEMPO_DEV_MODE` is the var
 *   `dev-mode-bootstrap.ts` promotes `--dev` into (§5.4 ADR 0014). Re-enable
 *   via `opts.env` when a test explicitly exercises the dev-mode path.
 *
 * - **Synchronous (`spawnSync`)** — keeps test bodies simple; no async
 *   child-process stream management. `runCli` inside `async it()` is fine for
 *   Mocha. For verbs that may take > 15 s, bump `timeoutMs` in opts.
 *
 * - **`result.error` surfaced** — a spawn failure (e.g. ENOENT for the node
 *   binary, a pre-exec OS error) sets `result.error` on `CliResult` instead of
 *   silently returning `exitCode: null`. Tests that care only about exit codes
 *   can ignore the field; tests that probe spawn-level failures check it.
 *
 * - **Timeout** — defaults to 15 000 ms. Override via `timeoutMs` in options.
 */

import { spawnSync } from 'child_process';
import * as path from 'path';
import * as fs from 'fs';

// ── Paths ─────────────────────────────────────────────────────────────────

/**
 * Repo root — this file compiles to `dist-test/test/helpers/cli-harness.js`,
 * so `__dirname` is three levels deep. Walk up to reach the repo root where
 * `dist/cli.js` lives.
 */
const REPO_ROOT = path.resolve(__dirname, '..', '..', '..');

/** The CLI entry point to spawn. Must exist (produced by `npm run build`). */
const CLI_ENTRY = path.join(REPO_ROOT, 'dist', 'cli.js');

// ── Types ──────────────────────────────────────────────────────────────────

/**
 * Result of a `runCli` invocation.
 */
export interface CliResult {
  /** Process exit code — `null` if the process was killed (timeout/signal) or a spawn error occurred. */
  exitCode: number | null;
  /** Combined stdout as a string (UTF-8). */
  stdout: string;
  /** Combined stderr as a string (UTF-8). */
  stderr: string;
  /**
   * True when the process was killed because it exceeded `timeoutMs`.
   * When `timedOut` is true, `exitCode` is `null`.
   */
  timedOut: boolean;
  /**
   * Set when `spawnSync` itself fails before the child could run — e.g. ENOENT
   * for the node binary, a pre-exec OS error, or a Windows access-denied on
   * spawn. Distinct from the child exiting with a non-zero code. When set,
   * `exitCode` is `null` and `stdout`/`stderr` are empty.
   */
  error?: Error;
}

/**
 * Options for `runCli`.
 */
export interface RunCliOptions {
  /**
   * Temporal gRPC address for the ephemeral test server.
   * Typically `getTestEnvAddress(testEnv)` (see helper below).
   * Set as `TEMPORAL_ADDRESS` env var so the CLI connects to the right server.
   */
  temporalAddress?: string;

  /**
   * Temporal namespace. Defaults to `'default'` — matches the namespace used
   * by `TestWorkflowEnvironment.createLocal()`.
   */
  temporalNamespace?: string;

  /**
   * Additional environment variables merged on top of the defaults.
   * Use to inject `AGENT_TEMPO_DEV_MODE=1`, `AGENT_TEMPO_HOME`, etc.
   * Values here take precedence over harness defaults.
   */
  env?: Record<string, string>;

  /**
   * Maximum wall-clock time to wait for the spawned process, in milliseconds.
   * Defaults to 15 000 ms. When exceeded, the process is killed (SIGTERM on
   * POSIX, `taskkill /F` on Windows via Node's spawnSync timeout) and
   * `result.timedOut` is `true`.
   */
  timeoutMs?: number;

  /**
   * Working directory for the spawned process.
   * Defaults to the repo root so relative paths in the CLI resolve correctly.
   */
  cwd?: string;
}

// ── Core function ──────────────────────────────────────────────────────────

/**
 * Spawn `node dist/cli.js <args>` synchronously and return the captured
 * result. Uses `spawnSync` (blocking) so tests can use straightforward
 * `const result = runCli(...)` without managing async child-process streams.
 * Works fine inside `async it()` bodies — Mocha awaits the promise; the sync
 * call blocks only the current microtask, not other test suites.
 *
 * @param args  argv to pass after `dist/cli.js`, e.g. `['upgrade-to-2', '--dry-run']`
 * @param opts  harness options — see {@link RunCliOptions}
 * @returns     {@link CliResult} with exit code, stdout, stderr, timeout flag, and
 *              spawn-level error (if any)
 *
 * @throws {Error} if `dist/cli.js` does not exist (build not run) — use the
 *         clear build-not-run error rather than an opaque ENOENT from spawnSync
 *
 * @example
 * ```ts
 * const r = runCli(['upgrade-to-2', '--dry-run'], { temporalAddress: addr });
 * assert.equal(r.exitCode, 0);
 * assert.match(r.stdout, /Dry-run complete/);
 * ```
 */
export function runCli(args: string[], opts: RunCliOptions = {}): CliResult {
  // Guard: dist/cli.js must exist. A missing build is a common footgun in
  // worktrees and gives a confusing "ENOENT" from spawnSync otherwise.
  if (!fs.existsSync(CLI_ENTRY)) {
    throw new Error(
      `[cli-harness] dist/cli.js not found at ${CLI_ENTRY}. ` +
      `Run 'npm run build' (or 'npm run build:bundle' in a worktree) before running CLI harness tests.`,
    );
  }

  const timeoutMs = opts.timeoutMs ?? 15_000;
  const cwd = opts.cwd ?? REPO_ROOT;

  // Build the child environment. Inherit the current process's env (for PATH,
  // HOME, etc.) but override Temporal coordinates and test-mode flags.
  const childEnv: Record<string, string> = {
    ...filterEnv(process.env),
    // ── Temporal coordinates ──
    ...(opts.temporalAddress ? { TEMPORAL_ADDRESS: opts.temporalAddress } : {}),
    TEMPORAL_NAMESPACE: opts.temporalNamespace ?? 'default',
    // Clear any inherited dev-mode flag so tests run against the production
    // surface by default. `dev-mode-bootstrap.ts` promotes `--dev` into
    // AGENT_TEMPO_DEV_MODE (ADR 0014 §5.4) — scrubbing that var is sufficient.
    // Re-enable via opts.env when a test specifically exercises dev mode.
    AGENT_TEMPO_DEV_MODE: '',
    // ── Caller overrides (last — highest precedence) ──
    ...opts.env,
  };

  const result = spawnSync(process.execPath, [CLI_ENTRY, ...args], {
    cwd,
    env: childEnv,
    encoding: 'utf-8',
    timeout: timeoutMs,
    // Capture both stdio streams separately.
    stdio: ['ignore', 'pipe', 'pipe'],
    // `windowsHide: true` suppresses the console window on Windows CI.
    windowsHide: true,
  });

  const timedOut = result.status === null && result.signal === 'SIGTERM';

  return {
    exitCode: result.status,
    stdout: result.stdout ?? '',
    stderr: result.stderr ?? '',
    timedOut,
    // Surface spawn-level errors (ENOENT, pre-exec OS failure, etc.) so
    // callers aren't left with a silent exitCode: null / empty streams.
    ...(result.error ? { error: result.error } : {}),
  };
}

// ── Helpers ────────────────────────────────────────────────────────────────

/**
 * Filter `process.env` to only string values (Node types it as
 * `Record<string, string | undefined>` but `spawnSync`'s `env` only
 * accepts `Record<string, string>`).
 */
function filterEnv(raw: NodeJS.ProcessEnv): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(raw)) {
    if (typeof v === 'string') out[k] = v;
  }
  return out;
}

/**
 * Extract the Temporal address from a `TestWorkflowEnvironment` instance.
 *
 * `TestWorkflowEnvironment` doesn't expose its gRPC address directly on a
 * stable public field. This helper covers two known shapes:
 *   1. `.options.connection.address` — present in `@temporalio/testing` ≥ 1.10
 *   2. `.nativeConnection.address` — earlier versions
 *
 * Falls back to `'127.0.0.1:7233'` (the `createLocal` default) when neither
 * field is set, which is correct for the common single-server test setup.
 *
 * Pass the result as `temporalAddress` to `runCli`:
 * ```ts
 * const r = runCli(['status'], { temporalAddress: getTestEnvAddress(testEnv) });
 * ```
 *
 * @param testEnv  a `TestWorkflowEnvironment` obtained from `setupTestEnv()`
 */
export function getTestEnvAddress(testEnv: {
  options?: { connection?: { address?: string } };
  nativeConnection?: { address?: string };
}): string {
  return (
    testEnv.options?.connection?.address ??
    testEnv.nativeConnection?.address ??
    '127.0.0.1:7233'
  );
}

/**
 * Build a minimal set of CLI options that point at a `TestWorkflowEnvironment`
 * address. Convenience wrapper so callers don't repeat the address extraction.
 *
 * ```ts
 * const r = runCli(['version'], cliOptsFor(testEnv));
 * ```
 */
export function cliOptsFor(
  testEnv: Parameters<typeof getTestEnvAddress>[0],
  overrides: RunCliOptions = {},
): RunCliOptions {
  return {
    temporalAddress: getTestEnvAddress(testEnv),
    ...overrides,
  };
}
