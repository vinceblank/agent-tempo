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
import * as crypto from 'crypto';
import { z } from 'zod';
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
import { zodShapeToTypeBox } from '../zod-to-typebox';
import type { McExtensionAPI, McExtensionContext, McOutboundMessage, McMessageOptions, McToolResult } from './pi-ui';

/** The durable conductor a `/handoff` targets by default (matches catalog's conductorName default). */
const DEFAULT_CONDUCTOR = 'conductor';
/** Bounded human-`/ask` poll: total wait + interval. The LLM `ask` tool yields instead (SSE wake). */
const ASK_POLL_TIMEOUT_MS = 30_000;
const ASK_POLL_INTERVAL_MS = 1_000;

/** Mint a url/path-safe correlation id for a Q&A ask (client-side; not workflow code). */
function mintQuestionId(): string {
  return `q-${crypto.randomUUID()}`;
}

/**
 * #700 P2 — build the planner-wake injection from a resolved `answer` SSE event.
 * Pure (testable). The planner has no inbox; the SSE `answer` event is turned
 * into a `triggerTurn` session injection — the planner-side mirror of the
 * cue-pump waking an idle player. Text is fetched on read (the answer route /
 * the planner's `readAnswer` tool, commit 4); the wake just announces arrival.
 */
export function buildAnswerWake(
  payload: { questionId: string; from: string; ts: string },
): { message: McOutboundMessage; options: McMessageOptions } {
  return {
    message: {
      customType: 'answer',
      content:
        `[answer to ${payload.questionId} from ${payload.from}] ` +
        `Your question was answered — read the full text via the answer route ` +
        `(questionId: ${payload.questionId}).`,
      display: true,
    },
    options: { deliverAs: 'followUp', triggerTurn: true },
  };
}

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

  // ── Planner Q&A + handoff commands (#700 P2) ──

  async cmdAsk(args: string, ctx: McExtensionContext): Promise<void> {
    const [target, question] = Controller.splitFirst(args);
    if (!target || !question) { this.notify(ctx, 'Usage: /ask <player> <question>'); return; }
    const questionId = mintQuestionId();
    const r = await this.actions.ask({ target, question, questionId });
    if (!r.ok) { this.report(ctx, `ask ${target}`, r); return; }
    // Human path: poll (the operator is watching). The LLM `ask` TOOL yields
    // instead and is woken by the SSE `answer` event.
    this.notify(ctx, `Asked ${target} (q=${questionId}); waiting up to ${ASK_POLL_TIMEOUT_MS / 1000}s…`);
    const answer = await this.pollAnswer(questionId);
    if (answer) this.notify(ctx, `${answer.from} → ${answer.text}`);
    else this.notify(ctx, `No answer yet for ${questionId}. It'll surface when ${target} responds (re-run /ask to re-check).`);
  }

  /** Bounded poll of the answer mailbox (human `/ask` path). Resolves null on timeout. */
  private async pollAnswer(questionId: string): Promise<{ from: string; text: string } | null> {
    const deadline = Date.now() + ASK_POLL_TIMEOUT_MS;
    while (Date.now() < deadline) {
      const a = await this.actions.readAnswer(questionId);
      if (a) return a;
      await new Promise((res) => setTimeout(res, ASK_POLL_INTERVAL_MS));
    }
    return null;
  }

  async cmdHandoff(args: string, ctx: McExtensionContext): Promise<void> {
    const plan = args.trim();
    if (!plan) { this.notify(ctx, 'Usage: /handoff <plan> — pushes the plan to the durable conductor.'); return; }
    // Inline cue (a §5.4 brief is small markdown). Large-plan-via-coat-check is a
    // P2.1 follow-up (coat_check_put has no HTTP route yet).
    this.report(ctx, `handoff → ${DEFAULT_CONDUCTOR}`, await this.actions.cue(DEFAULT_CONDUCTOR, `[PLAN HANDOFF]\n${plan}`));
  }
}

/**
 * #700 P2 — register the planner LLM tools (the "think with tools" half) on an
 * interactive Pi's tool surface, alongside the human slash-commands. Each tool
 * lands on the SAME {@link MissionControlActions} the commands use. `ask` is
 * YIELD-NOT-POLL (dispatch + return; the SSE `answer` wake resumes the turn).
 * No-op when `pi.registerTool` is absent (non-interactive / fake Pi).
 */
