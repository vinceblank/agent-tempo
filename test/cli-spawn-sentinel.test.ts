/**
 * Regression test for #259 — every CLI spawn path that launches `claude.exe`
 * must include `ENSEMBLE_SENTINEL_FLAG <ensemble>` in its argv, so that the
 * hard-terminate path (src/activities/hard-terminate.ts) can scope
 * `destroy --all` kills by ensemble (#180).
 *
 * The bug caught by #259 was that `src/cli/commands.ts` had three
 * `claudeArgs` builders (one per spawn site: `up` player, standalone
 * conduct, `up` conductor) that drifted from the correct pattern in
 * `src/activities/outbox.ts` and omitted the sentinel entirely — making
 * `destroy` a silent no-op for every `up`-spawned process.
 *
 * This test is intentionally structural (it reads the source file and
 * inspects each builder) rather than runtime — exercising the CLI spawn
 * paths at runtime would require booting Temporal and actually spawning
 * processes. The invariant being guarded is a drift-prevention one:
 * "every claudeArgs builder in commands.ts contains ENSEMBLE_SENTINEL_FLAG",
 * which is exactly what a source-level test asserts.
 */
import { expect } from 'chai';
import { readFileSync } from 'fs';
import * as path from 'path';
import { ENSEMBLE_SENTINEL_FLAG } from '../src/constants';

// `__dirname` at runtime is `<repo>/dist-test/test` (Mocha runs the compiled
// JS), so `../..` reaches the repo root where `src/` actually lives. Same
// trick `test/wire-protocol.test.ts` uses for its docs-drift assertions.
const REPO_ROOT = path.resolve(__dirname, '..', '..');

describe('CLI spawn sentinel (#259)', function () {
  it('ENSEMBLE_SENTINEL_FLAG has the value hard-terminate greps for', function () {
    expect(ENSEMBLE_SENTINEL_FLAG).to.equal('--remote-control-session-name-prefix');
  });

  it('every claudeArgs builder in src/cli/commands.ts carries ENSEMBLE_SENTINEL_FLAG', function () {
    const src = readFileSync(path.join(REPO_ROOT, 'src', 'cli', 'commands.ts'), 'utf8');
    const builders = [...src.matchAll(/const claudeArgs = \[([\s\S]*?)\];/g)];
    expect(builders.length).to.be.at.least(
      3,
      `expected ≥3 claudeArgs builders in src/cli/commands.ts (up player + conduct + up conductor); found ${builders.length}`,
    );
    for (let i = 0; i < builders.length; i++) {
      const body = builders[i][1];
      expect(body).to.include(
        'ENSEMBLE_SENTINEL_FLAG',
        `claudeArgs builder #${i + 1} in src/cli/commands.ts is missing ENSEMBLE_SENTINEL_FLAG — hard-terminate would be a no-op for processes spawned from this path. See #259.`,
      );
    }
  });

  it('the recruit-path spawn (src/activities/outbox.ts) also carries the sentinel (regression guard for drift the other way)', function () {
    const src = readFileSync(path.join(REPO_ROOT, 'src', 'activities', 'outbox.ts'), 'utf8');
    expect(src).to.include(
      'ENSEMBLE_SENTINEL_FLAG',
      'recruit path lost ENSEMBLE_SENTINEL_FLAG — this was the pattern the CLI paths were supposed to mirror (#180).',
    );
  });
});
