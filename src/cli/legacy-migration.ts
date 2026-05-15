/**
 * Legacy home migration — `~/.claude-tempo/` → `~/.agent-tempo/`.
 *
 * PR-2 of the v1.0 rebrand renames the on-disk profile directory. This
 * helper performs a one-shot copy on first boot of the new binary so
 * users don't lose their saved config / lineups / state.
 *
 * Contract (see brief):
 *   1. **Idempotent.** Re-running on a migrated home is `'already-migrated'`.
 *   2. **Copy, not move.** Legacy `~/.claude-tempo/` stays untouched as a
 *      safety net for one release.
 *   3. **Marker file.** Writes `~/.agent-tempo/.migrated-from-claude-tempo`
 *      with `{ migratedAt, copiedFromHash, files }`.
 *   4. **Conflict policy.** If `~/.agent-tempo/` exists AND has no marker,
 *      refuse with `'skipped'`; user must pass `force: true` or delete.
 *      Don't clobber a user-initiated new home.
 *   5. **Partial-copy resume.** Per-file SHA-256 in the marker — re-running
 *      a partially-completed run finishes only the missing/changed files.
 *   6. **Files copied.** Allowlist — `config.json`, `.bootstrap-cache.json`,
 *      any `*.yaml` user-stashed lineup files, plus subdirs `lineups/`,
 *      `state/`, `coat-check/` (forward-compat — fine if absent). The
 *      volatile runtime trio (`daemon.pid`, `daemon.port`, `daemon.log`)
 *      is intentionally skipped — let the daemon recreate them.
 *   7. **Volatile-state guard.** If `daemon.pid` is present in the legacy
 *      home (likely-running daemon), refuses unless `force: true`.
 *
 * Single owner file — narrow blast radius. The CLI verb in `src/cli.ts`
 * and the bootstrap step in `src/cli/startup.ts` are the only callers.
 */
import * as fs from 'fs';
import * as path from 'path';
import * as crypto from 'crypto';
import { homedir } from 'os';
import { DEV_HOME_DIR_NAME, PROD_HOME_DIR_NAME } from '../config';

/** Legacy POSIX/macOS/Windows home dir name (pre-v1.0 rebrand). */
const LEGACY_PROD_HOME_DIR_NAME = '.claude-tempo';
const LEGACY_DEV_HOME_DIR_NAME = '.claude-tempo-dev';

/** Marker file name dropped in the new home post-migration. */
export const MIGRATION_MARKER_FILENAME = '.migrated-from-claude-tempo';

/** Volatile runtime state — never copied (daemon recreates on boot). */
const VOLATILE_FILES = new Set(['daemon.pid', 'daemon.port', 'daemon.log']);

/** Allowlisted top-level files. `*.yaml` is matched as a glob. */
const ALLOWLIST_FILES = new Set(['config.json', '.bootstrap-cache.json']);

/** Allowlisted top-level subdirs (recursive copy). Forward-compat — fine if absent. */
const ALLOWLIST_SUBDIRS = ['lineups', 'state', 'coat-check'];

export type MigrationStatus =
  | 'no-legacy'
  | 'already-migrated'
  | 'migrated'
  | 'skipped'
  | 'failed';

export interface LegacyMigrationResult {
  status: MigrationStatus;
  legacyHome?: string;
  newHome?: string;
  /** Relative paths inside the new home that were copied this run. */
  copiedFiles?: string[];
  /** Errors collected during partial-copy resume; populated when status === 'failed'. */
  errors?: string[];
  /** Set when status === 'skipped' to explain why. */
  reason?: string;
}

export interface LegacyMigrationOpts {
  /** Don't write anything; report what would happen. */
  dryRun?: boolean;
  /** Override the conflict guard (existing new-home without marker) AND the volatile-state guard. */
  force?: boolean;
  /** Which profile to migrate. `'prod'` = `~/.claude-tempo` → `~/.agent-tempo`; `'dev'` = `-dev` variants. Default `'prod'`. */
  profile?: 'prod' | 'dev';
  /** Test seam — override `homedir()`. */
  homeDir?: string;
}

interface MarkerPayload {
  migratedAt: string;
  /** SHA-256 of legacy home tree content — recomputed on each run. */
  copiedFromHash: string;
  /** Relative paths inside new home. */
  files: string[];
  /** Per-file SHA-256 keyed by relative path — drives partial-copy resume. */
  fileHashes: Record<string, string>;
}

function legacyHomeFor(profile: 'prod' | 'dev', home: string): string {
  return path.join(home, profile === 'dev' ? LEGACY_DEV_HOME_DIR_NAME : LEGACY_PROD_HOME_DIR_NAME);
}

