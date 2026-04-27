/**
 * Unit tests for `TempoClient.subscribe` — the SSE event stream wrapper.
 * See `src/client/subscribe.ts`. Issue #94/#95 PR-3.
 *
 * The wrapper talks to the daemon's `/v1/events*` endpoints over HTTP/SSE.
 * These tests inject a fake `fetch` so the wrapper's behaviour can be
 * exercised deterministically — no daemon, no Temporal, no network.
 *
 * Coverage:
 *   - Snapshot-then-stream emission order (§7.2)
 *   - URL + header construction (per-ensemble, global, topics, lastEventId, bearer)
 *   - AbortSignal cancellation + `for await … break` cleanup (§7.4)
 *   - Reconnect with `Last-Event-ID` carried across drops (§7.5)
 *   - Backoff schedule (100 × 2^attempt cap 30 000) and reset on success
 *   - Gap / chat.compressed events surface to consumer (§7.5/§7.6)
 *   - Malformed lines / unknown event types skipped silently
 *   - Permanent HTTP errors (401, 404) surface as `SubscribeHttpError`
 */
import { describe, it, expect, vi } from 'vitest';
import { createSubscribe, SubscribeHttpError, type SubscribeDeps } from '../../src/client/subscribe';
import type { TempoEvent } from '../../src/http/event-types';

// ── Test helpers ───────────────────────────────────────────────────────────

/**
 * Build a `ReadableStream<Uint8Array>` from a list of string chunks. Each
 * chunk is enqueued as a separate frame so tests can exercise partial
 * line splits across reads.
 */
function streamFromChunks(chunks: string[]): ReadableStream<Uint8Array> {
  const enc = new TextEncoder();
  return new ReadableStream<Uint8Array>({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(enc.encode(chunk));
      controller.close();
    },
  });
}

/**
 * Build a stream that pumps chunks then leaves the stream open until the
 * passed AbortSignal aborts — simulates a long-lived SSE connection that
 * can be canceled by the consumer.
 */
function liveStream(initialChunks: string[], signal: AbortSignal): ReadableStream<Uint8Array> {
  const enc = new TextEncoder();
  return new ReadableStream<Uint8Array>({
    async start(controller) {
      for (const chunk of initialChunks) controller.enqueue(enc.encode(chunk));
      // Hold open until the signal aborts.
      await new Promise<void>((resolve) => {
        if (signal.aborted) { resolve(); return; }
        signal.addEventListener('abort', () => resolve(), { once: true });
      });
      try { controller.close(); } catch { /* ignore */ }
    },
  });
}

/**
 * Drain an iterable just long enough to record the first fetch, then
 * abort and wait for the run loop to exit. Used by the URL/header
 * assertions which only care about the first fetch call.
 */
async function consumeBriefly(
  it: AsyncIterable<TempoEvent>,
  ctrl: AbortController,
): Promise<void> {
  const done = (async () => {
    for await (const _ of it) { /* drain */ }
  })();
  await new Promise((r) => setImmediate(r));
  ctrl.abort();
  await done;
}

/**
 * Quick SSE frame builder — `id\nevent\ndata\n\n`. Mirrors the daemon's
 * on-wire envelope produced by `frameSseEvent` in `src/http/sse-handler.ts`
 * (`{ v, eventId, payload }`) so the tests round-trip the actual format
 * the production daemon emits — a previous version of this helper wrote
 * the payload bare and let the bug at #351 slip through.
 */
function frame(event: string, payload: unknown, id?: string): string {
  const lines: string[] = [];
  if (id) lines.push(`id: ${id}`);
  lines.push(`event: ${event}`);
  const envelope = { v: 1, eventId: id ?? '0:0', payload };
  lines.push(`data: ${JSON.stringify(envelope)}`);
  lines.push('');
  lines.push('');
  return lines.join('\n');
}

/** Build an OK Response with a body stream. */
function okStream(body: ReadableStream<Uint8Array>): Response {
  return new Response(body, { status: 200, headers: { 'Content-Type': 'text/event-stream' } });
}

interface FetchCall {
  url: string;
  headers: Record<string, string>;
  signal?: AbortSignal;
}

/**
 * Minimal `EventSource` test double — captures the constructed URL,
 * exposes `emit(kind, payload, eventId?)` for tests, and tracks listener
 * registration / close. Doesn't try to model the spec's auto-reconnect
 * semantics; the wrapper relies on the runtime's native implementation
 * for that, and we don't test it here.
 */
