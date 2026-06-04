/**
 * Mission-control Pi extension (3f) — turns ONE interactive Pi TUI into an
 * ensemble mission-control board + operator controller.
 *
 * Three ruled decisions:
 *   1. DRIVE = HTTP — controls POST to the daemon write/gate surface ({@link MissionControlActions}).
 *   2. OBSERVER-ONLY — this extension NEVER claimAttachment / registers as a player.
 *   3. RENDER THROTTLE ~200ms — events fold into the in-memory {@link BoardModel};
 *      a tick re-renders only when the model changed (revision bump), so the
 *      /inner tail can't thrash the TUI.
 *
 * Lifecycle: `session_start` opens the coarse SSE (`/v1/events/:ensemble` via the
 * Node `subscribe` path), starts the render tick, and registers operator
 * commands; `session_shutdown` tears all of it down + clears the widget.
 */
import { getConfig } from '../../config';
import { readPortFile } from '../../http/port-file';
import { createSubscribe } from '../../client/subscribe';
import {
  initBoard,
  applyTempoEvent,
  applyInnerFrame,
  selectPlayer,
  sortedPlayerIds,
  type BoardModel,
} from './board';
import { renderBoard } from './render';
import { MissionControlActions, ADMIN_TOKEN_ENV, type ActionResult } from './actions';
import { openInnerTail } from './inner-tail';
import type { McExtensionAPI, McExtensionContext } from './pi-ui';

const WIDGET_KEY = 'mission-control';
const DEFAULT_RENDER_THROTTLE_MS = 200;
const DEFAULT_PORT = 8473;

/** Injectable seams (production defaults; tests override). */
export interface MissionControlDeps {
  ensemble?: string;
  adminToken?: string;
  baseUrl?: string;
  renderThrottleMs?: number;
}

/**
 * The operator-command + board controller. Holds the model + the action client;
 * command methods are independently unit-testable with a fake actions + ctx.
 * The lifecycle (SSE/render/teardown) lives in {@link createMissionControlExtension}.
 */
export class Controller {
  readonly model: BoardModel;
  readonly actions: MissionControlActions;
  /** Set by the extension so /tail can (re)open the fine SSE; null in unit tests. */
  onTailRequest: ((playerId: string | null) => void) | null = null;

  constructor(ensemble: string, actions: MissionControlActions) {
    this.model = initBoard(ensemble);
    this.actions = actions;
  }

  private notify(ctx: McExtensionContext, msg: string): void {
    if (ctx.hasUI) ctx.ui.notify(msg);
  }

  private report(ctx: McExtensionContext, label: string, r: ActionResult): void {
    this.notify(ctx, r.ok ? `${label} ✓` : `${label} failed: ${r.error}`);
  }

  /** First whitespace-delimited token + the remainder. */
  private static splitFirst(args: string): [string, string] {
    const t = args.trim();
    const i = t.indexOf(' ');
    return i < 0 ? [t, ''] : [t.slice(0, i), t.slice(i + 1).trim()];
  }

  async cmdPlayers(ctx: McExtensionContext): Promise<void> {
    const ids = sortedPlayerIds(this.model);
    this.notify(ctx, ids.length ? `Players (${ids.length}): ${ids.join(', ')}` : 'No players in the ensemble.');
  }

  async cmdTail(args: string, ctx: McExtensionContext): Promise<void> {
    const target = args.trim();
    if (!target || target === 'off') {
      selectPlayer(this.model, null);
      this.onTailRequest?.(null);
      this.notify(ctx, 'Inner-loop tail off.');
      return;
    }
    if (!selectPlayer(this.model, target)) {
      this.notify(ctx, `No such player: ${target}`);
      return;
    }
    this.onTailRequest?.(target);
    this.notify(ctx, `Tailing ${target}.`);
  }

  async cmdCue(args: string, ctx: McExtensionContext): Promise<void> {
    const [to, message] = Controller.splitFirst(args);
    if (!to || !message) { this.notify(ctx, 'Usage: /cue <player> <message>'); return; }
    this.report(ctx, `cue → ${to}`, await this.actions.cue(to, message));
  }

  async cmdPause(_args: string, ctx: McExtensionContext): Promise<void> {
    this.report(ctx, 'pause', await this.actions.pause());
  }

