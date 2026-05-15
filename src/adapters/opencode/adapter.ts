/**
 * Headless OpenCode adapter — SDK class.
 *
 * Issue #449 Phase C. Drives [SST OpenCode](https://opencode.ai) as a
 * headless local subprocess for multi-provider LLM access (Anthropic,
 * OpenAI, Bedrock, Vertex, Ollama, ~70+ providers via OpenCode's
 * `provider/model` selector). Mirrors the claude-api / Copilot bridge
 * structure: detached Node subprocess, dual-purpose entry point,
 * `claimAttachment` + heartbeat lifecycle inherited from `SdkAttachment`.
 *
 * Class hierarchy: `OpenCodeAttachment extends SdkAttachment extends BaseAttachment`.
 * Concrete adapter overrides `invokeSdk` (HTTP/SSE round-trip via
 * `OpenCodeServerBridge`) and `onSuperseded` (graceful `POST /session/:id/abort`
 * with subprocess-kill fallback). Everything else (claim, heartbeat,
 * phase watcher, `processingStart`/`End` pairing, `markDelivered`) is free.
 *
 * What's NEW vs claude-api / copilot:
 *   - Adapter manages a sibling `opencode serve` subprocess (probed-free
 *     port, hardcoded loopback bind, `mdns: false`).
 *   - Tool bridging is MCP-NATIVE — OpenCode spawns `dist/server.js` as
 *     its own MCP child via the `OPENCODE_CONFIG_CONTENT` env. No
 *     in-process MCP bridge / no schema translation layer.
 *   - Server-side history — adapter sends only the new turn's parts;
 *     OpenCode appends to its own session record.
 *   - PID file is two-line (adapter PID + opencode-serve PID).
 *
 * Design reference: `docs/design/449-opencode-adapter.md`. ADR locked at
 * `docs/adr/0015-opencode-adapter.md`.
 */
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { spawn, ChildProcess } from 'child_process';
import { Client, WorkflowHandle } from '@temporalio/client';
import type { Message, AdapterDescriptor } from '../../types';
import { SdkAttachment, type SdkDeliverResult } from '../sdk/base';
import { ENV, getConfig } from '../../config';
import { createTemporalConnection } from '../../connection';
import {
  pendingMessagesQuery,
  isDestroyedQuery,
  updateMetadataSignal,
} from '../../workflows/signals';
import { buildServerInstructions } from '../../server-tools';
import { synthesizeOpenCodeConfig } from './config';
import { OpenCodeServerBridge, type OpenCodeEvent } from './server-bridge';
import { isVersionMatch, probeFreePort, redactSecrets, waitForExit } from './helpers';
import { probeSdkInstall } from '../../utils/sdk-probe';

/**
 * Descriptor for the opencode adapter. Colocated with the class so
 * `adapter.ts` has no import dependency on `index.ts` (avoids the
 * circular module-graph cycle QA flagged on copilot's PR-B).
 */
export const opencodeDescriptor: AdapterDescriptor = {
  adapterId: 'opencode',
  adapterClass: 'sdk',
  blocksOnLLMTurn: true,
  heartbeatMs: 30_000,
};

/**
 * Optional-dep gate. The adapter uses raw `fetch` for the hot path (per
 * design §8.3 #2) so the SDK isn't actually imported, but the install
 * presence is the operator's signal that opencode integration is intended
 * on this host. ADR 0015 §85.
 *
 * `probeSdkInstall` walks the filesystem rather than calling
 * `require.resolve` because `@opencode-ai/sdk` ships an ESM-only
 * `exports` map with no CJS-resolvable entry — see the helper's docblock.
 */
const opencodeSdkAvailable = probeSdkInstall('@opencode-ai/sdk');
if (!opencodeSdkAvailable && require.main === module) {
  console.error(
    'Error: @opencode-ai/sdk is not installed.\n' +
    'Install it with: npm install @opencode-ai/sdk\n' +
    'And install the opencode binary: npm install -g opencode-ai\n' +
    'Or recruit with a different agent (claude / copilot / claude-api).',
  );
  process.exit(1);
}

