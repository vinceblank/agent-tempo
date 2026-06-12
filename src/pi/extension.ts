/**
 * agent-tempo Pi extension — interactive (Phase 2) + headless (Phase 3a) runtime.
 *
 *   createPiExtension({ mode })  →  (pi: ExtensionAPI) => void
 *   export default = createPiExtension()      (interactive)
 *
 * Registers the FULL agent-tempo tool surface natively on Pi (shared
 * transport-neutral descriptors + `renderToPi`), drives the attachment phase
 * from Pi lifecycle events, holds an attachment lease + heartbeat, and pumps
 * cues into the live session. The SAME extension runs interactive (behind a
 * human `pi` CLI) and headless (injected into `createAgentSession` by the daemon
 * — Phase 3a); `mode` discriminates only role resolution and the interactive
 * `/tempo-reset` command surface.
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
import type { Client, WorkflowHandle } from '@temporalio/client';
import { getConfig, ENV, resolvePiRole, sessionWorkflowId, type Config } from '../config';
import type { AgentType, SessionMetadata } from '../types';
import {
  buildAllTempoTools,
  buildServerInstructions,
  type RegisterAllTempoToolsOpts,
  type BuildServerInstructionsOpts,
} from '../server-tools';
import type {
  ExtensionAPI, PiAgentSession, PiEventPayload,
  PiBeforeAgentStartEvent, PiBeforeAgentStartResult,
} from './pi-types';
import { PhaseDriver } from './phase-driver';
import { PiWorkflowClient } from './workflow-client';
import { CuePump, buildPiInjector } from './cue-pump';
import { renderToPi } from './render-tools';
import { createLazyProxy } from './lazy-proxy';
import { probePi } from './probe';
import { InnerLoopPublisher } from './inner-loop-publisher';
import { InnerLoopHttpClient } from './inner-loop-client';

const log = (...args: unknown[]): void => {
  // eslint-disable-next-line no-console
  console.error('[agent-tempo:pi]', ...args);
};

const nowIso = (): string => new Date().toISOString();

// Pi IS a first-class AgentType (#666). #676 FIX-2: was a stale 'claude'
// placeholder — that made a Pi session misreport its agentType metadata AND
// recruit's mirror-fallback resolve to 'claude'.
const PI_AGENT_TYPE: AgentType = 'pi';

/** Runtime mode. Headless = recruited daemon-spawned player (no command surface). */
export type PiExtensionMode = 'interactive' | 'headless';

/**
 * Interactive-session breadcrumb (#645 H4 → reworded for #677).
 *
 * Pi 0.78.1's `SessionStartEvent` carries NO `session` field, so in INTERACTIVE
 * mode `payload.session` is null. Pre-#677 that meant cue/reset injection was inert
 * (it read `payload.session`), so this was a WARNING. Post-#677 injection routes
 * through the stable `pi.sendMessage` handle (re-resolved per tick) and a missing
 * session is the EXPECTED path — NOT an error. The "is `pi.sendMessage` still
 * wired?" correctness signal now lives at BUILD time in the H4 drift gate
 * (`test/pi-drift/assert.ts` `_passSendMsg` / `_sendSurfaceCallShape`), so this
 * runtime check's correctness role is redundant.
 *
 * What remains is value as a ONE-TIME, non-alarming boot breadcrumb: during Pi
 * bring-up it confirms at a glance "you're on the expected 0.78.1 no-session path;
 * cues route via pi.sendMessage." Fires AT MOST ONCE per process (the
 * module-scope `notedInteractiveSessionAbsent` flag) — not per switch, not per
 * tick. Pure + injected `note` so it unit-tests without the workflow harness.
 */
let notedInteractiveSessionAbsent = false;
export function noteInteractiveSessionAbsent(
  mode: PiExtensionMode,
  payload: { session?: unknown },
  note: (msg: string) => void,
): void {
  if (mode !== 'interactive' || payload.session != null) return;
  if (notedInteractiveSessionAbsent) return;
  notedInteractiveSessionAbsent = true;
  note(
    'interactive session_start has no `session` field — expected on Pi ≥0.78.1; ' +
      'cues/reset route via pi.sendMessage (re-resolved per tick).',
  );
}

