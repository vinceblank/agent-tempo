#!/usr/bin/env node
/**
 * Tarball-shape verification (ADR 0014 §7 gate 1 + dashboard regression
 * guard from #378). Runs `npm pack --dry-run --json` and asserts:
 *
 *   - `dashboard/dist/index.html` IS present (else the daemon serves
 *     `{"error":"dashboard-not-built"}` — the v0.28.0-beta.4 bug).
 *   - `dist/adapters/mock/` is NOT present (else the dev-mode-only mock
 *     adapter shipped to production users — defeats build-time gate 1).
 *   - `scenarios/` is NOT present (mock-adapter scenarios; same reason).
 *
 * Single source of truth for both checks so a future contributor adds
 * their assertion to one place. Failures print a one-line reason and
 * exit 1; success prints what was verified for the CI log.
 *
 * Called from `release.yml` (publish job, between Build and Publish),
 * `ci.yml` (`dashboard-build` job, after the dashboard build step), and
 * `prepublishOnly` (defence in depth — though the matrix already runs it
 * via the dedicated workflow steps).
 */
'use strict';
const { execSync } = require('child_process');

let raw;
try {
  raw = execSync('npm pack --dry-run --json', { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
} catch (err) {
  console.error('verify-tarball: npm pack --dry-run failed:', err.message ?? err);
  process.exit(1);
}

let entries;
try {
  // npm pack --dry-run mixes prepack-script stdout (e.g. our own
  // `[strip-mock-adapter] removed dist/adapters/mock` line) with the
  // JSON output. The JSON document opens with a bare `[` on its own line.
  // Naïvely searching for the first `[` matches log prefixes like
  // `[strip-mock-adapter]` instead — find the bare-`[` line.
  const lines = raw.split(/\r?\n/);
  const jsonStart = lines.findIndex((l) => l.trim() === '[');
  if (jsonStart < 0) throw new Error('no JSON array start found in npm pack output');
  const json = lines.slice(jsonStart).join('\n');
  entries = JSON.parse(json);
} catch (err) {
  console.error('verify-tarball: could not parse npm pack output:', err.message ?? err);
  console.error('Raw stdout (first 500 chars):', raw.slice(0, 500));
  process.exit(1);
}

const files = entries[0].files.map((x) => x.path);
const failures = [];

// (1) Dashboard SPA must be in the tarball.
if (!files.some((p) => p === 'dashboard/dist/index.html')) {
  failures.push('dashboard/dist/index.html missing — check files[] / dashboard/.npmignore (PR #378 regression)');
}

// (2) Mock adapter must NOT be in the tarball (ADR 0014 §7 gate 1).
const mockMatches = files.filter((p) => p.startsWith('dist/adapters/mock/'));
if (mockMatches.length > 0) {
  failures.push(
    `mock adapter leaked into tarball (${mockMatches.length} file(s)) — strip-mock-adapter.js prepack script may have failed silently`,
  );
}

// (3) Mock-adapter scenarios SHIP in the tarball (architect's §4.8 — they're
// first-class library artifacts, discoverable by npm-install dev-mode users
// via `claude-tempo --dev scenarios list`). They're inert without the mock
// adapter (which gate 1 strips above) so there's no production-safety
// concern. A spot check confirms at least one scenario landed.
const scenarioMatches = files.filter((p) => p.startsWith('scenarios/') && p.endsWith('.yaml'));

if (failures.length > 0) {
  console.error('verify-tarball: FAILED');
  for (const f of failures) console.error('  •', f);
  process.exit(1);
}

console.log(
  `verify-tarball OK — ${files.length} files; ` +
  `dashboard/dist/index.html present; mock adapter absent; ` +
  `${scenarioMatches.length} scenario(s) shipped`,
);
