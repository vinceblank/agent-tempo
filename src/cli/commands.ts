import { existsSync, readFileSync, writeFileSync } from 'fs';
import { join, resolve } from 'path';
import { Connection, Client } from '@temporalio/client';
import { spawnInTerminal } from '../spawn';
import { runPreflight } from './preflight';
import * as out from './output';

/** Package root is two levels up from dist/cli/ */
const PACKAGE_ROOT = resolve(__dirname, '..', '..');

interface StartOpts {
  ensemble: string;
  conductor: boolean;
  temporalAddress: string;
  name?: string;
  skipPreflight?: boolean;
}

export async function start(opts: StartOpts) {
  const workDir = process.cwd();

  if (!opts.skipPreflight) {
    const result = await runPreflight({
      temporalAddress: opts.temporalAddress,
      projectDir: workDir,
    });
    for (const w of result.warnings) out.warn(w);
    if (!result.ok) {
      for (const e of result.errors) out.error(e);
      process.exit(1);
    }
  }

  const role = opts.conductor ? 'conductor' : 'player';
  out.log(`Starting ${out.bold(role)} in ensemble ${out.cyan(opts.ensemble)}`);

  const claudeArgs = [
    '--dangerously-skip-permissions',
    '--dangerously-load-development-channels', 'server:claude-tempo',
  ];
  if (opts.name) {
    claudeArgs.push('-n', opts.name);
  }

  const envVars: Record<string, string> = {
    CLAUDE_TEMPO_ENSEMBLE: opts.ensemble,
  };
  if (opts.conductor) {
    envVars.CLAUDE_TEMPO_CONDUCTOR = 'true';
  }

  const { pid } = spawnInTerminal(claudeArgs, workDir, envVars);
  out.success(`Launched ${role} session${opts.name ? ` "${opts.name}"` : ''} (pid ${pid ?? 'unknown'})`);
  out.log(`  Ensemble: ${opts.ensemble}`);
  out.log(`  Directory: ${workDir}`);
  out.log(`\nCheck status: ${out.dim('claude-tempo status ' + opts.ensemble)}`);
}

interface StatusOpts {
  ensemble?: string;
  temporalAddress: string;
}

export async function status(opts: StatusOpts) {
  let connection: Connection;
  try {
    connection = await Promise.race([
      Connection.connect({ address: opts.temporalAddress }),
      new Promise<never>((_, reject) => setTimeout(() => reject(new Error('timeout')), 3000)),
    ]);
  } catch {
    out.error(`Cannot connect to Temporal at ${opts.temporalAddress}`);
    out.log(`  Run: ${out.dim('temporal server start-dev')}`);
    process.exit(1);
    return; // unreachable, helps TS
  }

  const client = new Client({ connection });

  // Build query
  let query = 'WorkflowType = "claudeSessionWorkflow" AND ExecutionStatus = "Running"';
  if (opts.ensemble) {
    query += ` AND ClaudeTempoEnsemble = "${opts.ensemble}"`;
  }

  const sessions: Array<{
    id: string;
    name: string;
    part: string;
    ensemble: string;
    workDir: string;
    branch: string;
    host: string;
    conductor: boolean;
  }> = [];

  for await (const wf of client.workflow.list({ query })) {
    try {
      const handle = client.workflow.getHandle(wf.workflowId);
      const [metadata, part] = await Promise.all([
        handle.query('getMetadata').catch(() => ({})),
        handle.query('getPart').catch(() => ''),
      ]);
      const meta = metadata as Record<string, unknown>;
      sessions.push({
        id: wf.workflowId,
        name: (meta.playerId as string) || wf.workflowId.split('-').pop() || '?',
        part: (part as string) || '',
        ensemble: (meta.ensemble as string) || '?',
        workDir: (meta.workDir as string) || '?',
        branch: (meta.gitBranch as string) || '',
        host: (meta.hostname as string) || '',
        conductor: (meta.isConductor as boolean) || false,
      });
    } catch {
      // workflow may have closed between list and query
    }
  }

  await connection.close();

  if (sessions.length === 0) {
    out.log(opts.ensemble
      ? `No active sessions in ensemble "${opts.ensemble}".`
      : 'No active sessions found.');
    return;
  }

  // Group by ensemble
  const byEnsemble = new Map<string, typeof sessions>();
  for (const s of sessions) {
    const list = byEnsemble.get(s.ensemble) || [];
    list.push(s);
    byEnsemble.set(s.ensemble, list);
  }

  for (const [ensemble, members] of byEnsemble) {
    out.heading(`Ensemble: ${ensemble}`);
    out.log(`  ${out.dim(`${members.length} active session${members.length !== 1 ? 's' : ''}`)}`);
    console.log();

    // Sort: conductor first, then alphabetical
    members.sort((a, b) => {
      if (a.conductor !== b.conductor) return a.conductor ? -1 : 1;
      return a.name.localeCompare(b.name);
    });

    for (const s of members) {
      const role = s.conductor ? out.yellow(' (conductor)') : '';
      const name = out.bold(s.name);
      out.log(`  ${name}${role}`);
      if (s.part) out.log(`    ${out.dim(s.part)}`);
      const details = [s.workDir, s.branch, s.host].filter(Boolean).join('  ');
      if (details) out.log(`    ${out.dim(details)}`);
    }
  }
  console.log();
}

