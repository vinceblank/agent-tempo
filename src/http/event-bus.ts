/**
 * `EnsembleEventBus` — fan-out + ring buffer + replay engine that backs
 * the `/v1/events/:ensemble` SSE endpoint (SSE-PROTOCOL.md §6, §7, §8).
 *
 * **Responsibilities**:
 * - Allocate `<bootEpoch>:<seq>` ids via {@link SeqAllocator}.
 * - Buffer the most recent N events for `Last-Event-ID` replay.
 * - Fan out to every live subscriber, with a per-subscription queue
 *   so a slow consumer doesn't backpressure faster ones.
 * - Enforce wire-level rate caps (§8): ensemble-wide 50 ev/s ceiling
 *   produces a `throttled` event and pauses non-essential streams
 *   (`heartbeat`, `flags.changed`) for 1 s; chat 100 msg/s collapses
 *   to a single `chat.compressed`.
 * - Heartbeat: emit `heartbeat` every `heartbeatMs` (default 10 s) on
 *   the bus, suppressed if any other event has been emitted in the
 *   last `heartbeatSuppressMs` (default 8 s).
 *
 * **NOT in this module**:
 * - Coalescing (phase debounce, schedule SHA-256 diff, flag diff,
 *   host-profile hash compare) — those live in `aggregate.ts` and
 *   feed clean events to the bus.
 * - SSE framing / `Last-Event-ID` parsing — `sse-handler.ts` owns
 *   that and consults the bus for replay slices.
 */
import { createRingBuffer, RING_BUFFER_CAPACITY, type RingBuffer } from './ring-buffer';
import { SeqAllocator, type EventIdTuple } from './event-id';
import type { SseEventKind } from './event-types';

/** Default heartbeat cadence — locked in by §6 / §8. */
export const DEFAULT_HEARTBEAT_MS = 10_000;
/** Default heartbeat suppression window — §6. */
export const DEFAULT_HEARTBEAT_SUPPRESS_MS = 8_000;
/** Ensemble-wide rate ceiling — §8. */
export const DEFAULT_ENSEMBLE_RATE_LIMIT = 50;
/** Chat-only rate ceiling — §8. */
export const DEFAULT_CHAT_RATE_LIMIT = 100;
/** Window over which both rate caps are evaluated. */
export const RATE_LIMIT_WINDOW_MS = 1_000;
/** How long to suppress non-essential streams after `throttled` fires. */
export const THROTTLE_SUPPRESS_MS = 1_000;

/** Event types that are essential — never dropped under throttling. */
const ESSENTIAL_TYPES: ReadonlySet<SseEventKind> = new Set<SseEventKind>([
  'snapshot',
  'gap',
  'throttled',
  'chat.compressed',
  'ensemble.created',
  'ensemble.destroyed',
  'player.added',
  'player.removed',
  'player.phase_changed',
  'chat.appended',
  'schedules.changed',
  'host_profile.changed',
]);

/** Event types the bus suppresses for `THROTTLE_SUPPRESS_MS` after a `throttled` fires. */
const NON_ESSENTIAL_AFTER_THROTTLE: ReadonlySet<SseEventKind> = new Set<SseEventKind>([
  'heartbeat',
  'flags.changed',
]);

/**
 * Internal wire shape for an event traveling the bus. The SSE handler
 * formats this into the `id:` / `event:` / `data:` lines on the wire.
 */
export interface BusEvent {
  eventId: string;
  /** Tuple form of `eventId`, for ring-buffer indexing + comparison. */
  tuple: EventIdTuple;
  type: SseEventKind;
  payload: unknown;
  emittedAt: number;
  /**
   * `true` when the event lives in the ring (`Last-Event-ID` replay
   * sees it). Heartbeats are connection-local and excluded per §7.1.
   */
  bufferable: boolean;
}

export interface SubscribeOpts {
  /**
   * Replay events with `seq > afterSeq` from the ring before live tail.
   * Caller must have already verified epoch-match and that
   * `afterSeq >= ringStart - 1` (otherwise the caller should drive a
   * `gap` event).
   */
  afterSeq?: number;
  /**
   * Server-side topic filter. Setup events
   * (`snapshot`, `gap`, `throttled`, `*.added`, `*.removed`,
   * `*.created`, `*.destroyed`, `host_profile.changed`) always pass
   * regardless of this filter.
   */
  topics?: ReadonlySet<TopicCategory>;
}

/** Maps to `?topics=...` query string per spec §6.1. */
export type TopicCategory = 'phase' | 'chat' | 'flags' | 'schedules' | 'heartbeat';

