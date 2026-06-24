#!/usr/bin/env node
/**
 * check-surface-drift.js — Verify docs/SURFACE-REGISTRY.md matches source.
 *
 * Checks two surfaces:
 *   1. MCP tools       src/tools/*.ts           defineTool(server, 'name', ...)
 *   2. CLI commands    src/cli.ts (switch cases) + version/help/daemon/upgrade/config
 *
 * (The TUI slash-command surface was removed in #789 with the Ink TUI; the
 * command-center board registers its operator commands via `pi.registerCommand`
 * in `src/pi/mission-control/extension.ts`, which is not a drift surface.)
 *
 * Each surface is diffed against docs/SURFACE-REGISTRY.md:
 *   • "in source, not in registry" → undocumented surface — add it to the registry
 *   • "in registry, not in source" → phantom entry — remove it from the registry
 *
 * Usage: node scripts/check-surface-drift.js
 * Exit 0 = clean. Exit 1 = drift detected (diff printed to stderr).
 */
'use strict';

const fs   = require('fs');
const path = require('path');
const { execSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..');

// ── Helpers ───────────────────────────────────────────────────────────────────

/** Read a file relative to repo root. */
function read(rel) {
  return fs.readFileSync(path.join(ROOT, rel), 'utf8');
}

/**
 * Parse first-column values from a markdown table inside a registry section.
 *
 * Returns a Set of raw strings (still includes arguments, e.g. '<player>').
 * Callers normalize with `normalize*` helpers below.
 */
function parseRegistryTableFirstCol(registryContent, sectionTitle) {
  const sectionIdx = registryContent.indexOf(sectionTitle);
  if (sectionIdx === -1) {
    throw new Error(`Surface registry section not found: "${sectionTitle}"`);
  }
  // Slice from the heading to the next ## heading (or end of file).
  const afterHeading = registryContent.slice(sectionIdx + sectionTitle.length);
  const nextH2 = afterHeading.search(/\n## /);
  const section = nextH2 === -1 ? afterHeading : afterHeading.slice(0, nextH2);

  const entries = new Set();
  // Match rows: | `value` | ...
  for (const m of section.matchAll(/^\|\s*`([^`]+)`/gm)) {
    entries.add(m[1]);
  }
  return entries;
}

/** Normalize a CLI command: take only the first whitespace-delimited token. */
function normalizeCli(s) {
  return s.split(/\s+/)[0];
}

// ── 1. MCP Tools ──────────────────────────────────────────────────────────────

function extractMcpToolsFromSource() {
  // #793 §6 hardening — enumerate the ACTUAL registered tool names from
  // `buildAllTempoTools()` output (via scripts/enumerate-tool-names.ts), NOT a
  // source-regex scrape. The tool-family merge (#793) registers canonical tools
  // plus forwarding aliases; a `name: '...', description:` regex silently
  // under-counts any alias authored outside that exact adjacency — a #707-class
  // "scans nothing, reports clean" hazard. Building the list is immune to
  // authoring style: if a tool is registered, it's counted.
  let raw;
  try {
    raw = execSync('npx tsx scripts/enumerate-tool-names.ts', {
      cwd: ROOT,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    });
  } catch (err) {
    // FAIL-CLOSED — if we can't enumerate, we can't prove the surface is clean.
    // Surface the underlying tsx/build error rather than passing as "clean".
    const detail = (err && (err.stderr || err.message)) || String(err);
    throw new Error(
      'check-surface-drift: failed to enumerate MCP tool names via ' +
      `scripts/enumerate-tool-names.ts. Refusing to diff against an empty scan. See #793/#707.\n${detail}`,
    );
  }

  let names;
  try {
    names = JSON.parse(raw);
  } catch {
    throw new Error(
      'check-surface-drift: enumerate-tool-names.ts did not emit valid JSON. ' +
      `Got: ${raw.slice(0, 200)}`,
    );
  }

  // #707 — a check that scans nothing must never report success.
  if (!Array.isArray(names) || names.length === 0) {
    throw new Error(
      'check-surface-drift: enumerated 0 MCP tools from buildAllTempoTools() — ' +
      'the build enumeration is broken. Refusing to diff against an empty scan. See #707.',
    );
  }

  return new Set(names);
}

