import { existsSync, readFileSync, writeFileSync, mkdirSync, readdirSync, unlinkSync, copyFileSync } from 'fs';
import { join, resolve } from 'path';
import { execFileSync, spawn as cpSpawn } from 'child_process';
import { homedir } from 'os';
import { Client, Connection, WorkflowIdConflictPolicy } from '@temporalio/client';
import { spawnInTerminal, spawnCopilotBridge, resolveClaudePath } from '../spawn';
import { conductorWorkflowId, schedulerWorkflowId, maestroWorkflowId, ENV, getConfig, Config, CliOverrides, CLAUDE_TEMPO_HOME } from '../config';
import { createTemporalConnection } from '../connection';
import { playerReportSignal, updateMetadataSignal } from '../workflows/signals';
import { addScheduleSignal } from '../workflows/scheduler-signals';
import { AgentType, ScheduleEntry, SessionMetadata } from '../types';
import { runPreflight } from './preflight';
import { isGlobalMcpRegistered, addGlobalMcp, removeGlobalMcp, isMcpConfigured } from './mcp';
import { loadLineup } from '../ensemble/loader';
import { saveLineup, listLineups, readSavedLineup } from '../ensemble/saver';
import { listAgentTypes, resolveAgentType } from '../ensemble/agent-types';
import { ENCORE_DEFAULT_CONTEXT_MESSAGES, PREVIEW_MAX_LENGTH, shouldIncludeInBroadcast, validateEnsembleName } from '../utils/validation';
import { isDaemonRunning, startDaemon, stopDaemon, getDaemonStatus, DAEMON_LOG_PATH } from './daemon';
import * as out from './output';

/** Package root is two levels up from dist/cli/ */
const PACKAGE_ROOT = resolve(__dirname, '..', '..');

function formatDurationMs(ms: number): string {
  if (ms >= 86_400_000) return `${ms / 86_400_000}d`;
  if (ms >= 3_600_000) return `${ms / 3_600_000}h`;
  if (ms >= 60_000) return `${ms / 60_000}m`;
  return `${ms / 1000}s`;
}

/**
 * Ensure the Maestro workflow is running for the given ensemble.
 * Idempotent — uses USE_EXISTING conflict policy.
 */
