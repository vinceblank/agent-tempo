import * as readline from 'readline';
import { existsSync, readFileSync, writeFileSync, mkdirSync, readdirSync, unlinkSync, copyFileSync, statSync, openSync, readSync, closeSync } from 'fs';
import { basename, join, resolve } from 'path';
import { execFileSync, spawn as cpSpawn } from 'child_process';
import { homedir, hostname } from 'os';
import { randomUUID } from 'crypto';
import { Client, Connection, WorkflowIdConflictPolicy } from '@temporalio/client';
import { spawnInTerminal, spawnCopilotBridge, resolveClaudePath } from '../spawn';
import { conductorWorkflowId, sessionWorkflowId, schedulerWorkflowId, maestroWorkflowId, GLOBAL_MAESTRO_WORKFLOW_ID, ENV, getConfig, Config, CliOverrides, CLAUDE_TEMPO_HOME } from '../config';
import { getGitInfo } from '../git-info';
import { createTemporalConnection } from '../connection';
import { playerReportSignal, updateMetadataSignal, releaseHeldSignal, outboxLockedQuery, setPausedSignal, destroyUpdate } from '../workflows/signals';
import { addScheduleSignal, setSchedulerPausedSignal } from '../workflows/scheduler-signals';
import { maestroSetPausedSignal } from '../workflows/maestro-signals';
import { AgentType, ScheduleEntry, SessionInput, SessionMetadata } from '../types';
import { formatDurationMs } from '../utils/duration';
import { formatAttachmentInfoForDisplay } from '../utils/attachment-format';
import { runPreflight } from './preflight';
import { isGlobalMcpRegistered, addGlobalMcp, removeGlobalMcp, isMcpConfigured } from './mcp';
import { loadLineup, resolveLineupPath } from '../ensemble/loader';
import { saveLineup, listLineups, readSavedLineup } from '../ensemble/saver';
import { listAgentTypes, resolveAgentType } from '../ensemble/agent-types';
import { shouldIncludeInBroadcast, validateEnsembleName } from '../utils/validation';
import { getAttachmentPhase, getEnsembleName } from '../utils/search-attributes';
import { isDaemonRunning, startDaemon, stopDaemon, getDaemonStatus, DAEMON_LOG_PATH } from './daemon';
import { createTempoClient } from '../client';
import { ENSEMBLE_SENTINEL_FLAG, ensembleReadyBanner, ensembleReadyDirective } from '../constants';
import { buildTimeline, formatRecall } from '../utils/recall-format';
import * as out from './output';

/** Package root is two levels up from dist/cli/ */
const PACKAGE_ROOT = resolve(__dirname, '..', '..');

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

/**
 * Resolve a conductor's session name. MUST equal both the spawned process's
 * `ENV.PLAYER_NAME` and the workflow metadata's `playerId` — a mismatch
 * confuses `who_am_i`, reports, and operator-run `restart`/`detach` by name
 * (issue #172).
 */
function resolveConductorName(
  opts: { name?: string; agent: AgentType; ensemble: string },
  lineup?: import('../ensemble/schema').EnsembleLineup,
): string {
  if (lineup) {
    return opts.name
      || lineup.conductor?.name
      || (opts.agent === 'copilot' ? `${opts.ensemble}-conductor` : 'conductor');
  }
  // No lineup: preserve legacy `copilot-${Date.now()}` for ad-hoc copilot
  // conductors (changing that is out of scope for #172).
  return opts.name || (opts.agent === 'copilot' ? `copilot-${Date.now()}` : 'conductor');
}

/** Resolve a player's session name. Returns undefined for claude, where
 *  Claude Code auto-assigns on spawn. */
function resolvePlayerName(opts: { name?: string; agent: AgentType }): string | undefined {
  return opts.name || (opts.agent === 'copilot' ? `copilot-${Date.now()}` : undefined);
}

/**
 * Issue #172 (v0.26): pre-create the conductor workflow, optionally with
 * lineup-seeded `messages[]`. MUST run BEFORE the conductor process spawns
 * — otherwise `USE_EXISTING` silently drops the seeded input if the spawned
 * Claude Code MCP client registers the workflow first.
 *
 * Seeded messages (only when `lineup` is provided):
 *   1. lineup instructions (`from: 'lineup'`) — role/phase/convention brief
 *   2. banner + "wait for user, call `resume_ensemble` first" directive
 *      (`from: 'system'`), only on `initialStartup: true`
 *
 * When `lineup` is undefined (plain `up` / `conduct`), the workflow is still
 * pre-created with empty seeded messages — this matches the prior inline
 * behavior that held signals safely before the Claude Code MCP client
 * connected.
 */
async function seedConductorWorkflow(args: {
  client: Client;
  config: Config;
  ensemble: string;
  lineup?: import('../ensemble/schema').EnsembleLineup;
  initialStartup: boolean;
  conductorName: string;
  conductorAgent: AgentType;
}): Promise<void> {
  const { client, config, ensemble, lineup, initialStartup, conductorName } = args;
  const conductorWfId = conductorWorkflowId(ensemble);
  const { gitRoot: conductorGitRoot, gitBranch: conductorGitBranch } = getGitInfo(process.cwd());
  const conductorSessionId = randomUUID();
  const resolvedConductorType = lineup?.conductor?.type ? resolveAgentType(lineup.conductor.type) : null;

  // Issue #172 follow-up: seed the `from: 'system'` directive BEFORE the
  // lineup's role/phase brief. Earlier messages carry more weight with the
  // LLM — putting the "call resume_ensemble + release FIRST" framing ahead
  // of the lineup instructions reduces the chance the model skims past it
  // and broadcasts directly.
  const seededMessages: NonNullable<SessionInput['messages']> = [];
  if (initialStartup && lineup) {
    seededMessages.push({
      id: randomUUID(),
      from: 'system',
      text: ensembleReadyDirective(lineup.name, lineup.players.length),
      timestamp: new Date().toISOString(),
      delivered: false,
    });
  }
  if (lineup?.conductor?.instructions) {
    seededMessages.push({
      id: randomUUID(),
      from: 'lineup',
      text: lineup.conductor.instructions,
      timestamp: new Date().toISOString(),
      delivered: false,
    });
  }

  const conductorInput: SessionInput = {
    metadata: {
      playerId: conductorName,
      ensemble,
      hostname: hostname(),
      workDir: process.cwd(),
      gitRoot: conductorGitRoot,
      gitBranch: conductorGitBranch,
      isConductor: true,
      agentType: args.conductorAgent,
      sessionId: conductorSessionId,
      ...(resolvedConductorType ? { playerType: resolvedConductorType.name, playerTypeDescription: resolvedConductorType.description || '' } : {}),
    },
    autoSummary: `Conductor session`,
    disableStaleDetection: true,
    temporalConfig: {
      temporalAddress: config.temporalAddress,
      temporalNamespace: config.temporalNamespace,
      taskQueue: config.taskQueue,
    },
    ...(seededMessages.length > 0 ? { messages: seededMessages } : {}),
  };

  await client.workflow.start('claudeSessionWorkflow', {
    workflowId: conductorWfId,
    taskQueue: config.taskQueue,
    args: [conductorInput],
    workflowIdConflictPolicy: WorkflowIdConflictPolicy.USE_EXISTING,
    searchAttributes: {
      ...(conductorGitRoot ? { ClaudeTempoGitRoot: [conductorGitRoot] } : {}),
      ClaudeTempoHostname: [hostname()],
      ClaudeTempoEnsemble: [ensemble],
      ClaudeTempoPlayerId: [conductorName],
    },
  });
}

/**
 * Issue #172 (v0.26): pre-create player workflows (warm hold on initial
 * startup), spawn their processes, create scheduled entries, and pause the
 * whole ensemble. Called AFTER the conductor spawn so the conductor tab
 * opens first. Does NOT pre-create the conductor workflow — that must
 * already exist (via `seedConductorWorkflow`).
 */
