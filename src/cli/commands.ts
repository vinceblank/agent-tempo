import * as readline from 'readline';
import { existsSync, readFileSync, writeFileSync, mkdirSync, readdirSync, unlinkSync, copyFileSync, statSync, openSync, readSync, closeSync } from 'fs';
import { basename, join, resolve } from 'path';
import { execFileSync, spawn as cpSpawn } from 'child_process';
import { homedir, hostname } from 'os';
import { randomUUID } from 'crypto';
import { Cron } from 'croner';
import { Client, Connection, WorkflowIdConflictPolicy } from '@temporalio/client';
import { spawnInTerminal, spawnCopilotBridge, spawnMockAdapter, resolveClaudePath, launchInTerminal, buildPiConductorSpawn, sweepStaleSecretEnvFiles } from '../spawn';
import { checkPiNodeFloor } from '../pi/probe';
import { conductorWorkflowId, sessionWorkflowId, schedulerWorkflowId, maestroWorkflowId, GLOBAL_MAESTRO_WORKFLOW_ID, ENV, getConfig, isDevMode, Config, CliOverrides, AGENT_TEMPO_HOME, bridgeLogPaths, bridgeLogsRoot } from '../config';
import { getGitInfo } from '../git-info';
import { createTemporalConnection } from '../connection';
import { releaseHeldSignal, outboxLockedQuery, setPausedSignal, destroyUpdate } from '../workflows/signals';
import { addScheduleSignal, setSchedulerPausedSignal } from '../workflows/scheduler-signals';
import { maestroSetPausedSignal } from '../workflows/maestro-signals';
import { AgentType, MockMode, ScheduleEntry, SessionInput, SessionMetadata } from '../types';
import { formatDurationMs } from '../utils/duration';
import { formatAttachmentInfoForDisplay } from '../utils/attachment-format';
import { defaultPart } from '../utils/default-part';
import { runPreflight } from './preflight';
import { isGlobalMcpRegistered, addGlobalMcp, removeGlobalMcp, isMcpConfigured } from './mcp';
import { loadLineup, resolveLineupPath } from '../ensemble/loader';
import { saveLineup, listLineups, readSavedLineup } from '../ensemble/saver';
import { listAgentTypes, resolveAgentType } from '../ensemble/agent-types';
import { shouldIncludeInBroadcast, validateEnsembleName } from '../utils/validation';
import { getAttachmentPhase, getEnsembleName } from '../utils/search-attributes';
import { isDaemonRunning, startDaemon, stopDaemon, getDaemonStatus, isOtherProfileLikelyRunning, DAEMON_LOG_PATH } from './daemon';
// #700 P1 — infra bootstrap moved to a shared helper (CLI `up` + `/ensemble-up`).
import { ensureInfra, isTemporalReachable, registerSearchAttributes, DEFAULT_DB_PATH } from './ensure-infra';
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
    await client.workflow.start('agentMaestroWorkflow', {
      workflowId: wfId,
      taskQueue: config.taskQueue,
      args: [{ ensemble }],
      workflowIdConflictPolicy: WorkflowIdConflictPolicy.USE_EXISTING,
      searchAttributes: {
        AgentTempoEnsemble: [ensemble],
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
    // Issue #450 — derive default `part` from the resolved player type so
    // a typed conductor reads as `'<Role> session'` (still falls back to
    // `'Conductor session'` when no type is resolved).
    autoSummary: defaultPart({
      playerType: resolvedConductorType?.name,
      isConductor: true,
      workDir: process.cwd(),
      adapterType: args.conductorAgent,
    }),
    disableStaleDetection: true,
    temporalConfig: {
      temporalAddress: config.temporalAddress,
      temporalNamespace: config.temporalNamespace,
      taskQueue: config.taskQueue,
    },
    ...(seededMessages.length > 0 ? { messages: seededMessages } : {}),
  };

  await client.workflow.start('agentSessionWorkflow', {
    workflowId: conductorWfId,
    taskQueue: config.taskQueue,
    args: [conductorInput],
    workflowIdConflictPolicy: WorkflowIdConflictPolicy.USE_EXISTING,
    searchAttributes: {
      ...(conductorGitRoot ? { AgentTempoGitRoot: [conductorGitRoot] } : {}),
      AgentTempoHostname: [hostname()],
      AgentTempoEnsemble: [ensemble],
      AgentTempoPlayerId: [conductorName],
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
  /**
   * CLI `--scenario` override (PR-3 of #340-followup, ADR 0014 §5.5). When
   * set, every mock player in the lineup gets `mockMode: 'scripted'` and
   * `mockScenario: <this value>` regardless of what the lineup YAML
   * specified. Lets the conductor one-command spin up an entire scripted
   * ensemble: `agent-tempo --dev up --lineup tempo-mock-jam --scenario echo-roundtrip`.
   */
  scenarioOverride?: string;
}): Promise<void> {
  const { client, config, ensemble, lineup, initialStartup, conductorName } = args;

  // Pre-create and spawn players.
  if (lineup.players.length > 0) {
    console.log();
    out.log(`Recruiting ${lineup.players.length} player${lineup.players.length !== 1 ? 's' : ''} from lineup...`);
  }
  for (const player of lineup.players) {
    // ADR 0014 §4 — `agent: "mock"` is dev-only. Reject up-front rather than
    // letting the spawn fail downstream so operators get a clear hint.
    if (player.agent === 'mock' && !isDevMode()) {
      out.warn(
        `Skipping player "${player.name}" — agent: "mock" requires dev mode. ` +
        `Re-run with --dev to enable.`,
      );
      continue;
    }
    const playerAgent: AgentType =
      player.agent === 'copilot' ? 'copilot' :
      player.agent === 'claude' ? 'claude' :
      player.agent === 'mock' ? 'mock' :
      args.conductorAgent;
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
      // Issue #450 — derive default `part` from the resolved player type
      // so a freshly recruited lineup player reads as e.g.
      // `'Engineer session'` instead of the role-agnostic
      // `'Session in <basename>'` placeholder.
      autoSummary: defaultPart({
        playerType: resolvedPlayerType?.name,
        isConductor: false,
        workDir: resolve(playerWorkDir),
        adapterType: playerAgent,
      }),
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
      await client.workflow.start('agentSessionWorkflow', {
        workflowId: playerWfId,
        taskQueue: config.taskQueue,
        args: [playerInput],
        workflowIdConflictPolicy: WorkflowIdConflictPolicy.USE_EXISTING,
        searchAttributes: {
          ...(playerGitRoot ? { AgentTempoGitRoot: [playerGitRoot] } : {}),
          AgentTempoHostname: [hostname()],
          AgentTempoEnsemble: [ensemble],
          AgentTempoPlayerId: [player.name],
        },
      });
    } catch (err) {
      out.warn(`Could not pre-create workflow for "${player.name}": ${err}`);
      continue;
    }

    // Spawn the player process.
    try {
      if (playerAgent === 'mock') {
        // PR-3 — `--scenario` CLI override wins over per-player lineup
        // `mockScenario`. Forces `mockMode: scripted` because that's the
        // only mode that consumes a scenario. Per-player `mockMode` (silent /
        // chaos / echo) is preserved when no override is set.
        const effectiveMode: MockMode =
          args.scenarioOverride ? 'scripted' : (player.mockMode ?? 'echo');
        const effectiveScenario = args.scenarioOverride ?? player.mockScenario;
        spawnMockAdapter({
          name: player.name,
          ensemble,
          temporalAddress: config.temporalAddress,
          temporalNamespace: config.temporalNamespace,
          temporalApiKey: config.temporalApiKey,
          temporalTlsCertPath: config.temporalTlsCertPath,
          temporalTlsKeyPath: config.temporalTlsKeyPath,
          isConductor: false,
          workDir: playerWorkDir,
          mockMode: effectiveMode,
          ...(effectiveScenario ? { mockScenario: effectiveScenario } : {}),
        });
      } else if (playerAgent === 'copilot') {
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
          // #672 — a `up --lineup` copilot PLAYER is also spawned directly (no
          // terminal) by the transient CLI → same self-kill bug as the conductor.
          // Skip the ppid-poll; daemon-recruit copilot (outbox.ts) keeps it.
          transientSpawner: true,
        });
      } else {
        const claudeArgs = [
          '--dangerously-skip-permissions',
          '--dangerously-load-development-channels', 'server:agent-tempo',
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
          await client.workflow.start('agentSchedulerWorkflow', {
            workflowId: schedulerWfId,
            taskQueue: config.taskQueue,
            args: [{ ensemble, entries: [entry] }],
            workflowIdConflictPolicy: WorkflowIdConflictPolicy.USE_EXISTING,
            searchAttributes: {
              AgentTempoEnsemble: [ensemble],
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

/**
 * #288: no longer exported — the `start`/`conduct` CLI verbs were removed.
 * Still invoked internally by `up()` for its post-provisioning conductor +
 * player spawn. Slice 7 will replace this internal usage with the new
 * auto-provision flow, after which this function can be deleted outright.
 */
async function start(opts: StartOpts) {
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
          out.log(`  ${out.dim('agent-tempo conduct --resume')}    Reconnect a new session to the existing workflow`);
          out.log(`  ${out.dim('agent-tempo conduct --replace')}   Stop the existing conductor and start fresh`);
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
          console.error('[agent-tempo:conduct] ensureMaestroWorkflow failed:', err);
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
      // #672 — CLI-direct copilot spawn (start path): transient `up`/`conduct`
      // spawner → skip the ppid-poll. Daemon-recruit copilot (outbox.ts) omits it.
      transientSpawner: true,
    });
    out.success(`Launched copilot bridge "${sessionName}" (pid ${pid ?? 'unknown'})`);
  } else {
    const claudeArgs = [
      '--dangerously-skip-permissions',
      '--dangerously-load-development-channels', 'server:agent-tempo',
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

  // #93: resume flow — after the conductor is spawned, scan for orphaned
  // player workflows on this host and enqueue `restart` entries on their
  // outboxes so the daemon re-attaches. Reuses the same helper the daemon
  // calls at boot (`reconcileOnBoot`). Only fires when the user explicitly
  // chose the resume path (`--resume` or `up` option 2).
  if (opts.conductor && opts.resume && conductorClient) {
    try {
      const { restoreOrphansOnce, formatRestoreOutcome } = await import('../reconcile/orphans');
      const summary = await restoreOrphansOnce(
        conductorClient,
        { hostname: hostname(), invokerPlayerId: 'cli', policy: 'auto' },
      );
      if (summary.details.length > 0) {
        console.log();
        out.heading('Orphaned players');
        for (const d of summary.details) {
          const text = `${d.playerId} — ${formatRestoreOutcome(d.outcome)}`;
          switch (d.outcome.kind) {
            case 'queued': out.success(text); break;
            case 'failed': out.warn(text); break;
            case 'skipped': out.log(`  ${out.dim(text)}`); break;
          }
        }
        out.log(`${summary.reattached} reattached, ${summary.skipped} skipped, ${summary.failed} failed.`);
      }
    } catch (err) {
      out.warn(`Orphan restore scan failed (non-fatal): ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  if (conductorConnection) {
    try { await conductorConnection.close(); } catch { /* best effort */ }
  }

  out.log(`\nCheck status: ${out.dim('agent-tempo status ' + opts.ensemble)}`);
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
  const query = 'WorkflowType = "agentSessionWorkflow" AND ExecutionStatus = "Running"';

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

      // Attachment phase lives on the `AgentTempoAttachmentState` search attribute (post-#175).
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

  // Query scheduler workflows for active schedules. #586 — using
  // `ScheduleEntry` directly (the wire shape) so the display formatter
  // sees the canonical `'once' | 'interval' | 'cron'` discriminator and
  // can pick up `cronExpression` / `timezone` for cron entries instead
  // of falling through to "one-shot".
  const schedulesByEnsemble = new Map<string, ScheduleEntry[]>();

  const schedulerQuery = 'WorkflowType = "agentSchedulerWorkflow" AND ExecutionStatus = "Running"';
  for await (const wf of client.workflow.list({ query: schedulerQuery })) {
    try {
      const handle = client.workflow.getHandle(wf.workflowId);
      const entries = await handle.query('getSchedules') as ScheduleEntry[];
      if (entries.length > 0) {
        // Extract ensemble from workflow ID: agent-scheduler-{ensemble}
        const ensemble = wf.workflowId.replace('agent-scheduler-', '');
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
      const pidInfo = s.agentType === 'copilot' ? getBridgePidInfo(ensemble, s.name) : '';
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
        const recur = formatScheduleRecurrence(sched);
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
    out.success('agent-tempo already registered');
    out.log(`  ${out.dim('claude mcp list -s user')}`);
    return;
  }

  const claudePath = resolveClaudePath();
  if (claudePath === 'claude') {
    out.warn('claude binary not found — falling back to project-level .mcp.json');
    return initProject(opts.dir);
  }

  if (addGlobalMcp()) {
    out.success('Registered agent-tempo globally (user scope)');
    out.log(`  ${out.dim('Available in all Claude Code sessions')}`);
  } else {
    out.warn('Failed to register globally — falling back to project-level .mcp.json');
    return initProject(opts.dir);
  }

  out.log(`\nNext steps:`);
  out.log(`  1. Start Temporal:  ${out.dim('temporal server start-dev')}`);
  out.log(`  2. Start conductor: ${out.dim('agent-tempo conduct')}`);
}

/** Per-project .mcp.json install (legacy, used with --project flag). */
function initProject(dir: string) {
  const mcpPath = join(dir, '.mcp.json');

  const entry = {
    command: 'agent-tempo-server',
  };

  if (existsSync(mcpPath)) {
    try {
      const existing = JSON.parse(readFileSync(mcpPath, 'utf8'));
      // Backward-compat: detect either the new (`agent-tempo`) or legacy
      // (`agent-tempo`) registration. Skip the rewrite if either is present —
      // the migration verb is the one path that upgrades the key.
      if (existing?.mcpServers?.['agent-tempo'] || existing?.mcpServers?.['agent-tempo']) {
        out.success('.mcp.json already has an agent-tempo entry');
        out.log(`  ${out.dim(mcpPath)}`);
        return;
      }
      existing.mcpServers = existing.mcpServers || {};
      existing.mcpServers['agent-tempo'] = entry;
      writeFileSync(mcpPath, JSON.stringify(existing, null, 2) + '\n');
      out.success('Added agent-tempo to existing .mcp.json');
    } catch {
      out.error(`Failed to parse ${mcpPath}. Fix the JSON or delete it and re-run.`);
      process.exit(1);
    }
  } else {
    const config = {
      mcpServers: {
        'agent-tempo': entry,
      },
    };
    writeFileSync(mcpPath, JSON.stringify(config, null, 2) + '\n');
    out.success('Created .mcp.json with agent-tempo config');
  }

  out.log(`  ${out.dim(mcpPath)}`);
  out.log(`\nNext steps:`);
  out.log(`  1. Start Temporal:  ${out.dim('temporal server start-dev')}`);
  out.log(`  2. Start conductor: ${out.dim('agent-tempo conduct')}`);
}

// --- Temporal server management ---

// #700 P1 — DEFAULT_DB_PATH, isTemporalReachable, and registerSearchAttributes
// MOVED to ./ensure-infra (the shared infra home; imported back below) so the CLI
// `up` path and the mission-control `/ensemble-up` extension call ONE bootstrap.

function temporalCliExists(): boolean {
  const cmd = process.platform === 'win32' ? 'where' : 'which';
  try {
    execFileSync(cmd, ['temporal'], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
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
  mkdirSync(AGENT_TEMPO_HOME, { recursive: true });

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
  /**
   * `--scenario <name>` (PR-3 of #340-followup, ADR 0014 §5.5). Forces
   * every `agent: "mock"` player in the lineup into `mockMode: "scripted"`
   * with this scenario. Bare name (resolved against shipped `scenarios/`)
   * or absolute path. Ignored when no `--lineup` is given.
   *
   * Dev-mode-only — silently no-ops outside dev mode because mock players
   * can't exist there anyway (gate 3 in recruit pre-flight).
   */
  scenario?: string;
}

export async function up(opts: UpOpts) {
  const config = getConfig(opts);

  // #689 — best-effort sweep of stale 0600 secret env files (residual from a shell
  // that died between `source` and `rm`). Owner-only, swallows errors.
  sweepStaleSecretEnvFiles();

  out.heading('agent-tempo setup');

  // Step 1: Check temporal CLI
  if (!temporalCliExists()) {
    out.error('temporal CLI not found');
    out.log(`\n  Install the Temporal CLI first:`);
    out.log(`  ${out.dim('https://docs.temporal.io/cli')}\n`);
    process.exit(1);
  }
  out.check('temporal CLI installed', true);

  // Steps 2–3.7: bring infra up via the SHARED ensureInfra — the same path
  // `/ensemble-up` uses, so CLI + extension can't drift (#700 P1). Order:
  // Temporal → search attributes → agent types → daemon (SA BEFORE daemon — the
  // daemon refuses to boot without them). `onStep` renders the same out.check
  // sequence `up()` showed before the extraction.
  try {
    await ensureInfra({
      config,
      onStep: (p) => {
        if (p.step === 'temporal') {
          out.check(p.status === 'ok' ? 'Temporal running' : 'Temporal started', true, p.detail);
        } else if (p.step === 'agent-types') {
          if (p.detail?.startsWith('installed')) out.success(`Agent types: ${p.detail} → ~/.claude/agents/`);
          else if (p.detail) out.dim(`  Agent types already installed (${p.detail})`);
        } else if (p.step === 'search-attributes') {
          // #46 — ensureInfra registers SAs with `quiet: true` (the per-attribute
          // success lines are suppressed for the extension TUI path). The CLI
          // restores visibility with a one-line summary here. `detail` is
          // "N failed" only when registration failed (errors/permission warnings
          // still print from registerSearchAttributes regardless of `quiet`).
          out.check('Search attributes registered', !p.detail, p.detail);
        } else if (p.step === 'daemon') {
          out.check(p.status === 'ok' ? 'Worker daemon running' : 'Worker daemon started', true, p.detail);
        }
      },
    });
  } catch (err: any) {
    out.error(`Infra startup failed: ${err?.message || err}`);
    out.log(`  ${out.dim('You can start it manually: agent-tempo daemon start')}`);
    process.exit(1);
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

  // Resolve conductor agent from lineup or CLI flags.
  // `agent: "mock"` is dev-only — silently fall back to the CLI default
  // outside dev mode so a mis-configured lineup doesn't spawn a real session
  // unexpectedly (mirrors the player-level guard at ~line 209).
  const conductorAgent: AgentType =
    lineup?.conductor?.agent === 'copilot' ? 'copilot' :
    lineup?.conductor?.agent === 'pi' ? 'pi' :
    lineup?.conductor?.agent === 'mock' && isDevMode() ? 'mock' :
    opts.agent;

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
        out.log(`  Use ${out.dim('--resume')} to reconnect, or ${out.dim('agent-tempo start')} to join as a player.`);
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
  if (conductorAgent === 'mock') {
    // Dev-mode mock conductor — mirrors the player mock-spawn path in
    // applyLineupPlayersAndSchedules. isConductor: true so the mock
    // adapter registers the session as the ensemble conductor.
    const effectiveMode: MockMode = lineup?.conductor?.mockMode ?? 'echo';
    const effectiveScenario = lineup?.conductor?.mockScenario;
    ({ pid } = spawnMockAdapter({
      name: sessionName,
      ensemble: opts.ensemble,
      temporalAddress: config.temporalAddress,
      temporalNamespace: config.temporalNamespace,
      temporalApiKey: config.temporalApiKey,
      temporalTlsCertPath: config.temporalTlsCertPath,
      temporalTlsKeyPath: config.temporalTlsKeyPath,
      isConductor: true,
      workDir: process.cwd(),
      mockMode: effectiveMode,
      ...(effectiveScenario ? { mockScenario: effectiveScenario } : {}),
    }));
  } else if (conductorAgent === 'copilot') {
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
      // #672 — the `up` CLI is a TRANSIENT spawner; the detached bridge must NOT
      // ppid-poll it (would self-kill seconds after launch → lease never renews →
      // all players detach). The daemon-recruit path (outbox.ts) omits this.
      transientSpawner: true,
    }));
  } else if (conductorAgent === 'pi') {
    // Interactive Pi conductor (#666). MUST launch `pi` in a REAL TERMINAL —
    // Pi only fires session_start / attaches in a TTY (headless/print-mode does
    // NOT). So this uses launchInTerminal, NOT spawnPiHeadless (that's recruited
    // players). One branch serves `up --agent pi` AND TUI /recruit-conductor.
    //
    // PREFLIGHT — fail clean BEFORE launching a terminal that would die:
    const nodeFloor = checkPiNodeFloor(); // best-effort proxy on the daemon's Node
    if (!nodeFloor.ok) {
      out.error(`Cannot start Pi conductor — ${nodeFloor.reason}`);
      process.exit(1);
    }
    if (!process.env.ANTHROPIC_API_KEY) {
      out.warn('ANTHROPIC_API_KEY is not set — the Pi conductor will fall back to Pi\'s own auth/default model. Set it if Pi needs an Anthropic key.');
    }
    let piSpawn: { cmd: string; args: string[]; env: Record<string, string> };
    try {
      // resolvePiInteractiveBinary / resolvePiExtensionPath throw fail-clean
      // (Pi CLI missing / extension unbuilt) — caught here, no terminal launched.
      piSpawn = buildPiConductorSpawn({
        ensemble: opts.ensemble,
        sessionName,
        temporalEnvVars,
        taskQueue: config.taskQueue,
        devMode: isDevMode(),
        conductorTypeName: resolvedConductorType?.name || conductorTypeName,
        anthropicApiKey: process.env.ANTHROPIC_API_KEY,
      });
    } catch (err) {
      out.error(`Cannot start Pi conductor — ${err instanceof Error ? err.message : String(err)}`);
      process.exit(1);
    }
    ({ pid } = launchInTerminal(piSpawn.cmd, piSpawn.args, process.cwd(), piSpawn.env));
  } else {
    const claudeArgs = [
      '--dangerously-skip-permissions',
      '--dangerously-load-development-channels', 'server:agent-tempo',
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
      ...(opts.scenario ? { scenarioOverride: opts.scenario } : {}),
    });
  }

  await connection.close();

  console.log();
  out.success('You\'re all set!');
  out.log(`  Ensemble: ${out.cyan(opts.ensemble)}`);
  if (!lineup) {
    out.log(`\n  ${out.bold('What next?')}`);
    out.log(`  ${out.dim('agent-tempo start ' + opts.ensemble)}    Add a player session`);
    out.log(`  ${out.dim('agent-tempo status ' + opts.ensemble)}   See who\'s active`);
    out.log(`  Or ask the conductor to ${out.dim('recruit')} players for you`);
  } else {
    out.log(`  Lineup: ${out.dim(lineup.name)}`);
    out.log(`  Players: ${lineup.players.length}`);
    if (lineup.schedules?.length) out.log(`  Schedules: ${lineup.schedules.length}`);
    out.log(`\n  ${out.dim('agent-tempo status ' + opts.ensemble)}   See who\'s active`);
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

/**
 * Format a `ScheduleEntry` recurrence for the `status` display.
 *
 * #586 — cron entries previously rendered as `'one-shot'` because the inline
 * formatter only checked `sched.interval`. The display formatter now mirrors
 * the wire-type triplet (`'once' | 'interval' | 'cron'`) from
 * `ScheduleEntry.type` so cron schedules from the lineup loader (and the
 * MCP `load_lineup` path) read correctly in `agent-tempo status`.
 *
 * Exported for unit tests.
 */
export function formatScheduleRecurrence(sched: ScheduleEntry): string {
  if (sched.type === 'cron' && sched.cronExpression) {
    const tz = sched.timezone && sched.timezone !== 'UTC' ? ` ${sched.timezone}` : '';
    return `cron: ${sched.cronExpression}${tz}`;
  }
  if (sched.interval) {
    return `every ${formatDurationMs(sched.interval)}`;
  }
  return 'one-shot';
}

/**
 * Convert a lineup schedule definition to a ScheduleEntry for the scheduler
 * workflow.
 *
 * #586 — cron entries now produce `type: 'cron'` with `cronExpression` +
 * `timezone` populated; previously they fell through to the default
 * `nextFireAt = now + 60_000` with `type: 'once'`, firing once and getting
 * garbage-collected. The cron branch mirrors the MCP-side `load_lineup` tool
 * at `src/tools/load-lineup.ts:280-300` so both load paths agree on the wire
 * shape submitted to the scheduler workflow.
 *
 * Exported for unit tests; consumed internally by `up` /
 * `ensembleCommand` after a lineup is parsed.
 */
export function lineupScheduleToEntry(
  sched: NonNullable<import('../ensemble/schema').EnsembleLineup['schedules']>[number],
  /** Injectable clock for deterministic tests. Defaults to `Date.now()`. */
  now: number = Date.now(),
): ScheduleEntry {
  let nextFireAt: string;
  let interval: number | undefined;
  let cronExpression: string | undefined;
  let timezone: string | undefined;

  if (sched.cron) {
    // #586 — cron branch matches MCP `load_lineup` (src/tools/load-lineup.ts:280).
    // `croner` is a runtime dependency declared in package.json; the scheduler
    // workflow uses it on the firing side too (src/activities/schedule-fire.ts).
    cronExpression = sched.cron;
    timezone = sched.timezone ?? 'UTC';
    const job = new Cron(cronExpression, { timezone });
    const next = job.nextRun(new Date(now));
    if (!next) {
      throw new Error(
        `Cron expression "${sched.cron}" has no upcoming fire time (schedule "${sched.name}")`,
      );
    }
    nextFireAt = next.toISOString();
  } else if (sched.every) {
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

  const type: ScheduleEntry['type'] = cronExpression
    ? 'cron'
    : interval
      ? 'interval'
      : 'once';

  return {
    name: sched.name,
    message: sched.message,
    target: sched.target,
    createdBy: 'lineup',
    nextFireAt,
    interval,
    cronExpression,
    timezone,
    until: sched.until,
    remainingCount: sched.count,
    firedCount: 0,
    type,
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

/**
 * Require the user to type `expected` verbatim to confirm an irrecoverable
 * action. Exits with code 1 in non-TTY environments.
 */
async function typedConfirmPrompt(message: string, expected: string): Promise<boolean> {
  if (!process.stdin.isTTY) {
    out.error('Non-interactive environment: use --yes / -y to skip this confirmation.');
    process.exit(1);
  }
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  return new Promise<boolean>((resolve) => {
    rl.question(`${message}\n  Type ${out.bold(expected)} to confirm: `, (answer) => {
      rl.close();
      resolve(answer.trim() === expected);
    });
  });
}

// --- Teardown: `down` command ---

interface DownOpts extends CliOverrides {
  removeMcp: boolean;
  keepDaemon: boolean;
  yes: boolean;
  /** When true, terminate every workflow across every ensemble before
   *  stopping infra. Without it, workflows stay on the Temporal server and
   *  resume on the next `up`. */
  destroy: boolean;
  /**
   * `--kill-shared-temporal` (#423): bypass the cross-profile coexistence
   * guard and kill the shared Temporal dev server unconditionally. Without
   * it, `down` skips the Temporal kill when the OPPOSITE profile shows any
   * sign of life (PID file, port file) — see ADR 0014 §5.6 for the same
   * guard `stopDaemon`'s zombie reaper applies. The flag is the explicit
   * opt-in for the hard-reset case.
   */
  killSharedTemporal: boolean;
  dir: string;
}

/**
 * Options for {@link stopTemporalServer} — exported for unit tests so we
 * can inject stubs without spawning real processes or touching the
 * developer's home dir. Production callers should pass only
 * `killSharedTemporal` and accept the defaults.
 *
 * @internal
 */
export interface StopTemporalServerOpts {
  /** When true, bypass the cross-profile coexistence guard. Maps to the
   *  `--kill-shared-temporal` CLI flag (#423). */
  killSharedTemporal: boolean;
  /** Cross-profile coexistence probe — defaults to {@link isOtherProfileLikelyRunning}. */
  isOtherProfileLikelyRunning?: () => boolean;
  /** Process exec hook — defaults to `execFileSync` with stdio ignored. */
  exec?: (command: string, args: string[]) => void;
  /** Platform override — defaults to `process.platform`. */
  platform?: NodeJS.Platform;
}

/** Outcome of {@link stopTemporalServer}, surfaced so callers (and tests)
 *  can shape user-facing messages. */
export type StopTemporalResult =
  | { action: 'killed' }
  | { action: 'failed'; error: unknown }
  | { action: 'skipped-cross-profile' };

/**
 * Stop the shared Temporal dev server, with the same cross-profile guard
 * that `stopDaemon`'s zombie reaper already applies (ADR 0014 §5.6).
 *
 * The Temporal dev server is a single OS-wide process — `pkill -f` on
 * POSIX and `taskkill /IM temporal.exe` on Windows kill it by name and
 * cannot distinguish dev-profile vs prod-profile ownership. So when
 * `agent-tempo --dev down` runs while the prod profile is also active,
 * the unconditional kill takes down the prod profile's Temporal as
 * collateral damage. This is exactly the bug `isOtherProfileLikelyRunning`
 * was introduced to prevent on the daemon side; the missing piece was
 * `down`'s own Temporal kill (#423).
 *
 * `--kill-shared-temporal` (passed as `killSharedTemporal: true`) is the
 * explicit opt-in for the hard-reset case where the user accepts cross-
 * profile collateral damage.
 */
export function stopTemporalServer(opts: StopTemporalServerOpts): StopTemporalResult {
  const otherLikelyRunning = opts.isOtherProfileLikelyRunning ?? isOtherProfileLikelyRunning;
  const exec = opts.exec ?? ((cmd, args) => { execFileSync(cmd, args, { stdio: 'ignore' }); });
  const platform = opts.platform ?? process.platform;

  if (!opts.killSharedTemporal && otherLikelyRunning()) {
    return { action: 'skipped-cross-profile' };
  }

  try {
    if (platform === 'win32') {
      exec('taskkill', ['/F', '/IM', 'temporal.exe']);
    } else {
      exec('pkill', ['-f', 'temporal server start-dev']);
    }
    return { action: 'killed' };
  } catch (err) {
    return { action: 'failed', error: err };
  }
}

/**
 * Minimal child handle {@link startTemporalForDestroy} needs — `ChildProcess`
 * satisfies it. Kept narrow so unit tests can inject a fake without spawning.
 *
 * @internal
 */
export interface SpawnedTemporalChild {
  kill(): void;
  unref(): void;
}

/**
 * Dependency seam for {@link startTemporalForDestroy} — production callers
 * pass nothing and get the real spawn + reachability probe. Tests inject
 * stubs plus a tiny `pollDelayMs` so the readiness loop runs instantly.
 *
 * @internal
 */
export interface StartTemporalForDestroyDeps {
  /** Readiness probe — defaults to {@link isTemporalReachable} for `config`. */
  isReachable?: () => Promise<boolean>;
  /** Spawn hook — defaults to a detached `temporal server start-dev`. */
  spawn?: () => SpawnedTemporalChild;
  /** Readiness poll attempts. Default 20. */
  attempts?: number;
  /** Delay between readiness polls, ms. Default 500 (→ 20×500ms = 10s). */
  pollDelayMs?: number;
}

/**
 * Start a temporary Temporal dev server just long enough for `down --destroy`
 * to terminate workflows when Temporal happened to be down. Polls for
 * readiness; on timeout it kills the child it spawned so `down` never leaves
 * a stray Temporal process booting in the background. Exported for unit
 * tests — production callers pass only `config`.
 *
 * @internal
 */
export async function startTemporalForDestroy(
  config: Config,
  deps: StartTemporalForDestroyDeps = {},
): Promise<{ started: boolean }> {
  const attempts = deps.attempts ?? 20;
  const pollDelayMs = deps.pollDelayMs ?? 500;
  const isReachable = deps.isReachable ?? (() => isTemporalReachable(config));
  const spawn = deps.spawn ?? ((): SpawnedTemporalChild => {
    mkdirSync(AGENT_TEMPO_HOME, { recursive: true });
    const port = config.temporalAddress.split(':')[1] || '7233';
    return cpSpawn('temporal', [
      'server', 'start-dev',
      '--port', port,
      '--db-filename', DEFAULT_DB_PATH,
    ], { detached: true, stdio: 'ignore' });
  });

  const child = spawn();
  child.unref();
  for (let i = 0; i < attempts; i++) {
    await new Promise(r => setTimeout(r, pollDelayMs));
    if (await isReachable()) return { started: true };
  }
  // Timed out. The detached child may still be booting and would come up
  // orphaned moments after we give up — kill the process we spawned so
  // `down` doesn't leave a stray Temporal server behind.
  try { child.kill(); } catch { /* already exited */ }
  return { started: false };
}

export async function down(opts: DownOpts) {
  const config = getConfig(opts);

  out.heading('agent-tempo teardown');
  out.log(opts.destroy
    ? `  ${out.bold('Destroying all workflows')}, then stopping daemon + Temporal.`
    : `  Stopping daemon + Temporal. Workflows stay parked for the next ${out.dim('agent-tempo up')}.`,
  );

  // Step 1 (destroy mode only): enumerate + terminate workflows across every
  // ensemble, after a typed confirmation showing the user what's at stake.
  let temporalUp = await isTemporalReachable(config);

  // `--destroy` can only terminate workflows while Temporal is reachable.
  // Workflow state lives durably on disk in ~/.agent-tempo/, so if Temporal
  // happens to be down when the user runs `down --destroy`, skipping the
  // destroy step here silently leaves every workflow to be resurrected the
  // next time anything starts the daemon (an `up`, a `status`, or the TUI).
  // To make `--destroy` actually mean it, start Temporal temporarily just
  // long enough to run the terminations — Step 4 below stops it again.
  let startedTemporalForDestroy = false;
  if (opts.destroy && !temporalUp) {
    if (!temporalCliExists()) {
      out.warn('temporal CLI not found — cannot destroy workflows; they will persist on disk.');
    } else {
      out.log(`  ${out.dim('...')} Temporal is down — starting it temporarily to destroy workflows...`);
      const { started } = await startTemporalForDestroy(config);
      if (started) {
        temporalUp = true;
        startedTemporalForDestroy = true;
        out.success('Temporal started for cleanup');
      } else {
        out.warn(
          'Could not start Temporal within 10s — workflows may survive teardown. ' +
          'Re-run `agent-tempo down --destroy` once Temporal is up. ' +
          'A stray Temporal process may have been left starting — check with ' +
          '`agent-tempo status` and stop it manually if one is still running.',
        );
      }
    }
  }

  if (opts.destroy && temporalUp) {
    try {
      const connection = await createTemporalConnection(config);
      const client = new Client({ connection, namespace: config.temporalNamespace });
      try {
        // Enumerate every workflow type we own, not just sessions. Previously
        // we only listed `agentSessionWorkflow` and derived maestro/scheduler
        // workflow IDs from each session's `AgentTempoEnsemble` search
        // attribute. Two failure modes that left orphans behind:
        //   1. Sessions started without the search attribute set (e.g. from
        //      an older or partially-rebranded build) were added to
        //      `sessionIds` but their ensemble name never made it into the
        //      `runningEnsembles` set — and the early-return on
        //      `runningEnsembles.size === 0` then bailed out without
        //      terminating ANY of the buffered session IDs.
        //   2. Maestro/scheduler workflows whose sessions had already exited
        //      were invisible to a session-only query.
        // Listing each type directly catches both cases.
        const collect = async (query: string): Promise<string[]> => {
          const ids: string[] = [];
          for await (const wf of client.workflow.list({ query })) {
            ids.push(wf.workflowId);
          }
          return ids;
        };
        const baseFilter = 'ExecutionStatus = "Running"';
        const [sessionIds, maestroIds, schedulerIds, globalMaestroIds] = await Promise.all([
          collect(`WorkflowType = "agentSessionWorkflow" AND ${baseFilter}`),
          collect(`WorkflowType = "agentMaestroWorkflow" AND ${baseFilter}`),
          collect(`WorkflowType = "agentSchedulerWorkflow" AND ${baseFilter}`),
          collect(`WorkflowType = "agentGlobalMaestroWorkflow" AND ${baseFilter}`),
        ]);

        // Ensemble names are best-effort display only — derived from
        // workflow ID prefixes when present. We terminate by ID, not by
        // ensemble, so a missing name no longer blocks cleanup.
        const ensemblesFromIds = new Set<string>();
        for (const id of sessionIds) {
          // `agent-session-<ensemble>-<playerId>` / legacy `claude-session-<ensemble>-<playerId>`
          const m = id.match(/^(?:agent|claude)-session-(.+?)-[^-]+$/);
          if (m) ensemblesFromIds.add(m[1]);
        }
        for (const id of maestroIds) {
          // `agent-maestro-<ensemble>` (and `agent-maestro-global` which we exclude as global)
          const m = id.match(/^(?:agent|claude)-maestro-(.+)$/);
          if (m && m[1] !== 'global') ensemblesFromIds.add(m[1]);
        }

        const totalTargets =
          sessionIds.length + maestroIds.length + schedulerIds.length + globalMaestroIds.length;

        if (totalTargets === 0) {
          out.log('  No active workflows to destroy.');
        } else {
          if (!opts.yes) {
            console.log();
            if (ensemblesFromIds.size > 0) {
              out.log('  The following ensembles will be destroyed:');
              for (const name of [...ensemblesFromIds].sort()) {
                out.log(`    - ${name}`);
              }
            }
            out.log(
              `  ${sessionIds.length} session${sessionIds.length !== 1 ? 's' : ''}, ` +
              `${maestroIds.length} maestro${maestroIds.length !== 1 ? 's' : ''}, ` +
              `${schedulerIds.length} scheduler${schedulerIds.length !== 1 ? 's' : ''}` +
              (globalMaestroIds.length > 0 ? `, ${globalMaestroIds.length} global maestro` : ''),
            );
            console.log();
            const confirmed = await typedConfirmPrompt(
              `  This terminates every workflow (${totalTargets}) and cannot be undone.`,
              'destroy',
            );
            if (!confirmed) {
              out.log('Aborted.');
              // We may have started Temporal solely to run this destroy.
              // Aborting at the confirmation prompt must not leave that
              // server orphaned — stop it before the hard exit. We own it
              // outright, so force past the cross-profile guard.
              if (startedTemporalForDestroy) {
                if (stopTemporalServer({ killSharedTemporal: true }).action === 'killed') {
                  out.log(`  ${out.dim('Temporal server stopped')}`);
                }
              }
              process.exit(0);
            }
          }

          // Fan out terminations in parallel. Individual failures are
          // swallowed — closed workflows are fine, and the overall operation
          // is best-effort scorched-earth.
          const terminate = async (id: string): Promise<boolean> => {
            try {
              await client.workflow.getHandle(id).terminate('agent-tempo down --destroy');
              return true;
            } catch {
              return false;
            }
          };
          const targets = [...sessionIds, ...maestroIds, ...schedulerIds, ...globalMaestroIds];
          const results = await Promise.all(targets.map(terminate));
          const terminated = results.filter(Boolean).length;

          const ensembleCount = ensemblesFromIds.size;
          out.success(
            `Terminated ${terminated}/${totalTargets} workflow${terminated !== 1 ? 's' : ''}` +
            (ensembleCount > 0 ? ` across ${ensembleCount} ensemble${ensembleCount !== 1 ? 's' : ''}` : ''),
          );
        }
      } finally {
        await connection.close();
      }
    } catch (err) {
      out.warn(`Could not terminate active workflows: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  // Step 2: Kill bridge processes via PID files
  killBridgeProcesses();

  // Step 3: Stop worker daemon unless `--keep-daemon`.
  if (opts.keepDaemon) {
    if (isDaemonRunning()) {
      out.log(`  ${out.dim('Worker daemon left running (--keep-daemon)')}`);
    }
  } else if (stopDaemon()) {
    out.success('Worker daemon stopped');
  }

  // Step 4: Stop Temporal dev server.
  //
  // Cross-profile coexistence (ADR 0014 §5.6, #423): the dev-server is one
  // OS-wide process and `pkill`/`taskkill` cannot distinguish profile
  // ownership. Without the guard, `--dev down` kills the prod profile's
  // Temporal as collateral damage (and vice versa). `stopTemporalServer`
  // skips the kill when the OPPOSITE profile is likely active;
  // `--kill-shared-temporal` is the explicit opt-in to override.
  if (temporalUp) {
    // When we started Temporal ourselves just for the destroy step, always
    // stop it again — the cross-profile guard is about not killing a server
    // the *other* profile owns, but this one we own outright.
    const result = stopTemporalServer({
      killSharedTemporal: opts.killSharedTemporal || startedTemporalForDestroy,
    });
    switch (result.action) {
      case 'killed':
        out.success('Temporal server stopped');
        break;
      case 'failed':
        out.warn('Could not stop Temporal server (may need to stop it manually)');
        break;
      case 'skipped-cross-profile': {
        const otherProfile = isDevMode() ? 'prod' : 'dev';
        out.warn(
          `Temporal server kept running — the ${otherProfile} profile appears active. ` +
            `Pass --kill-shared-temporal to override.`,
        );
        break;
      }
    }
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
      // Backward-compat: check both the new (`agent-tempo`) and legacy (`agent-tempo`) keys.
      const tempoEntry = mcpContent?.mcpServers?.['agent-tempo'] ?? mcpContent?.mcpServers?.['agent-tempo'];
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
        out.success('Removed agent-tempo from global MCP config');
      } else {
        out.warn('Could not remove global MCP entry');
      }
    }

    // Also remove project-level .mcp.json entry if present.
    // Backward-compat: clean up either the new (`agent-tempo`) or legacy (`agent-tempo`) key.
    if (existsSync(projectMcpPath)) {
      try {
        const existing = JSON.parse(readFileSync(projectMcpPath, 'utf8'));
        const removedAny =
          (existing?.mcpServers?.['agent-tempo'] && (delete existing.mcpServers['agent-tempo'])) ||
          (existing?.mcpServers?.['agent-tempo'] && (delete existing.mcpServers['agent-tempo']));
        if (removedAny) {
          if (Object.keys(existing.mcpServers).length === 0) {
            unlinkSync(projectMcpPath);
            out.success('Removed .mcp.json (no other servers configured)');
          } else {
            writeFileSync(projectMcpPath, JSON.stringify(existing, null, 2) + '\n');
            out.success('Removed agent-tempo from .mcp.json');
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
    out.log(`  ${out.dim('Run: agent-tempo init')}`);
  }

  console.log();
  out.success('agent-tempo is shut down');
  out.log(`  ${out.dim('Temporal data preserved in ~/.agent-tempo/ (delete manually to reset)')}`);
  console.log();
}


/**
 * Read PID info for a copilot bridge session from its PID file.
 * Returns a formatted string like " (pid 12345)" or "" if no PID file found.
 */
function getBridgePidInfo(ensemble: string, name: string): string {
  // #690 — pid lives at the CENTRAL ~/.agent-tempo/logs/<ensemble>/ path; transitional
  // READ-ONLY fallback to the legacy per-cwd ./logs for a pre-upgrade bridge.
  // TODO(v1.7): drop the legacy fallback.
  const centralPid = bridgeLogPaths(ensemble, name).pidPath;
  const legacyPid = join(process.cwd(), 'logs', `${name}.pid`);
  const pidPath = existsSync(centralPid) ? centralPid : legacyPid;
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
 * Kill all bridge processes found in `*.pid` files and clean up the pid files.
 *
 * #690 — bridge pid files moved to the CENTRAL `~/.agent-tempo/logs/<ensemble>/`
 * dirs. `down` is a GLOBAL teardown (it stops the daemon + Temporal for EVERY
 * ensemble), so this scans ALL central ensemble subdirs — NOT a single ensemble.
 *
 * ⚠️ GLOBAL-TEARDOWN ONLY. The sole caller is `down()`, which has no ensemble (it
 * stops everything), so scanning all ensembles is correct HERE. A FUTURE
 * ensemble-scoped teardown (e.g. `down --ensemble X` / a per-ensemble `destroy`)
 * MUST add an `ensemble` param and scope this to `bridgeLogPaths(ensemble, '').dir`
 * — do NOT reuse this global scan-all from a scoped op: it would kill OTHER live
 * ensembles' bridges. The param is intentionally NOT added now (no caller needs it
 * = speculative; backlogged per the architect's deviation ruling).
 *
 * Plus a transitional READ of the legacy per-cwd `./logs` for a pre-upgrade
 * bridge. TODO(v1.7): drop the legacy `./logs` dir.
 */
function killBridgeProcesses() {
  const centralRoot = bridgeLogsRoot();
  const dirs: string[] = [join(process.cwd(), 'logs')]; // legacy (transitional)
  try {
    for (const ent of readdirSync(centralRoot, { withFileTypes: true })) {
      if (ent.isDirectory()) dirs.push(join(centralRoot, ent.name));
    }
  } catch {
    // no central logs root yet — nothing central to scan
  }

  for (const logsDir of dirs) {
    if (!existsSync(logsDir)) continue;
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
        out.log(`  Run ${out.dim('agent-tempo agent-types init')} to install shipped examples.`);
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
        out.error('Usage: agent-tempo agent-types show <name>');
        process.exit(1);
      }
      const info = resolveAgentType(opts.name);
      if (!info) {
        out.error(`No agent type found named "${opts.name}"`);
        out.log(`  Run ${out.dim('agent-tempo agent-types list')} to see available types.`);
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
      out.error('Usage: agent-tempo agent-types <list|show|init> [name]');
      out.log(`\n  ${out.dim('agent-tempo agent-types list')}          List available agent types`);
      out.log(`  ${out.dim('agent-tempo agent-types show <name>')}   Display an agent definition`);
      out.log(`  ${out.dim('agent-tempo agent-types init')}          Copy shipped examples to ~/.claude/agents/`);
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

  const query = `WorkflowType = "agentSessionWorkflow" AND ExecutionStatus = "Running"`;
  const targets: Array<{ playerId: string; workflowId: string }> = [];

  for await (const wf of client.workflow.list({ query })) {
    try {
      const handle = client.workflow.getHandle(wf.workflowId);
      const metadata: SessionMetadata = await handle.query('getMetadata');

      if (metadata.ensemble !== ensemble) continue;

      // Filter by attachment phase (post-#176). Phase lives on the
      // `AgentTempoAttachmentState` search attribute.
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

// --- Destroy + attachment-info CLI verbs ---

interface VerbOpts extends CliOverrides {
  name: string;
  ensemble?: string;
}

interface DestroyCliOpts extends CliOverrides {
  ensemble: string;
  yes: boolean;
}

/**
 * Shared connection + client helper for verb commands. Exported so the
 * dev-mode verb dispatcher (`./dev-verbs.ts`) can use the same connection
 * idiom — single source of truth for the 3-second timeout + error-exit
 * behavior across all CLI verbs.
 */
export async function verbClient(opts: CliOverrides): Promise<{ config: Config; connection: Connection; client: Client }> {
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

/**
 * `agent-tempo destroy <ensemble> [-y]` — terminate every workflow in an
 * ensemble (#288). Prompts with the ensemble name and workflow count unless
 * `-y` is passed. The per-player destroy path lives in the TUI (`/destroy
 * --player`).
 */
export async function destroy(opts: DestroyCliOpts) {
  const { config, connection, client } = await verbClient(opts);
  try {
    const handles: Array<{ id: string; label: string }> = [];
    const sessionQuery = `WorkflowType = "agentSessionWorkflow" AND ExecutionStatus = "Running" AND AgentTempoEnsemble = "${opts.ensemble}"`;
    for await (const wf of client.workflow.list({ query: sessionQuery })) {
      handles.push({ id: wf.workflowId, label: 'session' });
    }
    const probe = async (id: string, label: string): Promise<{ id: string; label: string } | null> => {
      try {
        const desc = await client.workflow.getHandle(id).describe();
        return desc.status.name === 'RUNNING' ? { id, label } : null;
      } catch { return null; }
    };
    const sidecars = await Promise.all([
      probe(schedulerWorkflowId(opts.ensemble), 'scheduler'),
      probe(maestroWorkflowId(opts.ensemble), 'maestro'),
    ]);
    for (const s of sidecars) if (s) handles.push(s);

    if (handles.length === 0) {
      out.log(`No active workflows in ensemble "${opts.ensemble}".`);
      return;
    }

    if (!opts.yes) {
      out.heading(`Destroy ensemble "${opts.ensemble}"`);
      for (const h of handles) {
        out.log(`  ${out.dim('-')} ${h.label}: ${h.id}`);
      }
      console.log();
      const confirmed = await typedConfirmPrompt(
        `  This terminates ${handles.length} workflow${handles.length !== 1 ? 's' : ''} and cannot be undone.`,
        'destroy',
      );
      if (!confirmed) {
        out.log('Aborted.');
        process.exit(0);
      }
    }

    const results = await Promise.all(handles.map(async (h) => {
      try {
        await client.workflow.getHandle(h.id).terminate(`agent-tempo destroy ${opts.ensemble}`);
        return true;
      } catch { return false; }
    }));
    const terminated = results.filter(Boolean).length;
    out.success(`Terminated ${terminated} workflow${terminated !== 1 ? 's' : ''} in "${opts.ensemble}".`);
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

// --- Hosts commands (#274) ---

export interface HostsCliOpts extends CliOverrides {
  ensemble?: string;
  /** Include stale hosts (those not seen in the last minute). CLI default: false. */
  all?: boolean;
  /** Emit raw `HostInfo[]` JSON instead of the formatted table. */
  json?: boolean;
}

export async function hosts(opts: HostsCliOpts) {
  const { config, connection, client } = await verbClient(opts);
  try {
    const { listHosts } = await import('../utils/hosts');
    const { formatHostList } = await import('../utils/format-hosts');
    const list = await listHosts(client, {
      force: true, // CLI always bypasses the cache — freshness expectation is "right now".
      namespace: config.temporalNamespace,
      taskQueue: config.taskQueue,
    });
    if (opts.json) {
      process.stdout.write(JSON.stringify(list, null, 2) + '\n');
    } else {
      out.log(formatHostList(list, { includeStale: opts.all }));
    }
  } catch (err: any) {
    out.error(err?.message || String(err));
    process.exit(1);
  } finally {
    await connection.close();
  }
}

export interface RefreshHostProfileCliOpts extends CliOverrides {
  ensemble?: string;
  /** Max wait for the new profile to appear in the maestro `hostProfiles` map. Default 10s. */
  confirmTimeoutMs?: number;
}

/**
 * #274 AC5d (M12) — manual re-signal of this host's profile to the
 * global maestro. The daemon otherwise only re-signals on boot; this
 * subcommand re-computes the profile + signals fresh.
 *
 * Exit semantics (per my implementation-time call to the conductor,
 * approved): await ensureGlobalMaestro → signal → short poll on
 * `hostProfiles()` to confirm the new version is visible → exit 0.
 * Exits nonzero if the poll timeout elapses without confirmation.
 */
export async function refreshHostProfile(opts: RefreshHostProfileCliOpts) {
  const { config, connection, client } = await verbClient(opts);
  try {
    const { computeHostProfile, scrubHostProfile, advertiseHostProfile } = await import('../daemon');
    const { GLOBAL_MAESTRO_WORKFLOW_ID } = await import('../config');
    const profile = scrubHostProfile(computeHostProfile(config));
    const result = await advertiseHostProfile(client, profile, { log: (...a) => out.log(a.map(String).join(' ')) });
    if (!result.ok) {
      out.error(`hostProfile signal failed after ${result.attempts} attempts. Global Maestro may be unreachable.`);
      process.exit(1);
    }
    // Short confirmation poll — give the workflow a moment to apply the
    // signal and respond to the query with the fresh version. If the
    // maestro is absent entirely, the query will throw and we exit 1.
    const deadline = Date.now() + (opts.confirmTimeoutMs ?? 10_000);
    const target = profile.version;
    const handle = client.workflow.getHandle(GLOBAL_MAESTRO_WORKFLOW_ID);
    while (Date.now() < deadline) {
      try {
        const profiles = (await handle.query('hostProfiles')) as Record<string, { version?: string }>;
        const live = profiles[profile.hostname];
        if (live && live.version === target) {
          out.success(`Host profile for "${profile.hostname}" refreshed (version ${target}).`);
          return;
        }
      } catch {
        // retry until deadline
      }
      await new Promise((r) => setTimeout(r, 500));
    }
    out.error(`Signal sent but not yet reflected in hostProfiles() query after ${opts.confirmTimeoutMs ?? 10_000}ms. May succeed shortly; re-run to confirm.`);
    process.exit(1);
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

// --- Restore command (#288 clean break: ensemble-scoped, no picker flags) ---

interface RestoreCliOpts extends CliOverrides {
  /** Required for the default local-restore flow; ignored when `allHosts` is set. */
  ensemble?: string;
  /**
   * #151: cluster-view listing mode. Lists cross-host orphans the local
   * daemon's `agent-tempo restore <ensemble>` would otherwise skip
   * silently. Read-only: never enqueues a `restart`. Recovery still
   * happens through the remote daemon's `reconcileOnBoot` when it
   * returns, or a deliberate TUI `/migrate <player> <host> --force`.
   */
  allHosts?: boolean;
}

/**
 * `agent-tempo restore <ensemble>` — delegate to {@link TempoClient.restore},
 * which reattaches orphans AND unpauses maestro + scheduler (#298 — the
 * direct-to-`restoreOrphansOnce` path left the ensemble paused after a
 * `shutdown → restore` roundtrip). The TUI home view (#290) is the picker
 * surface; the CLI is the scriptable bulk operation, one ensemble at a time.
 *
 * `--all-hosts` (#151): switches to cluster-view readonly listing — the
 * positional `<ensemble>` becomes optional (when set, narrows the listing;
 * when omitted, lists across every ensemble). Never enqueues a restart.
 * See `formatCrossHostOrphans` for the output shape.
 */
export async function restore(opts: RestoreCliOpts) {
  if (opts.allHosts) {
    await restoreAllHosts(opts);
    return;
  }
  if (!opts.ensemble) {
    out.error('Usage: agent-tempo restore <ensemble>   (or --all-hosts for cluster-view)');
    process.exit(1);
  }

  const { connection, client } = await verbClient(opts);
  try {
    const { formatRestoreOutcome } = await import('../reconcile/orphans');
    const tempo = createTempoClient(client);
    const summary = await tempo.restore(opts.ensemble);

    if (summary.details.length === 0) {
      out.log(`No orphans in ensemble "${opts.ensemble}" on this host.`);
      return;
    }

    out.heading(`Restored orphans in "${opts.ensemble}"`);
    for (const d of summary.details) {
      const text = `${d.playerId} — ${formatRestoreOutcome(d.outcome)}`;
      switch (d.outcome.kind) {
        case 'queued': out.success(text); break;
        case 'failed': out.warn(text); break;
        case 'skipped': out.log(`  ${out.dim(text)}`); break;
      }
    }
    out.log(`\n${summary.reattached} reattached, ${summary.skipped} skipped, ${summary.failed} failed.`);
  } catch (err: any) {
    out.error(err?.message || String(err));
    process.exit(1);
  } finally {
    await connection.close();
  }
}

/**
 * #151 — `agent-tempo restore --all-hosts` implementation.
 *
 * Read-only cluster-view: enumerates every orphan in the namespace (not
 * just local) and groups by `preferredHost`. Each group is annotated with
 * a liveness label (`[live]` / `[stale]` / `[missing]`) derived from
 * `listHosts()`, and each orphan line includes the TUI `/migrate`
 * command the operator would run to deliberately steal the session to
 * the local host.
 *
 * Never enqueues a restart. The architect's spec (#151 refined Option D)
 * is explicit: recovery happens reflexively when the remote daemon comes
 * back (its own `reconcileOnBoot` picks up matching orphans), or by
 * deliberate operator action via `/migrate`. A timer-based reclaim is
 * disallowed (PR-F §3 Site 3) — a clock cannot distinguish "host
 * decommissioned" from "weekend offline."
 *
 * Output format mirrors the existing `hosts` formatter's section style
 * (per-host groupings, dimmed annotations). Liveness label semantics:
 *
 *   [live]    — host's daemon is polling now (`HOST_FRESHNESS_THRESHOLD_MS`,
 *               60s). Recovery is imminent on its next reconcile tick.
 *   [stale]   — host has a profile but no poller seen in the last minute.
 *               Probably down; manual `/migrate` if recovery can't wait.
 *   [missing] — host has no registered profile (never came back since boot,
 *               or the maestro restarted and the profile expired). Almost
 *               certainly safe to steal.
 */
async function restoreAllHosts(opts: RestoreCliOpts): Promise<void> {
  const { connection, client } = await verbClient(opts);
  try {
    const localHost = hostname();
    const { restoreOrphansOnce } = await import('../reconcile/orphans');
    const { listHosts } = await import('../utils/hosts');
    const { formatCrossHostOrphans } = await import('../utils/restore-format');

    // Run the cluster-view query and the host enumeration concurrently —
    // the join is cheap and both calls take 50-200ms apiece against a
    // healthy Temporal.
    const [summary, hosts] = await Promise.all([
      restoreOrphansOnce(client, {
        hostname: localHost,
        invokerPlayerId: 'cli',
        policy: 'auto',
        mode: 'all-hosts-readonly',
        ...(opts.ensemble ? { ensemble: opts.ensemble } : {}),
      }),
      listHosts(client, { force: true }),
    ]);

    const output = formatCrossHostOrphans(summary.details, hosts, {
      localHost,
      ...(opts.ensemble ? { ensemble: opts.ensemble } : {}),
    });
    out.log(output);
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
        out.log('No saved ensembles. Use `agent-tempo ensemble save [name]` to save one.');
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
        out.error('Usage: agent-tempo ensemble show <name>');
        process.exit(1);
      }
      const content = readSavedLineup(opts.name);
      if (!content) {
        out.error(`No saved ensemble named "${opts.name}"`);
        out.log(`  Run ${out.dim('agent-tempo ensemble list')} to see available ensembles.`);
        process.exit(1);
      }
      console.log(content);
      break;
    }
    default:
      out.error('Usage: agent-tempo ensemble <save|list|show> [name]');
      out.log(`\n  ${out.dim('agent-tempo ensemble save [name]')}   Save current ensemble state`);
      out.log(`  ${out.dim('agent-tempo ensemble list')}          List saved ensembles`);
      out.log(`  ${out.dim('agent-tempo ensemble show <name>')}   Display a saved lineup`);
      process.exit(1);
  }
}

// --- Daemon command moved to src/cli/daemon-command.ts (#157) ---
// The daemon CLI surface lives in its own module with zero Temporal/workflow
// imports so that `daemon stop` / `daemon status` remain operable when the
// Temporal SDK itself is broken (e.g. a native-dep build failure on an
// unsupported Node version). `src/cli.ts` routes `agent-tempo daemon ...`
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

  const query = `WorkflowType = "agentSessionWorkflow" AND ExecutionStatus = "Running" AND AgentTempoEnsemble = "${opts.ensemble.replace(/["\\\n\r]/g, '')}"`;
  let released = 0;

  for await (const wf of client.workflow.list({ query })) {
    try {
      const handle = client.workflow.getHandle(wf.workflowId);
      const locked = await handle.query(outboxLockedQuery);
      if (locked) {
        await handle.signal(releaseHeldSignal);
        released++;
        const sa = wf.searchAttributes || {};
        const playerId = Array.isArray(sa.AgentTempoPlayerId) ? String(sa.AgentTempoPlayerId[0]) : wf.workflowId;
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

/**
 * Fan out the paused/unpaused state to every component of an ensemble —
 * maestro hub, scheduler, and each session. Shared by the TUI `/pause` +
 * `/play` surface and by the internal initial-startup hold in
 * {@link applyLineupPlayersAndSchedules}.
 */
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
  const query = `WorkflowType = "agentSessionWorkflow" AND ExecutionStatus = "Running" AND AgentTempoEnsemble = "${sanitized}"`;
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
