/**
 * Fixed-capacity FIFO ring buffer for SSE replay (SSE-PROTOCOL.md §7.1).
 *
 * Holds at most `capacity` items. Past capacity, `push` evicts the
 * oldest. Items are stored alongside a strictly-monotonic `seq`
 * (provided by the caller, sourced from {@link SeqAllocator}) so
 * replay can address ranges without scanning.
 *
 * **Default capacity**: 256 events per ensemble (§7.1). Power of two,
 * ≤ 128 KiB worst case at ~500 B/event. Larger sizes don't materially
 * widen the common-case reconnect window once §6 coalescing kicks in.
 */

/** Default per-ensemble buffer size — locked in by §7.1. */
export const RING_BUFFER_CAPACITY = 256;

export interface BufferedEvent<T> {
  /** Strictly-monotonic seq value matching the wire `<bootEpoch>:<seq>`. */
  seq: number;
  payload: T;
}

export interface RingBuffer<T> {
  /** Number of items currently held. */
  readonly size: number;
  /** Configured maximum size. */
  readonly capacity: number;
  /** `seq` of the oldest item, or `null` when empty. Monotone-increasing across the buffer's lifetime as evictions occur. */
  readonly oldestSeq: number | null;
  /** `seq` of the newest item, or `null` when empty. */
  readonly newestSeq: number | null;
  /** Append a new item. Evicts the oldest when at capacity. Throws on a non-monotonic seq (ring assumes the caller pulls from a SeqAllocator). */
  push(item: BufferedEvent<T>): void;
  /** Return every item with `seq >= fromSeq`, in original order. Empty array if none qualify. */
  sliceFrom(fromSeq: number): BufferedEvent<T>[];
  /** Snapshot of all items in order — escape hatch for tests + diagnostics. */
  toArray(): BufferedEvent<T>[];
}

/**
 * Build a ring buffer of the given capacity. Implementation uses a
 * cyclic array — push is O(1), `sliceFrom` is O(n) where n is the
 * number of returned items.
 */
export function createRingBuffer<T>(capacity: number = RING_BUFFER_CAPACITY): RingBuffer<T> {
  if (!Number.isInteger(capacity) || capacity < 1) {
    throw new Error(`createRingBuffer: capacity must be a positive integer, got ${capacity}`);
  }
  const slots: Array<BufferedEvent<T> | undefined> = new Array(capacity);
  let head = 0; // index where the next push lands
  let count = 0;
  let lastSeq: number | null = null;

  return {
    get size(): number { return count; },
    get capacity(): number { return capacity; },
    get oldestSeq(): number | null {
      if (count === 0) return null;
      const idx = (head - count + capacity) % capacity;
      return slots[idx]!.seq;
    },
    get newestSeq(): number | null {
      if (count === 0) return null;
      const idx = (head - 1 + capacity) % capacity;
      return slots[idx]!.seq;
    },
    push(item: BufferedEvent<T>) {
      if (lastSeq !== null && item.seq <= lastSeq) {
        throw new Error(
          `RingBuffer.push: non-monotonic seq ${item.seq} (last was ${lastSeq})`,
        );
      }
      slots[head] = item;
      head = (head + 1) % capacity;
      if (count < capacity) count++;
      lastSeq = item.seq;
    },
    sliceFrom(fromSeq: number): BufferedEvent<T>[] {
      const out: BufferedEvent<T>[] = [];
      if (count === 0) return out;
      const startIdx = (head - count + capacity) % capacity;
      for (let i = 0; i < count; i++) {
        const slot = slots[(startIdx + i) % capacity]!;
        if (slot.seq >= fromSeq) out.push(slot);
      }
      return out;
    },
    toArray(): BufferedEvent<T>[] {
      const out: BufferedEvent<T>[] = [];
      if (count === 0) return out;
      const startIdx = (head - count + capacity) % capacity;
      for (let i = 0; i < count; i++) {
        out.push(slots[(startIdx + i) % capacity]!);
      }
      return out;
    },
  };
}
