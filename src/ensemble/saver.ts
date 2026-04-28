import { existsSync, mkdirSync, writeFileSync, readdirSync, readFileSync } from 'fs';
import { join, resolve } from 'path';
import { Client } from '@temporalio/client';
import { stringify as yamlStringify } from 'yaml';
import { CLAUDE_TEMPO_HOME, schedulerWorkflowId } from '../config';
import { EnsembleLineup } from './schema';
import { loadLineup } from './loader';

const ENSEMBLES_DIR = join(CLAUDE_TEMPO_HOME, 'ensembles');

function ensemblesDir(): string {
  mkdirSync(ENSEMBLES_DIR, { recursive: true });
  return ENSEMBLES_DIR;
}

/**
 * Save the current live ensemble state to a YAML lineup file.
 * Queries all running sessions and active schedules from Temporal.
 */
export async function saveLineup(
  client: Client,
  ensemble: string,
  filePath?: string,
  name?: string,
): Promise<string> {
  const outputPath = filePath || join(ensemblesDir(), `${name || ensemble}.yaml`);

  // Query all running session workflows
  const query = 'WorkflowType = "claudeSessionWorkflow" AND ExecutionStatus = "Running"';
  const players: EnsembleLineup['players'] = [];
  let conductor: EnsembleLineup['conductor'] | undefined;

  for await (const wf of client.workflow.list({ query })) {
    try {
      const handle = client.workflow.getHandle(wf.workflowId);
      const [metadata, part] = await Promise.all([
        handle.query('getMetadata').catch(() => ({})),
        handle.query('getPart').catch(() => ''),
      ]);
      const meta = metadata as Record<string, unknown>;
      if ((meta.ensemble as string) !== ensemble) continue;

      const isConductor = (meta.isConductor as boolean) || false;
      const agentType = (meta.agentType as string) || 'claude';
      const workDir = (meta.workDir as string) || undefined;

      if (isConductor) {
        const conductorName = (meta.playerId as string) || undefined;
        conductor = {
          // Only save name if it's not the default 'conductor'
          ...(conductorName && conductorName !== 'conductor' ? { name: conductorName } : {}),
          agent: agentType === 'copilot' ? 'copilot' : undefined,
        };
      } else {
        const name = (meta.playerId as string) || wf.workflowId.split('-').pop() || 'unknown';
        const playerType = (meta.playerType as string) || undefined;
        players.push({
          name,
          type: playerType,
          workDir,
          agent: agentType === 'copilot' ? 'copilot' : undefined,
        });
      }
    } catch {
      // workflow may have closed between list and query
    }
  }

  // Query active schedules
  const schedules: EnsembleLineup['schedules'] = [];
  try {
    const schedulerWfId = schedulerWorkflowId(ensemble);
    const handle = client.workflow.getHandle(schedulerWfId);
    const entries = await handle.query('getSchedules') as any[];
    for (const entry of entries) {
      const sched: EnsembleLineup['schedules'] extends (infer T)[] | undefined ? T : never = {
        name: entry.name,
        message: entry.message,
        target: entry.target,
      };
      if (entry.cronExpression) {
        sched.cron = entry.cronExpression;
        if (entry.timezone) sched.timezone = entry.timezone;
      } else if (entry.interval) {
        sched.every = formatDurationMs(entry.interval);
      }
      if (entry.until) {
        sched.until = entry.until;
      }
      if (entry.remainingCount != null) {
        sched.count = entry.remainingCount;
      }
      schedules.push(sched);
    }
  } catch {
    // No scheduler running or no schedules
  }

  // An empty `{}` satisfies the schema when no conductor session is live;
  // downstream consumers apply the field-level defaults.
  const lineup: EnsembleLineup = {
    name: ensemble,
    conductor: conductor ?? {},
    players,
    ...(schedules.length > 0 ? { schedules } : {}),
  };

  // Ensure parent directory exists
  const parentDir = outputPath.substring(0, outputPath.lastIndexOf('/') >= 0 ? outputPath.lastIndexOf('/') : outputPath.lastIndexOf('\\'));
  if (parentDir) mkdirSync(parentDir, { recursive: true });

  writeFileSync(outputPath, yamlStringify(lineup));
  return outputPath;
}

