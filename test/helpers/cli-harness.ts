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
 * const env = getTestEnv();
 * const result = await runCli(['upgrade-to-2', '--dry-run'], {
 *   temporalAddress: env.options.connection.address,
 * });
 * assert.equal(result.exitCode, 0);
 * assert.match(result.stdout, /Dry-run complete/);
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
 * - **`AGENT_TEMPO_SKIP_PREFLIGHT=1` by default** — prevents the CLI's
 *   infra-preflight (Temporal SA registration, daemon auto-start) from
 *   blocking short-lived test invocations that only need the verb logic.
 *   Clear it by passing `skipPreflight: false` in options if a test
 *   specifically exercises the preflight path.
 *
 * - **Timeout** — defaults to 15 000 ms. Long enough for an ephemeral-server
 *   round-trip but tight enough that a hung verb fails the test quickly.
 *   Override via `timeoutMs` in options.
 *
 * - **No daemon, no daemon** — the harness sets `AGENT_TEMPO_SKIP_DAEMON=1`
 *   by default so the CLI doesn't try to contact or start a background daemon
 *   process during tests. Override via `skipDaemon: false` if needed.
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
  /** Process exit code — `null` if the process was killed (timeout/signal). */
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
}

/**
 * Options for `runCli`.
 */
export interface RunCliOptions {
  /**
   * Temporal gRPC address for the ephemeral test server.
   * Typically `testEnv.options?.connection?.address ?? '127.0.0.1:7233'`.
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

  /**
   * When `false`, does NOT inject `AGENT_TEMPO_SKIP_PREFLIGHT=1`.
   * Set to `false` only when a test specifically exercises the preflight path.
   * Default: `true` (skip preflight).
   */
  skipPreflight?: boolean;

  /**
   * When `false`, does NOT inject `AGENT_TEMPO_SKIP_DAEMON=1`.
   * Set to `false` only when a test specifically exercises the daemon path.
   * Default: `true` (skip daemon auto-start).
   */
  skipDaemon?: boolean;
}

// ── Core function ──────────────────────────────────────────────────────────

/**
 * Spawn `node dist/cli.js <args>` synchronously and return the captured
 * result. Uses `spawnSync` (blocking) so tests can use straightforward
 * `const result = runCli(...)` without the complexity of managing async
 * child-process streams.
 *
 * @param args  argv to pass after `dist/cli.js`, e.g. `['upgrade-to-2', '--dry-run']`
 * @param opts  harness options — see {@link RunCliOptions}
 * @returns     {@link CliResult} with exit code, stdout, stderr, and timeout flag
 *
 * @throws {Error} if `dist/cli.js` does not exist (build not run)
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
  const skipPreflight = opts.skipPreflight ?? true;
  const skipDaemon = opts.skipDaemon ?? true;

  // Build the child environment. Inherit the current process's env (for PATH,
  // HOME, etc.) but override Temporal coordinates and test-mode flags.
  const childEnv: Record<string, string> = {
    ...filterEnv(process.env),
    // ── Temporal coordinates ──
    ...(opts.temporalAddress ? { TEMPORAL_ADDRESS: opts.temporalAddress } : {}),
    TEMPORAL_NAMESPACE: opts.temporalNamespace ?? 'default',
    // ── Test-mode guards ──
    ...(skipPreflight ? { AGENT_TEMPO_SKIP_PREFLIGHT: '1' } : {}),
    ...(skipDaemon ? { AGENT_TEMPO_SKIP_DAEMON: '1' } : {}),
    // Ensure no inherited AGENT_TEMPO_DEV_MODE leaks into non-dev tests
    // (caller can re-enable it via opts.env if needed).
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
  };
}

// ── Async variant ──────────────────────────────────────────────────────────

/**
 * Async wrapper around `runCli` that offloads the blocking `spawnSync` call
 * to a `setImmediate`-deferred microtask. Keeps the Mocha event loop
 * responsive during long-running CLI invocations without pulling in the
 * full async child-process machinery.
 *
 * Use this in `it(...)` bodies that await a long CLI run (e.g. `upgrade-to-2`
 * against a real Temporal server). For sub-50ms verbs (`--version`, `--help`)
 * the synchronous `runCli` is fine — no await overhead.
 *
 * @example
 * ```ts
 * it('upgrade-to-2 --dry-run exits 0', async function () {
 *   this.timeout(20_000);
 *   const r = await runCliAsync(['upgrade-to-2', '--dry-run'], { temporalAddress: addr });
 *   assert.equal(r.exitCode, 0);
 * });
 * ```
 */
export function runCliAsync(args: string[], opts: RunCliOptions = {}): Promise<CliResult> {
  return new Promise((resolve, reject) => {
    setImmediate(() => {
      try {
        resolve(runCli(args, opts));
      } catch (err) {
        reject(err);
      }
    });
  });
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
 * Pass the result as `temporalAddress` to `runCli` / `runCliAsync`:
 * ```ts
 * const addr = getTestEnvAddress(testEnv);
 * const r = runCli(['status'], { temporalAddress: addr });
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