/**
 * Unbuffered stderr logger. Errors are unpacked into `message + stack`
 * because the default `JSON.stringify(err)` drops both fields (they're
 * non-enumerable) and renders `Error` as `{}` — useless for debugging.
 */
const log = (...args: unknown[]) => {
  const msg = `[agent-tempo:opencode] ${args.map((a) => {
    if (typeof a === 'string') return a;
    if (a instanceof Error) return a.stack ? `${a.message}\n${a.stack}` : a.message;
    try { return JSON.stringify(a); } catch { return String(a); }
  }).join(' ')}\n`;
  fs.writeSync(2, msg);
};

/** Default model id — reviewable at next minor SDK bump per ADR 0015 §51. */
const DEFAULT_MODEL = 'anthropic/claude-opus-4-7';
/** Tested-pinned OpenCode SDK version — drift triggers a stderr WARNING. */
const TESTED_OPENCODE_VERSION = '~1.14.29';
/** Idle poll cadence — short enough for snappy cue delivery, loose on Temporal. */
const POLL_INTERVAL_MS = 2000;
/** Workflow-register poll bounds. */
const WORKFLOW_REGISTER_ATTEMPTS = 30;
const WORKFLOW_REGISTER_INTERVAL_MS = 1000;
/** Workflow status check cadence (every N polls). */
const WORKFLOW_STATUS_CHECK_INTERVAL = 15;
/** Per-turn timeout — opencode tool-use chains can run minutes. */
const TURN_TIMEOUT_MS = 5 * 60 * 1000;
/** opencode serve health-probe timeout. */
const HEALTH_PROBE_TIMEOUT_MS = 10_000;
/** Subprocess SIGTERM grace before SIGKILL escalation. */
const SIGTERM_TIMEOUT_MS = 5_000;
/** OpenCode-specific system-prompt addendum — design §10. */
const HEADLESS_OPENCODE_ADDENDUM =
  '\n\nYou are an **opencode** player — you have access to the claude-tempo MCP tools ' +
  '(cue, report, recall, ensemble, broadcast, recruit, set_part, …) AND OpenCode\'s built-in ' +
  'tools (file edits, shell, web search). Use the claude-tempo tools for ensemble coordination ' +
  'and OpenCode\'s built-ins for local task work. Your model is delivered via OpenCode, so the ' +
  'underlying provider (Anthropic, OpenAI, Bedrock, Ollama, …) is opaque to you and to the rest ' +
  'of the ensemble.';

/**
 * SDK-class adapter for OpenCode. Pull-based delivery: poll workflow for
 * pending messages, post each batch to `prompt_async`, observe SSE until
 * `finish`, ack via `markDelivered`. `processingStart`/`End` paired by
 * `SdkAttachment.deliver()`.
 */
export class OpenCodeAttachment extends SdkAttachment {
  readonly descriptor: AdapterDescriptor = opencodeDescriptor;

  /** Resolved model id (recruit-arg → ENV.OPENCODE_MODEL → DEFAULT_MODEL). */
  private model: string;
  /** Probed-free port the opencode serve subprocess binds. */
  private port = 0;
  /** Subprocess handle — `null` before run() spawns, after cleanup kills. */
  private serveProcess: ChildProcess | null = null;
  /** HTTP/SSE bridge — `null` before run() boots the subprocess. */
  private bridge: OpenCodeServerBridge | null = null;
  /** OpenCode session id — created on first turn, stashed on workflow metadata. */
  private openCodeSessionId: string | null = null;
  /** AbortController for the in-flight SSE consumer / prompt_async fetch. */
  private inFlightAbortController: AbortController | null = null;
  /** Cached for the per-turn telemetry log. */
  private playerName = '';
  /** Built once at session start; sent every turn (cheap; OpenCode caches server-side). */
  private systemPrompt = '';

