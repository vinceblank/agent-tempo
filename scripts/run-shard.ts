#!/usr/bin/env node
/**
 * Run a Mocha shard per `test/shard-config.json` (#231, design
 * `docs/design/191-test-parallelization.md` §2).
 *
 * Usage:
 *   node dist/scripts/run-shard.js <1|2>
 *
 *   shard-1 — run only the files listed in `shard-config.json` under
 *     `"shard-1"`. Runs Mocha with `--no-config` so positional args are the
 *     complete spec; the `require: root-hooks.js` + `timeout` + `exit`
 *     options from `.mocharc.yml` are forwarded as CLI flags to preserve the
 *     shared-env teardown hook and the existing 30s-per-test cap.
 *     Mocha 11's default spec from mocharc unions with CLI args rather than
 *     replacing, which is why we can't just pass positional args against the
 *     default config — that would silently run the full suite.
 *
 *   shard-2 — run the default `.mocharc.yml` spec minus the shard-1 files,
 *     via Mocha's `--ignore` flag. Mocharc config stays in charge so
 *     `root-hooks.js` etc. land via its `require:` key, no CLI duplication.
 *
 * The JSON is the single source of truth. Moving a file between shards is a
 * one-line edit; the rebalance rule lives in `test/README.md` (20% drift
 * bound). Build/clean is handled by `pretest:shard-*` hooks in
 * `package.json`, so this script only needs to fan args into Mocha.
 *
 * Exits with Mocha's own exit code (0 on success, non-zero on test failure
 * or spawn error) so `npm run test:shard-*` and CI see identical semantics
 * to a direct `mocha` invocation.
 */
import * as path from 'path';
import * as fs from 'fs';
import { spawnSync } from 'child_process';

const shard = process.argv[2];
if (shard !== '1' && shard !== '2') {
  console.error('Usage: node dist/scripts/run-shard.js <1|2>');
  process.exit(2);
}

const configPath = path.join(__dirname, '..', '..', 'test', 'shard-config.json');
const config = JSON.parse(fs.readFileSync(configPath, 'utf8'));
const shard1Sources: string[] = Array.isArray(config['shard-1']) ? config['shard-1'] : [];
if (shard1Sources.length === 0) {
  console.error('test/shard-config.json is missing or empty under "shard-1".');
  process.exit(2);
}

// Map each source path to its compiled .js under dist-test. The helper stays
// here (rather than in the JSON) so the JSON reads as a plain file list — no
// build-path leakage into a config that engineers edit during rebalance.
function toCompiled(sourcePath: string): string {
  return sourcePath
    .replace(/^test\//, 'dist-test/test/')
    .replace(/\.ts$/, '.js');
}
const shard1Compiled = shard1Sources.map(toCompiled);

// For shard-1 we bypass `.mocharc.yml` entirely (`--no-config`) because
// Mocha 11 unions the mocharc `spec:` glob with CLI args rather than
// letting CLI args override, so a positional-args-only approach would also
// pull in every file in the default glob. Forwarding `require` + `timeout`
// + `exit` by hand keeps the shared TestWorkflowEnvironment teardown hook
// wired up and the per-test timeout identical to a full-suite run.
const shard1CliMirrorOfMocharc: string[] = [
  '--no-config',
  '--require',
  'dist-test/test/root-hooks.js',
  '--timeout',
  '30000',
  '--exit',
];

const mochaArgs: string[] =
  shard === '1'
    ? [...shard1CliMirrorOfMocharc, ...shard1Compiled]
    : shard1Compiled.flatMap((f) => ['--ignore', f]);

// Resolve the local `mocha` binary directly rather than relying on PATH / npx
// wrapping — avoids an extra process on CI and keeps Windows + POSIX behaviour
// identical. `npm_execpath`-style lookup isn't worth the complexity for one
// dev-only script.
const mochaBin = path.join(
  __dirname,
  '..',
  '..',
  'node_modules',
  '.bin',
  process.platform === 'win32' ? 'mocha.cmd' : 'mocha',
);

console.log(
  `[run-shard] shard-${shard}: ${shard === '1' ? shard1Compiled.length + ' explicit files' : 'full spec minus ' + shard1Compiled.length + ' shard-1 files'}`,
);

const result = spawnSync(mochaBin, mochaArgs, {
  stdio: 'inherit',
  shell: process.platform === 'win32', // .cmd on Windows needs a shell
});

if (result.error) {
  console.error('[run-shard] failed to spawn mocha:', result.error.message);
  process.exit(1);
}
process.exit(result.status ?? 1);
