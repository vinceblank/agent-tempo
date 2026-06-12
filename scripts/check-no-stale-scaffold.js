#!/usr/bin/env node
/**
 * check-no-stale-scaffold.js — Verify no PR-era scaffold placeholder text
 * remains in rendered component files.
 *
 * Background (#375): the v0.28.0-beta.4 dashboard shipped with two cosmetic
 * bugs originating from the PR-2 scaffold commit (#366):
 *   - Sidebar aria-labels reading "Navigation lights up in PR-4 of #340"
 *   - AppShell PageHeader subtitle reading "Dashboard scaffold (PR-2 of #340)"
 *
 * Both were fixed organically during the #389 dashboard rebuild, but the
 * issue was never explicitly tested. This lint guard ensures they don't
 * silently regress.
 *
 * Strategy: grep *.tsx component files (not *.ts lib files, where "PR-N of
 * #N" legitimately appears in JSDoc attribution comments) for the pattern
 * `PR-\d+ of #\d+`. A match in a component file means scaffold text is
 * exposed to the UI.
 *
 * Usage: node scripts/check-no-stale-scaffold.js
 * Exit 0 = clean. Exit 1 = forbidden text found.
 */
'use strict';

const fs   = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');

/** Glob all *.tsx files under a directory recursively. */
function findTsx(dir, results = []) {
  if (!fs.existsSync(dir)) return results;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      findTsx(full, results);
    } else if (entry.isFile() && entry.name.endsWith('.tsx')) {
      results.push(full);
    }
  }
  return results;
}

/** Directories whose *.tsx files are checked. */
const SEARCH_DIRS = [
  path.join(ROOT, 'dashboard', 'src'),
];

/** Pattern that should never appear in rendered component files. */
const FORBIDDEN = /PR-\d+ of #\d+/;

/**
 * Lines that are purely comments (single-line `//` or block-comment `*`
 * continuations). These may legitimately reference PR numbers for
 * attribution/context — we only care about UI-rendered text.
 */
const COMMENT_LINE = /^\s*(\/\/|\/\*|\*)/;

let found = false;

for (const dir of SEARCH_DIRS) {
  for (const file of findTsx(dir)) {
    const content = fs.readFileSync(file, 'utf8');
    const lines = content.split('\n');
    for (let i = 0; i < lines.length; i++) {
      if (COMMENT_LINE.test(lines[i])) continue;
      if (FORBIDDEN.test(lines[i])) {
        const rel = path.relative(ROOT, file);
        console.error(`✗  Stale scaffold text in ${rel}:${i + 1}`);
        console.error(`     ${lines[i].trim()}`);
        found = true;
      }
    }
  }
}

if (found) {
  console.error(
    '\nRemove PR-era placeholder text from component files. ' +
    'See issue #375 for context.',
  );
  process.exit(1);
}

console.log('✓  No stale scaffold text in component files.');
process.exit(0);
