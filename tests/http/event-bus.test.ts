/**
 * Unit tests for `EnsembleEventBus` — the §6/§7/§8 fan-out + replay engine.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import {
  EnsembleEventBus,
  RATE_LIMIT_WINDOW_MS,
  THROTTLE_SUPPRESS_MS,
  topicOf,
  type BusEvent,
} from '../../src/http/event-bus';
import { SeqAllocator } from '../../src/http/event-id';

/** Drive a bus with an injectable clock so all timing is deterministic. */
function makeBus(opts: {
  bootEpoch?: number;
  bufferCapacity?: number;
  ensembleRateLimit?: number;
  chatRateLimit?: number;
  heartbeatMs?: number;
  heartbeatSuppressMs?: number;
} = {}): { bus: EnsembleEventBus; advance: (ms: number) => void; nowRef: { value: number } } {
  const nowRef = { value: 1_000_000 };
  const bus = new EnsembleEventBus({
    scope: 'ensemble:test',
    allocator: new SeqAllocator(opts.bootEpoch ?? 1714000000000),
    bufferCapacity: opts.bufferCapacity ?? 4,
    now: () => nowRef.value,
    ensembleRateLimit: opts.ensembleRateLimit,
    chatRateLimit: opts.chatRateLimit,
    heartbeatMs: opts.heartbeatMs,
    heartbeatSuppressMs: opts.heartbeatSuppressMs,
  });
  return { bus, advance: (ms) => { nowRef.value += ms; }, nowRef };
}

/**
 * Drain everything currently queued on a subscription, synchronously.
 *
 * Reads `Subscription.pending` directly (cast through a mutable alias)
 * rather than racing `sub.next()` against a microtask. The race-based
 * approach loses events when a follow-up `flush` resolves a pending
 * `next()` promise that the previous drain already abandoned — see
 * the "does not emit chat.compressed before the deferred timer fires"
 * test for the failure mode.
 */
async function drain(sub: AsyncIterableIterator<BusEvent>): Promise<BusEvent[]> {
  // Yield to microtasks so any synchronous emits from the caller land
  // in the queue before we read it.
  await Promise.resolve();
  const sub_ = sub as unknown as { pending: BusEvent[] };
  const out = [...sub_.pending];
  sub_.pending.length = 0;
  return out;
}

describe('emit', () => {
  it('allocates monotonic eventIds and pushes to subscribers', async () => {
    const { bus } = makeBus();
    const sub = bus.subscribe();
    const r1 = bus.emit('player.added', { playerId: 'a' });
    const r2 = bus.emit('player.added', { playerId: 'b' });
    expect(r1?.eventId).toBe('1714000000000:0');
    expect(r2?.eventId).toBe('1714000000000:1');
    const events = await drain(sub);
    expect(events).toHaveLength(2);
    expect(events[0].eventId).toBe('1714000000000:0');
    expect(events[0].type).toBe('player.added');
    expect(events[1].eventId).toBe('1714000000000:1');
    sub.close();
  });
  it('buffers events for replay (non-heartbeat)', () => {
    const { bus } = makeBus({ bufferCapacity: 4 });
    bus.emit('player.added', { playerId: 'a' });
    bus.emit('player.added', { playerId: 'b' });
    bus.emit('player.added', { playerId: 'c' });
    expect(bus.oldestSeq()).toBe(0);
    expect(bus.newestSeq()).toBe(2);
    const replay = bus.replayFrom(0);
    // replayFrom(N) returns events with seq > N
    expect(replay.map((e) => e.eventId)).toEqual(['1714000000000:1', '1714000000000:2']);
  });
  it('does NOT buffer heartbeats (§7.1)', () => {
    const { bus, advance } = makeBus({ heartbeatSuppressMs: 0 });
    bus.tickHeartbeat();
    advance(50);
    bus.emit('player.added', { playerId: 'a' });
    advance(50);
    bus.tickHeartbeat();
    // Only the player.added is in the ring.
    expect(bus.replayFrom(-1).map((e) => e.type)).toEqual(['player.added']);
  });
});

describe('subscribe with afterSeq replay', () => {
  it('replays events with seq > afterSeq before live tail', async () => {
    const { bus } = makeBus();
    bus.emit('player.added', { playerId: 'a' });
    bus.emit('player.added', { playerId: 'b' });
    bus.emit('player.added', { playerId: 'c' });
    const sub = bus.subscribe({ afterSeq: 0 });
    const events = await drain(sub);
    expect(events.map((e) => e.payload)).toEqual([
      { playerId: 'b' },
      { playerId: 'c' },
    ]);
    sub.close();
  });
  it('replays nothing when afterSeq >= newestSeq', async () => {
    const { bus } = makeBus();
    bus.emit('player.added', { playerId: 'a' });
    const sub = bus.subscribe({ afterSeq: 0 });
    const events = await drain(sub);
    expect(events).toEqual([]);
    sub.close();
  });
});

