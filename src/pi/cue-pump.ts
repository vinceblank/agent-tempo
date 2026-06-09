/**
 * Cue pump — pulls cues queued on the session workflow and injects them into the
 * LIVE Pi agent, then acks them.
 *
 * Pi has no reverse-RPC into a running session from Temporal, so (like the
 * existing adapters) we poll `pendingMessages` and ack via `markDelivered`.
 *
 * ── Injection target: the STABLE `pi` handle, re-resolved per tick (#677) ──
 * Pi 0.78.1's `SessionStartEvent` carries NO `session` field, so in INTERACTIVE
 * mode `PiEventPayload.session` is null → the old `resolveSession` returned null
 * every tick → the interactive Pi conductor NEVER received cues. The fix routes
 * injection through the `pi` ExtensionAPI handle (`pi.sendMessage`), which is
 * always live. Crucially the injector is RE-RESOLVED PER TICK from the surviving
 * module-scope runtime — capturing it once silently dies after an interactive
 * session switch (the runtime's `pi` is repointed on rebind). Headless still works
 * (its `pi` is the real ExtensionAPI too); the legacy `session.sendCustomMessage`
 * path is kept as a feature-detected fallback.
 *
 * Injection follows D10 cue-delivery semantics:
 *   - **deliverAs** — operator cue (`msg.isMaestro`, a human steering from the
 *     Maestro dashboard) → `'steer'` (interrupt the in-flight turn so the
 *     override lands immediately); peer cue → `'followUp'` (queue behind the
 *     current turn rather than interrupting a peer's work).
 *   - **triggerTurn — always `true`.** Researcher-confirmed: Pi's `followUp`
 *     does NOT self-wake an idle agent, so an unconditional `triggerTurn` is
 *     REQUIRED to avoid #18-style silent cue loss when no human is driving. It
 *     is a no-op when a turn is already running (the message just queues), so we
 *     don't need to race-check the idle state — set it unconditionally.
 *
 * ── Escalation (#677): turn-started → sendUserMessage ──
 * `triggerTurn: true` on `sendMessage` SHOULD wake a cold-idle agent, but if it
 * doesn't (e.g. a Pi regression, or a queued followUp that never drains), the
 * cue sits unprocessed and silently. The pump therefore tracks the last cue it
 * injected via the escalation-eligible `pi.sendMessage` route; on the NEXT tick,
 * if NO turn started since (the runtime's `lastTurnStartAt` is still older than
 * the inject), it re-injects the SAME cue via `pi.sendUserMessage` — a user-role
 * message ALWAYS starts a turn. Escalation fires at most once per cue (it can't
 * loop). The primary route stays `pi.sendMessage` so the `cue` customType +
 * operator-vs-peer steer/followUp semantics are preserved; `sendUserMessage`
 * loses both, so it is fallback-only.
 *
 * Adapted from Pi's `examples/extensions/file-trigger.ts`.
 */
import type { Message } from '../types';
import { consolidateQuestionCue } from '../utils/cue-format';
import type { ExtensionAPI, PiAgentSession, PiOutboundMessage, PiCustomMessageOptions } from './pi-types';

/** Source of pending cues + ack — satisfied by `PiWorkflowClient`. */
export interface CueSource {
  fetchPending(): Promise<Message[]>;
  ackDelivered(messageIds: string[]): Promise<void>;
}

/**
 * The live cue-injection capability, RE-RESOLVED each tick from the surviving
 * runtime so a session switch never injects through a stale handle. Two routes:
 *   - PRIMARY (`pi.sendMessage`): preserves the `cue` customType + steer/followUp
 *     operator-vs-peer semantics. Escalation-eligible.
 *   - FALLBACK (`session.sendCustomMessage`): legacy path; NOT escalation-eligible.
 */
export interface MessageInjector {
  /** Inject one cue (D10 — `cue` customType, steer/followUp + triggerTurn). */
  inject(msg: PiOutboundMessage, opts: PiCustomMessageOptions): void | Promise<void>;
  /**
   * Re-inject the SAME cue as a user-role message (always wakes a turn). Present
   * ONLY on the escalation-eligible `pi.sendMessage` route — its presence IS the
   * "this route can escalate" signal (the legacy session fallback omits it).
   */
  escalate?(text: string): void | Promise<void>;
  /** Epoch-ms of the last observed `turn_start` (null = none yet) — drives escalation. */
  lastTurnStartAt(): number | null;
}

/**
 * Resolves the CURRENT injection capability at tick time. Re-acquired every tick
 * rather than captured once, so a Pi instance rebuild (D11) never injects through
 * a stale `pi`/session. Returns `null` when nothing is attached yet.
 */
