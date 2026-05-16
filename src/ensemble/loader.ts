import { existsSync, readFileSync, readdirSync } from 'fs';
import { join, resolve } from 'path';
import { parse as parseYaml } from 'yaml';
import { EnsembleLineup, SpawnMode } from './schema';
import { AGENT_TEMPO_HOME } from '../config';

/** Walk up from a directory to find the nearest package.json. */
function findPackageRoot(dir: string): string {
  if (existsSync(join(dir, 'package.json'))) return dir;
  const parent = resolve(dir, '..');
  return parent === dir ? dir : findPackageRoot(parent);
}

/** Package root — works from both dist/ (production) and dist-test/ (tests). */
const PACKAGE_ROOT = findPackageRoot(resolve(__dirname));

export interface LineupResolution {
  path: string;
  source: 'saved' | 'shipped' | 'file';
}

/**
 * Resolve a lineup name or file path to an absolute file path.
 * Resolution order: saved lineups → shipped examples → direct file path → error.
 */
export function resolveLineupPath(nameOrPath: string): LineupResolution {
  // 1. Saved lineups (~/.agent-tempo/ensembles/)
  const ensemblesDir = join(AGENT_TEMPO_HOME, 'ensembles');
  const savedYaml = join(ensemblesDir, `${nameOrPath}.yaml`);
  const savedYml = join(ensemblesDir, `${nameOrPath}.yml`);
  if (existsSync(savedYaml)) return { path: savedYaml, source: 'saved' };
  if (existsSync(savedYml)) return { path: savedYml, source: 'saved' };

  // 2. Shipped examples (<package-root>/examples/ensembles/)
  const shippedYaml = join(PACKAGE_ROOT, 'examples', 'ensembles', `${nameOrPath}.yaml`);
  const shippedYml = join(PACKAGE_ROOT, 'examples', 'ensembles', `${nameOrPath}.yml`);
  if (existsSync(shippedYaml)) return { path: shippedYaml, source: 'shipped' };
  if (existsSync(shippedYml)) return { path: shippedYml, source: 'shipped' };

  // 3. Direct file path
  const resolved = resolve(nameOrPath);
  if (existsSync(resolved)) return { path: resolved, source: 'file' };

  // 4. Error with suggestions
  const suggestions: string[] = [];
  const saved = existsSync(ensemblesDir) ? readdirSync(ensemblesDir).filter(f => f.endsWith('.yaml') || f.endsWith('.yml')).map(f => f.replace(/\.ya?ml$/, '')) : [];
  if (saved.length) suggestions.push(`Saved: ${saved.join(', ')}`);
  const shippedDir = join(PACKAGE_ROOT, 'examples', 'ensembles');
  if (existsSync(shippedDir)) {
    const shipped = readdirSync(shippedDir).filter(f => f.endsWith('.yaml') || f.endsWith('.yml')).map(f => f.replace(/\.ya?ml$/, ''));
    if (shipped.length) suggestions.push(`Shipped: ${shipped.join(', ')}`);
  }

  const msg = `Lineup "${nameOrPath}" not found as saved lineup, shipped example, or file path.`;
  throw new Error(suggestions.length ? `${msg}\n  ${suggestions.join('\n  ')}` : msg);
}

/**
 * Load and validate an ensemble lineup from a YAML file.
 */