export function registerPlannerTools(pi: McExtensionAPI, ctrl: Controller): void {
  if (typeof pi.registerTool !== 'function') return;
  const ok = (text: string): McToolResult => ({ content: [{ type: 'text', text }], details: {} });

  pi.registerTool({
    name: 'ask', label: 'ask',
    description: 'Ask a player a correlated question. Returns IMMEDIATELY — end your turn; you will be woken when the answer lands. Do NOT poll. Use observe_board to see who is active.',
    parameters: zodShapeToTypeBox({
      target: z.string().describe('Player name to ask.'),
      question: z.string().describe('The question to ask.'),
    }, 'ask'),
    execute: async (_id, params) => {
      const { target, question } = params as { target: string; question: string };
      const questionId = mintQuestionId();
      const r = await ctrl.actions.ask({ target, question, questionId });
      if (!r.ok) throw new Error(`ask failed: ${r.error}`);
      return ok(`Dispatched to ${target} (questionId=${questionId}). End your turn — you'll be woken when the answer lands; do not poll.`);
    },
  });

  pi.registerTool({
    name: 'handoff', label: 'handoff',
    description: 'Hand off a plan to the durable headless conductor for execution. It keeps orchestrating after you close this window.',
    parameters: zodShapeToTypeBox({
      plan: z.string().describe('The plan brief (Objective / Assignments / Constraints / Success criteria).'),
      to: z.string().optional().describe(`Conductor to hand to (default "${DEFAULT_CONDUCTOR}").`),
    }, 'handoff'),
    execute: async (_id, params) => {
      const { plan, to } = params as { plan: string; to?: string };
      const target = to ?? DEFAULT_CONDUCTOR;
      const r = await ctrl.actions.cue(target, `[PLAN HANDOFF]\n${plan}`);
      if (!r.ok) throw new Error(`handoff failed: ${r.error}`);
      return ok(`Plan handed off to ${target}.`);
    },
  });

  pi.registerTool({
    name: 'cue', label: 'cue',
    description: 'Send a message to a player by name.',
    parameters: zodShapeToTypeBox({ to: z.string().describe('Player name.'), message: z.string().describe('Message body.') }, 'cue'),
    execute: async (_id, params) => {
      const { to, message } = params as { to: string; message: string };
      const r = await ctrl.actions.cue(to, message);
      if (!r.ok) throw new Error(`cue failed: ${r.error}`);
      return ok(`Cued ${to}.`);
    },
  });

  pi.registerTool({
    name: 'recruit', label: 'recruit',
    description: 'Recruit a new player into the ensemble.',
    parameters: zodShapeToTypeBox({
      name: z.string().describe('Player name.'),
      type: z.string().optional().describe('Player type (agent-type name, e.g. tempo-soloist).'),
      host: z.string().optional().describe('Target host.'),
      agent: z.string().optional().describe('Agent backend (e.g. pi, claude).'),
    }, 'recruit'),
    execute: async (_id, params) => {
      const { name, type, host, agent } = params as { name: string; type?: string; host?: string; agent?: string };
      const r = await ctrl.actions.recruit({
        name, workDir: process.cwd(),
        ...(type !== undefined ? { playerType: type } : {}),
        ...(host !== undefined ? { host } : {}),
        ...(agent !== undefined ? { agent } : {}),
      });
      if (!r.ok) throw new Error(`recruit failed: ${r.error}`);
      return ok(`Recruited ${name}.`);
    },
  });

  pi.registerTool({
    name: 'observe_board', label: 'observe_board',
    description: 'Get the current ensemble board as text — players, phases, parts, current tool, context%. Your read path; no need to scrape the widget.',
    parameters: zodShapeToTypeBox({}, 'observe_board'),
    execute: () => ok(renderBoard(ctrl.model, ctrl.localHost).join('\n')),
  });
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
            // #700 P2 — an `answer` event isn't a board event; it WAKES the
            // planner (its only inbound channel is this SSE stream). Inject via
            // pi.sendMessage(triggerTurn) — feature-detected (a fake/older Pi
            // may not provide it). Everything else folds into the board model.
            if (ev.type === 'answer') {
              if (typeof pi.sendMessage === 'function') {
                const { message, options } = buildAnswerWake(ev.payload);
                pi.sendMessage(message, options);
              }
              continue;
            }
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

    // #700 P2 — planner Q&A + handoff (human slash-commands).
    pi.registerCommand('ask', { description: 'Ask a player a question and wait for the answer (/ask <player> <question>)', handler: (a, ctx) => ctrl.cmdAsk(a, ctx) });
    pi.registerCommand('handoff', { description: 'Hand off a plan to the durable conductor (/handoff <plan>)', handler: (a, ctx) => ctrl.cmdHandoff(a, ctx) });

    // #700 P2 — planner LLM tools (the "think with tools" half), alongside the
    // human commands. No-op on a non-interactive / fake Pi (registerTool absent).
    registerPlannerTools(pi, ctrl);
  };
}

/** Default export — the loadable Pi extension. */
const missionControlExtension = createMissionControlExtension();
export default missionControlExtension;
