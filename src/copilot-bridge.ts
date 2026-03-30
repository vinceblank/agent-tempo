/**
 * Copilot Bridge — allows GitHub Copilot CLI sessions to participate
 * as players in a claude-tempo ensemble.
 *
 * The bridge:
 * 1. Spawns a Copilot CLI session via the Copilot SDK
 * 2. Configures it with claude-tempo as an MCP server (so it gets all tools)
 * 3. Polls the Temporal workflow for pending messages
 * 4. Injects messages as prompts via the SDK
 *
 * Usage:
 *   npx ts-node src/copilot-bridge.ts
 *
 * Environment variables:
 *   CLAUDE_TEMPO_ENSEMBLE     — ensemble name (default: "default")
 *   COPILOT_BRIDGE_NAME       — player name for set_name (optional)
 *   COPILOT_BRIDGE_MODEL      — model to use (optional)
 *   GITHUB_TOKEN              — GitHub auth token (optional, uses logged-in user by default)
 */

import * as path from 'path';
import { Client, Connection } from '@temporalio/client';
import { getConfig } from './config';
import { Message } from './types';

// Optional dependency — must be installed separately: npm install @github/copilot-sdk
let CopilotClient: any;
let approveAll: any;
try {
  const sdk = require('@github/copilot-sdk');
  CopilotClient = sdk.CopilotClient;
  approveAll = sdk.approveAll;
} catch {
  console.error(
    'Error: @github/copilot-sdk is not installed.\n' +
    'Install it with: npm install @github/copilot-sdk\n' +
    'See the Copilot CLI integration section in the README.',
  );
  process.exit(1);
}

const log = (...args: unknown[]) => console.error('[copilot-bridge]', ...args);

const POLL_INTERVAL_MS = 2000;