  async cmdPlay(args: string, ctx: McExtensionContext): Promise<void> {
    const release = args.trim() === 'release';
    this.report(ctx, 'play', await this.actions.play(release));
  }

  async cmdRestart(args: string, ctx: McExtensionContext): Promise<void> {
    const [p, reason] = Controller.splitFirst(args);
    if (!p) { this.notify(ctx, 'Usage: /restart <player> [reason]'); return; }
    this.report(ctx, `restart ${p}`, await this.actions.restart(p, reason || undefined));
  }

  async cmdDestroy(args: string, ctx: McExtensionContext): Promise<void> {
    const [p, reason] = Controller.splitFirst(args);
    if (!p) { this.notify(ctx, 'Usage: /destroy <player> [reason]'); return; }
    this.report(ctx, `destroy ${p}`, await this.actions.destroy(p, reason || undefined));
  }

  async cmdReset(args: string, ctx: McExtensionContext): Promise<void> {
    const p = args.trim();
    if (!p) { this.notify(ctx, 'Usage: /reset <player>'); return; }
    // D14 reset has NO daemon HTTP route yet (MCP/outbox only). Surface clearly
    // rather than silently fail. Wiring a POST /v1/ensembles/:e/reset is a daemon
    // follow-up (flagged to the conductor).
    this.notify(ctx, `reset ${p}: not available over the daemon HTTP surface yet (MCP/outbox only). Flagged for a daemon route.`);
  }

  async cmdArm(args: string, ctx: McExtensionContext): Promise<void> {
    const [p, mode] = Controller.splitFirst(args);
    if (!p) { this.notify(ctx, 'Usage: /arm <player> [off]'); return; }
    const off = mode.trim() === 'off';
    this.report(ctx, `${off ? 'disarm' : 'arm'} ${p}`, off ? await this.actions.gateDisarm(p) : await this.actions.gateArm(p));
  }

  async cmdGate(args: string, ctx: McExtensionContext): Promise<void> {
    const [reqId, decisionRaw] = Controller.splitFirst(args);
    const decision = decisionRaw.trim();
    if (!reqId || (decision !== 'allow' && decision !== 'deny')) {
      this.notify(ctx, 'Usage: /gate <requestId> allow|deny  (decides for the tailed player)');
      return;
    }
    if (!this.model.selected) {
      this.notify(ctx, 'Select a player first with /tail <player> — gate decisions are per-player.');
      return;
    }
    this.report(ctx, `gate ${reqId} ${decision}`, await this.actions.gateDecide(this.model.selected, reqId, decision));
  }
}

function resolveBaseUrl(override: string | undefined): string {
  if (override) return override.replace(/\/$/, '');
  return `http://127.0.0.1:${readPortFile() ?? DEFAULT_PORT}`;
}

const log = (...args: unknown[]): void => {
  // eslint-disable-next-line no-console
  console.error('[agent-tempo:pi:mission-control]', ...args);
};

/**
 * Build the mission-control extension (default-export shape). The operator's Pi
 * loads it in OBSERVER mode. `deps` overrides config/token/baseUrl for tests.
 */
