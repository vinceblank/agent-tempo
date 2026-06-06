/**
 * agent-tempo Pi extension — interactive (Phase 2) + headless (Phase 3a) runtime.
 *
 *   createPiExtension({ mode, toolAccess })  →  (pi: ExtensionAPI) => void
 *   export default = createPiExtension()      (interactive)
 *
 * Registers the FULL agent-tempo tool surface natively on Pi (shared
 * transport-neutral descriptors + `renderToPi`), drives the attachment phase
 * from Pi lifecycle events, holds an attachment lease + heartbeat, and pumps
 * cues into the live session. The SAME extension runs interactive (behind a
 * human `pi` CLI) and headless (injected into `createAgentSession` by the daemon
 * — Phase 3a); `mode` is the only behavioural discriminator (it gates the MD-C
 * tool_call enforcement, which applies to unsupervised headless players only).
 *
 * ── Module-scope singleton (CRITICAL — researcher finding) ──
 * Pi REBUILDS the extension instance on every SessionManager switch, so
 * per-INSTANCE state does NOT survive. Everything that must survive — the
 * Temporal `Client`, the fixed `workflowId`, the pinned handle, the heartbeat
 * timer, the cue pump, the current-session pointer — lives in a MODULE-SCOPE
 * singleton (`runtimes`, keyed by workflowId; one entry interactive, N for the
 * headless daemon — D12a). The rebuilt instance RE-BINDS; it never recreates.
 *
 * ── Teardown (Option C — reason-discriminated) ──
 * `session_shutdown` carries `reason` {quit|reload|new|resume|fork}. We detach
 * ONLY on a clean `quit`; switch/unknown reasons → rebind (no detach). The
 * `quit` detach is best-effort; the MD-A lease reaper is the permanent floor.
 * Headless owns its exit sequence, so it uses {@link detachAllPiRuntimesForExit}
 * for RELIABLE detach (await adapterExited) before disposing the SDK session.
 *
 * Determinism boundary: this module (and all of src/pi/) is CLIENT-SIDE only.
 */
import * as os from 'os';
import * as crypto from 'crypto';
import type { Client, WorkflowHandle } from '@temporalio/client';
import { getConfig, ENV, sessionWorkflowId, type Config } from '../config';
import type { AgentType, SessionMetadata } from '../types';
import { buildAllTempoTools, type RegisterAllTempoToolsOpts } from '../server-tools';
import type {
  ExtensionAPI, PiAgentSession, PiEventPayload, PiToolCallEvent, PiToolCallResult, PiExtensionContext,
} from './pi-types';
import { PhaseDriver } from './phase-driver';
import { PiWorkflowClient } from './workflow-client';
import { CuePump, buildPiInjector } from './cue-pump';
import { ResetPump } from './reset-pump';
import { renderToPi } from './render-tools';
import { createLazyProxy } from './lazy-proxy';
import { probePi } from './probe';
import { InnerLoopPublisher, truncateSummary } from './inner-loop-publisher';
import { InnerLoopHttpClient } from './inner-loop-client';
import { GateClient } from './gate-client';
import { classify } from './tool-capability';
import { GATE_AUTO_ALLOW_MS } from '../http/gate-registry';

const log = (...args: unknown[]): void => {
  // eslint-disable-next-line no-console
  console.error('[agent-tempo:pi]', ...args);
};

const nowIso = (): string => new Date().toISOString();

// Pi IS a first-class AgentType (#666). #676 FIX-2: was a stale 'claude'
// placeholder — that made a Pi session misreport its agentType metadata AND
// recruit's mirror-fallback resolve to 'claude'.
const PI_AGENT_TYPE: AgentType = 'pi';

/** Runtime mode. Headless = recruited unsupervised player (MD-C gate active). */
export type PiExtensionMode = 'interactive' | 'headless';
export type PiToolAccess = 'restricted' | 'standard' | 'full';

/**
 * B1 runtime guard (#645 H4) — the type gate's blind spot.
 *
 * `PiEventPayload.session` is UNDECLARED in Pi 0.78's `.d.ts` — it's an
 * interactive-only RUNTIME field, so the pi-drift type gate can't assert it. In
 * INTERACTIVE mode the `session_start` payload MUST carry `session` (the cue +
 * reset pumps inject into it); a null session there means injection is silently
 * inert — a likely Pi API drift. (Headless legitimately omits it — it wires
 * `rt.session` via `setRuntimeSession` — so the guard is interactive-only.)
 *
 * Pure + injected `warn` so it unit-tests without the workflow harness.
 */
