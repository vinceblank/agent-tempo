/**
 * Unit tests for the `<bootEpoch>:<seq>` event-id contract
 * (SSE-PROTOCOL.md §5).
 */
import { describe, it, expect } from 'vitest';
import {
  compareEventIds,
  formatEventId,
  parseEventId,
  SeqAllocator,
} from '../../src/http/event-id';

describe('formatEventId', () => {
  it('renders <epoch>:<seq>', () => {
    expect(formatEventId(1714000000000, 0)).toBe('1714000000000:0');
    expect(formatEventId(1, 99)).toBe('1:99');
  });
  it('rejects non-integer or negative components', () => {
    expect(() => formatEventId(-1, 0)).toThrow(/invalid epoch/);
    expect(() => formatEventId(1.5, 0)).toThrow(/invalid epoch/);
    expect(() => formatEventId(1, -1)).toThrow(/invalid seq/);
    expect(() => formatEventId(1, 1.1)).toThrow(/invalid seq/);
  });
});

describe('parseEventId', () => {
  it('parses well-formed tokens', () => {
    expect(parseEventId('1714000000000:42')).toEqual({ epoch: 1714000000000, seq: 42 });
    expect(parseEventId('0:0')).toEqual({ epoch: 0, seq: 0 });
  });
  it('tolerates surrounding whitespace (HTTP intermediaries normalize headers)', () => {
    expect(parseEventId('  1:2 ')).toEqual({ epoch: 1, seq: 2 });
  });
  it('returns null for malformed input', () => {
    expect(parseEventId(undefined)).toBeNull();
    expect(parseEventId(null)).toBeNull();
    expect(parseEventId('')).toBeNull();
    expect(parseEventId('foo')).toBeNull();
    expect(parseEventId('1:2:3')).toBeNull();
    expect(parseEventId('-1:0')).toBeNull();
    expect(parseEventId('1.5:0')).toBeNull();
    expect(parseEventId(':5')).toBeNull();
    expect(parseEventId('5:')).toBeNull();
  });
});

describe('compareEventIds', () => {
  it('orders by epoch first', () => {
    expect(compareEventIds({ epoch: 1, seq: 100 }, { epoch: 2, seq: 0 })).toBeLessThan(0);
    expect(compareEventIds({ epoch: 3, seq: 0 }, { epoch: 2, seq: 999 })).toBeGreaterThan(0);
  });
  it('falls through to seq when epochs match', () => {
    expect(compareEventIds({ epoch: 5, seq: 1 }, { epoch: 5, seq: 2 })).toBeLessThan(0);
    expect(compareEventIds({ epoch: 5, seq: 2 }, { epoch: 5, seq: 1 })).toBeGreaterThan(0);
    expect(compareEventIds({ epoch: 5, seq: 7 }, { epoch: 5, seq: 7 })).toBe(0);
  });
});

describe('SeqAllocator', () => {
  it('returns monotonic ids prefixed by the configured epoch', () => {
    const a = new SeqAllocator(1714);
    expect(a.next()).toEqual({ eventId: '1714:0', tuple: { epoch: 1714, seq: 0 } });
    expect(a.next()).toEqual({ eventId: '1714:1', tuple: { epoch: 1714, seq: 1 } });
    expect(a.next()).toEqual({ eventId: '1714:2', tuple: { epoch: 1714, seq: 2 } });
  });
  it('peekNextSeq does not advance the counter', () => {
    const a = new SeqAllocator(0);
    a.next();
    expect(a.peekNextSeq()).toBe(1);
    expect(a.peekNextSeq()).toBe(1);
    a.next();
    expect(a.peekNextSeq()).toBe(2);
  });
  it('rejects an invalid bootEpoch at construction', () => {
    expect(() => new SeqAllocator(-1)).toThrow(/invalid bootEpoch/);
    expect(() => new SeqAllocator(1.5)).toThrow(/invalid bootEpoch/);
  });
});
