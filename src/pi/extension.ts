/**
 * agent-tempo Pi extension — interactive runtime (Phase 2).
 *
 *   export default function(pi: ExtensionAPI) { ... }
 *
 * Registers the FULL agent-tempo tool surface natively on Pi (shared
 * transport-neutral descriptors + `renderToPi`), drives the attachment phase
 * from Pi lifecycle events, holds an attachment lease + heartbeat, and pumps
 * cues into the live session.
 *
 * ── Module-scope singleton (CRITICAL — researcher finding) ──
 * Pi REBUILDS the extension instance on every SessionManager switch
 * (newSession/fork/switch fire `session_shutdown` then `session_start`, and a
 * fresh `piExtension(pi)` runs). So per-INSTANCE state does NOT survive a
 * switch. Everything that must survive — the Temporal `Client`, the fixed
 * `workflowId`, the pinned session handle, the heartbeat timer, the cue pump,
 * the current-session pointer — lives in a MODULE-SCOPE singleton
 * (`runtimes`, keyed by workflowId; one entry for interactive Pi, N for the
 * Phase 3 headless daemon — D12a). The rebuilt instance RE-BINDS to the
 * existing runtime; it never recreates it. This singleton IS the
 * implementation of the fixed-workflowId-per-process identity ruling: the
 * workflow never sees the instance churn — same player, same attachment,
 * unbroken lease.
 *
 * ── Teardown (Option C — reason-discriminated, architect ruling) ──
 * `session_shutdown` carries a `reason` {quit|reload|new|resume|fork}. We detach
 * ONLY on a known clean `quit`; ANY switch reason — or an unknown/missing reason
 * — does NOT detach (rebind case). Allowlist by design: a spurious detach
 * (ensemble flap) is worse than a missed immediate detach, so a future Pi reason
 * value can never cause a flap (and surfaces as a D6 version-floor review item).
 * The `quit` detach is BEST-EFFORT — Pi may not await this handler long enough
 * for the async `adapterExited` to land — so we never gate exit on it. The MD-A
 * lease reaper is the PERMANENT floor: it covers SIGKILL/crash (no event) AND a
 * `quit` whose graceful signal didn't land. Strictly better than never-detach:
 * fast clean-exit detach when it lands, reaper-correct otherwise.
 *
 * Determinism boundary: this module (and all of src/pi/) is CLIENT-SIDE only —
 * never bundled into the workflow sandbox.
 */
import * as os from 'os';
import type { Client, WorkflowHandle } from '@temporalio/client';
import { getConfig, ENV, sessionWorkflowId, type Config } from '../config';
import type { AgentType, SessionMetadata } from '../types';
import { buildAllTempoTools, type RegisterAllTempoToolsOpts } from '../server-tools';
import type { ExtensionAPI, PiAgentSession, PiEventPayload } from './pi-types';
import { PhaseDriver } from './phase-driver';
import { PiWorkflowClient } from './workflow-client';
import { CuePump } from './cue-pump';
import { renderToPi } from './render-tools';
import { createLazyProxy } from './lazy-proxy';
import { probePi } from './probe';

const log = (...args: unknown[]): void => {
  // eslint-disable-next-line no-console
  console.error('[agent-tempo:pi]', ...args);
};

const nowIso = (): string => new Date().toISOString();

const PI_AGENT_TYPE: AgentType = 'claude'; // Pi is not yet a first-class AgentType.

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

/**
 * Connection factory used by the extension. Defaults to the module-scope shared
 * connection; overridable via `__setPiClientFactoryForTests` so the rebuild
 * invariant can be exercised without a live Temporal server.
 */
let clientFactory: (config: Config) => Promise<Client> = getSharedClient;

/**
 * Per-PLAYER runtime — lives in the module-scope `runtimes` map and SURVIVES Pi
 * extension-instance rebuilds (a switch re-binds to it). Holds the durable
 * attachment (handle + lease + heartbeat, inside `wf`), the phase driver (phase
 * continuity across switches), the cue pump, and the current Pi session pointer.
 */
interface PiPlayerRuntime {
  readonly workflowId: string;
  readonly wf: PiWorkflowClient;
  readonly driver: PhaseDriver;
  readonly pump: CuePump;
  /** The currently-active Pi session (null during a switch gap). */
  session: PiAgentSession | null;
  /** Last Pi conversation id persisted to metadata.sessionId (resume pointer). */
  lastSessionId?: string;
}

/** One runtime per player, keyed by fixed workflowId. Survives instance rebuilds. */
const runtimes = new Map<string, PiPlayerRuntime>();

