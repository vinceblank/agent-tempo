/**
 * agent-tempo Pi extension — interactive runtime (Phase 2).
 *
 *   export default function(pi: ExtensionAPI) { ... }
 *
 * Registers the FULL agent-tempo tool surface natively on Pi (via the shared
 * transport-neutral descriptors + `renderToPi`), drives the attachment phase
 * from Pi lifecycle events, claims/renews an attachment lease, and pumps cues
 * into the live session.
 *
 * D11 (lazy-proxy binding): Pi tools are registered ONCE at extension load, but
 * a tool's handler needs the player's live Temporal `Client` and session
 * `WorkflowHandle` — which only exist after connect + claim, and which advance
 * across continueAsNew / reconnect. So we build the tool surface with LAZY
 * proxies (`createLazyProxy`) that resolve the current client/handle per call.
 * This is additive: the descriptor + MCP contract is unchanged (the proxy IS a
 * Client / WorkflowHandle structurally).
 *
 * Identity (architect's ruling): ONE interactive `pi` process = ONE player =
 * ONE FIXED workflowId for the process lifetime. Pi SessionManager
 * newSession/fork/switch are INTERNAL conversation management, invisible to the
 * ensemble — they do NOT repoint the workflow. `set_name` updates the display
 * id, never the workflowId. (metadata.sessionId tracking + resume is P2-5.)
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

/**
 * Per-session runtime bundle. Created fresh on each `session_start`, torn down
 * on `session_shutdown`. The lazy handle proxy resolves `ctx.wf.handle`, so when
 * `ctx` is null (no session) tool handlers fail cleanly rather than mis-route.
 */
interface SessionContext {
  session: PiAgentSession | null;
  driver: PhaseDriver;
  wf: PiWorkflowClient;
  pump: CuePump;
}

const piExtension = function (pi: ExtensionAPI): void {
  // Soft preflight: warn (don't crash the human's Pi session) if Pi packages
  // look absent — the extension is loaded BY Pi so this should never trip.
  const probe = probePi();
  if (!probe.available) log('WARNING:', probe.reason);

  const config: Config = getConfig();
  const isConductor = process.env[ENV.CONDUCTOR] === '1' || process.env[ENV.CONDUCTOR] === 'true';

  // Player identity — FIXED workflowId for the process lifetime (architect's
  // ruling). `currentPlayerId` is the mutable DISPLAY id (set_name updates it);
  // the workflowId is computed once and never repointed.
  let currentPlayerId = process.env[ENV.PLAYER_NAME] || `pi-${process.pid}`;
  const workflowId = sessionWorkflowId(config.ensemble, currentPlayerId);

  let ctx: SessionContext | null = null;
  let sharedClient: Client | null = null;

  // Connect once at load (D12a: one Client serves every in-process session).
  // session_start awaits this; tool handlers reach it via the lazy client proxy.
  const connectPromise: Promise<Client> = PiWorkflowClient.connect(config)
    .then((c) => { sharedClient = c; return c; })
    .catch((err) => { log('Temporal connect failed:', err); throw err; });

  // ── D11 lazy proxies: resolve the live client / current session handle per call ──
  const clientProxy = createLazyProxy<Client>(() => sharedClient, 'Temporal client');
  const handleProxy = createLazyProxy<WorkflowHandle>(() => ctx?.wf.handle ?? null, 'workflow handle');

  // ── Register the FULL tool surface ONCE, over the lazy proxies ──
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

  // ── Lifecycle: session_start → connect + attach + claim + start loops ──
  pi.on('session_start', async (payload: PiEventPayload) => {
    try {
      const client = await connectPromise;
      const wf = new PiWorkflowClient({ client, config, metadata: buildMetadata() });
      const driver = new PhaseDriver();

      // Fresh context — re-acquire the live session from THIS payload.
      ctx = {
        session: payload.session ?? null,
        driver,
        wf,
        pump: new CuePump({
          source: wf,
          resolveSession: () => ctx?.session ?? null,
        }),
      };

      await wf.ensureSessionWorkflow();
      const result = driver.handle('session_start', payload, nowIso());
      await wf.performAction(result.action); // claim → attached, starts heartbeat
      ctx.pump.start();
      log(`attached as ${currentPlayerId} (ensemble ${config.ensemble})`);
    } catch (err) {
      log('session_start wiring failed:', err);
    }
  });

  // ── Lifecycle: phase-affecting events ──
  for (const event of ['agent_start', 'agent_end'] as const) {
    pi.on(event, async (payload: PiEventPayload) => {
      if (!ctx) return;
      if (payload.session) ctx.session = payload.session;
      const result = ctx.driver.handle(event, payload, nowIso());
      try {
        await ctx.wf.performAction(result.action);
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
      if (!ctx) return;
      if (payload.session) ctx.session = payload.session;
      // Stamp activity only; action is guaranteed `none` for these events.
      ctx.driver.handle(event, payload, nowIso());
    });
  }

  // ── Lifecycle: session_shutdown → draining → detached ──
  pi.on('session_shutdown', async (payload: PiEventPayload) => {
    if (!ctx) return;
    const result = ctx.driver.handle('session_shutdown', payload, nowIso());
    try {
      ctx.pump.stop();
      await ctx.wf.performAction(result.action); // requestDetach + adapterExited
    } catch (err) {
      log('session_shutdown detach failed:', err);
    } finally {
      ctx = null; // drop the session context.
    }
  });
};

export default piExtension;
