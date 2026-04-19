/**
 * Regression test for issue #157 — the recovery CLI commands must remain
 * operable even when the Temporal SDK is broken on the current Node
 * version. The guard is architectural: each module below must have ZERO
 * transitive imports from `@temporalio/*`, `rxjs`, `@grpc/*`, `nice-grpc`,
 * or any other Temporal-adjacent module.
 *
 * **How to add a new crash-proof module**: extend `CRASH_PROOF_MODULES`
 * below with `{ name, ts, dist, forbiddenImports? }`. The suite auto-runs
 * both the runtime require.cache scan and the static-import grep for
 * each entry. Pair the addition with:
 *   - A fast-path route in `src/cli.ts` that dynamic-imports the new
 *     module BEFORE `./cli/commands` is loaded.
 *   - Minimal imports in the module itself (stdlib + `./output` + its own
 *     sibling crash-proof modules only).
 *
 * If a future edit introduces a Temporal-adjacent import to any
 * enumerated module (or anything in its dep graph), this test will fail
 * loudly in CI before the regression ever reaches users.
 *
 * See also `dist/scripts/verify-daemon-isolation-guard.js` (built from
 * `scripts/verify-daemon-isolation-guard.ts` via `npm run build:scripts`) for
 * a one-shot manual check that confirms the detector's fail-path is working.
 */
import { expect } from 'chai';
import { execFileSync } from 'child_process';
import * as path from 'path';
import * as fs from 'fs';

// At runtime the compiled test lives at `dist-test/test/cli-crash-proof-isolation.test.js`,
// so `__dirname` is `<repo>/dist-test/test/`. Repo root is two levels up, not one —
// an earlier iteration of this test (PR A, before PR C consolidation) used a single
// `..` and silently skipped the entire suite because the dist path didn't exist.
// Leaving the comment here as a land-mine warning.
const REPO_ROOT = path.resolve(__dirname, '..', '..');

/**
 * Keys that indicate a Temporal-adjacent module was loaded. Matching any of
 * these in require.cache after loading a crash-proof module means the
 * architectural guard is broken — some import in its dep graph is pulling
 * in the heavy surface this test is meant to exclude.
 */
const FORBIDDEN_PATTERNS: RegExp[] = [
  /[\\/]@temporalio[\\/]/,
  /[\\/]rxjs[\\/]/,
  /[\\/]@grpc[\\/]/,
  /[\\/]nice-grpc(?:-[^\\/]+)?[\\/]/,
  /[\\/]long[\\/]umd[\\/]/, // protobuf.js long — dragged in by @temporalio/proto
];

/**
 * Packages whose **static imports** are forbidden in crash-proof modules.
 * Dynamic imports (`await import(...)`) are fine — they defer the load so a
 * broken SDK install still lets the module itself load. This distinction is
 * what makes `upgrade-command.ts` work: it CAN reference `@temporalio/client`
 * via dynamic import inside a try/catch, just not as a top-level static import.
 */
const FORBIDDEN_PACKAGES: readonly string[] = [
  '@temporalio/',
  '@grpc/',
  'nice-grpc',
  'rxjs',
];

/** Relative local modules that transitively pull in Temporal. */
const FORBIDDEN_LOCAL_MODULES: readonly string[] = [
  '../client',
  '../workflows',
  '../adapters',
  '../spawn',
  '../worker',
  '../connection',
];

/**
 * Build a regex that matches only top-level TypeScript **static** imports of
 * the given paths. Matches both `import X from 'pkg'` and side-effect
 * `import 'pkg'` forms. Does NOT match `await import(...)`, `require(...)`,
 * or substring mentions inside strings / comments.
 */
