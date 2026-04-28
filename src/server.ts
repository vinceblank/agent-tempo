#!/usr/bin/env node
import * as crypto from 'crypto';
import * as os from 'os';
import * as path from 'path';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { Client, WorkflowIdConflictPolicy } from '@temporalio/client';
import { getConfig, conductorWorkflowId, maestroWorkflowId, ENV } from './config';
// eslint-disable-next-line @typescript-eslint/no-var-requires
const { version: PKG_VERSION } = require('../package.json');
import { createTemporalConnection } from './connection';
import { isDaemonRunning, startDaemon } from './cli/daemon';
import { SessionInput } from './types';
import { getGitInfo } from './git-info';
import { registerEnsembleTool } from './tools/ensemble';
import { registerCueTool } from './tools/cue';
import { registerSetPartTool } from './tools/set-part';
import { registerListenTool } from './tools/listen';
import { registerRecruitTool } from './tools/recruit';
import { registerReportTool } from './tools/report';
import { registerSetNameTool } from './tools/set-name';
import { registerScheduleTool } from './tools/schedule';
import { registerUnscheduleTool } from './tools/unschedule';
import { registerSchedulesTool } from './tools/schedules';
import { registerSaveLineupTool } from './tools/save-lineup';
import { registerLoadLineupTool } from './tools/load-lineup';
import { registerAgentTypesTool } from './tools/agent-types';
import { registerWhoAmITool } from './tools/who-am-i';
import { registerBroadcastTool } from './tools/broadcast';
import { registerRecallTool } from './tools/recall';
import { registerReleaseTool } from './tools/release';
import { registerPauseTool } from './tools/pause';
import { registerPlayTool } from './tools/play';
import { registerShutdownTool } from './tools/shutdown';
import { registerRestoreTool } from './tools/restore';
import { registerQualityGateTool } from './tools/quality-gate';
import { registerEvaluateGateTool } from './tools/evaluate-gate';
import { registerGatesTool } from './tools/gates';
import { registerWorktreeTool } from './tools/worktree';
import { registerStageTool } from './tools/stage';
import { registerStagesTool } from './tools/stages';
import { registerCancelStageTool } from './tools/cancel-stage';
import { registerRestartTool } from './tools/restart';
import { registerDestroyTool } from './tools/destroy';
import { registerMigrateTool } from './tools/migrate';
import { registerAttachmentInfoTool } from './tools/attachment-info';
import { registerHostsTool } from './tools/hosts';
import { registerSetEnsembleDescriptionTool } from './tools/set-ensemble-description';
import { registry, InteractiveAttachment } from './adapters';
import { resolveAgentType } from './ensemble/agent-types';

const log = (...args: unknown[]) => console.error('[claude-tempo]', ...args);