/** Maps a `SseEventKind` to its filterable topic, or null when essential. */
export function topicOf(kind: SseEventKind): TopicCategory | null {
  switch (kind) {
    case 'player.phase_changed': return 'phase';
    case 'player.activity':      return 'phase';
    case 'chat.appended':
    case 'chat.compressed':     return 'chat';
    case 'flags.changed':       return 'flags';
    case 'schedules.changed':   return 'schedules';
    case 'heartbeat':           return 'heartbeat';
    default:                    return null;
  }
}

/**
 * One open SSE connection's view of the bus. Async iterator yields
 * events in the order the bus emitted them. `close()` is idempotent
 * and must be called when the underlying socket goes away.
 */
export class Subscription implements AsyncIterableIterator<BusEvent> {
  private queue: BusEvent[] = [];
  private resolveNext: ((v: IteratorResult<BusEvent>) => void) | null = null;
  private closed = false;
  /** Caller's hook — bus calls this on close so the parent can drop us from its set. */
  public onClose: (() => void) | null = null;

  constructor(public readonly opts: SubscribeOpts) {}

  /** Push an event onto the consumer queue. Bus → subscription. */
  push(e: BusEvent): void {
    if (this.closed) return;
    if (!this.passesTopicFilter(e)) return;
    if (this.resolveNext) {
      const r = this.resolveNext;
      this.resolveNext = null;
      r({ value: e, done: false });
    } else {
      this.queue.push(e);
    }
  }

  next(): Promise<IteratorResult<BusEvent>> {
    if (this.closed && this.queue.length === 0) {
      return Promise.resolve({ value: undefined, done: true });
    }
    if (this.queue.length > 0) {
      return Promise.resolve({ value: this.queue.shift()!, done: false });
    }
    return new Promise<IteratorResult<BusEvent>>((resolve) => {
      this.resolveNext = resolve;
    });
  }

  async return(): Promise<IteratorResult<BusEvent>> {
    this.close();
    return { value: undefined, done: true };
  }

  [Symbol.asyncIterator](): AsyncIterableIterator<BusEvent> {
    return this;
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    if (this.resolveNext) {
      const r = this.resolveNext;
      this.resolveNext = null;
      r({ value: undefined, done: true });
    }
    if (this.onClose) {
      const fn = this.onClose;
      this.onClose = null;
      try { fn(); } catch { /* ignore — bus internal */ }
    }
  }

  /** True when `close()` has been called. */
  get isClosed(): boolean { return this.closed; }

  /** Snapshot of unread items — exposed for tests + diagnostics only. */
  get pending(): readonly BusEvent[] { return this.queue; }

  private passesTopicFilter(e: BusEvent): boolean {
    if (!this.opts.topics) return true;
    const cat = topicOf(e.type);
    if (cat === null) return true; // essential / always-emit
    return this.opts.topics.has(cat);
  }
}

export interface EventBusOptions {
  /** Free-form scope label for log lines (`'ensemble:demo'`, `'global'`). */
  scope: string;
  allocator: SeqAllocator;
  /** Ring capacity. Defaults to {@link RING_BUFFER_CAPACITY}. */
  bufferCapacity?: number;
  /** Test seam — defaults to `Date.now`. */
  now?: () => number;
  /** Override §8 limits — used by tests; production keeps defaults. */
  ensembleRateLimit?: number;
  chatRateLimit?: number;
  heartbeatMs?: number;
  heartbeatSuppressMs?: number;
}

/**
 * The bus interface — `EnsembleEventBus` and the global cluster bus
 * share this surface. The aggregate poll loop is a strict consumer
 * (only calls `emit`); the SSE handler reads `oldestSeq` /
 * `replayFrom` / `subscribe`.
 */
export interface EventBus {
  readonly scope: string;
  readonly bootEpoch: number;
  /** Ring's oldest seq, or `null` when empty. */
  oldestSeq(): number | null;
  /** Ring's newest seq, or `null` when empty. */
  newestSeq(): number | null;
  /** The next seq the allocator will use — useful for `lastEventId` math even when the ring is empty. */
  nextSeq(): number;

  /**
   * Emit a typed event. Returns the assigned eventId, or `null` when
   * the event was suppressed by §8 caps. Heartbeats with §6
   * suppression also return `null`.
   */
  emit(type: SseEventKind, payload: unknown): { eventId: string } | null;

  /** Replay events with `seq > afterSeq` from the ring buffer. */
  replayFrom(afterSeq: number): BusEvent[];

  /** Open a new subscription. Caller drives snapshot/gap upstream. */
  subscribe(opts?: SubscribeOpts): Subscription;

  /**
   * Tick the heartbeat — emits `heartbeat` only if the §6 suppression
   * gate is open. Production schedules this on a timer; tests call it
   * directly. Returns the heartbeat's eventId, or `null` if suppressed.
   */
  tickHeartbeat(): { eventId: string } | null;

  /** Drain subscribers and stop emitting. Idempotent. */
  close(): void;

  /** Live subscriber count — used by `/v1/health.subscriberCount`. */
  subscriberCount(): number;
}

