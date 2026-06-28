/**
 * Gap 5 — `upgrade-to-2` CLI exit codes (#796 GA gate).
 *
 * Drives `node dist/cli.js upgrade-to-2 [flags]` as a child process via the
 * reusable CLI harness (#918) against the shared `TestWorkflowEnvironment`.
 * Tests in-process unit coverage can't reach: real `process.exitCode` /
 * `process.exit()` paths, dynamic-import crash guard, and the CLI's
 * `AGENT_TEMPO_HOME` / drain-timeout env wiring.
 *
 * Exit codes under test:
 *   C1  0  — `--dry-run` exits 0 and prints "Dry-run complete"
 *   C2  1  — connection failure (proxy for dynamic-import crash-guard path)
 *   C3  2  — version-floor refusal ("1.7.x version floor" — fixes stale "1.8.x")
 *   C4  3  — drain-stopped without `--force-drain`
 *   C5  0  — successful full cutover
 *
 * ## Spawn discipline
 *
 * Tests that use a `withWorker*` callback MUST use `await spawnCli(...)` (the
 * local async wrapper) NOT `runCli` (synchronous `spawnSync`). `spawnSync`
 * blocks the Node.js main thread, preventing the Temporal worker from
 * processing workflow tasks needed to answer queries from the CLI child process
 * — manifesting as a 24-second gRPC "slow call" on the query path.
 * `spawnCli` uses `spawn` (async) so the main thread stays free while waiting
 * for the child process to exit.
 *
 * C1 and C2 run WITHOUT a worker and use `runCli` (synchronous is fine there).
 *
 * Gap 6 (`up --from-upgrade` full CLI path) is DESCOPED: it would trigger
 * real `ensureInfra` (daemon + SA) against the ephemeral test server, and we
 * decided NOT to add a production skip-hook just to enable it. The dispatch
 * path is already covered at the unit level in `test/from-upgrade.test.ts`.
 *
 * Heavyweight (child-process + worker + workflow lifecycle) → pinned to
 * shard-1 in `test/shard-config.json` alongside the other cutover suites.
 */
import { spawn } from 'child_process';
import { expect } from 'chai';
import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join, resolve } from 'path';
import {
  setupSharedEnv,
  teardownTestEnv,
  getClient,
  getTestEnsemble,
  getTestEnvServerAddress,
  TASK_QUEUE,
  startSession,
  playerMetadata,
  conductorMetadata,
  withWorkerAndRecruitActivities,
  withWorkerAndGlobalMaestroActivities,
  pollWithTimeout,
} from './helpers';
import { GLOBAL_MAESTRO_WORKFLOW_ID } from '../src/config';
import {
  setPausedSignal,
  pausedQuery,
  submitOutboxUpdate,
  destroyUpdate,
} from '../src/workflows/signals';
import {
  enumerateEnsembleNames,
  type UpgradeDeps,
} from '../src/upgrade/phase-engine';
import { hostProfilesWithExistenceQuery } from '../src/workflows/maestro-signals';
import { runCli, type CliResult, type RunCliOptions } from './helpers/cli-harness';

const SILENT = (..._args: unknown[]): void => {};

// ── Local async spawn helper ───────────────────────────────────────────────
//
// Tests that run inside `withWorker*` callbacks MUST use this, NOT `runCli`.
// `spawnSync` blocks the main thread → worker can't process workflow tasks
// → CLI queries time out (24s gRPC slow call on the query path).
// `spawn` (async) keeps the main thread free while the child runs.
//
const REPO_ROOT = resolve(__dirname, '..', '..');
const CLI_ENTRY = join(REPO_ROOT, 'dist', 'cli.js');

async function spawnCli(args: string[], opts: RunCliOptions = {}): Promise<CliResult> {
  const timeoutMs = opts.timeoutMs ?? 15_000;
  const childEnv: Record<string, string> = {
    ...(process.env as Record<string, string>),
    TEMPORAL_NAMESPACE: opts.temporalNamespace ?? 'default',
    AGENT_TEMPO_DEV_MODE: '',
    AGENT_TEMPO_SKIP_PREFLIGHT: '1',
    AGENT_TEMPO_SKIP_DAEMON: '1',
    ...(opts.temporalAddress ? { TEMPORAL_ADDRESS: opts.temporalAddress } : {}),
    ...opts.env,
  };

  return new Promise<CliResult>((resolve) => {
    const proc = spawn(process.execPath, [CLI_ENTRY, ...args], {
      cwd: opts.cwd ?? REPO_ROOT,
      env: childEnv,
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
    });
    let stdout = '';
    let stderr = '';
    proc.stdout!.on('data', (d: Buffer) => { stdout += d.toString(); });
    proc.stderr!.on('data', (d: Buffer) => { stderr += d.toString(); });
    let settled = false;
    const timer = setTimeout(() => {
      if (!settled) {
        settled = true;
        proc.kill('SIGTERM');
        resolve({ exitCode: null, stdout, stderr, timedOut: true });
      }
    }, timeoutMs);
    proc.on('close', (code: number | null) => {
      if (!settled) {
        settled = true;
        clearTimeout(timer);
        resolve({ exitCode: code, stdout, stderr, timedOut: false });
      }
    });
  });
}