async function ensureMaestroWorkflow(client: Client, config: Config, ensemble: string): Promise<void> {
  const wfId = maestroWorkflowId(ensemble);
  try {
    await client.workflow.start('claudeMaestroWorkflow', {
      workflowId: wfId,
      taskQueue: config.taskQueue,
      args: [{ ensemble }],
      workflowIdConflictPolicy: WorkflowIdConflictPolicy.USE_EXISTING,
      searchAttributes: {
        ClaudeTempoEnsemble: [ensemble],
      },
    });
  } catch {
    // Maestro is non-critical — log but don't fail
  }
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

  // Start Maestro workflow when launching a conductor
  if (opts.conductor) {
    try {
      const connection = await createTemporalConnection(config);
      const client = new Client({ connection, namespace: config.temporalNamespace });
      await ensureMaestroWorkflow(client, config, opts.ensemble);
      await connection.close();
    } catch {
      // Maestro is non-critical
    }
  }

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
        : s.status === 'blocked' ? out.yellow(' (blocked)')
        : '';
      // Show PID info for copilot bridge sessions
      const pidInfo = s.agentType === 'copilot' ? getBridgePidInfo(s.name) : '';
      const name = out.bold(s.name);
      out.log(`  ${name}${role}${statusLabel}${agent}${pidInfo}`);
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
  lineup?: string;
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

  // Step 3.7: Start worker daemon if not already running
  if (isDaemonRunning()) {
    const daemonStatus = getDaemonStatus();
    out.check('Worker daemon running', true, `pid ${daemonStatus.pid}`);
  } else {
    out.log(`  ${out.dim('...')} Starting worker daemon...`);
    try {
      const daemonPid = await startDaemon(config);
      out.check('Worker daemon started', true, `pid ${daemonPid}`);
    } catch (err: any) {
      out.error(`Failed to start worker daemon: ${err.message || err}`);
      out.log(`  ${out.dim('You can start it manually: claude-tempo daemon start')}`);
      process.exit(1);
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

  // Load lineup if --lineup is provided
  let lineup;
  const lineupArg = opts.lineup;
  if (lineupArg) {
    // Resolve by name or file path
    let lineupPath: string;
    if (existsSync(resolve(lineupArg))) {
      // Direct file path
      lineupPath = resolve(lineupArg);
    } else {
      // Try saved lineups (~/.claude-tempo/ensembles/)
      const ensemblesDir = join(CLAUDE_TEMPO_HOME, 'ensembles');
      const savedYaml = join(ensemblesDir, `${lineupArg}.yaml`);
      const savedYml = join(ensemblesDir, `${lineupArg}.yml`);
      if (existsSync(savedYaml)) {
        lineupPath = savedYaml;
      } else if (existsSync(savedYml)) {
        lineupPath = savedYml;
      } else {
        // Try shipped examples
        const shippedPath = join(PACKAGE_ROOT, 'examples', 'ensembles', `${lineupArg}.yaml`);
        const shippedYml = join(PACKAGE_ROOT, 'examples', 'ensembles', `${lineupArg}.yml`);
        if (existsSync(shippedPath)) {
          lineupPath = shippedPath;
        } else if (existsSync(shippedYml)) {
          lineupPath = shippedYml;
        } else {
          out.error(`Lineup "${lineupArg}" not found as file, saved lineup, or shipped example`);
          const saved = listLineups();
          if (saved.length) out.log(`  Saved: ${saved.map(b => b.name).join(', ')}`);
          const shipped = readdirSync(join(PACKAGE_ROOT, 'examples', 'ensembles')).filter(f => f.endsWith('.yaml') || f.endsWith('.yml')).map(f => f.replace(/\.ya?ml$/, ''));
          if (shipped.length) out.log(`  Shipped: ${shipped.join(', ')}`);
          process.exit(1);
        }
      }
    }
    lineup = loadLineup(lineupPath);
  }
  if (lineup) {
    out.check('Lineup loaded', true, lineup.name);
  }

  // Resolve conductor agent from lineup or CLI flags
  const conductorAgent: AgentType = lineup?.conductor?.agent === 'copilot' ? 'copilot' : opts.agent;

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
    const sessionName = opts.name || lineup?.conductor?.name || 'conductor';

    // Resolve conductor agent type from lineup
    const conductorType = lineup?.conductor?.agent && lineup.conductor.agent !== 'default' && lineup.conductor.agent !== 'copilot'
      ? lineup.conductor.agent  // custom agent path
      : undefined;
    // Also check if the lineup has a type field
    const conductorTypeName = lineup?.conductor?.type;
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

  // Step 6: If lineup provided, recruit players and create schedules
  if (lineup) {
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
      } catch { /* Conductor workflow not yet registered — keep polling */ }
    }

    if (!conductorReady) {
      out.warn('Conductor did not register within 15s — skipping lineup players/schedules');
    } else {
      out.check('Conductor registered', true);

      // Ensure Maestro workflow is running
      await ensureMaestroWorkflow(client, config, opts.ensemble);

      // Send conductor instructions if provided
      if (lineup.conductor?.instructions) {
        try {
          const handle = client.workflow.getHandle(conductorWfId);
          await handle.signal('receiveMessage', {
            from: 'lineup',
            text: lineup.conductor.instructions,
          });
          out.check('Conductor instructions sent', true);
        } catch (err) {
          out.warn(`Could not send conductor instructions: ${err}`);
        }
      }

      // Recruit players sequentially (each polls for ~15s)
      if (lineup.players.length > 0) {
        console.log();
        out.log(`Recruiting ${lineup.players.length} player${lineup.players.length !== 1 ? 's' : ''} from lineup...`);

        for (const player of lineup.players) {
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
            // Resolve player type from lineup
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
                from: 'lineup',
                text: player.instructions,
              });
            } catch { /* Instruction delivery is best-effort — player may not be ready yet */ }
          }

          const status = newWorkflowId ? out.green('ok') : out.yellow('slow');
          out.log(`  ${status} ${out.bold(player.name)} in ${playerWorkDir}`);
        }
      }

      // Create schedules
      if (lineup.schedules && lineup.schedules.length > 0) {
        console.log();
        out.log(`Creating ${lineup.schedules.length} schedule${lineup.schedules.length !== 1 ? 's' : ''}...`);

        for (const sched of lineup.schedules) {
          try {
            const entry = lineupScheduleToEntry(sched);
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
  if (!lineup) {
    out.log(`\n  ${out.bold('What next?')}`);
    out.log(`  ${out.dim('claude-tempo start ' + opts.ensemble)}    Add a player session`);
    out.log(`  ${out.dim('claude-tempo status ' + opts.ensemble)}   See who\'s active`);
    out.log(`  Or ask the conductor to ${out.dim('recruit')} players for you`);
  } else {
    out.log(`  Lineup: ${out.dim(lineup.name)}`);
    out.log(`  Players: ${lineup.players.length}`);
    if (lineup.schedules?.length) out.log(`  Schedules: ${lineup.schedules.length}`);
    out.log(`\n  ${out.dim('claude-tempo status ' + opts.ensemble)}   See who\'s active`);
  }
  console.log();
}

/** Convert a lineup schedule definition to a ScheduleEntry for the scheduler workflow. */
function lineupScheduleToEntry(sched: NonNullable<import('../ensemble/schema').EnsembleLineup['schedules']>[number]): ScheduleEntry {
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
    createdBy: 'lineup',
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
  ensemble: string;
  all: boolean;
  removeMcp: boolean;
  dir: string;
}

export async function down(opts: DownOpts) {
  const config = getConfig(opts);
  const ensembleName = opts.ensemble;

  // Validate ensemble name before interpolating into query strings
  const nameErr = validateEnsembleName(ensembleName);
  if (nameErr) { out.error(nameErr); process.exit(1); }

  out.heading('claude-tempo teardown');
  out.log(`  Ensemble: ${out.bold(ensembleName)}${opts.all ? ' (--all: will also stop Temporal server)' : ''}`);

  // Step 1: Terminate workflows for the target ensemble
  const temporalUp = await isTemporalReachable(config);
  let hasRemainingWorkflows = false;
  if (temporalUp) {
    try {
      const connection = await createTemporalConnection(config);
      const client = new Client({ connection, namespace: config.temporalNamespace });

      // Terminate session workflows scoped to this ensemble
      const sessionQuery = `WorkflowType = "claudeSessionWorkflow" AND ExecutionStatus = "Running" AND ClaudeTempoEnsemble = "${ensembleName}"`;
      let terminated = 0;
      for await (const wf of client.workflow.list({ query: sessionQuery })) {
        try {
          const handle = client.workflow.getHandle(wf.workflowId);
          await handle.terminate('claude-tempo down');
          terminated++;
        } catch { /* already closed */ }
      }

      // Also terminate the ensemble's scheduler workflow
      try {
        const schedulerHandle = client.workflow.getHandle(schedulerWorkflowId(ensembleName));
        await schedulerHandle.terminate('claude-tempo down');
        terminated++;
      } catch { /* no scheduler or already closed */ }

      // Check if other workflows still running (to decide whether to kill Temporal)
      const allRunningQuery = 'ExecutionStatus = "Running"';
      for await (const _ of client.workflow.list({ query: allRunningQuery })) {
        hasRemainingWorkflows = true;
        break;
      }

      await connection.close();
      if (terminated > 0) {
        out.success(`Terminated ${terminated} workflow${terminated !== 1 ? 's' : ''} in ensemble "${ensembleName}"`);
      } else {
        out.warn(`No active workflows found for ensemble "${ensembleName}"`);
      }
    } catch {
      out.warn('Could not terminate active sessions');
    }
  }

  // Step 2: Kill bridge processes via PID files
  killBridgeProcesses();

  // Step 2.5: Stop worker daemon — only if --all or no other workflows remain
  if (opts.all || !hasRemainingWorkflows) {
    if (stopDaemon()) {
      out.success('Worker daemon stopped');
    }
  } else if (isDaemonRunning()) {
    out.log(`  ${out.dim('Worker daemon left running (other ensembles still active)')}`);
  }

  // Step 3: Stop Temporal server — only if --all flag or no other workflows remain
  if (temporalUp && (opts.all || !hasRemainingWorkflows)) {
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
  } else if (temporalUp) {
    out.log(`  ${out.dim('Temporal server left running (other ensembles still active)')}`);
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
 * Read PID info for a copilot bridge session from its PID file.
 * Returns a formatted string like " (pid 12345)" or "" if no PID file found.
 */
function getBridgePidInfo(name: string): string {
  const pidPath = join(process.cwd(), 'logs', `${name}.pid`);
  if (!existsSync(pidPath)) return '';
  try {
    const pid = parseInt(readFileSync(pidPath, 'utf8').trim(), 10);
    if (isNaN(pid)) return '';
    // Check if process is still alive
    try {
      process.kill(pid, 0); // signal 0 = existence check, doesn't kill
      return out.dim(` (pid ${pid})`);
    } catch {
      return out.dim(` (pid ${pid}, dead)`);
    }
  } catch {
    return '';
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

// --- Broadcast command ---

interface BroadcastOpts extends CliOverrides {
  ensemble?: string;
  message: string;
  type?: string;
  includeStale?: boolean;
}

export async function broadcast(opts: BroadcastOpts) {
  const config = getConfig(opts);

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
  const ensemble = opts.ensemble || config.ensemble;

  const query = `WorkflowType = "claudeSessionWorkflow" AND ExecutionStatus = "Running"`;
  const targets: Array<{ playerId: string; workflowId: string }> = [];

  for await (const wf of client.workflow.list({ query })) {
    try {
      const handle = client.workflow.getHandle(wf.workflowId);
      const metadata: SessionMetadata = await handle.query('getMetadata');

      if (metadata.ensemble !== ensemble) continue;

      // Filter by status
      if (!shouldIncludeInBroadcast(metadata.status, !!opts.includeStale)) continue;

      // Filter by player type if specified
      if (opts.type && metadata.playerType !== opts.type) continue;

      targets.push({ playerId: metadata.playerId, workflowId: wf.workflowId });
    } catch {
      // Workflow may have just completed — skip it
    }
  }

  if (targets.length === 0) {
    out.warn('No active players matched the broadcast filter.');
    await connection.close();
    return;
  }

  // Signal each target directly (CLI bypasses outbox)
  let sent = 0;
  for (const target of targets) {
    try {
      const handle = client.workflow.getHandle(target.workflowId);
      await handle.signal('receiveMessage', {
        from: 'cli',
        text: opts.message,
      });
      sent++;
      out.log(`  ${out.green('✓')} ${target.playerId}`);
    } catch (err) {
      out.warn(`  ${target.playerId}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  out.success(`Broadcast sent to ${sent}/${targets.length} player${targets.length === 1 ? '' : 's'}`);
  await connection.close();
}

// --- Encore command ---

interface EncoreOpts extends CliOverrides {
  name: string;
  ensemble?: string;
  host?: string;
}

export async function encore(opts: EncoreOpts) {
  if (opts.host) {
    out.error('Cross-machine encore is not supported via the CLI. Use the MCP `encore` tool with --host instead (it routes through the outbox and per-host task queues).');
    process.exit(1);
    return;
  }

  const config = getConfig(opts);
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
  const ensemble = opts.ensemble || config.ensemble;

  // Resolve the target session
  const query = `WorkflowType = "claudeSessionWorkflow" AND ExecutionStatus = "Running"`;
  let targetHandle: import('@temporalio/client').WorkflowHandle | null = null;
  let targetMeta: SessionMetadata | null = null;

  for await (const wf of client.workflow.list({ query })) {
    try {
      const handle = client.workflow.getHandle(wf.workflowId);
      const metadata: SessionMetadata = await handle.query('getMetadata');
      if (metadata.ensemble === ensemble && metadata.playerId === opts.name) {
        targetHandle = handle;
        targetMeta = metadata;
        break;
      }
    } catch {
      // skip
    }
  }

  if (!targetHandle || !targetMeta) {
    out.error(`No session found with name "${opts.name}" in ensemble "${ensemble}".`);
    await connection.close();
    process.exit(1);
    return;
  }

  const status = targetMeta.status || 'active';
  if (status !== 'stale') {
    out.error(`Session "${opts.name}" is ${status}, not stale. Encore only works on stale sessions.`);
    await connection.close();
    process.exit(1);
    return;
  }

  // Query context
  const part = await targetHandle.query('getPart') as string;
  const allMessages = await targetHandle.query('allMessages') as Array<{ from: string; text: string; timestamp: string }>;
  const recentMessages = allMessages.slice(-ENCORE_DEFAULT_CONTEXT_MESSAGES);

  const msgSummary = recentMessages.length > 0
    ? recentMessages.map(m => `[${m.from}] ${m.text.slice(0, PREVIEW_MAX_LENGTH)}`).join('\n')
    : '(no recent messages)';

  const contextMessage = [
    `🎵 **Encore** — you've been revived via CLI.`,
    part ? `Your last status: ${part}` : '',
    `Recent messages (last ${recentMessages.length}):`,
    msgSummary,
    '',
    'Resume where you left off. Use `ensemble` to see who is active.',
  ].filter(Boolean).join('\n');

  // Reset status and inject context message
  await targetHandle.signal('updateMetadata', { status: 'pending' });
  await targetHandle.signal('receiveMessage', { from: 'system', text: contextMessage });

  out.log(`Reviving "${opts.name}" in ${targetMeta.workDir}...`);

  // Resolve agent flags
  let agentFlags: string[] = [];
  if (targetMeta.playerType) {
    try {
      const info = resolveAgentType(targetMeta.playerType);
      if (info?.nativeResolvable) {
        agentFlags = ['--agent', targetMeta.playerType];
      } else if (info?.path) {
        agentFlags = ['--system-prompt', info.path];
      }
    } catch {
      // non-fatal
    }
  }

  const spawnArgs = [
    '--dangerously-skip-permissions',
    '--dangerously-load-development-channels', 'server:claude-tempo',
    '--resume', opts.name,
    ...agentFlags,
  ];
  const envVars: Record<string, string> = {
    [ENV.ENSEMBLE]: ensemble,
    [ENV.CONDUCTOR]: targetMeta.isConductor ? 'true' : '',
    [ENV.PLAYER_NAME]: opts.name,
    [ENV.TEMPORAL_ADDRESS]: config.temporalAddress,
    [ENV.TEMPORAL_NAMESPACE]: config.temporalNamespace,
  };
  if (targetMeta.playerType) envVars[ENV.PLAYER_TYPE] = targetMeta.playerType;
  if (config.temporalApiKey) envVars[ENV.TEMPORAL_API_KEY] = config.temporalApiKey;
  if (config.temporalTlsCertPath) envVars[ENV.TEMPORAL_TLS_CERT_PATH] = config.temporalTlsCertPath;
  if (config.temporalTlsKeyPath) envVars[ENV.TEMPORAL_TLS_KEY_PATH] = config.temporalTlsKeyPath;

  const { pid } = spawnInTerminal(spawnArgs, targetMeta.workDir, envVars);
  out.success(`Encore! "${opts.name}" revived (pid ${pid})`);

  await connection.close();
}

// --- Ensemble lineup commands ---

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
        const path = await saveLineup(client, ensemble);
        out.success(`Saved ensemble "${ensemble}" to ${path}`);
      } finally {
        await connection.close();
      }
      break;
    }
    case 'list': {
      const lineups = listLineups();
      if (lineups.length === 0) {
        out.log('No saved ensembles. Use `claude-tempo ensemble save [name]` to save one.');
        return;
      }
      out.heading('Saved ensembles');
      for (const bp of lineups) {
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
      const content = readSavedLineup(opts.name);
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
      out.log(`  ${out.dim('claude-tempo ensemble show <name>')}   Display a saved lineup`);
      process.exit(1);
  }
}

// --- Daemon command ---

interface DaemonOpts extends CliOverrides {
  subcommand?: string;
}

export async function daemon(opts: DaemonOpts) {
  const config = getConfig(opts);

  switch (opts.subcommand) {
    case 'start': {
      if (isDaemonRunning()) {
        const status = getDaemonStatus();
        out.success(`Daemon already running (pid ${status.pid})`);
        return;
      }
      out.log('Starting daemon...');
      try {
        const pid = await startDaemon(config);
        out.success(`Daemon started (pid ${pid})`);
        out.log(`  ${out.dim('Logs: ' + DAEMON_LOG_PATH)}`);
      } catch (err: any) {
        out.error(err.message || String(err));
        process.exit(1);
      }
      break;
    }

    case 'stop': {
      if (stopDaemon()) {
        out.success('Daemon stopped');
      } else {
        out.warn('Daemon is not running');
      }
      break;
    }

    case 'status': {
      const status = getDaemonStatus();
      if (status.running) {
        out.success(`Daemon running (pid ${status.pid})`);
      } else {
        out.log('Daemon is not running');
      }
      break;
    }

    case 'logs': {
      if (!existsSync(DAEMON_LOG_PATH)) {
        out.warn('No daemon log file found');
        return;
      }
      // Tail the log file
      if (process.platform === 'win32') {
        // On Windows, read the last 50 lines
        const content = readFileSync(DAEMON_LOG_PATH, 'utf8');
        const lines = content.split('\n');
        const tail = lines.slice(-50).join('\n');
        console.log(tail);
      } else {
        // On Unix, use tail -f for live following
        const child = cpSpawn('tail', ['-f', '-n', '50', DAEMON_LOG_PATH], {
          stdio: 'inherit',
        });
        child.on('error', () => {
          // Fallback: just read the file
          const content = readFileSync(DAEMON_LOG_PATH, 'utf8');
          const lines = content.split('\n');
          console.log(lines.slice(-50).join('\n'));
        });
        // Keep running until user presses Ctrl+C
        await new Promise<void>((resolve) => {
          child.on('exit', () => resolve());
          process.on('SIGINT', () => { child.kill(); resolve(); });
        });
      }
      break;
    }

    default:
      out.error('Usage: claude-tempo daemon <start|stop|status|logs>');
      out.log(`\n  ${out.dim('claude-tempo daemon start')}    Start the worker daemon`);
      out.log(`  ${out.dim('claude-tempo daemon stop')}     Stop the worker daemon`);
      out.log(`  ${out.dim('claude-tempo daemon status')}   Check daemon status`);
      out.log(`  ${out.dim('claude-tempo daemon logs')}     Tail daemon log output`);
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
  ${out.cyan('ensemble')} <sub>       Manage saved ensemble lineups (save/list/show)
  ${out.cyan('broadcast')} <message>   Send a message to all active players
  ${out.cyan('encore')}   <name>      Revive a stale player session (reconnect with context)
  ${out.cyan('agent-types')} <sub>    Manage player type definitions (list/show/init)
  ${out.cyan('daemon')}    <sub>       Manage the worker daemon (start/stop/status/logs)
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
  --lineup <name|file>         Load ensemble lineup by name or file path (up only)
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