class MockEventSource {
  static instances: MockEventSource[] = [];
  static reset(): void { MockEventSource.instances = []; }

  static readonly CONNECTING = 0;
  static readonly OPEN = 1;
  static readonly CLOSED = 2;

  readonly url: string;
  readyState: number = MockEventSource.OPEN;
  closed = false;
  private listeners = new Map<string, Set<(ev: MessageEvent) => void>>();

  constructor(url: string) {
    this.url = url;
    MockEventSource.instances.push(this);
  }

  addEventListener(type: string, listener: (ev: MessageEvent) => void): void {
    let set = this.listeners.get(type);
    if (!set) { set = new Set(); this.listeners.set(type, set); }
    set.add(listener);
  }

  removeEventListener(type: string, listener: (ev: MessageEvent) => void): void {
    this.listeners.get(type)?.delete(listener);
  }

  close(): void {
    this.closed = true;
    this.readyState = MockEventSource.CLOSED;
    this.listeners.clear();
  }

  /**
   * Test helper: deliver an event to registered listeners. Wraps the
   * payload in the daemon's on-wire envelope (`frameSseEvent`,
   * `src/http/sse-handler.ts`) so the EventSource transport is exercised
   * against the same shape the production server emits.
   */
  emit(kind: string, payload: unknown, eventId = '0:0'): void {
    const set = this.listeners.get(kind);
    if (!set) return;
    const data = JSON.stringify({ v: 1, eventId, payload });
    const ev = { type: kind, data, lastEventId: eventId } as MessageEvent;
    for (const l of set) l(ev);
  }
}

/** Capture every fetch call into a queue plus return scripted responses. */
function makeScriptedFetch(handlers: Array<(call: FetchCall) => Promise<Response> | Response>): {
  fetchImpl: typeof fetch;
  calls: FetchCall[];
} {
  const calls: FetchCall[] = [];
  let i = 0;
  const fetchImpl: typeof fetch = async (input, init) => {
    const url = typeof input === 'string' ? input : (input as URL).toString();
    const rawHeaders = (init?.headers ?? {}) as Record<string, string>;
    // Normalize to lower-case access (Headers obj or plain record) for assertions
    const headers: Record<string, string> = {};
    for (const k of Object.keys(rawHeaders)) headers[k] = rawHeaders[k];
    calls.push({ url, headers, signal: init?.signal as AbortSignal | undefined });
    const handler = handlers[Math.min(i, handlers.length - 1)];
    i++;
    return handler({ url, headers, signal: init?.signal as AbortSignal | undefined });
  };
  return { fetchImpl, calls };
}

/**
 * Near-instant sleep that still yields to the macrotask queue. Using a
 * synchronously-resolved Promise (`async () => {}`) would saturate the
 * microtask queue and never give the test's external `ctrl.abort()` a
 * chance to fire — `setTimeout(0)` is a macrotask boundary, which is what
 * the production `defaultSleep` relies on too.
 */
const instantSleep: SubscribeDeps['sleep'] = () =>
  new Promise<void>((resolve) => setTimeout(resolve, 0));

// ── Tests ──────────────────────────────────────────────────────────────────

