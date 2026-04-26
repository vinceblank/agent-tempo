/**
 * `<bootEpoch>:<seq>` event-id allocator (SSE-PROTOCOL.md §5).
 *
 * **Format**: `"<bootEpoch>:<seq>"`. Two decimal-ASCII parts separated by
 * a single `:`. `bootEpoch` is the daemon process boot time as Unix
 * epoch milliseconds, frozen for the process lifetime. `seq` is a
 * uint64 monotonic counter (starting at `0`) owned by a specific bus.
 *
 * **Why**: a daemon restart must NOT silently lose the snapshot bridge.
 * Without an epoch prefix, a client reconnecting with `Last-Event-ID:
 * 1234` after a daemon restart would be `seq > ringStart=0` and the
 * server would try to replay events that don't exist. The two-stage
 * gate (epoch first → `gap epoch-mismatch`, then seq → `gap overflow`)
 * fixes that.
 *
 * **Scope**: `bootEpoch` is process-global. `seq` is per-bus —
 * `EnsembleEventBus` owns one counter per ensemble; the global bus
 * owns its own. Both v2 upgrade paths in ADR 0004 preserve this
 * contract through the `EnsembleEventBus` interface.
 */

/** Parsed `(epoch, seq)` tuple. */
export interface EventIdTuple {
  epoch: number;
  seq: number;
}

/**
 * Format an `(epoch, seq)` tuple to the wire token. Both components
 * MUST be non-negative integers; callers should never reach for
 * floating-point arithmetic on these values.
 */
export function formatEventId(epoch: number, seq: number): string {
  if (!Number.isInteger(epoch) || epoch < 0) {
    throw new Error(`formatEventId: invalid epoch ${epoch}`);
  }
  if (!Number.isInteger(seq) || seq < 0) {
    throw new Error(`formatEventId: invalid seq ${seq}`);
  }
  return `${epoch}:${seq}`;
}

/**
 * Parse a wire token back into a tuple. Returns `null` for malformed
 * input — caller treats that the same as an `epoch-mismatch` gap (the
 * client is from a previous daemon process / a corrupt header / etc.).
 *
 * Permissive on whitespace because some HTTP intermediaries normalize
 * `Last-Event-ID`; rejects anything outside `[0-9]:[0-9]`.
 */
export function parseEventId(token: string | undefined | null): EventIdTuple | null {
  if (token == null) return null;
  const trimmed = token.trim();
  const m = /^(\d+):(\d+)$/.exec(trimmed);
  if (!m) return null;
  const epoch = Number(m[1]);
  const seq = Number(m[2]);
  if (!Number.isFinite(epoch) || !Number.isFinite(seq)) return null;
  if (!Number.isInteger(epoch) || !Number.isInteger(seq)) return null;
  return { epoch, seq };
}

/**
 * Compare two event-id tuples lexicographically — epoch first, then seq.
 * Returns negative / zero / positive following the standard
 * comparator convention.
 */
export function compareEventIds(a: EventIdTuple, b: EventIdTuple): number {
  if (a.epoch !== b.epoch) return a.epoch < b.epoch ? -1 : 1;
  if (a.seq !== b.seq) return a.seq < b.seq ? -1 : 1;
  return 0;
}

/**
 * Allocates `seq` values for one bus. Each call to {@link next} returns
 * the next monotonic id token bound to the configured `bootEpoch`.
 *
 * `bootEpoch` is supplied by the caller — the daemon constructs one
 * value (`Date.now()`) and threads it through every bus instance so
 * every event in the same process lifetime shares the prefix.
 */
export class SeqAllocator {
  private nextSeq = 0;

  constructor(public readonly bootEpoch: number) {
    if (!Number.isInteger(bootEpoch) || bootEpoch < 0) {
      throw new Error(`SeqAllocator: invalid bootEpoch ${bootEpoch}`);
    }
  }

  /** Allocate the next `(epoch, seq)` and return the formatted token. */
  next(): { eventId: string; tuple: EventIdTuple } {
    const seq = this.nextSeq++;
    return {
      eventId: formatEventId(this.bootEpoch, seq),
      tuple: { epoch: this.bootEpoch, seq },
    };
  }

  /**
   * The seq the next allocation will use — useful for ring buffer
   * `ringStart` math without having to peek into a buffer.
   */
  peekNextSeq(): number {
    return this.nextSeq;
  }
}
