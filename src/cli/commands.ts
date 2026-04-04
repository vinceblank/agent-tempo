import { existsSync, readFileSync, writeFileSync, mkdirSync, readdirSync, unlinkSync, copyFileSync } from 'fs';
import { join, resolve } from 'path';
import { execFileSync, spawn as cpSpawn } from 'child_process';
import { homedir } from 'os';
import { Client, Connection } from '@temporalio/client';
import { spawnInTerminal, spawnCopilotBridge, resolveClaudePath } from '../spawn';
import { conductorWorkflowId, schedulerWorkflowId, ENV, getConfig, Config, CliOverrides, CLAUDE_TEMPO_HOME } from '../config';
import { createTemporalConnection } from '../connection';
import { playerReportSignal, updateMetadataSignal } from '../workflows/signals';
import { addScheduleSignal } from '../workflows/scheduler-signals';
import { AgentType, ScheduleEntry } from '../types';
import { runPreflight } from './preflight';
import { isGlobalMcpRegistered, addGlobalMcp, removeGlobalMcp, isMcpConfigured } from './mcp';
import { loadBlueprint } from '../ensemble/loader';
import { saveBlueprint, listBlueprints, readSavedBlueprint } from '../ensemble/saver';
import { listAgentTypes, resolveAgentType } from '../ensemble/agent-types';
import * as out from './output';

/** Package root is two levels up from dist/cli/ */
const PACKAGE_ROOT = resolve(__dirname, '..', '..');

function formatDurationMs(ms: number): string {
  if (ms >= 86_400_000) return `${ms / 86_400_000}d`;
  if (ms >= 3_600_000) return `${ms / 3_600_000}h`;
  if (ms >= 60_000) return `${ms / 60_000}m`;
  return `${ms / 1000}s`;
}

interface StartOpts extends CliOverrides {
  ensemble: string;
  conductor: boolean;
  replace?: boolean;
  resume?: boolean;
  name?: string;
  skipPreflight?: boolean;
  agent: AgentType;
  dir?: string;
}