export type InjectorResolver = () => MessageInjector | null;

/** The runtime slice {@link buildPiInjector} reads — satisfied by `PiPlayerRuntime`. */
export interface InjectorRuntime {
  pi: ExtensionAPI | null;
  session: PiAgentSession | null;
  lastTurnStartAt: number | null;
}

/**
 * Build the per-tick {@link MessageInjector} from the live runtime, PREFERRING the
 * stable `pi.sendMessage` handle (interactive root-cause fix, #677) and falling
 * back to `session.sendCustomMessage` only when `pi.sendMessage` is unavailable.
 * Pure + feature-detected (`typeof`) so it's safe whatever Pi build is loaded and
 * unit-testable without a real Pi.
 */
export function buildPiInjector(rt: InjectorRuntime | null | undefined): MessageInjector | null {
  if (!rt) return null;
  const pi = rt.pi;
  const send = typeof pi?.sendMessage === 'function' ? pi.sendMessage.bind(pi) : null;
  if (send) {
    const sendUser = typeof pi?.sendUserMessage === 'function' ? pi.sendUserMessage.bind(pi) : null;
    return {
      inject: (msg, opts) => send(msg, opts),
      // #688 — escalate with `deliverAs: 'followUp'`. maybeEscalate can fire while a
      // turn is ALREADY in flight (one that started BEFORE the inject — a busy
      // false-positive), and a bare sendUserMessage (no deliverAs) while Pi is
      // streaming throws "Agent is already processing". followUp is correct in BOTH
      // cases: cold-idle (behavior ignored → the user message still starts a turn,
      // escalation works) and busy (queues + drains in order, no throw). NOT 'steer'
      // — steer would let a peer cue preempt the operator's in-flight turn, breaking
      // the operator-vs-peer guarantee (see file header).
      ...(sendUser ? { escalate: (text: string) => sendUser(text, { deliverAs: 'followUp' }) } : {}),
      lastTurnStartAt: () => rt.lastTurnStartAt,
    };
  }
  const session = rt.session;
  if (session) {
    return {
      inject: (msg, opts) => session.sendCustomMessage(msg, opts),
      lastTurnStartAt: () => rt.lastTurnStartAt,
    };
  }
  return null;
}

export interface CuePumpOptions {
  source: CueSource;
  resolveInjector: InjectorResolver;
  /** Poll interval (ms). */
  intervalMs?: number;
  /** Injected clock (tests). Defaults to `Date.now`. */
  now?: () => number;
}

const DEFAULT_POLL_MS = 1_000;

const log = (...args: unknown[]): void => {
  // eslint-disable-next-line no-console
  console.error('[agent-tempo:pi]', ...args);
};

export class CuePump {
  private readonly source: CueSource;
  private readonly resolveInjector: InjectorResolver;
  private readonly intervalMs: number;
  private readonly now: () => number;
  private timer: ReturnType<typeof setInterval> | null = null;
  private draining = false;
  /**
   * The last cue injected via the escalation-eligible `pi.sendMessage` route,
   * pending a turn-start check on the next tick. Cleared once a turn starts or
   * once escalated (escalate-once invariant).
   */
  private lastInject: { text: string; injectedAt: number; escalated: boolean } | null = null;

  constructor(opts: CuePumpOptions) {
    this.source = opts.source;
    this.resolveInjector = opts.resolveInjector;
    this.intervalMs = opts.intervalMs ?? DEFAULT_POLL_MS;
    this.now = opts.now ?? Date.now;
  }

