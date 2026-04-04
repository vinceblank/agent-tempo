import { readFileSync } from 'fs';
import { parse as parseYaml } from 'yaml';
import { EnsembleBlueprint } from './schema';

/**
 * Load and validate an ensemble blueprint from a YAML file.
 */
export function loadBlueprint(filePath: string): EnsembleBlueprint {
  const raw = readFileSync(filePath, 'utf8');
  const doc = parseYaml(raw);

  if (!doc || typeof doc !== 'object') {
    throw new Error(`Invalid blueprint: file does not contain a YAML object`);
  }

  // Required: name
  if (typeof doc.name !== 'string' || !doc.name) {
    throw new Error(`Invalid blueprint: "name" is required and must be a non-empty string`);
  }

  // Required: players array
  if (!Array.isArray(doc.players)) {
    throw new Error(`Invalid blueprint: "players" must be an array`);
  }

  for (let i = 0; i < doc.players.length; i++) {
    const p = doc.players[i];
    if (typeof p.name !== 'string' || !p.name) {
      throw new Error(`Invalid blueprint: players[${i}].name is required`);
    }
    if (!/^[a-zA-Z0-9_-]+$/.test(p.name)) {
      throw new Error(`Invalid blueprint: players[${i}].name "${p.name}" contains invalid characters`);
    }
  }

  // Validate schedules if present
  if (doc.schedules != null) {
    if (!Array.isArray(doc.schedules)) {
      throw new Error(`Invalid blueprint: "schedules" must be an array`);
    }
    for (let i = 0; i < doc.schedules.length; i++) {
      const s = doc.schedules[i];
      if (typeof s.name !== 'string' || !s.name) {
        throw new Error(`Invalid blueprint: schedules[${i}].name is required`);
      }
      if (typeof s.message !== 'string' || !s.message) {
        throw new Error(`Invalid blueprint: schedules[${i}].message is required`);
      }
      if (typeof s.target !== 'string' || !s.target) {
        throw new Error(`Invalid blueprint: schedules[${i}].target is required`);
      }
      if (!s.at && !s.delay && !s.every) {
        throw new Error(`Invalid blueprint: schedules[${i}] must have at least one of: at, delay, every`);
      }
    }
  }

  return {
    name: doc.name,
    description: doc.description,
    conductor: doc.conductor,
    players: doc.players,
    schedules: doc.schedules,
  };
}
