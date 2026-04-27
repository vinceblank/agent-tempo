#!/usr/bin/env node
/**
 * Build-exclusion gate (ADR 0014 §7 gate 1) — runs as the `prepack` lifecycle
 * script so npm publish, npm pack, and `npm install <git-url>` all see a
 * tarball with `dist/adapters/mock/` removed.
 *
 * The mock adapter is a dev-mode-only fixture. Defense in depth (registry
 * gate behind `isDevMode()`, recruit-time rejection of `agent: 'mock'`,
 * runtime banner) means even if this script silently fails the mock can't
 * actually run in production. But shipping the source-level surface to
 * users invites tampering and increases the published-package footprint
 * with code that can never be executed by design — so we strip it.
 *
 * The `verify-tarball` script asserts the directory is absent from the
 * generated tarball. CI runs `verify-tarball` between Build and Publish so
 * a regression here fails loud at release time.
 *
 * Pure Node, no deps. Idempotent — running twice is fine; running before
 * the directory exists is fine. Tests and dev workflows are unaffected
 * because the mock dist is rebuilt by the next `tsc` pass after pack.
 */
'use strict';
const fs = require('fs');
const path = require('path');

const targets = [
  // Compiled adapter implementation. ONLY this is stripped — the registry
  // gate at `src/adapters/index.ts` swallows a missing-module error so
  // production builds without this directory still boot cleanly.
  //
  // The repo-root `scenarios/` directory ships in the tarball (architect's
  // §4.8 first-class library artifact) — npm-install dev-mode users
  // running `claude-tempo --dev scenarios list` against a fresh package
  // need them to be discoverable, and they're inert without the adapter.
  path.join('dist', 'adapters', 'mock'),
];

let strippedAny = false;
for (const target of targets) {
  if (fs.existsSync(target)) {
    fs.rmSync(target, { recursive: true, force: true });
    console.log(`[strip-mock-adapter] removed ${target}`);
    strippedAny = true;
  }
}
if (!strippedAny) {
  console.log('[strip-mock-adapter] nothing to strip (clean tree or already stripped)');
}
