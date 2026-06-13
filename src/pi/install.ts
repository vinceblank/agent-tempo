/**
 * Install the agent-tempo Pi extensions the normal `.pi` way (#700 P1, design §8).
 *
 * One agent-tempo install ships TWO Pi extension entry points — the player
 * extension (`dist/pi/extension.js`, claims attachment / registers as a player)
 * and the command-center extension (`dist/pi/mission-control/extension.js`,
 * observer-only board + operator controller). `installPiExtensions()`
 * idempotently merges their ABSOLUTE dist paths into Pi's `settings.json`
 * `"extensions"` array.
 *
 * ── INSTALL-BY-REFERENCE, never a loose copy (design §8, load-bearing) ──
 * We point Pi's settings at the extension files *where they already live inside
 * the installed agent-tempo package* — we never copy a loose `.js` into
 * `~/.pi/agent/extensions/`. The reason is dependency resolution: our extension
 * imports `@temporalio/*`, `croner`, etc., which resolve via Node's upward
 * `node_modules` walk. That walk only finds our deps when the extension file
 * sits inside the agent-tempo package tree. A loose copy has no `node_modules`
 * beside it, so those bare imports would fail. Reference-install keeps Node's
 * resolution intact with zero copying.
 *
 * ── MUST-FIX 1: resolve the two paths DIRECTLY from `__dirname` ──
 * This file compiles to `<pkg>/dist/pi/install.js`, co-located with
 * `dist/pi/extension.js` and `dist/pi/mission-control/extension.js`. So the
 * paths are `join(__dirname, 'extension.js')` and
 * `join(__dirname, 'mission-control', 'extension.js')` — NOT
 * `resolve(__dirname, '..', …)` (that would yield `dist/dist/…`, the bug).
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'fs';
import { dirname, join, resolve } from 'path';
import { homedir } from 'os';

/**
 * Absolute paths to the two shipped Pi extension entry points.
 *
 * `__dirname` is `<pkg>/dist/pi` (this module compiles to `dist/pi/install.js`),
 * so both entry points are resolved relative to it directly (MUST-FIX 1).
 */
export function piExtensionPaths(): { player: string; missionControl: string } {
  return {
    player: resolve(__dirname, 'extension.js'),
    missionControl: resolve(__dirname, 'mission-control', 'extension.js'),
  };
}

export interface InstallPiOptions {
  /**
   * Install into the per-project `.pi/settings.json` (under `cwd`) instead of
   * the global `~/.pi/agent/settings.json`.
   */
  project?: boolean;
  /** Base dir for project-scope install. Defaults to `process.cwd()`. */
  cwd?: string;
  /** Override the home dir (tests). Defaults to `os.homedir()`. */
  home?: string;
}

export interface InstallPiResult {
  /** The settings.json file that was read/written. */
  settingsPath: string;
  /** Extension paths added by THIS run (empty on a repeat run — idempotent). */
  added: string[];
  /** Extension paths already present before this run. */
  alreadyPresent: string[];
  /**
   * #738 — STALE agent-tempo extension paths PRUNED by this run (old-version /
   * moved-install entries that pointed at an agent-tempo extension but are no
   * longer the current path). Empty on a clean re-run.
   */
  removed: string[];
  /** The final `extensions` array written to settings.json. */
  extensions: string[];
}

/**
 * #738 — does this settings `extensions` entry point at an agent-tempo Pi
 * extension (player or command-center), of ANY version / install location?
 *
 * The motivating bug: a `pnpm` global install version-hashes the package dir
 * (`.../.pnpm/agent-tempo@<version>_<hash>/node_modules/agent-tempo/...`), so on
 * UPGRADE the recorded absolute path goes stale — and a naive add-only install
 * leaves BOTH the old and new paths in `settings.json`, which makes `pi` fail on
 * the now-missing stale entry. {@link installPiExtensions} prunes every match of
 * this predicate (except the current paths) before re-adding, so a re-run
 * REPLACES rather than duplicates.
 *
 * Match = an agent-tempo package marker (`/agent-tempo@…` version dir, or the
 * `/node_modules/agent-tempo/` package dir) AND an agent-tempo extension suffix
 * (`dist/pi/extension.js` or `dist/pi/mission-control/extension.js`). Both halves
 * are required so a user's own unrelated extension is never pruned. Separators
 * are normalised so the predicate holds on Windows paths too.
 */
export function isAgentTempoExtensionPath(p: string): boolean {
  const n = p.replace(/\\/g, '/');
  const fromAgentTempo = n.includes('/agent-tempo@') || n.includes('/node_modules/agent-tempo/');
  const isExtensionEntry =
    n.endsWith('/dist/pi/extension.js') || n.endsWith('/dist/pi/mission-control/extension.js');
  return fromAgentTempo && isExtensionEntry;
}

