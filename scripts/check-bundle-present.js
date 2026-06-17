#!/usr/bin/env node
/**
 * Pretest guard (#694) — fail fast, with an actionable message, when the
 * prebuilt Temporal workflow bundle is missing.
 *
 * The Temporal integration tests (`test/`, mocha) load `workflow-bundle.js`,
 * which is produced by the webpack pre-bundle step — NOT by `npm run build:test`
 * (which only compiles `test/` → `dist-test/`). A worktree builder who runs
 * `npm test` (or a shard) without having produced the bundle first has none, and
 * `setupTestEnv` would otherwise fail deep inside the worker layer. Catching it
 * here turns an opaque failure into a one-line fix.
 *
 * The fast fix is `npm run build:bundle` (#720) — `tsc` + `build:scripts` + the
 * workflow bundle, SKIPPING the heavy `build:dashboard` (`npm --prefix dashboard
 * ci`) that the tests never need. `npm run build` also works but is slower.
 *
 * Exit 0 when the bundle is present and non-empty; exit 1 with guidance
 * otherwise. Pure Node, no deps — runs before `build:test`.
 */
'use strict';
const fs = require('fs');
const path = require('path');

const bundlePath = path.join(__dirname, '..', 'workflow-bundle.js');

if (!fs.existsSync(bundlePath)) {
  console.error(
    '\n✖ workflow-bundle.js is missing.\n\n' +
    '  The Temporal integration tests load a prebuilt workflow bundle that\n' +
    '  `npm run build:test` does NOT produce.\n\n' +
    '  Produce it first (fast — skips the dashboard build):\n\n' +
    '      npm run build:bundle\n\n' +
    '  (or `npm run build` for the full build incl. dashboard), then re-run the tests.\n',
  );
  process.exit(1);
}

if (fs.statSync(bundlePath).size === 0) {
  console.error(
    '\n✖ workflow-bundle.js is empty (a partial/failed build).\n\n' +
    '  Re-run the bundle build:\n\n' +
    '      npm run build:bundle\n',
  );
  process.exit(1);
}