export function warnIfInteractiveSessionMissing(
  mode: PiExtensionMode,
  payload: { session?: unknown },
  warn: (msg: string) => void,
): void {
  if (mode === 'interactive' && payload.session == null) {
    warn(
      'WARNING: interactive session_start carried no session — cue/reset injection inert; ' +
        'possible Pi API drift (#645)',
    );
  }
}

export interface PiExtensionOptions {
  /** Default `'interactive'`. Headless installs the MD-C tool_call gate. */
  mode?: PiExtensionMode;
  /** MD-C tool-class policy (headless only). Default `'restricted'`. */
  toolAccess?: PiToolAccess;
}

// MD-C shell/exec tool-class membership is owned by `tool-capability.ts`
// (`classify(name) === 'exec'`, content signed off by tempo-security). F1
// import-refactor (3d): this REPLACES the former local `SHELL_TOOL_NAMES` set —
// the canonical EXEC_TOOLS set is a SUPERSET that also blocks
// powershell/pwsh/cmd/run, closing the gap the local list left open. Single
// source of truth: never re-declare a shell denylist here.

// ── Module-scope Temporal Client singleton (D12a: one Client per OS process) ──
let sharedClientPromise: Promise<Client> | null = null;
let connectedClient: Client | null = null;
function getSharedClient(config: Config): Promise<Client> {
  if (!sharedClientPromise) {
    sharedClientPromise = PiWorkflowClient.connect(config)
      .then((c) => { connectedClient = c; return c; })
      .catch((err) => { sharedClientPromise = null; log('Temporal connect failed:', err); throw err; });
  }
  return sharedClientPromise;
}

/** Connection factory; overridable via `__setPiClientFactoryForTests`. */
let clientFactory: (config: Config) => Promise<Client> = getSharedClient;

/**
 * Per-PLAYER runtime — lives in the module-scope `runtimes` map and SURVIVES Pi
 * extension-instance rebuilds. Holds the durable attachment (handle + lease +
 * heartbeat, inside `wf`), the phase driver, the cue pump, and the session ptr.
 */
export interface PiPlayerRuntime {
  readonly workflowId: string;
  readonly wf: PiWorkflowClient;
  readonly driver: PhaseDriver;
  readonly pump: CuePump;
  /**
   * 3c — inner-loop publisher: observes Pi events to maintain Tier-1 coarse state
   * (sampled by the heartbeat via `wf.setCoarseProvider`) and forward Tier-2 fine
   * frames to the daemon (presence-gated, off-wire). Started on first attach,
   * stopped on teardown.
   */
  readonly pub: InnerLoopPublisher;
  /** 3d D14 — polls the workflow's pending reset → clean-wipe (newSession) + ack. */
  readonly reset: ResetPump;
  session: PiAgentSession | null;
  /**
   * #677 — THIS player's CURRENT Pi `ExtensionAPI` handle. Repointed on every
   * instance rebuild (`session_start` re-bind) so the cue pump injects through the
   * live `pi.sendMessage` (the stable interactive-injection path; Pi 0.78.1's
   * SessionStartEvent has no `session` field). Re-resolved per tick — never captured.
   */
  pi: ExtensionAPI | null;
  /**
   * #677 — epoch-ms of the last observed `turn_start`/`agent_start`. The cue pump
   * reads it to decide whether a sendMessage-injected cue actually woke a turn; if
   * not, it escalates to `sendUserMessage`. `null` until the first turn starts.
   */
  lastTurnStartAt: number | null;
  lastSessionId?: string;
}

/** One runtime per player, keyed by fixed workflowId. Survives instance rebuilds. */
const runtimes = new Map<string, PiPlayerRuntime>();

/**
 * Build the Pi extension factory. `mode='headless'` installs the MD-C tool_call
 * gate; `mode='interactive'` (default) does not (the human owns their machine).
 */