async function applyLineupPlayersAndSchedules(args: {
  client: Client;
  config: Config;
  ensemble: string;
  lineup: import('../ensemble/schema').EnsembleLineup;
  initialStartup: boolean;
  conductorName: string;
  temporalEnvVars: Record<string, string>;
  conductorAgent: AgentType;
}): Promise<void> {
  const { client, config, ensemble, lineup, initialStartup, conductorName } = args;

  // Pre-create and spawn players.
  if (lineup.players.length > 0) {
    console.log();
    out.log(`Recruiting ${lineup.players.length} player${lineup.players.length !== 1 ? 's' : ''} from lineup...`);
  }
  for (const player of lineup.players) {
    const playerAgent: AgentType = player.agent === 'copilot' ? 'copilot' : (player.agent === 'claude' ? 'claude' : args.conductorAgent);
    const playerWorkDir = player.workDir || process.cwd();
    const resolvedPlayerType = player.type ? resolveAgentType(player.type) : null;
    const playerSessionId = randomUUID();
    const playerWfId = sessionWorkflowId(ensemble, player.name);
    const { gitRoot: playerGitRoot, gitBranch: playerGitBranch } = getGitInfo(playerWorkDir);
    const playerInput: SessionInput = {
      metadata: {
        playerId: player.name,
        ensemble,
        hostname: hostname(),
        workDir: playerWorkDir,
        gitRoot: playerGitRoot,
        gitBranch: playerGitBranch,
        isConductor: false,
        agentType: playerAgent,
        sessionId: playerSessionId,
        recruitedBy: conductorName,
        ...(resolvedPlayerType ? { playerType: resolvedPlayerType.name, playerTypeDescription: resolvedPlayerType.description || '' } : {}),
      },
      autoSummary: `Session in ${basename(resolve(playerWorkDir))}`,
      disableStaleDetection: true,
      temporalConfig: {
        temporalAddress: config.temporalAddress,
        temporalNamespace: config.temporalNamespace,
        taskQueue: config.taskQueue,
      },
      ...(initialStartup
        ? {
            outboxLocked: true,
            ...(player.instructions ? { heldMessage: player.instructions } : {}),
          }
        : (player.instructions ? {
            messages: [{
              id: randomUUID(),
              from: 'lineup',
              text: player.instructions,
              timestamp: new Date().toISOString(),
              delivered: false,
            }],
          } : {})),
    };
    try {
      await client.workflow.start('claudeSessionWorkflow', {
        workflowId: playerWfId,
        taskQueue: config.taskQueue,
        args: [playerInput],
        workflowIdConflictPolicy: WorkflowIdConflictPolicy.USE_EXISTING,
        searchAttributes: {
          ...(playerGitRoot ? { ClaudeTempoGitRoot: [playerGitRoot] } : {}),
          ClaudeTempoHostname: [hostname()],
          ClaudeTempoEnsemble: [ensemble],
          ClaudeTempoPlayerId: [player.name],
        },
      });
    } catch (err) {
      out.warn(`Could not pre-create workflow for "${player.name}": ${err}`);
      continue;
    }

    // Spawn the player process.
    try {
      if (playerAgent === 'copilot') {
        spawnCopilotBridge({
          name: player.name,
          ensemble,
          temporalAddress: config.temporalAddress,
          temporalNamespace: config.temporalNamespace,
          temporalApiKey: config.temporalApiKey,
          temporalTlsCertPath: config.temporalTlsCertPath,
          temporalTlsKeyPath: config.temporalTlsKeyPath,
          isConductor: false,
          workDir: playerWorkDir,
        });
      } else {
        const claudeArgs = [
          '--dangerously-skip-permissions',
          '--dangerously-load-development-channels', 'server:claude-tempo',
          // ENSEMBLE_SENTINEL_FLAG carries the ensemble name into the spawned
          // claude.exe's CommandLine so hard-terminate can scope `destroy --all`
          // kills by ensemble (#180, #259). Mirrors src/activities/outbox.ts.
          ENSEMBLE_SENTINEL_FLAG, ensemble,
          '-n', player.name,
          ...(resolvedPlayerType?.nativeResolvable ? ['--agent', resolvedPlayerType.name] :
              resolvedPlayerType ? ['--system-prompt', resolvedPlayerType.path] : []),
        ];
        const playerEnvVars: Record<string, string> = {
          ...args.temporalEnvVars,
          [ENV.ENSEMBLE]: ensemble,
          [ENV.CONDUCTOR]: '',
          [ENV.PLAYER_NAME]: player.name,
        };
        if (resolvedPlayerType) {
          playerEnvVars[ENV.PLAYER_TYPE] = resolvedPlayerType.name;
        }
        spawnInTerminal(claudeArgs, playerWorkDir, playerEnvVars, { claudeBin: config.claudeBin });
      }
      out.log(`  ${out.green('ok')} ${out.bold(player.name)} in ${playerWorkDir}`);
    } catch (err) {
      out.warn(`Could not spawn "${player.name}": ${err}`);
    }
  }

  // Create schedules (independent of hold state).
  if (lineup.schedules && lineup.schedules.length > 0) {
    console.log();
    out.log(`Creating ${lineup.schedules.length} schedule${lineup.schedules.length !== 1 ? 's' : ''}...`);
    for (const sched of lineup.schedules) {
      try {
        const entry = lineupScheduleToEntry(sched);
        const schedulerWfId = schedulerWorkflowId(ensemble);
        try {
          const handle = client.workflow.getHandle(schedulerWfId);
          await handle.describe();
          await handle.signal(addScheduleSignal, entry);
        } catch {
          await client.workflow.start('claudeSchedulerWorkflow', {
            workflowId: schedulerWfId,
            taskQueue: config.taskQueue,
            args: [{ ensemble, entries: [entry] }],
            workflowIdConflictPolicy: WorkflowIdConflictPolicy.USE_EXISTING,
            searchAttributes: {
              ClaudeTempoEnsemble: [ensemble],
            },
          });
        }
        out.check(sched.name, true, `→ ${sched.target}`);
      } catch (err) {
        out.warn(`Could not create schedule "${sched.name}": ${err}`);
      }
    }
  }

  // Issue #172 (v0.26): on initial-startup, pause the whole ensemble so the
  // scheduler, per-session outbox dispatch, and maestro all stay quiet while
  // we wait for the user's first message. The system directive baked into
  // the conductor's messages[] tells the LLM to call `resume_ensemble` before
  // taking any action once the user speaks.
  if (initialStartup) {
    await setPausedState(client, ensemble, true);
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
  /**
   * Issue #172: `conduct --lineup <name>` — load a lineup during conductor
   * startup and apply the same initial-startup semantics as `up --lineup`:
   * conductor instructions deferred, players held, banner shown. Only
   * meaningful when `conductor: true`.
   */
  lineup?: string;
  /**
   * Issue #172: opt out of the defer-conductor-instructions behavior.
   * Forces the legacy immediate-start path even on `conduct --lineup`.
   */
  noHold?: boolean;
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
            // PR-C commit 4: V2 `destroy` update — explicit operator termination.
            await handle.executeUpdate(destroyUpdate, { args: [{ reason: 'conductor replace via CLI' }] });
            // Wait briefly for graceful shutdown
            for (let i = 0; i < 10; i++) {
              await new Promise(r => setTimeout(r, 500));
              const check = await handle.describe();
              if (check.status.name !== 'RUNNING') break;
            }
          } catch {
            // Force cancel if destroy fails (workflow may be stuck/corrupt)
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

  // Issue #172: `conduct --lineup <name>` loads the lineup with the initial-
  // startup semantics. Resolved here so a bad name/path fails before we spawn
  // the process. Non-conductor `start` ignores `--lineup` (only `up` /
  // `conduct` create ensembles from scratch). `--resume` also ignores it:
  // reconnecting to an existing conductor must NOT re-seed messages (a no-op
  // under `USE_EXISTING`), re-recruit players, or re-pause the ensemble.
  let startLineup: ReturnType<typeof loadLineup> | undefined;
  if (opts.conductor && opts.lineup) {
    if (opts.resume) {
      out.warn('`--lineup` is ignored with `--resume` — reconnecting to existing conductor without re-applying lineup.');
    } else {
      try {
        const resolution = resolveLineupPath(opts.lineup);
        startLineup = loadLineup(resolution.path);
      } catch (err: any) {
        out.error(err.message);
        process.exit(1);
      }
    }
  } else if (!opts.conductor && opts.lineup) {
    // Plain `start --lineup` silently dropped the flag; surface a warning so
    // users notice the mistake.
    out.warn('`--lineup` is only meaningful with `conduct` or `up`, not `start` — ignored.');
  }
  const startInitialStartup = Boolean(startLineup) && !opts.noHold;

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
  if (config.claudeBin) temporalEnvVars[ENV.CLAUDE_BIN] = config.claudeBin;

  // Resolve the session name ONCE so the spawn env var and the workflow
  // metadata's `playerId` match. Conductor path requires a stable name;
  // player path may leave it undefined for claude auto-assignment.
  const sessionName = opts.conductor
    ? resolveConductorName(opts, startLineup)
    : resolvePlayerName(opts);

  // Pre-seed the conductor workflow BEFORE spawning the Claude Code / copilot
  // process. If the spawned process's MCP client wins the race and registers
  // the workflow first, `USE_EXISTING` silently drops our seeded messages.
  let conductorClient: Client | undefined;
  let conductorConnection: Connection | undefined;
  if (opts.conductor) {
    try {
      conductorConnection = await createTemporalConnection(config);
      conductorClient = new Client({ connection: conductorConnection, namespace: config.temporalNamespace });
      try {
        await ensureMaestroWorkflow(conductorClient, config, opts.ensemble);
      } catch (err) {
        if (process.env.DEBUG) {
          console.error('[claude-tempo:conduct] ensureMaestroWorkflow failed:', err);
        }
      }
      if (startLineup) {
        try {
          await seedConductorWorkflow({
            client: conductorClient,
            config,
            ensemble: opts.ensemble,
            lineup: startLineup,
            initialStartup: startInitialStartup,
            conductorName: sessionName as string,
            conductorAgent: opts.agent,
          });
        } catch (err) {
          out.warn(`Conductor workflow pre-seed failed: ${err instanceof Error ? err.message : String(err)}`);
        }
      }
    } catch (err) {
      // Couldn't even connect — let the spawn proceed; the conductor's MCP
      // client will surface a clearer error. Lineup seeding is lost though.
      if (startLineup) {
        out.warn(`Could not connect to Temporal to pre-seed lineup: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
  }

  if (opts.agent === 'copilot') {
    const { pid } = spawnCopilotBridge({
      name: sessionName as string,
      ensemble: opts.ensemble,
      temporalAddress: config.temporalAddress,
      temporalNamespace: config.temporalNamespace,
      temporalApiKey: config.temporalApiKey,
      temporalTlsCertPath: config.temporalTlsCertPath,
      temporalTlsKeyPath: config.temporalTlsKeyPath,
      isConductor: opts.conductor,
      workDir,
    });
    out.success(`Launched copilot bridge "${sessionName}" (pid ${pid ?? 'unknown'})`);
  } else {
    const claudeArgs = [
      '--dangerously-skip-permissions',
      '--dangerously-load-development-channels', 'server:claude-tempo',
      // ENSEMBLE_SENTINEL_FLAG carries the ensemble name into the spawned
      // claude.exe's CommandLine so hard-terminate can scope `destroy --all`
      // kills by ensemble (#180, #259). Mirrors src/activities/outbox.ts.
      ENSEMBLE_SENTINEL_FLAG, opts.ensemble,
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

    const { pid } = spawnInTerminal(claudeArgs, workDir, envVars, { claudeBin: config.claudeBin });
    out.success(`Launched ${role} session${sessionName ? ` "${sessionName}"` : ''} (pid ${pid ?? 'unknown'})`);
  }
  out.log(`  Ensemble: ${opts.ensemble}`);
  out.log(`  Directory: ${workDir}`);

  // Post-spawn: pre-create players, create schedules, pause ensemble.
  // The conductor tab is already open so the user sees it first.
  if (opts.conductor && startLineup && conductorClient) {
    try {
      await applyLineupPlayersAndSchedules({
        client: conductorClient,
        config,
        ensemble: opts.ensemble,
        lineup: startLineup,
        initialStartup: startInitialStartup,
        conductorName: sessionName!,
        temporalEnvVars,
        conductorAgent: opts.agent,
      });
    } catch (err) {
      out.warn(`Lineup player/schedule setup encountered errors: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
  if (conductorConnection) {
    try { await conductorConnection.close(); } catch { /* best effort */ }
  }

  out.log(`\nCheck status: ${out.dim('claude-tempo status ' + opts.ensemble)}`);
  if (startLineup && startInitialStartup) {
    console.log();
    out.log(`  ${ensembleReadyBanner(startLineup.name, startLineup.players.length)}`);
  }
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
    phase: string | undefined;
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

      // Attachment phase lives on the `ClaudeTempoAttachmentState` search attribute (post-#175).
      const phase = getAttachmentPhase(wf);

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
        phase,
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

    // Option-B phase → tag mapping (see #176 PR):
    //   booting → (pending); attached/processing/awaiting → no tag;
    //   draining/detached → (disconnected); gone → (gone).
    const phaseLabel = (phase: string | undefined): string => {
      if (phase === 'booting') return out.dim(' (pending)');
      if (phase === 'draining' || phase === 'detached') return out.yellow(' (disconnected)');
      if (phase === 'gone') return out.dim(' (gone)');
      return '';
    };

    for (const s of members) {
      const role = s.conductor ? out.yellow(' (conductor)') : '';
      const agent = s.agentType === 'copilot' ? out.dim(' [copilot]') : '';
      const statusLabel = phaseLabel(s.phase);
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
  if (isGlobalMcpRegistered() || isMcpConfigured(opts.dir)) {
    out.success('claude-tempo already registered');
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
    command: 'claude-tempo-server',
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
  { name: 'ClaudeTempoPlayerType', type: 'Keyword' },
  { name: 'ClaudeTempoIsConductor', type: 'Bool' },
  // v0.25 attachment lifecycle search attrs (design §9, §11.2).
  // Ops note: registration documented in docs/ops/v0.26-migration.md.
  // `ClaudeTempoStatus` was removed in v0.26 (#175 / #178); operators on
  // long-lived Temporal clusters must manually drop the attribute — Temporal
  // does not auto-unregister search attributes.
  { name: 'ClaudeTempoAttachedHost', type: 'Keyword' },
  { name: 'ClaudeTempoAttachmentState', type: 'Keyword' },
  { name: 'ClaudeTempoAttachmentId', type: 'Keyword' },
];

async function isTemporalReachable(config: { temporalAddress: string; temporalNamespace?: string; temporalApiKey?: string; temporalTlsCertPath?: string; temporalTlsKeyPath?: string }): Promise<boolean> {
  try {
    const conn = await createTemporalConnection(config as any);
    try {
      // Verify namespace is ready — a gRPC connection alone doesn't guarantee the server can serve requests
      const client = new Client({ connection: conn, namespace: config.temporalNamespace || 'default' });
      // eslint-disable-next-line @typescript-eslint/no-unused-vars
      for await (const _ of client.workflow.list({ query: 'WorkflowId = "__readiness_probe__"' })) {
        break;
      }
    } finally {
      await conn.close();
    }
    return true;
  } catch {
    return false;
  }
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
  /**
   * Issue #172: when true, skip the "defer conductor instructions + hold
   * players until user's first message" behavior and use the legacy
   * immediate-start semantics. Ignored when `--lineup` is not set.
   */
  noHold?: boolean;
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
    try {
      const resolution = resolveLineupPath(lineupArg);
      lineup = loadLineup(resolution.path);
    } catch (err: any) {
      out.error(err.message);
      process.exit(1);
    }
  }
  if (lineup) {
    out.check('Lineup loaded', true, lineup.name);
  }

  // Issue #172: initial-startup behavior is on by default when a lineup is
  // loaded. `--no-hold` opts out and preserves legacy immediate-start. No
  // lineup ⇒ the flag is a no-op (nothing to defer).
  const initialStartup = Boolean(lineup) && !opts.noHold;

  // Resolve conductor agent from lineup or CLI flags
  const conductorAgent: AgentType = lineup?.conductor?.agent === 'copilot' ? 'copilot' : opts.agent;

  // Step 5: Connect to Temporal and check for existing conductor
  console.log();

  const connection = await createTemporalConnection(config);
  const client = new Client({ connection, namespace: config.temporalNamespace });

  const conductorWfId = conductorWorkflowId(opts.ensemble);

  // Check if a conductor is already running
  try {
    const existingHandle = client.workflow.getHandle(conductorWfId);
    const desc = await existingHandle.describe();
    if (desc.status.name === 'RUNNING') {
      if (!process.stdin.isTTY) {
        out.error(`A conductor is already running for ensemble "${opts.ensemble}".`);
        out.log(`  Use ${out.dim('--resume')} to reconnect, or ${out.dim('claude-tempo start')} to join as a player.`);
        process.exit(1);
      }

      out.warn(`A conductor is already running for ensemble "${opts.ensemble}".`);
      console.log();
      out.log(`  1) Join as a new player session`);
      out.log(`  2) Reconnect to the existing conductor (--resume)`);
      out.log(`  3) Tear down and start fresh`);
      out.log(`  4) Cancel`);
      console.log();

      const choice = await new Promise<string>((res) => {
        const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
        rl.question(`  ${out.cyan('?')} Choose an option [1-4]: `, (answer) => {
          rl.close();
          res(answer.trim());
        });
      });

      switch (choice) {
        case '1':
          // Join as a player — delegate to start()
          console.log();
          out.log('Joining as a player session...');
          await start({
            ensemble: opts.ensemble,
            conductor: false,
            name: opts.name,
            skipPreflight: true, // infrastructure already verified above
            agent: opts.agent,
            dir: process.cwd(),
          });
          return;

        case '2':
          // Reconnect to existing conductor
          console.log();
          out.log('Reconnecting to existing conductor...');
          await start({
            ensemble: opts.ensemble,
            conductor: true,
            resume: true,
            name: opts.name,
            skipPreflight: true,
            agent: opts.agent,
            dir: process.cwd(),
          });
          return;

        case '3':
          // Terminate existing workflows, then fall through to normal up flow
          console.log();
          try { await client.workflow.getHandle(conductorWfId).terminate('up: fresh start'); } catch { /* may not exist */ }
          try { await client.workflow.getHandle(schedulerWorkflowId(opts.ensemble)).terminate('up: fresh start'); } catch { /* may not exist */ }
          try { await client.workflow.getHandle(maestroWorkflowId(opts.ensemble)).terminate('up: fresh start'); } catch { /* may not exist */ }
          out.success('Existing ensemble torn down');
          // Fall through to normal up flow below
          break;

        case '4':
        default:
          out.log('Cancelled.');
          process.exit(0);
      }
    }
  } catch {
    // No existing conductor — proceed normally
  }

  out.log(`Launching conductor in ensemble ${out.cyan(opts.ensemble)}${conductorAgent === 'copilot' ? out.dim(' (copilot)') : ''}...`);

  const sessionName = resolveConductorName({ ...opts, agent: conductorAgent }, lineup);

  // Legacy `lineup.conductor.agent` (string form, e.g. path to a system prompt)
  // is passed through to the spawn CLI below — not to the workflow metadata.
  const conductorType = lineup?.conductor?.agent && lineup.conductor.agent !== 'default' && lineup.conductor.agent !== 'copilot'
    ? lineup.conductor.agent
    : undefined;
  const conductorTypeName = lineup?.conductor?.type;
  const resolvedConductorType = conductorTypeName ? resolveAgentType(conductorTypeName) : null;

  await seedConductorWorkflow({
    client,
    config,
    ensemble: opts.ensemble,
    lineup,
    initialStartup,
    conductorName: sessionName,
    conductorAgent,
  });
  out.check('Conductor workflow pre-created', true);

  // Spawn the conductor process
  let pid: number | undefined;
  if (conductorAgent === 'copilot') {
    ({ pid } = spawnCopilotBridge({
      name: sessionName,
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
    const claudeArgs = [
      '--dangerously-skip-permissions',
      '--dangerously-load-development-channels', 'server:claude-tempo',
      // ENSEMBLE_SENTINEL_FLAG carries the ensemble name into the spawned
      // claude.exe's CommandLine so hard-terminate can scope `destroy --all`
      // kills by ensemble (#180, #259). Mirrors src/activities/outbox.ts.
      ENSEMBLE_SENTINEL_FLAG, opts.ensemble,
      '-n', sessionName,
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

    ({ pid } = spawnInTerminal(claudeArgs, process.cwd(), conductorEnvVars, { claudeBin: config.claudeBin }));
  }

  out.success(`Conductor launched (pid ${pid ?? 'unknown'})`);

  // Step 6: If lineup provided, recruit players, create schedules, and
  // pause the ensemble for initial-startup — same code path as
  // `conduct --lineup` via the shared helper.
  if (lineup) {
    await ensureMaestroWorkflow(client, config, opts.ensemble);
    if (lineup.conductor?.instructions) {
      out.check('Conductor instructions baked into workflow', true);
    }
    await applyLineupPlayersAndSchedules({
      client,
      config,
      ensemble: opts.ensemble,
      lineup,
      initialStartup,
      conductorName: sessionName,
      temporalEnvVars,
      conductorAgent,
    });
  }

  await connection.close();

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
  // Issue #172: print the canonical "ensemble ready" banner on stdout so the
  // user sees the same wording in their terminal, the conductor's tab, and
  // the TUI. On `--no-hold` the legacy wording is preserved implicitly since
  // nothing is deferred — we only surface the banner on initial-startup paths.
  if (lineup && initialStartup) {
    console.log();
    out.log(`  ${ensembleReadyBanner(lineup.name, lineup.players.length)}`);
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

/** Prompt the user for y/n confirmation. Exits with code 1 in non-TTY environments. */
async function confirmPrompt(message: string): Promise<boolean> {
  if (!process.stdin.isTTY) {
    out.error('Non-interactive environment: use --yes / -y to confirm teardown.');
    process.exit(1);
  }
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  return new Promise<boolean>((resolve) => {
    rl.question(`${message} [y/N] `, (answer) => {
      rl.close();
      resolve(answer.trim().toLowerCase() === 'y');
    });
  });
}

// --- Teardown: `down` command ---

interface DownOpts extends CliOverrides {
  /** Explicitly specified ensemble name. If undefined, auto-detect from running workflows. */
  ensemble?: string;
  all: boolean;
  removeMcp: boolean;
  keepDaemon: boolean;
  yes: boolean;
  dir: string;
}

export async function down(opts: DownOpts) {
  const config = getConfig(opts);
  let ensembleName = opts.ensemble;

  // Auto-detect ensemble if not explicitly specified
  if (!ensembleName && !opts.all) {
    const temporalUp = await isTemporalReachable(config);
    if (!temporalUp) {
      out.error('No ensembles running (Temporal is not reachable).');
      process.exit(1);
    }
    let connection: Connection | undefined;
    try {
      connection = await createTemporalConnection(config);
      const client = new Client({ connection, namespace: config.temporalNamespace });
      const runningEnsembles = new Set<string>();
      const query = 'WorkflowType = "claudeSessionWorkflow" AND ExecutionStatus = "Running"';
      for await (const wf of client.workflow.list({ query })) {
        const name = getEnsembleName(wf);
        if (name) runningEnsembles.add(name);
      }

      if (runningEnsembles.size === 0) {
        out.error('No ensembles running.');
        process.exit(1);
      } else if (runningEnsembles.size === 1) {
        ensembleName = [...runningEnsembles][0];
        // Auto-detected ensemble requires confirmation unless --yes
        if (!opts.yes) {
          out.heading('claude-tempo teardown');
          out.log(`  This will destroy ensemble ${out.bold(ensembleName)}: all sessions, daemon, and Temporal server.`);
          const confirmed = await confirmPrompt('Proceed?');
          if (!confirmed) {
            out.log('Aborted.');
            process.exit(0);
          }
        }
      } else {
        // Multiple ensembles: require confirmation or --yes for each
        if (!opts.yes) {
          out.heading('claude-tempo teardown');
          out.log(`  Multiple ensembles running:`);
          for (const name of [...runningEnsembles].sort()) {
            out.log(`    - ${name}`);
          }
          out.log('');
          out.log(`  This will destroy ${out.bold('all')} of them: sessions, daemon, and Temporal server.`);
          const confirmed = await confirmPrompt('Proceed?');
          if (!confirmed) {
            out.log('Aborted. To tear down a specific ensemble:');
            for (const name of [...runningEnsembles].sort()) {
              out.log(`  - claude-tempo down ${name}`);
            }
            process.exit(0);
          }
          // Treat as --all since user confirmed tearing down everything
          opts.all = true;
        } else {
          // --yes with multiple ensembles: treat as --all
          opts.all = true;
        }
      }
    } catch (err) {
      out.error(`Could not detect running ensembles: ${(err as Error).message}`);
      process.exit(1);
    } finally {
      await connection?.close();
    }
  }

  // When --all is set without a specific ensemble, we terminate everything
  if (!ensembleName && opts.all) {
    ensembleName = undefined;
  }

  // Validate ensemble name before interpolating into query strings
  if (ensembleName) {
    const nameErr = validateEnsembleName(ensembleName);
    if (nameErr) { out.error(nameErr); process.exit(1); }
  }

  out.heading('claude-tempo teardown');
  if (ensembleName) {
    out.log(`  Ensemble: ${out.bold(ensembleName)}${opts.all ? ' (--all: will also stop Temporal server)' : ''}`);
  } else {
    out.log(`  ${out.bold('Tearing down all ensembles')} (--all)`);
  }

  // Confirm destructive --all on unspecified-ensemble path. Non-all paths
  // already prompt earlier in the auto-detect block; this covers the
  // scorched-earth `claude-tempo down --all` invocation, which otherwise
  // ran silently.
  if (!ensembleName && opts.all && !opts.yes) {
    const confirmed = await confirmPrompt('Proceed?');
    if (!confirmed) {
      out.log('Aborted.');
      process.exit(0);
    }
  }

  // Step 1: Terminate workflows for the target ensemble (or all ensembles)
  const temporalUp = await isTemporalReachable(config);
  let hasRemainingWorkflows = false;
  if (temporalUp) {
    try {
      const connection = await createTemporalConnection(config);
      const client = new Client({ connection, namespace: config.temporalNamespace });

      // Terminate session workflows — scoped to ensemble if specified, otherwise all
      const sessionQuery = ensembleName
        ? `WorkflowType = "claudeSessionWorkflow" AND ExecutionStatus = "Running" AND ClaudeTempoEnsemble = "${ensembleName}"`
        : `WorkflowType = "claudeSessionWorkflow" AND ExecutionStatus = "Running"`;
      let terminated = 0;
      const discoveredEnsembles = new Set<string>();
      for await (const wf of client.workflow.list({ query: sessionQuery })) {
        // Track ensemble names for scheduler/maestro cleanup in --all mode
        if (!ensembleName) {
          const name = getEnsembleName(wf);
          if (name) discoveredEnsembles.add(name);
        }
        try {
          const handle = client.workflow.getHandle(wf.workflowId);
          await handle.terminate('claude-tempo down');
          terminated++;
        } catch { /* already closed */ }
      }

      // Terminate scheduler and maestro workflows for each ensemble
      const ensemblesToClean = ensembleName ? [ensembleName] : [...discoveredEnsembles];
      for (const name of ensemblesToClean) {
        // Scheduler
        try {
          const schedulerHandle = client.workflow.getHandle(schedulerWorkflowId(name));
          await schedulerHandle.terminate('claude-tempo down');
          terminated++;
        } catch { /* no scheduler or already closed */ }
        // Per-ensemble Maestro
        try {
          const maestroHandle = client.workflow.getHandle(maestroWorkflowId(name));
          await maestroHandle.terminate('claude-tempo down');
          terminated++;
        } catch { /* no maestro or already closed */ }
      }

      // Terminate global Maestro when tearing down all ensembles
      if (!ensembleName) {
        try {
          const globalMaestroHandle = client.workflow.getHandle(GLOBAL_MAESTRO_WORKFLOW_ID);
          await globalMaestroHandle.terminate('claude-tempo down');
          terminated++;
        } catch { /* no global maestro or already closed */ }
      }

      // Check if other workflows still running (to decide whether to kill Temporal)
      if (!opts.all) {
        const allRunningQuery = 'ExecutionStatus = "Running"';
        for await (const _ of client.workflow.list({ query: allRunningQuery })) {
          hasRemainingWorkflows = true;
          break;
        }
      }

      await connection.close();
      const scope = ensembleName ? `in ensemble "${ensembleName}"` : 'across all ensembles';
      if (terminated > 0) {
        out.success(`Terminated ${terminated} workflow${terminated !== 1 ? 's' : ''} ${scope}`);
      } else {
        out.warn(`No active workflows found ${scope}`);
      }
    } catch {
      out.warn('Could not terminate active sessions');
    }
  }

  // Step 2: Kill bridge processes via PID files
  killBridgeProcesses();

  // Step 2.5: Stop worker daemon — unless --keep-daemon or other ensembles still active
  if (opts.keepDaemon) {
    if (isDaemonRunning()) {
      out.log(`  ${out.dim('Worker daemon left running (--keep-daemon)')}`);
    }
  } else if (opts.all || !hasRemainingWorkflows) {
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

  // Step 4: Check for npx usage, then remove MCP config
  // npx check must happen BEFORE removal since step 4 deletes the entry
  let hasNpxWarning = false;
  const projectMcpPath = join(opts.dir, '.mcp.json');
  if (existsSync(projectMcpPath)) {
    try {
      const mcpContent = JSON.parse(readFileSync(projectMcpPath, 'utf8'));
      const tempoEntry = mcpContent?.mcpServers?.['claude-tempo'];
      if (tempoEntry) {
        const cmd = tempoEntry.command ?? '';
        const entryArgs: string[] = tempoEntry.args ?? [];
        if (cmd === 'npx' || entryArgs.some((a: string) => a === 'npx')) {
          hasNpxWarning = true;
        }
      }
    } catch {
      // Corrupt .mcp.json — ignore
    }
  }

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
    if (existsSync(projectMcpPath)) {
      try {
        const existing = JSON.parse(readFileSync(projectMcpPath, 'utf8'));
        if (existing?.mcpServers?.['claude-tempo']) {
          delete existing.mcpServers['claude-tempo'];
          if (Object.keys(existing.mcpServers).length === 0) {
            unlinkSync(projectMcpPath);
            out.success('Removed .mcp.json (no other servers configured)');
          } else {
            writeFileSync(projectMcpPath, JSON.stringify(existing, null, 2) + '\n');
            out.success('Removed claude-tempo from .mcp.json');
          }
        }
      } catch {
        out.warn(`Could not update ${projectMcpPath}`);
      }
    }
  }

  if (hasNpxWarning) {
    console.log();
    out.warn('Your .mcp.json uses npx which may cache stale versions.');
    out.log(`  ${out.dim('Consider removing it — user-level registration is preferred.')}`);
    out.log(`  ${out.dim('Run: claude-tempo init')}`);
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

        // V2 `destroy` update — sets isDestroyed so adapter recovery (bridge
        // recreateSession) sees "no" and exits cleanly instead of zombie-
        // rejoining (#102). PR-H (#132) removed the `hardTerminate` escape
        // hatch and the underlying `updateMetadata({status:'terminated'})`
        // shim it relied on; every v0.25+ workflow supports `destroy` natively.
        await handle.executeUpdate(destroyUpdate, { args: [{ reason: 'stop via CLI' }] });
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

    // V2 `destroy` update — sets isDestroyed so adapter recovery (e.g.
    // copilot-bridge's recreateSession) stops instead of rejoining as a
    // zombie (#102). PR-H (#132) removed the `hardTerminate` escape hatch
    // and the underlying `updateMetadata({status:'terminated'})` shim.
    try {
      await handle.executeUpdate(destroyUpdate, { args: [{ reason: 'stop via CLI' }] });
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

      // Filter by attachment phase (post-#176). Phase lives on the
      // `ClaudeTempoAttachmentState` search attribute.
      const phase = getAttachmentPhase(wf);
      if (!shouldIncludeInBroadcast(phase, !!opts.includeStale)) continue;

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
        responseRequested: false,
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

// --- PR-D verb commands (restart / detach / destroy / migrate / attachment-info) ---

interface VerbOpts extends CliOverrides {
  name: string;
  ensemble?: string;
}

interface RestartCliOpts extends VerbOpts {
  host?: string;
  fresh?: boolean;
  force?: boolean;
  contextMessages?: number;
  /** PR-F: required when force-restarting a session attached to a different host. */
  yesSteal?: string;
}

interface DetachCliOpts extends VerbOpts {
  deadlineMs?: number;
}

interface DestroyCliOpts extends VerbOpts {
  reason?: string;
}

interface MigrateCliOpts extends RestartCliOpts {
  host: string;
}

/** Shared connection + client helper for verb commands. */
async function verbClient(opts: CliOverrides): Promise<{ config: Config; connection: Connection; client: Client }> {
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
  }
  const client = new Client({ connection, namespace: config.temporalNamespace });
  return { config, connection, client };
}

export async function restart(opts: RestartCliOpts) {
  const { config, connection, client } = await verbClient(opts);
  const ensemble = opts.ensemble || config.ensemble;
  try {
    const tempo = createTempoClient(client);

    // PR-F §16.5 guard — cross-host force-restart requires --yes-steal match.
    await enforceCliYesSteal(tempo, ensemble, opts.name, {
      ...(opts.force !== undefined ? { force: opts.force } : {}),
      ...(opts.yesSteal !== undefined ? { yesSteal: opts.yesSteal } : {}),
      verbName: 'restart',
      targetHostFlag: '--host',
      ...(opts.host !== undefined ? { targetHostValue: opts.host } : {}),
    });

    const result = await tempo.restart(ensemble, opts.name, {
      ...(opts.host !== undefined ? { host: opts.host } : {}),
      ...(opts.fresh !== undefined ? { fresh: opts.fresh } : {}),
      ...(opts.force !== undefined ? { force: opts.force } : {}),
      ...(opts.contextMessages !== undefined ? { contextMessages: opts.contextMessages } : {}),
      invokerPlayerId: 'cli',
    });
    out.success(
      `Restart queued for "${result.playerId}"` +
      `${result.host ? ` on ${result.host}` : ''}` +
      `${opts.fresh ? ' (fresh)' : ''}${opts.force ? ' (force)' : ''}.`,
    );
    out.log(`  ${out.dim(`outbox entry: ${result.entryId}`)}`);
    if (opts.host) {
      out.log(`  ${out.dim(`Verify a claude-tempo daemon is running on "${opts.host}" — tasks will queue until one picks them up.`)}`);
    }
  } catch (err: any) {
    out.error(err?.message || String(err));
    process.exit(1);
  } finally {
    await connection.close();
  }
}

export async function detach(opts: DetachCliOpts) {
  const { config, connection, client } = await verbClient(opts);
  const ensemble = opts.ensemble || config.ensemble;
  try {
    const tempo = createTempoClient(client);
    await tempo.detach(ensemble, opts.name, opts.deadlineMs);
    out.success(`Detach signaled for "${opts.name}" (draining up to ${opts.deadlineMs ?? 5000}ms).`);
  } catch (err: any) {
    out.error(err?.message || String(err));
    process.exit(1);
  } finally {
    await connection.close();
  }
}

export async function destroy(opts: DestroyCliOpts) {
  const { config, connection, client } = await verbClient(opts);
  const ensemble = opts.ensemble || config.ensemble;
  try {
    const tempo = createTempoClient(client);
    await tempo.destroy(ensemble, opts.name, opts.reason);
    out.success(`"${opts.name}" destroyed${opts.reason ? ` (reason: ${opts.reason})` : ''}.`);
  } catch (err: any) {
    out.error(err?.message || String(err));
    process.exit(1);
  } finally {
    await connection.close();
  }
}

/**
 * CLI-side `--yes-steal` guard (§16.5 Option B, brief §8 answer 5).
 *
 * Detects cross-host force-restart at the CLI layer and emits a
 * copy-paste-friendly error including the exact re-run command. Returns the
 * confirmed hostname on success; exits the process (code 1) on rejection —
 * intentionally synchronous UX per "hard error, no interactive prompt".
 *
 * Shared by `migrate` and `restart` CLI commands so both surfaces have
 * identical error text.
 */
async function enforceCliYesSteal(
  tempo: ReturnType<typeof createTempoClient>,
  ensemble: string,
  playerName: string,
  opts: {
    force?: boolean;
    yesSteal?: string;
    /** For the "re-run" suggestion — the CLI verb name (`migrate` or `restart`). */
    verbName: string;
    /** For the "re-run" suggestion — flag that carries the target host. */
    targetHostFlag: string;
    /** Resolved target host value (e.g. opts.host for migrate). */
    targetHostValue?: string;
  },
  localHostname: string = hostname(),
): Promise<void> {
  if (!opts.force) return;

  let info;
  try {
    info = await tempo.attachmentInfo(ensemble, playerName);
  } catch {
    // Target may not exist or be destroyed — let the downstream call surface
    // its own error. Not our job to synthesize cross-host errors here.
    return;
  }

  const currentHost = info.currentAttachment?.hostname;
  if (!currentHost || currentHost === localHostname) return;

  const targetFlag = opts.targetHostValue
    ? `${opts.targetHostFlag} ${opts.targetHostValue}`
    : opts.targetHostFlag;
  const reRun = `claude-tempo ${opts.verbName} ${playerName} ${targetFlag} --yes-steal=${currentHost} --force`;

  if (!opts.yesSteal) {
    out.error(`session "${playerName}" is attached to host "${currentHost}".`);
    out.log('  To confirm moving it, re-run with --yes-steal:');
    out.log(`\n    ${reRun}\n`);
    out.log('  This safety flag prevents accidental cross-host session takeover.');
    process.exit(1);
  }
  if (opts.yesSteal !== currentHost) {
    out.error(`--yes-steal mismatch: session "${playerName}" is on "${currentHost}", not "${opts.yesSteal}".`);
    out.log('  Re-run with the correct hostname:');
    out.log(`\n    ${reRun}\n`);
    process.exit(1);
  }
}

export async function migrate(opts: MigrateCliOpts) {
  if (!opts.host) {
    out.error('Usage: claude-tempo migrate <name> --to <hostname> [--force --yes-steal=<current-host>]');
    process.exit(1);
  }
  const { config, connection, client } = await verbClient(opts);
  const ensemble = opts.ensemble || config.ensemble;
  try {
    const tempo = createTempoClient(client);

    // PR-F §16.5 guard — cross-host force-migrate requires --yes-steal match.
    await enforceCliYesSteal(tempo, ensemble, opts.name, {
      ...(opts.force !== undefined ? { force: opts.force } : {}),
      ...(opts.yesSteal !== undefined ? { yesSteal: opts.yesSteal } : {}),
      verbName: 'migrate',
      targetHostFlag: '--to',
      targetHostValue: opts.host,
    });

    const result = await tempo.migrate(ensemble, opts.name, opts.host, {
      ...(opts.fresh !== undefined ? { fresh: opts.fresh } : {}),
      ...(opts.force !== undefined ? { force: opts.force } : {}),
      ...(opts.contextMessages !== undefined ? { contextMessages: opts.contextMessages } : {}),
      invokerPlayerId: 'cli',
    });
    out.success(`Migrate queued for "${result.playerId}" → ${result.host ?? opts.host}.`);
    out.log(`  ${out.dim(`outbox entry: ${result.entryId}`)}`);
    out.log(`  ${out.dim(`Verify a claude-tempo daemon is running on "${opts.host}" — tasks will queue until one picks them up.`)}`);
  } catch (err: any) {
    out.error(err?.message || String(err));
    process.exit(1);
  } finally {
    await connection.close();
  }
}

export async function attachmentInfo(opts: VerbOpts) {
  const { config, connection, client } = await verbClient(opts);
  const ensemble = opts.ensemble || config.ensemble;
  try {
    const tempo = createTempoClient(client);
    const info = await tempo.attachmentInfo(ensemble, opts.name);
    // #264 carved the per-surface formatter out to src/utils/attachment-format.ts
    // so the TUI's /attachment-info renders identical output including heartbeat
    // age. The CLI is now a pure consumer; if you need to add a field, add it
    // to the shared formatter so every surface picks it up at once.
    for (const line of formatAttachmentInfoForDisplay(opts.name, info)) {
      out.log(line);
    }
  } catch (err: any) {
    out.error(err?.message || String(err));
    process.exit(1);
  } finally {
    await connection.close();
  }
}

// --- Recall command (#128) ---

export interface RecallCliOpts extends VerbOpts {
  limit?: number;
  offset?: number;
  previewLength?: number;
  since?: string;
  from?: string;
  includeSent?: boolean;
  /** Emit raw JSON `{ received, sent, total, shown, hasMore, text }` instead of the formatted timeline. */
  json?: boolean;
}

export async function recall(opts: RecallCliOpts) {
  const { config, connection, client } = await verbClient(opts);
  const ensemble = opts.ensemble || config.ensemble;
  try {
    const tempo = createTempoClient(client);
    const { received, sent } = await tempo.recall(ensemble, opts.name);
    const timeline = buildTimeline(received, sent, Boolean(opts.includeSent));
    const rendered = formatRecall(timeline, {
      limit: opts.limit,
      offset: opts.offset,
      previewLength: opts.previewLength,
      since: opts.since,
      from: opts.from,
    });
    if (opts.json) {
      // Machine-readable. Includes the rendered text too so callers can
      // either re-render or pass through. Pagination state is explicit so
      // shell pipelines don't have to parse the header line.
      process.stdout.write(
        JSON.stringify(
          {
            player: opts.name,
            ensemble,
            received,
            sent: opts.includeSent ? sent : [],
            total: rendered.total,
            shown: rendered.shown,
            hasMore: rendered.hasMore,
            text: rendered.text,
          },
          null,
          2,
        ) + '\n',
      );
    } else {
      out.log(rendered.text);
    }
  } catch (err: any) {
    out.error(err?.message || String(err));
    process.exit(1);
  } finally {
    await connection.close();
  }
}

// --- PR-E restore command (design §10.3) ---

interface RestoreCliOpts extends CliOverrides {
  /** Specific player name to restore. Omitted means "interactive picker". */
  name?: string;
  ensemble?: string;
  /** Restore every orphan in the namespace, respecting allowlist. */
  all?: boolean;
  /** Filter to orphans whose `preferredHost` matches this value. */
  fromHost?: string;
  /** List candidates without restoring. */
  dryRun?: boolean;
}

/**
 * Render a single orphan row. Used by both the dry-run list and the
 * interactive picker.
 */
function formatOrphanRow(o: import('../reconcile/orphans').OrphanCandidate, index?: number): string {
  const idx = index !== undefined ? `${(index + 1).toString().padStart(2, ' ')}. ` : '';
  const phase = o.info.phase;
  const since = o.summary.detachedSince ?? '(unknown)';
  const pref = o.summary.preferredHost ?? '(unset)';
  return `${idx}${o.workflowId}`
    + `\n    phase: ${phase} · detachedSince: ${since} · preferredHost: ${pref}`;
}

/**
 * Prompt the operator to select one of the orphan candidates. Returns the
 * selected index (0-based) or `null` on cancel.
 *
 * Uses Node's `readline` — matches the existing conductor-conflict prompt
 * pattern in `up` command. No `inquirer` dep.
 */
async function pickOrphan(
  orphans: import('../reconcile/orphans').OrphanCandidate[],
): Promise<number | null> {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  out.log('Select orphan to restore:');
  orphans.forEach((o, i) => out.log(formatOrphanRow(o, i)));
  const answer: string = await new Promise((resolve) => {
    rl.question(`\n  Choice [1-${orphans.length}, or 'q' to cancel]: `, resolve);
  });
  rl.close();
  const trimmed = answer.trim().toLowerCase();
  if (trimmed === 'q' || trimmed === '' || trimmed === 'cancel') return null;
  const n = parseInt(trimmed, 10);
  if (Number.isNaN(n) || n < 1 || n > orphans.length) return null;
  return n - 1;
}

/**
 * Restore one orphan via `TempoClient.restart`. Extracted so the `--all` +
 * specific-name + interactive paths share identical error handling +
 * formatting.
 */
async function restoreOneOrphan(
  tempo: ReturnType<typeof createTempoClient>,
  orphan: import('../reconcile/orphans').OrphanCandidate,
  localHostname: string,
): Promise<{ ok: boolean; message: string }> {
  const { ensemble, playerId } = orphan.summary;
  const targetHost = orphan.summary.preferredHost ?? localHostname;
  try {
    const result = await tempo.restart(ensemble, playerId, {
      host: targetHost,
      invokerPlayerId: 'cli',
    });
    return {
      ok: true,
      message: `${playerId} in ${ensemble} → ${targetHost} (outbox ${result.entryId})`,
    };
  } catch (err: any) {
    const msg = err?.message || String(err);
    if (msg.includes('AttachmentConflict')) {
      return { ok: false, message: `${playerId} — already claimed (AttachmentConflict)` };
    }
    return { ok: false, message: `${playerId} — ${msg}` };
  }
}

export async function restore(opts: RestoreCliOpts) {
  const { config, connection, client } = await verbClient(opts);
  const localHost = hostname();
  try {
    const { queryOrphanedSessions } = await import('../reconcile/orphans');
    let orphans = await queryOrphanedSessions(client, { hostname: localHost });

    // `--from-host` filter.
    if (opts.fromHost) {
      orphans = orphans.filter((o) => o.summary.preferredHost === opts.fromHost);
    }

    // Specific `--name` filter.
    if (opts.name) {
      const wanted = opts.name;
      orphans = orphans.filter((o) => o.summary.playerId === wanted);
    }

    if (orphans.length === 0) {
      out.log('No orphaned sessions on this host.');
      if (opts.fromHost) out.log(`  ${out.dim(`(filter: --from-host=${opts.fromHost})`)}`);
      if (opts.name) out.log(`  ${out.dim(`(filter: name=${opts.name})`)}`);
      return;
    }

    // `--dry-run` lists + exits.
    if (opts.dryRun) {
      out.log(`Found ${orphans.length} orphan${orphans.length === 1 ? '' : 's'}${opts.fromHost ? ` on host ${opts.fromHost}` : ''} (dry-run):`);
      orphans.forEach((o, i) => out.log(formatOrphanRow(o, i)));
      return;
    }

    const tempo = createTempoClient(client);

    // `--all` or `--from-host` or `--name` with unique match → batch restore.
    if (opts.all || opts.fromHost || (opts.name && orphans.length === 1)) {
      out.log(`Restoring ${orphans.length} orphan${orphans.length === 1 ? '' : 's'}...`);
      let ok = 0;
      let failed = 0;
      for (const o of orphans) {
        const r = await restoreOneOrphan(tempo, o, localHost);
        if (r.ok) {
          out.success(r.message);
          ok++;
        } else {
          out.warn(r.message);
          failed++;
        }
      }
      out.log(`\nRestore complete — ${ok} queued, ${failed} skipped/failed.`);
      return;
    }

    // Interactive single-select picker.
    const idx = await pickOrphan(orphans);
    if (idx === null) {
      out.log('Cancelled.');
      return;
    }
    const r = await restoreOneOrphan(tempo, orphans[idx], localHost);
    if (r.ok) out.success(r.message);
    else {
      out.error(r.message);
      process.exit(1);
    }
  } catch (err: any) {
    out.error(err?.message || String(err));
    process.exit(1);
  } finally {
    await connection.close();
  }
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

// --- Daemon command moved to src/cli/daemon-command.ts (#157) ---
// The daemon CLI surface lives in its own module with zero Temporal/workflow
// imports so that `daemon stop` / `daemon status` remain operable when the
// Temporal SDK itself is broken (e.g. a native-dep build failure on an
// unsupported Node version). `src/cli.ts` routes `claude-tempo daemon ...`
// directly to that module via dynamic import.

// ── Hold / Pause / Resume ──

interface ReleaseOpts extends CliOverrides {
  ensemble: string;
}

/** Release all held sessions in an ensemble (unlock outbox, deliver initial messages). */
export async function release(opts: ReleaseOpts) {
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

  const query = `WorkflowType = "claudeSessionWorkflow" AND ExecutionStatus = "Running" AND ClaudeTempoEnsemble = "${opts.ensemble.replace(/["\\\n\r]/g, '')}"`;
  let released = 0;

  for await (const wf of client.workflow.list({ query })) {
    try {
      const handle = client.workflow.getHandle(wf.workflowId);
      const locked = await handle.query(outboxLockedQuery);
      if (locked) {
        await handle.signal(releaseHeldSignal);
        released++;
        const sa = wf.searchAttributes || {};
        const playerId = Array.isArray(sa.ClaudeTempoPlayerId) ? String(sa.ClaudeTempoPlayerId[0]) : wf.workflowId;
        out.log(`  ${out.dim('released')} ${playerId}`);
      }
    } catch {
      // Skip failed queries (terminated workflows, etc.)
    }
  }

  if (released > 0) {
    out.success(`Released ${released} player${released !== 1 ? 's' : ''}`);
  } else {
    out.log('No held players found.');
  }

  await connection.close();
}

interface PauseResumeOpts extends CliOverrides {
  ensemble: string;
  /** Issue #172: when true on `resume`, also fan out `releaseHeldSignal` to every
   *  session so deferred task messages are delivered and outboxes unlocked in one shot. */
  release?: boolean;
}

/** Pause an entire ensemble — sessions, scheduler, and maestro. */
export async function pause(opts: PauseResumeOpts) {
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
  await setPausedState(client, opts.ensemble, true);
  out.success(`Ensemble "${opts.ensemble}" paused`);
  await connection.close();
}

/** Resume an entire ensemble — sessions, scheduler, and maestro. */
export async function resume(opts: PauseResumeOpts) {
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
  await setPausedState(client, opts.ensemble, false);

  // Issue #172: opt-in release — fan out `releaseHeldSignal` to every session.
  // The workflow handler is idempotent on non-held sessions (no heldMessage,
  // outboxLocked already false), so this is safe to blanket-signal.
  let releasedCount = 0;
  if (opts.release) {
    const sanitized = opts.ensemble.replace(/["\\\n\r]/g, '');
    const query = `WorkflowType = "claudeSessionWorkflow" AND ExecutionStatus = "Running" AND ClaudeTempoEnsemble = "${sanitized}"`;
    for await (const wf of client.workflow.list({ query })) {
      try {
        const handle = client.workflow.getHandle(wf.workflowId);
        await handle.signal(releaseHeldSignal);
        releasedCount++;
      } catch {
        // Skip terminated / unreachable workflows
      }
    }
    out.log(`  ${out.dim('released')} ${releasedCount} session${releasedCount !== 1 ? 's' : ''}`);
  }

  out.success(`Ensemble "${opts.ensemble}" resumed${opts.release ? ' (with release)' : ''}`);
  await connection.close();
}

/** Shared logic: set paused state across all ensemble components. */
async function setPausedState(client: Client, ensemble: string, paused: boolean) {
  // 1. Signal maestro hub
  try {
    const mh = client.workflow.getHandle(maestroWorkflowId(ensemble));
    await mh.signal(maestroSetPausedSignal, paused);
  } catch {
    // Maestro may not be running — non-critical
  }

  // 2. Signal all active sessions
  const sanitized = ensemble.replace(/["\\\n\r]/g, '');
  const query = `WorkflowType = "claudeSessionWorkflow" AND ExecutionStatus = "Running" AND ClaudeTempoEnsemble = "${sanitized}"`;
  let count = 0;
  for await (const wf of client.workflow.list({ query })) {
    try {
      const handle = client.workflow.getHandle(wf.workflowId);
      await handle.signal(setPausedSignal, paused);
      count++;
    } catch {
      // Skip failed signals
    }
  }
  out.log(`  ${out.dim(paused ? 'paused' : 'resumed')} ${count} session${count !== 1 ? 's' : ''}`);

  // 3. Signal scheduler
  try {
    const sh = client.workflow.getHandle(schedulerWorkflowId(ensemble));
    await sh.signal(setSchedulerPausedSignal, paused);
    out.log(`  ${out.dim(paused ? 'paused' : 'resumed')} scheduler`);
  } catch {
    // Scheduler may not be running — non-critical
  }
}

// `help()`, `version()`, and `upgrade()` moved out of commands.ts (#157 PR C)
// to keep them crash-proof under a broken Temporal SDK install:
//   - help     → src/cli/help-text.ts         (dedicated minimal module)
//   - version  → inlined in src/cli.ts         (package.json read only)
//   - upgrade  → src/cli/upgrade-command.ts    (dynamic Temporal imports)
// All three are routed directly from `src/cli.ts` before `./cli/commands`
// is dynamic-imported, so they remain available as recovery levers.

// See src/cli/upgrade-command.ts for the upgrade handler implementation.
