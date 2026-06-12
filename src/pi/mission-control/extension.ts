/**
 * Mission-control Pi extension (3f) — turns ONE interactive Pi TUI into an
 * ensemble mission-control board + operator controller.
 *
 * Three ruled decisions:
 *   1. DRIVE = HTTP — controls POST to the daemon write surface ({@link MissionControlActions}).
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
import { getConfig, resolvePiRole, type PiRole } from '../../config';
import { readPortFile } from '../../http/port-file';
import { createSubscribe } from '../../client/subscribe';
import {
  initBoard,
  applyTempoEvent,
  applyInnerFrame,
  rebindBoard,
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
import { COAT_CHECK_CONTENT_MAX } from '../../utils/validation';
import type { McExtensionAPI, McExtensionContext, McOutboundMessage, McMessageOptions, McToolResult } from './pi-ui';

/** The durable conductor a `/handoff` targets by default (matches catalog's conductorName default). */
const DEFAULT_CONDUCTOR = 'conductor';

/**
 * #713 — handoff stash band (UTF-8 bytes). A plan in `(MIN, MAX]` stashes to the
 * coat-check so the cue body stays lean; below MIN an inline cue is fine; above
 * MAX (the coat-check entry cap) we stay inline up to the 100 KB cue cap.
 *
 * HONEST FRAMING (#713): MAX === the coat-check entry cap (32 KiB), which is
 * BELOW the 100 KB cue cap. Coat-check stashing keeps cues lean and lets the
 * inbox-less planner park artifacts — it does NOT raise the handoff ceiling. A
 * plan over 100 KB still cannot be handed off; that would need a coat-check cap
 * increase (a separate decision with Temporal continue-as-new state implications).
 */