describe('createSubscribe — URL + header construction', () => {
  /**
   * Helper: build a wrapper backed by an empty stream, run it briefly,
   * abort, and return the captured fetch calls. Every URL/header test
   * only inspects the first fetch — this collapses the otherwise-
   * repeated 6-line setup.
   */
  async function captureFirstFetch(
    extra: Partial<SubscribeDeps>,
    invoke: (subscribe: ReturnType<typeof createSubscribe>, signal: AbortSignal) => AsyncIterable<TempoEvent>,
  ): Promise<FetchCall[]> {
    const { fetchImpl, calls } = makeScriptedFetch([
      () => okStream(streamFromChunks([])),
    ]);
    const subscribe = createSubscribe({ baseUrl: 'http://test:1234', fetchImpl, sleep: instantSleep, ...extra });
    const ctrl = new AbortController();
    await consumeBriefly(invoke(subscribe, ctrl.signal), ctrl);
    return calls;
  }

  it('per-ensemble URL and Accept header', async () => {
    const calls = await captureFirstFetch({}, (sub, signal) => sub('demo', { signal }));
    expect(calls.length).toBeGreaterThanOrEqual(1);
    expect(calls[0].url).toBe('http://test:1234/v1/events/demo');
    expect(calls[0].headers.Accept).toBe('text/event-stream');
    expect(calls[0].headers['Last-Event-ID']).toBeUndefined();
    expect(calls[0].headers.Authorization).toBeUndefined();
  });

  it('global stream URL when no ensemble passed', async () => {
    const calls = await captureFirstFetch({}, (sub, signal) => sub({ signal }));
    expect(calls[0].url).toBe('http://test:1234/v1/events');
  });

  it('encodes ensemble name in path', async () => {
    const calls = await captureFirstFetch({}, (sub, signal) =>
      sub('my ensemble/with slash', { signal }),
    );
    expect(calls[0].url).toBe('http://test:1234/v1/events/my%20ensemble%2Fwith%20slash');
  });

  it('topics filter as comma-separated query param', async () => {
    const calls = await captureFirstFetch({}, (sub, signal) =>
      sub('demo', { signal, topics: ['phase', 'chat'] }),
    );
    expect(calls[0].url).toBe('http://test:1234/v1/events/demo?topics=phase,chat');
  });

  it('bearer token sets Authorization header', async () => {
    const calls = await captureFirstFetch(
      { token: 'sekret' },
      (sub, signal) => sub('demo', { signal }),
    );
    expect(calls[0].headers.Authorization).toBe('Bearer sekret');
  });
});