describe('heartbeat §6 suppression', () => {
  it('emits when no other event in the suppression window', () => {
    const { bus } = makeBus({ heartbeatSuppressMs: 8_000 });
    const r = bus.tickHeartbeat();
    expect(r).not.toBeNull();
  });
  it('suppresses when another event was emitted within the window', () => {
    const { bus, advance } = makeBus({ heartbeatSuppressMs: 8_000 });
    bus.emit('player.added', { playerId: 'a' });
    advance(7_000);
    expect(bus.tickHeartbeat()).toBeNull();
    advance(2_000); // total 9_000ms since the player.added
    expect(bus.tickHeartbeat()).not.toBeNull();
  });
});

describe('§8 ensemble-wide 50/s ceiling', () => {
  it('drops non-essential events after the ceiling and emits throttled once', async () => {
    const { bus } = makeBus({ ensembleRateLimit: 3 });
    const sub = bus.subscribe();
    // Three flag flips (non-essential), all should pass.
    for (let i = 0; i < 3; i++) {
      expect(bus.emit('flags.changed', { ensemble: 't', paused: i % 2 === 0, held: false, at: '' }))
        .not.toBeNull();
    }
    // Fourth crosses the ceiling — non-essential, dropped, throttled emitted instead.
    const r = bus.emit('flags.changed', { ensemble: 't', paused: false, held: false, at: '' });
    expect(r).toBeNull();
    const events = await drain(sub);
    expect(events.map((e) => e.type)).toEqual(['flags.changed', 'flags.changed', 'flags.changed', 'throttled']);
    sub.close();
  });
  it('still allows essential events through after the ceiling fires', async () => {
    const { bus } = makeBus({ ensembleRateLimit: 1 });
    const sub = bus.subscribe();
    bus.emit('flags.changed', { ensemble: 't', paused: false, held: false, at: '' });
    bus.emit('flags.changed', { ensemble: 't', paused: true, held: false, at: '' }); // throttled
    bus.emit('player.added', { playerId: 'a' }); // essential — should still flow
    const events = await drain(sub);
    expect(events.map((e) => e.type)).toContain('player.added');
    expect(events.map((e) => e.type)).toContain('throttled');
  });
  it('suppresses heartbeats during throttle window', () => {
    const { bus, advance } = makeBus({ ensembleRateLimit: 1 });
    bus.emit('flags.changed', { ensemble: 't', paused: false, held: false, at: '' });
    bus.emit('flags.changed', { ensemble: 't', paused: true, held: false, at: '' }); // triggers throttle
    advance(500);
    expect(bus.tickHeartbeat()).toBeNull(); // still in suppress window
    advance(THROTTLE_SUPPRESS_MS + 100);
    // After window — heartbeat may still be suppressed by §6 rule (recent flags emit).
    // Push past §6 too.
    advance(10_000);
    expect(bus.tickHeartbeat()).not.toBeNull();
  });
});

