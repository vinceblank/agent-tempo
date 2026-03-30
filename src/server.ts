import * as crypto from 'crypto';
import * as os from 'os';
import * as path from 'path';
import { execSync } from 'child_process';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { Client, Connection, WorkflowIdConflictPolicy } from '@temporalio/client';
import { getConfig, conductorWorkflowId } from './config';
import { createWorker } from './worker';
import { SessionInput } from './types';
import { registerEnsembleTool } from './tools/ensemble';
import { registerCueTool } from './tools/cue';
import { registerSetPartTool } from './tools/set-part';
import { registerListenTool } from './tools/listen';
import { registerRecruitTool } from './tools/recruit';
import { registerReportTool } from './tools/report';
import { registerTerminateTool } from './tools/terminate';
import { registerSetNameTool } from './tools/set-name';
import { startMessagePoller } from './channel';

const log = (...args: unknown[]) => console.error('[claude-tempo]', ...args);

function getGitInfo(workDir: string): { gitRoot?: string; gitBranch?: string } {
  try {
    const gitRoot = execSync('git rev-parse --show-toplevel', {
      cwd: workDir,
      encoding: 'utf-8',
      stdio: ['pipe', 'pipe', 'pipe'],
    }).trim();
    let gitBranch: string | undefined;
    try {
      gitBranch = execSync('git rev-parse --abbrev-ref HEAD', {
        cwd: workDir,
        encoding: 'utf-8',
        stdio: ['pipe', 'pipe', 'pipe'],
      }).trim();
    } catch {
      // not on a branch
    }
    return { gitRoot, gitBranch };
  } catch {
    return {};
  }
}

async function main() {
  const config = getConfig();
  const isConductor = process.env.CLAUDE_TEMPO_CONDUCTOR === 'true';
  let playerId = isConductor ? 'conductor' : crypto.randomBytes(4).toString('hex');
  const getPlayerId = () => playerId;
  const setPlayerId = (id: string) => { playerId = id; };
  const workDir = process.cwd();
  const { gitRoot, gitBranch } = getGitInfo(workDir);

  log(`Starting ${isConductor ? 'conductor' : `peer ${playerId}`} in ${workDir}`);

  // Connect Temporal client
  const connection = await Connection.connect({
    address: config.temporalAddress,
  });
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

  const sessionInput: SessionInput = {
    metadata: {
      playerId,
      ensemble: config.ensemble,
      hostname: os.hostname(),
      workDir,
      gitRoot,
      gitBranch,
      isConductor,
    },
    autoSummary: `Session in ${path.basename(workDir)}`,
  };

  const handle = await client.workflow.start('claudeSessionWorkflow', {
    workflowId,
    taskQueue: config.taskQueue,
    args: [sessionInput],
    workflowIdConflictPolicy: WorkflowIdConflictPolicy.USE_EXISTING,
    workflowExecutionTimeout: '24 hours',
    searchAttributes: {
      ...(gitRoot ? { ClaudeTempoGitRoot: [gitRoot] } : {}),
      ClaudeTempoHostname: [os.hostname()],
      ClaudeTempoEnsemble: [config.ensemble],
      ClaudeTempoPlayerId: [playerId],
    },
  });
  log(`Workflow ${workflowId} started (or reconnected)`);

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
  const serverInstructions = `You are part of the "${config.ensemble}" ensemble of Claude Code sessions coordinated via Temporal. ` +
    `Your temporary player ID is "${playerId}". ` +
    `IMPORTANT: If you receive a message instructing you to call \`set_name\`, do so immediately before anything else. ` +
    `When you receive a message from another session, treat it like a coworker asking for help — respond promptly, then resume your work. ` +
    `Use \`set_name\` to give yourself a human-readable name. ` +
    `Use \`ensemble\` to see who else is active. ` +
    `Use \`cue\` to ask others for help. ` +
    `Use \`recruit\` if you need a session in a directory where none exists. ` +
    `Use \`report\` to send significant updates to the conductor.`;

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
  registerRecruitTool(mcpServer, client, config, getPlayerId);
  registerReportTool(mcpServer, client, config, getPlayerId);
  registerTerminateTool(mcpServer, client, config, getPlayerId);

  // Start message poller — push messages into Claude Code via channel notifications
  const stopPoller = startMessagePoller(handle, async (messages) => {
    for (const msg of messages) {
      log(`Message from ${msg.from}: ${msg.text}`);
      try {
        await mcpServer.server.notification({
          method: 'notifications/claude/channel',
          params: {
            content: msg.text,
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
      await handle.signal('shutdown');
    } catch {
      try {
        await handle.cancel();
      } catch {
        // workflow may already be gone
      }
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
