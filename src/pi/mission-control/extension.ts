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
import * as os from 'os';
import { getConfig } from '../../config';
import { readPortFile } from '../../http/port-file';
import { createSubscribe } from '../../client/subscribe';
import {
  initBoard,
  applyTempoEvent,
  applyInnerFrame,
  selectPlayer,
  sortedPlayerIds,
  tailability,
  type BoardModel,
} from './board';
import { renderBoard } from './render';
import { MissionControlActions, ADMIN_TOKEN_ENV, type ActionResult } from './actions';
import { openInnerTail } from './inner-tail';
import { ensureInfra, type InfraProgress } from '../../cli/ensure-infra';
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
  /** Local daemon host for tailability (test override; defaults to `os.hostname()`). */
  localHost?: string;
}

/**
 * Infra-bootstrap seam (#700 P1). Defaults to the real {@link ensureInfra}; the
 * extension command tests inject a fake so `/ensemble-up` etc. don't spawn
 * Temporal / the daemon. Accepts only the `onStep` opt the controller passes.
 */
export type EnsureInfraFn = (opts?: { onStep?: (p: InfraProgress) => void }) => Promise<unknown>;

/** Parsed `/ensemble-up [name] [--lineup X] [--hold]` args. */
export function parseEnsembleUpArgs(args: string): { name?: string; lineup?: string; hold: boolean } {
  const tokens = args.trim().split(/\s+/).filter(Boolean);
  let name: string | undefined;
  let lineup: string | undefined;
  let hold = false;
  for (let i = 0; i < tokens.length; i++) {
    const t = tokens[i];
    if (t === '--hold') hold = true;
    else if (t === '--lineup') lineup = tokens[++i];
    else if (t.startsWith('--lineup=')) lineup = t.slice('--lineup='.length);
    else if (!t.startsWith('--') && name === undefined) name = t;
  }
  return { ...(name !== undefined ? { name } : {}), ...(lineup !== undefined ? { lineup } : {}), hold };
}

/** Parsed `/recruit <name> [--type T] [--host H] [--agent A]` args. */
export function parseRecruitArgs(args: string): { name?: string; type?: string; host?: string; agent?: string } {
  const tokens = args.trim().split(/\s+/).filter(Boolean);
  const out: { name?: string; type?: string; host?: string; agent?: string } = {};
  for (let i = 0; i < tokens.length; i++) {
    const t = tokens[i];
    if (t === '--type') out.type = tokens[++i];
    else if (t.startsWith('--type=')) out.type = t.slice('--type='.length);
    else if (t === '--host') out.host = tokens[++i];
    else if (t.startsWith('--host=')) out.host = t.slice('--host='.length);
    else if (t === '--agent') out.agent = tokens[++i];
    else if (t.startsWith('--agent=')) out.agent = t.slice('--agent='.length);
    else if (!t.startsWith('--') && out.name === undefined) out.name = t;
  }
  return out;
}

/**
 * The operator-command + board controller. Holds the model + the action client;
 * command methods are independently unit-testable with a fake actions + ctx.
 * The lifecycle (SSE/render/teardown) lives in {@link createMissionControlExtension}.
 */
export class Controller {
  readonly model: BoardModel;
  readonly actions: MissionControlActions;
  /**
   * This daemon's host (`os.hostname()`). The fine /inner tail is daemon-local,
   * so only same-host players are tailable — see {@link tailability}.
   */
  readonly localHost: string;
  /** Set by the extension so /tail can (re)open the fine SSE; null in unit tests. */
  onTailRequest: ((playerId: string | null) => void) | null = null;
  /** Infra bootstrap fn (#700 P1); injectable for tests. */
  private readonly ensureInfraFn: EnsureInfraFn;