  start(): void {
    if (this.timer) return;
    this.timer = setInterval(() => {
      this.tick().catch((err) => log('cue-pump tick failed:', err));
    }, this.intervalMs);
    if (typeof this.timer.unref === 'function') this.timer.unref();
  }

  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  /**
   * One poll cycle: (1) escalate a previously-injected cue that never woke a turn,
   * then (2) fetch pending cues, inject each into the live agent, ack the ones
   * successfully injected. Re-entrancy guarded so a slow tick never overlaps the
   * next interval.
   */
  async tick(): Promise<void> {
    if (this.draining) return;
    this.draining = true;
    try {
      const injector = this.resolveInjector();

      // (1) Escalation check — runs even with no new pending. If the previous
      // tick injected a cue via pi.sendMessage and NO turn has started since, the
      // cue may be sitting in a cold-idle agent's queue unprocessed → re-inject as
      // a user message (which always wakes a turn). Once per cue.
      await this.maybeEscalate(injector);

      const pending = await this.source.fetchPending();
      if (pending.length === 0) return;

      if (!injector) {
        // No live injection target yet (no `pi` handle / session) — leave cues
        // queued; next tick retries once an instance attaches/rebinds. Logged so a
        // live bring-up can see cues are HELD (not lost) while waiting to attach.
        log(`no live injector — holding ${pending.length} cue(s) for next tick`);
        return;
      }

      const delivered: string[] = [];
      let lastDeliveredText: string | null = null;
      for (const msg of pending) {
        // #53 — a planner question consolidates to a single `[Q <id> · from …]`
        // header (no doubled prefix); a normal cue keeps the `[cue from …]` envelope.
        const content = consolidateQuestionCue(msg.from, msg.text)
          ?? (msg.from ? `[cue from ${msg.from}] ${msg.text}` : msg.text);
        try {
          await this.injectCue(injector, msg, content);
          delivered.push(msg.id);
          lastDeliveredText = content;
        } catch (err) {
          log(`failed to inject cue ${msg.id}:`, err);
          // Stop on first failure — preserve ordering; retry next tick.
          break;
        }
      }
      await this.source.ackDelivered(delivered);

      // Track ONLY the LAST cue injected via the escalation-eligible route so the
      // NEXT tick can re-inject it as a user message if no turn started. Tracking
      // just the last is intentional and does NOT drop earlier cues' delivery:
      // every cue in this batch was already injected via pi.sendMessage (queued in
      // Pi), so they ALL drain once any turn starts — escalation only needs to WAKE
      // a turn, and re-injecting one cue as a user message does exactly that. The
      // session-fallback route omits `escalate` → no tracking.
      if (injector.escalate && lastDeliveredText !== null) {
        this.lastInject = { text: lastDeliveredText, injectedAt: this.now(), escalated: false };
      }
    } finally {
      this.draining = false;
    }
  }

  /**
   * If a previously sendMessage-injected cue has not been followed by a turn, the
   * `triggerTurn` wake didn't take — re-inject the SAME cue as a user-role message
   * (always starts a turn). Escalates at most once per cue; clears the tracker
   * once a turn is observed.
   */
  private async maybeEscalate(injector: MessageInjector | null): Promise<void> {
    const pending = this.lastInject;
    if (!pending || pending.escalated) return;
    if (!injector?.escalate) return;
    const turnAt = injector.lastTurnStartAt();
    if (turnAt !== null && turnAt >= pending.injectedAt) {
      // A turn started after the inject → the cue was picked up; stop tracking.
      this.lastInject = null;
      return;
    }
    try {
      await injector.escalate(pending.text);
      pending.escalated = true;
      log('escalated un-woken cue via sendUserMessage');
    } catch (err) {
      log('cue escalation failed:', err);
    }
  }

  /**
   * Inject one cue into the live agent (D10 — see file header). Operator cues
   * `steer` (same-turn priority); peer cues `followUp` (queue). `triggerTurn` is
   * always set: a no-op mid-turn, the required cold-idle wake otherwise.
   */
  private async injectCue(injector: MessageInjector, msg: Message, content: string): Promise<void> {
    // LOAD-BEARING Pi-runtime invariant (D10) — confirmed sound through Pi 0.78.x
    // (researcher-cited; a D6 "behaviors-to-revalidate-on-bump" item):
    //   peer cue     = { deliverAs: 'followUp', triggerTurn: true } → QUEUES; drains
    //     when the agent goes idle, NEVER preempts a running turn. triggerTurn only
    //     wakes a cold-idle session (followUp alone won't start one); it is a no-op
    //     while a turn is in flight.
    //   operator cue = { deliverAs: 'steer', triggerTurn: true } → same-turn PRIORITY:
    //     injected after the current tool batch, before the next LLM call. NOT a hard
    //     mid-tool abort (only RPC abort / AbortSignal hard-interrupts a running tool).
    // The guarantee this comment protects: a future Pi version MUST keep followUp
    // non-interrupting AND triggerTurn a no-op-while-busy. If that regresses, peer
    // cues silently become preemptions, defeating operator-vs-peer. Not unit-testable
    // here (the injector is mocked) — locked by researcher confirmation + the D6 Pi
    // version floor (≥ #2860 + #5115) + a real-Pi mid-turn integration smoke. The
    // #677 sendUserMessage escalation is the belt-and-suspenders for a missed wake.
    await injector.inject(
      { customType: 'cue', content, display: true },
      { deliverAs: msg.isMaestro ? 'steer' : 'followUp', triggerTurn: true },
    );
  }
}
