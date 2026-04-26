/**
 * SSE handler — wires `EnsembleEventBus` to the HTTP socket.
 *
 * **Responsibilities**:
 * - Frame `BusEvent` into SSE `id:` / `event:` / `data:` lines (§5).
 * - Decide the §7.2 connection-flow branch:
 *   - no `Last-Event-ID` → emit `snapshot` (per-ensemble only), then live tail
 *   - epoch mismatch → emit `gap` with `reason: 'epoch-mismatch'`, live tail
 *   - epoch match, `seq < ringStart` → emit `gap` with `reason: 'overflow'`, live tail
 *   - epoch match, `seq >= ringStart` → replay `[seq+1 … newest]`, live tail
 * - Per-connection 1 MiB write-buffer cap (§7.3) with destroy-on-overflow.
 * - Process-wide connection cap (`CLAUDE_TEMPO_SSE_MAX_CONNECTIONS`,
 *   default 100); over-cap → `503 Service Unavailable`, `Retry-After: 5`.
 * - Cancellation: socket close drops the subscription within one
 *   event-loop tick.
 */
import type { IncomingMessage, ServerResponse } from 'http';
import type { TempoClient } from '../client/interface';
import {
  buildEnsembleSnapshot,
  EnsembleNotFoundError,
} from './snapshot';
import { parseEventId, type EventIdTuple } from './event-id';
import {
  EnsembleEventBus,
  type BusEvent,
  type EventBus,
  type Subscription,
  type TopicCategory,
} from './event-bus';

/** Default per-process SSE connection cap. */
export const DEFAULT_MAX_CONNECTIONS = 100;
/** Per-connection write-buffer ceiling (§7.3). */
export const PER_CONNECTION_BUFFER_LIMIT = 1 * 1024 * 1024;

const log = (...args: unknown[]) =>
  console.error('[claude-tempo:sse]', ...args);

/** Counts open SSE connections. Exported for `/v1/health.subscriberCount`. */
export class ConnectionCap {
  private current = 0;
  constructor(public readonly limit: number = DEFAULT_MAX_CONNECTIONS) {}
  size(): number { return this.current; }
  /**
   * Try to take a slot. Returns `true` when the connection is
   * accepted; `false` when over the cap.
   */
  acquire(): boolean {
    if (this.current >= this.limit) return false;
    this.current++;
    return true;
  }
  release(): void {
    if (this.current > 0) this.current--;
  }
}

/**
 * SSE frame format (§5). Returns the byte buffer that goes on the wire.
 *
 * Multi-line payloads are split on `\n` so each becomes its own
 * `data:` line per the WHATWG spec — but in practice the daemon
 * always emits single-line JSON, so this branch is defensive.
 */
export function frameSseEvent(event: BusEvent): Buffer {
  const lines: string[] = [];
  lines.push(`id: ${event.eventId}`);
  lines.push(`event: ${event.type}`);
  const data = JSON.stringify({ v: 1, eventId: event.eventId, payload: event.payload });
  // Single-line JSON — but defend against line breaks in payloads.
  for (const piece of data.split('\n')) lines.push(`data: ${piece}`);
  return Buffer.from(lines.join('\n') + '\n\n', 'utf8');
}

/**
 * Frame a synthetic event-id-less prelude — `: <comment>\n\n`. Used for
 * the initial keepalive nudge some intermediaries need before the
 * first real event.
 */
export function frameSseComment(comment: string): Buffer {
  return Buffer.from(`: ${comment}\n\n`, 'utf8');
}

/** Parse `?topics=phase,chat,...` query string into a Set, or `undefined`. */
export function parseTopicQuery(raw: string | string[] | undefined): Set<TopicCategory> | undefined {
  if (!raw) return undefined;
  const value = Array.isArray(raw) ? raw[0] : raw;
  const known: ReadonlySet<TopicCategory> =
    new Set<TopicCategory>(['phase', 'chat', 'flags', 'schedules', 'heartbeat']);
  const out = new Set<TopicCategory>();
  for (const tok of value.split(',').map((s) => s.trim()).filter(Boolean)) {
    if (known.has(tok as TopicCategory)) out.add(tok as TopicCategory);
  }
  return out.size > 0 ? out : undefined;
}

