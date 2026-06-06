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
  /** The final `extensions` array written to settings.json. */
  extensions: string[];
}

/** Resolve the Pi settings.json path for the chosen scope. */
export function piSettingsPath(opts: InstallPiOptions = {}): string {
  if (opts.project) return join(opts.cwd ?? process.cwd(), '.pi', 'settings.json');
  return join(opts.home ?? homedir(), '.pi', 'agent', 'settings.json');
}

/**
 * Idempotently merge the two agent-tempo Pi extension absolute paths into Pi's
 * `settings.json` `"extensions"` array. Re-running is a no-op (no duplicates, no
 * write when nothing changed). Never copies any extension file — install by
 * reference only (see file header).
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

  const added: string[] = [];
  const alreadyPresent: string[] = [];
  const merged = [...current];
  for (const p of want) {
    if (merged.includes(p)) {
      alreadyPresent.push(p);
    } else {
      merged.push(p);
      added.push(p);
    }
  }
  settings.extensions = merged;

  // Idempotent: only write when something actually changed (or the file is
  // absent and must be created). A clean repeat run touches nothing.
  if (added.length > 0 || !fileExists) {
    mkdirSync(dirname(settingsPath), { recursive: true });
    writeFileSync(settingsPath, `${JSON.stringify(settings, null, 2)}\n`, 'utf8');
  }

  return { settingsPath, added, alreadyPresent, extensions: merged };
}
