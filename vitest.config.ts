import { defineConfig } from 'vitest/config';
import { fileURLToPath, URL } from 'node:url';

/**
 * Vitest configuration for pure-logic unit tests.
 *
 * Phase 1 unit tests live under `tests/` (client, cli, http, pi, tools, …).
 * Temporal workflow/activity tests continue to run under Mocha via the `test`
 * script — this config targets ONLY the pure-logic layer. (The `tests/tui/`
 * suite was removed with the Ink TUI in #789.)
 *
 * See issue #105 for the testing strategy breakdown.
 */
export default defineConfig({
  // `src/` is TypeScript-only. Resolve `.ts` ahead of `.js` so a stray
  // compiled artifact (e.g. an editor/`tsc` run that drops `src/**/*.js`)
  // can never shadow the real source — Vite's default order puts `.js`
  // first, which silently serves stale exports to the suite (#839).
  resolve: {
    extensions: ['.ts', '.mts', '.tsx', '.mjs', '.js', '.jsx', '.json'],
  },
  test: {
    include: [
      'tests/client/**/*.test.ts',
      'tests/ensemble/**/*.test.ts',
      'tests/config/**/*.test.ts',
      'tests/cli/**/*.test.ts',
      'tests/reconcile/**/*.test.ts',
      'tests/http/**/*.test.ts',
      'tests/utils/**/*.test.ts',
      // ADR 0014 PR-2 — mock-adapter pure-logic unit tests (parser, prefix
      // parser, build-exclusion script harness, source-level recruit gate
      // + prefix-safety regressions).
      'tests/adapters/**/*.test.ts',
      // #334 PR-1 — player saveable state MCP tools (Zod schema validation,
      // error mapping, args propagation; no Temporal worker, no network).
      'tests/tools/**/*.test.ts',
      // #689 — no-echo spawn secret-env helpers (partition / writeSecretEnvFile /
      // fishQuote + the secret-not-in-command-string regression guard). Pure, no
      // process spawning.
      'tests/spawn/**/*.test.ts',
      // #695 — buildServerInstructions yield-norm content regression guard.
      'tests/server-tools/**/*.test.ts',
      // #700 P1 — Pi extension install helper (install-by-reference idempotency,
      // no-loose-copy invariant, __dirname-direct path resolution). Pure fs.
      'tests/pi/**/*.test.ts',
      // #748 — decision-path fence guard (pure fs source scan).
      'tests/conformance/**/*.test.ts',
      // #748 — pure workflow helpers (cadence resolver; no Temporal sandbox).
      'tests/workflows/**/*.test.ts',
      // #785 — upgrade-to-2 snapshot schema + persistence (Temporal-free
      // schema module; pure fs round-trip + validation guards).
      'tests/upgrade/**/*.test.ts',
      // #886 slice 1 — nondeterminism alarm (classifier, counter/snapshot,
      // logger wrapper, singleton; Temporal-value-free, pure logic).
      'tests/observability/**/*.test.ts',
      // #886 slice 2 — scanEnsembleSessionsCloud degraded-row behaviour
      // (getter module mocked to force the extraction-failure branch; no worker).
      'tests/activities/**/*.test.ts',
    ],
    // Scrub ambient AGENT_TEMPO_*/CLAUDE_TEMPO_* env vars before each file
    // and restore the clean baseline after each test (#744).
    // Absolute path bypasses Vite's URL transformer for the setup file so the
    // vite-worker spawn race ("Failed to load url tests/setup.ts") can't hit it.
    // A relative string goes through the Vite module server which fails
    // intermittently under heavy parallelism (#894). Belt-and-suspenders with
    // poolOptions.threads.maxThreads below.
    setupFiles: [fileURLToPath(new URL('./tests/setup.ts', import.meta.url))],
    environment: 'node',
    globals: false,
    // Keep these tests fast — no Ink, no Temporal, no I/O beyond mocks.
    testTimeout: 5000,
    // #894 — cap concurrent vitest worker threads to prevent the vite-worker
    // spawn race where `setupFiles` URL resolution fails under heavy
    // parallelism ("Failed to load url tests/setup.ts"). At 132+ test files,
    // unbounded spawning overwhelms Vite's internal module transformer; a cap
    // of 4 spreads the burst without meaningfully serialising the suite
    // (pure-logic tests complete in <15ms each). Hits CI Linux too, not just
    // Windows-local (#886 CI run). See also: dashboard/vitest.config.ts.
    poolOptions: {
      threads: {
        maxThreads: 4,
      },
    },
  },
});