/** Pull a single string from a possibly-array header. */
function headerString(v: string | string[] | undefined): string | undefined {
  if (Array.isArray(v)) return v[0];
  return v;
}

export interface HandleSseOptions {
  client: TempoClient;
  bus: EventBus;
  /**
   * `true` for `/v1/events/:ensemble` — emits `snapshot` on fresh
   * connect. `false` for `/v1/events` global stream which has no
   * snapshot semantics (§6 table).
   */
  emitSnapshot: boolean;
  /** Ensemble name when `emitSnapshot` is true; ignored otherwise. */
  ensemble?: string;
  /** Process-wide connection cap. */
  cap: ConnectionCap;
  /** Test seam for the per-connection write buffer ceiling. */
  bufferLimit?: number;
}

/**
 * Handle an SSE request. Long-lived — resolves only when the client
 * disconnects, the bus closes, or the per-connection buffer overflows.
 */
export async function handleSseRequest(
  req: IncomingMessage,
  res: ServerResponse,
  opts: HandleSseOptions,
): Promise<void> {
  // Connection cap.
  if (!opts.cap.acquire()) {
    res.writeHead(503, {
      'Content-Type': 'application/json; charset=utf-8',
      'Retry-After': '5',
    });
    res.end(JSON.stringify({ error: 'connection-cap-exceeded' }));
    return;
  }

  // Always release the cap on exit.
  let capReleased = false;
  const releaseCap = () => {
    if (!capReleased) {
      capReleased = true;
      opts.cap.release();
    }
  };

  // Open SSE response. Headers per §1 + §5.
  res.writeHead(200, {
    'Content-Type': 'text/event-stream; charset=utf-8',
    'Cache-Control': 'no-store',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no', // disable buffering on nginx + friends
  });
  res.flushHeaders?.();
  // Initial comment to nudge the connection through any intermediaries.
  res.write(frameSseComment('claude-tempo SSE'));

  // Determine §7.2 entry branch.
  const lastEventIdRaw = headerString(req.headers['last-event-id']);
  const requested = parseEventId(lastEventIdRaw);
  const url = new URL(req.url ?? '/', 'http://localhost');
  const topics = parseTopicQuery(url.searchParams.get('topics') ?? undefined);

  // Subscribe — afterSeq is determined by branch decisions below. The
  // bus's subscribe call replays `seq > afterSeq` events from the ring.
  let afterSeq: number | undefined;
  let preludeEvents: BusEvent[] = [];

  if (requested) {
    if (requested.epoch !== opts.bus.bootEpoch) {
      // Epoch mismatch → gap.
      preludeEvents.push(synthEvent(opts.bus, 'gap', {
        from: lastEventIdRaw ?? '',
        to: makeIdToken(opts.bus, opts.bus.nextSeq()),
        reason: 'epoch-mismatch',
      }));
      // Don't replay — client will re-fetch /v1/state and reconnect.
      afterSeq = undefined;
    } else {
      const ringStart = opts.bus.oldestSeq();
      if (ringStart === null || requested.seq + 1 < ringStart) {
        // Overflow → gap. `ringStart === null` happens when the bus
        // has emitted nothing yet — semantically "I have no events
        // to replay you" rather than the strict overflow case
        // (client predates the ring's oldest entry). The wire spec
        // §6 only defines two `gap` reasons (`epoch-mismatch` and
        // `overflow`), so we use `overflow` for both flavors. The
        // recovery path is identical: re-fetch `/v1/state` and
        // reconnect with the snapshot's `lastEventId`. PR #324
        // review nit — flagged for a possible §6 spec extension
        // (`reason: 'empty-ring'`) if a future PR-3 consumer can use
        // the distinction; for now collapsing keeps the wire stable.
        preludeEvents.push(synthEvent(opts.bus, 'gap', {
          from: lastEventIdRaw ?? '',
          to: makeIdToken(opts.bus, opts.bus.nextSeq()),
          reason: 'overflow',
        }));
        afterSeq = undefined;
      } else {
        // Replay range — bus.subscribe will pull from the ring.
        afterSeq = requested.seq;
      }
    }
  } else if (opts.emitSnapshot) {
    // No Last-Event-ID + per-ensemble stream → emit snapshot.
    if (!opts.ensemble) {
      res.end();
      releaseCap();
      throw new Error('handleSseRequest: ensemble required when emitSnapshot=true');
    }
    try {
      const snap = await buildEnsembleSnapshot(opts.client, opts.ensemble);
      preludeEvents.push(synthEvent(opts.bus, 'snapshot', snap));
    } catch (err) {
      if (err instanceof EnsembleNotFoundError) {
        // The route handler validates ensemble existence before calling
        // this, but the ensemble could go away between resolution and
        // snapshot fetch — return a 404-equivalent SSE close with a
        // helpful body comment.
        res.write(frameSseComment(`ensemble-not-found ${opts.ensemble}`));
        res.end();
        releaseCap();
        return;
      }
      log('snapshot fetch failed:', err instanceof Error ? err.message : err);
      // Non-fatal — let the bus do the live tail; consumer is no worse off.
    }
  }

  const sub = opts.bus.subscribe({ ...(afterSeq !== undefined ? { afterSeq } : {}), ...(topics ? { topics } : {}) });
  let closed = false;
  const close = () => {
    if (closed) return;
    closed = true;
    try { sub.close(); } catch { /* ignore */ }
    try { res.end(); } catch { /* ignore */ }
    releaseCap();
  };

  // Bind socket lifecycle. `req.on('close')` covers TCP drop + abort.
  req.on('close', close);
  res.on('close', close);

  // Stream loop.
  try {
    // Prelude (snapshot / gap) goes first.
    for (const ev of preludeEvents) {
      if (closed) return;
      if (!writeOrDrop(res, ev, opts.bufferLimit ?? PER_CONNECTION_BUFFER_LIMIT, close)) return;
    }
    for await (const ev of sub) {
      if (closed) return;
      if (!writeOrDrop(res, ev, opts.bufferLimit ?? PER_CONNECTION_BUFFER_LIMIT, close)) return;
    }
  } finally {
    close();
  }
}