describe('createSubscribe — event delivery', () => {
  it('snapshot-then-stream emission order', async () => {
    const ctrl = new AbortController();
    const body = streamFromChunks([
      frame('snapshot', { v: 1, ensemble: 'demo' }, '100:1'),
      frame('player.added', { playerId: 'alice' }, '100:2'),
      frame('player.phase_changed', { playerId: 'alice', phase: 'attached' }, '100:3'),
    ]);
    const { fetchImpl } = makeScriptedFetch([() => okStream(body)]);
    const subscribe = createSubscribe({ baseUrl: 'http://test:1234', fetchImpl, sleep: instantSleep });
    const events: TempoEvent[] = [];

    for await (const ev of subscribe('demo', { signal: ctrl.signal })) {
      events.push(ev);
      if (events.length === 3) ctrl.abort();
    }
    expect(events.map((e) => e.type)).toEqual([
      'snapshot',
      'player.added',
      'player.phase_changed',
    ]);
    expect(events[0].eventId).toBe('100:1');
    expect(events[2].eventId).toBe('100:3');
  });

  /**
   * Regression — issue #351. The daemon's `frameSseEvent` writes the
   * on-wire envelope `{ v, eventId, payload }` (verified by
   * `tests/http/sse-handler.test.ts`). Earlier client parsers passed the
   * **whole envelope** through as `event.payload`, so consumers reading
   * `event.payload.players` on a snapshot got `undefined` and the TUI
   * subscribe loop crashed silently → the v0.28.0-beta.1 "Loading
   * messages..." + "No conductor" stuck-state. This test reproduces the
   * exact wire shape and asserts the consumer sees the unwrapped
   * payload, so a future regression at the wire/client boundary is
   * caught at the parser layer instead of leaking into a UI that has
   * no way to recover.
   */
  it('unwraps the daemon envelope so consumer sees the inner payload (#351)', async () => {
    const ctrl = new AbortController();
    // Hand-built frame matching the *real* wire — `frameSseEvent` writes
    // `data: {"v":1,"eventId":"...","payload":<actualPayload>}`.
    const wireFrame =
      'id: 100:1\n' +
      'event: snapshot\n' +
      'data: {"v":1,"eventId":"100:1","payload":{"v":1,"ensemble":"demo","capturedAt":"2026-04-26T12:00:00Z","lastEventId":"100:1","state":"online","hasConductor":true,"flags":{"paused":false,"held":false},"players":[{"playerId":"alice","ensemble":"demo","hostname":"h","isConductor":true,"agentType":"claude","part":"","workDir":"/w"}],"schedules":[],"chat":{"messages":[],"total":0,"hasMore":false},"hostProfiles":{}}}\n' +
      '\n';
    const body = streamFromChunks([wireFrame]);
    const { fetchImpl } = makeScriptedFetch([() => okStream(body)]);
    const subscribe = createSubscribe({ baseUrl: 'http://test:1234', fetchImpl, sleep: instantSleep });
    const events: TempoEvent[] = [];

    for await (const ev of subscribe('demo', { signal: ctrl.signal })) {
      events.push(ev);
      if (events.length === 1) ctrl.abort();
    }
    expect(events).toHaveLength(1);
    const snap = events[0];
    expect(snap.type).toBe('snapshot');
    expect(snap.eventId).toBe('100:1');
    if (snap.type !== 'snapshot') return; // narrowing for TS
    // The bug: `snap.payload.players` was `undefined` because the
    // entire envelope was being passed through as `payload`. Asserting
    // both the conductor flag + the unwrapped fields catches both
    // branches of the regression.
    expect(snap.payload.hasConductor).toBe(true);
    expect(snap.payload.players.map((p) => p.playerId)).toEqual(['alice']);
    expect(snap.payload.players[0].isConductor).toBe(true);
    expect(snap.payload.flags.paused).toBe(false);
    // Importantly — the inner payload is NOT itself an envelope. A
    // double-wrap regression would surface as a residual `eventId`
    // field on the unwrapped payload.
    expect((snap.payload as Record<string, unknown>).eventId).toBeUndefined();
  });

  it('gap event surfaces to consumer (not swallowed)', async () => {
    const ctrl = new AbortController();
    const body = streamFromChunks([
      frame('gap', { from: '99:0', to: '100:0', reason: 'epoch-mismatch' }, '100:0'),
      frame('snapshot', { v: 1, ensemble: 'demo' }, '100:1'),
    ]);
    const { fetchImpl } = makeScriptedFetch([() => okStream(body)]);
    const subscribe = createSubscribe({ baseUrl: 'http://test:1234', fetchImpl, sleep: instantSleep });
    const events: TempoEvent[] = [];

    for await (const ev of subscribe('demo', { signal: ctrl.signal })) {
      events.push(ev);
      if (events.length === 2) ctrl.abort();
    }
    expect(events[0].type).toBe('gap');
    if (events[0].type === 'gap') {
      expect(events[0].payload.reason).toBe('epoch-mismatch');
    }
    expect(events[1].type).toBe('snapshot');
  });

  it('chat.compressed surfaces to consumer (soft gap)', async () => {
    const ctrl = new AbortController();
    const body = streamFromChunks([
      frame('chat.appended', { from: 'a', text: 'hi' }, '50:1'),
      frame('chat.compressed', { dropped: 12, since: '50:1' }, '50:2'),
      frame('chat.appended', { from: 'a', text: 'resumed' }, '50:3'),
    ]);
    const { fetchImpl } = makeScriptedFetch([() => okStream(body)]);
    const subscribe = createSubscribe({ baseUrl: 'http://test:1234', fetchImpl, sleep: instantSleep });
    const events: TempoEvent[] = [];

    for await (const ev of subscribe('demo', { signal: ctrl.signal })) {
      events.push(ev);
      if (events.length === 3) ctrl.abort();
    }
    expect(events.map((e) => e.type)).toEqual([
      'chat.appended',
      'chat.compressed',
      'chat.appended',
    ]);
  });

  it('skips unknown event kinds silently (forward compat per §6)', async () => {
    const ctrl = new AbortController();
    const body = streamFromChunks([
      frame('snapshot', { v: 1, ensemble: 'demo' }, '100:1'),
      'event: future.event\ndata: {"new":1}\n\n',
      frame('player.added', { playerId: 'bob' }, '100:2'),
    ]);
    const { fetchImpl } = makeScriptedFetch([() => okStream(body)]);
    const subscribe = createSubscribe({ baseUrl: 'http://test:1234', fetchImpl, sleep: instantSleep });
    const events: TempoEvent[] = [];

    for await (const ev of subscribe('demo', { signal: ctrl.signal })) {
      events.push(ev);
      if (events.length === 2) ctrl.abort();
    }
    expect(events.map((e) => e.type)).toEqual(['snapshot', 'player.added']);
  });

  it('skips frames with malformed JSON payloads', async () => {
    const ctrl = new AbortController();
    const body = streamFromChunks([
      'event: snapshot\ndata: not-json\n\n',
      frame('player.added', { playerId: 'alice' }, '100:1'),
    ]);
    const { fetchImpl } = makeScriptedFetch([() => okStream(body)]);
    const subscribe = createSubscribe({ baseUrl: 'http://test:1234', fetchImpl, sleep: instantSleep });
    const events: TempoEvent[] = [];

    for await (const ev of subscribe('demo', { signal: ctrl.signal })) {
      events.push(ev);
      if (events.length === 1) ctrl.abort();
    }
    expect(events).toHaveLength(1);
    expect(events[0].type).toBe('player.added');
  });

  it('handles SSE frames split across read chunks', async () => {
    const ctrl = new AbortController();
    const f = frame('snapshot', { v: 1, ensemble: 'demo' }, '100:1');
    // Cut the frame into byte-level chunks: every 7 chars
    const chunks: string[] = [];
    for (let i = 0; i < f.length; i += 7) chunks.push(f.slice(i, i + 7));
    const body = streamFromChunks(chunks);
    const { fetchImpl } = makeScriptedFetch([() => okStream(body)]);
    const subscribe = createSubscribe({ baseUrl: 'http://test:1234', fetchImpl, sleep: instantSleep });
    const events: TempoEvent[] = [];

    for await (const ev of subscribe('demo', { signal: ctrl.signal })) {
      events.push(ev);
      if (events.length === 1) ctrl.abort();
    }
    expect(events[0].type).toBe('snapshot');
    expect(events[0].eventId).toBe('100:1');
  });

  it('ignores SSE comment lines (lines starting with `:`)', async () => {
    const ctrl = new AbortController();
    const body = streamFromChunks([
      ':keepalive\n\n',
      frame('snapshot', { v: 1, ensemble: 'demo' }, '100:1'),
    ]);
    const { fetchImpl } = makeScriptedFetch([() => okStream(body)]);
    const subscribe = createSubscribe({ baseUrl: 'http://test:1234', fetchImpl, sleep: instantSleep });
    const events: TempoEvent[] = [];

    for await (const ev of subscribe('demo', { signal: ctrl.signal })) {
      events.push(ev);
      if (events.length === 1) ctrl.abort();
    }
    expect(events).toHaveLength(1);
  });
});