  constructor(
    ensemble: string,
    actions: MissionControlActions,
    localHost: string = os.hostname(),
    ensureInfraFn: EnsureInfraFn = ensureInfra,
  ) {
    this.model = initBoard(ensemble);
    this.actions = actions;
    this.localHost = localHost;
    this.ensureInfraFn = ensureInfraFn;
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
    // H3a: the /inner tail is daemon-local — refuse a cross-host tail with an
    // actionable message rather than silently selecting a player that would only
    // ever show "(no inner-loop activity yet)". Decided BEFORE select/open so a
    // cross-host player is never selected and no tail SSE is opened.
    const t = tailability(this.model, target, this.localHost);
    if (!t.ok) {
      let msg: string;
      if (t.reason === 'cross-host') {
        msg = `Inner tail unavailable: ${target} runs on host ${t.playerHost}, not this daemon's host (${this.localHost}). Cross-host tail is a tracked follow-up (#645 / H3b).`;
      } else if (t.reason === 'ui-player') {
        msg = `${target} is a UI player — nothing to tail.`;
      } else {
        msg = `No such player: ${target}`;
      }
      this.notify(ctx, msg);
      return;
    }
    selectPlayer(this.model, target);
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
    // H5b: real POST /v1/ensembles/:e/reset (D14 clean-wipe) — mirrors cmdRestart.
    const [p, reason] = Controller.splitFirst(args);
    if (!p) { this.notify(ctx, 'Usage: /reset <player> [reason]'); return; }
    this.report(ctx, `reset ${p}`, await this.actions.reset(p, reason || undefined));
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

  // ── Bootstrap commands (#700 P1) ──

  /**
   * Ensure local infra is up (Temporal + SAs + agent types + daemon), streaming
   * each step to the UI. Returns false (and notifies) if bootstrap fails, so the
   * caller can bail before the HTTP action. Idempotent — a no-op when infra is
   * already live.
   */
  private async ensureInfraReady(ctx: McExtensionContext): Promise<boolean> {
    try {
      await this.ensureInfraFn({
        onStep: (p: InfraProgress) =>
          this.notify(ctx, `infra: ${p.step} ${p.status}${p.detail ? ` (${p.detail})` : ''}`),
      });
      return true;
    } catch (err) {
      this.notify(ctx, `infra failed: ${err instanceof Error ? err.message : String(err)}`);
      return false;
    }
  }

  async cmdEnsembleUp(args: string, ctx: McExtensionContext): Promise<void> {
    const { name, lineup, hold } = parseEnsembleUpArgs(args);
    if (!(await this.ensureInfraReady(ctx))) return;
    // Conductor defaults to a HEADLESS Pi (design §3) — the human's seat is this
    // command-center planner, so a second interactive conductor window is
    // redundant. `conductorAgent: 'pi'` overrides any lineup conductor agent.
    const r = await this.actions.createEnsemble({
      ...(name !== undefined ? { name } : {}),
      ...(lineup !== undefined ? { lineup } : {}),
      startMode: hold ? 'hold' : 'release',
      conductorAgent: 'pi',
    });
    this.report(ctx, `ensemble-up${name ? ` ${name}` : ''}`, r);
  }

  async cmdRecruit(args: string, ctx: McExtensionContext): Promise<void> {
    const { name, type, host, agent } = parseRecruitArgs(args);
    if (!name) { this.notify(ctx, 'Usage: /recruit <name> [--type T] [--host H] [--agent A]'); return; }
    if (!(await this.ensureInfraReady(ctx))) return;
    const r = await this.actions.recruit({
      name,
      // The extension runs in the Pi process; its cwd is the project dir.
      workDir: process.cwd(),
      ...(type !== undefined ? { playerType: type } : {}),
      ...(host !== undefined ? { host } : {}),
      ...(agent !== undefined ? { agent } : {}),
    });
    this.report(ctx, `recruit ${name}`, r);
  }

  async cmdEnsembleDown(args: string, ctx: McExtensionContext): Promise<void> {
    const destroy = args.trim().split(/\s+/).includes('--destroy');
    if (!(await this.ensureInfraReady(ctx))) return;
    const r = await this.actions.shutdownEnsemble(destroy);
    this.report(ctx, `ensemble-down${destroy ? ' --destroy' : ''}`, r);
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
    const throttleMs = deps.renderThrottleMs ?? DEFAULT_RENDER_THROTTLE_MS;
    // H3a: mission-control is co-located with its 127.0.0.1 daemon, so this
    // process's hostname IS the daemon's host. (HealthV1.hostname is the noted
    // future upgrade for a baseUrl pointing at a remote daemon — not built here.)
    const localHost = deps.localHost ?? os.hostname();

    // H5: do NOT pre-resolve baseUrl. createSubscribe + MissionControlActions both
    // re-read ~/.agent-tempo/daemon.port per-call when baseUrl is undefined, so a
    // daemon restart on a new port self-heals (a once-resolved URL wedges the
    // board). A `deps.baseUrl` override (tests / future remote daemon) still wins.
    const actions = new MissionControlActions({
      ensemble,
      ...(adminToken ? { adminToken } : {}),
      ...(deps.baseUrl ? { baseUrl: deps.baseUrl } : {}),
    });
    const ctrl = new Controller(ensemble, actions, localHost);

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
      activeCtx.ui.setWidget(WIDGET_KEY, renderBoard(ctrl.model, ctrl.localHost), { placement: 'aboveEditor' });
    };

    const startCoarse = (): void => {
      if (!adminToken) { log(`no admin token (${ADMIN_TOKEN_ENV}) — board limited / disabled`); }
      // H5: capture the controller locally. teardown nulls the outer `coarseAbort`,
      // so the catch must check THIS signal — checking the nulled outer ref made an
      // expected teardown abort log a spurious "coarse SSE ended: AbortError".
      const ac = new AbortController();
      coarseAbort = ac;
      // H5: omit baseUrl → createSubscribe re-resolves the daemon port per
      // (re)connect, so a daemon restart on a new port self-heals.
      const subscribe = createSubscribe({
        ...(deps.baseUrl ? { baseUrl: deps.baseUrl } : {}),
        ...(adminToken ? { token: adminToken } : {}),
      });
      void (async () => {
        try {
          for await (const ev of subscribe(ensemble, { signal: ac.signal })) {
            applyTempoEvent(ctrl.model, ev);
          }
        } catch (err) {
          if (!ac.signal.aborted) log('coarse SSE ended:', err instanceof Error ? err.message : err);
        }
      })();
    };

    const openTail = (playerId: string | null): void => {
      tailAbort?.abort();
      tailAbort = null;
      if (playerId === null || !adminToken) return;
      tailAbort = new AbortController();
      // H5: resolve the daemon base URL HERE (per /tail) so a port change is
      // picked up on the next tail instead of being pinned at session start.
      const baseUrl = resolveBaseUrl(deps.baseUrl);
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
    pi.registerCommand('reset', { description: 'Clean-wipe a player (/reset <player> [reason])', handler: (a, ctx) => ctrl.cmdReset(a, ctx) });
    pi.registerCommand('arm', { description: 'Arm/disarm the operator gate for a player (/arm <player> [off])', handler: (a, ctx) => ctrl.cmdArm(a, ctx) });
    pi.registerCommand('gate', { description: 'Decide a gate request for the tailed player (/gate <reqId> allow|deny)', handler: (a, ctx) => ctrl.cmdGate(a, ctx) });

    // #700 P1 — bootstrap commands (ensureInfra → daemon HTTP action).
    pi.registerCommand('ensemble-up', { description: 'Bootstrap the ensemble (/ensemble-up [name] [--lineup X] [--hold])', handler: (a, ctx) => ctrl.cmdEnsembleUp(a, ctx) });
    pi.registerCommand('recruit', { description: 'Recruit a player (/recruit <name> [--type T] [--host H] [--agent A])', handler: (a, ctx) => ctrl.cmdRecruit(a, ctx) });
    pi.registerCommand('ensemble-down', { description: 'Tear down the ensemble (/ensemble-down [--destroy])', handler: (a, ctx) => ctrl.cmdEnsembleDown(a, ctx) });
  };
}

/** Default export — the loadable Pi extension. */
const missionControlExtension = createMissionControlExtension();
export default missionControlExtension;