/** Per-event write with §7.3 backpressure. Returns `false` when the connection was destroyed. */
function writeOrDrop(
  res: ServerResponse,
  event: BusEvent,
  bufferLimit: number,
  close: () => void,
): boolean {
  const payload = frameSseEvent(event);
  // Track per-socket buffered bytes via Node's `writableLength`.
  const socket = res.socket;
  if (socket && socket.writableLength + payload.length > bufferLimit) {
    log('connection write buffer exceeded — dropping subscriber');
    try { socket.destroy(); } catch { /* ignore */ }
    close();
    return false;
  }
  res.write(payload);
  return true;
}

/**
 * Build a synthetic `BusEvent` not allocated by the bus's `emit`
 * pipeline — used only for the connection prelude (snapshot / gap)
 * which is per-connection rather than per-bus. Allocates a sentinel
 * `eventId` based on the bus's current `nextSeq` minus one so the
 * client's local `Last-Event-ID` tracking stays internally
 * consistent without polluting the ring.
 *
 * NOTE: the eventId on a synthetic event is for client-side ordering
 * only — the daemon will never reuse this id from its allocator.
 * Per §7.2 the snapshot/gap re-bridge means the client always
 * follows up with a fresh `/v1/state/:ensemble` fetch on `gap` and
 * normalizes its Last-Event-ID against the snapshot's `lastEventId`.
 */
function synthEvent(
  bus: EventBus,
  type: 'snapshot' | 'gap',
  payload: unknown,
): BusEvent {
  // Pick an id strictly less than the bus's next allocation so it
  // sorts before any real event. Synthetic prelude events are an
  // implementation detail of the per-connection wire and are never
  // expected to be addressed via Last-Event-ID resume.
  const seq = Math.max(0, bus.nextSeq() - 1);
  const tuple: EventIdTuple = { epoch: bus.bootEpoch, seq };
  return {
    eventId: `${tuple.epoch}:${tuple.seq}`,
    tuple,
    type,
    payload,
    emittedAt: Date.now(),
    bufferable: false,
  };
}

function makeIdToken(bus: EventBus, seq: number): string {
  return `${bus.bootEpoch}:${seq}`;
}

/** Type guard re-export to satisfy TS without circular refs. */
export type { EnsembleEventBus, Subscription };
