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
 *   CLAUDE_TEMPO_PLAYER_NAME  — player ID for workflow registration (set by spawner for deterministic workflow IDs)
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

/** Filter process.env to exclude undefined values (safe to spread as Record<string, string>). */
const cleanEnv = (): Record<string, string> =>
  Object.fromEntries(Object.entries(process.env).filter((e): e is [string, string] => e[1] !== undefined));

const POLL_INTERVAL_MS = 2000;
const CREATE_SESSION_TIMEOUT_MS = 45_000;
const MAX_CONSECUTIVE_FAILURES = 3;
const MAX_SESSION_RECREATIONS = 2;

/** Wrap createSession with a timeout so auth/network hangs don't block forever. */
async function createSessionWithTimeout(
  copilotClient: any,
  sessionConfig: any,
  timeoutMs = CREATE_SESSION_TIMEOUT_MS,
): Promise<any> {
  let timer: ReturnType<typeof setTimeout>;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(
      `createSession timed out after ${timeoutMs / 1000}s — check Copilot auth and network connectivity`,
    )), timeoutMs);
  });
  try {
    return await Promise.race([
      copilotClient.createSession(sessionConfig),
      timeout,
    ]);
  } finally {
    clearTimeout(timer!);
  }
}

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

  // Determine the expected workflow ID. The MCP server uses the pattern
  // `claude-session-{ensemble}-{playerId}`, where playerId comes from
  // CLAUDE_TEMPO_PLAYER_NAME or a random hex. We pass CLAUDE_TEMPO_PLAYER_NAME
  // to the MCP server env so both sides agree on the ID.
  const isConductor = !!process.env.CLAUDE_TEMPO_CONDUCTOR;
  const playerIdForWorkflow = isConductor
    ? 'conductor'
    : (process.env.CLAUDE_TEMPO_PLAYER_NAME || playerName || `copilot-${Date.now()}`);
  const expectedWorkflowId = `claude-session-${config.ensemble}-${playerIdForWorkflow}`;

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
    ...cleanEnv(),
    CLAUDE_TEMPO_ENSEMBLE: config.ensemble,
    TEMPORAL_ADDRESS: config.temporalAddress,
    TEMPORAL_NAMESPACE: config.temporalNamespace,
    CLAUDE_TEMPO_TASK_QUEUE: config.taskQueue,
    CLAUDE_TEMPO_CONDUCTOR: process.env.CLAUDE_TEMPO_CONDUCTOR || '',
    CLAUDE_TEMPO_BRIDGE_MODE: '1', // disable MCP server's message poller — bridge handles delivery
    CLAUDE_TEMPO_PLAYER_NAME: playerIdForWorkflow, // ensures MCP server uses same workflow ID
  };

  // Spawn Copilot SDK client and session
  const copilotClient = new CopilotClient({
    logLevel: 'debug',
    env: {
      ...cleanEnv(),
      ...(process.env.GITHUB_TOKEN ? { GITHUB_TOKEN: process.env.GITHUB_TOKEN } : {}),
    },
  });

  const sessionConfig: Parameters<typeof copilotClient.createSession>[0] = {
    // approveAll is intentional: Copilot bridge sessions run headless with no
    // interactive terminal, so there is no way to prompt for permission approval.
    // All tool calls are auto-approved by design — the bridge operator accepts
    // this when launching the bridge process.
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
  let session = await createSessionWithTimeout(copilotClient, sessionConfig);
  log(`Copilot session created: ${session.sessionId}`);

  // Track session health — resets to true on any successful interaction
  let sessionAlive = true;
  let lastEventTime = Date.now();
  let lastEventType = 'session.created';

  function attachEventLogger(s: any) {
    s.on((event: any) => {
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
  }
  attachEventLogger(session);

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

  // Wait for the MCP server's workflow to register in Temporal.
  // We know the exact workflow ID because we pass CLAUDE_TEMPO_PLAYER_NAME to the
  // MCP server — no need for a time-window heuristic that could misidentify workflows.
  log(`Waiting for workflow ${expectedWorkflowId} to register...`);
  const handle = client.workflow.getHandle(expectedWorkflowId);

  let workflowReady = false;
  for (let attempt = 0; attempt < 30; attempt++) {
    try {
      const desc = await handle.describe();
      if (desc.status.name === 'RUNNING') {
        workflowReady = true;
        break;
      }
    } catch {
      // Workflow not yet started
    }
    await new Promise((r) => setTimeout(r, 1000));
    if (attempt % 5 === 4) log(`Still waiting... attempt ${attempt + 1}/30`);
  }

  if (!workflowReady) {
    log(`ERROR: Workflow ${expectedWorkflowId} did not register within 30 seconds`);
    await session.disconnect();
    await copilotClient.stop();
    process.exit(1);
  }

  log(`Workflow ready: ${expectedWorkflowId}`);

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

  // Start message poller — inject messages into the Copilot session.
  // Tracks consecutive failures and attempts session recreation before giving up.
  let polling = true;
  let processing = false;
  let pollCount = 0;
  let consecutiveFailures = 0;
  let sessionRecreations = 0;

  /** Attempt to recreate the Copilot session after repeated failures. */
  async function recreateSession(): Promise<boolean> {
    sessionRecreations++;
    if (sessionRecreations > MAX_SESSION_RECREATIONS) {
      log(`ERROR: Exceeded max session recreations (${MAX_SESSION_RECREATIONS}). Giving up.`);
      return false;
    }
    log(`Attempting session recreation (${sessionRecreations}/${MAX_SESSION_RECREATIONS})...`);
    try {
      await session.disconnect().catch(() => {});
      session = await createSessionWithTimeout(copilotClient, sessionConfig);
      attachEventLogger(session);
      sessionAlive = true;
      consecutiveFailures = 0;
      log(`Session recreated successfully: ${session.sessionId}`);
      return true;
    } catch (err: any) {
      log(`Session recreation failed: ${err?.message}`);
      return false;
    }
  }

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

      // Success — reset failure tracking
      consecutiveFailures = 0;
      sessionAlive = true;
      processing = false;
    } catch (err: any) {
      processing = false;
      consecutiveFailures++;
      log(`Poll error (${consecutiveFailures}/${MAX_CONSECUTIVE_FAILURES}): ${err?.message}`);
      log(`Error stack: ${err?.stack?.substring(0, 300)}`);

      if (consecutiveFailures >= MAX_CONSECUTIVE_FAILURES) {
        log('Consecutive failure threshold reached — attempting session recovery');
        const recovered = await recreateSession();
        if (!recovered) {
          log('ERROR: Session recovery failed. Shutting down bridge.');
          polling = false;
          clearInterval(interval);
          process.exit(2);
        }
      }
    }
  };

  const interval = setInterval(poll, POLL_INTERVAL_MS);
  log('Message poller started. Bridge is running.');

  // Write PID file so callers can find/kill orphaned bridge processes
  const pidDir = path.join(workDir, 'logs');
  const pidFile = path.join(pidDir, `${playerName || playerIdForWorkflow}.pid`);
  try {
    fs.mkdirSync(pidDir, { recursive: true });
    fs.writeFileSync(pidFile, String(process.pid));
    log(`PID file written: ${pidFile}`);
  } catch (err: any) {
    log(`Warning: could not write PID file: ${err?.message}`);
  }

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
    // Clean up PID file
    try { fs.unlinkSync(pidFile); } catch { /* may already be gone */ }
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