function newHomeFor(profile: 'prod' | 'dev', home: string): string {
  return path.join(home, profile === 'dev' ? DEV_HOME_DIR_NAME : PROD_HOME_DIR_NAME);
}

/** SHA-256 hex digest of a file's contents. */
function hashFile(absPath: string): string {
  const hash = crypto.createHash('sha256');
  hash.update(fs.readFileSync(absPath));
  return hash.digest('hex');
}

/** Aggregate hash of a whole tree — order-stable by sorting relative paths. */
function hashTree(root: string, files: Array<{ rel: string; abs: string }>): string {
  const hash = crypto.createHash('sha256');
  for (const f of files.slice().sort((a, b) => a.rel.localeCompare(b.rel))) {
    hash.update(f.rel + ':' + hashFile(f.abs) + '\n');
  }
  return hash.digest('hex');
}

/** Read the migration marker, returning `null` if absent / malformed. */
function readMarker(newHome: string): MarkerPayload | null {
  const markerPath = path.join(newHome, MIGRATION_MARKER_FILENAME);
  if (!fs.existsSync(markerPath)) return null;
  try {
    const parsed = JSON.parse(fs.readFileSync(markerPath, 'utf8')) as Partial<MarkerPayload>;
    if (typeof parsed.copiedFromHash !== 'string' || !Array.isArray(parsed.files)) return null;
    return {
      migratedAt: parsed.migratedAt ?? '',
      copiedFromHash: parsed.copiedFromHash,
      files: parsed.files,
      fileHashes: parsed.fileHashes ?? {},
    };
  } catch {
    return null;
  }
}

/**
 * Walk a directory tree, yielding `{ rel, abs }` entries for files matching
 * the allowlist. Returns `[]` if `legacyHome` doesn't exist.
 *
 * Allowlist:
 *   - top-level files in {@link ALLOWLIST_FILES}
 *   - top-level `*.yaml` / `*.yml` files
 *   - everything (recursively) under top-level subdirs in {@link ALLOWLIST_SUBDIRS}
 *
 * The volatile trio (`daemon.pid`/`.port`/`.log`) is excluded everywhere.
 */
function walkLegacyTree(legacyHome: string): Array<{ rel: string; abs: string }> {
  if (!fs.existsSync(legacyHome)) return [];
  const out: Array<{ rel: string; abs: string }> = [];

  // Top-level entries
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(legacyHome, { withFileTypes: true });
  } catch {
    return [];
  }

  for (const entry of entries) {
    if (VOLATILE_FILES.has(entry.name)) continue;
    if (entry.name === MIGRATION_MARKER_FILENAME) continue;

    const abs = path.join(legacyHome, entry.name);

    if (entry.isFile()) {
      if (ALLOWLIST_FILES.has(entry.name) || /\.ya?ml$/i.test(entry.name)) {
        out.push({ rel: entry.name, abs });
      }
      continue;
    }

    if (entry.isDirectory() && ALLOWLIST_SUBDIRS.includes(entry.name)) {
      walkSubtree(abs, entry.name, out);
    }
  }

  return out;
}

function walkSubtree(absRoot: string, relRoot: string, out: Array<{ rel: string; abs: string }>): void {
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(absRoot, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries) {
    const abs = path.join(absRoot, entry.name);
    const rel = path.posix.join(relRoot, entry.name);
    if (entry.isFile()) {
      out.push({ rel, abs });
    } else if (entry.isDirectory()) {
      walkSubtree(abs, rel, out);
    }
  }
}

/**
 * One-shot legacy home migration. See module doc-comment for the full
 * contract. Never throws — all error paths return a structured
 * {@link LegacyMigrationResult}.
 */