async function main() {
  const config = getConfig();
  const playerName = process.env.COPILOT_BRIDGE_NAME;
  const model = process.env.COPILOT_BRIDGE_MODEL;
  const workDir = process.cwd();

  log(`Starting Copilot bridge in ${workDir} (ensemble: ${config.ensemble})`);

  // Connect Temporal client (for polling only — the MCP server child process runs its own worker)
  const connection = await Connection.connect({
    address: config.temporalAddress,
  });
  const client = new Client({
    connection,
    namespace: config.temporalNamespace,
  });

  // Record existing workflows so we can find the new one created by the MCP server
  const existingIds = new Set<string>();
  const listQuery = `WorkflowType = "claudeSessionWorkflow" AND ExecutionStatus = "Running" AND ClaudeTempoEnsemble = "${config.ensemble}"`;
  for await (const wf of client.workflow.list({ query: listQuery })) {
    existingIds.add(wf.workflowId);
  }

  // Build the MCP server command — always use the compiled dist/server.js
  // Run `npm run build` (or `pnpm build`) before using the bridge.
  const serverJsPath = path.resolve(__dirname, '..', 'dist', 'server.js');
  const serverCommand = 'node';
  const serverArgs = [serverJsPath];
  const mcpEnv: Record<string, string> = {
    CLAUDE_TEMPO_ENSEMBLE: config.ensemble,
    TEMPORAL_ADDRESS: config.temporalAddress,
    TEMPORAL_NAMESPACE: config.temporalNamespace,
    CLAUDE_TEMPO_TASK_QUEUE: config.taskQueue,
    // Not a conductor
  };

  // Spawn Copilot SDK client and session
  const copilotClient = new CopilotClient({
    logLevel: 'error',
    env: {
      ...process.env as Record<string, string>,
      ...(process.env.GITHUB_TOKEN ? { GITHUB_TOKEN: process.env.GITHUB_TOKEN } : {}),
    },
  });

  const sessionConfig: Parameters<typeof copilotClient.createSession>[0] = {
    onPermissionRequest: approveAll,
    workingDirectory: workDir,
    mcpServers: {
      'claude-tempo': {
        command: serverCommand,
        args: serverArgs,
        env: mcpEnv,
        tools: ['*'],
      },
    },
    systemMessage: {
      mode: 'append' as const,
      content:
        `You are part of the "${config.ensemble}" ensemble of Claude Code sessions coordinated via Temporal. ` +
        `IMPORTANT: If you receive a message instructing you to call \`set_name\`, do so immediately before anything else. ` +
        `When you receive a message from another session, treat it like a coworker asking for help — respond promptly, then resume your work. ` +
        `Use \`set_name\` to give yourself a human-readable name. ` +
        `Use \`ensemble\` to see who else is active. ` +
        `Use \`cue\` to reply directly to the player who messaged you, or to ask others for help. ` +
        `Use \`recruit\` if you need a session in a directory where none exists. ` +
        `Use \`report\` to notify the conductor of task completion, blockers, or questions — always report when you finish a recruited task.`,
    },
    ...(model ? { model } : {}),
  };

  log('Creating Copilot session...');
  const session = await copilotClient.createSession(sessionConfig);
  log(`Copilot session created: ${session.sessionId}`);

  // Log session events for debugging
  session.on((event: any) => {
    if (event.type === 'assistant.message') {
      log(`[assistant] ${(event as any).data?.content?.substring(0, 200)}`);
    } else if (event.type === 'session.error') {
      log(`[error] ${(event as any).data?.message}`);
    }
  });

  // Wait for the MCP server's workflow to appear in Temporal
  log('Waiting for MCP server workflow to register...');
  let newWorkflowId: string | null = null;
  for (let attempt = 0; attempt < 30; attempt++) {
    await new Promise((r) => setTimeout(r, 1000));
    for await (const wf of client.workflow.list({ query: listQuery })) {
      if (!existingIds.has(wf.workflowId)) {
        newWorkflowId = wf.workflowId;
        break;
      }
    }
    if (newWorkflowId) break;
  }

  if (!newWorkflowId) {
    log('ERROR: MCP server workflow did not register within 30 seconds');
    await session.disconnect();
    await copilotClient.stop();
    process.exit(1);
  }

  log(`Found workflow: ${newWorkflowId}`);
  const handle = client.workflow.getHandle(newWorkflowId);

  // If a name was requested, send the set_name instruction
  if (playerName) {
    log(`Sending set_name instruction for "${playerName}"...`);
    await session.sendAndWait(
      { prompt: `Call set_name("${playerName}") immediately.` },
      30_000,
    );
  }

  // Start message poller — inject messages into the Copilot session
  let polling = true;
  let processing = false;

  const poll = async () => {
    if (!polling || processing) return;
    try {
      const messages: Message[] = await handle.query('pendingMessages');
      if (messages.length === 0) return;

      processing = true;
      const ids = messages.map((m) => m.id);
      await handle.signal('markDelivered', ids);

      // Format messages into a single prompt
      const prompt = messages
        .map((m) => `[Message from ${m.from}]: ${m.text}`)
        .join('\n\n');

      log(`Injecting ${messages.length} message(s) into Copilot session`);
      await session.sendAndWait({ prompt }, 300_000); // 5 min timeout for complex tasks
      processing = false;
    } catch (err) {
      processing = false;
      log('Poll error:', err);
    }
  };

  const interval = setInterval(poll, POLL_INTERVAL_MS);
  log('Message poller started. Bridge is running.');

  // Graceful shutdown
  const shutdown = async () => {
    log('Shutting down...');
    polling = false;
    clearInterval(interval);
    try {
      await handle.signal('shutdown');
    } catch {
      // workflow may already be gone
    }
    try {
      await session.disconnect();
    } catch {
      // session may already be disconnected
    }
    await copilotClient.stop();
    process.exit(0);
  };

  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

main().catch((err) => {
  log('Fatal error:', err);
  process.exit(1);
});
