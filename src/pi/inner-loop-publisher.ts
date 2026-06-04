/**
 * Inner-loop publisher (3c) — the single Pi-source observer of the headless
 * agent loop. It subscribes to `pi.on(...)` events ONCE and routes what it
 * observes two ways, never touching extension.ts (the singleton imports + wires
 * this module on bootstrap):
 *
 *   TIER 1 — COARSE, always-on (route A, poll-derived). Maintains a small
 *     {@link CoarseState} ({ currentTool, contextTokens?, contextPercent? }) that
 *     the heartbeat sender samples via {@link InnerLoopPublisher.getCoarseState}
 *     and piggybacks onto the EXISTING heartbeat (additive optional fields — ZERO
 *     new Temporal signals). lead's AggregateRunner poll-diffs that metadata into
 *     a `player.activity` SSE event. This module never touches the bus or
 *     Temporal — it only produces the values.
 *
 *   TIER 2 — FINE, on-demand (push). Forwards inner frames to the injected
 *     {@link InnerLoopRegistry} — but ONLY when `subscriberCount(workflowId) > 0`
 *     (the subscriber-presence gate: zero watchers ⇒ zero forwarding ⇒ no
 *     firehose). This module owns: source coalescing of thinking/text deltas
 *     (flush on a timer OR a char threshold, bounding wire rate regardless of LLM
 *     token speed), the presence gate (rate-limited so it can't hammer the
 *     registry), and ~2KB summary truncation (never forward raw file/Bash output
 *     inline — privacy + volume). The registry owns per-subscriber backpressure
 *     (drop-oldest + `compacted{dropped:N}`).
 *
 * TOKENS ARE PULL-ONLY (Pi 0.78): there is no token event. Usage comes from the
 * handler's 2nd arg `ctx.getContextUsage()` (sampled at `turn_end`), surfaced as
 * context-window PRESSURE (tokens + percent) — the useful operational signal.
 *
 * Cross-process note: the headless Pi player is a DETACHED subprocess, separate
 * from the daemon that hosts the real registry — so the production
 * {@link InnerLoopRegistry} impl is a thin loopback-HTTP client, NOT an
 * in-process call. This module is coded against the 2-method interface (DI) so
 * it's unit-testable without the HTTP layer; the real client is wired at
 * integration.
 */
import type {
  ExtensionAPI,
  PiAssistantDelta,
  PiExtensionContext,
  PiMessageUpdatePayload,
  PiToolCallEvent,
  PiToolExecutionStartPayload,
  PiToolExecutionEndPayload,
  PiTurnPayload,
} from './pi-types';

/**
 * A fine-tail frame (Tier 2). Matches lead's InnerLoopRegistry frame schema.
 *
 * 3d adds the two MD-G operator-gate frames. They ride the SAME /inner stream the
 * operator already watches (per-player, so workflowId/playerId are implicit):
 *   - `inner.gate_pending`  — emitted by the Pi tool_call handler when the gate
 *     engages; the ingest route's side-effect registers the pending in the
 *     GateRegistry (the "engagement IS registration" path). `argsSummary` is
 *     source-truncated (~2KB). `timeoutMs` lets the operator UI render a countdown.
 *   - `inner.gate_resolved` — emitted by the GateRegistry (via an injected
 *     publishToInner callback) when a decision lands (operator) or the 45s
 *     auto-allow fires (timeout), so the operator sees the outcome.
 */
export type InnerFrame =
  | { type: 'inner.thinking'; delta: string; kind: 'thinking' | 'text' }
  | { type: 'inner.tool_call'; tool: string; argsSummary: string; ts: number }
  | { type: 'inner.tool_result'; tool: string; resultSummary: string; isError: boolean; ts: number }
  | { type: 'inner.token'; contextTokens?: number; contextPercent?: number }
  | { type: 'inner.turn'; phase: 'start' | 'end'; turnIndex: number; ts: number }
  | { type: 'inner.gate_pending'; requestId: string; tool: string; argsSummary: string; classification: 'exec' | 'high-blast'; timeoutMs: number; ts: number }
  | { type: 'inner.gate_resolved'; requestId: string; decision: 'allow' | 'deny' | 'auto-allow'; source: 'operator' | 'timeout'; ts: number };

