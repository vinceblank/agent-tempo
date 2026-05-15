/**
 * Smoke tests for dev-mode verb dispatch (#432) — argv → parser →
 * dev-mode gate → `dispatchDevVerb()` → verb handler.
 *
 * Verbs are exercised via `dist/cli.js` in a child process. Asserts that
 * dispatch reaches the verb (no "Unknown command", no removed-verbs hint)
 * and — for verbs that get past argparse — that the connection step is
 * reached. Forced `--temporal-address localhost:1` keeps the suite
 * deterministic regardless of any live dev daemon.
 */
import { expect } from 'chai';
import { spawnSync } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';

const REPO_ROOT = path.resolve(__dirname, '..', '..');
const CLI_ENTRY = path.join(REPO_ROOT, 'dist', 'cli.js');

/**
 * Run `node dist/cli.js --dev <args...>` and capture exit + streams.
 * `--dev` triggers the bootstrap module's env-var promotion before
 * cli.ts loads, so `isDevMode()` returns true for this invocation.
 *
 * `--temporal-address localhost:1` is forced for every invocation so any
 * verb that gets past argparse and tries to connect fails fast at the
 * 3-second connection timeout — keeps the suite deterministic regardless
 * of whether a real dev daemon happens to be running on the test host
 * (a live daemon would let `pause` / `play` / `release` actually fan out
 * across the ensemble, which is wrong for a unit smoke test).
 */
function runDev(...args: string[]): { status: number | null; stdout: string; stderr: string } {
  const result = spawnSync(process.execPath, [CLI_ENTRY, '--dev', '--temporal-address', 'localhost:1', ...args], {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    timeout: 8_000,
  });
  return {
    status: result.status,
    stdout: result.stdout || '',
    stderr: result.stderr || '',
  };
}

/**
 * Common negative assertions for any dev-verb invocation: the dispatch
 * reached the verb (didn't fall to "Unknown command" or removed-verbs
 * hint). Holds regardless of whether the verb succeeded or failed
 * downstream against Temporal.
 */
function assertReachedDevVerb(stderr: string, label: string): void {
  expect(
    stderr,
    `${label}: dispatch must reach the dev verb (no "Unknown command")`,
  ).to.not.match(/Unknown command/);
  expect(
    stderr,
    `${label}: dev-mode gate must fire BEFORE removed-verbs check (no "no longer a CLI verb")`,
  ).to.not.include('is no longer a CLI verb');
}

describe('CLI dev-verbs dispatch smoke (#432)', function () {
  before(function () {
    if (!fs.existsSync(CLI_ENTRY)) {
      throw new Error(
        `Smoke tests require compiled dist. Run 'npm run build' first. Missing: ${CLI_ENTRY}`,
      );
    }
  });

  describe('cue', function () {
    it('reaches the verb (its own usage error on missing args)', function () {
      const result = runDev('cue');
      expect(result.status).to.equal(1);
      expect(
        result.stderr,
        'cue handler should print its own usage error',
      ).to.match(/Usage:\s*agent-tempo\s+--dev\s+cue\s+<player>\s+<message>/);
      assertReachedDevVerb(result.stderr, 'cue');
    });

    it('reaches the verb when only player given (still missing message)', function () {
      const result = runDev('cue', 'alice');
      expect(result.status).to.equal(1);
      expect(result.stderr).to.match(/Usage:\s*agent-tempo\s+--dev\s+cue/);
      assertReachedDevVerb(result.stderr, 'cue');
    });
  });

  // The next three verbs have no required positional args, so they get
  // past argparse and hit `openClient()`. With the forced
  // `--temporal-address localhost:1` in `runDev`, the connection fails at
  // the 3-second timeout and the verb prints "Cannot connect to Temporal
  // at <addr>" to stderr — a strong positive signal that dispatch
  // reached the connection step (vs. falling through to a removed-verb
  // hint or unknown-command error).
  describe('pause', function () {
    it('intercepted by dev-mode gate, reaches connection step', function () {
      // `pause` was in REMOVED_VERBS before #432; its row was deleted in
      // the same PR that added it to DEV_VERBS. The dev-mode gate must
      // intercept first now.
      const result = runDev('pause');
      assertReachedDevVerb(result.stderr, 'pause');
      expect(result.stderr).to.match(/Cannot connect to Temporal at localhost:1/);
    });
  });

  describe('play', function () {
    it('reaches the verb, reaches connection step', function () {
      const result = runDev('play');
      assertReachedDevVerb(result.stderr, 'play');
      expect(result.stderr).to.match(/Cannot connect to Temporal at localhost:1/);
    });
  });

  describe('release', function () {
    it('reaches the verb (no-args ensemble-wide path), reaches connection step', function () {
      const result = runDev('release');
      assertReachedDevVerb(result.stderr, 'release');
      expect(result.stderr).to.match(/Cannot connect to Temporal at localhost:1/);
    });
  });

  describe('set-ensemble-description', function () {
    it('reaches the verb (its own usage error on missing description)', function () {
      const result = runDev('set-ensemble-description');
      expect(result.status).to.equal(1);
      expect(result.stderr).to.match(/Usage:\s*agent-tempo\s+--dev\s+set-ensemble-description/);
      assertReachedDevVerb(result.stderr, 'set-ensemble-description');
    });

    it('accepts empty string as clear-the-description (no usage error)', function () {
      // Shell preserves "" as an empty positional. The verb must NOT print
      // its usage error — proving the empty-string-is-clear branch is
      // accepted, not rejected by argparse.
      const result = runDev('set-ensemble-description', '');
      expect(
        result.stderr,
        'empty string is a valid "clear the description" input — usage must not fire',
      ).to.not.match(/Usage:\s*agent-tempo\s+--dev\s+set-ensemble-description/);
      assertReachedDevVerb(result.stderr, 'set-ensemble-description');
    });
  });

  describe('production parity (no --dev flag)', function () {
    function runProd(...args: string[]): { status: number | null; stderr: string } {
      const result = spawnSync(process.execPath, [CLI_ENTRY, ...args], {
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'pipe'],
        timeout: 12_000,
      });
      return { status: result.status, stderr: result.stderr || '' };
    }

    it('production `pause` is now Unknown command (row deleted from REMOVED_VERBS in #432)', function () {
      const result = runProd('pause');
      expect(result.status).to.equal(1);
      expect(result.stderr).to.match(/Unknown command:?\s*pause/);
      // Inverse: it should NOT have been intercepted by dev-mode logic.
      expect(result.stderr).to.not.include('[DEV MODE]');
    });

    it('production `cue` is Unknown command (never was a production verb)', function () {
      const result = runProd('cue', 'alice', 'hi');
      expect(result.status).to.equal(1);
      expect(result.stderr).to.match(/Unknown command:?\s*cue/);
    });

    it('production `resume` still hits the removed-verbs hint (row preserved)', function () {
      // Sanity check that the row deletion was scoped to `pause` and the
      // discipline rule didn't accidentally remove other rows.
      const result = runProd('resume');
      expect(result.status).to.equal(1);
      expect(result.stderr).to.match(/"resume" is no longer a CLI verb/);
      expect(result.stderr).to.include('/play');
    });
  });
});