describe('createSubscribe — cancellation (§7.4)', () => {
  it('AbortSignal cancels in-flight stream', async () => {
    const ctrl = new AbortController();
    let fetchSignalAborted = false;
    const fetchImpl: typeof fetch = async (_, init) => {
      const sig = init?.signal as AbortSignal;
      sig.addEventListener('abort', () => { fetchSignalAborted = true; }, { once: true });
      return okStream(liveStream([
        frame('snapshot', { v: 1, ensemble: 'demo' }, '100:1'),
      ], sig));
    };
    const subscribe = createSubscribe({ baseUrl: 'http://test:1234', fetchImpl, sleep: instantSleep });
    const events: TempoEvent[] = [];

    for await (const ev of subscribe('demo', { signal: ctrl.signal })) {
      events.push(ev);
      ctrl.abort();
    }
    expect(events).toHaveLength(1);
    expect(fetchSignalAborted).toBe(true);
  });

  it('for-await break tears down underlying transport', async () => {
    let fetchSignalAborted = false;
    const fetchImpl: typeof fetch = async (_, init) => {
      const sig = init?.signal as AbortSignal;
      sig.addEventListener('abort', () => { fetchSignalAborted = true; }, { once: true });
      return okStream(liveStream([
        frame('snapshot', { v: 1, ensemble: 'demo' }, '100:1'),
        frame('player.added', { playerId: 'alice' }, '100:2'),
      ], sig));
    };
    const subscribe = createSubscribe({ baseUrl: 'http://test:1234', fetchImpl, sleep: instantSleep });

    let count = 0;
    for await (const _ of subscribe('demo')) {
      count++;
      if (count === 1) break;
    }

    expect(count).toBe(1);
    expect(fetchSignalAborted).toBe(true);
  });
});