function staticImportRegex(paths: readonly string[]): RegExp {
  const alt = paths.map((p) => p.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|');
  // Anchor at line start (after optional leading whitespace). Allow either the
  // `from '...'` form (`import X from '...'`, `import { A, B } from '...'`) or
  // the side-effect form (`import '...'`).
  return new RegExp(`^\\s*import\\s+(?:[^'\"\\n]*?from\\s+)?['"](${alt})(?:[^'\"\\n]*)?['"]`, 'm');
}

interface CrashProofModule {
  /** Display name used in test titles. */
  name: string;
  /** Path (relative to repo root) of the TS source file, for the static-import grep. */
  ts: string;
  /** Path (relative to repo root) of the compiled JS, for the runtime require.cache scan. */
  dist: string;
}

const CRASH_PROOF_MODULES: readonly CrashProofModule[] = [
  // PR A — `claude-tempo daemon …`
  { name: 'daemon-command', ts: 'src/cli/daemon-command.ts', dist: 'dist/cli/daemon-command.js' },
  // PR C — `claude-tempo help`
  { name: 'help-text', ts: 'src/cli/help-text.ts', dist: 'dist/cli/help-text.js' },
  // PR C — `claude-tempo upgrade` (Temporal accessed via dynamic import only)
  { name: 'upgrade-command', ts: 'src/cli/upgrade-command.ts', dist: 'dist/cli/upgrade-command.js' },
  // PR C — `claude-tempo config` (connection test uses dynamic import)
  { name: 'config-command', ts: 'src/cli/config-command.ts', dist: 'dist/cli/config-command.js' },
];

/**
 * Counter used by the `after` hook below to detect silent-skip regressions.
 * Incremented once per assertion inside each `it(...)`. If the suite's
 * `before` hook ever gates all tests behind `this.skip()` again, this stays
 * at 0 and the `after` hook fails the suite loudly — closing the gap that
 * let PR A's isolation guarantee ship with a broken CI check (#157 PR C).
 */
let isolationAssertionsRun = 0;

describe('CLI crash-proof isolation (#157 regression guard)', function () {
  // Compiled output must exist for the runtime checks. `pretest` compiles the
  // test directory (dist-test/); `npm run build` produces `dist/cli/*.js`.
  // The project's canonical flow runs `build` before `test` so both exist.
  //
  // **IMPORTANT (#157 PR C retrospective)**: earlier iterations of this test
  // called `this.skip()` when a distfile was missing. That bug caused the
  // entire suite to skip silently when `__dirname` resolution was wrong —
  // PR A's isolation guarantee shipped with CI "green" that meant nothing.
  // We now FAIL LOUD instead. For the rare dev-loop where you want to run
  // `npm test` without a preceding `npm run build`, set
  // `SKIP_ISOLATION_TEST=1` — but that's an explicit opt-out, not a default.
  before(function () {
    if (process.env.SKIP_ISOLATION_TEST === '1') {
      // Explicit operator opt-out. Logged loudly so it's noticed in CI logs.
      // eslint-disable-next-line no-console
      console.warn('[cli-crash-proof-isolation] SKIPPED via SKIP_ISOLATION_TEST=1');
      this.skip(); // SKIP-REASON: explicit operator opt-out via SKIP_ISOLATION_TEST=1 env var — see module docstring
      return;
    }
    const missing = CRASH_PROOF_MODULES
      .map((m) => path.join(REPO_ROOT, m.dist))
      .filter((p) => !fs.existsSync(p));
    if (missing.length > 0) {
      throw new Error(
        `CLI isolation test requires compiled dist. Run 'npm run build' first. Missing:\n  ${missing.join('\n  ')}`,
      );
    }
  });

  after(function () {
    // Silent-skip detector. If no `it(...)` body actually executed an
    // assertion, the counter stays at 0 and we fail the suite with a
    // pointed error. Catches regressions where a `before` hook gate is
    // added and accidentally skips everything (the exact PR A bug).
    const expected = CRASH_PROOF_MODULES.length * 2; // runtime + static per module
    if (isolationAssertionsRun < expected) {
      throw new Error(
        `Silent-skip regression detected: expected ${expected} isolation assertions, ran ${isolationAssertionsRun}.`,
      );
    }
  });

  for (const mod of CRASH_PROOF_MODULES) {
    describe(mod.name, function () {
      it('loading the compiled module does not leak any @temporalio / rxjs / @grpc / nice-grpc / protobuf-long into require.cache', function () {
        isolationAssertionsRun++;
        const distPath = path.join(REPO_ROOT, mod.dist);
        // Run `node -e "..."` in a fresh process so we get a virgin require.cache.
        const script = `
          require(${JSON.stringify(distPath)});
          const forbidden = ${JSON.stringify(FORBIDDEN_PATTERNS.map((r) => r.source))};
          const regexes = forbidden.map((s) => new RegExp(s));
          const hits = Object.keys(require.cache).filter((k) => regexes.some((re) => re.test(k)));
          if (hits.length > 0) {
            console.error('LEAKED:\\n' + hits.join('\\n'));
            process.exit(1);
          }
          process.exit(0);
        `;
        expect(() =>
          execFileSync(process.execPath, ['-e', script], {
            stdio: ['ignore', 'pipe', 'pipe'],
            encoding: 'utf8',
          }),
        ).to.not.throw();
      });

      it('source file contains no static imports from forbidden packages', function () {
        isolationAssertionsRun++;
        // Defense in depth — the runtime check above catches transitive leaks
        // via any dep chain. This static check catches the direct-import case
        // with a clearer error message pointing at the exact line.
        //
        // Critical nuance: we match **static** import statements only. Dynamic
        // `await import('@temporalio/client')` is explicitly allowed — deferring
        // the load is how modules like `upgrade-command.ts` legitimately use
        // Temporal inside try/catch without breaking the crash-proof property.
        const src = fs.readFileSync(path.join(REPO_ROOT, mod.ts), 'utf8');
        // Strip line and block comments before regex-matching so doc comments
        // that reference forbidden package names (e.g. "don't import rxjs")
        // don't false-positive on the static-import regex.
        const stripped = src
          .replace(/\/\*[\s\S]*?\*\//g, '')
          .replace(/(^|[^:])\/\/.*$/gm, '$1');
        const pkgRegex = staticImportRegex(FORBIDDEN_PACKAGES);
        const localRegex = staticImportRegex(FORBIDDEN_LOCAL_MODULES);
        const pkgMatch = stripped.match(pkgRegex);
        const localMatch = stripped.match(localRegex);
        expect(
          pkgMatch,
          `${mod.ts} has static import of forbidden package: ${pkgMatch?.[0]}`,
        ).to.be.null;
        expect(
          localMatch,
          `${mod.ts} has static import of forbidden local module: ${localMatch?.[0]}`,
        ).to.be.null;
      });
    });
  }
});
