import { readFileSync } from 'fs';
import { parse as parseYaml } from 'yaml';
import { EnsembleLineup } from './schema';

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
    if (p.isolation != null && p.isolation !== 'worktree') {
      throw new Error(`Invalid lineup: players[${i}].isolation must be "worktree" if specified`);
    }
    if (p.branch != null && (typeof p.branch !== 'string' || !p.branch)) {
      throw new Error(`Invalid lineup: players[${i}].branch must be a non-empty string`);
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
      ...(p.isolation != null && { isolation: p.isolation }),
      ...(p.branch != null && { branch: p.branch }),
    })),
    schedules: doc.schedules,
  };
}