/** Concrete implementation. Same class powers per-ensemble + global buses. */
export class EnsembleEventBus implements EventBus {
  readonly scope: string;
  readonly bootEpoch: number;

  private readonly allocator: SeqAllocator;
  private readonly ring: RingBuffer<BusEvent>;
  private readonly now: () => number;
  private readonly subs = new Set<Subscription>();
  private readonly ensembleRateLimit: number;
  private readonly chatRateLimit: number;
  private readonly heartbeatMs: number;
  private readonly heartbeatSuppressMs: number;
  private closed = false;

  /** Sliding window of recent emit timestamps for the ensemble-wide cap. */
  private readonly recentEmits: number[] = [];
  /** Sliding window of recent chat emit timestamps. */
  private readonly recentChat: number[] = [];

  /** Last time *any* non-heartbeat event was emitted — drives §6 heartbeat suppression. */
  private lastNonHeartbeatAt = 0;

  /** When set, suppress `heartbeat` and `flags.changed` until this timestamp (post-`throttled` window). */
  private nonEssentialSuppressUntil = 0;

  /** Last time `throttled` was emitted — at most once per `THROTTLE_SUPPRESS_MS` window. */
  private lastThrottledAt = 0;

  /**
   * `chat.compressed` deferred-emission state (PR #324 review followup).
   *
   * **Why deferred**: §6 says "excess collapses into a single
   * `chat.compressed` event" — singular. If we emitted on the first
   * drop, the `dropped` field would always read `1` even when 50+
   * messages got dropped in the same burst. Misleading metadata —
   * eng-4's PR-3 wrapper might surface the count as "N messages
   * dropped" or use it for retry logic.
   *
   * **Resolution**: track every drop in `chatDropCount`; on first
   * drop schedule a `chat.compressed` emission `RATE_LIMIT_WINDOW_MS`
   * later. Subsequent drops in the same burst just increment the
   * counter — no second timer, no second event. When the timer
   * fires, emit `chat.compressed { dropped: <total>, since: <iso> }`
   * and reset. A 150-message burst at rate 1/s now yields one
   * `chat.compressed { dropped: 149 }` event, matching the spec
   * intent.
   *
   * Note: "compression event fired" (timer ran, message went on the
   * wire) is separate from "drop count accumulated" (drops have
   * happened but the timer is still pending). Tests differentiate
   * the two by advancing the fake timer and re-draining.
   */
  private chatDropCount = 0;
  private chatCompressedTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(opts: EventBusOptions) {
    this.scope = opts.scope;
    this.allocator = opts.allocator;
    this.bootEpoch = opts.allocator.bootEpoch;
    this.ring = createRingBuffer<BusEvent>(opts.bufferCapacity ?? RING_BUFFER_CAPACITY);
    this.now = opts.now ?? Date.now;
    this.ensembleRateLimit = opts.ensembleRateLimit ?? DEFAULT_ENSEMBLE_RATE_LIMIT;
    this.chatRateLimit = opts.chatRateLimit ?? DEFAULT_CHAT_RATE_LIMIT;
    this.heartbeatMs = opts.heartbeatMs ?? DEFAULT_HEARTBEAT_MS;
    this.heartbeatSuppressMs = opts.heartbeatSuppressMs ?? DEFAULT_HEARTBEAT_SUPPRESS_MS;
  }

  oldestSeq(): number | null { return this.ring.oldestSeq; }
  newestSeq(): number | null { return this.ring.newestSeq; }
  nextSeq(): number { return this.allocator.peekNextSeq(); }
  subscriberCount(): number { return this.subs.size; }

  emit(type: SseEventKind, payload: unknown): { eventId: string } | null {
    if (this.closed) return null;
    const now = this.now();

    // Heartbeat path: respect §6 suppression — skip when any other
    // event was emitted within the last `heartbeatSuppressMs`.
    if (type === 'heartbeat') {
      if (now - this.lastNonHeartbeatAt < this.heartbeatSuppressMs) return null;
      if (now < this.nonEssentialSuppressUntil) return null;
    }

    // §8 chat 100/s cap — collapse excess to a single `chat.compressed`.
    if (type === 'chat.appended') {
      this.trimWindow(this.recentChat, now);
      if (this.recentChat.length >= this.chatRateLimit) {
        this.chatDropCount++;
        if (!this.chatCompressedTimer) {
          // Defer emission so a single `chat.compressed` can carry the
          // total burst count, not just the first drop. See the
          // `chatDropCount` field comment for the contract.
          this.chatCompressedTimer = setTimeout(
            () => this.flushChatCompressed(),
            RATE_LIMIT_WINDOW_MS,
          );
          if (typeof this.chatCompressedTimer.unref === 'function') {
            this.chatCompressedTimer.unref();
          }
        }
        return null;
      }
      this.recentChat.push(now);
    }

    // §8 ensemble-wide 50/s cap — emit `throttled` once + suppress
    // non-essential streams for 1 s.
    if (NON_ESSENTIAL_AFTER_THROTTLE.has(type) && now < this.nonEssentialSuppressUntil) {
      return null;
    }
    this.trimWindow(this.recentEmits, now);
    if (!ESSENTIAL_TYPES.has(type) && this.recentEmits.length >= this.ensembleRateLimit) {
      // Drop this non-essential event and emit `throttled` (capped per window).
      if (now - this.lastThrottledAt >= THROTTLE_SUPPRESS_MS) {
        this.lastThrottledAt = now;
        this.nonEssentialSuppressUntil = now + THROTTLE_SUPPRESS_MS;
        const since = new Date(now - RATE_LIMIT_WINDOW_MS).toISOString();
        this.emitInternal('throttled', { droppedSince: since, count: 1 }, now);
      }
      return null;
    }

    this.recentEmits.push(now);
    return this.emitInternal(type, payload, now);
  }