  constructor(opts: { model?: string } = {}) {
    super();
    this.model = opts.model ?? process.env[ENV.OPENCODE_MODEL] ?? DEFAULT_MODEL;
  }

  /**
   * Lease-revocation hook. Two-step graceful → SIGTERM → SIGKILL fallback
   * per design §6.1: post `/session/:id/abort` first (cleanest, no
   * subprocess kill), abort in-flight fetch via `inFlightAbortController`,
   * fall back to subprocess kill if HTTP abort hangs.
   */
  protected onSuperseded(): void {
    log('lease revoked — aborting in-flight + posting /session/abort');
    const ctrl = this.inFlightAbortController;
    this.inFlightAbortController = null;
    if (ctrl) {
      try { ctrl.abort(); } catch (err) { log('abort threw:', (err as Error)?.message ?? err); }
    }
    if (this.openCodeSessionId && this.bridge) {
      // Fire-and-forget — the SSE consumer above will tear down on its
      // own; this just nudges OpenCode to release the session.
      void this.bridge.abortSession(this.openCodeSessionId)
        .catch((err) => log('graceful abort failed:', (err as Error)?.message ?? err));
    }
  }

  /**
   * Subprocess entry point. Boots `opencode serve`, connects Temporal,
   * claims the attachment, runs the poll loop. The optional-dep gate at
   * module load (above) has already exited the process if the SDK isn't
   * installed, so by the time `run()` executes we know it's available.
   */
  async run(): Promise<void> {
    const config = getConfig();
    const isConductor = process.env[ENV.CONDUCTOR] === 'true';
    const requestedName = process.env[ENV.PLAYER_NAME] || '';
    const playerIdForWorkflow = isConductor
      ? 'conductor'
      : (requestedName && requestedName !== 'conductor' ? requestedName : '') || `opencode-${Date.now()}`;
    const expectedWorkflowId = `agent-session-${config.ensemble}-${playerIdForWorkflow}`;
    const workDir = process.cwd();

    log(`Starting opencode adapter in ${workDir} (ensemble: ${config.ensemble}, player: ${playerIdForWorkflow}, model: ${this.model})`);

    // (1) Probe a free port on loopback. Cheap insurance against port 4096
    // collisions in CI / multi-ensemble setups.
    this.port = await probeFreePort();
    log(`Probed free port: ${this.port}`);

    // (2) Synthesize OPENCODE_CONFIG_CONTENT. Provider env auto-detected
    // from the model's `provider/...` prefix; secrets stay as `{env:VAR}`
    // markers (OpenCode resolves at read time).
    const mcpServerPath = path.resolve(__dirname, '../../server.js');
    const configContent = synthesizeOpenCodeConfig({
      model: this.model,
      port: this.port,
      mcpServerPath,
      ensemble: config.ensemble,
      playerName: playerIdForWorkflow,
      temporalAddress: config.temporalAddress,
      temporalNamespace: config.temporalNamespace,
    });
    log(`Synthesized OPENCODE_CONFIG_CONTENT: ${redactSecrets(configContent)}`);

    // (3) Spawn opencode serve. Stdio redirected to a per-player log file
    // so terminal noise from opencode doesn't clutter the adapter's log.
    const logDir = path.join(workDir, 'logs');
    fs.mkdirSync(logDir, { recursive: true });
    const opencodeLogFile = path.join(logDir, `opencode-${playerIdForWorkflow}.log`);
    const logFd = fs.openSync(opencodeLogFile, 'a');
    // Windows: npm-installed binaries land as `.cmd` shims. Node's
    // `CreateProcess` won't run `.cmd` files directly, and `shell: true`
    // trips DEP0190 (the args-not-escaped warning). Use the same
    // `cmd.exe /c <bin> <args>` pattern that `spawnInTerminal` uses for
    // Windows Terminal — explicit, no shell: true, no deprecation.
    const isWindows = process.platform === 'win32';
    const spawnCmd = isWindows ? 'cmd.exe' : 'opencode';
    const spawnArgs = isWindows
      ? ['/c', 'opencode', 'serve', '--port', String(this.port), '--hostname', '127.0.0.1']
      : ['serve', '--port', String(this.port), '--hostname', '127.0.0.1'];
    try {
      this.serveProcess = spawn(
        spawnCmd,
        spawnArgs,
        {
          // Loopback hardcoded — see config.ts SECURITY note + ADR 0015 §53.
          stdio: ['ignore', logFd, logFd],
          env: { ...process.env, OPENCODE_CONFIG_CONTENT: configContent },
          // `detached: false` — child dies when parent dies (Linux) or is
          // killed via job object (Windows). We add explicit signal
          // handling below to clean up on SIGTERM/SIGINT.
          detached: false,
        },
      );
    } finally {
      // Close our fd handle immediately — the spawn cloned it for the child.
      try { fs.closeSync(logFd); } catch { /* ignore */ }
    }
    if (!this.serveProcess.pid) {
      throw new Error('Failed to spawn `opencode serve` — is the binary on PATH?');
    }
    log(`Spawned opencode serve (pid=${this.serveProcess.pid}, port=${this.port}, log=${opencodeLogFile})`);

    // Surface early child-exit (e.g. ENOENT, missing config) loudly. The
    // health-probe loop below would also catch this but with a less
    // diagnostic error.
    this.serveProcess.once('exit', (code, signal) => {
      log(`opencode serve exited (code=${code ?? 'null'}, signal=${signal ?? 'null'})`);
    });

    // (4) Health-probe + version-drift gate.
    this.bridge = new OpenCodeServerBridge({
      baseUrl: `http://127.0.0.1:${this.port}`,
      log,
    });
    await this.bridge.waitForHealth(HEALTH_PROBE_TIMEOUT_MS);
    try {
      const health = await this.bridge.getHealth();
      if (!isVersionMatch(health.version, TESTED_OPENCODE_VERSION)) {
        log(`WARNING: opencode version ${health.version} drift from tested ${TESTED_OPENCODE_VERSION}`);
      } else {
        log(`opencode version ${health.version} (matches tested ${TESTED_OPENCODE_VERSION})`);
      }
    } catch (err) {
      // Health endpoint returned but version field missing / malformed —
      // log + continue. Version-drift is diagnostic, not blocking.
      log(`getHealth post-ready failed: ${(err as Error)?.message ?? err}`);
    }

    // (5) Connect Temporal, wait for workflow, hand client to BaseAttachment.
    const connection = await createTemporalConnection(config);
    const client = new Client({ connection, namespace: config.temporalNamespace });
    this.configureV2(client, os.hostname());

    log(`Waiting for workflow ${expectedWorkflowId} to register...`);
    let handle = client.workflow.getHandle(expectedWorkflowId);
    let pinnedRunId: string | undefined;
    let workflowReady = false;
    for (let attempt = 0; attempt < WORKFLOW_REGISTER_ATTEMPTS; attempt++) {
      try {
        const desc = await handle.describe();
        if (desc.status.name === 'RUNNING') {
          workflowReady = true;
          pinnedRunId = desc.runId;
          break;
        }
      } catch { /* not yet started */ }
      await sleep(WORKFLOW_REGISTER_INTERVAL_MS);
      if (attempt % 5 === 4) log(`Still waiting for workflow... attempt ${attempt + 1}/${WORKFLOW_REGISTER_ATTEMPTS}`);
    }
    if (!workflowReady) {
      log(`ERROR: Workflow ${expectedWorkflowId} did not register within ${WORKFLOW_REGISTER_ATTEMPTS}s — exiting`);
      await this.killSubprocessChain();
      process.exit(1);
    }
    handle = client.workflow.getHandle(expectedWorkflowId, pinnedRunId);
    log(`Workflow ready: ${expectedWorkflowId} (pinned runId ${pinnedRunId})`);

    // (6) Build cached system prompt — claude-tempo MCP_INSTRUCTIONS plus
    // the opencode-specific addendum. Sent every turn; OpenCode caches
    // server-side per its provider transform layer.
    this.systemPrompt = buildServerInstructions({
      ensemble: config.ensemble,
      playerId: playerIdForWorkflow,
      isConductor,
      hasRequestedName: true,
    }) + HEADLESS_OPENCODE_ADDENDUM;
    this.playerName = playerIdForWorkflow;

    // (7) Wire terminal-cleanup hook BEFORE claiming so a race between
    // claim + lease loss can't drop the event.
    let shuttingDown = false;
    const cleanup = async () => {
      if (shuttingDown) return;
      shuttingDown = true;
      log('Cleanup running...');

      // Best-effort opencode session teardown — avoids leaking server-side
      // state if the subprocess outlives this call.
      if (this.openCodeSessionId && this.bridge) {
        await this.bridge.abortSession(this.openCodeSessionId).catch(() => { /* best-effort */ });
        await this.bridge.deleteSession(this.openCodeSessionId).catch(() => { /* best-effort */ });
      }

      try { await this.detachGracefully('user-stop'); }
      catch (err) { log('detachGracefully error:', (err as Error)?.message ?? err); }

      await this.killSubprocessChain();
    };
    this.onTerminal((reason) => {
      log(`V2 terminal (${reason}) — triggering cleanup`);
      cleanup().catch((err) => log('terminal cleanup error:', (err as Error)?.message ?? err));
    });

    // (8) Claim the attachment via V2 lifecycle.
    try {
      const expectedAttachmentId = process.env[ENV.ATTACHMENT_ID] || undefined;
      handle = await this.startV2Lifecycle(expectedWorkflowId, expectedAttachmentId);
      log(`V2 attachment claimed (attachmentId=${this.token?.attachmentId}${expectedAttachmentId ? ', renewed' : ''})`);
    } catch (err) {
      log(`ERROR: V2 claimAttachment failed: ${(err as Error)?.message ?? err}`);
      await cleanup();
      process.exit(1);
    }

    // (9) PID file — two lines (adapter PID + opencode-serve PID) per
    // design §6.5. Operators can grep / kill either.
    const pidFile = path.join(logDir, `${playerIdForWorkflow}.pid`);
    try {
      fs.writeFileSync(pidFile, `${process.pid}\n${this.serveProcess.pid ?? ''}\n`);
    } catch (err) {
      log(`Warning: PID file write failed: ${(err as Error)?.message ?? err}`);
    }

    // (10) Signal handlers. SIGTERM behaviour on Windows differs from POSIX
    // (ADR 0015 §84) — handled below in killSubprocessChain.
    const shutdown = async () => {
      log('Shutting down (signal received)...');
      await cleanup();
      try { fs.unlinkSync(pidFile); } catch { /* gone */ }
      process.exit(0);
    };
    process.on('SIGINT', shutdown);
    process.on('SIGTERM', shutdown);

    // (11) Drive the poll loop.
    await this.pollLoop(handle);
    try { fs.unlinkSync(pidFile); } catch { /* gone */ }
  }

