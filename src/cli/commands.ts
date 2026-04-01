import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'fs';
import { join, resolve } from 'path';
import { execFileSync, spawn as cpSpawn, ChildProcess } from 'child_process';
import { homedir } from 'os';
import { Connection, Client } from '@temporalio/client';
import { spawnInTerminal, spawnCopilotBridge } from '../spawn';
import { conductorWorkflowId, ENV } from '../config';
import { AgentType } from '../types';
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
  agent: AgentType;
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

  // Check if a conductor workflow already exists for this ensemble
  if (opts.conductor) {
    try {
      const connection = await Connection.connect({ address: opts.temporalAddress });
      const client = new Client({ connection });
      const conductorWfId = conductorWorkflowId(opts.ensemble);
      const handle = client.workflow.getHandle(conductorWfId);
      const desc = await handle.describe();
      if (desc.status.name === 'RUNNING') {
        out.warn(`A conductor workflow already exists for ensemble "${opts.ensemble}". Reconnecting...`);
      }
      await connection.close();
    } catch {
      // No existing conductor — proceed normally
    }
  }

  out.log(`Starting ${out.bold(role)} in ensemble ${out.cyan(opts.ensemble)}${opts.agent === 'copilot' ? out.dim(' (copilot)') : ''}`);

  if (opts.agent === 'copilot') {
    const { pid } = spawnCopilotBridge({
      name: opts.name || `copilot-${Date.now()}`,
      ensemble: opts.ensemble,
      temporalAddress: opts.temporalAddress,
      isConductor: opts.conductor,
      workDir,
    });
    out.success(`Launched copilot bridge${opts.name ? ` "${opts.name}"` : ''} (pid ${pid ?? 'unknown'})`);
  } else {
    const claudeArgs = [
      '--dangerously-skip-permissions',
      '--dangerously-load-development-channels', 'server:claude-tempo',
    ];
    if (opts.name) {
      claudeArgs.push('-n', opts.name);
    }

    const envVars: Record<string, string> = {
      [ENV.ENSEMBLE]: opts.ensemble,
    };
    if (opts.conductor) {
      envVars[ENV.CONDUCTOR] = 'true';
    }
    if (opts.name) {
      envVars[ENV.PLAYER_NAME] = opts.name;
    }

    const { pid } = spawnInTerminal(claudeArgs, workDir, envVars);
    out.success(`Launched ${role} session${opts.name ? ` "${opts.name}"` : ''} (pid ${pid ?? 'unknown'})`);
  }
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
    command: 'npx',
    args: ['claude-tempo-server'],
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

// --- Temporal server management ---

const CLAUDE_TEMPO_HOME = join(homedir(), '.claude-tempo');
const DEFAULT_DB_PATH = join(CLAUDE_TEMPO_HOME, 'temporal-data.db');

const SEARCH_ATTRIBUTES = [
  { name: 'ClaudeTempoHostname', type: 'Keyword' },
  { name: 'ClaudeTempoGitRoot', type: 'Keyword' },
  { name: 'ClaudeTempoEnsemble', type: 'Keyword' },
  { name: 'ClaudeTempoPlayerId', type: 'Keyword' },
];

function isTemporalReachable(address: string): Promise<boolean> {
  return Connection.connect({ address })
    .then(conn => { conn.close(); return true; })
    .catch(() => false);
}