export function createPiExtension(options: PiExtensionOptions = {}): (pi: ExtensionAPI) => void {
  const mode: PiExtensionMode = options.mode ?? 'interactive';
  const toolAccess: PiToolAccess = options.toolAccess ?? 'restricted';

  return function piExtension(pi: ExtensionAPI): void {
    const probe = probePi();
    if (!probe.available) log('WARNING:', probe.reason);

    const config: Config = getConfig();
    const isConductor = process.env[ENV.CONDUCTOR] === '1' || process.env[ENV.CONDUCTOR] === 'true';

    // Identity — FIXED workflowId for the process lifetime. `currentPlayerId` is
    // the mutable DISPLAY id (set_name updates it); the workflowId never repoints.
    let currentPlayerId = process.env[ENV.PLAYER_NAME] || `pi-${process.pid}`;
    const workflowId = sessionWorkflowId(config.ensemble, currentPlayerId);
    // 3c — the inner-loop URL + ingest token are keyed to the player's FIXED
    // identity (the daemon minted the token for sessionWorkflowId(ensemble,
    // <recruit name>)). `currentPlayerId` is mutable (set_name), so capture the
    // original here — the publisher's HTTP client URL must match the workflowId.
    const fixedPlayerId = currentPlayerId;

    // Kick off (or reuse) the module-scope shared connection.
    void clientFactory(config);

    // ── D11 lazy proxies: resolve MODULE-SCOPE state per call (instance-independent) ──
    const clientProxy = createLazyProxy<Client>(() => connectedClient, 'Temporal client');
    const handleProxy = createLazyProxy<WorkflowHandle>(
      () => runtimes.get(workflowId)?.wf.handle ?? null,
      'workflow handle',
    );

    // ── Register the FULL tool surface on THIS instance's `pi` ──
    const toolOpts: RegisterAllTempoToolsOpts = {
      client: clientProxy,
      config,
      getPlayerId: () => currentPlayerId,
      setPlayerId: (id: string) => { currentPlayerId = id; },
      handle: handleProxy,
      workflowId,
      ownAgentType: PI_AGENT_TYPE,
      isConductor,
    };
    renderToPi(pi, buildAllTempoTools(toolOpts));
    log(`registered tools (player=${currentPlayerId}, conductor=${isConductor}, mode=${mode})`);

    // ── MD-C tool-access gate (HEADLESS ONLY) ──
    // Interactive Pi = a human owns their machine → no gate. Headless = recruited
    // unsupervised → MD-C governs tool access. TOOL-CLASS CHECK FIRST: shell/exec
    // tools are HARD-BLOCKED at toolAccess='restricted' (the safe unsupervised
    // default) regardless of any later gate logic. The supervised gate (3d) slots
    // in AFTER this MD-C floor — for now, anything MD-C permits is allowed.
    if (mode === 'headless') {
      // 3d MD-G — the operator gate's two loopback clients, keyed to the FIXED
      // player identity (matches the ingest token + workflowId). `gateInner`
      // emits the gate_pending frame (the daemon's ingest side-effect registers
      // the pending) and reports presence {subscribers, gateArmed}; `gateClient`
      // polls the daemon for the operator's decision. Both no-op without the
      // ingest token (so this is inert for a manually-launched headless Pi).
      const gateInner = new InnerLoopHttpClient({ ensemble: config.ensemble, playerId: fixedPlayerId });
      const gateClient = new GateClient({ ensemble: config.ensemble, playerId: fixedPlayerId });

      (pi.on as unknown as (
        e: string,
        h: (ev: PiToolCallEvent, ctx?: PiExtensionContext) => PiToolCallResult | Promise<PiToolCallResult>,
      ) => void)(
        'tool_call',
        async (event: PiToolCallEvent, ctx?: PiExtensionContext): Promise<PiToolCallResult> => {
          const cls = classify(event.toolName);
          // 1) MD-C tool-class FLOOR (fires FIRST). classify()==='exec' is the
          //    canonical EXEC set (F1) — a SUPERSET that hard-blocks
          //    powershell/pwsh/cmd/run at restricted. HARD-block, never gated.
          if (cls === 'exec' && toolAccess === 'restricted') {
            log(`MD-C: blocked '${event.toolName}' (toolAccess=restricted)`);
            return {
              block: true,
              reason: `toolAccess=restricted: shell/exec tools are disabled for this headless Pi player`,
            };
          }
          // 2) MD-G OPERATOR GATE — engage for any non-low-risk tool WHEN an
          //    operator is armed AND present (both read from the short-poll
          //    cached presence). low-risk bypasses; unknown→high-blast is gated-
          //    when-armed (R2). The await resolves on the operator's decision,
          //    the daemon's 45s auto-allow, ctx.signal cancel, or the bounded
          //    poll deadline — all FAIL-OPEN except an explicit deny.
          if (cls !== 'low-risk' && gateInner.gateArmed(workflowId) && gateInner.subscriberCount(workflowId) > 0) {
            const requestId = crypto.randomUUID();
            gateInner.publish(workflowId, {
              type: 'inner.gate_pending',
              requestId,
              tool: event.toolName,
              argsSummary: truncateSummary(event.input, 2048),
              classification: cls as 'exec' | 'high-blast', // low-risk already returned above
              timeoutMs: GATE_AUTO_ALLOW_MS,
              ts: Date.now(),
            });
            const effect = await gateClient.awaitDecision(requestId, { signal: ctx?.signal });
            if (effect === 'deny') {
              log(`MD-G: operator DENIED '${event.toolName}' (req ${requestId})`);
              return { block: true, reason: `operator denied ${event.toolName}` };
            }
            log(`MD-G: '${event.toolName}' permitted (req ${requestId})`);
            return {};
          }
          // 3) not gated → permit.
          return {};
        },
      );
      log(`MD-C+MD-G tool gate active (mode=headless, toolAccess=${toolAccess})`);
    }

    /** Build session metadata from the (current) identity + host. */
    function buildMetadata(): SessionMetadata {
      return {
        playerId: currentPlayerId,
        ensemble: config.ensemble,
        hostname: os.hostname(),
        workDir: process.cwd(),
        isConductor,
        agentType: PI_AGENT_TYPE,
        adapterId: 'pi',
      };
    }

    /** Persist the active Pi conversation id to metadata.sessionId IF it changed (P2-5). */
    async function refreshSessionId(rt: PiPlayerRuntime, sessionId: string | undefined): Promise<void> {
      if (!sessionId || sessionId === rt.lastSessionId) return;
      await rt.wf.updateSessionId(sessionId);
      rt.lastSessionId = sessionId;
    }

    /**
     * Get-or-create the runtime for this player. FIRST attach claims the lease +
     * starts the heartbeat + cue pump. A subsequent `session_start` (instance
     * rebuild) RE-BINDS the surviving runtime — session pointer only, no re-claim.
     */
    async function attachOrRebind(payload: PiEventPayload): Promise<PiPlayerRuntime> {
      const existing = runtimes.get(workflowId);
      if (existing) {
        existing.session = payload.session ?? existing.session;
        // #677 — repoint to THIS instance's `pi`. Pi rebuilds the extension
        // instance on every session switch; the surviving runtime + its cue pump
        // (created on first attach) re-resolve the injector from `rt.pi` each tick,
        // so the cue pump injects through the LIVE handle, not the stale one.
        existing.pi = pi;
        // #677 FREEBIE — the InnerLoopPublisher was captured-once on the FIRST pi
        // and goes stale after a switch (README:251 carry-item — same root cause).
        // Re-start it on the new pi so its `pi.on(...)` observers track the live
        // instance. `start()` re-registers handlers; its flush timer is idempotent.
        existing.pub.start(pi);
        log(`re-bound ${currentPlayerId} (Pi instance rebuilt; lease intact)`);
        return existing;
      }
      const client = await clientFactory(config);
      const wf = new PiWorkflowClient({
        client,
        config,
        metadata: buildMetadata(),
        expectedAttachmentId: process.env[ENV.ATTACHMENT_ID] || undefined,
      });
      const driver = new PhaseDriver();
      const pump = new CuePump({
        source: wf,
        // #677 — re-resolve the injector from the SURVIVING runtime each tick:
        // prefer `rt.pi.sendMessage` (stable interactive path), fall back to
        // `rt.session.sendCustomMessage`. Reading `runtimes.get(workflowId)` (not a
        // captured `rt`) is what makes a post-rebind tick use the NEW pi.
        resolveInjector: () => buildPiInjector(runtimes.get(workflowId) ?? null),
      });
      // 3c — inner-loop publisher + its loopback-HTTP sink. The client no-ops
      // unless AGENT_TEMPO_INGEST_TOKEN is present (daemon-spawned headless
      // players only), so interactive Pi gets Tier-1 coarse for free and zero
      // Tier-2 forwarding. URL keyed to the FIXED playerId (matches workflowId).
      const registry = new InnerLoopHttpClient({ ensemble: config.ensemble, playerId: fixedPlayerId });
      const pub = new InnerLoopPublisher({ workflowId, registry });
      // 3d D14 — reset poll-tick (sibling to the cue pump): polls pendingReset →
      // session.newSession() clean-wipe + ack. resolveSession re-acquired each
      // tick so a session switch never wipes a stale session.
      const reset = new ResetPump({
        source: wf,
        resolveSession: () => runtimes.get(workflowId)?.session ?? null,
      });
      const rt: PiPlayerRuntime = {
        workflowId, wf, driver, pump, pub, reset,
        session: payload.session ?? null,
        pi, // #677 — first-attach instance's pi (repointed on each rebind)
        lastTurnStartAt: null,
      };
      runtimes.set(workflowId, rt);

      await wf.ensureSessionWorkflow();
      const result = driver.handle('session_start', payload, nowIso());
      await wf.performAction(result.action); // claim → attached, starts heartbeat
      pump.start();
      // Start the publisher AFTER the claim (heartbeat is live → coarse samples
      // have a delivery path) and wire its coarse state into the heartbeat. The
      // bound method is wrapped so `this` survives the provider call.
      pub.start(pi);
      wf.setCoarseProvider(() => pub.getCoarseState());
      reset.start(); // 3d D14 — begin polling for pending resets
      log(`attached ${currentPlayerId} (wf ${workflowId})`);
      return rt;
    }

    // ── Lifecycle: session_start → first attach OR re-bind ──
    pi.on('session_start', async (payload: PiEventPayload) => {
      // B1 (#645 H4): warn loudly if interactive session_start lost its session.
      warnIfInteractiveSessionMissing(mode, payload, log);
      try {
        const rt = await attachOrRebind(payload);
        await refreshSessionId(rt, rt.session?.id);
      } catch (err) {
        log('session_start wiring failed:', err);
      }
    });

    // ── Lifecycle: phase-affecting events ──
    for (const event of ['agent_start', 'agent_end'] as const) {
      pi.on(event, async (payload: PiEventPayload) => {
        const rt = runtimes.get(workflowId);
        if (!rt) return;
        if (payload.session) rt.session = payload.session;
        // #677 — a turn has begun → stamp for the cue pump's escalation check (so
        // a sendMessage-injected cue that DID wake a turn is not re-escalated).
        if (event === 'agent_start') rt.lastTurnStartAt = Date.now();
        const result = rt.driver.handle(event, payload, nowIso());
        try {
          await rt.wf.performAction(result.action);
          if (event === 'agent_start') await refreshSessionId(rt, rt.session?.id);
        } catch (err) {
          log(`${event} → ${result.action.kind} failed:`, err);
        }
      });
    }

    // ── Lifecycle: activity-only events (NEVER drive phase) ──
    for (const event of [
      'turn_start', 'turn_end', 'tool_execution_start', 'tool_execution_end',
    ] as const) {
      pi.on(event, (payload: PiEventPayload) => {
        const rt = runtimes.get(workflowId);
        if (!rt) return;
        if (payload.session) rt.session = payload.session;
        // #677 — turn_start marks a live turn for the cue pump's escalation check.
        if (event === 'turn_start') rt.lastTurnStartAt = Date.now();
        rt.driver.handle(event, payload, nowIso());
      });
    }

    // ── Lifecycle: session_shutdown → Option C (reason-discriminated teardown) ──
    pi.on('session_shutdown', async (payload: PiEventPayload) => {
      const rt = runtimes.get(workflowId);
      if (!rt) return;
      rt.session = null; // switch gap: cue pump stops injecting (dodges Pi #2860)
      if (payload.reason === 'quit') {
        rt.pub.stop(); // 3c — stop observing + flush the trailing coalesce buffer
        rt.reset.stop(); // 3d — stop the reset poll
        try {
          await rt.wf.detach('agent-exited'); // requestDetach + adapterExited + stopHeartbeat
          runtimes.delete(workflowId);
        } catch (err) {
          log('quit detach (best-effort) failed — reaper will backstop:', err);
        }
      }
    });
  };
}