export async function start(opts: StartOpts) {
  const config = getConfig(opts);
  const workDir = opts.dir || process.cwd();

  if (!opts.skipPreflight) {
    const result = await runPreflight({
      dir: workDir,
      ...opts,
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
      const connection = await createTemporalConnection(config);
      const client = new Client({ connection, namespace: config.temporalNamespace });
      const conductorWfId = conductorWorkflowId(opts.ensemble);
      const handle = client.workflow.getHandle(conductorWfId);
      const desc = await handle.describe();
      if (desc.status.name === 'RUNNING') {
        if (opts.replace) {
          out.log(`Stopping existing conductor for ensemble "${opts.ensemble}"...`);
          try {
            await handle.signal(updateMetadataSignal, { status: 'terminated' });
            // Wait briefly for graceful shutdown
            for (let i = 0; i < 10; i++) {
              await new Promise(r => setTimeout(r, 500));
              const check = await handle.describe();
              if (check.status.name !== 'RUNNING') break;
            }
          } catch {
            // Force cancel if signal fails
            try { await handle.cancel(); } catch { /* already gone */ }
          }
          out.success('Existing conductor stopped');
        } else if (opts.resume) {
          out.log(`Resuming conductor for ensemble "${opts.ensemble}" — reconnecting to existing workflow state.\n`);
        } else {
          out.error(`A conductor is already running for ensemble "${opts.ensemble}".`);
          out.log(`  ${out.dim('claude-tempo conduct --resume')}    Reconnect a new session to the existing workflow`);
          out.log(`  ${out.dim('claude-tempo conduct --replace')}   Stop the existing conductor and start fresh`);
          await connection.close();
          process.exit(1);
        }
      }
      await connection.close();
    } catch {
      // No existing conductor — proceed normally
    }
  }

  out.log(`Starting ${out.bold(role)} in ensemble ${out.cyan(opts.ensemble)}${opts.agent === 'copilot' ? out.dim(' (copilot)') : ''}`);

  // Always forward all resolved Temporal settings to child processes.
  // Don't skip defaults — child processes may not have access to the same config file.
  const temporalEnvVars: Record<string, string> = {
    [ENV.TEMPORAL_ADDRESS]: config.temporalAddress,
    [ENV.TEMPORAL_NAMESPACE]: config.temporalNamespace,
  };
  if (config.temporalApiKey) temporalEnvVars[ENV.TEMPORAL_API_KEY] = config.temporalApiKey;
  if (config.temporalTlsCertPath) temporalEnvVars[ENV.TEMPORAL_TLS_CERT_PATH] = config.temporalTlsCertPath;
  if (config.temporalTlsKeyPath) temporalEnvVars[ENV.TEMPORAL_TLS_KEY_PATH] = config.temporalTlsKeyPath;

  if (opts.agent === 'copilot') {
    const { pid } = spawnCopilotBridge({
      name: opts.name || `copilot-${Date.now()}`,
      ensemble: opts.ensemble,
      temporalAddress: config.temporalAddress,
      temporalNamespace: config.temporalNamespace,
      temporalApiKey: config.temporalApiKey,
      temporalTlsCertPath: config.temporalTlsCertPath,
      temporalTlsKeyPath: config.temporalTlsKeyPath,
      isConductor: opts.conductor,
      workDir,
    });
    out.success(`Launched copilot bridge${opts.name ? ` "${opts.name}"` : ''} (pid ${pid ?? 'unknown'})`);
  } else {
    // Default conductor name to "conductor" so the Claude Code session name matches
    const sessionName = opts.name || (opts.conductor ? 'conductor' : undefined);

    const claudeArgs = [
      '--dangerously-skip-permissions',
      '--dangerously-load-development-channels', 'server:claude-tempo',
    ];
    if (opts.resume && sessionName) {
      // Resume the previous Claude Code conversation by name
      claudeArgs.push('--resume', sessionName);
    } else if (sessionName) {
      claudeArgs.push('-n', sessionName);
    }

    const envVars: Record<string, string> = {
      ...temporalEnvVars,
      [ENV.ENSEMBLE]: opts.ensemble,
      [ENV.CONDUCTOR]: opts.conductor ? 'true' : '',
      [ENV.PLAYER_NAME]: sessionName || '',
    };

    const { pid } = spawnInTerminal(claudeArgs, workDir, envVars);
    out.success(`Launched ${role} session${sessionName ? ` "${sessionName}"` : ''} (pid ${pid ?? 'unknown'})`);
  }
  out.log(`  Ensemble: ${opts.ensemble}`);
  out.log(`  Directory: ${workDir}`);
  out.log(`\nCheck status: ${out.dim('claude-tempo status ' + opts.ensemble)}`);
}

interface StatusOpts extends CliOverrides {
  ensemble?: string;
}

export async function status(opts: StatusOpts) {
  const config = getConfig(opts);
  let connection: Connection;
  try {
    connection = await Promise.race([
      createTemporalConnection(config),
      new Promise<never>((_, reject) => setTimeout(() => reject(new Error('timeout')), 3000)),
    ]);
  } catch {
    out.error(`Cannot connect to Temporal at ${config.temporalAddress}`);
    out.log(`  Run: ${out.dim('temporal server start-dev')}`);
    process.exit(1);
    return; // unreachable, helps TS
  }

  const client = new Client({ connection, namespace: config.temporalNamespace });

  // List all running session workflows, filter by ensemble using metadata queries.
  // This avoids depending on custom search attributes which are eventually consistent.
  const query = 'WorkflowType = "claudeSessionWorkflow" AND ExecutionStatus = "Running"';

  const sessions: Array<{
    id: string;
    name: string;
    part: string;
    ensemble: string;
    workDir: string;
    branch: string;
    host: string;
    conductor: boolean;
    agentType: string;
    status: string;
  }> = [];

  for await (const wf of client.workflow.list({ query })) {
    try {
      const handle = client.workflow.getHandle(wf.workflowId);
      const [metadata, part] = await Promise.all([
        handle.query('getMetadata').catch(() => ({})),
        handle.query('getPart').catch(() => ''),
      ]);
      const meta = metadata as Record<string, unknown>;
      const ensemble = (meta.ensemble as string) || '?';

      // Filter by ensemble if specified
      if (opts.ensemble && ensemble !== opts.ensemble) continue;

      sessions.push({
        id: wf.workflowId,
        name: (meta.playerId as string) || wf.workflowId.split('-').pop() || '?',
        part: (part as string) || '',
        ensemble,
        workDir: (meta.workDir as string) || '?',
        branch: (meta.gitBranch as string) || '',
        host: (meta.hostname as string) || '',
        conductor: (meta.isConductor as boolean) || false,
        agentType: (meta.agentType as string) || 'claude',
        status: (meta.status as string) || 'active',
      });
    } catch {
      // workflow may have closed between list and query
    }
  }

  // Query scheduler workflows for active schedules
  const schedulesByEnsemble = new Map<string, Array<{
    name: string;
    target: string;
    nextFireAt: string;
    interval?: number;
    type: string;
    remainingCount?: number;
    firedCount: number;
    createdBy: string;
    message: string;
  }>>();

  const schedulerQuery = 'WorkflowType = "claudeSchedulerWorkflow" AND ExecutionStatus = "Running"';
  for await (const wf of client.workflow.list({ query: schedulerQuery })) {
    try {
      const handle = client.workflow.getHandle(wf.workflowId);
      const entries = await handle.query('getSchedules') as any[];
      if (entries.length > 0) {
        // Extract ensemble from workflow ID: claude-scheduler-{ensemble}
        const ensemble = wf.workflowId.replace('claude-scheduler-', '');
        if (opts.ensemble && ensemble !== opts.ensemble) continue;
        schedulesByEnsemble.set(ensemble, entries);
      }
    } catch {
      // scheduler may have just completed
    }
  }

  await connection.close();

  if (sessions.length === 0 && schedulesByEnsemble.size === 0) {
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
      const agent = s.agentType === 'copilot' ? out.dim(' [copilot]') : '';
      const statusLabel = s.status === 'stale' ? out.yellow(' (stale)')
        : s.status === 'pending' ? out.dim(' (pending)')
        : '';
      const name = out.bold(s.name);
      out.log(`  ${name}${role}${statusLabel}${agent}`);
      if (s.part) out.log(`    ${out.dim(s.part)}`);
      const details = [s.workDir, s.branch, s.host].filter(Boolean).join('  ');
      if (details) out.log(`    ${out.dim(details)}`);
    }

    // Show schedules for this ensemble
    const ensembleSchedules = schedulesByEnsemble.get(ensemble);
    if (ensembleSchedules && ensembleSchedules.length > 0) {
      console.log();
      out.log(`  ${out.dim(`${ensembleSchedules.length} active schedule${ensembleSchedules.length !== 1 ? 's' : ''}`)}`);
      for (const sched of ensembleSchedules) {
        const recur = sched.interval
          ? `every ${formatDurationMs(sched.interval)}`
          : 'one-shot';
        const next = new Date(sched.nextFireAt).toLocaleTimeString();
        const bounds: string[] = [];
        if (sched.remainingCount != null) bounds.push(`${sched.firedCount}/${sched.firedCount + sched.remainingCount} fired`);
        const boundsStr = bounds.length ? ` (${bounds.join(', ')})` : '';
        out.log(`  ${out.bold(sched.name)} → ${sched.target} | ${recur}${boundsStr} | next: ${next}`);
      }
    }
  }
  console.log();
}

interface InitOpts {
  dir: string;
  project?: boolean;
}

