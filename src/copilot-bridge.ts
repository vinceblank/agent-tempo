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

import * as fs from 'fs';
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

// Unbuffered logging — fs.writeSync(2, ...) bypasses Node.js stream buffering,
// ensuring log output appears immediately even when stderr is redirected to a file.
const log = (...args: unknown[]) => {
  const msg = `[copilot-bridge] ${args.map(a => typeof a === 'string' ? a : JSON.stringify(a)).join(' ')}\n`;
  fs.writeSync(2, msg);
};

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

  // Record existing workflows so we can find the new one created by the MCP server.
  // For conductors, the workflow ID is deterministic (claude-session-{ensemble}-conductor),
  // so on reconnection the MCP server reuses the same workflow. We need to handle both cases:
  // 1. Fresh start: new workflow ID appears that wasn't in existingIds
  // 2. Reconnection: MCP server attaches to the existing conductor workflow
  const existingIds = new Set<string>();
  const listQuery = `WorkflowType = "claudeSessionWorkflow" AND ExecutionStatus = "Running" AND ClaudeTempoEnsemble = "${config.ensemble}"`;
  for await (const wf of client.workflow.list({ query: listQuery })) {
    existingIds.add(wf.workflowId);
  }

  // If we're a conductor reconnecting, we know the exact workflow ID
  const isConductor = !!process.env.CLAUDE_TEMPO_CONDUCTOR;
  const expectedWorkflowId = isConductor
    ? `claude-session-${config.ensemble}-conductor`
    : null;

  // Build the MCP server command — always use the compiled dist/server.js
  // Run `npm run build` (or `pnpm build`) before using the bridge.
  const serverJsPath = path.resolve(__dirname, '..', 'dist', 'server.js');
  if (!fs.existsSync(serverJsPath)) {
    log(`ERROR: ${serverJsPath} not found. Run 'pnpm build' first.`);
    process.exit(1);
  }
  log(`MCP server path: ${serverJsPath}`);
  const serverCommand = 'node';
  const serverArgs = [serverJsPath];
  const mcpEnv: Record<string, string> = {
    ...process.env as Record<string, string>,
    CLAUDE_TEMPO_ENSEMBLE: config.ensemble,
    TEMPORAL_ADDRESS: config.temporalAddress,
    TEMPORAL_NAMESPACE: config.temporalNamespace,
    CLAUDE_TEMPO_TASK_QUEUE: config.taskQueue,
    CLAUDE_TEMPO_CONDUCTOR: process.env.CLAUDE_TEMPO_CONDUCTOR || '',
  };

  // Spawn Copilot SDK client and session
  const copilotClient = new CopilotClient({
    logLevel: 'debug',
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

  // Track session health
  let sessionAlive = true;
  let lastEventTime = Date.now();
  let lastEventType = 'session.created';

  // Log session events for debugging (unbuffered so we always see them)
  session.on((event: any) => {
    lastEventTime = Date.now();
    lastEventType = event.type;
    // Log tool calls and completions fully, truncate verbose events
    if (event.type === 'tool.execution_start' || event.type === 'tool.execution_complete') {
      log(`[event:${event.type}]`, JSON.stringify(event.data ?? event).substring(0, 800));
    } else if (event.type === 'assistant.message') {
      const data = event.data ?? event;
      const tools = data.toolRequests?.map((t: any) => t.name).join(', ') || 'none';
      log(`[event:${event.type}] content="${(data.content || '').substring(0, 200)}" tools=[${tools}]`);
    } else if (event.type === 'session.idle') {
      log(`[event:session.idle] Session is idle`);
    } else if (event.type?.includes('error') || event.type?.includes('disconnect')) {
      log(`[event:${event.type}]`, JSON.stringify(event.data ?? event).substring(0, 500));
      sessionAlive = false;
    } else {
      log(`[event:${event.type}]`);
    }
  });

  // Send an initial prompt to trigger MCP server initialization.
  // The Copilot SDK doesn't start MCP server subprocesses until the session
  // processes a message that could use tools. We await this so the workflow
  // registers before we try to find it, and so subsequent sendAndWait calls
  // don't collide with this one.
  log('Sending initial prompt to trigger MCP server startup...');
  try {
    const t0 = Date.now();
    const initResult = await session.sendAndWait(
      { prompt: 'Call the ensemble tool to list active sessions. Respond in one short sentence.' },
      120_000,
    );
    log(`Initial prompt completed in ${Date.now() - t0}ms, result:`, JSON.stringify(initResult)?.substring(0, 300));
  } catch (err: any) {
    log(`Initial prompt error after ${Date.now()}ms:`, err?.message, err?.stack?.substring(0, 300));
  }

  // Wait for the MCP server's workflow to appear in Temporal
  log('Waiting for MCP server workflow to register...');
  log(`List query: ${listQuery}`);
  log(`Existing workflow IDs: ${[...existingIds].join(', ') || '(none)'}`);
  if (expectedWorkflowId) {
    log(`Conductor mode: will accept existing workflow ${expectedWorkflowId}`);
  }

  let newWorkflowId: string | null = null;

  // Fast path: if we're a conductor reconnecting and the workflow already exists, use it directly
  if (expectedWorkflowId && existingIds.has(expectedWorkflowId)) {
    log(`Reconnecting to existing conductor workflow: ${expectedWorkflowId}`);
    newWorkflowId = expectedWorkflowId;
  }

  // Otherwise, wait for a new workflow to appear
  if (!newWorkflowId) {
    for (let attempt = 0; attempt < 30; attempt++) {
      await new Promise((r) => setTimeout(r, 1000));
      const found: string[] = [];
      for await (const wf of client.workflow.list({ query: listQuery })) {
        found.push(wf.workflowId);
        if (!existingIds.has(wf.workflowId)) {
          newWorkflowId = wf.workflowId;
          break;
        }
      }
      if (newWorkflowId) break;
      if (attempt % 5 === 4) log(`Still waiting... attempt ${attempt + 1}/30, found workflows: [${found.join(', ')}]`);
    }
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
    const t0 = Date.now();
    await session.sendAndWait(
      { prompt: `Call set_name("${playerName}") immediately. Respond in one short sentence.` },
      120_000,
    );
    log(`set_name completed in ${Date.now() - t0}ms`);
  }

  // Start message poller — inject messages into the Copilot session
  let polling = true;
  let processing = false;
  let pollCount = 0;

  const poll = async () => {
    if (!polling || processing) return;
    pollCount++;

    // Periodic health check
    if (pollCount % 30 === 0) { // every ~60 seconds
      const silenceSec = ((Date.now() - lastEventTime) / 1000).toFixed(0);
      log(`[health] poll #${pollCount}, sessionAlive=${sessionAlive}, lastEvent=${lastEventType} ${silenceSec}s ago`);
    }

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
      log(`Prompt: ${prompt.substring(0, 300)}`);

      if (!sessionAlive) {
        log('WARNING: session appears dead, sendAndWait may hang');
      }

      const t0 = Date.now();
      const result = await session.sendAndWait({ prompt }, 300_000); // 5 min timeout
      const elapsed = Date.now() - t0;

      log(`sendAndWait completed in ${elapsed}ms`);
      log(`Response: ${JSON.stringify(result)?.substring(0, 500)}`);
      processing = false;
    } catch (err: any) {
      processing = false;
      log(`Poll error: ${err?.message}`);
      log(`Error stack: ${err?.stack?.substring(0, 300)}`);
      if (err?.message?.includes('timeout') || err?.message?.includes('disconnect')) {
        log('Session may be dead — will continue polling but expect failures');
        sessionAlive = false;
      }
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
