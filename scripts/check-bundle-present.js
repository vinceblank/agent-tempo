#!/usr/bin/env node
/**
 * Pretest guard (#694) — fail fast, with an actionable message, when the
 * prebuilt Temporal workflow bundle is missing.
 *
 * The Temporal integration tests (`test/`, mocha) load `workflow-bundle.js`,
 * which is produced by `npm run build` (the webpack pre-bundle step) — NOT by
 * `npm run build:test` (which only compiles `test/` → `dist-test/`). A worktree
 * builder who runs `npm test` (or a shard) without having run the full build
 * first has no bundle, and `setupTestEnv` would otherwise fail deep inside the
 * worker layer. Catching it here turns an opaque failure into a one-line fix.
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
    '  `npm run build:test` does NOT produce — it comes from `npm run build`.\n\n' +
    '  Run the full build first (worktree builders need BOTH):\n\n' +
    '      npm run build && npm run build:test\n',
  );
  process.exit(1);
}

if (fs.statSync(bundlePath).size === 0) {
  console.error(
    '\n✖ workflow-bundle.js is empty (a partial/failed build).\n\n' +
    '  Re-run the full build:\n\n' +
    '      npm run build\n',
  );
  process.exit(1);
}