interface InitOpts {
  dir: string;
}

export async function init(opts: InitOpts) {
  const mcpPath = join(opts.dir, '.mcp.json');

  const entry = {
    command: 'claude-tempo-server',
    args: [] as string[],
  };

  if (existsSync(mcpPath)) {
    try {
      const existing = JSON.parse(readFileSync(mcpPath, 'utf8'));
      if (existing?.mcpServers?.['claude-tempo']) {
        out.success('.mcp.json already has a claude-tempo entry');
        out.log(`  ${out.dim(mcpPath)}`);
        return;
      }
      // Merge into existing config
      existing.mcpServers = existing.mcpServers || {};
      existing.mcpServers['claude-tempo'] = entry;
      writeFileSync(mcpPath, JSON.stringify(existing, null, 2) + '\n');
      out.success('Added claude-tempo to existing .mcp.json');
    } catch {
      out.error(`Failed to parse ${mcpPath}. Fix the JSON or delete it and re-run.`);
      process.exit(1);
    }
  } else {
    const config = {
      mcpServers: {
        'claude-tempo': entry,
      },
    };
    writeFileSync(mcpPath, JSON.stringify(config, null, 2) + '\n');
    out.success('Created .mcp.json with claude-tempo config');
  }

  out.log(`  ${out.dim(mcpPath)}`);
  out.log(`\nNext steps:`);
  out.log(`  1. Start Temporal:  ${out.dim('temporal server start-dev')}`);
  out.log(`  2. Start conductor: ${out.dim('claude-tempo conduct')}`);
}

export function help() {
  console.log(`
${out.bold('claude-tempo')} — Multi-session Claude Code coordination via Temporal

${out.bold('Usage:')}
  claude-tempo <command> [options]

${out.bold('Commands:')}
  ${out.cyan('conduct')} [ensemble]    Start a conductor session (one per ensemble)
  ${out.cyan('start')}   [ensemble]    Start a player session
  ${out.cyan('status')}  [ensemble]    Show active sessions and Temporal health
  ${out.cyan('init')}                  Create .mcp.json config in the current directory
  ${out.cyan('preflight')}             Run preflight checks only
  ${out.cyan('help')}                  Show this help message

${out.bold('Options:')}
  --temporal-address <addr>   Temporal server address (default: localhost:7233)
  -n, --name <name>           Set the session window name (start/conduct only)
  --skip-preflight            Skip preflight checks (start/conduct only)
  --dir <path>                Target directory for init (default: cwd)

${out.bold('Examples:')}
  claude-tempo conduct myband        Start conducting the "myband" ensemble
  claude-tempo start myband          Join "myband" as a player
  claude-tempo status                Show all active ensembles
  claude-tempo status myband         Show sessions in "myband"
  claude-tempo init                  Set up MCP config in current project

${out.bold('Environment:')}
  CLAUDE_TEMPO_ENSEMBLE       Default ensemble name (fallback: "default")
  TEMPORAL_ADDRESS            Default Temporal address (fallback: localhost:7233)
`);
}

export function version() {
  try {
    const pkg = JSON.parse(readFileSync(join(PACKAGE_ROOT, 'package.json'), 'utf8'));
    out.log(`claude-tempo v${pkg.version}`);
  } catch {
    out.log('claude-tempo (unknown version)');
  }
}
