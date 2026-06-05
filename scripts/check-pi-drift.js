#!/usr/bin/env node
/**
 * check-pi-drift.js — guard + invoke the Pi type-drift gate (#645 H4).
 *
 * Our Pi `ExtensionAPI`/tool shims (src/pi/pi-types.ts, src/pi/mission-control/
 * pi-ui.ts) are HAND-WRITTEN so the build/test suite stays green WITHOUT the
 * optional `@earendil-works/pi-coding-agent` dep installed. The cost is drift:
 * if Pi's real types change, our shims silently lie. test/pi-drift/assert.ts
 * imports the REAL Pi types and asserts our shims stay assignable; it fails to
 * COMPILE on drift. This script decides whether to run that compile:
 *
 *   - Pi NOT resolvable + Node >= 22.19  → ERROR + exit 1. Pi is expected here
 *     (CI's 22/24 lanes install optionalDeps), so a missing Pi is a real CI
 *     regression — NOT a silent skip.
 *   - Pi NOT resolvable + Node < 22.19   → skip (exit 0). Pi can't install on a
 *     sub-floor Node; the gate legitimately doesn't run on lean/Node-20 lanes.
 *   - Pi resolvable                      → run `tsc -p test/pi-drift/tsconfig.json
 *     --noEmit` and propagate its exit code (non-zero = drift).
 *
 * Usage: node scripts/check-pi-drift.js  (wired as `lint:pi-drift`, in check:all).
 */
'use strict';

const { execSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const PI_PACKAGE = '@earendil-works/pi-coding-agent';
const NODE_FLOOR = { major: 22, minor: 19 };

/** True when the live Node meets Pi's >=22.19 floor. */
function meetsNodeFloor() {
  const [major, minor] = process.versions.node.split('.').map((n) => parseInt(n, 10));
  if (major > NODE_FLOOR.major) return true;
  if (major < NODE_FLOOR.major) return false;
  return minor >= NODE_FLOOR.minor;
}

/**
 * Is Pi installed? Detected by FILESYSTEM WALK, not `require.resolve` — Pi is
 * ESM-only with an `exports` map and NO CJS-resolvable entry, so `require.resolve`
 * throws even when the package is present (this is exactly why src/utils/
 * sdk-probe.ts walks the tree too). Walk up from ROOT looking for the package's
 * package.json under any ancestor node_modules.
 */
function piInstalled() {
  let dir = ROOT;
  for (let i = 0; i < 8; i += 1) {
    if (fs.existsSync(path.join(dir, 'node_modules', PI_PACKAGE, 'package.json'))) return true;
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return false;
}

if (!piInstalled()) {
  if (meetsNodeFloor()) {
    // Anti-silent-noop: on a Node that CAN run Pi, a missing Pi means the gate
    // would never catch drift — treat that as a CI regression, not a skip.
    console.error(
      `[check-pi-drift] FAIL: ${PI_PACKAGE} is not installed, but Node ${process.versions.node} >= 22.19 ` +
        `is expected to have it (optionalDependencies). The drift gate cannot run — install Pi or fix the CI lane.`,
    );
    process.exit(1);
  }
  console.log(
    `[check-pi-drift] skipped: ${PI_PACKAGE} not installed and Node ${process.versions.node} < 22.19 ` +
      `(Pi can't install below its floor — the gate legitimately does not run on this lane).`,
  );
  process.exit(0);
}

// Pi present → run the type-level assertions. tsc exits non-zero on any drift.
// Call the local tsc entry directly (via `node`) rather than `npx` — avoids npx's
// resolution overhead and is cross-platform (no .bin shim / .cmd quirks).
const tscBin = require.resolve('typescript/bin/tsc');
try {
  execSync(`node "${tscBin}" -p test/pi-drift/tsconfig.json --noEmit`, { cwd: ROOT, stdio: 'inherit' });
  console.log('[check-pi-drift] OK: Pi shim types are assignable to the installed Pi 0.78 types.');
} catch {
  console.error(
    '[check-pi-drift] DRIFT DETECTED: a Pi shim type is no longer assignable to the installed Pi types ' +
      '(see the tsc errors above). Update the shim in src/pi/pi-types.ts or src/pi/mission-control/pi-ui.ts.',
  );
  process.exit(1);
}