const HANDOFF_STASH_MIN_BYTES = 8 * 1024;
const HANDOFF_STASH_MAX_BYTES = COAT_CHECK_CONTENT_MAX;
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
  /**
   * #729 — session-role override for the dormancy gate (test seam). Defaults to
   * {@link resolvePiRole}. The board activates ONLY for `'command-center'`;
   * `'player'` and `'none'` both keep it dormant.
   */
  role?: PiRole;
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
  /**
   * #790 — set by the extension so `/ensemble <name>` can tear down the old
   * ensemble's coarse SSE + tail and re-open on the new one. Fired AFTER the
   * model + actions are re-keyed (same hook pattern as {@link onTailRequest});
   * null in unit tests.
   */
  onRebind: ((ensemble: string) => void) | null = null;
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

  // ── Multi-ensemble home (#790) ──

  /**
   * One-line ensembles listing — `▶` marks the board's current binding. Shared
   * by the `/ensembles` command and the `list_ensembles` planner tool. Returns
   * the text (the tool needs it) or the failure.
   */
  async ensemblesText(): Promise<{ ok: true; text: string } | { ok: false; error: string }> {
    const r = await this.actions.listEnsembles();
    if (!r.ok) return r;
    if (r.ensembles.length === 0) {
      return { ok: true, text: 'No ensembles found. Create one with /ensemble-up <name>.' };
    }
    const line = r.ensembles
      .map((e) => {
        const mark = e.name === this.model.ensemble ? '▶ ' : '';
        const state = e.state ? `, ${e.state}` : '';
        return `${mark}${e.name} (${e.playerCount} player${e.playerCount === 1 ? '' : 's'}${state})`;
      })
      .join(' · ');
    return { ok: true, text: `Ensembles (${r.ensembles.length}): ${line}` };
  }

  async cmdEnsembles(ctx: McExtensionContext): Promise<void> {
    const r = await this.ensemblesText();
    this.notify(ctx, r.ok ? r.text : `ensembles failed: ${r.error}`);
  }

  /**
   * Shared bind-validation (the `/ensemble` command renders the failure; the
   * `bind_ensemble` planner tool throws it). `unknown` carries the known list
   * so both surfaces can show it. Visibility-backed (#673) — the command's
   * `--force` skips this entirely for the lag window.
   */
  async validateEnsemble(
    name: string,
  ): Promise<{ ok: true } | { ok: false; reason: 'unverifiable' | 'unknown'; detail: string }> {
    const r = await this.actions.listEnsembles();
    if (!r.ok) return { ok: false, reason: 'unverifiable', detail: r.error };
    if (!r.ensembles.some((e) => e.name === name)) {
      return {
        ok: false,
        reason: 'unknown',
        detail: r.ensembles.map((e) => e.name).join(', ') || 'none',
      };
    }
    return { ok: true };
  }

  /**
   * #790 — re-bind the board to another ensemble: re-keys the model + actions,
   * then fires {@link onRebind} so the extension tears down the old coarse
   * SSE/tail and re-opens on the new one. Validates against the daemon's
   * ensemble list first; `--force` skips validation for the #673 visibility-lag
   * window (a just-created ensemble may not be indexed for a few seconds — the
   * SSE route itself falls back to a strongly-consistent existence check).
   */
  async cmdEnsemble(args: string, ctx: McExtensionContext): Promise<void> {
    const tokens = args.trim().split(/\s+/).filter(Boolean);
    const force = tokens.includes('--force');
    const name = tokens.find((t) => !t.startsWith('--'));
    if (!name) {
      this.notify(ctx, `Bound to "${this.model.ensemble}". Usage: /ensemble <name> [--force] — switch the board (see /ensembles).`);
      return;
    }
    if (name === this.model.ensemble) {
      this.notify(ctx, `Already bound to "${name}".`);
      return;
    }
    if (!force) {
      const v = await this.validateEnsemble(name);
      if (!v.ok) {
        this.notify(
          ctx,
          v.reason === 'unverifiable'
            ? `Cannot verify ensemble "${name}" (${v.detail}). Re-run with --force to bind anyway.`
            : `No such ensemble: "${name}" (known: ${v.detail}). Create it with /ensemble-up ${name}, or --force if it was created seconds ago (#673 visibility lag).`,
        );
        return;
      }
    }
    this.rebind(name);
    this.notify(ctx, `Re-bound to "${name}" — board will repopulate from its snapshot.`);
  }

  /** Re-key actions + model and fire the extension's SSE-rebind hook. */
  rebind(ensemble: string): void {
    this.actions.setEnsemble(ensemble);
    rebindBoard(this.model, ensemble);
    this.onRebind?.(ensemble);
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
    this.report(ctx, `handoff → ${DEFAULT_CONDUCTOR}`, await this.handoffPlan(DEFAULT_CONDUCTOR, plan));
  }

  /**
   * #713 — hand a plan to `target`. Plans in the stash band `(8 KiB, 32 KiB]`
   * are parked on the coat-check (`coatCheckPut`) and the cue carries only a
   * short summary + the redeem instruction, keeping the cue body lean. Smaller
   * plans cue inline; larger ones (> 32 KiB) ALSO cue inline up to the 100 KB cue
   * cap — the coat-check entry cap is below the cue cap, so it can't hold them.
   *
   * Public so both the `/handoff` slash command and the planner `handoff` tool
   * share one path. If a stash fails (saturation / transport), falls back to an
   * inline cue so the handoff still lands (a ≤ 32 KiB plan always fits a cue).
   */
  async handoffPlan(target: string, plan: string): Promise<ActionResult> {
    const bytes = Buffer.byteLength(plan, 'utf8');
    if (bytes > HANDOFF_STASH_MIN_BYTES && bytes <= HANDOFF_STASH_MAX_BYTES) {
      const preview = plan.replace(/\s+/g, ' ').trim().slice(0, 160);
      const stash = await this.actions.coatCheckPut({
        summary: `[PLAN HANDOFF] ${preview}`,
        content: plan,
        contentType: 'text/markdown',
      });
      if (stash.ok) {
        return this.actions.cue(
          target,
          `[PLAN HANDOFF] Full plan stashed on the coat-check (${bytes} bytes) — redeem with the ` +
          `\`coat_check_get\` tool:\ncoat_check_get({ ticket: "${stash.ticket}" })`,
        );
      }
      // Stash failed — fall through to inline (the plan fits the 100 KB cue cap).
    }
    return this.actions.cue(target, `[PLAN HANDOFF]\n${plan}`);
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
      // #713 — large plans stash to the coat-check (cue carries the ticket);
      // small plans inline. Shared with the `/handoff` slash command.
      const r = await ctrl.handoffPlan(target, plan);
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

  // #790 — multi-ensemble home for the planner half: see every ensemble, and
  // re-bind the board (the SAME re-bind path as the operator's /ensemble — the
  // SSE plane follows via Controller.onRebind).
  pi.registerTool({
    name: 'list_ensembles', label: 'list_ensembles',
    description: 'List all ensembles on this daemon (name, player count, online/paused/offline). The ▶ marker is the one this board is bound to.',
    parameters: zodShapeToTypeBox({}, 'list_ensembles'),
    execute: async () => {
      const r = await ctrl.ensemblesText();
      if (!r.ok) throw new Error(`list_ensembles failed: ${r.error}`);
      return ok(r.text);
    },
  });

  pi.registerTool({
    name: 'bind_ensemble', label: 'bind_ensemble',
    description: 'Re-bind this board (and all your ensemble-scoped tools: cue, recruit, observe_board, ask, handoff) to another ensemble. The board repopulates from the new ensemble\'s snapshot.',
    parameters: zodShapeToTypeBox({
      name: z.string().describe('Ensemble name to bind to (see list_ensembles).'),
    }, 'bind_ensemble'),
    execute: async (_id, params) => {
      const { name } = params as { name: string };
      if (name === ctrl.model.ensemble) return ok(`Already bound to "${name}".`);
      const v = await ctrl.validateEnsemble(name);
      if (!v.ok) {
        throw new Error(
          v.reason === 'unverifiable'
            ? `bind_ensemble: cannot verify "${name}": ${v.detail}`
            : `bind_ensemble: no such ensemble "${name}" (known: ${v.detail})`,
        );
      }
      ctrl.rebind(name);
      return ok(`Re-bound to "${name}". The board repopulates from its snapshot; observe_board reflects the new ensemble.`);
    },
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
    // ── #729 role gate (MUST stay first — before any registerCommand /
    // registerTool / session_start SSE) ──
    //
    // The board activates ONLY in the command-center role (the operator's
    // `agent-tempo command-center` seat, which sets AGENT_TEMPO_MISSION_CONTROL).
    // A player session ('player') AND a bare coding `pi` ('none') both keep the
    // board DORMANT — no commands/tools registered, no coarse SSE opened. This is
    // the other half of #729 mutual exclusion: exactly one extension registers
    // tools per session (no cue/recruit name collision with the player surface),
    // and a plain `pi` stays pristine (A2 — affirmative opt-in only).
    const role = deps.role ?? resolvePiRole();
    if (role !== 'command-center') {
      log(`dormant — session role is '${role}', not command-center: board not activated.`);
      return;
    }

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
    // #790 — the CURRENT ensemble binding lives on `ctrl.model.ensemble`
    // (re-keyed by Controller.rebind BEFORE onRebind fires), so the SSE
    // closures below read it at (re)open time instead of capturing the
    // session-start `ensemble` const — no second variable to keep in sync.

    const renderNow = (): void => {
      if (!activeCtx?.hasUI) return;
      if (ctrl.model.revision === lastRenderedRevision) return; // throttle: skip no-op ticks
      lastRenderedRevision = ctrl.model.revision;
      activeCtx.ui.setWidget(WIDGET_KEY, renderBoard(ctrl.model, ctrl.localHost), { placement: 'aboveEditor' });
    };

    const startCoarse = (): void => {
      // #54 — accurate posture: a tokenless board is FULLY functional against a
      // local (loopback) daemon, which grants full trust. Only a REMOTE / 0.0.0.0
      // daemon requires the admin token (it 401s tokenless reads + actions).
      if (!adminToken) {
        log(`no ${ADMIN_TOKEN_ENV} — OK for a local loopback daemon (full trust); a remote / 0.0.0.0 daemon will require it`);
      }
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
          for await (const ev of subscribe(ctrl.model.ensemble, { signal: ac.signal })) {
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
      // #54 — do NOT gate on the token: the loopback daemon serves /inner tokenless.
      // openInnerTail sends the bearer iff present; a remote/0.0.0.0 daemon 401s → onError.
      if (playerId === null) return;
      tailAbort = new AbortController();
      // H5: resolve the daemon base URL HERE (per /tail) so a port change is
      // picked up on the next tail instead of being pinned at session start.
      const baseUrl = resolveBaseUrl(deps.baseUrl);
      const fetchFn = (globalThis as { fetch?: unknown }).fetch as
        | ((u: string, i: { method: string; headers: Record<string, string>; signal?: AbortSignal }) => Promise<{ status: number; body: AsyncIterable<Uint8Array> | null }>)
        | undefined;
      if (!fetchFn) return;
      void openInnerTail({
        baseUrl, adminToken, ensemble: ctrl.model.ensemble, playerId,
        signal: tailAbort.signal,
        fetchFn: fetchFn as Parameters<typeof openInnerTail>[0]['fetchFn'],
        onFrame: (f) => applyInnerFrame(ctrl.model, f),
        onError: (m) => log(`inner tail (${playerId}):`, m),
      });
    };
    ctrl.onTailRequest = openTail;

    // #790 — `/ensemble <name>` re-bind: the model + actions were already
    // re-keyed by Controller.rebind; this hook swaps the SSE plane — abort the
    // old ensemble's coarse stream + any fine tail, then re-open the coarse
    // stream on the new ensemble (its snapshot event repopulates the board).
    ctrl.onRebind = (): void => {
      coarseAbort?.abort(); coarseAbort = null;
      tailAbort?.abort(); tailAbort = null;
      startCoarse(); // reads the already-re-keyed ctrl.model.ensemble
      renderNow(); // show the re-keyed (empty) board immediately, not at the next throttle tick
    };

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
    // #790 — multi-ensemble home: list + re-bind.
    pi.registerCommand('ensembles', { description: 'List all ensembles (▶ marks the bound one)', handler: (_a, ctx) => ctrl.cmdEnsembles(ctx) });
    pi.registerCommand('ensemble', { description: 'Switch the board to another ensemble (/ensemble <name> [--force])', handler: (a, ctx) => ctrl.cmdEnsemble(a, ctx) });
    pi.registerCommand('tail', { description: 'Tail a player\'s inner loop (/tail <player> | off)', handler: (a, ctx) => ctrl.cmdTail(a, ctx) });
    pi.registerCommand('cue', { description: 'Send a message to a player (/cue <player> <msg>)', handler: (a, ctx) => ctrl.cmdCue(a, ctx) });
    pi.registerCommand('pause', { description: 'Pause the ensemble', handler: (a, ctx) => ctrl.cmdPause(a, ctx) });
    pi.registerCommand('play', { description: 'Resume the ensemble (/play [release])', handler: (a, ctx) => ctrl.cmdPlay(a, ctx) });
    pi.registerCommand('restart', { description: 'Restart a player (/restart <player> [reason])', handler: (a, ctx) => ctrl.cmdRestart(a, ctx) });
    pi.registerCommand('destroy', { description: 'Destroy a player (/destroy <player> [reason])', handler: (a, ctx) => ctrl.cmdDestroy(a, ctx) });
    pi.registerCommand('reset', { description: 'Clean-wipe a player (/reset <player> [reason])', handler: (a, ctx) => ctrl.cmdReset(a, ctx) });

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