  /**
   * Poll the workflow for pending messages; call `deliver()` per batch.
   * Mirrors claude-api / copilot — only the `invokeSdk` body differs.
   */
  private async pollLoop(handle: WorkflowHandle): Promise<void> {
    let polling = true;
    let processing = false;
    let pollCount = 0;

    while (polling && !this.shouldStop()) {
      pollCount++;

      // Periodic workflow-status check — detect external destroy / completion.
      if (pollCount % WORKFLOW_STATUS_CHECK_INTERVAL === 0) {
        try {
          const desc = await handle.describe();
          if (desc.status.name !== 'RUNNING') {
            log(`Workflow status is ${desc.status.name} — exiting cleanly`);
            polling = false;
            break;
          }
          try {
            const isDestroyed = await handle.query(isDestroyedQuery);
            if (isDestroyed) {
              log('Workflow destroyed — exiting cleanly');
              polling = false;
              break;
            }
          } catch { /* isDestroyed query unavailable on pre-upgrade workflows — safe to skip */ }
        } catch (err) {
          log(`Workflow describe failed: ${(err as Error)?.message ?? err} — treating as terminated`);
          polling = false;
          break;
        }
      }

      if (processing) {
        await sleep(POLL_INTERVAL_MS);
        continue;
      }

      let messages: Message[] = [];
      try {
        messages = await handle.query(pendingMessagesQuery);
      } catch (err) {
        log(`pendingMessages query failed: ${(err as Error)?.message ?? err}`);
        await sleep(POLL_INTERVAL_MS);
        continue;
      }
      if (messages.length === 0) {
        await sleep(POLL_INTERVAL_MS);
        continue;
      }

      processing = true;
      try {
        const ackIds = messages.map((m) => m.id);
        // The whole batch is delivered as one OpenCode prompt — the
        // representative `messages[0]` only drives processingStart/End.
        await this.deliver(
          handle,
          messages[0],
          /* prompt unused — invokeSdk reads `messages` directly via closure */ '',
          TURN_TIMEOUT_MS,
          (timeoutPrompt, timeoutMs) => this.invokeSdkWithBatch(messages, timeoutPrompt, timeoutMs),
          ackIds,
        );
      } catch (err) {
        log(`deliver error: ${(err as Error)?.message ?? err}`);
        // Don't exit the loop — transient failures leave messages PENDING
        // for the next poll. Only terminal events (lease loss, destroy)
        // exit via onTerminal / status-check above.
      } finally {
        processing = false;
      }
    }

    log('Poll loop exiting');
  }