/**
 * RELIABLE detach for the headless exit sequence (Phase 3a). Headless owns its
 * exit loop, so — unlike interactive's best-effort `quit` path — it can AWAIT a
 * clean detach before disposing the SDK session. Ordering (architect ruling):
 * stopHeartbeat → requestDetach → adapterExited (all inside `wf.detach`) → unmap.
 * The caller then calls `session.dispose()`; the dispose-fired `session_shutdown`
 * finds no mapped runtime → no-op (avoids double-detach). Detaches every runtime
 * in the process (headless = one player per process).
 */
export async function detachAllPiRuntimesForExit(): Promise<void> {
  for (const rt of runtimes.values()) {
    rt.pub.stop(); // 3c — stop the inner-loop publisher before detaching
    rt.reset.stop(); // 3d — stop the reset poll before detaching
    try {
      await rt.wf.detach('agent-exited');
    } catch (err) {
      log('headless detach failed (reaper will backstop):', err);
    }
  }
  runtimes.clear();
}

/**
 * Headless-only: wire the live Pi SDK session onto a runtime so the cue pump can
 * inject into it. The interactive CLI's `session_start` payload carries
 * `session`, but the headless SDK's DEFAULT session_start payload does NOT (it's
 * `{ type, reason }`) — so `attachOrRebind` sets `rt.session = null` and the cue
 * pump's `resolveSession` returns null (every cue is dropped). The headless entry
 * HOLDS the session from `createAgentSession`, so it calls this after
 * `bindExtensions` (by which point the runtime exists + has claimed) to set it.
 * (3a live smoke — devops.)
 */