// ── Describe ──────────────────────────────────────────────────────────────

describe('upgrade-to-2 CLI exit codes (#796 Gap 5)', function () {
  before(setupSharedEnv);
  after(teardownTestEnv);

  // Fresh temp home per test — isolates snapshot files from parallel tests.
  let home: string;
  let temporalAddress: string;

  beforeEach(function () {
    home = mkdtempSync(join(tmpdir(), 'tempo-gap5-cli-'));
    temporalAddress = getTestEnvServerAddress();
  });

  afterEach(function () {
    rmSync(home, { recursive: true, force: true });
  });

  function deps(overrides: Partial<UpgradeDeps> = {}): UpgradeDeps {
    return {
      client: getClient(),
      home,
      cliVersion: '1.7.0-gap5',
      log: SILENT,
      ...overrides,
    };
  }

  async function waitForVisibility(ensemble: string): Promise<void> {
    await pollWithTimeout(
      async () => (await enumerateEnsembleNames(deps())).includes(ensemble),
      15_000,
      100,
    );
  }

  /**
   * CLI opts for tests WITHOUT a running worker — `runCli` (sync) is fine.
   * `AGENT_TEMPO_HOME_OVERRIDE` redirects snapshot I/O to the isolated temp
   * dir; the module-load-time `AGENT_TEMPO_HOME` constant in `config.ts` reads
   * this override, not a bare `AGENT_TEMPO_HOME` env var.
   */
  function cliOpts(extra: Record<string, string> = {}, timeoutMs = 25_000): RunCliOptions {
    return {
      temporalAddress,
      timeoutMs,
      env: {
        // `AGENT_TEMPO_HOME` is a module-load-time constant in config.ts —
        // it reads `AGENT_TEMPO_HOME_OVERRIDE` (not `AGENT_TEMPO_HOME`).
        // Setting the override directs snapshot I/O to the isolated temp dir.
        AGENT_TEMPO_HOME_OVERRIDE: home,
        ...extra,
      },
    };
  }

  // ── C1: --dry-run ──────────────────────────────────────────────────────────

  it('C1: --dry-run exits 0 and prints "Dry-run complete"', async function () {
    this.timeout(30_000);
    // No sessions needed — dry-run connects and enumerates (may find nothing)
    // then exits before modifying anything.
    // No worker needed → `runCli` (sync) is safe here.
    const r = runCli(['upgrade-to-2', '--dry-run', '--yes'], cliOpts());
    expect(r.exitCode, 'exit code 0 for dry-run').to.equal(0);
    expect(r.stdout, 'dry-run completion line').to.match(/Dry-run complete/);
    expect(r.timedOut, 'did not time out').to.be.false;
  });

  // ── C2: connection failure (exit 1) ───────────────────────────────────────

  it('C2: connection failure exits 1 with actionable "Could not connect" message', async function () {
    this.timeout(20_000);
    // Point at a port where no Temporal server is running. The CLI must catch
    // the connection error, print a helpful message, and exit 1 — same path as
    // the dynamic-import crash guard (both return 1 from upgradeToV2Command).
    // No worker needed → `runCli` (sync) is safe here.
    const r = runCli(
      ['upgrade-to-2', '--yes'],
      {
        ...cliOpts({}, 12_000),
        temporalAddress: '127.0.0.1:19999', // deliberately no server
      },
    );
    expect(r.exitCode, 'exit code 1 on connection failure').to.equal(1);
    expect(
      r.stderr + r.stdout,
      '"Could not connect" message (out.error → stderr)',
    ).to.match(/Could not connect/);
  });

  // ── C3: version-floor refusal (exit 2) ────────────────────────────────────

  it('C3: version-floor refusal exits 2 — fixed "1.7.x" message (was "1.8.x")', async function () {
    this.timeout(30_000);

    await withWorkerAndGlobalMaestroActivities({}, async () => {
      // Defensive: terminate any leftover global maestro from a prior test.
      try {
        await getClient().workflow.getHandle(GLOBAL_MAESTRO_WORKFLOW_ID).terminate('gap5-c3 reset');
      } catch { /* none running */ }

      // Start the global maestro advertising a stale daemon below the 1.7.0 floor.
      const gm = await getClient().workflow.start('agentGlobalMaestroWorkflow', {
        workflowId: GLOBAL_MAESTRO_WORKFLOW_ID,
        taskQueue: TASK_QUEUE,
        args: [
          {
            pollIntervalMs: 60_000,
            hostProfiles: { 'stale-host': { hostname: 'stale-host', version: '1.6.0' } },
          },
        ],
      });

      try {
        // Wait for the global maestro to have processed its initial state so
        // the CLI's preflight query returns the stale hostProfiles, not {}.
        await pollWithTimeout(
          async () => {
            try {
              const result = await getClient()
                .workflow.getHandle(GLOBAL_MAESTRO_WORKFLOW_ID)
                .query(hostProfilesWithExistenceQuery);
              return Object.keys(result.profiles).length > 0;
            } catch { return false; }
          },
          10_000, 100,
        );

        // IMPORTANT: use `await spawnCli` (async), NOT `runCli` (sync).
        // `runCli` blocks the main thread → worker can't answer queries → 24s
        // gRPC slow-call on the CLI's `fetchHostProfiles` path.
        const r = await spawnCli(['upgrade-to-2', '--yes'], cliOpts());
        expect(
          r.exitCode,
          `exit code 2 for version refusal (stdout: ${r.stdout.slice(0, 200)})`,
        ).to.equal(2);
        // The fixed message: "1.7.x version floor" (was "1.8.x" — typo fixed in this PR)
        expect(r.stderr, 'refused message names the correct floor version').to.match(/1\.7\.x version floor/);
      } finally {
        await gm.terminate('gap5-c3 cleanup').catch(() => {});
      }
    });
  });

  // ── C4: drain-stopped (exit 3) ────────────────────────────────────────────

  it('C4: drain-stopped exits 3 when outbox stalls without --force-drain', async function () {
    this.timeout(40_000);
    const ensemble = `${getTestEnsemble()}-gap5-drain`;

    await withWorkerAndRecruitActivities(async () => {
      // Seed a permanently-stuck outbox entry (session paused before enqueue).
      const blocker = await startSession({
        metadata: playerMetadata({ ensemble, playerId: 'blocker' }),
      });
      await blocker.signal(setPausedSignal, true);
      await pollWithTimeout(async () => (await blocker.query(pausedQuery)) === true, 10_000, 50);
      await blocker.executeUpdate(submitOutboxUpdate, {
        args: [{ type: 'cue', targetPlayerId: 'nobody', message: 'stuck' }],
      });
      await waitForVisibility(ensemble);

      // `AGENT_TEMPO_DRAIN_TIMEOUT_MS=2000` keeps the test fast — the engine
      // would otherwise wait the default 60 s for the outbox to clear.
      // IMPORTANT: use `await spawnCli` (async) — see module-level comment.
      const r = await spawnCli(
        ['upgrade-to-2', '--yes'],
        cliOpts({ AGENT_TEMPO_DRAIN_TIMEOUT_MS: '2000' }, 20_000),
      );
      expect(r.exitCode, 'exit code 3 for drain-stopped').to.equal(3);
      expect(r.stdout, '"stopped at DRAIN" message').to.match(/stopped at DRAIN/);

      // The upgrade engine must NOT have written a snapshot (SNAPSHOT-precedes-DESTROY).
      // Clean up the live session manually — it was NOT destroyed by the CLI.
      await blocker.executeUpdate(destroyUpdate, { args: [{}] });
      await blocker.result();
    });
  });

  // ── C5: successful cutover (exit 0) ───────────────────────────────────────

  it('C5: successful full cutover exits 0 and prints "Cutover complete"', async function () {
    this.timeout(40_000);
    const ensemble = `${getTestEnsemble()}-gap5-success`;

    await withWorkerAndRecruitActivities(async () => {
      const conductor = await startSession({ metadata: conductorMetadata({ ensemble }) });
      await waitForVisibility(ensemble);

      // The CLI drives the full upgrade protocol against the test server.
      // `AGENT_TEMPO_DRAIN_TIMEOUT_MS=3000` avoids the 60 s drain wait (empty
      // outbox drains immediately, but a short explicit bound makes it safe).
      // IMPORTANT: use `await spawnCli` (async) — see module-level comment.
      const r = await spawnCli(
        ['upgrade-to-2', '--yes'],
        cliOpts({ AGENT_TEMPO_DRAIN_TIMEOUT_MS: '3000' }),
      );
      expect(r.exitCode, 'exit code 0 for success').to.equal(0);
      expect(r.stdout, '"Cutover complete" completion message').to.match(/Cutover complete/);

      // Session was destroyed by the upgrade CLI — result() should resolve.
      await conductor.result();
    });
  });
});
