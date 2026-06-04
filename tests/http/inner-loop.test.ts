/**
 * Unit tests for the daemon-side inner-loop registry + subscription
 * (src/http/inner-loop.ts, 3c Tier-2). Pure — no HTTP, no Pi: drives the
 * registry and subscriptions directly.
 */
import { describe, it, expect } from 'vitest';
import {
  InnerLoopRegistry,
  InnerSubscription,
  INNER_SUB_QUEUE_MAX,
  type InnerWireFrame,
} from '../../src/http/inner-loop';
import type { InnerFrame } from '../../src/pi/inner-loop-publisher';

const thinking = (delta: string): InnerFrame => ({ type: 'inner.thinking', delta, kind: 'thinking' });
const turn = (n: number): InnerFrame => ({ type: 'inner.turn', phase: 'start', turnIndex: n, ts: 0 });

describe('InnerLoopRegistry — fanout + presence', () => {
  it('subscriberCount tracks subscribe/unsubscribe per workflowId', () => {
    const reg = new InnerLoopRegistry();
    expect(reg.subscriberCount('wf1')).toBe(0);
    const a = reg.subscribe('wf1');
    const b = reg.subscribe('wf1');
    reg.subscribe('wf2');
    expect(reg.subscriberCount('wf1')).toBe(2);
    expect(reg.subscriberCount('wf2')).toBe(1);
    expect(reg.totalSubscriberCount()).toBe(3);
    reg.unsubscribe('wf1', a);
    expect(reg.subscriberCount('wf1')).toBe(1);
    reg.unsubscribe('wf1', b);
    expect(reg.subscriberCount('wf1')).toBe(0);
  });

  it('publish fans out to every subscriber of the player only', async () => {
    const reg = new InnerLoopRegistry();
    const a = reg.subscribe('wf1');
    const b = reg.subscribe('wf1');
    const other = reg.subscribe('wf2');
    reg.publish('wf1', thinking('hi'));
    expect((await a.next()).value).toEqual(thinking('hi'));
    expect((await b.next()).value).toEqual(thinking('hi'));
    // wf2 subscriber saw nothing — its next() stays pending; assert via race.
    const pending = Promise.race([
      other.next().then(() => 'delivered'),
      Promise.resolve('pending'),
    ]);
    expect(await pending).toBe('pending');
  });

  it('publish to an unknown workflowId is a no-op (no throw)', () => {
    const reg = new InnerLoopRegistry();
    expect(() => reg.publish('nobody', thinking('x'))).not.toThrow();
    expect(reg.subscriberCount('nobody')).toBe(0);
  });
});

describe('InnerSubscription — delivery + async iteration', () => {
  it('delivers queued frames in order (buffered before consumer pulls)', async () => {
    const sub = new InnerSubscription();
    sub.push(turn(1));
    sub.push(turn(2));
    expect((await sub.next()).value).toEqual(turn(1));
    expect((await sub.next()).value).toEqual(turn(2));
  });

  it('wakes a parked consumer when a frame arrives', async () => {
    const sub = new InnerSubscription();
    const p = sub.next(); // park (queue empty)
    sub.push(turn(7));
    expect((await p).value).toEqual(turn(7));
  });

  it('close() ends the stream and wakes a parked consumer with done:true', async () => {
    const sub = new InnerSubscription();
    const p = sub.next();
    sub.close();
    expect(await p).toEqual({ value: undefined, done: true });
    // subsequent next() also done
    expect(await sub.next()).toEqual({ value: undefined, done: true });
    // push after close is ignored
    sub.push(turn(1));
    expect(await sub.next()).toEqual({ value: undefined, done: true });
  });

  it('works as an async iterator', async () => {
    const sub = new InnerSubscription();
    sub.push(turn(1));
    sub.push(turn(2));
    const seen: number[] = [];
    (async () => {
      for await (const f of sub) {
        if (f.type === 'inner.turn') seen.push(f.turnIndex);
        if (seen.length === 2) sub.close();
      }
    })();
    // give the loop a tick to drain
    await new Promise((r) => setTimeout(r, 5));
    expect(seen).toEqual([1, 2]);
  });
});

describe('InnerSubscription — drop-oldest + compacted backpressure', () => {
  it('drops oldest past the cap and injects ONE compacted marker before the next real frame', async () => {
    let t = 1000;
    const sub = new InnerSubscription(() => t);
    // Fill to the cap, then overflow by 3 (drops the 3 oldest).
    for (let i = 0; i < INNER_SUB_QUEUE_MAX; i++) sub.push(turn(i));
    t = 2000; // advance clock so the first drop stamps sinceTs=2000
    sub.push(turn(INNER_SUB_QUEUE_MAX));     // drop turn(0)
    sub.push(turn(INNER_SUB_QUEUE_MAX + 1)); // drop turn(1)
    sub.push(turn(INNER_SUB_QUEUE_MAX + 2)); // drop turn(2)

    // First delivery is the compacted marker (dropped=3, sinceTs from first drop).
    const first = (await sub.next()).value as InnerWireFrame;
    expect(first).toEqual({ type: 'compacted', dropped: 3, sinceTs: 2000 });

    // Then the surviving queue resumes at the oldest non-dropped frame (turn 3).
    const second = (await sub.next()).value as InnerWireFrame;
    expect(second).toEqual(turn(3));

    // No further compacted markers until new drops occur.
    const third = (await sub.next()).value as InnerWireFrame;
    expect(third).toEqual(turn(4));
  });

  it('no compacted marker when nothing was dropped', async () => {
    const sub = new InnerSubscription();
    sub.push(turn(1));
    expect((await sub.next()).value).toEqual(turn(1));
  });
});

describe('InnerLoopRegistry — closePlayer + close', () => {
  it('closePlayer ends every subscriber for the player and clears the entry', async () => {
    const reg = new InnerLoopRegistry();
    const a = reg.subscribe('wf1');
    const b = reg.subscribe('wf1');
    reg.closePlayer('wf1');
    expect(reg.subscriberCount('wf1')).toBe(0);
    expect(await a.next()).toEqual({ value: undefined, done: true });
    expect(await b.next()).toEqual({ value: undefined, done: true });
  });

  it('close() tears down all players', async () => {
    const reg = new InnerLoopRegistry();
    const a = reg.subscribe('wf1');
    const b = reg.subscribe('wf2');
    reg.close();
    expect(reg.totalSubscriberCount()).toBe(0);
    expect(await a.next()).toEqual({ value: undefined, done: true });
    expect(await b.next()).toEqual({ value: undefined, done: true });
  });
});
