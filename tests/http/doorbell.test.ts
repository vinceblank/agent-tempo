/**
 * Unit tests for the cue-doorbell registry (T1.1 PR-1,
 * docs/design/t11-cue-doorbell.md §2.2). Pins the §1 invariant mechanics:
 * no queue, no replay, ring-with-no-listener drops, connected listeners
 * coalesce to ONE pending ding, ring() never throws.
 */
import { describe, it, expect } from 'vitest';
import { DoorbellRegistry, DoorbellSubscription } from '../../src/http/doorbell';
import { sessionWorkflowId } from '../../src/config';

const E = 'demo';
const P = 'tempo-worker';
const WF = sessionWorkflowId(E, P);

/** Race-free helper: true iff `p` settles before a macrotask tick. */
async function settled(p: Promise<unknown>): Promise<boolean> {
  let done = false;
  void p.then(() => { done = true; });
  await new Promise((r) => setTimeout(r, 0));
  return done;
}

describe('DoorbellSubscription', () => {
  it('wakes a parked consumer on ring', async () => {
    const sub = new DoorbellSubscription();
    const next = sub.next();
    expect(await settled(next)).toBe(false);
    sub.ring();
    expect(await next).toEqual({ value: undefined, done: false });
  });

  it('coalesces rings while the consumer is mid-iteration into ONE pending ding', async () => {
    const sub = new DoorbellSubscription();
    // No parked waiter: three rings arrive while the consumer is busy.
    sub.ring();
    sub.ring();
    sub.ring();
    // Exactly one ding is pending …
    expect(await sub.next()).toEqual({ value: undefined, done: false });
    // … and the next take parks (no queue — §1.2).
    expect(await settled(sub.next())).toBe(false);
  });

  it('close() wakes a parked consumer with done and drops any pending bit', async () => {
    const sub = new DoorbellSubscription();
    const next = sub.next();
    sub.close();
    expect(await next).toEqual({ value: undefined, done: true });
    // Post-close: rings are no-ops, iteration stays done.
    sub.ring();
    expect(await sub.next()).toEqual({ value: undefined, done: true });
  });

  it('is async-iterable and ends on close', async () => {
    const sub = new DoorbellSubscription();
    sub.ring();
    const seen: number[] = [];
    const loop = (async () => {
      for await (const _ of sub) {
        void _;
        seen.push(1);
        if (seen.length === 2) sub.close();
      }
    })();
    sub.ring();
    await loop;
    expect(seen).toHaveLength(2);
  });
});

describe('DoorbellRegistry', () => {
  it('ring with no listener drops on the floor (indistinguishable from never-sent)', () => {
    const reg = new DoorbellRegistry();
    // Must not throw, must not accumulate anything a later subscriber sees.
    reg.ring(E, P);
    const sub = reg.subscribe(WF);
    // The pre-subscribe ring was NOT buffered: next() parks.
    return settled(sub.next()).then((s) => expect(s).toBe(false));
  });

  it('fans a ring out to every live subscriber for the player', async () => {
    const reg = new DoorbellRegistry();
    const a = reg.subscribe(WF);
    const b = reg.subscribe(WF);
    const nextA = a.next();
    const nextB = b.next();
    reg.ring(E, P);
    expect(await nextA).toEqual({ value: undefined, done: false });
    expect(await nextB).toEqual({ value: undefined, done: false });
  });

  it('does not ring other players', async () => {
    const reg = new DoorbellRegistry();
    const other = reg.subscribe(sessionWorkflowId(E, 'someone-else'));
    const next = other.next();
    reg.ring(E, P);
    expect(await settled(next)).toBe(false);
  });

  it('unsubscribe closes the sub and prunes the player set', () => {
    const reg = new DoorbellRegistry();
    const sub = reg.subscribe(WF);
    expect(reg.subscriberCount(WF)).toBe(1);
    reg.unsubscribe(WF, sub);
    expect(reg.subscriberCount(WF)).toBe(0);
    expect(reg.totalSubscriberCount()).toBe(0);
  });

  it('closePlayer ends every stream for that player only', async () => {
    const reg = new DoorbellRegistry();
    const target = reg.subscribe(WF);
    const bystander = reg.subscribe(sessionWorkflowId(E, 'bystander'));
    reg.closePlayer(E, P);
    expect(await target.next()).toEqual({ value: undefined, done: true });
    expect(reg.subscriberCount(WF)).toBe(0);
    expect(reg.subscriberCount(sessionWorkflowId(E, 'bystander'))).toBe(1);
    void bystander;
  });

  it('close() ends everything (daemon shutdown)', async () => {
    const reg = new DoorbellRegistry();
    const a = reg.subscribe(WF);
    reg.close();
    expect(await a.next()).toEqual({ value: undefined, done: true });
    expect(reg.totalSubscriberCount()).toBe(0);
  });

  it('ring() never throws, even when a subscriber misbehaves', () => {
    const reg = new DoorbellRegistry();
    const sub = reg.subscribe(WF);
    // Sabotage the subscription — ring() must swallow it (§1: a ring must
    // never propagate into the delivery activity that fired it).
    (sub as unknown as { ring: () => void }).ring = () => { throw new Error('boom'); };
    expect(() => reg.ring(E, P)).not.toThrow();
  });
});
