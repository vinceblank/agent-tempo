#!/usr/bin/env node
/**
 * check-surface-drift.js — Verify docs/SURFACE-REGISTRY.md matches source.
 *
 * Checks three surfaces:
 *   1. MCP tools       src/tools/*.ts           defineTool(server, 'name', ...)
 *   2. CLI commands    src/cli.ts (switch cases) + version/help/daemon/upgrade/config
 *   3. TUI commands    src/tui/commands.ts       COMMANDS record → usage: '/name...'
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

/** Normalize a TUI command: take only the first whitespace-delimited token. */
function normalizeTui(s) {
  return s.split(/\s+/)[0];
}

// ── 1. MCP Tools ──────────────────────────────────────────────────────────────

function extractMcpToolsFromSource() {
  const dir = path.join(ROOT, 'src', 'tools');
  const files = fs.readdirSync(dir)
    .filter(f => f.endsWith('.ts') && f !== 'descriptor.ts');

  const tools = new Set();
  for (const file of files) {
    const src = fs.readFileSync(path.join(dir, file), 'utf8');
    // Post-MD-B (Phase 1): each tool is a `build<X>Tool(...): TempoToolDescriptor`
    // factory returning `{ name: '<tool>', description: ... }`. Match the
    // descriptor's `name` field anchored by the immediately-following
    // `description:` key — this avoids picking up unrelated `name:` properties
    // (e.g. inside handler bodies or param schemas). Replaces the pre-MD-B
    // `defineTool(server, 'name', …)` extraction (defineTool no longer exists).
    for (const m of src.matchAll(/name:\s*'([^']+)',\s*description:/g)) {
      tools.add(m[1]);
    }
  }
  return tools;
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

// ── 3. TUI Slash Commands ─────────────────────────────────────────────────────

function extractTuiCommandsFromSource() {
  const src = read('src/tui/commands.ts');

  // Scope to the COMMANDS record so we don't accidentally match TypeScript
  // interface declarations or comments above the record.
  const recordStart = src.indexOf('export const COMMANDS');
  if (recordStart === -1) {
    throw new Error('COMMANDS record not found in src/tui/commands.ts');
  }
  const section = src.slice(recordStart);

  const commands = new Set();
  // Each command has:  usage: '/name [args]',
  // Capture the leading /name token from the usage string.
  for (const m of section.matchAll(/usage:\s*'\/([\w-]+)/g)) {
    commands.add('/' + m[1]);
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

// Surface 3 — TUI slash commands (source gives /name; registry column can
// include arguments; normalize both sides to first whitespace token).
const tuiSource   = extractTuiCommandsFromSource();
const tuiRegistry = parseRegistryTableFirstCol(registry, '## 3. TUI Slash Commands');
const tuiDrift    = diff('TUI slash commands', tuiSource, tuiRegistry, normalizeTui, normalizeTui);

// ── Report ────────────────────────────────────────────────────────────────────

let driftFound = false;

for (const { label, undocumented, phantom } of [mcpDrift, cliDrift, tuiDrift]) {
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