  /**
   * Internal emit — bypasses the §8 gates so the bus can self-emit
   * `throttled` and `chat.compressed` while the gate is denying their
   * trigger. Caller has already updated the rate-limit windows.
   */
  private emitInternal(
    type: SseEventKind,
    payload: unknown,
    now: number,
  ): { eventId: string } {
    const { eventId, tuple } = this.allocator.next();
    const bufferable = type !== 'heartbeat'; // §7.1 — heartbeats are not replayed.
    const event: BusEvent = { eventId, tuple, type, payload, emittedAt: now, bufferable };
    if (bufferable) this.ring.push({ seq: tuple.seq, payload: event });
    if (type !== 'heartbeat') this.lastNonHeartbeatAt = now;
    for (const sub of this.subs) sub.push(event);
    return { eventId };
  }

  /**
   * Emit the deferred `chat.compressed` event with the accumulated
   * drop count, then reset. Called by the `setTimeout` scheduled in
   * the chat-rate-cap path; tests may invoke it directly to bypass
   * `vi.advanceTimersByTime` plumbing.
   */
  private flushChatCompressed(): void {
    this.chatCompressedTimer = null;
    if (this.chatDropCount === 0) return;
    const dropped = this.chatDropCount;
    this.chatDropCount = 0;
    const now = this.now();
    this.emitInternal('chat.compressed', {
      dropped,
      since: new Date(now - RATE_LIMIT_WINDOW_MS).toISOString(),
    }, now);
  }

  /** Test seam — force a deferred `chat.compressed` to flush synchronously. */
  _flushChatCompressedForTest(): void {
    if (this.chatCompressedTimer) {
      clearTimeout(this.chatCompressedTimer);
      this.chatCompressedTimer = null;
    }
    this.flushChatCompressed();
  }

  replayFrom(afterSeq: number): BusEvent[] {
    return this.ring.sliceFrom(afterSeq + 1).map((b) => b.payload);
  }

  subscribe(opts: SubscribeOpts = {}): Subscription {
    const sub = new Subscription(opts);
    if (this.closed) {
      // New subscriber on a closed bus — yield no events, just close.
      sub.close();
      return sub;
    }
    if (typeof opts.afterSeq === 'number') {
      const replay = this.replayFrom(opts.afterSeq);
      for (const e of replay) sub.push(e);
    }
    sub.onClose = () => { this.subs.delete(sub); };
    this.subs.add(sub);
    return sub;
  }

  tickHeartbeat(): { eventId: string } | null {
    return this.emit('heartbeat', { at: new Date(this.now()).toISOString() });
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    if (this.chatCompressedTimer) {
      clearTimeout(this.chatCompressedTimer);
      this.chatCompressedTimer = null;
    }
    for (const sub of [...this.subs]) sub.close();
    this.subs.clear();
  }

  /** Drop entries older than `now - RATE_LIMIT_WINDOW_MS` from a sliding window. */
  private trimWindow(window: number[], now: number): void {
    const cutoff = now - RATE_LIMIT_WINDOW_MS;
    while (window.length > 0 && window[0] < cutoff) window.shift();
  }
}

/**
 * Drive the heartbeat on a real timer. Returns a stop function. Call
 * sites pass the bus's own `tickHeartbeat` so test wiring can stay
 * synchronous.
 */
export function startHeartbeatTimer(
  bus: Pick<EventBus, 'tickHeartbeat'>,
  intervalMs: number = DEFAULT_HEARTBEAT_MS,
): () => void {
  const handle = setInterval(() => { bus.tickHeartbeat(); }, intervalMs);
  // Don't keep the daemon alive solely on the heartbeat — workers + HTTP
  // listener are the durable long-running references.
  if (typeof handle.unref === 'function') handle.unref();
  return () => clearInterval(handle);
}