async function main() {
  // Only activate when explicitly opted in via CLAUDE_TEMPO_ENSEMBLE
  if (!process.env[ENV.ENSEMBLE]) {
    log(`${ENV.ENSEMBLE} not set — MCP server idle (no workflow started)`);
    // Keep the process alive so Claude Code doesn't see a crash, but do nothing
    const transport = new StdioServerTransport();
    const idleServer = new McpServer({ name: 'claude-tempo', version: PKG_VERSION });
    await idleServer.connect(transport);
    return;
  }

  const config = getConfig();
  const isConductor = process.env[ENV.CONDUCTOR] === 'true';
  const requestedName = process.env[ENV.PLAYER_NAME] || '';
  // Conductors use their requested name or fall back to 'conductor'.
  // Non-conductors are prevented from using "conductor" as a name,
  // which would collide with the conductor's deterministic workflow ID.
  let playerId = isConductor
    ? (requestedName || 'conductor')
    : (requestedName && requestedName !== 'conductor' ? requestedName : '') || crypto.randomBytes(4).toString('hex');
  const getPlayerId = () => playerId;
  const setPlayerId = (id: string) => { playerId = id; };
  const workDir = process.cwd();
  const { gitRoot, gitBranch } = getGitInfo(workDir);

  log(`Starting ${isConductor ? 'conductor' : `peer ${playerId}`} in ${workDir}`);

  // Connect Temporal client — friendly error messages for common failures
  let connection: Awaited<ReturnType<typeof createTemporalConnection>>;
  try {
    connection = await createTemporalConnection(config);
  } catch (err: any) {
    const code = err?.code || '';
    const msg = err?.message || String(err);
    if (code === 'ECONNREFUSED' || msg.includes('ECONNREFUSED')) {
      log(`Cannot connect to Temporal at ${config.temporalAddress} — is the server running?`);
      log('  Start it with: temporal server start-dev');
    } else if (msg.includes('ENOENT') || msg.includes('no such file')) {
      log(`TLS certificate/key file not found: ${msg}`);
      log('  Check TEMPORAL_TLS_CERT_PATH and TEMPORAL_TLS_KEY_PATH');
    } else {
      log(`Failed to connect to Temporal: ${msg}`);
    }
    process.exit(1);
  }
  const client = new Client({
    connection,
    namespace: config.temporalNamespace,
  });

  // Ensure the worker daemon is running (starts it if needed).
  // Sessions no longer run in-process workers — the daemon handles all task processing.
  if (!isDaemonRunning()) {
    log('Worker daemon not running — starting it...');
    try {
      const daemonPid = await startDaemon(config);
      log(`Worker daemon started (pid ${daemonPid})`);
    } catch (err: any) {
      log(`Failed to start worker daemon: ${err?.message || err}`);
      log('Start it manually with: claude-tempo daemon start');
      process.exit(1);
    }
  } else {
    log('Worker daemon already running');
  }

  // Start the session workflow
  const workflowId = isConductor
    ? conductorWorkflowId(config.ensemble)
    : `claude-session-${config.ensemble}-${playerId}`;

  const isBridgeMode = process.env[ENV.BRIDGE_MODE] === '1';
  // PR-B (v0.25 step 2/7): resolve the adapter descriptor through the registry.
  // `isBridgeMode` is the legacy signal — set by the Copilot bridge when it spawns
  // this MCP server as a child. PR-C will replace this with the attachment wire
  // protocol. Until then, the registry lookup is purely informational on the
  // server-side and the real dispatch is still driven by isBridgeMode.
  const adapterId = isBridgeMode ? 'copilot' : 'claude-code';
  const adapterDescriptor = registry.get(adapterId);
  const sessionInput: SessionInput = {
    metadata: {
      playerId,
      ensemble: config.ensemble,
      hostname: os.hostname(),
      workDir,
      gitRoot,
      gitBranch,
      isConductor,
      agentType: isBridgeMode ? 'copilot' : 'claude',
      adapterId,
    },
    autoSummary: `Session in ${path.basename(workDir)}`,
    temporalConfig: {
      temporalAddress: config.temporalAddress,
      temporalNamespace: config.temporalNamespace,
      taskQueue: config.taskQueue,
    },
  };

  const startedHandle = await client.workflow.start('claudeSessionWorkflow', {
    workflowId,
    taskQueue: config.taskQueue,
    args: [sessionInput],
    workflowIdConflictPolicy: WorkflowIdConflictPolicy.USE_EXISTING,
    // No execution timeout — workflows live until terminated status or stale detection.
    searchAttributes: {
      ...(gitRoot ? { ClaudeTempoGitRoot: [gitRoot] } : {}),
      ClaudeTempoHostname: [os.hostname()],
      ClaudeTempoEnsemble: [config.ensemble],
      ClaudeTempoPlayerId: [playerId],
    },
  });
  log(`Workflow ${workflowId} started (or reconnected)`);

  // #347 — every tool that calls `executeUpdate` / `signal` / `query` on
  // the session's own workflow MUST use an UNPINNED handle (no
  // `firstExecutionRunId` field). The handle returned by
  // `client.workflow.start()` carries `firstExecutionRunId` set to the
  // run that was current when start() resolved; once the workflow does
  // any `continueAsNew`, that run is no longer the FIRST of the chain
  // and Temporal rejects update RPCs with `WorkflowNotFoundError`. The
  // architect's outbox went silent because every force-restart reset
  // the handle to a fresh-but-soon-stale `firstExecutionRunId`. Using
  // `client.workflow.getHandle(workflowId)` (no runId) omits chain
  // validation entirely and routes every operation to the latest open
  // run regardless of CAN history. See
  // `test/session-can-handle-staleness.test.ts` for the structural
  // proof + stale-firstExecutionRunId reproducer.
  const handle = client.workflow.getHandle(workflowId);

  // Watch for workflow completion — exit the process when the workflow ends
  // (e.g., via stop tool setting status to 'terminated'). Use the
  // started handle (`runIdForResult` = the started run's id) so
  // `result()` follows the CAN chain via `followRuns: true` and resolves
  // when the entire chain ends, not on a single CAN boundary.
  // Note: daemon is NOT stopped here — it serves all sessions, not just this one.
  startedHandle.result().then(() => {
    log('Workflow completed — shutting down');
    stopPoller();
    process.exit(0);
  }).catch((err) => {
    // Only exit on workflow-level errors (cancelled, failed), not transient connection errors
    const name = err?.name || '';
    if (name.includes('WorkflowFailed') || name.includes('WorkflowCancelled') || name.includes('WorkflowNotFound')) {
      log('Workflow ended unexpectedly — shutting down');
      stopPoller();
      process.exit(1);
    } else {
      log('Transient error watching workflow result:', err?.message || err);
    }
  });

  // Resolve player type identity from env (set by recruiter's spawnProcess)
  const playerType = process.env[ENV.PLAYER_TYPE] || undefined;
  let playerTypeDescription: string | undefined;
  if (playerType) {
    try {
      const info = resolveAgentType(playerType);
      playerTypeDescription = info?.description;
    } catch {
      // Resolution failure is non-fatal — type is still set
    }
  }

  // If the workflow was pre-created by a recruiter, update it with real metadata
  // now that it's connected. Attachment phase (not the removed `status` field)
  // is driven by the V2 wire surface — see claimAttachment / adapterExited.
  await handle.signal('updateMetadata', {
    hostname: os.hostname(),
    gitRoot,
    gitBranch,
    enableStaleDetection: true,
    ...(playerType ? { playerType } : {}),
    ...(playerTypeDescription ? { playerTypeDescription } : {}),
  });

  // If there's a conductor running, announce ourselves
  if (!isConductor) {
    try {
      const conductorHandle = client.workflow.getHandle(conductorWorkflowId(config.ensemble));
      await conductorHandle.signal('receiveMessage', {
        from: playerId,
        text: `Player ${playerId} joined from ${workDir}`,
        responseRequested: false,
      });
    } catch {
      // No conductor running — that's fine
    }
  }

  // If ensemble is paused, inherit the paused state
  try {
    const maestroHandle = client.workflow.getHandle(maestroWorkflowId(config.ensemble));
    const isPaused = await maestroHandle.query('maestroPaused') as boolean;
    if (isPaused) {
      await handle.signal('setPaused', true);
      log('Ensemble is paused — session started in paused state');
    }
  } catch {
    // Maestro may not be running — that's fine
  }

  // Create MCP server
  const hasRequestedName = isConductor || Boolean(requestedName && requestedName !== 'conductor');
  const playerTypeLine = playerType
    ? `Your player type is "${playerType}"${playerTypeDescription ? ` (${playerTypeDescription})` : ''}. `
    : '';
  const serverInstructions = `You are part of the "${config.ensemble}" ensemble of Claude Code sessions coordinated via Temporal. ` +
    `Your player name is "${playerId}". ` +
    playerTypeLine +
    (hasRequestedName
      ? `This name was assigned at startup — do NOT call \`set_name\` unless explicitly asked to rename. `
      : `IMPORTANT: If you receive a message instructing you to call \`set_name\`, do so immediately before anything else. Use \`set_name\` to give yourself a human-readable name. `) +
    `When you receive a message from another session, treat it like a coworker asking for help — respond promptly, then resume your work. ` +
    `Use \`ensemble\` to see who else is active. ` +
    `Use \`cue\` to reply directly to the player who messaged you, or to ask others for help. ` +
    `Use \`recruit\` if you need a session in a directory where none exists. ` +
    `Use \`report\` to notify the conductor of task completion, blockers, or questions — always report when you finish a recruited task.` +
    (isConductor
      ? `\n\nOperational rules:\n` +
        `- Before assigning parallel work on different branches, provision git worktrees via the \`worktree\` tool so each player has an isolated checkout.\n` +
        `- No player should switch branches without your approval — if a player needs a different branch, provision a worktree for them.\n` +
        `- Before shipping, verify the branch diff scope matches the assigned task (no unrelated changes).`
      : `\n\nDo not switch git branches without the conductor's approval. If no conductor exists, broadcast your intent to the ensemble first. Prefer using the \`worktree\` tool for branch isolation.`);

  const mcpServer = new McpServer({
    name: 'claude-tempo',
    version: PKG_VERSION,
  }, {
    capabilities: {
      experimental: { 'claude/channel': {} },
    },
    instructions: serverInstructions,
  });

  // Register tools
  registerEnsembleTool(mcpServer, client, config, getPlayerId, workflowId);
  registerCueTool(mcpServer, client, config, getPlayerId, handle);
  registerSetPartTool(mcpServer, handle);
  registerSetNameTool(mcpServer, client, config, handle, getPlayerId, setPlayerId);
  registerListenTool(mcpServer, handle);
  registerRecruitTool(mcpServer, client, config, getPlayerId, handle, isBridgeMode ? 'copilot' : 'claude');
  registerReportTool(mcpServer, handle);
  registerScheduleTool(mcpServer, client, config, getPlayerId);
  registerUnscheduleTool(mcpServer, client, config);
  registerSchedulesTool(mcpServer, client, config);
  registerSaveLineupTool(mcpServer, client, config, getPlayerId, isConductor);
  registerLoadLineupTool(mcpServer, client, config, getPlayerId, isBridgeMode ? 'copilot' : 'claude', handle, setPlayerId, isConductor);
  registerAgentTypesTool(mcpServer);
  registerWhoAmITool(mcpServer, handle, getPlayerId);
  registerBroadcastTool(mcpServer, client, config, getPlayerId, handle);
  registerRecallTool(mcpServer, handle, getPlayerId);
  registerReleaseTool(mcpServer, client, config, getPlayerId, handle);
  registerPauseTool(mcpServer, client, config, getPlayerId);
  registerPlayTool(mcpServer, client, config, getPlayerId);
  registerShutdownTool(mcpServer, client, config, getPlayerId);
  registerRestoreTool(mcpServer, client, config, getPlayerId);
  // PR-D new verbs — enqueue outbox entries on the caller's workflow; the
  // session dispatch loop runs the `deliverDestroy` / `deliverRestart`
  // activities against the target. `detach` is no longer on the public MCP
  // surface (#287); `shutdown` owns ensemble-scope detach.
  registerRestartTool(mcpServer, client, config, getPlayerId, handle);
  registerDestroyTool(mcpServer, client, config, getPlayerId, handle);
  registerMigrateTool(mcpServer, client, config, getPlayerId, handle);
  registerAttachmentInfoTool(mcpServer, client, config);
  registerHostsTool(mcpServer, client, config);
  registerSetEnsembleDescriptionTool(mcpServer, client, config);

  // Conductor-only tools
  if (isConductor) {
    registerQualityGateTool(mcpServer, handle, getPlayerId);
    registerEvaluateGateTool(mcpServer, handle, getPlayerId);
    registerGatesTool(mcpServer, handle);
    registerWorktreeTool(mcpServer, client, config, handle, getPlayerId);
    registerStageTool(mcpServer, handle, getPlayerId);
    registerStagesTool(mcpServer, handle);
    registerCancelStageTool(mcpServer, handle);
  }

  const MAESTRO_ACK = '\n\n[IMPORTANT: This message is from a human (Maestro). Immediately cue the sender back with a brief acknowledgment and your planned next step before doing the work.]';

  // Start message poller — push messages into Claude Code via channel notifications.
  // SDK-class adapters (e.g. Copilot bridge) run their own delivery loop in the
  // bridge subprocess; this MCP server is just the tool surface for that bridge,
  // and must NOT also poll (would race on markDelivered, and SDK adapters don't
  // understand notifications/claude/channel).
  //
  // Dispatch by adapterClass from the registry (PR-B). Pass client + host so
  // the adapter can claim the attachment — `InteractiveAttachment` runs the
  // V2 attachment-lease lifecycle for the attachment's lifetime. PR-H (#132)
  // removed the `CLAUDE_TEMPO_LIFECYCLE_V2=0` legacy-shim branch; V2 is the
  // only path.
  const stopPoller = adapterDescriptor.adapterClass === 'sdk'
    ? () => {} // no-op — SDK adapters handle delivery in their own subprocess
    : new InteractiveAttachment({ client, host: os.hostname() }).start(handle, async (messages) => {
    for (const msg of messages) {
      log(`Message from ${msg.from}: ${msg.text}`);
      const content = msg.isMaestro ? msg.text + MAESTRO_ACK : msg.text;
      try {
        await mcpServer.server.notification({
          method: 'notifications/claude/channel',
          params: {
            content,
            meta: {
              from_player: msg.from,
              sent_at: msg.timestamp,
            },
          },
        });
      } catch (err) {
        log('Channel notification error:', err);
      }
    }
  });

  // Connect MCP transport
  const transport = new StdioServerTransport();
  await mcpServer.connect(transport);
  log('MCP server connected');

  // Graceful shutdown (idempotent — safe to call multiple times)
  let shuttingDown = false;
  const shutdown = async () => {
    if (shuttingDown) return;
    shuttingDown = true;
    log('Shutting down...');

    // Hard exit safety net in case graceful shutdown hangs
    const hardExit = setTimeout(() => {
      log('Shutdown timeout — forcing exit');
      process.exit(1);
    }, 20_000);
    hardExit.unref();

    // 1. Stop the message poller — V2 adapter fires `adapterExited` (graceful=true)
    //    from inside `stopV2Lifecycle`, collapsing the workflow `draining → detached`
    //    per §11.1. Closing our terminal should NOT destroy the workflow — the user
    //    can re-attach later via `restart`. PR-C commit 4 retired the former
    //    `updateMetadata({ status: 'terminated' })` signal here (it destroyed the
    //    session on every SIGINT, defeating the phase split). Operator-initiated
    //    destruction now goes through the `destroy` tool / CLI, which uses
    //    `destroyUpdate` directly.
    stopPoller();

    // 2. Close Temporal connection (daemon is left running — it serves all sessions)
    try {
      connection.close();
    } catch {
      // best effort
    }

    process.exit(0);
  };

  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

main().catch((err) => {
  console.error('Fatal error:', err);
  process.exit(1);
});
