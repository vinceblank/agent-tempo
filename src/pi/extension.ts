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
import type { Client, WorkflowHandle } from '@temporalio/client';
import { getConfig, ENV, sessionWorkflowId, type Config } from '../config';
import type { AgentType, SessionMetadata } from '../types';
import { buildAllTempoTools, type RegisterAllTempoToolsOpts } from '../server-tools';
import type {
  ExtensionAPI, PiAgentSession, PiEventPayload, PiToolCallEvent, PiToolCallResult,
} from './pi-types';
import { PhaseDriver } from './phase-driver';
import { PiWorkflowClient } from './workflow-client';
import { CuePump } from './cue-pump';
import { renderToPi } from './render-tools';
import { createLazyProxy } from './lazy-proxy';
import { probePi } from './probe';
import { InnerLoopPublisher } from './inner-loop-publisher';
import { InnerLoopHttpClient } from './inner-loop-client';
import { classify } from './tool-capability';

const log = (...args: unknown[]): void => {
  // eslint-disable-next-line no-console
  console.error('[agent-tempo:pi]', ...args);
};

const nowIso = (): string => new Date().toISOString();

const PI_AGENT_TYPE: AgentType = 'claude'; // Pi is not yet a first-class AgentType.

/** Runtime mode. Headless = recruited unsupervised player (MD-C gate active). */
export type PiExtensionMode = 'interactive' | 'headless';
export type PiToolAccess = 'restricted' | 'standard' | 'full';

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
interface PiPlayerRuntime {
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
      (pi.on as unknown as (e: string, h: (ev: PiToolCallEvent) => PiToolCallResult) => void)(
        'tool_call',
        (event: PiToolCallEvent): PiToolCallResult => {
          // 1) MD-C tool-class floor (fires FIRST, before any gate-engagement
          //    check). F1: classify()==='exec' is the canonical EXEC set from
          //    tool-capability.ts — a SUPERSET of the old local list, so
          //    powershell/pwsh/cmd/run are now hard-blocked at restricted too.
          if (classify(event.toolName) === 'exec' && toolAccess === 'restricted') {
            log(`MD-C: blocked '${event.toolName}' (toolAccess=restricted)`);
            return {
              block: true,
              reason: `toolAccess=restricted: shell/exec tools are disabled for this headless Pi player`,
            };
          }
          // 2) toolAccess permits this tool. (3d operator-gate check slots in here.)
          return {};
        },
      );
      log(`MD-C tool gate active (mode=headless, toolAccess=${toolAccess})`);
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
        resolveSession: () => runtimes.get(workflowId)?.session ?? null,
      });
      // 3c — inner-loop publisher + its loopback-HTTP sink. The client no-ops
      // unless AGENT_TEMPO_INGEST_TOKEN is present (daemon-spawned headless
      // players only), so interactive Pi gets Tier-1 coarse for free and zero
      // Tier-2 forwarding. URL keyed to the FIXED playerId (matches workflowId).
      const registry = new InnerLoopHttpClient({ ensemble: config.ensemble, playerId: fixedPlayerId });
      const pub = new InnerLoopPublisher({ workflowId, registry });
      const rt: PiPlayerRuntime = { workflowId, wf, driver, pump, pub, session: payload.session ?? null };
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

/** Default export — interactive-mode extension (the human `pi` CLI entry). */
const piExtension = createPiExtension();
export default piExtension;
