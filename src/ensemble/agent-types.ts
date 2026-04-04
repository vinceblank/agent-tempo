import { existsSync, readFileSync, readdirSync } from 'fs';
import { join, resolve } from 'path';
import { homedir } from 'os';
import { parse as parseYaml } from 'yaml';
import { AgentTypeInfo } from '../types';
import { EnsembleBlueprint } from './schema';
import { loadBlueprint } from './loader';

/**
 * Parse YAML frontmatter from a markdown file.
 * Expects `---` delimiters wrapping YAML at the top of the file.
 */
export function parseFrontmatter(filePath: string): Record<string, any> {
  const content = readFileSync(filePath, 'utf8');
  const match = content.match(/^---\r?\n([\s\S]*?)\r?\n---/);
  if (!match) return {};
  try {
    return parseYaml(match[1]) ?? {};
  } catch {
    return {};
  }
}

/** Resolve the shipped examples/agents directory relative to package root. */
function shippedAgentsDir(): string {
  // Walk up from __dirname until we find examples/agents/ or package.json
  let dir = __dirname;
  for (let i = 0; i < 5; i++) {
    const candidate = join(dir, 'examples', 'agents');
    if (existsSync(candidate)) return candidate;
    const parent = resolve(dir, '..');
    if (parent === dir) break; // filesystem root
    dir = parent;
  }
  // Fallback: two levels up (src/ensemble → package root or dist/ensemble → package root)
  return join(resolve(__dirname, '..', '..'), 'examples', 'agents');
}

interface AgentDirEntry {
  dir: string;
  source: 'project' | 'user' | 'shipped';
  nativeResolvable: boolean;
}

function agentDirs(cwd?: string): AgentDirEntry[] {
  return [
    { dir: join(cwd || process.cwd(), '.claude', 'agents'), source: 'project', nativeResolvable: true },
    { dir: join(homedir(), '.claude', 'agents'), source: 'user', nativeResolvable: true },
    { dir: shippedAgentsDir(), source: 'shipped', nativeResolvable: false },
  ];
}

/**
 * List all available agent types across the three-tier lookup.
 * Deduplicates by name: project > user > shipped.
 */
export function listAgentTypes(cwd?: string): AgentTypeInfo[] {
  const seen = new Map<string, AgentTypeInfo>();

  for (const { dir, source, nativeResolvable } of agentDirs(cwd)) {
    if (!existsSync(dir)) continue;

    let files: string[];
    try {
      files = readdirSync(dir).filter(f => f.endsWith('.md'));
    } catch {
      continue;
    }

    for (const file of files) {
      const filePath = join(dir, file);
      const fm = parseFrontmatter(filePath);
      const name = fm.name || file.replace(/\.md$/, '');

      // Higher-priority sources are scanned first — skip if already seen
      if (seen.has(name)) continue;

      seen.set(name, {
        name,
        description: fm.description,
        source,
        path: filePath,
        nativeResolvable,
      });
    }
  }

  return Array.from(seen.values());
}

/**
 * Resolve a single agent type by name across the three-tier lookup.
 * Returns the first match (project > user > shipped) or null.
 */
export function resolveAgentType(name: string, cwd?: string): AgentTypeInfo | null {
  for (const { dir, source, nativeResolvable } of agentDirs(cwd)) {
    const filePath = join(dir, `${name}.md`);
    if (!existsSync(filePath)) continue;

    const fm = parseFrontmatter(filePath);
    return {
      name: fm.name || name,
      description: fm.description,
      source,
      path: filePath,
      nativeResolvable,
    };
  }
  return null;
}

/**
 * Load and resolve a blueprint, validating and resolving `type` fields on each player.
 * Players without `type` pass through unchanged.
 * Throws if a referenced type is not found.
 */
export function loadAndResolveBlueprint(filePath: string, cwd?: string): EnsembleBlueprint {
  const blueprint = loadBlueprint(filePath);

  for (const player of blueprint.players) {
    if (!player.type) continue;

    const info = resolveAgentType(player.type, cwd);
    if (!info) {
      const available = listAgentTypes(cwd).map(t => t.name);
      throw new Error(
        `Unknown agent type "${player.type}" for player "${player.name}". ` +
        `Available types: ${available.length ? available.join(', ') : '(none)'}`,
      );
    }

    player._agentDefinition = info.name;
    player._agentDefinitionPath = info.path;
  }

  return blueprint;
}