export function loadLineup(filePath: string): EnsembleLineup {
  const raw = readFileSync(filePath, 'utf8');
  const doc = parseYaml(raw);

  if (!doc || typeof doc !== 'object') {
    throw new Error(`Invalid lineup: file does not contain a YAML object`);
  }

  // Required: name
  if (typeof doc.name !== 'string' || !doc.name) {
    throw new Error(`Invalid lineup: "name" is required and must be a non-empty string`);
  }

  // Every ensemble must define exactly one conductor — the default chat
  // target and anchor for the maestro's `getEnsembleChat`.
  const remediation =
    `Add a conductor block with 'name:' (default "conductor") and 'agent:' (default from AGENT_TEMPO_DEFAULT_AGENT config).`;
  if (doc.conductor == null) {
    throw new Error(
      `lineup "${doc.name}" is missing a conductor; every ensemble must define exactly one conductor. ${remediation}`,
    );
  }
  if (typeof doc.conductor !== 'object' || Array.isArray(doc.conductor)) {
    throw new Error(
      `lineup "${doc.name}" has a malformed conductor (expected a mapping, got ${Array.isArray(doc.conductor) ? 'array' : typeof doc.conductor}). ${remediation}`,
    );
  }

  // Required: players array
  if (!Array.isArray(doc.players)) {
    throw new Error(`Invalid lineup: "players" must be an array`);
  }

  for (let i = 0; i < doc.players.length; i++) {
    const p = doc.players[i];
    if (typeof p.name !== 'string' || !p.name) {
      throw new Error(`Invalid lineup: players[${i}].name is required`);
    }
    if (!/^[a-zA-Z0-9_-]+$/.test(p.name)) {
      throw new Error(`Invalid lineup: players[${i}].name "${p.name}" contains invalid characters`);
    }
  }

  // Validate schedules if present
  if (doc.schedules != null) {
    if (!Array.isArray(doc.schedules)) {
      throw new Error(`Invalid lineup: "schedules" must be an array`);
    }
    for (let i = 0; i < doc.schedules.length; i++) {
      const s = doc.schedules[i];
      if (typeof s.name !== 'string' || !s.name) {
        throw new Error(`Invalid lineup: schedules[${i}].name is required`);
      }
      if (typeof s.message !== 'string' || !s.message) {
        throw new Error(`Invalid lineup: schedules[${i}].message is required`);
      }
      if (typeof s.target !== 'string' || !s.target) {
        throw new Error(`Invalid lineup: schedules[${i}].target is required`);
      }
      if (!s.at && !s.delay && !s.every && !s.cron) {
        throw new Error(`Invalid lineup: schedules[${i}] must have at least one of: at, delay, every, cron`);
      }
    }
  }

  // ── ADR 0016 — experimental + spawn validation ───────────────────────
  const SPAWN_VALUES: readonly SpawnMode[] = ['terminal', 'bg'];
  const isSpawnMode = (v: unknown): v is SpawnMode =>
    typeof v === 'string' && (SPAWN_VALUES as readonly string[]).includes(v);

  // experimental block (open shape — only `spawn` recognised today)
  let experimentalSpawn = false;
  if (doc.experimental != null) {
    if (typeof doc.experimental !== 'object' || Array.isArray(doc.experimental)) {
      throw new Error(
        `Invalid lineup: "experimental" must be a mapping (e.g. \`experimental:\\n  spawn: true\`).`,
      );
    }
    if (doc.experimental.spawn != null) {
      if (typeof doc.experimental.spawn !== 'boolean') {
        throw new Error(
          `Invalid lineup: "experimental.spawn" must be a boolean (got ${typeof doc.experimental.spawn}).`,
        );
      }
      experimentalSpawn = doc.experimental.spawn === true;
    }
  }

  // top-level spawn
  if (doc.spawn != null && !isSpawnMode(doc.spawn)) {
    throw new Error(
      `Invalid lineup: "spawn" must be one of ${SPAWN_VALUES.map((v) => `"${v}"`).join(' | ')} (got "${doc.spawn}").`,
    );
  }
  const lineupSpawn: SpawnMode | undefined = doc.spawn;

  // per-player spawn — validate enum first, gate check below after collecting
  for (let i = 0; i < doc.players.length; i++) {
    const p = doc.players[i];
    if (p.spawn != null && !isSpawnMode(p.spawn)) {
      throw new Error(
        `Invalid lineup: players[${i}].spawn must be one of ${SPAWN_VALUES.map((v) => `"${v}"`).join(' | ')} (got "${p.spawn}").`,
      );
    }
  }

  // Experimental gate: ANY resolved spawn === 'bg' requires experimental.spawn === true.
  // Apply precedence: per-player > lineup > 'terminal' (default).
  const resolvedSpawns: SpawnMode[] = doc.players.map((p: any): SpawnMode =>
    (p.spawn as SpawnMode | undefined) ?? lineupSpawn ?? 'terminal',
  );
  const wantsBg = resolvedSpawns.some((s) => s === 'bg') || lineupSpawn === 'bg';
  if (wantsBg && !experimentalSpawn) {
    throw new Error(
      `spawn: bg requires 'experimental.spawn: true' at the top of the lineup.`,
    );
  }

  // Warning (not error) if spawn:bg resolves for a non-claude-code player.
  // The dispatch layer silently ignores the field for non-claude-code adapters,
  // but the warning helps users catch lineup typos early.
  for (let i = 0; i < doc.players.length; i++) {
    const p = doc.players[i];
    const resolved = resolvedSpawns[i];
    if (resolved === 'bg') {
      const agent = (p.agent as string | undefined) ?? 'claude';
      // 'claude' / undefined / 'default' all map to the interactive
      // claude-code adapter at recruit time. Anything else is non-claude-code.
      const isClaudeCode = !agent || agent === 'claude' || agent === 'default';
      if (!isClaudeCode) {
        // eslint-disable-next-line no-console
        console.warn(
          `[agent-tempo:lineup] players[${i}] "${p.name}" has spawn: bg but agent: "${agent}" — bg spawn is only supported for the claude-code adapter (#596 / ADR 0016). The spawn field will be silently ignored for this player.`,
        );
      }
    }
  }

  // Validate conductor name if present
  if (doc.conductor?.name != null) {
    if (typeof doc.conductor.name !== 'string' || !doc.conductor.name) {
      throw new Error(`Invalid lineup: conductor.name must be a non-empty string`);
    }
    if (!/^[a-zA-Z0-9_-]+$/.test(doc.conductor.name)) {
      throw new Error(`Invalid lineup: conductor.name "${doc.conductor.name}" contains invalid characters`);
    }
  }

  return {
    name: doc.name,
    description: doc.description,
    ...(doc.experimental != null && { experimental: { ...(experimentalSpawn && { spawn: true }) } }),
    ...(lineupSpawn != null && { spawn: lineupSpawn }),
    conductor: doc.conductor,
    players: doc.players.map((p: any, i: number) => ({
      name: p.name,
      ...(p.type != null && { type: p.type }),
      ...(p.workDir != null && { workDir: p.workDir }),
      ...(p.agent != null && { agent: p.agent }),
      ...(p.instructions != null && { instructions: p.instructions }),
      ...(Array.isArray(p.allowedTools) && { allowedTools: p.allowedTools.map(String) }),
      // PR-3 mock fields. Pass through verbatim — schema validation is
      // shape-only here; runtime rejection lives in `recruit.ts` (gates the
      // dev-mode `agent: "mock"` requirement) and the spawn layer.
      ...(p.mockMode != null && { mockMode: p.mockMode }),
      ...(p.mockScenario != null && { mockScenario: p.mockScenario }),
      // ADR 0016 — per-player spawn (raw, for round-trip / save_lineup)
      ...(p.spawn != null && { spawn: p.spawn as SpawnMode }),
      // ADR 0016 — resolved spawn after precedence; dispatcher reads this
      _spawn: resolvedSpawns[i],
    })),
    schedules: doc.schedules,
  };
}

/**
 * Resolve the effective spawn mode for a player. Exposed for tests and for
 * call sites that build `RecruitOutboxEntry` instances directly without
 * going through `loadLineup` (the lineup loader already populates the
 * transient `_spawn` field; this helper is the single source of truth for
 * the precedence rule).
 *
 * Precedence: per-player > lineup > built-in default `'terminal'`.
 */
export function resolveSpawnMode(
  player: { spawn?: SpawnMode },
  lineup: { spawn?: SpawnMode },
): SpawnMode {
  return player.spawn ?? lineup.spawn ?? 'terminal';
}