  /** True once `onTerminal` fired and cleanup tore down the V2 token. */
  private shouldStop(): boolean {
    return this.token === null;
  }

  /**
   * Per-turn LLM dispatch. Closes over the message batch so SdkAttachment's
   * `invokeSdk` callback can stay (prompt, timeoutMs) shaped while the
   * actual driving data is the `messages[]` from the poll.
   *
   * Steps per design §5.4:
   *   1. Ensure OpenCode session exists (create on first turn, stash id
   *      on workflow metadata via the existing updateMetadataSignal
   *      sessionId field — same field copilot uses).
   *   2. Subscribe to `/event` SSE.
   *   3. POST `/session/:id/prompt_async` (returns 204, turn streams).
   *   4. Consume SSE until `finish` reason — accumulate text, observe
   *      tool-use breadcrumbs.
   *   5. Log per-turn `turn-usage` line (design §5.6).
   */
  private async invokeSdkWithBatch(
    messages: Message[],
    _prompt: string,
    _timeoutMs: number,
  ): Promise<SdkDeliverResult> {
    // `bridge` and `pinnedHandle` are guaranteed initialized by `run()`
    // before the poll loop ever enters `deliver()`. Narrow once via
    // non-null assertions so the rest of the method reads cleanly.
    const bridge = this.bridge!;
    const handle = this.pinnedHandle!;

    // (1) Lazy-create the OpenCode session on first turn. Q6 carry-forward
    // (design §5.2): Path A is implemented (re-attach to stashed id on
    // restart). If the impl-time experiment shows OpenCode does NOT
    // persist sessions across server restart, swap this for the
    // workflow-history rebuild path documented in README.md.
    if (!this.openCodeSessionId) {
      const session = await bridge.createSession();
      this.openCodeSessionId = session.id;
      try {
        await handle.signal(updateMetadataSignal, { sessionId: session.id });
      } catch (err) {
        log(`updateMetadata sessionId signal failed: ${(err as Error)?.message ?? err}`);
      }
      log(`Created OpenCode session ${session.id}`);
    }
    const sessionId = this.openCodeSessionId;

    // (2) Build the new turn's parts. Multi-cue batching mirrors
    // claude-api's history-fold pattern: every queued message becomes
    // one labelled text part; OpenCode appends to its server-side history.
    const parts: Array<{ type: 'text'; text: string }> = messages.map((m) => ({
      type: 'text',
      text: `[from ${m.from}]: ${m.text}`,
    }));

    this.inFlightAbortController = new AbortController();
    const t0 = Date.now();
    let assistantText = '';
    let stopReason: string | null = null;
    let usage: Record<string, number> | null = null;
    let providerSeen: string | null = null;

    try {
      // (3) Subscribe to SSE BEFORE posting prompt_async — a tight race
      // window otherwise drops the early `Message` events that announce
      // the turn's session. SSE consumer iterates concurrently with the
      // prompt_async fetch.
      const sse = bridge.subscribeEvents(this.inFlightAbortController.signal);

      // (4) Post the turn. Returns 204 immediately; output streams over SSE.
      await bridge.promptAsync(sessionId, {
        model: this.model,
        system: this.systemPrompt,
        parts,
      });

      // (5) Consume SSE until finish.
      for await (const event of sse) {
        if (!isEventForSession(event, sessionId)) continue;
        const summary = consumeEvent(event);
        if (summary.text) assistantText += summary.text;
        if (summary.toolName) log(`tool=${summary.toolName} session=${sessionId}`);
        if (summary.providerSeen && !providerSeen) providerSeen = summary.providerSeen;
        if (summary.usage) usage = { ...(usage ?? {}), ...summary.usage };
        if (summary.stopReason) {
          stopReason = summary.stopReason;
          break;
        }
        if (summary.errorMessage) {
          throw new Error(`OpenCode SSE error: ${summary.errorMessage}`);
        }
      }
    } finally {
      this.inFlightAbortController = null;
    }

    // (6) Per-turn telemetry — design §5.6. Provider attribution from the
    // event stream if available, otherwise inferred from the model prefix.
    const provider = providerSeen ?? (this.model.split('/')[0] || 'unknown');
    if (usage) {
      log(`turn-usage provider=${provider} model=${this.model} input=${usage.input_tokens ?? 0} output=${usage.output_tokens ?? 0} cache_read=${usage.cache_read_input_tokens ?? 0} elapsed_ms=${Date.now() - t0} player=${this.playerName} stop_reason=${stopReason ?? 'none'}`);
    }

    return {
      sdkResult: { assistantText, stopReason, usage, provider },
      elapsedMs: Date.now() - t0,
    };
  }