function temporalCliExists(): boolean {
  const cmd = process.platform === 'win32' ? 'where' : 'which';
  try {
    execFileSync(cmd, ['temporal'], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}

function registerSearchAttributes(temporalAddress: string) {
  for (const attr of SEARCH_ATTRIBUTES) {
    try {
      execFileSync('temporal', [
        'operator', 'search-attribute', 'create',
        '--address', temporalAddress,
        '--name', attr.name,
        '--type', attr.type,
      ], { stdio: ['ignore', 'ignore', 'ignore'] });
      out.success(`Registered search attribute: ${attr.name}`);
    } catch {
      // Already exists or other error — safe to ignore
      out.dim(`  ${attr.name} (already exists)`);
    }
  }
}

interface ServerOpts {
  temporalAddress: string;
  background: boolean;
}

export async function server(opts: ServerOpts) {
  if (!temporalCliExists()) {
    out.error('temporal CLI not found on PATH');
    out.log(`  Install: ${out.dim('https://docs.temporal.io/cli')}`);
    process.exit(1);
  }

  // Check if already running
  const alreadyRunning = await isTemporalReachable(opts.temporalAddress);
  if (alreadyRunning) {
    out.success(`Temporal already running at ${opts.temporalAddress}`);
    out.log('  Registering search attributes...');
    registerSearchAttributes(opts.temporalAddress);
    return;
  }

  // Ensure data directory exists
  mkdirSync(CLAUDE_TEMPO_HOME, { recursive: true });

  const port = opts.temporalAddress.split(':')[1] || '7233';
  const args = [
    'server', 'start-dev',
    '--port', port,
    '--db-filename', DEFAULT_DB_PATH,
  ];

  out.log(`Starting Temporal dev server on port ${port}...`);
  out.log(`  Data: ${out.dim(DEFAULT_DB_PATH)}`);

  if (opts.background) {
    const child = cpSpawn('temporal', args, {
      detached: true,
      stdio: 'ignore',
    });
    child.unref();
    out.success(`Temporal started in background (pid ${child.pid})`);

    // Wait for it to be ready
    for (let i = 0; i < 20; i++) {
      await new Promise(r => setTimeout(r, 500));
      if (await isTemporalReachable(opts.temporalAddress)) break;
    }
  } else {
    // Foreground — register attributes after startup, then hand over stdio
    const child = cpSpawn('temporal', args, {
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    // Wait for ready, then register attributes
    const waitForReady = async () => {
      for (let i = 0; i < 20; i++) {
        await new Promise(r => setTimeout(r, 500));
        if (await isTemporalReachable(opts.temporalAddress)) {
          out.success(`Temporal running at ${opts.temporalAddress}`);
          out.log('  Registering search attributes...');
          registerSearchAttributes(opts.temporalAddress);
          out.log(`\n  ${out.dim('Press Ctrl+C to stop')}\n`);
          return;
        }
      }
      out.warn('Temporal started but not responding — search attributes not registered');
    };
    waitForReady();

    // Pipe output through
    child.stdout?.pipe(process.stdout);
    child.stderr?.pipe(process.stderr);

    // Forward signals for clean shutdown
    const forward = (sig: NodeJS.Signals) => { child.kill(sig); };
    process.on('SIGINT', () => forward('SIGINT'));
    process.on('SIGTERM', () => forward('SIGTERM'));

    await new Promise<void>((resolve) => {
      child.on('exit', (code) => {
        if (code && code !== 0) out.error(`Temporal exited with code ${code}`);
        resolve();
      });
    });
  }

  // Register search attributes (for background mode — foreground does it inline)
  if (opts.background) {
    out.log('  Registering search attributes...');
    registerSearchAttributes(opts.temporalAddress);
    out.success('Temporal ready');
  }
}

// --- First-time setup: `up` command ---

interface UpOpts {
  ensemble: string;
  temporalAddress: string;
  name?: string;
  agent: AgentType;
}

export async function up(opts: UpOpts) {
  out.heading('claude-tempo setup');

  // Step 1: Check temporal CLI
  if (!temporalCliExists()) {
    out.error('temporal CLI not found');
    out.log(`\n  Install the Temporal CLI first:`);
    out.log(`  ${out.dim('https://docs.temporal.io/cli')}\n`);
    process.exit(1);
  }
  out.check('temporal CLI installed', true);

  // Step 2: Start Temporal if needed
  const temporalUp = await isTemporalReachable(opts.temporalAddress);
  if (temporalUp) {
    out.check('Temporal running', true, opts.temporalAddress);
  } else {
    out.log(`  ${out.dim('...')} Starting Temporal dev server...`);
    mkdirSync(CLAUDE_TEMPO_HOME, { recursive: true });
    const port = opts.temporalAddress.split(':')[1] || '7233';
    const child = cpSpawn('temporal', [
      'server', 'start-dev',
      '--port', port,
      '--db-filename', DEFAULT_DB_PATH,
    ], { detached: true, stdio: 'ignore' });
    child.unref();

    // Wait for ready
    let ready = false;
    for (let i = 0; i < 20; i++) {
      await new Promise(r => setTimeout(r, 500));
      if (await isTemporalReachable(opts.temporalAddress)) { ready = true; break; }
    }
    if (!ready) {
      out.error('Temporal did not start within 10 seconds');
      process.exit(1);
    }
    out.check('Temporal started', true, `pid ${child.pid}, data in ~/.claude-tempo/`);
  }

  // Step 3: Register search attributes
  registerSearchAttributes(opts.temporalAddress);

  // Step 4: Init .mcp.json if needed
  const mcpPath = join(process.cwd(), '.mcp.json');
  let mcpExists = false;
  if (existsSync(mcpPath)) {
    try {
      const mcp = JSON.parse(readFileSync(mcpPath, 'utf8'));
      mcpExists = !!mcp?.mcpServers?.['claude-tempo'];
    } catch { /* invalid */ }
  }
  if (mcpExists) {
    out.check('.mcp.json configured', true);
  } else {
    await init({ dir: process.cwd() });
    out.check('.mcp.json created', true);
  }

  // Step 5: Launch conductor
  console.log();
  out.log(`Launching conductor in ensemble ${out.cyan(opts.ensemble)}${opts.agent === 'copilot' ? out.dim(' (copilot)') : ''}...`);

  let pid: number | undefined;
  if (opts.agent === 'copilot') {
    ({ pid } = spawnCopilotBridge({
      name: opts.name || `${opts.ensemble}-conductor`,
      ensemble: opts.ensemble,
      temporalAddress: opts.temporalAddress,
      isConductor: true,
      workDir: process.cwd(),
    }));
  } else {
    const claudeArgs = [
      '--dangerously-skip-permissions',
      '--dangerously-load-development-channels', 'server:claude-tempo',
    ];
    if (opts.name) claudeArgs.push('-n', opts.name);

    ({ pid } = spawnInTerminal(claudeArgs, process.cwd(), {
      [ENV.ENSEMBLE]: opts.ensemble,
      [ENV.CONDUCTOR]: 'true',
    }));
  }

  console.log();
  out.success('You\'re all set!');
  out.log(`  Conductor launched (pid ${pid ?? 'unknown'})`);
  out.log(`  Ensemble: ${out.cyan(opts.ensemble)}`);
  out.log(`\n  ${out.bold('What next?')}`);
  out.log(`  ${out.dim('claude-tempo start ' + opts.ensemble)}    Add a player session`);
  out.log(`  ${out.dim('claude-tempo status ' + opts.ensemble)}   See who\'s active`);
  out.log(`  Or ask the conductor to ${out.dim('recruit')} players for you`);
  console.log();
}

// --- Teardown: `down` command ---

interface DownOpts {
  temporalAddress: string;
  removeMcp: boolean;
  dir: string;
}

export async function down(opts: DownOpts) {
  out.heading('claude-tempo teardown');

  // Step 1: Terminate all active workflows
  const temporalUp = await isTemporalReachable(opts.temporalAddress);
  if (temporalUp) {
    try {
      const connection = await Connection.connect({ address: opts.temporalAddress });
      const client = new Client({ connection });
      const query = 'WorkflowType = "claudeSessionWorkflow" AND ExecutionStatus = "Running"';
      let terminated = 0;
      for await (const wf of client.workflow.list({ query })) {
        try {
          const handle = client.workflow.getHandle(wf.workflowId);
          await handle.terminate('claude-tempo down');
          terminated++;
        } catch { /* already closed */ }
      }
      await connection.close();
      if (terminated > 0) {
        out.success(`Terminated ${terminated} active session${terminated !== 1 ? 's' : ''}`);
      } else {
        out.log(`  ${out.dim('No active sessions to terminate')}`);
      }
    } catch {
      out.warn('Could not terminate active sessions');
    }
  }

  // Step 2: Stop Temporal server
  if (temporalUp) {
    // Find and kill the temporal dev server process
    try {
      if (process.platform === 'win32') {
        execFileSync('taskkill', ['/F', '/IM', 'temporal.exe'], { stdio: 'ignore' });
      } else {
        // Kill temporal server processes started by start-dev
        execFileSync('pkill', ['-f', 'temporal server start-dev'], { stdio: 'ignore' });
      }
      out.success('Temporal server stopped');
    } catch {
      out.warn('Could not stop Temporal server (may need to stop it manually)');
    }
  } else {
    out.log(`  ${out.dim('Temporal not running')}`);
  }

  // Step 3: Remove .mcp.json entry
  if (opts.removeMcp) {
    const mcpPath = join(opts.dir, '.mcp.json');
    if (existsSync(mcpPath)) {
      try {
        const existing = JSON.parse(readFileSync(mcpPath, 'utf8'));
        if (existing?.mcpServers?.['claude-tempo']) {
          delete existing.mcpServers['claude-tempo'];
          // If no other MCP servers remain, remove the file entirely
          if (Object.keys(existing.mcpServers).length === 0) {
            const { unlinkSync } = require('fs');
            unlinkSync(mcpPath);
            out.success('Removed .mcp.json (no other servers configured)');
          } else {
            writeFileSync(mcpPath, JSON.stringify(existing, null, 2) + '\n');
            out.success('Removed claude-tempo from .mcp.json');
          }
        } else {
          out.log(`  ${out.dim('.mcp.json has no claude-tempo entry')}`);
        }
      } catch {
        out.warn(`Could not update ${mcpPath}`);
      }
    } else {
      out.log(`  ${out.dim('No .mcp.json found')}`);
    }
  }

  console.log();
  out.success('claude-tempo is shut down');
  out.log(`  ${out.dim('Temporal data preserved in ~/.claude-tempo/ (delete manually to reset)')}`);
  console.log();
}

export function help() {
  console.log(`
${out.bold('claude-tempo')} — Multi-session Claude Code coordination via Temporal

${out.bold('Getting started:')}
  ${out.cyan('claude-tempo up')}                  Set up everything and launch a conductor

${out.bold('Usage:')}
  claude-tempo <command> [options]

${out.bold('Commands:')}
  ${out.cyan('up')}      [ensemble]    First-time setup: start Temporal, configure MCP, launch conductor
  ${out.cyan('down')}                  Stop Temporal, terminate sessions, remove MCP config
  ${out.cyan('server')}                Start the Temporal dev server and register search attributes
  ${out.cyan('conduct')} [ensemble]    Start a conductor session (one per ensemble)
  ${out.cyan('start')}   [ensemble]    Start a player session
  ${out.cyan('status')}  [ensemble]    Show active sessions and Temporal health
  ${out.cyan('init')}                  Create .mcp.json config in the current directory
  ${out.cyan('preflight')}             Run preflight checks only
  ${out.cyan('help')}                  Show this help message

${out.bold('Options:')}
  --temporal-address <addr>   Temporal server address (default: localhost:7233)
  -n, --name <name>           Set the session window name (start/conduct/up only)
  --agent <claude|copilot>    Agent type to spawn (default: claude; start/conduct)
  --skip-preflight            Skip preflight checks (start/conduct only)
  --background                Run Temporal in background (server only)
  --keep-mcp                  Don't remove .mcp.json entry (down only)
  --dir <path>                Target directory for init/down (default: cwd)

${out.bold('First time? Run this:')}
  ${out.dim('cd your-project')}
  ${out.dim('claude-tempo up')}

${out.bold('Typical workflow:')}
  ${out.dim('claude-tempo server')}               Start Temporal (once, keep running)
  ${out.dim('claude-tempo conduct myband')}       Start a conductor
  ${out.dim('claude-tempo start myband')}         Add player sessions
  ${out.dim('claude-tempo start myband --agent copilot -n copilot-1')}   Add a Copilot player
  ${out.dim('claude-tempo status myband')}        Check who's active

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