export async function migrateLegacyHome(
  opts: LegacyMigrationOpts = {},
): Promise<LegacyMigrationResult> {
  const profile = opts.profile ?? 'prod';
  const home = opts.homeDir ?? homedir();
  const legacyHome = legacyHomeFor(profile, home);
  const newHome = newHomeFor(profile, home);

  // 1. No legacy → nothing to do.
  if (!fs.existsSync(legacyHome)) {
    return { status: 'no-legacy', legacyHome, newHome };
  }

  // 2. Volatile state guard — daemon.pid likely means a running daemon.
  const pidPath = path.join(legacyHome, 'daemon.pid');
  if (!opts.force && fs.existsSync(pidPath)) {
    return {
      status: 'skipped',
      legacyHome,
      newHome,
      reason:
        `Legacy daemon.pid present at ${pidPath}. The daemon may still be running — ` +
        `stop it first (\`agent-tempo daemon stop\` or \`claude-tempo daemon stop\`) ` +
        `and re-run, or pass \`--force\` to migrate anyway.`,
    };
  }

  // 3. Conflict policy — new home exists without our marker = user-initiated, refuse.
  const newHomeExists = fs.existsSync(newHome);
  const existingMarker = newHomeExists ? readMarker(newHome) : null;
  if (newHomeExists && !existingMarker && !opts.force) {
    return {
      status: 'skipped',
      legacyHome,
      newHome,
      reason:
        `Refusing to overwrite ${newHome} — directory exists and was not created ` +
        `by a previous migration (no \`${MIGRATION_MARKER_FILENAME}\` marker found). ` +
        `Pass \`--force\` to migrate anyway, or delete the directory first.`,
    };
  }

  // 4. Enumerate legacy files + hash the source tree.
  const legacyFiles = walkLegacyTree(legacyHome);
  if (legacyFiles.length === 0) {
    // Legacy dir exists but holds only volatile state / nothing to migrate.
    return { status: 'no-legacy', legacyHome, newHome };
  }
  const sourceHash = hashTree(legacyHome, legacyFiles);

  // 5. Idempotency — same source content + valid marker = already migrated.
  if (existingMarker && existingMarker.copiedFromHash === sourceHash) {
    return {
      status: 'already-migrated',
      legacyHome,
      newHome,
      copiedFiles: [],
    };
  }

  // 6. Plan the copy. Partial-copy resume: skip files whose dest already has the right SHA.
  const plan: Array<{ rel: string; abs: string; destAbs: string; sourceHash: string }> = [];
  const errors: string[] = [];
  for (const f of legacyFiles) {
    let srcHash: string;
    try {
      srcHash = hashFile(f.abs);
    } catch (err) {
      errors.push(`hash failed for ${f.rel}: ${(err as Error).message}`);
      continue;
    }
    const destAbs = path.join(newHome, f.rel);
    if (existingMarker?.fileHashes?.[f.rel] === srcHash && fs.existsSync(destAbs)) {
      try {
        if (hashFile(destAbs) === srcHash) continue; // already copied with right content
      } catch { /* fall through and re-copy */ }
    }
    plan.push({ rel: f.rel, abs: f.abs, destAbs, sourceHash: srcHash });
  }

  if (opts.dryRun) {
    return {
      status: 'migrated',
      legacyHome,
      newHome,
      copiedFiles: plan.map((p) => p.rel),
    };
  }

  // 7. Execute the copy.
  const copied: string[] = [];
  const fileHashes: Record<string, string> = { ...(existingMarker?.fileHashes ?? {}) };

  try {
    fs.mkdirSync(newHome, { recursive: true });
  } catch (err) {
    errors.push(`mkdir ${newHome}: ${(err as Error).message}`);
    return { status: 'failed', legacyHome, newHome, errors };
  }

  for (const p of plan) {
    try {
      fs.mkdirSync(path.dirname(p.destAbs), { recursive: true });
      fs.copyFileSync(p.abs, p.destAbs);
      copied.push(p.rel);
      fileHashes[p.rel] = p.sourceHash;
    } catch (err) {
      errors.push(`copy ${p.rel}: ${(err as Error).message}`);
    }
  }

  if (errors.length > 0 && copied.length === 0) {
    return { status: 'failed', legacyHome, newHome, errors };
  }

  // 8. Drop the marker — captures final state for idempotency.
  const allFiles = legacyFiles.map((f) => f.rel).sort();
  const marker: MarkerPayload = {
    migratedAt: new Date().toISOString(),
    copiedFromHash: sourceHash,
    files: allFiles,
    fileHashes,
  };
  try {
    fs.writeFileSync(
      path.join(newHome, MIGRATION_MARKER_FILENAME),
      JSON.stringify(marker, null, 2) + '\n',
    );
  } catch (err) {
    errors.push(`marker write: ${(err as Error).message}`);
  }

  return {
    status: 'migrated',
    legacyHome,
    newHome,
    copiedFiles: copied,
    ...(errors.length > 0 ? { errors } : {}),
  };
}

/**
 * Format a {@link LegacyMigrationResult} for human display (CLI verb output
 * + bootstrap step `notes`).
 */
export function formatMigrationResult(r: LegacyMigrationResult): string {
  switch (r.status) {
    case 'no-legacy':
      return `No legacy home at ${r.legacyHome} — nothing to migrate.`;
    case 'already-migrated':
      return `Already migrated — ${r.newHome} is up-to-date with ${r.legacyHome}.`;
    case 'migrated': {
      const n = r.copiedFiles?.length ?? 0;
      const errSuffix = r.errors?.length ? ` (${r.errors.length} error(s) recorded)` : '';
      return `Migrated ${n} file(s) ${r.legacyHome} → ${r.newHome}${errSuffix}.`;
    }
    case 'skipped':
      return r.reason ?? 'Migration skipped.';
    case 'failed':
      return `Migration failed: ${(r.errors ?? []).join('; ')}`;
  }
}