  /**
   * SIGTERM → SIGKILL escalation on the `opencode serve` subprocess.
   * Idempotent — racing signals during cleanup are safe.
   *
   * On Windows, Bun-runtime SIGTERM may not propagate cleanly (ADR 0015
   * §84). The fallback to SIGKILL after `SIGTERM_TIMEOUT_MS` covers this
   * case without per-platform branching.
   */
  private async killSubprocessChain(): Promise<void> {
    const p = this.serveProcess;
    if (!p || p.killed) return;
    try { p.kill('SIGTERM'); } catch (err) { log(`SIGTERM threw: ${(err as Error)?.message ?? err}`); }
    const exitCode = await waitForExit(p, SIGTERM_TIMEOUT_MS);
    if (exitCode === null) {
      log(`opencode serve did not exit within ${SIGTERM_TIMEOUT_MS}ms — escalating to SIGKILL`);
      try { p.kill('SIGKILL'); } catch (err) { log(`SIGKILL threw: ${(err as Error)?.message ?? err}`); }
    }
  }
}

/**
 * Filter SSE events to a specific session id. OpenCode's `/event` stream
 * is global per `opencode serve` instance — we only act on events whose
 * payload carries our session's id. Permissive shape — events that
 * don't carry a session id are passed through (they're typically
 * server-level signals like `error` or `health.update`).
 */
