/**
 * agent-tempo Pi extension — Phase 0 conductor-cue PoC.
 *
 *   export default function(pi: ExtensionAPI) { ... }
 *
 * On `session_start` it opens a client-side `WorkflowClient`, ensures/attaches
 * the session workflow (reusing existing workflow code), claims the attachment
 * lease, starts the heartbeat + cue pump, and registers the native `report`
 * tool. Pi lifecycle events drive the attachment phase via `PhaseDriver`.
 *
 * Determinism boundary: this module (and all of src/pi/) is CLIENT-SIDE only —
 * it is never bundled into the workflow sandbox.
 *
 * D11: the live session and phase driver are RE-ACQUIRED per session — a
 * `session_start` always starts a fresh `PhaseDriver` and `WorkflowClient`;
 * nothing is cached across session switches.
 */
import * as os from 'os';
import { getConfig, ENV } from '../config';
import type { SessionMetadata } from '../types';
import type { ExtensionAPI, PiAgentSession, PiEventPayload } from './pi-types';
import { PhaseDriver } from './phase-driver';
import { PiWorkflowClient } from './workflow-client';
import { CuePump } from './cue-pump';
import { registerReportTool } from './report-tool';
import { probePi } from './probe';

const log = (...args: unknown[]): void => {
  // eslint-disable-next-line no-console
  console.error('[agent-tempo:pi]', ...args);
};

const nowIso = (): string => new Date().toISOString();

/** Build minimal session metadata from config + env + host. */
function buildMetadata(): SessionMetadata {
  const config = getConfig();
  const playerId = process.env[ENV.PLAYER_NAME] || `pi-${process.pid}`;
  const isConductor = process.env[ENV.CONDUCTOR] === '1' || process.env[ENV.CONDUCTOR] === 'true';
  return {
    playerId,
    ensemble: config.ensemble,
    hostname: os.hostname(),
    workDir: process.cwd(),
    isConductor,
    agentType: 'claude', // Pi is not yet a first-class AgentType; placeholder for Phase 0.
    adapterId: 'pi',
  };
}

/**
 * Per-session runtime bundle. Created fresh on each `session_start`, torn down
 * on `session_shutdown`. Never reused across sessions (D11).
 */
interface SessionContext {
  session: PiAgentSession | null;
  driver: PhaseDriver;
  wf: PiWorkflowClient;
  pump: CuePump;
}

const piExtension = function (pi: ExtensionAPI): void {
  // Soft preflight: warn (don't crash the human's Pi session) if Pi packages
  // look absent — the extension is loaded BY Pi so this should never trip, but
  // it surfaces a clear message in the misconfigured/headless case.
  const probe = probePi();
  if (!probe.available) log('WARNING:', probe.reason);

  let ctx: SessionContext | null = null;

  // ── Lifecycle: session_start → attach + claim + start loops ──
  pi.on('session_start', async (payload: PiEventPayload) => {
    try {
      const metadata = buildMetadata();
      const client = await PiWorkflowClient.connect(getConfig());
      const wf = new PiWorkflowClient({ client, config: getConfig(), metadata });
      const driver = new PhaseDriver();

      // Fresh context — D11: re-acquire session from THIS payload, don't cache.
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
      log(`attached as ${metadata.playerId} (ensemble ${metadata.ensemble})`);
    } catch (err) {
      log('session_start wiring failed:', err);
    }
  });

  // ── Lifecycle: phase-affecting events ──
  for (const event of ['agent_start', 'agent_end'] as const) {
    pi.on(event, async (payload: PiEventPayload) => {
      if (!ctx) return;
      // D11: refresh the live session ref from each event payload.
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
      ctx = null; // D11: drop the session context.
    }
  });

  // ── Native tool: report (routes through outbox; zero peer signals) ──
  // The tool's submitter resolves the CURRENT session's workflow client lazily,
  // so the report always routes through the live attachment.
  registerReportTool(pi, {
    submitOutbox: (entry) => {
      if (!ctx) throw new Error('report: no active session');
      return ctx.wf.submitOutbox(entry);
    },
  });
};

export default piExtension;
