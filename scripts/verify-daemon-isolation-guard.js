#!/usr/bin/env node
/**
 * Manual verification script for the #157 isolation guard
 * (`test/daemon-command-isolation.test.ts`).
 *
 * QA observation on PR #218: the isolation test asserts the guard PASSES on
 * the current daemon-command module, but never empirically verifies the
 * guard would FAIL if a forbidden import leaked in. This script plugs that
 * gap — run it as a one-shot sanity check (e.g. before a release or after
 * touching CLI imports) to confirm the detector's fail-side actually works.
 *
 * Usage:
 *   node scripts/verify-daemon-isolation-guard.js
 *
 * How it works:
 *   Spawns a child `node -e "..."` that (a) requires the compiled
 *   daemon-command module, then (b) ALSO requires `@temporalio/client` —
 *   simulating a hypothetical regression where daemon-command grew a
 *   forbidden import. Runs the same require.cache scan logic as the
 *   isolation test and asserts it DOES find `@temporalio/*` entries.
 *
 * The test in test/daemon-command-isolation.test.ts guards the pass path
 * (no Temporal leaks via daemon-command's own dep chain). This script
 * guards the detector itself — it confirms the scan would catch a leak.
 *
 * Exit 0 = guard-detector works correctly on a simulated regression.
 * Exit 1 = guard-detector silently accepted a forbidden import (bug in
 *          the detector itself, or the test's FORBIDDEN_PATTERNS array is
 *          missing a case).
 */
'use strict';

const path = require('path');
const fs = require('fs');
const { spawnSync } = require('child_process');

const REPO_ROOT = path.resolve(__dirname, '..');
const DAEMON_COMMAND_DIST = path.join(REPO_ROOT, 'dist', 'cli', 'daemon-command.js');

if (!fs.existsSync(DAEMON_COMMAND_DIST)) {
  console.error('dist/cli/daemon-command.js not found. Run `npm run build` before this script.');
  process.exit(1);
}

let temporalClientPath;
try {
  temporalClientPath = require.resolve('@temporalio/client', { paths: [REPO_ROOT] });
} catch (err) {
  console.error('Could not resolve @temporalio/client from repo node_modules. Run `npm install` first.');
  console.error(err && err.message);
  process.exit(1);
}

const detector = `
  // Step 1: load daemon-command (should leave require.cache clean of Temporal).
  require(${JSON.stringify(DAEMON_COMMAND_DIST)});
  // Step 2: simulate a regression — load @temporalio/client directly.
  // This is what would happen if a future edit to daemon-command (or one of
  // its deps) accidentally imported something Temporal-adjacent.
  require(${JSON.stringify(temporalClientPath)});
  // Step 3: run the same detector as test/daemon-command-isolation.test.ts.
  const forbidden = [
    /[\\\\/]@temporalio[\\\\/]/,
    /[\\\\/]rxjs[\\\\/]/,
    /[\\\\/]@grpc[\\\\/]/,
    /[\\\\/]nice-grpc(?:-[^\\\\/]+)?[\\\\/]/,
    /[\\\\/]long[\\\\/]umd[\\\\/]/,
  ];
  const hits = Object.keys(require.cache).filter((k) => forbidden.some((re) => re.test(k)));
  if (hits.length > 0) {
    console.log('Detector found ' + hits.length + ' forbidden module(s) in require.cache:');
    for (const h of hits.slice(0, 3)) console.log('  ' + h);
    if (hits.length > 3) console.log('  ... (' + (hits.length - 3) + ' more)');
    process.exit(0);
  }
  console.error('BUG: detector did not flag any of the injected forbidden modules.');
  process.exit(1);
`;

const result = spawnSync(process.execPath, ['-e', detector], {
  stdio: ['ignore', 'inherit', 'inherit'],
  cwd: REPO_ROOT,
});

if (result.status === 0) {
  console.log('\n✅ Isolation guard fail-path verified. The detector correctly flags forbidden imports.');
  console.log('   (The isolation test in test/daemon-command-isolation.test.ts will catch a real regression.)');
  process.exit(0);
} else {
  console.error('\n❌ Isolation guard fail-path NOT verified.');
  if (result.status === 1) {
    console.error('   The detector silently accepted injected forbidden imports — regression in the detector itself,');
    console.error('   OR the FORBIDDEN_PATTERNS array in test/daemon-command-isolation.test.ts is missing a case.');
  } else {
    console.error(`   Child exited with status ${result.status}. See output above for the cause.`);
  }
  process.exit(1);
}
