#!/usr/bin/env node
/**
 * Lint rule: every this.skip() call in test/ and tests/ must have a
 * // SKIP-REASON: comment on the same line or the line immediately above.
 *
 * This guards against silent skip regressions like PR #218's isolation test
 * (this.skip() in a before() hook was silently skipping the entire suite in
 * CI, reported as "pending" — PR #221 caught it). Closes #223.
 *
 * Usage: node scripts/lint-skip-reasons.js
 * Exit 0 = all skips annotated. Exit 1 = violations found.
 */
'use strict';

const fs = require('fs');
const path = require('path');

/** Recursively collect all .ts files under a directory. */
function collectTs(dir, results = []) {
  if (!fs.existsSync(dir)) return results;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      collectTs(full, results);
    } else if (entry.isFile() && entry.name.endsWith('.ts')) {
      results.push(full);
    }
  }
  return results;
}

const REPO_ROOT = path.resolve(__dirname, '..');
const TEST_DIRS = [path.join(REPO_ROOT, 'test'), path.join(REPO_ROOT, 'tests')];

const files = TEST_DIRS.flatMap((d) => collectTs(d));

// #707 — a source-walking check that enumerates ZERO files must never report
// "clean": a broken enumeration (wrong path, empty checkout, or — the bug
// that motivated this — a `dir/**/*.ext` glob that silently matches nothing
// on Windows) would otherwise pass while scanning nothing. Fail loud.
if (files.length === 0) {
  console.error(
    'lint-skip-reasons: enumerated 0 .ts files under test/ + tests/ — the ' +
    'file walk is broken (wrong path / empty checkout). Refusing to report ' +
    '"clean" on an empty scan. See #707.',
  );
  process.exit(1);
}

const violations = [];

for (const file of files) {
  const lines = fs.readFileSync(file, 'utf8').split('\n');
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (!line.includes('this.skip()')) continue;

    // Ignore occurrences inside single-line comments (// ...) or block-comment
    // lines (* ... or /* ...). These are documentation references, not live code.
    const trimmed = line.trimStart();
    if (trimmed.startsWith('//') || trimmed.startsWith('*') || trimmed.startsWith('/*')) continue;

    // Also ignore if this.skip() only appears after a // comment marker on the
    // same line (e.g. `// foo this.skip()`).
    const commentIdx = line.indexOf('//');
    const skipIdx = line.indexOf('this.skip()');
    if (commentIdx !== -1 && commentIdx < skipIdx) continue;

    const sameLine = line.includes('// SKIP-REASON:');
    // "immediately preceding non-blank line" — walk backwards skipping blanks
    let prevHasReason = false;
    for (let j = i - 1; j >= 0; j--) {
      const prev = lines[j].trim();
      if (prev === '') continue; // skip blank lines
      prevHasReason = prev.includes('// SKIP-REASON:');
      break;
    }

    if (!sameLine && !prevHasReason) {
      // line numbers are 1-based
      violations.push(`${file}:${i + 1}: this.skip() lacks // SKIP-REASON: comment`);
    }
  }
}

if (violations.length > 0) {
  for (const v of violations) {
    console.error(v);
  }
  process.exit(1);
}

console.log(`lint-skip-reasons: all this.skip() calls annotated (${files.length} file(s) scanned).`);
process.exit(0);
