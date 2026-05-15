/**
 * Copilot adapter — SDK class.
 *
 * Content lifted verbatim from `src/copilot-bridge.ts` into a class wrapper as
 * part of PR-B (v0.25 rebuild step 2/7). Zero behavior change: the same
 * createSession / event-logger / poll / sendAndWait / cleanup flow runs, and
 * the PR-A compat shim in `src/workflows/session.ts` translates
 * `updateMetadata({ status })` onto the attachment phase machine.
 *
 * Dual-purpose file:
 *   - `import { CopilotSdkAttachment } from '.../adapter'` → class reference for
 *     the adapter registry. `run()` is NOT invoked.
 *   - `node .../adapter.js` (or `ts-node .../adapter.ts`) → executes `run()` as
 *     the spawned subprocess entry point, gated by `require.main === module`.
 *
 * PR-C rewrites this adapter against the v0.25 attachment wire protocol —
 * `claimAttachment` + heartbeat, `processingStart`/`End` via SdkAttachment.deliver()
 * wrapper, `onSuperseded` cancellation hook. Until then, the bridge runs its
 * lifecycle stand-alone.
 *
 * Usage (dev / prod):
 *   npx ts-node src/adapters/copilot/adapter.ts
 *   node dist/adapters/copilot/adapter.js
 *
 * Environment variables:
 *   AGENT_TEMPO_ENSEMBLE     — ensemble name (default: "default")
 *   AGENT_TEMPO_PLAYER_NAME  — player ID for workflow registration (set by spawner for deterministic workflow IDs)
 *   COPILOT_BRIDGE_NAME       — player name for set_name (optional)
 *   COPILOT_BRIDGE_MODEL      — model to use (optional)
 *   COPILOT_BRIDGE_SESSION_ID — deterministic session ID for resumable sessions (optional)
 *   GITHUB_TOKEN              — GitHub auth token (optional, uses logged-in user by default)
 *
 * Design reference: docs/design/session-lifecycle-rebuild-v2.md §6 (Class 2 —
 * SDK), §4.2, §4.4.
 */

import * as fs from 'fs';
import * as path from 'path';
import { Client } from '@temporalio/client';
import { getConfig, ENV } from '../../config';
import { createTemporalConnection } from '../../connection';
import { Message } from '../../types';
import type { AdapterDescriptor } from '../../types';
import { SdkAttachment } from '../sdk/base';
// #536 — shared SDK-class system-prompt + MAESTRO_ACK (was inline
// here pre-#536; moved to the shared module so the post-#536
// claude-code-headless adapter mirrors the same dialect).
import { MAESTRO_ACK, buildSdkSystemPrompt } from '../sdk/system-prompt';
import { updateMetadataSignal } from '../../workflows/signals';

/**
 * Descriptor for the copilot adapter. Kept colocated with the class so
 * `adapter.ts` has no import dependency on `index.ts` (breaks the circular
 * module-graph cycle flagged in QA review of PR-B). `index.ts` re-exports
 * this constant alongside the class.
 *
 * Design reference: docs/design/session-lifecycle-rebuild-v2.md §4.2–4.3.
 */
export const copilotDescriptor: AdapterDescriptor = {
  adapterId: 'copilot',
  adapterClass: 'sdk',
  // Copilot's sendAndWait blocks on the LLM turn — processingStart/End pairing
  // is required (handled today inline in the bridge; PR-C centralizes it in
  // SdkAttachment.deliver()).
  blocksOnLLMTurn: true,
  // SDK class — 30s cadence per design §4.3. PR-C wires this into the
  // heartbeat loop on BaseAttachment.
  heartbeatMs: 30_000,
};