function isEventForSession(event: OpenCodeEvent, sessionId: string): boolean {
  // Common shapes seen in v1.14.x: `properties.sessionID`, `properties.session_id`,
  // top-level `sessionID`. Be lenient — drop only events that explicitly carry
  // a different session id.
  const candidates: Array<unknown> = [
    (event as Record<string, unknown>).sessionID,
    (event as Record<string, unknown>).session_id,
    ((event as Record<string, unknown>).properties as Record<string, unknown> | undefined)?.sessionID,
    ((event as Record<string, unknown>).properties as Record<string, unknown> | undefined)?.session_id,
    ((event as Record<string, unknown>).info as Record<string, unknown> | undefined)?.sessionID,
  ];
  for (const c of candidates) {
    if (typeof c === 'string') {
      return c === sessionId;
    }
  }
  // No session id on the event — not session-scoped, pass through.
  return true;
}

/** Slice of an event the consumer cares about. Permissive on shape. */
interface EventSummary {
  text?: string;
  toolName?: string;
  providerSeen?: string;
  usage?: Record<string, number>;
  stopReason?: string | null;
  errorMessage?: string;
}

/**
 * Reduce one OpenCode SSE event into the bits the consumer needs. v1.14.x
 * event shapes are still labeled experimental (ADR 0015 §82), so this is
 * deliberately tolerant — unknown shapes are silently ignored.
 */