export async function init(opts: InitOpts) {
  if (opts.project) {
    // Per-project .mcp.json mode
    return initProject(opts.dir);
  }

  // Default: global install via `claude mcp add`
  if (isGlobalMcpRegistered()) {
    out.success('claude-tempo already registered globally');
    out.log(`  ${out.dim('claude mcp list -s user')}`);
    return;
  }

  const claudePath = resolveClaudePath();
  if (claudePath === 'claude') {
    out.warn('claude binary not found — falling back to project-level .mcp.json');
    return initProject(opts.dir);
  }

  if (addGlobalMcp()) {
    out.success('Registered claude-tempo globally (user scope)');
    out.log(`  ${out.dim('Available in all Claude Code sessions')}`);
  } else {
    out.warn('Failed to register globally — falling back to project-level .mcp.json');
    return initProject(opts.dir);
  }

  out.log(`\nNext steps:`);
  out.log(`  1. Start Temporal:  ${out.dim('temporal server start-dev')}`);
  out.log(`  2. Start conductor: ${out.dim('claude-tempo conduct')}`);
}

/** Per-project .mcp.json install (legacy, used with --project flag). */
function initProject(dir: string) {
  const mcpPath = join(dir, '.mcp.json');

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

const DEFAULT_DB_PATH = join(CLAUDE_TEMPO_HOME, 'temporal-data.db');

const SEARCH_ATTRIBUTES = [
  { name: 'ClaudeTempoHostname', type: 'Keyword' },
  { name: 'ClaudeTempoGitRoot', type: 'Keyword' },
  { name: 'ClaudeTempoEnsemble', type: 'Keyword' },
  { name: 'ClaudeTempoPlayerId', type: 'Keyword' },
  { name: 'ClaudeTempoStatus', type: 'Keyword' },
  { name: 'ClaudeTempoPlayerType', type: 'Keyword' },
];

function isTemporalReachable(config: { temporalAddress: string; temporalApiKey?: string; temporalTlsCertPath?: string; temporalTlsKeyPath?: string }): Promise<boolean> {
  return createTemporalConnection(config as any)
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

function registerSearchAttributes(temporalAddress: string, namespace = 'default') {
  for (const attr of SEARCH_ATTRIBUTES) {
    try {
      execFileSync('temporal', [
        'operator', 'search-attribute', 'create',
        '--address', temporalAddress,
        '--namespace', namespace,
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

interface ServerOpts extends CliOverrides {
  background: boolean;
}

export async function server(opts: ServerOpts) {
  const config = getConfig(opts);

  if (!temporalCliExists()) {
    out.error('temporal CLI not found on PATH');
    out.log(`  Install: ${out.dim('https://docs.temporal.io/cli')}`);
    process.exit(1);
  }

  // Check if already running
  const alreadyRunning = await isTemporalReachable(config);
  if (alreadyRunning) {
    out.success(`Temporal already running at ${config.temporalAddress}`);
    out.log('  Registering search attributes...');
    registerSearchAttributes(config.temporalAddress, config.temporalNamespace);
    return;
  }

  // Ensure data directory exists
  mkdirSync(CLAUDE_TEMPO_HOME, { recursive: true });

  const port = config.temporalAddress.split(':')[1] || '7233';
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
      if (await isTemporalReachable(config)) break;
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
        if (await isTemporalReachable(config)) {
          out.success(`Temporal running at ${config.temporalAddress}`);
          out.log('  Registering search attributes...');
          registerSearchAttributes(config.temporalAddress, config.temporalNamespace);
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
    registerSearchAttributes(config.temporalAddress, config.temporalNamespace);
    out.success('Temporal ready');
  }
}

// --- First-time setup: `up` command ---

interface UpOpts extends CliOverrides {
  ensemble: string;
  name?: string;
  blueprint?: string;
  agent: AgentType;
}

export async function up(opts: UpOpts) {
  const config = getConfig(opts);

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
  const temporalUp = await isTemporalReachable(config);
  if (temporalUp) {
    out.check('Temporal running', true, config.temporalAddress);
  } else {
    out.log(`  ${out.dim('...')} Starting Temporal dev server...`);
    mkdirSync(CLAUDE_TEMPO_HOME, { recursive: true });
    const port = config.temporalAddress.split(':')[1] || '7233';
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
      if (await isTemporalReachable(config)) { ready = true; break; }
    }
    if (!ready) {
      out.error('Temporal did not start within 10 seconds');
      process.exit(1);
    }
    out.check('Temporal started', true, `pid ${child.pid}, data in ~/.claude-tempo/`);
  }

  // Step 3: Register search attributes
  registerSearchAttributes(config.temporalAddress, config.temporalNamespace);

  // Step 3.5: Install shipped agent types to ~/.claude/agents/ (if not already there)
  const userAgentsDir = join(homedir(), '.claude', 'agents');
  const shippedAgentsPath = join(PACKAGE_ROOT, 'examples', 'agents');
  if (existsSync(shippedAgentsPath)) {
    mkdirSync(userAgentsDir, { recursive: true });
    const shipped = readdirSync(shippedAgentsPath).filter(f => f.endsWith('.md'));
    let installed = 0;
    for (const file of shipped) {
      const dest = join(userAgentsDir, file);
      if (!existsSync(dest)) {
        copyFileSync(join(shippedAgentsPath, file), dest);
        installed++;
      }
    }
    if (installed > 0) {
      out.success(`Installed ${installed} agent type${installed !== 1 ? 's' : ''} to ~/.claude/agents/`);
    } else {
      out.dim(`  Agent types already installed (${shipped.length} in ~/.claude/agents/)`);
    }
  }

  // Step 4: Register MCP server if needed
  if (isMcpConfigured(process.cwd())) {
    out.check('MCP configured', true);
  } else {
    await init({ dir: process.cwd() });
    out.check('MCP configured', true);
  }

  // Always forward all resolved Temporal settings to child processes.
  const temporalEnvVars: Record<string, string> = {
    [ENV.TEMPORAL_ADDRESS]: config.temporalAddress,
    [ENV.TEMPORAL_NAMESPACE]: config.temporalNamespace,
  };
  if (config.temporalApiKey) temporalEnvVars[ENV.TEMPORAL_API_KEY] = config.temporalApiKey;
  if (config.temporalTlsCertPath) temporalEnvVars[ENV.TEMPORAL_TLS_CERT_PATH] = config.temporalTlsCertPath;
  if (config.temporalTlsKeyPath) temporalEnvVars[ENV.TEMPORAL_TLS_KEY_PATH] = config.temporalTlsKeyPath;

  // Load blueprint if --blueprint is provided (also accepts --from for backward compat)
  let blueprint;
  const blueprintArg = opts.blueprint;
  if (blueprintArg) {
    // Resolve by name or file path
    let blueprintPath: string;
    if (existsSync(resolve(blueprintArg))) {
      // Direct file path
      blueprintPath = resolve(blueprintArg);
    } else {
      // Try saved blueprints (~/.claude-tempo/ensembles/)
      const ensemblesDir = join(CLAUDE_TEMPO_HOME, 'ensembles');
      const savedYaml = join(ensemblesDir, `${blueprintArg}.yaml`);
      const savedYml = join(ensemblesDir, `${blueprintArg}.yml`);
      if (existsSync(savedYaml)) {
        blueprintPath = savedYaml;
      } else if (existsSync(savedYml)) {
        blueprintPath = savedYml;
      } else {
        // Try shipped examples
        const shippedPath = join(PACKAGE_ROOT, 'examples', 'ensembles', `${blueprintArg}.yaml`);
        const shippedYml = join(PACKAGE_ROOT, 'examples', 'ensembles', `${blueprintArg}.yml`);
        if (existsSync(shippedPath)) {
          blueprintPath = shippedPath;
        } else if (existsSync(shippedYml)) {
          blueprintPath = shippedYml;
        } else {
          out.error(`Blueprint "${blueprintArg}" not found as file, saved blueprint, or shipped example`);
          const saved = listBlueprints();
          if (saved.length) out.log(`  Saved: ${saved.map(b => b.name).join(', ')}`);
          const shipped = readdirSync(join(PACKAGE_ROOT, 'examples', 'ensembles')).filter(f => f.endsWith('.yaml') || f.endsWith('.yml')).map(f => f.replace(/\.ya?ml$/, ''));
          if (shipped.length) out.log(`  Shipped: ${shipped.join(', ')}`);
          process.exit(1);
        }
      }
    }
    blueprint = loadBlueprint(blueprintPath);
  }
  if (blueprint) {
    out.check('Blueprint loaded', true, blueprint.name);
  }

  // Resolve conductor agent from blueprint or CLI flags
  const conductorAgent: AgentType = blueprint?.conductor?.agent === 'copilot' ? 'copilot' : opts.agent;

  // Step 5: Launch conductor
  console.log();
  out.log(`Launching conductor in ensemble ${out.cyan(opts.ensemble)}${conductorAgent === 'copilot' ? out.dim(' (copilot)') : ''}...`);

  let pid: number | undefined;
  if (conductorAgent === 'copilot') {
    ({ pid } = spawnCopilotBridge({
      name: opts.name || `${opts.ensemble}-conductor`,
      ensemble: opts.ensemble,
      temporalAddress: config.temporalAddress,
      temporalNamespace: config.temporalNamespace,
      temporalApiKey: config.temporalApiKey,
      temporalTlsCertPath: config.temporalTlsCertPath,
      temporalTlsKeyPath: config.temporalTlsKeyPath,
      isConductor: true,
      workDir: process.cwd(),
    }));
  } else {
    // Default conductor name so the Claude Code session name matches the ensemble role
    const sessionName = opts.name || 'conductor';

    // Resolve conductor agent type from blueprint
    const conductorType = blueprint?.conductor?.agent && blueprint.conductor.agent !== 'default' && blueprint.conductor.agent !== 'copilot'
      ? blueprint.conductor.agent  // custom agent path
      : undefined;
    // Also check if the blueprint has a type field (from our schema extension — not standard yet)
    const conductorTypeName = (blueprint?.conductor as any)?.type as string | undefined;
    const resolvedConductorType = conductorTypeName ? resolveAgentType(conductorTypeName) : null;

    const claudeArgs = [
      '--dangerously-skip-permissions',
      '--dangerously-load-development-channels', 'server:claude-tempo',
      '-n', sessionName,
      // Pass agent definition if available
      ...(resolvedConductorType?.nativeResolvable ? ['--agent', resolvedConductorType.name] :
          resolvedConductorType ? ['--system-prompt', resolvedConductorType.path] :
          conductorType ? ['--system-prompt', conductorType] : []),
    ];

    const conductorEnvVars: Record<string, string> = {
      ...temporalEnvVars,
      [ENV.ENSEMBLE]: opts.ensemble,
      [ENV.CONDUCTOR]: 'true',
      [ENV.PLAYER_NAME]: sessionName,
    };
    if (resolvedConductorType || conductorTypeName) {
      conductorEnvVars[ENV.PLAYER_TYPE] = resolvedConductorType?.name || conductorTypeName || '';
    }

    ({ pid } = spawnInTerminal(claudeArgs, process.cwd(), conductorEnvVars));
  }

  out.success(`Conductor launched (pid ${pid ?? 'unknown'})`);

  // Step 6: If blueprint provided, recruit players and create schedules
  if (blueprint) {
    // Connect to Temporal to send signals
    const connection = await createTemporalConnection(config);
    const client = new Client({ connection, namespace: config.temporalNamespace });

    // Wait for conductor workflow to appear
    out.log(`\n  Waiting for conductor to register...`);
    const conductorWfId = conductorWorkflowId(opts.ensemble);
    let conductorReady = false;
    for (let i = 0; i < 30; i++) {
      await new Promise(r => setTimeout(r, 500));
      try {
        const handle = client.workflow.getHandle(conductorWfId);
        const desc = await handle.describe();
        if (desc.status.name === 'RUNNING') { conductorReady = true; break; }
      } catch { /* not yet */ }
    }

    if (!conductorReady) {
      out.warn('Conductor did not register within 15s — skipping blueprint players/schedules');
    } else {
      out.check('Conductor registered', true);

      // Send conductor instructions if provided
      if (blueprint.conductor?.instructions) {
        try {
          const handle = client.workflow.getHandle(conductorWfId);
          await handle.signal('receiveMessage', {
            from: 'blueprint',
            text: blueprint.conductor.instructions,
          });
          out.check('Conductor instructions sent', true);
        } catch (err) {
          out.warn(`Could not send conductor instructions: ${err}`);
        }
      }

      // Recruit players sequentially (each polls for ~15s)
      if (blueprint.players.length > 0) {
        console.log();
        out.log(`Recruiting ${blueprint.players.length} player${blueprint.players.length !== 1 ? 's' : ''} from blueprint...`);

        for (const player of blueprint.players) {
          const playerAgent: AgentType = player.agent === 'copilot' ? 'copilot' : 'claude';
          const playerWorkDir = player.workDir || process.cwd();

          // Record existing workflows to detect the new one
          const existingIds = new Set<string>();
          const listQuery = `WorkflowType = "claudeSessionWorkflow" AND ExecutionStatus = "Running"`;
          for await (const wf of client.workflow.list({ query: listQuery })) {
            existingIds.add(wf.workflowId);
          }

          // Spawn the player
          if (playerAgent === 'copilot') {
            spawnCopilotBridge({
              name: player.name,
              ensemble: opts.ensemble,
              temporalAddress: config.temporalAddress,
              temporalNamespace: config.temporalNamespace,
              temporalApiKey: config.temporalApiKey,
              temporalTlsCertPath: config.temporalTlsCertPath,
              temporalTlsKeyPath: config.temporalTlsKeyPath,
              isConductor: false,
              workDir: playerWorkDir,
            });
          } else {
            // Resolve player type from blueprint
            const playerTypeName = player.type;
            const resolvedPlayerType = playerTypeName ? resolveAgentType(playerTypeName) : null;

            const claudeArgs = [
              '--dangerously-skip-permissions',
              '--dangerously-load-development-channels', 'server:claude-tempo',
              '-n', player.name,
              ...(resolvedPlayerType?.nativeResolvable ? ['--agent', resolvedPlayerType.name] :
                  resolvedPlayerType ? ['--system-prompt', resolvedPlayerType.path] : []),
            ];
            const playerEnvVars: Record<string, string> = {
              ...temporalEnvVars,
              [ENV.ENSEMBLE]: opts.ensemble,
              [ENV.CONDUCTOR]: '',
              [ENV.PLAYER_NAME]: player.name,
            };
            if (resolvedPlayerType) {
              playerEnvVars[ENV.PLAYER_TYPE] = resolvedPlayerType.name;
            }
            spawnInTerminal(claudeArgs, playerWorkDir, playerEnvVars);
          }

          // Poll for the new workflow to appear (up to ~15s)
          let newWorkflowId: string | null = null;
          for (let attempt = 0; attempt < 30; attempt++) {
            await new Promise(r => setTimeout(r, 500));
            for await (const wf of client.workflow.list({ query: listQuery })) {
              if (!existingIds.has(wf.workflowId)) {
                newWorkflowId = wf.workflowId;
                break;
              }
            }
            if (newWorkflowId) break;
          }

          if (newWorkflowId && player.instructions) {
            try {
              const handle = client.workflow.getHandle(newWorkflowId);
              await handle.signal('receiveMessage', {
                from: 'blueprint',
                text: player.instructions,
              });
            } catch { /* best effort */ }
          }

          const status = newWorkflowId ? out.green('ok') : out.yellow('slow');
          out.log(`  ${status} ${out.bold(player.name)} in ${playerWorkDir}`);
        }
      }

      // Create schedules
      if (blueprint.schedules && blueprint.schedules.length > 0) {
        console.log();
        out.log(`Creating ${blueprint.schedules.length} schedule${blueprint.schedules.length !== 1 ? 's' : ''}...`);

        for (const sched of blueprint.schedules) {
          try {
            const entry = blueprintScheduleToEntry(sched);
            const schedulerWfId = schedulerWorkflowId(opts.ensemble);
            const handle = client.workflow.getHandle(schedulerWfId);
            await handle.signal(addScheduleSignal, entry);
            out.check(sched.name, true, `→ ${sched.target}`);
          } catch (err) {
            out.warn(`Could not create schedule "${sched.name}": ${err}`);
          }
        }
      }
    }

    await connection.close();
  }

  console.log();
  out.success('You\'re all set!');
  out.log(`  Ensemble: ${out.cyan(opts.ensemble)}`);
  if (!blueprint) {
    out.log(`\n  ${out.bold('What next?')}`);
    out.log(`  ${out.dim('claude-tempo start ' + opts.ensemble)}    Add a player session`);
    out.log(`  ${out.dim('claude-tempo status ' + opts.ensemble)}   See who\'s active`);
    out.log(`  Or ask the conductor to ${out.dim('recruit')} players for you`);
  } else {
    out.log(`  Blueprint: ${out.dim(blueprint.name)}`);
    out.log(`  Players: ${blueprint.players.length}`);
    if (blueprint.schedules?.length) out.log(`  Schedules: ${blueprint.schedules.length}`);
    out.log(`\n  ${out.dim('claude-tempo status ' + opts.ensemble)}   See who\'s active`);
  }
  console.log();
}

/** Convert a blueprint schedule definition to a ScheduleEntry for the scheduler workflow. */
function blueprintScheduleToEntry(sched: NonNullable<import('../ensemble/schema').EnsembleBlueprint['schedules']>[number]): ScheduleEntry {
  const now = Date.now();
  let nextFireAt: string;
  let interval: number | undefined;

  if (sched.every) {
    interval = parseDuration(sched.every);
    nextFireAt = sched.delay
      ? new Date(now + parseDuration(sched.delay)).toISOString()
      : new Date(now + interval).toISOString();
  } else if (sched.at) {
    nextFireAt = new Date(sched.at).toISOString();
  } else if (sched.delay) {
    nextFireAt = new Date(now + parseDuration(sched.delay)).toISOString();
  } else {
    nextFireAt = new Date(now + 60_000).toISOString(); // default: 1 minute
  }

  return {
    name: sched.name,
    message: sched.message,
    target: sched.target,
    createdBy: 'blueprint',
    nextFireAt,
    interval,
    until: sched.until,
    remainingCount: sched.count,
    firedCount: 0,
    type: interval ? 'interval' : 'once',
  };
}

/** Parse a human duration string like "10m", "1h", "30s" to milliseconds. */
function parseDuration(s: string): number {
  const match = s.match(/^(\d+(?:\.\d+)?)\s*(s|m|h|d)$/);
  if (!match) throw new Error(`Invalid duration: "${s}"`);
  const value = parseFloat(match[1]);
  switch (match[2]) {
    case 's': return value * 1_000;
    case 'm': return value * 60_000;
    case 'h': return value * 3_600_000;
    case 'd': return value * 86_400_000;
    default: throw new Error(`Unknown duration unit: "${match[2]}"`);
  }
}

// --- Teardown: `down` command ---

interface DownOpts extends CliOverrides {
  removeMcp: boolean;
  dir: string;
}

export async function down(opts: DownOpts) {
  const config = getConfig(opts);

  out.heading('claude-tempo teardown');

  // Step 1: Terminate all active workflows
  const temporalUp = await isTemporalReachable(config);
  if (temporalUp) {
    try {
      const connection = await createTemporalConnection(config);
      const client = new Client({ connection, namespace: config.temporalNamespace });
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

  // Step 2: Kill bridge processes via PID files
  killBridgeProcesses();

  // Step 3: Stop Temporal server
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

  // Step 4: Remove MCP config (global + project-level)
  if (opts.removeMcp) {
    // Remove global registration
    if (isGlobalMcpRegistered()) {
      if (removeGlobalMcp()) {
        out.success('Removed claude-tempo from global MCP config');
      } else {
        out.warn('Could not remove global MCP entry');
      }
    }

    // Also remove project-level .mcp.json entry if present
    const mcpPath = join(opts.dir, '.mcp.json');
    if (existsSync(mcpPath)) {
      try {
        const existing = JSON.parse(readFileSync(mcpPath, 'utf8'));
        if (existing?.mcpServers?.['claude-tempo']) {
          delete existing.mcpServers['claude-tempo'];
          if (Object.keys(existing.mcpServers).length === 0) {
            unlinkSync(mcpPath);
            out.success('Removed .mcp.json (no other servers configured)');
          } else {
            writeFileSync(mcpPath, JSON.stringify(existing, null, 2) + '\n');
            out.success('Removed claude-tempo from .mcp.json');
          }
        }
      } catch {
        out.warn(`Could not update ${mcpPath}`);
      }
    }
  }

  console.log();
  out.success('claude-tempo is shut down');
  out.log(`  ${out.dim('Temporal data preserved in ~/.claude-tempo/ (delete manually to reset)')}`);
  console.log();
}

// --- Stop sessions: `stop` command ---

interface StopOpts extends CliOverrides {
  /** Stop a specific player by name. */
  name?: string;
  /** Stop all sessions in this ensemble. */
  ensemble?: string;
  /** Stop every session across all ensembles. */
  all?: boolean;
}

export async function stop(opts: StopOpts) {
  const config = getConfig(opts);

  if (!opts.name && !opts.ensemble && !opts.all) {
    out.error('Specify what to stop:');
    out.log(`  ${out.dim('claude-tempo stop <ensemble>')}          Stop all sessions in an ensemble`);
    out.log(`  ${out.dim('claude-tempo stop <ensemble> -n <name>')} Stop a specific session`);
    out.log(`  ${out.dim('claude-tempo stop --all')}               Stop everything`);
    process.exit(1);
  }

  let connection: Connection;
  try {
    connection = await Promise.race([
      createTemporalConnection(config),
      new Promise<never>((_, reject) => setTimeout(() => reject(new Error('timeout')), 3000)),
    ]);
  } catch {
    out.error(`Cannot connect to Temporal at ${config.temporalAddress}`);
    process.exit(1);
    return;
  }

  const client = new Client({ connection, namespace: config.temporalNamespace });

  if (opts.name) {
    // Stop a specific player by name (optionally scoped to ensemble)
    await stopByName(client, opts.name, config, opts.ensemble);
  } else {
    // Stop multiple sessions (--ensemble or --all)
    const query = 'WorkflowType = "claudeSessionWorkflow" AND ExecutionStatus = "Running"';

    let stopped = 0;
    for await (const wf of client.workflow.list({ query })) {
      try {
        const handle = client.workflow.getHandle(wf.workflowId);

        // Filter by ensemble using metadata if specified
        if (opts.ensemble) {
          try {
            const meta = (await handle.query('getMetadata')) as Record<string, unknown>;
            if ((meta.ensemble as string) !== opts.ensemble) continue;
          } catch {
            continue;
          }
        }

        await handle.signal(updateMetadataSignal, { status: 'terminated' });
        stopped++;
        out.log(`  ${out.dim('stopped')} ${wf.workflowId}`);
      } catch {
        // already closed
      }
    }

    // Clean up PID files
    if (opts.ensemble || opts.all) {
      killBridgeProcesses();
    }

    if (stopped > 0) {
      out.success(`Stopped ${stopped} session${stopped !== 1 ? 's' : ''}`);
    } else {
      out.log(opts.ensemble
        ? `No active sessions in ensemble "${opts.ensemble}".`
        : 'No active sessions found.');
    }
  }

  await connection.close();
}

async function stopByName(client: Client, name: string, config: Config, ensemble?: string) {
  // Find the workflow by player name using metadata queries (not search attributes).
  const query = `WorkflowType = "claudeSessionWorkflow" AND ExecutionStatus = "Running"`;
  let found = false;

  for await (const wf of client.workflow.list({ query })) {
    const handle = client.workflow.getHandle(wf.workflowId);

    // Check metadata to match by name and ensemble
    let metadata: Record<string, unknown>;
    try {
      metadata = (await handle.query('getMetadata')) as Record<string, unknown>;
      if ((metadata.playerId as string) !== name) continue;
      if (ensemble && (metadata.ensemble as string) !== ensemble) continue;
    } catch {
      continue;
    }

    found = true;

    if (metadata.isConductor) {
      out.warn(`"${name}" is a conductor session`);
    }

    // Notify the conductor that this session was stopped (if it's not the conductor itself)
    if (!metadata.isConductor && metadata.ensemble) {
      try {
        const conductorWfId = conductorWorkflowId(metadata.ensemble as string);
        const conductorHandle = client.workflow.getHandle(conductorWfId);
        await conductorHandle.signal(playerReportSignal, {
          playerId: name,
          text: 'Session stopped by CLI',
          type: 'result' as const,
        });
      } catch {
        // No conductor or conductor not running — fine
      }
    }

    // Send termination status update (graceful)
    try {
      await handle.signal(updateMetadataSignal, { status: 'terminated' });
      out.success(`Stopped "${name}"`);
    } catch {
      out.warn(`Could not signal "${name}" — it may have already exited`);
    }

    // Try to kill bridge process via PID file
    killBridgePid(name);
    break;
  }

  if (!found) {
    out.error(`No active session found with name "${name}"`);
    process.exit(1);
  }
}

/**
 * Kill a bridge process by reading its PID file from logs/.
 * Cleans up the PID file after.
 */
function killBridgePid(name: string) {
  const pidPath = join(process.cwd(), 'logs', `${name}.pid`);
  if (!existsSync(pidPath)) return;

  try {
    const pid = parseInt(readFileSync(pidPath, 'utf8').trim(), 10);
    if (!isNaN(pid)) {
      try {
        process.kill(pid);
        out.log(`  ${out.dim(`Killed bridge process (pid ${pid})`)}`);
      } catch {
        // Process already dead
      }
    }
    unlinkSync(pidPath);
  } catch {
    // PID file unreadable — ignore
  }
}

/**
 * Kill all bridge processes found in logs/*.pid and clean up PID files.
 */
function killBridgeProcesses() {
  const logsDir = join(process.cwd(), 'logs');
  if (!existsSync(logsDir)) return;

  try {
    const pidFiles = readdirSync(logsDir).filter(f => f.endsWith('.pid'));
    for (const pidFile of pidFiles) {
      const pidPath = join(logsDir, pidFile);
      try {
        const pid = parseInt(readFileSync(pidPath, 'utf8').trim(), 10);
        if (!isNaN(pid)) {
          try {
            process.kill(pid);
            out.log(`  ${out.dim(`Killed bridge process ${pidFile.replace('.pid', '')} (pid ${pid})`)}`);
          } catch {
            // already dead
          }
        }
        unlinkSync(pidPath);
      } catch {
        // unreadable — skip
      }
    }
  } catch {
    // logs dir unreadable
  }
}

// --- Agent types commands ---

interface AgentTypesCommandOpts {
  subcommand?: string;
  name?: string;
}

export async function agentTypesCommand(opts: AgentTypesCommandOpts) {
  switch (opts.subcommand) {
    case 'list': {
      const types = listAgentTypes();
      if (types.length === 0) {
        out.log('No agent types found.');
        out.log(`  Run ${out.dim('claude-tempo agent-types init')} to install shipped examples.`);
        return;
      }
      out.heading('Available agent types');
      for (const t of types) {
        const src = t.source === 'shipped' ? out.dim('(shipped)') : t.source === 'user' ? out.dim('(user)') : out.dim('(project)');
        out.log(`  ${out.bold(t.name)} ${src}`);
        if (t.description) out.log(`    ${t.description}`);
      }
      console.log();
      break;
    }
    case 'show': {
      if (!opts.name) {
        out.error('Usage: claude-tempo agent-types show <name>');
        process.exit(1);
      }
      const info = resolveAgentType(opts.name);
      if (!info) {
        out.error(`No agent type found named "${opts.name}"`);
        out.log(`  Run ${out.dim('claude-tempo agent-types list')} to see available types.`);
        process.exit(1);
      }
      out.log(`${out.bold(info.name)} ${out.dim(`(${info.source}: ${info.path})`)}\n`);
      console.log(readFileSync(info.path, 'utf8'));
      break;
    }
    case 'init': {
      const shippedDir = join(PACKAGE_ROOT, 'examples', 'agents');
      const targetDir = join(homedir(), '.claude', 'agents');
      mkdirSync(targetDir, { recursive: true });

      if (!existsSync(shippedDir)) {
        out.error(`Shipped examples not found at ${shippedDir}`);
        process.exit(1);
      }

      const files = readdirSync(shippedDir).filter(f => f.endsWith('.md'));
      let copied = 0;
      let skipped = 0;
      for (const file of files) {
        const target = join(targetDir, file);
        if (existsSync(target)) {
          out.log(`  ${out.dim('skip')} ${file} (already exists)`);
          skipped++;
        } else {
          copyFileSync(join(shippedDir, file), target);
          out.success(`${file} → ${target}`);
          copied++;
        }
      }
      console.log();
      out.log(`Copied ${copied} agent definitions to ${targetDir}${skipped ? ` (${skipped} skipped)` : ''}`);
      break;
    }
    default:
      out.error('Usage: claude-tempo agent-types <list|show|init> [name]');
      out.log(`\n  ${out.dim('claude-tempo agent-types list')}          List available agent types`);
      out.log(`  ${out.dim('claude-tempo agent-types show <name>')}   Display an agent definition`);
      out.log(`  ${out.dim('claude-tempo agent-types init')}          Copy shipped examples to ~/.claude/agents/`);
      process.exit(1);
  }
}

// --- Ensemble blueprint commands ---

interface EnsembleCommandOpts extends CliOverrides {
  subcommand?: string;
  name?: string;
}

export async function ensembleCommand(opts: EnsembleCommandOpts) {
  switch (opts.subcommand) {
    case 'save': {
      const config = getConfig(opts);
      const connection = await createTemporalConnection(config);
      const client = new Client({ connection, namespace: config.temporalNamespace });
      const ensemble = opts.name || config.ensemble;
      try {
        const path = await saveBlueprint(client, ensemble);
        out.success(`Saved ensemble "${ensemble}" to ${path}`);
      } finally {
        await connection.close();
      }
      break;
    }
    case 'list': {
      const blueprints = listBlueprints();
      if (blueprints.length === 0) {
        out.log('No saved ensembles. Use `claude-tempo ensemble save [name]` to save one.');
        return;
      }
      out.heading('Saved ensembles');
      for (const bp of blueprints) {
        out.log(`  ${out.bold(bp.name)}  ${out.dim(bp.path)}`);
      }
      console.log();
      break;
    }
    case 'show': {
      if (!opts.name) {
        out.error('Usage: claude-tempo ensemble show <name>');
        process.exit(1);
      }
      const content = readSavedBlueprint(opts.name);
      if (!content) {
        out.error(`No saved ensemble named "${opts.name}"`);
        out.log(`  Run ${out.dim('claude-tempo ensemble list')} to see available ensembles.`);
        process.exit(1);
      }
      console.log(content);
      break;
    }
    default:
      out.error('Usage: claude-tempo ensemble <save|list|show> [name]');
      out.log(`\n  ${out.dim('claude-tempo ensemble save [name]')}   Save current ensemble state`);
      out.log(`  ${out.dim('claude-tempo ensemble list')}          List saved ensembles`);
      out.log(`  ${out.dim('claude-tempo ensemble show <name>')}   Display a saved blueprint`);
      process.exit(1);
  }
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
  ${out.cyan('conduct')} [ensemble]    Start a conductor session (resumes existing, --replace to restart)
  ${out.cyan('start')}   [ensemble]    Start a player session
  ${out.cyan('stop')}    [ensemble]    Stop sessions (-n <name> for one, or --all)
  ${out.cyan('status')}  [ensemble]    Show active sessions and Temporal health
  ${out.cyan('ensemble')} <sub>       Manage saved ensemble blueprints (save/list/show)
  ${out.cyan('agent-types')} <sub>    Manage player type definitions (list/show/init)
  ${out.cyan('config')}                Configure Temporal connection settings
  ${out.cyan('init')}                  Register MCP server globally (or --project for .mcp.json)
  ${out.cyan('preflight')}             Run preflight checks only
  ${out.cyan('help')}                  Show this help message

${out.bold('Connection options (all commands):')}
  --temporal-address <addr>    Temporal server address (default: localhost:7233)
  --temporal-namespace <ns>    Temporal namespace (default: default)
  --temporal-api-key <key>     Temporal API key (for Temporal Cloud)
  --temporal-tls-cert <path>   Path to TLS client certificate
  --temporal-tls-key <path>    Path to TLS client key

${out.bold('Other options:')}
  -n, --name <name>           Set the session window name (start/conduct/up only)
  --agent <claude|copilot>    Agent type to spawn (default: from config; start/conduct)
  --skip-preflight            Skip preflight checks (start/conduct only)
  --background                Run Temporal in background (server only)
  --project                   Use per-project .mcp.json instead of global (init only)
  --keep-mcp                  Don't remove MCP config (down only)
  --all                       Stop all sessions (stop only)
  --blueprint <name|file>      Load ensemble blueprint by name or file path (up only)
  --ensemble <name>           Target a specific ensemble (stop only)
  -d, --dir <path>            Target directory (default: cwd)

${out.bold('Config command:')}
  ${out.dim('claude-tempo config')}              Interactive connection setup
  ${out.dim('claude-tempo config show')}         Show resolved config
  ${out.dim('claude-tempo config set <k> <v>')}  Set a config value

  Settings are saved to ~/.claude-tempo/config.json.
  Also reads ~/.config/temporalio/temporal.yaml as a fallback.

  ${out.bold('Resolution order:')} CLI flag > env var > config file > temporal CLI config > default

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
  TEMPORAL_NAMESPACE          Default Temporal namespace (fallback: "default")
  TEMPORAL_API_KEY            Temporal API key
  TEMPORAL_TLS_CERT_PATH      Path to TLS client certificate
  TEMPORAL_TLS_KEY_PATH       Path to TLS client key
  CLAUDE_TEMPO_DEFAULT_AGENT  Default agent type: claude or copilot (fallback: claude)
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