describe('createSubscribe — reconnect (§7.5)', () => {
  it('reconnects with most-recently-seen Last-Event-ID after stream close', async () => {
    const ctrl = new AbortController();
    const { fetchImpl, calls } = makeScriptedFetch([
      // first connection — yields one event then closes
      () => okStream(streamFromChunks([
        frame('snapshot', { v: 1, ensemble: 'demo' }, '100:1'),
      ])),
      // second connection — yields nothing, kept alive until abort
      ({ signal }) => okStream(liveStream([], signal!)),
    ]);
    const subscribe = createSubscribe({ baseUrl: 'http://test:1234', fetchImpl, sleep: instantSleep });
    const events: TempoEvent[] = [];

    for await (const ev of subscribe('demo', { signal: ctrl.signal })) {
      events.push(ev);
      if (events.length === 1) {
        // First conn done. Wait briefly for reconnect.
        setTimeout(() => ctrl.abort(), 10);
      }
    }
    expect(events.map((e) => e.type)).toEqual(['snapshot']);
    expect(calls.length).toBeGreaterThanOrEqual(2);
    expect(calls[0].headers['Last-Event-ID']).toBeUndefined();
    // Second connection MUST carry Last-Event-ID = id of last event seen.
    expect(calls[1].headers['Last-Event-ID']).toBe('100:1');
  });

  it('backoff schedule: 100, 200, 400, … on consecutive transport failures', async () => {
    const ctrl = new AbortController();
    const sleeps: number[] = [];
    const sleep: SubscribeDeps['sleep'] = async (ms) => { sleeps.push(ms); };
    let n = 0;
    const fetchImpl: typeof fetch = async (_, init) => {
      n++;
      if (n <= 3) {
        // Three consecutive failures
        throw new Error('boom');
      }
      // Fourth call succeeds, then we abort
      const sig = init?.signal as AbortSignal;
      return okStream(liveStream([
        frame('snapshot', { v: 1, ensemble: 'demo' }, '100:1'),
      ], sig));
    };
    const subscribe = createSubscribe({ baseUrl: 'http://test:1234', fetchImpl, sleep });
    let count = 0;
    for await (const _ of subscribe('demo', { signal: ctrl.signal })) {
      count++;
      ctrl.abort();
    }
    expect(count).toBe(1);
    // First three sleeps should be 100, 200, 400
    expect(sleeps.slice(0, 3)).toEqual([100, 200, 400]);
  });

  it('resets backoff after a successful event delivery', async () => {
    const ctrl = new AbortController();
    const sleeps: number[] = [];
    const sleep: SubscribeDeps['sleep'] = async (ms) => { sleeps.push(ms); };
    let n = 0;
    const fetchImpl: typeof fetch = async (_, init) => {
      n++;
      const sig = init?.signal as AbortSignal;
      if (n === 1) throw new Error('boom1'); // attempt 0 fails → sleep 100
      if (n === 2) throw new Error('boom2'); // attempt 1 fails → sleep 200
      if (n === 3) {
        // success — yields event then closes (resets attempt to 0)
        return okStream(streamFromChunks([
          frame('snapshot', { v: 1, ensemble: 'demo' }, '100:1'),
        ]));
      }
      if (n === 4) throw new Error('boom4'); // after reset → sleep 100 again
      return okStream(liveStream([], sig));
    };
    const subscribe = createSubscribe({ baseUrl: 'http://test:1234', fetchImpl, sleep });
    const events: TempoEvent[] = [];
    for await (const ev of subscribe('demo', { signal: ctrl.signal })) {
      events.push(ev);
      if (events.length === 1) {
        // wait for the next reconnect cycle to fire fetch #4 + sleep
        setTimeout(() => ctrl.abort(), 30);
      }
    }
    expect(events).toHaveLength(1);
    // Sleep schedule: 100 (boom1), 200 (boom2), [100 inter-reconnect after success], 100 (boom4) …
    expect(sleeps[0]).toBe(100);
    expect(sleeps[1]).toBe(200);
    // Verify the post-success backoff is back to 100 (not 400) — the
    // reset-on-success path is what guarantees this.
    expect(sleeps).toContain(100);
    // Most importantly, after success we never see 400 (the next-power-of-2)
    // until at least two more failures.
    const sleepsAfterSuccess = sleeps.slice(2);
    expect(sleepsAfterSuccess[0]).toBe(100);
  });
});