describe('§8 chat 100/s cap', () => {
  /**
   * Helper — drop a chat message and force the deferred
   * `chat.compressed` to flush synchronously. Skips the production
   * `setTimeout` so tests stay deterministic without `vi.useFakeTimers`.
   */
  const flush = (bus: EnsembleEventBus) =>
    (bus as unknown as { _flushChatCompressedForTest: () => void })._flushChatCompressedForTest();

  it('collapses excess chat into a single chat.compressed', async () => {
    const { bus } = makeBus({ chatRateLimit: 2 });
    const sub = bus.subscribe();
    bus.emit('chat.appended', { id: '1', from: 'a', to: 'b', text: 'x', timestamp: '', role: 'maestro-out' });
    bus.emit('chat.appended', { id: '2', from: 'a', to: 'b', text: 'y', timestamp: '', role: 'maestro-out' });
    // Over-cap drops accumulate while the deferred timer is pending.
    expect(bus.emit('chat.appended', { id: '3', from: 'a', to: 'b', text: 'z', timestamp: '', role: 'maestro-out' })).toBeNull();
    expect(bus.emit('chat.appended', { id: '4', from: 'a', to: 'b', text: 'w', timestamp: '', role: 'maestro-out' })).toBeNull();
    flush(bus);
    const events = await drain(sub);
    const types = events.map((e) => e.type);
    expect(types.filter((t) => t === 'chat.appended')).toHaveLength(2);
    const compressed = events.filter((e) => e.type === 'chat.compressed');
    expect(compressed).toHaveLength(1);
    expect((compressed[0].payload as { dropped: number }).dropped).toBe(2);
    sub.close();
  });

  it('reports the actual burst count (150-message burst → dropped: 149)', async () => {
    // QA #324 review followup — verifies the timer-deferred emission
    // strategy. With rate=1 the first chat.appended passes; the
    // remaining 149 all drop into a single chat.compressed.
    const { bus } = makeBus({ chatRateLimit: 1 });
    const sub = bus.subscribe();
    for (let i = 0; i < 150; i++) {
      bus.emit('chat.appended', {
        id: String(i), from: 'a', to: 'b', text: 'x', timestamp: '', role: 'maestro-out',
      });
    }
    flush(bus);
    const events = await drain(sub);
    expect(events.filter((e) => e.type === 'chat.appended')).toHaveLength(1);
    const compressed = events.filter((e) => e.type === 'chat.compressed');
    expect(compressed).toHaveLength(1);
    expect((compressed[0].payload as { dropped: number }).dropped).toBe(149);
    sub.close();
  });

  it('does not emit chat.compressed before the deferred timer fires', async () => {
    // Pre-flush, only the cap-passing messages are in the queue —
    // `chat.compressed` is held until the burst settles.
    const { bus } = makeBus({ chatRateLimit: 2 });
    const sub = bus.subscribe();
    bus.emit('chat.appended', { id: '1', from: 'a', to: 'b', text: 'x', timestamp: '', role: 'maestro-out' });
    bus.emit('chat.appended', { id: '2', from: 'a', to: 'b', text: 'y', timestamp: '', role: 'maestro-out' });
    bus.emit('chat.appended', { id: '3', from: 'a', to: 'b', text: 'z', timestamp: '', role: 'maestro-out' });
    bus.emit('chat.appended', { id: '4', from: 'a', to: 'b', text: 'w', timestamp: '', role: 'maestro-out' });
    const events = await drain(sub);
    expect(events.filter((e) => e.type === 'chat.compressed')).toHaveLength(0);
    expect(events.filter((e) => e.type === 'chat.appended')).toHaveLength(2);
    // Still pending — flush now drains the held event.
    flush(bus);
    const more = await drain(sub);
    expect(more.filter((e) => e.type === 'chat.compressed')).toHaveLength(1);
    sub.close();
  });

  it('clears the pending chat.compressed timer on close()', () => {
    const { bus } = makeBus({ chatRateLimit: 1 });
    bus.emit('chat.appended', { id: '1', from: 'a', to: 'b', text: 'x', timestamp: '', role: 'maestro-out' });
    bus.emit('chat.appended', { id: '2', from: 'a', to: 'b', text: 'y', timestamp: '', role: 'maestro-out' });
    // close() should clear the pending timer without throwing.
    expect(() => bus.close()).not.toThrow();
  });
});

describe('topic filtering', () => {
  it('only delivers events matching the topic filter, plus essentials', async () => {
    const { bus } = makeBus();
    const sub = bus.subscribe({ topics: new Set(['chat']) });
    bus.emit('chat.appended', { id: '1', from: 'a', to: 'b', text: 'x', timestamp: '', role: 'maestro-out' });
    bus.emit('flags.changed', { ensemble: 't', paused: false, held: false, at: '' }); // filtered out
    bus.emit('player.phase_changed', { playerId: 'a', ensemble: 't', phase: 'attached', at: '' }); // filtered out
    bus.emit('player.added', { playerId: 'b' }); // essential — passes
    const events = await drain(sub);
    const types = events.map((e) => e.type);
    expect(types).toContain('chat.appended');
    expect(types).toContain('player.added');
    expect(types).not.toContain('flags.changed');
    expect(types).not.toContain('player.phase_changed');
    sub.close();
  });
});

describe('topicOf', () => {
  it('maps event types to their query-string category', () => {
    expect(topicOf('player.phase_changed')).toBe('phase');
    expect(topicOf('chat.appended')).toBe('chat');
    expect(topicOf('chat.compressed')).toBe('chat');
    expect(topicOf('flags.changed')).toBe('flags');
    expect(topicOf('schedules.changed')).toBe('schedules');
    expect(topicOf('heartbeat')).toBe('heartbeat');
  });
  it('returns null for essential / always-emit kinds', () => {
    expect(topicOf('snapshot')).toBeNull();
    expect(topicOf('gap')).toBeNull();
    expect(topicOf('throttled')).toBeNull();
    expect(topicOf('player.added')).toBeNull();
    expect(topicOf('host_profile.changed')).toBeNull();
  });
});

describe('close', () => {
  it('drops all subscribers and rejects new emits', async () => {
    const { bus } = makeBus();
    const s1 = bus.subscribe();
    const s2 = bus.subscribe();
    bus.close();
    expect((await s1.next()).done).toBe(true);
    expect((await s2.next()).done).toBe(true);
    expect(bus.emit('player.added', { playerId: 'x' })).toBeNull();
    expect(bus.subscriberCount()).toBe(0);
  });
  it('is idempotent', () => {
    const { bus } = makeBus();
    bus.close();
    expect(() => bus.close()).not.toThrow();
  });
});

describe('subscriberCount', () => {
  it('reflects live subscriptions only', () => {
    const { bus } = makeBus();
    expect(bus.subscriberCount()).toBe(0);
    const s1 = bus.subscribe();
    const s2 = bus.subscribe();
    expect(bus.subscriberCount()).toBe(2);
    s1.close();
    expect(bus.subscriberCount()).toBe(1);
    s2.close();
    expect(bus.subscriberCount()).toBe(0);
  });
});
