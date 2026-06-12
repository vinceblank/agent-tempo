/**
 * Cue doorbell registry (T1.1 PR-1, design: docs/design/t11-cue-doorbell.md).
 *
 * A content-free latency hint: "it may be worth polling now." The session
 * workflow's inbox stays the SOLE source of truth — the doorbell only decides
 * WHEN the next poll happens, never WHETHER a message is delivered. The
 * load-bearing invariant (§1): **doorbell loss must be indistinguishable from
 * doorbell-never-sent.** Hence:
 *
 *   - NO payload — a ding carries nothing; the adapter's reaction is exactly
 *     its existing poll + ack sequence.
 *   - NO persistence, NO replay, NO queue — a ring with no listener drops on
 *     the floor. A connected listener holds at most ONE pending bit
 *     (level-triggered: rings while the consumer is mid-iteration coalesce
 *     into a single ding — duplicates cost one wasted poll by design, §5).
 *   - NOT the EnsembleEventBus — doorbell connections must be invisible to
 *     the board-demand machinery: `totalSubscriberCount()` /
 *     `observersPresent` never see them (§3 T0.4/T0.1 hard rule — A DOORBELL
 *     IS NOT DEMAND). Enforced structurally by this separate registry and by
 *     `tests/conformance/doorbell-not-demand.test.ts`.
 *
 * Modeled on {@link InnerLoopRegistry} (the same daemon-local, off-Temporal,
 * ephemeral class of traffic) minus its bounded queue — there is nothing to
 * buffer. Keyed by the player's fixed session `workflowId` (the same key the
 * ingest-token plane uses), derived from `{ensemble, playerId}` at the call
 * sites via `sessionWorkflowId`.
 */
import { sessionWorkflowId } from '../config';

/**
 * One connected `/doorbell` SSE subscriber. Async-iterable: the SSE handler
 * does `for await (const _ of sub) write('event: ding')`. At most one pending
 * notification — no queue, no replay (§1.2).
 */
export class DoorbellSubscription implements AsyncIterableIterator<void> {
  private pending = false;
  private waiter: ((r: IteratorResult<void>) => void) | null = null;
  private closed = false;

  /** Ring this subscriber: wake a parked consumer, or set the single pending bit. */
  ring(): void {
    if (this.closed) return;
    if (this.waiter) {
      const w = this.waiter;
      this.waiter = null;
      w({ value: undefined, done: false });
      return;
    }
    // Consumer is mid-iteration — coalesce into one pending ding
    // (level-triggered; an extra ring is at most one wasted poll, §5).
    this.pending = true;
  }

  next(): Promise<IteratorResult<void>> {
    if (this.closed) return Promise.resolve({ value: undefined, done: true });
    if (this.pending) {
      this.pending = false;
      return Promise.resolve({ value: undefined, done: false });
    }
    return new Promise((resolve) => { this.waiter = resolve; });
  }

  /** Terminate the stream — wakes a parked consumer with `done: true`. Idempotent. */
  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.pending = false;
    if (this.waiter) {
      const w = this.waiter;
      this.waiter = null;
      w({ value: undefined, done: true });
    }
  }

  return(): Promise<IteratorResult<void>> {
    this.close();
    return Promise.resolve({ value: undefined, done: true });
  }

  [Symbol.asyncIterator](): AsyncIterableIterator<void> {
    return this;
  }
}

/**
 * Per-daemon registry of doorbell subscribers, keyed by session `workflowId`.
 * Structurally satisfies the `DoorbellSink["current"]` shape the outbox
 * delivery activities ring (`src/activities/outbox.ts` — late-wired holder,
 * the ObserverPresenceSource pattern; the daemon fills it in at boot).
 */
export class DoorbellRegistry {
  private readonly subs = new Map<string, Set<DoorbellSubscription>>();

  /** Open a new doorbell subscription for a player. Caller drains it, then `unsubscribe`. */
  subscribe(workflowId: string): DoorbellSubscription {
    const sub = new DoorbellSubscription();
    let set = this.subs.get(workflowId);
    if (!set) {
      set = new Set();
      this.subs.set(workflowId, set);
    }
    set.add(sub);
    return sub;
  }

  /** Remove + close one subscription (on SSE disconnect). Prunes the empty player set. */
  unsubscribe(workflowId: string, sub: DoorbellSubscription): void {
    const set = this.subs.get(workflowId);
    if (!set) return;
    set.delete(sub);
    sub.close();
    if (set.size === 0) this.subs.delete(workflowId);
  }

  /**
   * Ring every live subscriber for `{ensemble, playerId}`. No listener →
   * dropped on the floor, nothing logged above debug (§5 row 1: a lost ring
   * is indistinguishable from never-sent). Never throws — the delivery
   * activity calling this must not fail/retry because of a ring.
   */
  ring(ensemble: string, playerId: string): void {
    try {
      const set = this.subs.get(sessionWorkflowId(ensemble, playerId));
      if (!set) return;
      for (const sub of set) sub.ring();
    } catch {
      /* a ring must never propagate — §1: loss ≡ never-sent */
    }
  }

  /** Live subscriber count for one player (tests/diagnostics only — NOT demand). */
  subscriberCount(workflowId: string): number {
    return this.subs.get(workflowId)?.size ?? 0;
  }

  /** Close every subscriber for a player (player destroyed → streams end). */
  closePlayer(ensemble: string, playerId: string): void {
    const workflowId = sessionWorkflowId(ensemble, playerId);
    const set = this.subs.get(workflowId);
    if (!set) return;
    for (const sub of set) sub.close();
    this.subs.delete(workflowId);
  }

  /** Total live doorbell subscribers across all players (diagnostics only — NOT demand). */
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