/**
 * List all saved ensemble lineups in ~/.claude-tempo/ensembles/.
 */
export function listLineups(): Array<{ name: string; path: string }> {
  const dir = ensemblesDir();
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter(f => f.endsWith('.yaml') || f.endsWith('.yml'))
    .map(f => ({
      name: f.replace(/\.ya?ml$/, ''),
      path: join(dir, f),
    }));
}

/**
 * Read a saved lineup by name from ~/.claude-tempo/ensembles/.
 */
export function readSavedLineup(name: string): string | null {
  const dir = ensemblesDir();
  for (const ext of ['.yaml', '.yml']) {
    const path = join(dir, name + ext);
    if (existsSync(path)) return readFileSync(path, 'utf8');
  }
  return null;
}

/**
 * Find the package root by walking up from a directory.
 */
function findPackageRoot(dir: string): string {
  if (existsSync(join(dir, 'package.json'))) return dir;
  const parent = resolve(dir, '..');
  return parent === dir ? dir : findPackageRoot(parent);
}

/**
 * Lineup catalog entry — each row in `listAllLineups()` output. Used by
 * the TUI's CreateEnsembleWizard, the dashboard's `/v1/lineups`
 * endpoint, and the `claude-tempo up --lineup` resolver.
 *
 * `players` and `description` come from a YAML parse — best-effort: a
 * malformed lineup file silently degrades to `players: 0` /
 * `description: undefined` rather than skipping the row entirely. The
 * row stays clickable so the picker can still surface it; downstream
 * `loadLineup()` runs strict validation at use time.
 *
 * `path` is the absolute on-disk path. Local callers use it to seed
 * the resolver; HTTP catchments must NOT serve this field over the
 * wire (privacy contract — strip in the route handler).
 */
export interface LineupCatalogEntry {
  name: string;
  description?: string;
  players: number;
  source: 'saved' | 'shipped';
  path: string;
}

/**
 * List all available lineups — saved (`~/.claude-tempo/ensembles/`)
 * plus shipped (`<package-root>/examples/ensembles/`). Saved takes
 * precedence over shipped when names collide.
 *
 * Each row carries `description` + `players` count so pickers can
 * render rich rows without re-parsing the YAML themselves. Parse
 * failures are tolerated (zero count, no description).
 */
export function listAllLineups(): LineupCatalogEntry[] {
  const seen = new Map<string, LineupCatalogEntry>();

  const append = (name: string, path: string, source: 'saved' | 'shipped') => {
    if (seen.has(name)) return;
    let description: string | undefined;
    let players = 0;
    try {
      const lineup = loadLineup(path);
      description = lineup.description;
      players = lineup.players.length;
    } catch {
      // Malformed YAML — keep the row but with zero count.
    }
    seen.set(name, {
      name,
      ...(description !== undefined && { description }),
      players,
      source,
      path,
    });
  };

  // Saved (higher priority).
  for (const l of listLineups()) append(l.name, l.path, 'saved');

  // Shipped fallback.
  const pkgRoot = findPackageRoot(resolve(__dirname));
  const shippedDir = join(pkgRoot, 'examples', 'ensembles');
  if (existsSync(shippedDir)) {
    for (const f of readdirSync(shippedDir)) {
      if (!f.endsWith('.yaml') && !f.endsWith('.yml')) continue;
      const name = f.replace(/\.ya?ml$/, '');
      append(name, join(shippedDir, f), 'shipped');
    }
  }

  return Array.from(seen.values());
}

function formatDurationMs(ms: number): string {
  if (ms >= 86_400_000 && ms % 86_400_000 === 0) return `${ms / 86_400_000}d`;
  if (ms >= 3_600_000 && ms % 3_600_000 === 0) return `${ms / 3_600_000}h`;
  if (ms >= 60_000 && ms % 60_000 === 0) return `${ms / 60_000}m`;
  return `${ms / 1000}s`;
}
