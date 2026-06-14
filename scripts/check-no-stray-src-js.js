#!/usr/bin/env node
/**
 * check-no-stray-src-js.js — Assert `src/` is pure TypeScript source.
 *
 * Background (#839): a stray, gitignored compiled artifact
 * `src/utils/validation.js` (left behind by an editor/`tsc` run) silently
 * shadowed `validation.ts` in the vitest suite. Vite's default module
 * resolution tries `.js` BEFORE `.ts`, so `import '../utils/validation'`
 * resolved to the stale `.js` — which predated several constant blocks and
 * exported them as `undefined`. That single artifact produced 21 "Zod
 * regex" / "HTTP scaffold" failures across 8 files. Because the file was
 * gitignored + untracked, CI never saw it: the rot was local-only.
 *
 * `vitest.config.ts` now pins `resolve.extensions` so `.ts` wins, which
 * immunises the test runner. This guard is the belt-and-suspenders half:
 * it fails fast if ANY compiled artifact lands under `src/`, catching the
 * hazard at its source for every tool — not just vitest.
 *
 * Strategy: walk `src/` for `*.js`, `*.jsx`, `*.cjs`, `*.mjs`, `*.d.ts`,
 * and source maps. `src/` is authored exclusively in `.ts`/`.tsx`; any
 * emitted JavaScript there is a stray build artifact that must be removed
 * (compiled output belongs in `dist/`).
 *
 * Usage: node scripts/check-no-stray-src-js.js
 * Exit 0 = clean. Exit 1 = stray compiled artifact found.
 */
'use strict';

const fs   = require('fs');
const path = require('path');

const ROOT     = path.resolve(__dirname, '..');
const SRC      = path.join(ROOT, 'src');

/** Extensions that indicate compiled/emitted output, never hand-authored in src. */
const FORBIDDEN_EXT = /\.(js|jsx|cjs|mjs|d\.ts|js\.map|d\.ts\.map)$/;

/** Recursively collect files under `dir` whose name matches FORBIDDEN_EXT. */
function findStray(dir, results = []) {
  if (!fs.existsSync(dir)) return results;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      findStray(full, results);
    } else if (entry.isFile() && FORBIDDEN_EXT.test(entry.name)) {
      results.push(full);
    }
  }
  return results;
}

const stray = findStray(SRC);

if (stray.length > 0) {
  console.error('✗  Stray compiled artifact(s) found under src/ (src is TypeScript-only):');
  for (const file of stray) {
    console.error(`     ${path.relative(ROOT, file)}`);
  }
  console.error(
    '\nThese are likely a stray `tsc`/editor compile. They can silently shadow\n' +
    'the real `.ts` source (Vite resolves `.js` before `.ts`) and serve stale\n' +
    'exports to the test suite. Delete them — compiled output belongs in dist/.\n' +
    'See issue #839 for context.',
  );
  process.exit(1);
}

console.log('✓  No stray compiled artifacts under src/ (pure TypeScript source).');
process.exit(0);