/**
 * The daemon-side fine-tail sink (lead's `http/inner-loop.ts`). Injected so the
 * publisher is unit-testable without the HTTP layer; production is a thin
 * loopback-HTTP client to the daemon.
 */
export interface InnerLoopRegistry {
  publish(workflowId: string, frame: InnerFrame): void;
  /** Live fine-tail subscriber count for this player — the presence gate reads it. */
  subscriberCount(workflowId: string): number;
}

/** Coarse always-on state the heartbeat sender samples (Tier 1). */
export interface CoarseState {
  /** Tool currently executing, or null when idle between tools. */
  currentTool: string | null;
  /** Context tokens in use (pressure), when known. */
  contextTokens?: number;
  /** Context-window usage fraction/percent, when known. */
  contextPercent?: number;
}

export interface InnerLoopPublisherOptions {
  /** The player's fixed session workflowId (the registry key). */
  workflowId: string;
  /** Fine-tail sink (DI). */
  registry: InnerLoopRegistry;
  /** Max chars for an args/result summary before truncation (default 2048 ≈ 2KB). */
  maxSummaryChars?: number;
  /** Flush a coalesced thinking/text buffer after this many chars (default 2048). */
  coalesceChars?: number;
  /** Flush a coalesced thinking/text buffer this long after the first buffered delta (default 100ms). */
  coalesceMs?: number;
  /** Re-check `subscriberCount` at most this often (default 1000ms) — bounds registry calls. */
  presencePollMs?: number;
  /** Injected clock (tests). Defaults to `Date.now`. */
  now?: () => number;
}

const DEFAULT_MAX_SUMMARY_CHARS = 2048;
const DEFAULT_COALESCE_CHARS = 2048;
const DEFAULT_COALESCE_MS = 100;
const DEFAULT_PRESENCE_POLL_MS = 1000;
const TRUNCATION_MARKER = '…[truncated]';

const log = (...args: unknown[]): void => {
  // eslint-disable-next-line no-console
  console.error('[agent-tempo:pi]', ...args);
};

