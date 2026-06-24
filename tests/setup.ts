/**
 * Global Vitest setup — environment isolation (#744).
 *
 * Problem: ~20 test files read `AGENT_TEMPO_*` / `CLAUDE_TEMPO_*` env vars.
 * When a developer runs `npm run test:tui` from an ensemble-player shell that
 * already exports these vars (e.g. `AGENT_TEMPO_DEV_MODE=1`), config-reading
 * tests see wrong values and produce false-negatives. The symptom: 19+ healthy
 * tests appear to fail, quarantining 64 passing tests (#742).
 *
 * Fix: this file is wired as `setupFiles` in `vitest.config.ts` so Vitest
 * executes it once per worker (= once per test file) before any test runs.
 * On load it scrubs all managed env keys to a known-clean baseline. The
 * `afterEach` below then restores that same baseline after every individual
 * test, catching mutations that individual tests make but do not clean up.
 *
 * Rules for individual test files:
 *   - Tests that need a specific env var set it explicitly in `beforeEach`.
 *   - Tests SHOULD keep their own save/restore for vars they mutate — the
 *     global afterEach is a safety net, not a replacement.
 *   - The original ambient env is intentionally NOT restored: the test
 *     process is isolated from the developer's shell by design.
 */
import { afterEach } from 'vitest';

const MANAGED_PREFIXES = ['AGENT_TEMPO_', 'CLAUDE_TEMPO_'] as const;

function isManagedKey(key: string): boolean {
  return MANAGED_PREFIXES.some((p) => key.startsWith(p));
}

/**
 * Collect every managed key present in the ambient environment at startup
 * and immediately delete them. This snapshot is kept only for the log
 * message below — the clean baseline IS simply "all managed keys absent".
 */
const ambientKeys = Object.keys(process.env).filter(isManagedKey);
if (ambientKeys.length > 0) {
  // Emit a single warning so a developer can see which vars were scrubbed.
  // We intentionally do NOT throw here — the scrub IS the fix, not a blocker.
  // eslint-disable-next-line no-console
  console.warn(
    `[tests/setup.ts] Scrubbed ${ambientKeys.length} ambient managed env var(s) from this test worker: ${ambientKeys.join(', ')}. ` +
      'Tests run against a clean baseline. Set them explicitly in beforeEach if a test needs them.',
  );
  for (const key of ambientKeys) {
    delete process.env[key];
  }
}

/**
 * After each test: delete any managed env vars the test left set.
 * This catches tests that set vars without a matching cleanup, preventing
 * bleed to the next test in the same file.
 */
afterEach(() => {
  for (const key of Object.keys(process.env)) {
    if (isManagedKey(key)) {
      delete process.env[key];
    }
  }
});
