/**
 * Inner-loop registry + subscription (3c Tier-2, MD-F) — the DAEMON-LOCAL,
 * off-wire fine-tail sink. NOT on the coordination EnsembleEventBus, NOT on
 * Temporal, NOT replayable (no ring / Last-Event-ID / seq). A per-player live
 * tail of a headless Pi player's inner loop (thinking deltas, tool calls/results,
 * token pressure, turn markers), served by the daemon RUNNING that player.
 *
 * Two clients meet here:
 *   - The OPERATOR side: `GET /v1/players/:e/:p/inner` opens an SSE stream →
 *     {@link InnerLoopRegistry.subscribe} → drains an {@link InnerSubscription}.
 *   - The SOURCE side: eng's `InnerLoopPublisher` (in the detached Pi subprocess)
 *     forwards frames via the thin loopback-HTTP client → `POST /inner/ingest` →
 *     {@link InnerLoopRegistry.publish}. The publisher presence-gates on
 *     {@link InnerLoopRegistry.subscriberCount} (read via `GET /inner/presence`)
 *     so zero watchers ⇒ zero forwarding.
 *
 * Backpressure (registry-owned, per the split with the source-side coalescing):
 * each subscriber has a bounded queue with DROP-OLDEST. When frames are dropped,
 * a single `compacted{dropped,sinceTs}` marker is delivered ahead of the next
 * real frame so the operator knows the tail has gaps. (Source-side coalescing of
 * thinking deltas + ~2KB summary truncation already bound the inbound rate; this
 * is the last-resort guard against a stalled SSE socket.)
 *
 * This module implements eng's `InnerLoopRegistry` DI interface
 * (`publish` + `subscriberCount`) as a SUPERSET that also owns subscriber
 * lifecycle (`subscribe` / `unsubscribe` / `closePlayer`).
 */
import type { InnerFrame, InnerLoopRegistry as InnerLoopSink } from '../pi/inner-loop-publisher';

/** Per-subscriber bounded queue depth before drop-oldest engages. */
export const INNER_SUB_QUEUE_MAX = 256;

/**
 * A frame as delivered on the `/inner` wire — eng's source {@link InnerFrame}
 * plus the registry-injected `compacted` backpressure marker (never produced by
 * the source; purely the sink's gap signal).
 */
export type InnerWireFrame =
  | InnerFrame
  | { type: 'compacted'; dropped: number; sinceTs: number };

/**
 * One connected `/inner` SSE subscriber. Async-iterable: the SSE handler does
 * `for await (const frame of sub) { write(frame) }`. Bounded queue with
 * drop-oldest; a `compacted{dropped,sinceTs}` marker is injected before the next
 * real frame whenever drops have occurred since the last delivery.
 *
 * No ring / replay / seq — this is an ephemeral best-effort tail (MD-F): a
 * disconnect loses in-flight deltas, by design.
 */
export class InnerSubscription implements AsyncIterableIterator<InnerWireFrame> {
  private readonly queue: InnerWireFrame[] = [];
  private dropped = 0;
  private droppedSinceTs = 0;
  private waiter: ((r: IteratorResult<InnerWireFrame>) => void) | null = null;
  private closed = false;

  constructor(private readonly now: () => number = Date.now) {}

  /** Enqueue a frame, dropping the oldest if the queue is full. Source → sub. */
  push(frame: InnerFrame): void {
    if (this.closed) return;
    if (this.queue.length >= INNER_SUB_QUEUE_MAX) {
      this.queue.shift(); // drop oldest
      if (this.dropped === 0) this.droppedSinceTs = this.now();
      this.dropped++;
    }
    this.queue.push(frame);
    // A full queue means no waiter is parked (a waiter only parks on an empty
    // queue), so a drop never races a pending take — drain just wakes a waiter
    // when one exists (queue was empty, now has one item).
    if (this.waiter) {
      const next = this.take();
      if (next) {
        const w = this.waiter;
        this.waiter = null;
        w({ value: next, done: false });
      }
    }
  }

  /** Pull the next deliverable, injecting a `compacted` marker first if drops are pending. */
  private take(): InnerWireFrame | null {
    if (this.dropped > 0) {
      const marker: InnerWireFrame = { type: 'compacted', dropped: this.dropped, sinceTs: this.droppedSinceTs };
      this.dropped = 0;
      return marker;
    }
    return this.queue.shift() ?? null;
  }

  next(): Promise<IteratorResult<InnerWireFrame>> {
    if (this.closed) return Promise.resolve({ value: undefined as never, done: true });
    const item = this.take();
    if (item) return Promise.resolve({ value: item, done: false });
    return new Promise((resolve) => { this.waiter = resolve; });
  }

  /** Terminate the stream — wakes a parked consumer with `done: true`. Idempotent. */
  close(): void {
    if (this.closed) return;
    this.closed = true;
    if (this.waiter) {
      const w = this.waiter;
      this.waiter = null;
      w({ value: undefined as never, done: true });
    }
  }

  return(): Promise<IteratorResult<InnerWireFrame>> {
    this.close();
    return Promise.resolve({ value: undefined as never, done: true });
  }

  [Symbol.asyncIterator](): AsyncIterableIterator<InnerWireFrame> {
    return this;
  }
}

/**
 * Per-daemon registry of inner-loop subscribers, keyed by the player's fixed
 * session `workflowId`. Implements eng's {@link InnerLoopSink} interface
 * (`publish` + `subscriberCount`) so the publisher's thin client and this sink
 * share one contract.
 */
export class InnerLoopRegistry implements InnerLoopSink {
  private readonly subs = new Map<string, Set<InnerSubscription>>();

  constructor(private readonly now: () => number = Date.now) {}

  /** Open a new SSE subscription for a player. Caller drains it, then `unsubscribe`. */
  subscribe(workflowId: string): InnerSubscription {
    const sub = new InnerSubscription(this.now);
    let set = this.subs.get(workflowId);
    if (!set) {
      set = new Set();
      this.subs.set(workflowId, set);
    }
    set.add(sub);
    return sub;
  }

  /** Remove + close one subscription (on SSE disconnect). Prunes the empty player set. */
  unsubscribe(workflowId: string, sub: InnerSubscription): void {
    const set = this.subs.get(workflowId);
    if (!set) return;
    set.delete(sub);
    sub.close();
    if (set.size === 0) this.subs.delete(workflowId);
  }

  /** Fan a frame out to every live subscriber for the player. Source → subs. */
  publish(workflowId: string, frame: InnerFrame): void {
    const set = this.subs.get(workflowId);
    if (!set) return;
    for (const sub of set) sub.push(frame);
  }

  /** Live subscriber count — the publisher's presence gate reads this (via `/inner/presence`). */
  subscriberCount(workflowId: string): number {
    return this.subs.get(workflowId)?.size ?? 0;
  }

  /** Close every subscriber for a player (player gone → streams end with `:closed`). */
  closePlayer(workflowId: string): void {
    const set = this.subs.get(workflowId);
    if (!set) return;
    for (const sub of set) sub.close();
    this.subs.delete(workflowId);
  }

  /** Total live inner-tail subscribers across all players (diagnostics). */
  totalSubscriberCount(): number {
    let n = 0;
    for (const set of this.subs.values()) n += set.size;
    return n;
  }

  /** Close everything (daemon shutdown). */
  close(): void {
    for (const set of this.subs.values()) {
      for (const sub of set) sub.close();
    }
    this.subs.clear();
  }
}
