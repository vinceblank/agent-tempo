/**
 * Unit tests for the SSE replay ring buffer (SSE-PROTOCOL.md §7.1).
 */
import { describe, it, expect } from 'vitest';
import { createRingBuffer, RING_BUFFER_CAPACITY } from '../../src/http/ring-buffer';

describe('createRingBuffer', () => {
  it('starts empty with sane bookkeeping', () => {
    const r = createRingBuffer<string>(4);
    expect(r.size).toBe(0);
    expect(r.capacity).toBe(4);
    expect(r.oldestSeq).toBeNull();
    expect(r.newestSeq).toBeNull();
    expect(r.toArray()).toEqual([]);
  });
  it('rejects non-positive capacity', () => {
    expect(() => createRingBuffer(0)).toThrow();
    expect(() => createRingBuffer(-1)).toThrow();
    expect(() => createRingBuffer(1.5 as unknown as number)).toThrow();
  });
  it('default capacity is the §7.1 lock-in (256)', () => {
    expect(RING_BUFFER_CAPACITY).toBe(256);
    expect(createRingBuffer<string>().capacity).toBe(256);
  });
});

describe('push', () => {
  it('grows up to capacity, then evicts oldest FIFO', () => {
    const r = createRingBuffer<string>(3);
    r.push({ seq: 0, payload: 'a' });
    r.push({ seq: 1, payload: 'b' });
    r.push({ seq: 2, payload: 'c' });
    expect(r.size).toBe(3);
    expect(r.toArray().map((e) => e.payload)).toEqual(['a', 'b', 'c']);
    r.push({ seq: 3, payload: 'd' });
    expect(r.size).toBe(3);
    expect(r.toArray().map((e) => e.payload)).toEqual(['b', 'c', 'd']);
    expect(r.oldestSeq).toBe(1);
    expect(r.newestSeq).toBe(3);
  });
  it('rejects non-monotonic seq', () => {
    const r = createRingBuffer<string>(4);
    r.push({ seq: 5, payload: 'a' });
    expect(() => r.push({ seq: 5, payload: 'b' })).toThrow(/non-monotonic/);
    expect(() => r.push({ seq: 4, payload: 'c' })).toThrow(/non-monotonic/);
    // Continuing forward is fine.
    r.push({ seq: 6, payload: 'd' });
    expect(r.toArray().map((e) => e.payload)).toEqual(['a', 'd']);
  });
});

describe('sliceFrom', () => {
  it('returns empty when ring is empty', () => {
    const r = createRingBuffer<number>(3);
    expect(r.sliceFrom(0)).toEqual([]);
  });
  it('returns events with seq >= fromSeq', () => {
    const r = createRingBuffer<string>(4);
    r.push({ seq: 0, payload: 'a' });
    r.push({ seq: 1, payload: 'b' });
    r.push({ seq: 2, payload: 'c' });
    expect(r.sliceFrom(1).map((e) => e.payload)).toEqual(['b', 'c']);
    expect(r.sliceFrom(0).map((e) => e.payload)).toEqual(['a', 'b', 'c']);
    expect(r.sliceFrom(2).map((e) => e.payload)).toEqual(['c']);
    expect(r.sliceFrom(3)).toEqual([]);
  });
  it('returns nothing below the oldest after eviction', () => {
    const r = createRingBuffer<string>(2);
    r.push({ seq: 0, payload: 'a' });
    r.push({ seq: 1, payload: 'b' });
    r.push({ seq: 2, payload: 'c' });
    // 'a' was evicted; sliceFrom(0) only returns what survives.
    expect(r.sliceFrom(0).map((e) => e.payload)).toEqual(['b', 'c']);
  });
});

describe('cyclic indexing across many wraps', () => {
  it('preserves insertion order through repeated wraparound', () => {
    const r = createRingBuffer<number>(4);
    for (let i = 0; i < 20; i++) r.push({ seq: i, payload: i });
    expect(r.toArray().map((e) => e.payload)).toEqual([16, 17, 18, 19]);
    expect(r.oldestSeq).toBe(16);
    expect(r.newestSeq).toBe(19);
  });
});
