import { defineConfig } from 'vitest/config';

/**
 * Vitest configuration for TUI/client pure-logic unit tests.
 *
 * Phase 1 unit tests live under `tests/tui/` and `tests/client/`.
 * Temporal workflow/activity tests continue to run under Mocha via
 * the `test` script — this config targets ONLY the pure-logic layer.
 *
 * See issue #105 for the testing strategy breakdown.
 */
export default defineConfig({
  test: {
    include: [
      'tests/tui/**/*.test.ts',
      'tests/client/**/*.test.ts',
      'tests/ensemble/**/*.test.ts',
      'tests/config/**/*.test.ts',
      'tests/cli/**/*.test.ts',
      'tests/reconcile/**/*.test.ts',
      'tests/http/**/*.test.ts',
      'tests/utils/**/*.test.ts',
    ],
    environment: 'node',
    globals: false,
    // Keep these tests fast — no Ink, no Temporal, no I/O beyond mocks.
    testTimeout: 5000,
  },
});