const piExtension = function (pi: ExtensionAPI): void {
  // Soft preflight: warn (don't crash the human's Pi session) if Pi packages
  // look absent — the extension is loaded BY Pi so this should never trip.
  const probe = probePi();
  if (!probe.available) log('WARNING:', probe.reason);

  const config: Config = getConfig();
  const isConductor = process.env[ENV.CONDUCTOR] === '1' || process.env[ENV.CONDUCTOR] === 'true';

  // Identity — FIXED workflowId for the process lifetime (architect's ruling).
  // `currentPlayerId` is the mutable DISPLAY id (set_name updates it); the
  // workflowId is computed once and never repointed (a Pi switch is invisible to
  // the ensemble). Stable across instance rebuilds → the same map key.
  let currentPlayerId = process.env[ENV.PLAYER_NAME] || `pi-${process.pid}`;
  const workflowId = sessionWorkflowId(config.ensemble, currentPlayerId);

  // Kick off (or reuse) the module-scope shared connection.
  void clientFactory(config);

  // ── D11 lazy proxies: resolve MODULE-SCOPE state per call (instance-independent) ──
  const clientProxy = createLazyProxy<Client>(() => connectedClient, 'Temporal client');
  const handleProxy = createLazyProxy<WorkflowHandle>(
    () => runtimes.get(workflowId)?.wf.handle ?? null,
    'workflow handle',
  );

  // ── Register the FULL tool surface on THIS instance's `pi` ──
  // (Re-registered on each rebuild — correct: the new `pi` needs its tools. The
  // handlers resolve module-scope state, so they hit the surviving runtime.)
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
  log(`registered tools (player=${currentPlayerId}, conductor=${isConductor})`);

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

  /**
   * Persist the active Pi conversation id to `metadata.sessionId` IF it changed
   * (P2-5 resume pointer). Event-independent: called at attach AND per turn so a
   * silent SessionManager switch is caught without depending on a switch event.
   */
  async function refreshSessionId(rt: PiPlayerRuntime, sessionId: string | undefined): Promise<void> {
    if (!sessionId || sessionId === rt.lastSessionId) return;
    await rt.wf.updateSessionId(sessionId);
    rt.lastSessionId = sessionId;
  }

  /**
   * Get-or-create the runtime for this player. FIRST attach claims the lease +
   * starts the heartbeat + cue pump. A subsequent `session_start` (instance
   * rebuild on a switch) RE-BINDS the surviving runtime — updates the session
   * pointer ONLY; no re-claim, no second heartbeat timer (the lease is unbroken).
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
      // Restart/migrate handoff token if the spawn provided one; absent on a
      // fresh recruit / manual launch → fresh claim. (Read side of the
      // restart-spawn wiring is a tracked Phase 3 / restart-tool carry-item.)
      expectedAttachmentId: process.env[ENV.ATTACHMENT_ID] || undefined,
    });
    const driver = new PhaseDriver();
    const pump = new CuePump({
      source: wf,
      resolveSession: () => runtimes.get(workflowId)?.session ?? null,
    });
    const rt: PiPlayerRuntime = { workflowId, wf, driver, pump, session: payload.session ?? null };
    runtimes.set(workflowId, rt);

    await wf.ensureSessionWorkflow();
    const result = driver.handle('session_start', payload, nowIso());
    await wf.performAction(result.action); // claim → attached, starts heartbeat
    pump.start();
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

  // ── Lifecycle: phase-affecting events (drive the SURVIVING runtime's driver) ──
  for (const event of ['agent_start', 'agent_end'] as const) {
    pi.on(event, async (payload: PiEventPayload) => {
      const rt = runtimes.get(workflowId);
      if (!rt) return;
      if (payload.session) rt.session = payload.session;
      const result = rt.driver.handle(event, payload, nowIso());
      try {
        await rt.wf.performAction(result.action);
        // Event-independent resume-pointer refresh — catches a silent switch at
        // the per-turn boundary.
        if (event === 'agent_start') await refreshSessionId(rt, rt.session?.id);
      } catch (err) {
        log(`${event} → ${result.action.kind} failed:`, err);
      }
    });
  }

  // ── Lifecycle: activity-only events (NEVER drive phase) ──
  for (const event of [
    'turn_start',
    'turn_end',
    'tool_execution_start',
    'tool_execution_end',
  ] as const) {
    pi.on(event, (payload: PiEventPayload) => {
      const rt = runtimes.get(workflowId);
      if (!rt) return;
      if (payload.session) rt.session = payload.session;
      // Stamp activity only; action is guaranteed `none` for these events.
      rt.driver.handle(event, payload, nowIso());
    });
  }

  // ── Lifecycle: session_shutdown → Option C (reason-discriminated teardown) ──
  // Drop the session pointer first (cue pump's resolveSession → null → no
  // injection during the switch gap; also dodges the Pi #2860
  // inject-right-after-newSession drop). Then detach ONLY on a known clean
  // 'quit'; any switch reason (new/resume/fork/reload) or unknown/missing reason
  // → NO detach, leave the runtime mapped for the next rebuild to rebind. The
  // 'quit' detach is best-effort; the MD-A reaper backstops every other path.
  pi.on('session_shutdown', async (payload: PiEventPayload) => {
    const rt = runtimes.get(workflowId);
    if (!rt) return;
    rt.session = null;
    if (payload.reason === 'quit') {
      try {
        await rt.wf.detach('agent-exited'); // requestDetach + adapterExited + stopHeartbeat
        runtimes.delete(workflowId);
      } catch (err) {
        log('quit detach (best-effort) failed — reaper will backstop:', err);
      }
    }
  });
};

// ── Test-only hooks (ADR 0006 `__<verb><Noun>ForTests` convention) ──
// Reset the module-scope singletons between tests and inject a fake connection.
// NEVER called from production code; not surfaced through any barrel.

/** Override the Temporal connection factory (inject a fake Client). */
export function __setPiClientFactoryForTests(factory: (config: Config) => Promise<Client>): void {
  clientFactory = factory;
}

/** Stop timers, clear the per-player runtime map + shared-client singletons + factory. */
export function __resetPiRuntimesForTests(): void {
  for (const rt of runtimes.values()) {
    rt.pump.stop();
    rt.wf.stopHeartbeat();
  }
  runtimes.clear();
  sharedClientPromise = null;
  connectedClient = null;
  clientFactory = getSharedClient;
}

export default piExtension;
