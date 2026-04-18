/**
 * Regression test for issue #157 — `claude-tempo daemon stop` must remain
 * operable even when the Temporal SDK is broken on the current Node
 * version. The guard is architectural: `src/cli/daemon-command.ts` must
 * have ZERO transitive imports from `@temporalio/*`, `rxjs`, `@grpc/*`,
 * `nice-grpc`, or any other Temporal-adjacent module.
 *
 * This test enforces that guard at the require-cache level by spawning a
 * clean child `node` process, loading the compiled `dist/cli/daemon-command.js`,
 * and asserting the resulting `require.cache` contains no matching keys.
 *
 * If a future edit introduces a Temporal-adjacent import to the daemon
 * command module (or any module in its dep graph), this test will fail
 * loudly in CI before the regression ever reaches users.
 */
import { expect } from 'chai';
import { execFileSync } from 'child_process';
import * as path from 'path';
import * as fs from 'fs';

const REPO_ROOT = path.resolve(__dirname, '..');
const DAEMON_COMMAND_DIST = path.join(REPO_ROOT, 'dist', 'cli', 'daemon-command.js');

/**
 * Keys that indicate a Temporal-adjacent module was loaded. Matching any of
 * these in require.cache after loading daemon-command.js means the architectural
 * guard is broken — some import in the dep graph is pulling in the heavy surface
 * this test is meant to exclude.
 */
const FORBIDDEN_PATTERNS: RegExp[] = [
  /[\\/]@temporalio[\\/]/,
  /[\\/]rxjs[\\/]/,
  /[\\/]@grpc[\\/]/,
  /[\\/]nice-grpc(?:-[^\\/]+)?[\\/]/,
  /[\\/]long[\\/]umd[\\/]/, // protobuf.js long — dragged in by @temporalio/proto
];

describe('daemon command isolation (#157 regression guard)', function () {
  // Compiled output must exist. `pretest` runs `tsc -p test/tsconfig.json`
  // which produces `dist-test/` for test code, but `npm run build` is what
  // produces `dist/cli/daemon-command.js`. Skip when the prod build hasn't
  // run — the full CI pipeline (`build` before `test`) produces both.
  before(function () {
    if (!fs.existsSync(DAEMON_COMMAND_DIST)) {
      this.skip();
    }
  });

  it('loading daemon-command.js does not leak any @temporalio/rxjs/grpc module', function () {
    // Run `node -e "..."` in a fresh process so we get a virgin require.cache.
    // The inline script:
    //   1. require()s the compiled daemon-command module
    //   2. scans require.cache for any key matching the forbidden patterns
    //   3. prints each hit and exits non-zero if any are found
    const script = `
      require(${JSON.stringify(DAEMON_COMMAND_DIST)});
      const forbidden = ${JSON.stringify(FORBIDDEN_PATTERNS.map((r) => r.source))};
      const regexes = forbidden.map((s) => new RegExp(s));
      const hits = Object.keys(require.cache).filter((k) => regexes.some((re) => re.test(k)));
      if (hits.length > 0) {
        console.error('LEAKED:\\n' + hits.join('\\n'));
        process.exit(1);
      }
      process.exit(0);
    `;

    // execFileSync throws on non-zero exit, which bubbles to the test as a failure
    // with the child's stderr included in the error message.
    expect(() =>
      execFileSync(process.execPath, ['-e', script], {
        stdio: ['ignore', 'pipe', 'pipe'],
        encoding: 'utf8',
      }),
    ).to.not.throw();
  });

  it('daemon-command source file contains no direct imports from forbidden packages', function () {
    // Defense in depth — the runtime check above catches transitive leaks via
    // any dep chain. This static check catches the direct-import case with a
    // clearer error message pointing at the exact line.
    const src = fs.readFileSync(
      path.join(REPO_ROOT, 'src', 'cli', 'daemon-command.ts'),
      'utf8',
    );
    const forbiddenImports = [
      '@temporalio/',
      '@grpc/',
      'nice-grpc',
      "'rxjs'",
      '"rxjs"',
      "'../client'", // brings in @temporalio/client
      "'../workflows",
      "'../adapters",
      "'../spawn'",
      "'../worker'",
    ];
    const hits = forbiddenImports.filter((pkg) => src.includes(pkg));
    expect(hits, `daemon-command.ts imports from forbidden package(s): ${hits.join(', ')}`).to.deep.equal([]);
  });
});