/** Resolve the Pi settings.json path for the chosen scope. */
export function piSettingsPath(opts: InstallPiOptions = {}): string {
  if (opts.project) return join(opts.cwd ?? process.cwd(), '.pi', 'settings.json');
  return join(opts.home ?? homedir(), '.pi', 'agent', 'settings.json');
}

/**
 * #820 — are BOTH current agent-tempo Pi extension paths already registered in the
 * (global, unless `project`) Pi `settings.json`?
 *
 * `command-center` relies on the GLOBAL registration: it deliberately passes no
 * inline `-e` (that would double-load the mission-control extension), so a fresh
 * box that never ran `install-pi` would silently launch a PLAIN Pi session with no
 * board. The launcher uses this detector to decide whether a first-run auto-install
 * is needed BEFORE spawning Pi.
 *
 * A missing / unparseable settings file, or one missing either current path, → false
 * (the launcher then auto-installs). Mirrors {@link installPiExtensions}'s tolerant
 * parse: only a valid object with a string-array `extensions` counts.
 */
export function arePiExtensionsRegistered(opts: InstallPiOptions = {}): boolean {
  const settingsPath = piSettingsPath(opts);
  if (!existsSync(settingsPath)) return false;

  let extensions: string[] = [];
  try {
    const parsed = JSON.parse(readFileSync(settingsPath, 'utf8')) as unknown;
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      const arr = (parsed as Record<string, unknown>).extensions;
      if (Array.isArray(arr)) {
        extensions = arr.filter((x): x is string => typeof x === 'string');
      }
    }
  } catch {
    return false; // corrupt settings → treat as unregistered (auto-install will rewrite)
  }

  const { player, missionControl } = piExtensionPaths();
  return extensions.includes(player) && extensions.includes(missionControl);
}

/**
 * Idempotently merge the two agent-tempo Pi extension absolute paths into Pi's
 * `settings.json` `"extensions"` array. Re-running is a no-op (no duplicates, no
 * write when nothing changed). Never copies any extension file — install by
 * reference only (see file header).
 *
 * #738 — REPLACE, don't accumulate: before adding the current paths, PRUNE any
 * STALE agent-tempo extension entries ({@link isAgentTempoExtensionPath}, minus
 * the current paths). On a `pnpm` upgrade the package dir is version-hashed, so
 * the recorded absolute path changes — without pruning, `settings.json` would
 * list both the old (now-missing) and new paths and `pi` would fail on the stale
 * one. A user's own unrelated extensions and other settings keys are preserved.
 *
 * Tolerates a missing / empty / corrupt settings file: a missing file is
 * created; an unparseable one is replaced with a fresh object carrying just the
 * extensions (we can only safely merge a valid object). Other recognised keys in
 * a valid settings object are preserved.
 */
export function installPiExtensions(opts: InstallPiOptions = {}): InstallPiResult {
  const settingsPath = piSettingsPath(opts);
  const { player, missionControl } = piExtensionPaths();
  const want = [player, missionControl];

  let settings: Record<string, unknown> = {};
  const fileExists = existsSync(settingsPath);
  if (fileExists) {
    try {
      const parsed = JSON.parse(readFileSync(settingsPath, 'utf8')) as unknown;
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
        settings = parsed as Record<string, unknown>;
      }
    } catch {
      // Corrupt JSON — fall back to a clean object (can't safely merge into
      // something we can't parse). Other keys are unrecoverable in that case.
      settings = {};
    }
  }

  const current = Array.isArray(settings.extensions)
    ? (settings.extensions as unknown[]).filter((x): x is string => typeof x === 'string')
    : [];

  // #738 — prune STALE agent-tempo extension entries (an agent-tempo extension
  // path that is NOT one of the current `want` paths — e.g. an old version-hashed
  // pnpm dir). The current paths and all non-agent-tempo entries keep their
  // original positions.
  const removed = current.filter((p) => !want.includes(p) && isAgentTempoExtensionPath(p));
  const removedSet = new Set(removed);

  const added: string[] = [];
  const alreadyPresent: string[] = [];
  const merged = current.filter((p) => !removedSet.has(p));
  for (const p of want) {
    if (merged.includes(p)) {
      alreadyPresent.push(p);
    } else {
      merged.push(p);
      added.push(p);
    }
  }
  settings.extensions = merged;

  // Idempotent: only write when something actually changed (added, pruned, or the
  // file is absent and must be created). A clean repeat run touches nothing.
  if (added.length > 0 || removed.length > 0 || !fileExists) {
    mkdirSync(dirname(settingsPath), { recursive: true });
    writeFileSync(settingsPath, `${JSON.stringify(settings, null, 2)}\n`, 'utf8');
  }

  return { settingsPath, added, alreadyPresent, removed, extensions: merged };
}
