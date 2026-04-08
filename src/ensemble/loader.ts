import { existsSync, readFileSync, readdirSync } from 'fs';
import { join, resolve } from 'path';
import { parse as parseYaml } from 'yaml';
import { EnsembleLineup } from './schema';
import { CLAUDE_TEMPO_HOME } from '../config';

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
  // 1. Saved lineups (~/.claude-tempo/ensembles/)
  const ensemblesDir = join(CLAUDE_TEMPO_HOME, 'ensembles');
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
    conductor: doc.conductor,
    players: doc.players.map((p: any) => ({
      name: p.name,
      ...(p.type != null && { type: p.type }),
      ...(p.workDir != null && { workDir: p.workDir }),
      ...(p.agent != null && { agent: p.agent }),
      ...(p.instructions != null && { instructions: p.instructions }),
      ...(Array.isArray(p.allowedTools) && { allowedTools: p.allowedTools.map(String) }),
    })),
    schedules: doc.schedules,
  };
}