export function createMissionControlExtension(deps: MissionControlDeps = {}): (pi: McExtensionAPI) => void {
  return (pi: McExtensionAPI): void => {
    const ensemble = deps.ensemble ?? getConfig().ensemble;
    const adminToken = deps.adminToken ?? process.env[ADMIN_TOKEN_ENV];
    const baseUrl = resolveBaseUrl(deps.baseUrl);
    const throttleMs = deps.renderThrottleMs ?? DEFAULT_RENDER_THROTTLE_MS;

    const actions = new MissionControlActions({ ensemble, ...(adminToken ? { adminToken } : {}), baseUrl });
    const ctrl = new Controller(ensemble, actions);

    // Per-session lifecycle state (re-created on each session_start).
    let coarseAbort: AbortController | null = null;
    let tailAbort: AbortController | null = null;
    let renderTimer: ReturnType<typeof setInterval> | null = null;
    let lastRenderedRevision = -1;
    let activeCtx: McExtensionContext | null = null;

    const renderNow = (): void => {
      if (!activeCtx?.hasUI) return;
      if (ctrl.model.revision === lastRenderedRevision) return; // throttle: skip no-op ticks
      lastRenderedRevision = ctrl.model.revision;
      activeCtx.ui.setWidget(WIDGET_KEY, renderBoard(ctrl.model), { placement: 'aboveEditor' });
    };

    const startCoarse = (): void => {
      if (!adminToken) { log(`no admin token (${ADMIN_TOKEN_ENV}) — board limited / disabled`); }
      coarseAbort = new AbortController();
      const subscribe = createSubscribe({ baseUrl, ...(adminToken ? { token: adminToken } : {}) });
      void (async () => {
        try {
          for await (const ev of subscribe(ensemble, { signal: coarseAbort.signal })) {
            applyTempoEvent(ctrl.model, ev);
          }
        } catch (err) {
          if (!coarseAbort?.signal.aborted) log('coarse SSE ended:', err instanceof Error ? err.message : err);
        }
      })();
    };

    const openTail = (playerId: string | null): void => {
      tailAbort?.abort();
      tailAbort = null;
      if (playerId === null || !adminToken) return;
      tailAbort = new AbortController();
      const fetchFn = (globalThis as { fetch?: unknown }).fetch as
        | ((u: string, i: { method: string; headers: Record<string, string>; signal?: AbortSignal }) => Promise<{ status: number; body: AsyncIterable<Uint8Array> | null }>)
        | undefined;
      if (!fetchFn) return;
      void openInnerTail({
        baseUrl, adminToken, ensemble, playerId,
        signal: tailAbort.signal,
        fetchFn: fetchFn as Parameters<typeof openInnerTail>[0]['fetchFn'],
        onFrame: (f) => applyInnerFrame(ctrl.model, f),
        onError: (m) => log(`inner tail (${playerId}):`, m),
      });
    };
    ctrl.onTailRequest = openTail;

    const teardown = (): void => {
      coarseAbort?.abort(); coarseAbort = null;
      tailAbort?.abort(); tailAbort = null;
      if (renderTimer) { clearInterval(renderTimer); renderTimer = null; }
      if (activeCtx?.hasUI) activeCtx.ui.setWidget(WIDGET_KEY, undefined);
      activeCtx = null;
    };

    pi.on('session_start', (_event, ctx) => {
      activeCtx = ctx;
      lastRenderedRevision = -1;
      startCoarse();
      renderTimer = setInterval(renderNow, throttleMs);
      if (typeof renderTimer.unref === 'function') renderTimer.unref();
      renderNow();
    });
    pi.on('session_shutdown', () => teardown());

    // Operator commands (display-only widget → slash-commands drive everything).
    pi.registerCommand('players', { description: 'List ensemble players', handler: (_a, ctx) => ctrl.cmdPlayers(ctx) });
    pi.registerCommand('tail', { description: 'Tail a player\'s inner loop (/tail <player> | off)', handler: (a, ctx) => ctrl.cmdTail(a, ctx) });
    pi.registerCommand('cue', { description: 'Send a message to a player (/cue <player> <msg>)', handler: (a, ctx) => ctrl.cmdCue(a, ctx) });
    pi.registerCommand('pause', { description: 'Pause the ensemble', handler: (a, ctx) => ctrl.cmdPause(a, ctx) });
    pi.registerCommand('play', { description: 'Resume the ensemble (/play [release])', handler: (a, ctx) => ctrl.cmdPlay(a, ctx) });
    pi.registerCommand('restart', { description: 'Restart a player (/restart <player> [reason])', handler: (a, ctx) => ctrl.cmdRestart(a, ctx) });
    pi.registerCommand('destroy', { description: 'Destroy a player (/destroy <player> [reason])', handler: (a, ctx) => ctrl.cmdDestroy(a, ctx) });
    pi.registerCommand('reset', { description: 'Clean-wipe a player (/reset <player>)', handler: (a, ctx) => ctrl.cmdReset(a, ctx) });
    pi.registerCommand('arm', { description: 'Arm/disarm the operator gate for a player (/arm <player> [off])', handler: (a, ctx) => ctrl.cmdArm(a, ctx) });
    pi.registerCommand('gate', { description: 'Decide a gate request for the tailed player (/gate <reqId> allow|deny)', handler: (a, ctx) => ctrl.cmdGate(a, ctx) });
  };
}

/** Default export — the loadable Pi extension. */
const missionControlExtension = createMissionControlExtension();
export default missionControlExtension;