// ── 2. CLI Commands ───────────────────────────────────────────────────────────

/**
 * Known fall-through aliases in the cli.ts switch — canonical command is documented
 * under a different name in the registry. Exclude these from the "undocumented" set.
 */
const CLI_KNOWN_ALIASES = new Set([
  'attachment', // falls through to 'attachment-info'
  'cc',         // alias for 'command-center' (#729)
  'board',      // alias for 'command-center' (#729)
]);

function extractCliCommandsFromSource() {
  const src = read('src/cli.ts');
  const commands = new Set();

  // Extract case '...' labels from the main switch statement.
  for (const m of src.matchAll(/^\s+case '([^']+)':/gm)) {
    commands.add(m[1]);
  }

  // These are dispatched before the switch and are not case labels.
  // If you add a new pre-switch verb in src/cli.ts (e.g. an `if` branch before
  // the main `switch (args.command)`), add it here too or the drift detector
  // will report it as "in docs but not in source".
  for (const c of ['version', 'help', 'daemon', 'upgrade', 'config', 'dashboard', 'command-center']) {
    commands.add(c);
  }

  // Remove known aliases to avoid false-positive "undocumented" reports.
  for (const alias of CLI_KNOWN_ALIASES) {
    commands.delete(alias);
  }

  return commands;
}

// ── Diff helper ───────────────────────────────────────────────────────────────

/**
 * Compare two Sets. Returns { label, undocumented, phantom }.
 *
 * @param {string}   label
 * @param {Set}      fromSource   - names extracted from code
 * @param {Set}      fromRegistry - names extracted from SURFACE-REGISTRY.md
 * @param {Function} [normSource]   - optional normalizer applied to source names
 * @param {Function} [normRegistry] - optional normalizer applied to registry names
 */
function diff(label, fromSource, fromRegistry, normSource, normRegistry) {
  const src = new Set(normSource
    ? [...fromSource].map(normSource)
    : fromSource);
  const reg = new Set(normRegistry
    ? [...fromRegistry].map(normRegistry)
    : fromRegistry);

  return {
    label,
    undocumented: [...src].filter(x => !reg.has(x)).sort(),
    phantom:      [...reg].filter(x => !src.has(x)).sort(),
  };
}

// ── Main ──────────────────────────────────────────────────────────────────────

const registry = read('docs/SURFACE-REGISTRY.md');

// Surface 1 — MCP tools (exact name match; no normalization needed).
const mcpSource   = extractMcpToolsFromSource();
const mcpRegistry = parseRegistryTableFirstCol(registry, '## 1. MCP Tools');
const mcpDrift    = diff('MCP tools', mcpSource, mcpRegistry);

// Surface 2 — CLI commands (registry column can include arguments/flags;
// normalize both sides to first whitespace token for comparison).
const cliSource   = extractCliCommandsFromSource();
const cliRegistry = parseRegistryTableFirstCol(registry, '## 2. CLI Commands');
const cliDrift    = diff('CLI commands', cliSource, cliRegistry, normalizeCli, normalizeCli);

// ── Report ────────────────────────────────────────────────────────────────────

let driftFound = false;

for (const { label, undocumented, phantom } of [mcpDrift, cliDrift]) {
  if (undocumented.length === 0 && phantom.length === 0) {
    console.log(`✓  ${label}: clean`);
    continue;
  }
  driftFound = true;
  console.error(`\n✗  ${label}: drift detected`);
  if (undocumented.length > 0) {
    console.error('   In source but missing from docs/SURFACE-REGISTRY.md (add these):');
    undocumented.forEach(x => console.error(`     + ${x}`));
  }
  if (phantom.length > 0) {
    console.error('   In docs/SURFACE-REGISTRY.md but not found in source (remove these):');
    phantom.forEach(x => console.error(`     - ${x}`));
  }
}

if (driftFound) {
  console.error('\nUpdate docs/SURFACE-REGISTRY.md to match, then re-run: node scripts/check-surface-drift.js');
  process.exit(1);
}

console.log('\nSurface registry is up to date.');
process.exit(0);