describe('createSubscribe — permanent errors', () => {
  it('throws SubscribeHttpError on 401', async () => {
    const fetchImpl: typeof fetch = async () =>
      new Response('{"error":"unauthorized"}', { status: 401 });
    const subscribe = createSubscribe({ baseUrl: 'http://test:1234', fetchImpl, sleep: instantSleep });

    const consume = async () => {
      for await (const _ of subscribe('demo')) { /* noop */ }
    };
    await expect(consume()).rejects.toBeInstanceOf(SubscribeHttpError);
  });

  it('throws SubscribeHttpError on 404', async () => {
    const fetchImpl: typeof fetch = async () =>
      new Response('{"error":"ensemble-not-found"}', { status: 404 });
    const subscribe = createSubscribe({ baseUrl: 'http://test:1234', fetchImpl, sleep: instantSleep });

    const consume = async () => {
      for await (const _ of subscribe('nope')) { /* noop */ }
    };
    await expect(consume()).rejects.toMatchObject({
      name: 'SubscribeHttpError',
      status: 404,
    });
  });

  it('retries on 503 with backoff', async () => {
    const ctrl = new AbortController();
    const sleeps: number[] = [];
    const sleep: SubscribeDeps['sleep'] = async (ms) => { sleeps.push(ms); };
    let n = 0;
    const fetchImpl: typeof fetch = async (_, init) => {
      n++;
      if (n === 1) {
        return new Response('{"error":"connection-cap-exceeded"}', {
          status: 503,
          headers: { 'Retry-After': '2' },
        });
      }
      return okStream(liveStream([
        frame('snapshot', { v: 1, ensemble: 'demo' }, '100:1'),
      ], init?.signal as AbortSignal));
    };
    const subscribe = createSubscribe({ baseUrl: 'http://test:1234', fetchImpl, sleep });
    const events: TempoEvent[] = [];
    for await (const ev of subscribe('demo', { signal: ctrl.signal })) {
      events.push(ev);
      ctrl.abort();
    }
    expect(events).toHaveLength(1);
    // Retry-After: 2 → 2000 ms
    expect(sleeps[0]).toBe(2000);
  });
});