// Optional dependency — must be installed separately: npm install @github/copilot-sdk
let CopilotClient: any;
let approveAll: any;
try {
  const sdk = require('@github/copilot-sdk');
  CopilotClient = sdk.CopilotClient;
  approveAll = sdk.approveAll;
} catch {
  // When run as the Copilot bridge subprocess entrypoint, print an actionable
  // error and exit so the user knows what to install. When imported by the
  // adapter registry during normal MCP server startup, stay silent — the SDK
  // is optional and non-Copilot users should see no noise. (#122)
  if (require.main === module) {
    console.error(
      'Error: @github/copilot-sdk is not installed.\n' +
      'Install it with: npm install @github/copilot-sdk\n' +
      'See the Copilot CLI integration section in the README.',
    );
    process.exit(1);
  }
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
/** Check workflow status every N polls (~30s at 2s interval). */
const WORKFLOW_STATUS_CHECK_INTERVAL = 15;
/** Proactively recreate the Copilot session after this idle period (ms). Default 60 min. */
const SESSION_MAX_IDLE_MS = 60 * 60 * 1000;

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

/**
 * SDK-class adapter for the GitHub Copilot CLI.
 *
 * Delivery model is pull-based (blocks on LLM turn): the bridge polls the
 * workflow for pending messages, injects them as prompts via the Copilot SDK's
 * `session.sendAndWait`, then marks them delivered. `processingStart`/`End` are
 * paired around each blocking call so the workflow's stale detection doesn't
 * misclassify a long tool execution as a dead session (fix for #99).
 *
 * PR-B lands this as a verbatim lift from the old `src/copilot-bridge.ts`.
 * PR-C moves the processingStart/End wrapping up into SdkAttachment.deliver()
 * and introduces `claimAttachment` + heartbeat + `onSuperseded` hooks.
 */
export class CopilotSdkAttachment extends SdkAttachment {
  readonly descriptor: AdapterDescriptor = copilotDescriptor;

  /**
   * The currently-active Copilot SDK session, stashed here so the
   * `onSuperseded` hook can disconnect it on lease revocation. Populated in
   * `run()` after `copilotClient.createSession(...)` and refreshed on each
   * successful `recreateSession()`. `undefined` before the session is created
   * and after shutdown.
   */
  private activeSession?: { disconnect(): Promise<void> | void };

  /**
   * Split-brain cancellation hook (§9.3). Called by `SdkAttachment` when the
   * base-class phase watcher detects that our `attachmentId` no longer matches
   * the current attachment on the workflow — i.e., another claimant stole the
   * lease. We tear down the active Copilot session: it's the only
   * cancellation primitive the SDK exposes, and the adapter is about to exit
   * anyway.
   *
   * Residual ghost-reply window: if `sendAndWait` is already producing a reply
   * over the network, disconnect may race the response. The reply is dropped
   * (processingEnd will throw `AttachmentMismatch`, markDelivered never fires)
   * so delivery semantics stay at-most-once. One LLM turn is wasted; this is
   * documented in the adapter README per §9.3's guidance.
   */
  protected onSuperseded(): void {
    log('lease revoked — disconnecting Copilot session');
    const s = this.activeSession;
    this.activeSession = undefined;
    if (!s) return;
    // Fire-and-forget. disconnect() can be sync or async depending on SDK version;
    // we don't await because the phase-watcher listener is synchronous.
    try {
      const maybePromise = s.disconnect();
      if (maybePromise && typeof (maybePromise as Promise<void>).catch === 'function') {
        (maybePromise as Promise<void>).catch((err) =>
          log('session.disconnect during onSuperseded threw:', err?.message ?? err));
      }
    } catch (err: any) {
      log('session.disconnect during onSuperseded threw:', err?.message ?? err);
    }
  }

  /**
   * Entry point for the bridge subprocess.
   *
   * Kept as a single async method (instead of being broken up into lifecycle
   * hooks) to preserve the exact behavior of the pre-PR-B `main()` function.
   * The bridge claims the attachment via `startV2Lifecycle`, drives
   * `deliver()` through `SdkAttachment` (synchronous processingStart/End
   * per §7.1, `expectedAttachmentId` carried on both), and installs
   * `onSuperseded` to disconnect the Copilot session on lease revocation.
   *
   * PR-H (#132): the legacy fire-and-forget processingStart/End path
   * gated on `AGENT_TEMPO_LIFECYCLE_V2=0` has been removed. V2 is the
   * only path.
   */
  async run(): Promise<void> {
    const config = getConfig();
    const playerName = process.env[ENV.BRIDGE_NAME];
    const model = process.env[ENV.BRIDGE_MODEL];
    const copilotSessionId = process.env[ENV.BRIDGE_SESSION_ID] || `tempo-${config.ensemble}-${playerName || 'unknown'}-${Date.now()}-${process.pid}`;
    const workDir = process.cwd();

    log(`Starting Copilot bridge in ${workDir} (ensemble: ${config.ensemble})`);

    // Connect Temporal client (for polling only — the MCP server child process runs its own worker)
    const connection = await createTemporalConnection(config);
    const client = new Client({
      connection,
      namespace: config.temporalNamespace,
    });

    // Hand the client + host to BaseAttachment so startV2Lifecycle (below) can
    // issue claimAttachment + heartbeat against it. No-op on legacy path.
    const os = require('os') as typeof import('os');
    this.configureV2(client, os.hostname());

    // Determine the expected workflow ID. The MCP server uses the pattern
    // `agent-session-{ensemble}-{playerId}`, where playerId comes from
    // AGENT_TEMPO_PLAYER_NAME or a random hex. We pass AGENT_TEMPO_PLAYER_NAME
    // to the MCP server env so both sides agree on the ID.
    const isConductor = process.env[ENV.CONDUCTOR] === 'true';
    const requestedName = process.env[ENV.PLAYER_NAME] || playerName || '';
    const playerIdForWorkflow = isConductor
      ? 'conductor'
      : (requestedName && requestedName !== 'conductor' ? requestedName : '') || `copilot-${Date.now()}`;
    const expectedWorkflowId = `agent-session-${config.ensemble}-${playerIdForWorkflow}`;

    // Build the MCP server command — always use the compiled dist/server.js
    // Run `npm run build` (or `pnpm build`) before using the bridge.
    const serverJsPath = path.resolve(__dirname, '..', '..', '..', 'dist', 'server.js');
    if (!fs.existsSync(serverJsPath)) {
      log(`ERROR: ${serverJsPath} not found. Run 'pnpm build' first.`);
      process.exit(1);
    }
    log(`MCP server path: ${serverJsPath}`);
    const serverCommand = 'node';
    const serverArgs = [serverJsPath];
    const mcpEnv: Record<string, string> = {
      ...cleanEnv(),
      [ENV.ENSEMBLE]: config.ensemble,
      [ENV.TEMPORAL_ADDRESS]: config.temporalAddress,
      [ENV.TEMPORAL_NAMESPACE]: config.temporalNamespace,
      [ENV.TASK_QUEUE]: config.taskQueue,
      [ENV.CONDUCTOR]: isConductor ? 'true' : '',
      [ENV.BRIDGE_MODE]: '1', // disable MCP server's message poller — bridge handles delivery
      [ENV.PLAYER_NAME]: playerIdForWorkflow, // ensures MCP server uses same workflow ID
      ...(config.temporalApiKey ? { [ENV.TEMPORAL_API_KEY]: config.temporalApiKey } : {}),
      ...(config.temporalTlsCertPath ? { [ENV.TEMPORAL_TLS_CERT_PATH]: config.temporalTlsCertPath } : {}),
      ...(config.temporalTlsKeyPath ? { [ENV.TEMPORAL_TLS_KEY_PATH]: config.temporalTlsKeyPath } : {}),
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
      sessionId: copilotSessionId,
      // approveAll is intentional: Copilot bridge sessions run headless with no
      // interactive terminal, so there is no way to prompt for permission approval.
      // All tool calls are auto-approved by design — the bridge operator accepts
      // this when launching the bridge process.
      onPermissionRequest: approveAll,
      workingDirectory: workDir,
      mcpServers: {
        'agent-tempo': {
          command: serverCommand,
          args: serverArgs,
          env: mcpEnv,
          tools: ['*'],
        },
      },
      systemMessage: {
        mode: 'append' as const,
        // #536 — content extracted to `src/adapters/sdk/system-prompt.ts`
        // so claude-code-headless can use the same template via its
        // `--append-system-prompt` argv. Behavior here is unchanged.
        content: buildSdkSystemPrompt({ ensemble: config.ensemble }),
      },
      excludedTools: ['write_powershell', 'read_powershell', 'list_powershell'],
      ...(model ? { model } : {}),
    };

    log('Creating Copilot session...');
    let session = await createSessionWithTimeout(copilotClient, sessionConfig);
    log(`Copilot session created: ${session.sessionId}`);
    // Stash for onSuperseded (V2 path). Refreshed on each successful recreate.
    this.activeSession = session;

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
        } else if (event.type === 'session.info') {
          log(`[session.info] ${JSON.stringify(event.data)}`);
        } else if (event.type === 'session.warning') {
          log(`[session.warning] ${JSON.stringify(event.data)}`);
        } else if (event.type === 'session.mcp_servers_loaded') {
          log(`[mcp_servers_loaded] ${JSON.stringify(event.data)}`);
        } else if (event.type === 'session.mcp_server_status_changed') {
          log(`[mcp_server_status_changed] ${JSON.stringify(event.data)}`);
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
      // Dump available tools for diagnostics
      try {
        const toolList = await session.rpc.tools.list({});
        log('Available tools:', JSON.stringify(toolList.tools?.map((t: any) => t.name || t.namespacedName)));
      } catch (toolErr: any) {
        log('Failed to list tools:', toolErr?.message);
      }
    } catch (err: any) {
      log(`Initial prompt error after ${Date.now()}ms:`, err?.message, err?.stack?.substring(0, 300));
    }

    // PID file paths — computed early so early-exit paths can clean up
    const pidDir = path.join(workDir, 'logs');
    const pidFile = path.join(pidDir, `${playerName || playerIdForWorkflow}.pid`);

    // Wait for the MCP server's workflow to register in Temporal.
    // We know the exact workflow ID because we pass AGENT_TEMPO_PLAYER_NAME to the
    // MCP server — no need for a time-window heuristic that could misidentify workflows.
    log(`Waiting for workflow ${expectedWorkflowId} to register...`);
    let handle = client.workflow.getHandle(expectedWorkflowId);

    let workflowReady = false;
    let pinnedRunId: string | undefined;
    for (let attempt = 0; attempt < 30; attempt++) {
      try {
        const desc = await handle.describe();
        if (desc.status.name === 'RUNNING') {
          workflowReady = true;
          pinnedRunId = desc.runId;
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
      // Clean up PID file to avoid stale entries in `agent-tempo status`
      try { fs.unlinkSync(pidFile); } catch { /* may not exist yet */ }
      process.exit(1);
    }

    // Pin all subsequent interactions to the runId we observed — prevents the
    // zombie-resurrection hazard from #102. If this run completes (e.g. destroy),
    // a later USE_EXISTING start would spawn a new run with the same workflow ID;
    // an unpinned handle would silently attach to the new run, but a pinned handle
    // returns WorkflowNotFound and lets the bridge exit cleanly.
    handle = client.workflow.getHandle(expectedWorkflowId, pinnedRunId);
    log(`Workflow ready: ${expectedWorkflowId} (pinned runId ${pinnedRunId})`);

    // V2 path: claim the attachment + start the base-class heartbeat & phase
    // watcher loops. `startV2Lifecycle` returns its own pinned handle (same
    // runId we already have); we prefer it going forward so the heartbeat
    // and delivery use a consistent handle. `onTerminal` (WorkflowNotFound,
    // phase=gone, lease revoked) triggers clean shutdown below.
    //
    // PR-H (#132): unconditional — the V1 fallback gated on
    // `AGENT_TEMPO_LIFECYCLE_V2=0` has been removed.

    // Wire terminal handler BEFORE claiming so a race between claim + lease
    // loss can't drop the event.
    this.onTerminal((reason) => {
      log(`V2 terminal (${reason}) — triggering cleanup`);
      // Fire-and-forget: `cleanup` is idempotent.
      cleanup().catch((err) => log('terminal cleanup error:', err?.message ?? err));
    });
    try {
      // PR-D: read pre-claimed attachmentId (set by the spawn activity when
      // the workflow called `claimAttachment` before enqueueing this spawn).
      // Forwarding it selects §9.2's renewal branch so the adapter takes
      // over an existing lease atomically; absent on first-recruit spawn.
      const expectedAttachmentId = process.env[ENV.ATTACHMENT_ID] || undefined;
      handle = await this.startV2Lifecycle(expectedWorkflowId, expectedAttachmentId);
      log(`V2 attachment claimed (attachmentId=${this.token?.attachmentId}${expectedAttachmentId ? ', renewed' : ''})`);
    } catch (err: any) {
      log(`ERROR: V2 claimAttachment failed: ${err?.message ?? err}`);
      try { await session.disconnect(); } catch { /* best effort */ }
      try { fs.unlinkSync(pidFile); } catch { /* may not exist */ }
      await copilotClient.stop();
      process.exit(1);
    }

    // Store sessionId in workflow metadata for future restart/resume.
    // PR-D: migrated from string-literal `'updateMetadata'` to the typed
    // constant so the ts-morph wire-protocol drift detector sees this call.
    try {
      await handle.signal(updateMetadataSignal, { sessionId: copilotSessionId });
    } catch { /* workflow may not be ready yet */ }

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

    // #536 — `MAESTRO_ACK` lifted into `src/adapters/sdk/system-prompt.ts`
    // so claude-code-headless's prompt-build applies the same string.
    // Imported at the top of this module.

    // Write PID file so callers can find/kill orphaned bridge processes
    try {
      fs.mkdirSync(pidDir, { recursive: true });
      fs.writeFileSync(pidFile, String(process.pid));
      log(`PID file written: ${pidFile}`);
    } catch (err: any) {
      log(`Warning: could not write PID file: ${err?.message}`);
    }

    // Start message poller — inject messages into the Copilot session.
    // Tracks consecutive failures and attempts session recreation before giving up.
    let polling = true;
    let processing = false;
    let pollCount = 0;
    let consecutiveFailures = 0;
    let sessionRecreations = 0;
    let proactiveRecreations = 0;
    let lastActivityTime = Date.now();
    // interval declared here, assigned after poll is defined
    let interval: ReturnType<typeof setInterval> | undefined;

    // Shared cleanup — disconnects session, removes PID file, stops client.
    let shuttingDown = false;
    const cleanup = async () => {
      if (shuttingDown) return;
      shuttingDown = true;
      polling = false;
      clearInterval(interval);
      // V2 graceful detach — fires `adapterExited` so the workflow collapses
      // draining → detached immediately per §11.1. No-op if V2 was off or if
      // startV2Lifecycle never ran successfully.
      //
      // PR-C commit 4 retired the former `updateMetadata({ status: 'terminated' })`
      // follow-up signal: closing the Copilot bridge subprocess is a graceful
      // detach, not a session destroy. The workflow stays in `detached` waiting
      // for the next claim (e.g. `restart`). Explicit operator termination goes
      // through the `destroy` tool / CLI, which uses `destroyUpdate` directly.
      await this.stopV2Lifecycle('user-stop', /* graceful */ true).catch((err) =>
        log(`stopV2Lifecycle suppressed error: ${(err as Error)?.message ?? err}`));
      try { await session.disconnect(); } catch { /* already disconnected */ }
      this.activeSession = undefined;
      try { fs.unlinkSync(pidFile); } catch { /* already gone */ }
      await copilotClient.stop();
    };

    /** Attempt to recreate the Copilot session after repeated failures. */
    const recreateSession = async (): Promise<boolean> => {
      // Fixes #102: before recreating, check whether the pinned-runId workflow has
      // been destroyed. If so, the user explicitly stopped this session — do NOT
      // bring it back as a zombie. This also covers WorkflowNotFound (the pinned
      // run has completed/terminated) since the query throws cleanly.
      try {
        const isDestroyed: boolean = await handle.query('isDestroyed');
        if (isDestroyed) {
          log('Workflow is destroyed — not reconnecting (session was intentionally stopped)');
          return false;
        }
      } catch (err: any) {
        const errName = err?.name || '';
        const errMsg = err?.message || '';
        if (errName.includes('WorkflowNotFound') || errMsg.includes('NOT_FOUND')) {
          log('Workflow not found (likely terminated) — not reconnecting');
          return false;
        }
        // Query failed for another reason — log and continue with recreation.
        log(`isDestroyed query failed (${errMsg}), continuing with recreation`);
      }

      sessionRecreations++;
      if (sessionRecreations > MAX_SESSION_RECREATIONS) {
        log(`ERROR: Exceeded max session recreations (${MAX_SESSION_RECREATIONS}). Giving up.`);
        return false;
      }
      log(`Attempting session recovery (${sessionRecreations}/${MAX_SESSION_RECREATIONS})...`);
      try {
        await session.disconnect().catch(() => {});

        // Try resumeSession first to preserve conversation history
        try {
          const { sessionId: _discard, ...resumeConfig } = sessionConfig as any;
          session = await copilotClient.resumeSession(copilotSessionId, resumeConfig);
          attachEventLogger(session);
          this.activeSession = session; // refresh V2 onSuperseded target
          sessionAlive = true;
          consecutiveFailures = 0;
          lastActivityTime = Date.now();
          log(`Session resumed successfully: ${session.sessionId}`);
          return true;
        } catch (resumeErr: any) {
          log(`resumeSession failed (${resumeErr?.message}), falling back to createSession`);
          session = await createSessionWithTimeout(copilotClient, sessionConfig);
          attachEventLogger(session);
          this.activeSession = session; // refresh V2 onSuperseded target
          sessionAlive = true;
          consecutiveFailures = 0;
          lastActivityTime = Date.now();
          log(`Session recreated (fresh) successfully: ${session.sessionId}`);
          return true;
        }
      } catch (err: any) {
        log(`Session recovery failed: ${err?.message}`);
        return false;
      }
    };

    const poll = async () => {
      if (!polling || processing) return;
      pollCount++;

      // Periodic health check
      if (pollCount % 30 === 0) { // every ~60 seconds
        const silenceSec = ((Date.now() - lastEventTime) / 1000).toFixed(0);
        log(`[health] poll #${pollCount}, sessionAlive=${sessionAlive}, lastEvent=${lastEventType} ${silenceSec}s ago`);
      }

      // Periodic workflow status check — detect external termination/completion
      if (pollCount % WORKFLOW_STATUS_CHECK_INTERVAL === 0) {
        try {
          const desc = await handle.describe();
          const wfStatus = desc.status.name;
          if (wfStatus !== 'RUNNING') {
            log(`Workflow status is ${wfStatus} — exiting cleanly`);
            await cleanup();
            process.exit(0);
          }
          // Also check the in-workflow destroy flag — the workflow may still be RUNNING
          // (draining) but has been destroyed. Exit cleanly without attempting signals
          // that would be rejected.
          try {
            const isDestroyed: boolean = await handle.query('isDestroyed');
            if (isDestroyed) {
              log('Workflow destroyed — exiting cleanly');
              await cleanup();
              process.exit(0);
            }
          } catch { /* isDestroyed query unavailable pre-upgrade — safe to ignore */ }
        } catch (err: any) {
          // If we can't describe (e.g., workflow not found), it was likely terminated
          log(`Workflow describe failed: ${err?.message} — treating as terminated`);
          await cleanup();
          process.exit(0);
        }
      }

      // Proactive stale-session detection — recreate before the SDK server GCs the session
      const idleMs = Date.now() - lastActivityTime;
      if (idleMs > SESSION_MAX_IDLE_MS && !processing) {
        try {
          processing = true; // guard against overlapping polls during async recreation
          log(`Session idle for ${(idleMs / 1000 / 60).toFixed(0)}min — proactively recreating`);
          proactiveRecreations++;
          const recovered = await recreateSession();
          if (recovered) {
            // Proactive recreation is lifecycle management, not failure recovery — restore failure budget
            // but don't reset to 0: use proactiveRecreations to cap total lifecycle recreations
            sessionRecreations = Math.max(0, sessionRecreations - 1);
          } else {
            // Session is almost certainly dead server-side — force immediate recovery on next message
            // Use MAX - 1 so the next poll error increments to the threshold and triggers recovery
            consecutiveFailures = MAX_CONSECUTIVE_FAILURES - 1;
            sessionAlive = false;
            log('ERROR: Proactive session recreation failed — will force recovery on next message');
          }
        } finally {
          processing = false;
        }
      }

      try {
        const messages: Message[] = await handle.query('pendingMessages');
        if (messages.length === 0) return;

        processing = true;
        const ids = messages.map((m) => m.id);

        // Format messages into a single prompt, appending ack instruction for Maestro messages
        const prompt = messages
          .map((m) => {
            const line = `[Message from ${m.from}]: ${m.text}`;
            return m.isMaestro ? line + MAESTRO_ACK : line;
          })
          .join('\n\n');

        log(`Injecting ${messages.length} message(s) into Copilot session`);
        log(`Prompt: ${prompt.substring(0, 300)}`);

        if (!sessionAlive) {
          log('WARNING: session appears dead, sendAndWait may hang');
        }

        // Fixes #99: mark in-flight before the blocking LLM call so the workflow's
        // stale detection doesn't misclassify a long tool call as dead. The V2
        // path goes through `SdkAttachment.deliver()` which makes these updates
        // synchronous (§7.1) and carries `expectedAttachmentId` so a revoked
        // lease is observable. PR-H (#132): the `AGENT_TEMPO_LIFECYCLE_V2=0`
        // legacy fire-and-forget fallback has been removed.
        if (!this.token) {
          // Should be unreachable: `startV2Lifecycle` populates token before
          // `run()` reaches the delivery loop. Fail loudly rather than
          // silently fall back.
          throw new Error('Copilot bridge invariant: attachment token missing in delivery loop');
        }

        // SdkAttachment.deliver wraps processingStart → sendAndWait → processingEnd
        // → markDelivered(ids). Invokes onSuperseded on lease revocation mid-turn.
        const delivered = await this.deliver(
          handle,
          messages[0], // representative message
          prompt,
          300_000,
          async (p, t) => session.sendAndWait({ prompt: p }, t),
          ids, // ack all pending messages in one markDelivered signal
        );
        const result = delivered.sdkResult;
        const elapsed = delivered.elapsedMs;

        log(`sendAndWait completed in ${elapsed}ms`);
        log(`Response: ${JSON.stringify(result)?.substring(0, 500)}`);

        // Success — reset failure tracking
        consecutiveFailures = 0;
        lastActivityTime = Date.now();
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
            await cleanup();
            process.exit(2);
          }
        }
      }
    };

    interval = setInterval(poll, POLL_INTERVAL_MS);
    log('Message poller started. Bridge is running.');

    // Graceful shutdown on SIGINT/SIGTERM — signal the workflow before exiting
    const shutdown = async () => {
      log('Shutting down (signal received)...');
      await cleanup();
      process.exit(0);
    };

    process.on('SIGINT', shutdown);
    process.on('SIGTERM', shutdown);
  }
}

// Subprocess entry point — only fires when this file is executed directly by
// `node .../adapter.js` or `ts-node .../adapter.ts`. Keeps the file usable both
// as an importable class and as a spawn target.
if (require.main === module) {
  new CopilotSdkAttachment().run().catch((err) => {
    log('Fatal error:', err);
    process.exit(1);
  });
}