export interface PiExtensionOptions {
  /** Default `'interactive'`. */
  mode?: PiExtensionMode;
}

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
 * Build the Pi extension factory. `mode='headless'` marks a daemon-spawned
 * recruited player; `mode='interactive'` (default) a human-driven `pi` CLI.
 */
export function createPiExtension(options: PiExtensionOptions = {}): (pi: ExtensionAPI) => void {
  const mode: PiExtensionMode = options.mode ?? 'interactive';

  return function piExtension(pi: ExtensionAPI): void {
    // ── #729 role gate (MUST stay first — before probePi / getConfig /
    // clientFactory / renderToPi / before_agent_start / any session_start claim) ──
    //
    // Headless Pi is definitionally a recruited player, so force 'player' on it —
    // never trust the env heuristic there (env-weirdness immune). Every INTERACTIVE
    // player spawn (conductor `up --agent pi`, `recruit`) sets PLAYER_NAME; a bare
    // `pi` does not. When this session is NOT a player, the player extension goes
    // FULLY DORMANT: it registers NO tools, opens NO Temporal connection (the
    // `clientFactory(config)` kickoff below is skipped), and starts NO workflow.
    //
    // This is load-bearing for two things at once: (1) it resolves the cue/recruit
    // tool-name COLLISION with mission-control (exactly one extension registers
    // tools per session), and (2) it kills the phantom `pi-${process.pid}` orphan
    // workflow a bare `pi` used to self-bootstrap (the `pi-${pid}` fallback id below
    // is now never reached in a non-player session).
    const role = mode === 'headless' ? 'player' : resolvePiRole();
    if (role !== 'player') {
      log(
        `dormant — session role is '${role}', not a player: registering no player ` +
        'surface (no tools, no Temporal connection, no workflow).',
      );
      return;
    }

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

    // ── #698 — FULL server-instruction preamble into the Pi system prompt ──
    // The Pi equivalent of MCP players' `buildServerInstructions` (#695 S2 seeded
    // this hook with just the 4 yield-norms; #698 widens it to the WHOLE preamble —
    // identity, cue/report/recruit guidance, Communication-discipline, and the
    // conductor/player operational rules). SINGLE-SOURCED off `buildServerInstructions`
    // so MCP + Pi guidance can't drift; the yield-norms now arrive FOLDED IN (they
    // live inside that builder since #695 S1), so there is no separate const.
    // `before_agent_start` exposes the fully-assembled systemPrompt and accepts a
    // replacement (chained across extensions), so we APPEND — injected into the
    // model's system prompt every turn, invisibly (NOT a sendMessage, which would
    // spam the transcript). Applies to ALL Pi players (interactive + headless).
    //
    // Opts are built PER FIRE (before_agent_start fires every turn): playerId and
    // hasRequestedName must reflect CURRENT state, so a `set_name`-renamed player
    // gets the right identity rather than the boot-time one.
    const piInstructionOpts = (): BuildServerInstructionsOpts => ({
      ensemble: config.ensemble,
      playerId: toolOpts.getPlayerId(),
      isConductor,
      playerType: process.env[ENV.PLAYER_TYPE] || undefined,
      // playerTypeDescription omitted (MVP — not threaded into the Pi runtime).
      hasRequestedName: Boolean(process.env[ENV.PLAYER_NAME]),
    });
    // Cast mirrors the tool_call returning-handler pattern (the shim's `on` is
    // void-typed; the real ExtensionAPI before_agent_start handler returns a result).
    (pi.on as unknown as (
      e: string,
      h: (ev: PiBeforeAgentStartEvent) => PiBeforeAgentStartResult,
    ) => void)(
      'before_agent_start',
      (ev: PiBeforeAgentStartEvent): PiBeforeAgentStartResult => ({
        systemPrompt: `${ev.systemPrompt ?? ''}\n\n${buildServerInstructions(piInstructionOpts())}`,
      }),
    );

    // ── #677 PART B — interactive-only `/tempo-reset` command ──
    // Pi's `newSession` (clean-wipe) is ExtensionCommandContext-ONLY (not on the
    // SDK session), so an interactive Pi conductor can ONLY be reset by the operator
    // running this command. The reset pump's interactive branch notifies the
    // operator to run it when a peer/conductor requests a reset (operator-mediated
    // is the ceiling). Headless players have no command surface → not registered.
    if (mode === 'interactive' && typeof pi.registerCommand === 'function') {
      pi.registerCommand('tempo-reset', {
        description: "Clean-wipe this Pi session's context (agent-tempo reset).",
        handler: async (_args, ctx) => {
          log('/tempo-reset — clean-wiping session context (newSession)');
          await ctx.newSession();
        },
      });
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
        // 3d D14 — reset intake on the SAME poll loop (S3 merge): each tick first
        // drains pendingReset → session.newSession() clean-wipe + ack. Session/pi
        // re-acquired each tick so a session switch never wipes a stale session.
        // #677 PART B — interactive can't auto-wipe (no session field / newSession
        // is command-context-only); the pump notifies the operator via `pi`.
        resetSource: wf,
        // T0.3 (#750) — combined per-tick intake: cues + pending reset in ONE
        // `pendingIntake` query (PiWorkflowClient falls back to the legacy
        // pair on pre-#750 workflows). Halves the pump's idle Temporal actions.
        intakeSource: wf,
        resolveSession: () => runtimes.get(workflowId)?.session ?? null,
        resolvePi: () => runtimes.get(workflowId)?.pi ?? null,
        // T1.1 PR-3 — cue doorbell: a daemon ding pops the pump's inter-tick
        // sleep (sub-second injection) and connected-state raises the idle
        // ceiling. Same identity the inner-loop client uses; the client
        // no-ops without AGENT_TEMPO_INGEST_TOKEN (interactive/manual
        // launches keep pure polling) and is plain loopback HTTP — no Pi
        // instance dependency, so it survives rebuilds with the pump (D11).
        doorbell: { ensemble: config.ensemble, playerId: fixedPlayerId },
      });
      // 3c — inner-loop publisher + its loopback-HTTP sink. The client no-ops
      // unless AGENT_TEMPO_INGEST_TOKEN is present (daemon-spawned headless
      // players only), so interactive Pi gets Tier-1 coarse for free and zero
      // Tier-2 forwarding. URL keyed to the FIXED playerId (matches workflowId).
      const registry = new InnerLoopHttpClient({ ensemble: config.ensemble, playerId: fixedPlayerId });
      const pub = new InnerLoopPublisher({ workflowId, registry });
      const rt: PiPlayerRuntime = {
        workflowId, wf, driver, pump, pub,
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
      log(`attached ${currentPlayerId} (wf ${workflowId})`);
      return rt;
    }

    // ── Lifecycle: session_start → first attach OR re-bind ──
    pi.on('session_start', async (payload: PiEventPayload) => {
      // #677: one-time INFO breadcrumb when interactive session_start has no
      // `session` field (the expected 0.78.1 path — injection routes via pi.sendMessage).
      noteInteractiveSessionAbsent(mode, payload, log);
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
        rt.pump.stop(); // S3 — stop the cue+reset poll loop (workflow detaches below)
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
    rt.pump.stop(); // S3 — stop the cue+reset poll loop before detaching
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

/**
 * Reset the one-time interactive-session breadcrumb flag (#677). TEST ESCAPE HATCH
 * — do NOT call from production code. The flag is module-scope and fires at most
 * once per process, so tests asserting the note must reset it between cases.
 */
export function __resetInteractiveSessionNoteForTests(): void {
  notedInteractiveSessionAbsent = false;
}

/** Default export — interactive-mode extension (the human `pi` CLI entry). */
const piExtension = createPiExtension();
export default piExtension;