/** Stringify an arbitrary tool arg/result for a summary (compact, never throws). */
function stringifySummary(value: unknown): string {
  if (value == null) return '';
  if (typeof value === 'string') return value;
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

/** Truncate to `maxChars` with a marker — keeps a fine-tail summary bounded. */
export function truncateSummary(value: unknown, maxChars: number = DEFAULT_MAX_SUMMARY_CHARS): string {
  const s = stringifySummary(value);
  if (s.length <= maxChars) return s;
  return s.slice(0, Math.max(0, maxChars - TRUNCATION_MARKER.length)) + TRUNCATION_MARKER;
}

/**
 * Observes the Pi inner loop and routes coarse state + fine frames. Construct
 * one per headless player; call {@link start} with the extension's `pi` on
 * bootstrap and {@link stop} on teardown. Handler methods are public so unit
 * tests drive them directly (no live Pi) — mirroring the CuePump test pattern.
 */
export class InnerLoopPublisher {
  private readonly workflowId: string;
  private readonly registry: InnerLoopRegistry;
  private readonly maxSummaryChars: number;
  private readonly coalesceChars: number;
  private readonly coalesceMs: number;
  private readonly presencePollMs: number;
  private readonly now: () => number;

  /** Tier-1 coarse state, sampled by the heartbeat sender. */
  private coarse: CoarseState = { currentTool: null };

  /** Coalesce buffer for thinking/text deltas (single buffer, flushed on kind-switch). */
  private pending: { kind: 'thinking' | 'text'; text: string; startedAt: number } | null = null;
  private flushTimer: ReturnType<typeof setInterval> | null = null;

  /** Rate-limited presence cache (avoids per-frame registry calls). */
  private presentCached = false;
  private lastPresenceCheck = -Infinity;

  constructor(opts: InnerLoopPublisherOptions) {
    this.workflowId = opts.workflowId;
    this.registry = opts.registry;
    this.maxSummaryChars = opts.maxSummaryChars ?? DEFAULT_MAX_SUMMARY_CHARS;
    this.coalesceChars = opts.coalesceChars ?? DEFAULT_COALESCE_CHARS;
    this.coalesceMs = opts.coalesceMs ?? DEFAULT_COALESCE_MS;
    this.presencePollMs = opts.presencePollMs ?? DEFAULT_PRESENCE_POLL_MS;
    this.now = opts.now ?? Date.now;
  }

  /** Register the Pi event handlers and start the coalesce flush timer. */
  start(pi: ExtensionAPI): void {
    pi.on('message_update', (payload) => this.handleMessageUpdate(payload as PiMessageUpdatePayload));
    pi.on('tool_call', (payload) => this.handleToolCall(payload as unknown as PiToolCallEvent));
    pi.on('tool_execution_start', (payload) => this.handleToolStart(payload as PiToolExecutionStartPayload));
    pi.on('tool_execution_end', (payload) => this.handleToolEnd(payload as PiToolExecutionEndPayload));
    pi.on('turn_start', (payload) => this.handleTurnStart(payload as PiTurnPayload));
    pi.on('turn_end', (payload, ctx) => this.handleTurnEnd(payload as PiTurnPayload, ctx));

    if (!this.flushTimer) {
      this.flushTimer = setInterval(() => this.flushPending(), this.coalesceMs);
      if (typeof this.flushTimer.unref === 'function') this.flushTimer.unref();
    }
  }

  /** Tear down the flush timer (flushing any trailing buffer first). */
  stop(): void {
    this.flushPending();
    if (this.flushTimer) {
      clearInterval(this.flushTimer);
      this.flushTimer = null;
    }
  }

  /** Tier-1: the current coarse state, sampled by the heartbeat sender. */
  getCoarseState(): CoarseState {
    return { ...this.coarse };
  }

  // ── Pi event handlers (public for unit tests) ──────────────────────────────

  /**
   * Stream delta → coalesce into the pending thinking/text buffer. Thinking/text
   * is PURELY fine-tail (no coarse state), so the presence gate goes BEFORE
   * buffering — when nobody's watching we do zero per-delta work on this hot path.
   */
  handleMessageUpdate(payload: PiMessageUpdatePayload): void {
    const ev: PiAssistantDelta | undefined = payload.assistantMessageEvent;
    if (!ev || typeof ev.delta !== 'string' || ev.delta.length === 0) return;
    const kind = ev.type === 'text_delta' ? 'text' : ev.type === 'thinking_delta' ? 'thinking' : null;
    if (kind === null) return; // ignore toolcall_delta and any other variant
    if (!this.isPresent()) return; // no subscriber → don't buffer fine-tail text
    this.appendDelta(kind, ev.delta);
  }

  /** Tool started → set coarse currentTool. (No fine frame here; tool_call carries args.) */
  handleToolStart(payload: PiToolExecutionStartPayload): void {
    if (typeof payload.toolName === 'string' && payload.toolName.length > 0) {
      this.coarse.currentTool = payload.toolName;
    }
  }

  /**
   * Tool finished → clear coarse currentTool (Tier-1, ALWAYS) + forward a fine
   * tool_result frame. The presence gate goes BEFORE `truncateSummary` so a large
   * tool result is never JSON-stringified when nobody's tailing.
   */
  handleToolEnd(payload: PiToolExecutionEndPayload): void {
    this.coarse.currentTool = null; // always-on coarse update — never gated
    if (!this.isPresent()) return; // gate before the (potentially large) stringify
    this.forward({
      type: 'inner.tool_result',
      tool: typeof payload.toolName === 'string' ? payload.toolName : '',
      resultSummary: truncateSummary(payload.result, this.maxSummaryChars),
      isError: payload.isError === true,
      ts: this.now(),
    });
  }

  /** Pre-exec tool_call → forward a fine tool_call frame (args summarized). */
  handleToolCall(payload: PiToolCallEvent): void {
    if (!this.isPresent()) return; // gate before stringifying args
    this.forward({
      type: 'inner.tool_call',
      tool: typeof payload.toolName === 'string' ? payload.toolName : '',
      argsSummary: truncateSummary(payload.input, this.maxSummaryChars),
      ts: this.now(),
    });
  }

  /** Turn began → forward a fine turn frame. */
  handleTurnStart(payload: PiTurnPayload): void {
    this.forward({ type: 'inner.turn', phase: 'start', turnIndex: payload.turnIndex ?? -1, ts: this.now() });
  }

  /**
   * Turn ended → flush pending deltas, sample context usage (the ONLY token
   * source, pull-only), update coarse state, and forward turn + token frames.
   */
  handleTurnEnd(payload: PiTurnPayload, ctx?: PiExtensionContext): void {
    this.flushPending();
    this.sampleUsage(ctx);
    this.forward({ type: 'inner.turn', phase: 'end', turnIndex: payload.turnIndex ?? -1, ts: this.now() });
    if (this.coarse.contextTokens !== undefined || this.coarse.contextPercent !== undefined) {
      this.forward({
        type: 'inner.token',
        ...(this.coarse.contextTokens !== undefined ? { contextTokens: this.coarse.contextTokens } : {}),
        ...(this.coarse.contextPercent !== undefined ? { contextPercent: this.coarse.contextPercent } : {}),
      });
    }
  }

  /** Pull context usage from the handler ctx and fold it into coarse state. */
  private sampleUsage(ctx?: PiExtensionContext): void {
    if (!ctx || typeof ctx.getContextUsage !== 'function') return;
    let usage;
    try {
      usage = ctx.getContextUsage();
    } catch (err) {
      log('getContextUsage failed:', err);
      return;
    }
    if (!usage) return;
    if (typeof usage.tokens === 'number') this.coarse.contextTokens = usage.tokens;
    if (typeof usage.percent === 'number') this.coarse.contextPercent = usage.percent;
  }

  // ── Coalescing (source-side; bounds wire rate) ─────────────────────────────

  private appendDelta(kind: 'thinking' | 'text', delta: string): void {
    if (this.pending && this.pending.kind !== kind) {
      // Kind switched (thinking→text or vice versa) — flush to preserve order.
      this.flushPending();
    }
    if (!this.pending) {
      this.pending = { kind, text: '', startedAt: this.now() };
    }
    this.pending.text += delta;
    // The char-threshold flush also CAPS the `+=` concat window — the buffer
    // never grows past ~coalesceChars before being cut loose, so repeated
    // appends stay bounded regardless of total output length. Don't remove it.
    if (this.pending.text.length >= this.coalesceChars) {
      this.flushPending();
    }
  }

  /** Emit the buffered thinking/text as one inner.thinking frame (presence-gated). */
  flushPending(): void {
    const p = this.pending;
    if (!p || p.text.length === 0) {
      this.pending = null;
      return;
    }
    this.pending = null;
    this.forward({ type: 'inner.thinking', delta: p.text, kind: p.kind });
  }

  // ── Presence gate + forward ────────────────────────────────────────────────

  /** Rate-limited presence check — caches `subscriberCount > 0` per presencePollMs. */
  private isPresent(): boolean {
    const t = this.now();
    if (t - this.lastPresenceCheck >= this.presencePollMs) {
      this.lastPresenceCheck = t;
      try {
        this.presentCached = this.registry.subscriberCount(this.workflowId) > 0;
      } catch (err) {
        log('subscriberCount failed (treating as no subscribers):', err);
        this.presentCached = false;
      }
    }
    return this.presentCached;
  }

  /** Forward a fine frame iff a subscriber is present (the firehose gate). */
  private forward(frame: InnerFrame): void {
    if (!this.isPresent()) return;
    try {
      this.registry.publish(this.workflowId, frame);
    } catch (err) {
      log(`publish ${frame.type} failed:`, err);
    }
  }
}
