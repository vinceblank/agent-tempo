#!/usr/bin/env node
import * as crypto from 'crypto';
import * as os from 'os';
import * as path from 'path';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { Client, WorkflowIdConflictPolicy } from '@temporalio/client';
import { getConfig, conductorWorkflowId, ENV } from './config';
import { createTemporalConnection } from './connection';
import { createWorker } from './worker';
import { SessionInput } from './types';
import { getGitInfo } from './git-info';
import { registerEnsembleTool } from './tools/ensemble';
import { registerCueTool } from './tools/cue';
import { registerSetPartTool } from './tools/set-part';
import { registerListenTool } from './tools/listen';
import { registerRecruitTool } from './tools/recruit';
import { registerReportTool } from './tools/report';
import { registerStopTool } from './tools/stop';
import { registerSetNameTool } from './tools/set-name';
import { registerScheduleTool } from './tools/schedule';
import { registerUnscheduleTool } from './tools/unschedule';
import { registerSchedulesTool } from './tools/schedules';
import { registerSaveEnsembleTool } from './tools/save-ensemble';
import { registerLoadEnsembleTool } from './tools/load-ensemble';
import { startMessagePoller } from './channel';

const log = (...args: unknown[]) => console.error('[claude-tempo]', ...args);

async function main() {
  // Only activate when explicitly opted in via CLAUDE_TEMPO_ENSEMBLE
  if (!process.env[ENV.ENSEMBLE]) {
    log(`${ENV.ENSEMBLE} not set — MCP server idle (no workflow started)`);
    // Keep the process alive so Claude Code doesn't see a crash, but do nothing
    const transport = new StdioServerTransport();
    const idleServer = new McpServer({ name: 'claude-tempo', version: '0.1.0' });
    await idleServer.connect(transport);
    return;
  }

  const config = getConfig();
  const isConductor = process.env[ENV.CONDUCTOR] === 'true';
  const requestedName = process.env[ENV.PLAYER_NAME] || '';
  // Prevent non-conductor sessions from using "conductor" as a name,
  // which would collide with the conductor's deterministic workflow ID.
  let playerId = isConductor
    ? 'conductor'
    : (requestedName && requestedName !== 'conductor' ? requestedName : '') || crypto.randomBytes(4).toString('hex');
  const getPlayerId = () => playerId;
  const setPlayerId = (id: string) => { playerId = id; };
  const workDir = process.cwd();
  const { gitRoot, gitBranch } = getGitInfo(workDir);

  log(`Starting ${isConductor ? 'conductor' : `peer ${playerId}`} in ${workDir}`);

  // Connect Temporal client
  const connection = await createTemporalConnection(config);
  const client = new Client({
    connection,
    namespace: config.temporalNamespace,
  });

  // Start the Temporal worker (runs in background)
  const worker = await createWorker(config);
  const workerRunPromise = worker.run();
  workerRunPromise.catch((err) => {
    log('Worker error:', err);
    process.exit(1);
  });

  // Start the session workflow
  const workflowId = isConductor
    ? conductorWorkflowId(config.ensemble)
    : `claude-session-${config.ensemble}-${playerId}`;

  const isBridgeMode = process.env[ENV.BRIDGE_MODE] === '1';
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
    },
    autoSummary: `Session in ${path.basename(workDir)}`,
  };

  const handle = await client.workflow.start('claudeSessionWorkflow', {
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

  // Watch for workflow completion — exit the process when the workflow ends
  // (e.g., via stop tool setting status to 'terminated')
  handle.result().then(() => {
    log('Workflow completed — shutting down');
    stopPoller();
    worker.shutdown();
    workerRunPromise.catch(() => {}).then(() => process.exit(0));
  }).catch((err) => {
    // Only exit on workflow-level errors (cancelled, failed), not transient connection errors
    const name = err?.name || '';
    if (name.includes('WorkflowFailed') || name.includes('WorkflowCancelled') || name.includes('WorkflowNotFound')) {
      log('Workflow ended unexpectedly — shutting down');
      stopPoller();
      worker.shutdown();
      workerRunPromise.catch(() => {}).then(() => process.exit(1));
    } else {
      log('Transient error watching workflow result:', err?.message || err);
    }
  });

  // If the workflow was pre-created by a recruiter, update it with real metadata
  // and mark the session as active now that it's connected.
  await handle.signal('updateMetadata', {
    hostname: os.hostname(),
    gitRoot,
    gitBranch,
    status: 'active',
    enableStaleDetection: true,
  });

  // If there's a conductor running, announce ourselves
  if (!isConductor) {
    try {
      const conductorHandle = client.workflow.getHandle(conductorWorkflowId(config.ensemble));
      await conductorHandle.signal('receiveMessage', {
        from: playerId,
        text: `Player ${playerId} joined from ${workDir}`,
      });
    } catch {
      // No conductor running — that's fine
    }
  }

  // Create MCP server
  const hasRequestedName = Boolean(requestedName && requestedName !== 'conductor');
  const serverInstructions = `You are part of the "${config.ensemble}" ensemble of Claude Code sessions coordinated via Temporal. ` +
    `Your player name is "${playerId}". ` +
    (hasRequestedName
      ? `This name was assigned at startup — do NOT call \`set_name\` unless explicitly asked to rename. `
      : `IMPORTANT: If you receive a message instructing you to call \`set_name\`, do so immediately before anything else. Use \`set_name\` to give yourself a human-readable name. `) +
    `When you receive a message from another session, treat it like a coworker asking for help — respond promptly, then resume your work. ` +
    `Use \`ensemble\` to see who else is active. ` +
    `Use \`cue\` to reply directly to the player who messaged you, or to ask others for help. ` +
    `Use \`recruit\` if you need a session in a directory where none exists. ` +
    `Use \`report\` to notify the conductor of task completion, blockers, or questions — always report when you finish a recruited task.`;

  const mcpServer = new McpServer({
    name: 'claude-tempo',
    version: '0.1.0',
  }, {
    capabilities: {
      experimental: { 'claude/channel': {} },
    },
    instructions: serverInstructions,
  });

  // Register tools
  registerEnsembleTool(mcpServer, client, config, getPlayerId, workflowId);
  registerCueTool(mcpServer, client, config, getPlayerId);
  registerSetPartTool(mcpServer, handle);
  registerSetNameTool(mcpServer, client, config, handle, getPlayerId, setPlayerId);
  registerListenTool(mcpServer, handle);
  registerRecruitTool(mcpServer, client, config, getPlayerId, isBridgeMode ? 'copilot' : 'claude');
  registerReportTool(mcpServer, client, config, getPlayerId);
  registerStopTool(mcpServer, client, config, getPlayerId);
  registerScheduleTool(mcpServer, client, config, getPlayerId);
  registerUnscheduleTool(mcpServer, client, config);
  registerSchedulesTool(mcpServer, client, config);
  registerSaveEnsembleTool(mcpServer, client, config, getPlayerId, isConductor);
  registerLoadEnsembleTool(mcpServer, client, config, getPlayerId, isBridgeMode ? 'copilot' : 'claude');

  const MAESTRO_ACK = '\n\n[IMPORTANT: This message is from a human (Maestro). Immediately cue the sender back with a brief acknowledgment and your planned next step before doing the work.]';

  // Start message poller — push messages into Claude Code via channel notifications.
  // Skip when running under the Copilot bridge: the bridge has its own poller that
  // injects messages via sendAndWait. If both pollers run, this one wins the race and
  // sends messages via notifications/claude/channel — which Copilot doesn't understand.
  const stopPoller = isBridgeMode
    ? () => {} // no-op — bridge handles message delivery
    : startMessagePoller(handle, async (messages) => {
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

  // Graceful shutdown
  const shutdown = async () => {
    log('Shutting down...');
    stopPoller();
    try {
      await handle.signal('updateMetadata', { status: 'terminated', terminatedBy: 'system' });
    } catch {
      // workflow may already be gone
    }
    worker.shutdown();
    await workerRunPromise.catch(() => {});
    process.exit(0);
  };

  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

main().catch((err) => {
  console.error('Fatal error:', err);
  process.exit(1);
});