const EVENT_TYPES = {
  /** Text deltas; `properties.part.type === 'text'` carries the chunk. */
  MESSAGE_PART_UPDATED: 'message.part.updated',
  /** Assistant turn metadata — stop_reason + usage when role=assistant. */
  MESSAGE_UPDATED: 'message.updated',
  /** Tool-use breadcrumb — observability only; OpenCode owns dispatch. */
  TOOL_CALLED: 'tool.called',
  /** Server-level error — propagated as a thrown Error in the consumer. */
  ERROR: 'error',
} as const;

function consumeEvent(event: OpenCodeEvent): EventSummary {
  const summary: EventSummary = {};
  const props = (event as Record<string, unknown>).properties as Record<string, unknown> | undefined;

  if (event.type === EVENT_TYPES.MESSAGE_PART_UPDATED && props) {
    const part = props.part as Record<string, unknown> | undefined;
    if (part && part.type === 'text' && typeof part.text === 'string') {
      summary.text = part.text;
    }
  }

  if (event.type === EVENT_TYPES.TOOL_CALLED && props) {
    const name = props.name ?? props.tool;
    if (typeof name === 'string') summary.toolName = name;
  }

  if (event.type === EVENT_TYPES.MESSAGE_UPDATED && props) {
    const message = props.message as Record<string, unknown> | undefined;
    if (message) {
      const role = message.role;
      const stopReason = message.stop_reason ?? message.finishReason ?? message.finish_reason;
      const usageBlock = message.usage as Record<string, unknown> | undefined;
      const provider = (message.providerID ?? message.provider) as string | undefined;
      if (provider && typeof provider === 'string') summary.providerSeen = provider;
      if (role === 'assistant' && typeof stopReason === 'string') {
        summary.stopReason = stopReason;
      }
      if (usageBlock) {
        const numericUsage: Record<string, number> = {};
        for (const [k, v] of Object.entries(usageBlock)) {
          if (typeof v === 'number') numericUsage[k] = v;
        }
        if (Object.keys(numericUsage).length > 0) summary.usage = numericUsage;
      }
    }
  }

  if (event.type === EVENT_TYPES.ERROR && props) {
    const message = props.message ?? (props.error as Record<string, unknown> | undefined)?.message;
    summary.errorMessage = typeof message === 'string' ? message : 'unknown OpenCode error';
  }

  return summary;
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

if (require.main === module) {
  if (!opencodeSdkAvailable) process.exit(1);
  const model = process.env[ENV.OPENCODE_MODEL];
  new OpenCodeAttachment(model ? { model } : {}).run().catch((err) => {
    log('Fatal error:', err);
    process.exit(1);
  });
}