export function setRuntimeSession(workflowId: string, session: PiAgentSession): void {
  const rt = runtimes.get(workflowId);
  if (rt) {
    rt.session = session;
    log(`headless session wired to runtime (wf ${workflowId})`);
  } else {
    log(`setRuntimeSession: no runtime for ${workflowId} yet (session_start may not have fired)`);
  }
}

// ── Test-only hooks (ADR 0006 `__<verb><Noun>ForTests` convention) ──

/** Override the Temporal connection factory (inject a fake Client). */
export function __setPiClientFactoryForTests(factory: (config: Config) => Promise<Client>): void {
  clientFactory = factory;
}

/** Stop timers, clear the per-player runtime map + shared-client singletons + factory. */
export function __resetPiRuntimesForTests(): void {
  for (const rt of runtimes.values()) {
    rt.pub.stop();
    rt.reset.stop();
    rt.pump.stop();
    rt.wf.stopHeartbeat();
  }
  runtimes.clear();
  sharedClientPromise = null;
  connectedClient = null;
  clientFactory = getSharedClient;
}

/**
 * Seed a fake runtime into the module-scope `runtimes` map. TEST ESCAPE HATCH —
 * do NOT call from production code. The map is otherwise unreachable from a test;
 * this is the seam for covering lifecycle paths like {@link detachAllPiRuntimesForExit}.
 */
export function __seedRuntimeForTests(workflowId: string, rt: PiPlayerRuntime): void {
  runtimes.set(workflowId, rt);
}

/**
 * Clear the module-scope `runtimes` map WITHOUT timer/heartbeat teardown (for
 * afterEach isolation in runtime-seeding tests; use {@link __resetPiRuntimesForTests}
 * for the full singleton reset). TEST ESCAPE HATCH — do NOT call from production code.
 */
export function __clearRuntimesForTests(): void {
  runtimes.clear();
}

/**
 * Read the live runtime for a workflowId out of the module-scope map. TEST ESCAPE
 * HATCH — do NOT call from production code. Used by the #677 rebind test to assert
 * the post-switch tick injects through the NEW pi (cue pump) AND that the
 * InnerLoopPublisher rebound to it.
 */
export function __getPiRuntimeForTests(workflowId: string): PiPlayerRuntime | undefined {
  return runtimes.get(workflowId);
}

/** Default export — interactive-mode extension (the human `pi` CLI entry). */
const piExtension = createPiExtension();
export default piExtension;