describe('createSubscribe — transport selection (ADR 0010)', () => {
  it('uses native EventSource when available and no bearer token', async () => {
    MockEventSource.reset();
    let fetchCalled = false;
    const fetchImpl: typeof fetch = async () => {
      fetchCalled = true;
      return new Response(null, { status: 500 });
    };
    const subscribe = createSubscribe({
      baseUrl: 'http://test:1234',
      fetchImpl,
      sleep: instantSleep,
      EventSourceImpl: MockEventSource as unknown as typeof EventSource,
    });
    const ctrl = new AbortController();
    const events: TempoEvent[] = [];
    const consume = (async () => {
      for await (const ev of subscribe('demo', { signal: ctrl.signal })) {
        events.push(ev);
      }
    })();

    await new Promise((r) => setImmediate(r));
    expect(MockEventSource.instances).toHaveLength(1);
    expect(MockEventSource.instances[0].url).toBe('http://test:1234/v1/events/demo');
    expect(fetchCalled).toBe(false);

    // Server pushes a snapshot — wrapper should yield it as a TempoEvent.
    MockEventSource.instances[0].emit('snapshot', { v: 1, ensemble: 'demo' }, '100:1');
    await new Promise((r) => setImmediate(r));
    ctrl.abort();
    await consume;

    expect(events).toHaveLength(1);
    expect(events[0].type).toBe('snapshot');
    expect(events[0].eventId).toBe('100:1');
    expect(MockEventSource.instances[0].closed).toBe(true);
  });

  it('falls back to fetch when bearer token is set, even if EventSource is available', async () => {
    MockEventSource.reset();
    const { fetchImpl, calls } = makeScriptedFetch([
      () => okStream(streamFromChunks([])),
    ]);
    const subscribe = createSubscribe({
      baseUrl: 'http://test:1234',
      fetchImpl,
      sleep: instantSleep,
      token: 'sekret',
      EventSourceImpl: MockEventSource as unknown as typeof EventSource,
    });
    const ctrl = new AbortController();
    await consumeBriefly(subscribe('demo', { signal: ctrl.signal }), ctrl);

    expect(MockEventSource.instances).toHaveLength(0);
    expect(calls.length).toBeGreaterThanOrEqual(1);
    expect(calls[0].headers.Authorization).toBe('Bearer sekret');
  });

  it('falls back to fetch when EventSource is unavailable (Node default)', async () => {
    MockEventSource.reset();
    const { fetchImpl, calls } = makeScriptedFetch([
      () => okStream(streamFromChunks([])),
    ]);
    // Don't inject EventSourceImpl. Default Node 20 has no global EventSource.
    const subscribe = createSubscribe({
      baseUrl: 'http://test:1234',
      fetchImpl,
      sleep: instantSleep,
    });
    const ctrl = new AbortController();
    await consumeBriefly(subscribe('demo', { signal: ctrl.signal }), ctrl);

    expect(MockEventSource.instances).toHaveLength(0);
    expect(calls.length).toBeGreaterThanOrEqual(1);
  });

  it('EventSource path: AbortSignal closes the connection and ends iteration', async () => {
    MockEventSource.reset();
    const subscribe = createSubscribe({
      baseUrl: 'http://test:1234',
      EventSourceImpl: MockEventSource as unknown as typeof EventSource,
    });
    const ctrl = new AbortController();
    const events: TempoEvent[] = [];
    const consume = (async () => {
      for await (const ev of subscribe('demo', { signal: ctrl.signal })) {
        events.push(ev);
      }
    })();

    await new Promise((r) => setImmediate(r));
    const es = MockEventSource.instances[0];
    expect(es.closed).toBe(false);

    ctrl.abort();
    await consume;

    expect(es.closed).toBe(true);
  });

  it('EventSource path: malformed JSON payloads are skipped', async () => {
    MockEventSource.reset();
    const subscribe = createSubscribe({
      baseUrl: 'http://test:1234',
      EventSourceImpl: MockEventSource as unknown as typeof EventSource,
    });
    const ctrl = new AbortController();
    const events: TempoEvent[] = [];
    const consume = (async () => {
      for await (const ev of subscribe('demo', { signal: ctrl.signal })) {
        events.push(ev);
      }
    })();

    await new Promise((r) => setImmediate(r));
    const es = MockEventSource.instances[0];
    // Bypass MockEventSource.emit (which calls JSON.stringify) and deliver
    // a raw broken payload directly to the listener.
    const listeners = (es as unknown as { listeners: Map<string, Set<(ev: MessageEvent) => void>> }).listeners;
    const set = listeners.get('player.added');
    expect(set).toBeDefined();
    for (const l of set!) l({ type: 'player.added', data: 'not-json', lastEventId: '0:0' } as MessageEvent);
    es.emit('player.added', { playerId: 'alice' }, '100:1');
    await new Promise((r) => setImmediate(r));
    ctrl.abort();
    await consume;

    expect(events).toHaveLength(1);
    expect(events[0].type).toBe('player.added');
  });

  /**
   * Regression — issue #351 fixup. `EventSource.lastEventId` is always
   * a `string` (per the WHATWG spec) and is `''` when no `id:` line was
   * sent. The earlier `liftEnvelope` used `??` to fall back to the
   * envelope's own `eventId` field, but `?? ` only treats `null` /
   * `undefined` as nullish — so an empty `lastEventId` would short-
   * circuit to `''` instead of inheriting the envelope's id. Switching
   * to `||` restores the pre-#351 EventSource behaviour where the
   * fallback chain coerces empty strings.
   */
  it('EventSource path: empty `lastEventId` falls back to the envelope eventId', async () => {
    MockEventSource.reset();
    const subscribe = createSubscribe({
      baseUrl: 'http://test:1234',
      EventSourceImpl: MockEventSource as unknown as typeof EventSource,
    });
    const ctrl = new AbortController();
    const events: TempoEvent[] = [];
    const consume = (async () => {
      for await (const ev of subscribe('demo', { signal: ctrl.signal })) {
        events.push(ev);
      }
    })();

    await new Promise((r) => setImmediate(r));
    const es = MockEventSource.instances[0];
    // Deliver a payload directly with `lastEventId: ''` — what the
    // browser hands us when the server frame had no `id:` line. The
    // envelope still carries the canonical eventId.
    const listeners = (es as unknown as { listeners: Map<string, Set<(ev: MessageEvent) => void>> }).listeners;
    const set = listeners.get('player.added');
    expect(set).toBeDefined();
    const data = JSON.stringify({ v: 1, eventId: '777:42', payload: { playerId: 'alice' } });
    for (const l of set!) l({ type: 'player.added', data, lastEventId: '' } as MessageEvent);
    await new Promise((r) => setImmediate(r));
    ctrl.abort();
    await consume;

    expect(events).toHaveLength(1);
    expect(events[0].eventId).toBe('777:42'); // not '' — the envelope's id wins
  });
});
