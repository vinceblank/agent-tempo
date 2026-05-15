/**
 * `TempoClient.subscribe` — AsyncIterable wrapper over the daemon's
 * `/v1/events*` SSE endpoints. PR-3 of #94/#95.
 *
 * **Reference**: [`docs/SSE-PROTOCOL.md`](../../docs/SSE-PROTOCOL.md),
 * [`docs/adr/0010-drop-caller-controllable-event-cursor.md`](../../docs/adr/0010-drop-caller-controllable-event-cursor.md),
 * and the wire types in [`src/http/event-types.ts`](../http/event-types.ts).
 *
 * ## Design
 *
 * - **Dual transport** — the wrapper picks the best transport for the
 *   environment + auth context:
 *   - **Native `EventSource`** when available AND no bearer token is set
 *     (loopback browser dashboard). Native auto-reconnect handles
 *     `Last-Event-ID` for free.
 *   - **`fetch().body`** otherwise (Node 20+, or any path that needs the
 *     `Authorization` header). Manual reconnect + backoff + `Last-Event-ID`
 *     tracking implemented here.
 *
 *   Native `EventSource` cannot set custom request headers on initial
 *   connect, so any path that requires `Authorization: Bearer …` must use
 *   fetch. The transport choice is hidden from the consumer — the
 *   `AsyncIterable<TempoEvent>` shape is identical on both paths.
 *
 * - **Caller-controllable cursor resume is not supported (ADR 0010).**
 *   `SubscribeOptions` exposes `signal` and `topics` only. Snapshot-then-
 *   stream (server emits `event: snapshot` on fresh connect; SSE-PROTOCOL.md
 *   §7.2) covers every realistic case. In-session reconnects use
 *   `Last-Event-ID` under the hood — auto-managed by `EventSource`,
 *   tracked manually by the fetch wrapper.
 *
 * - **Transparent reconnect on the fetch path (§7.5).** TCP drops,
 *   premature stream ends, and 5xx responses are retried with exponential
 *   backoff (`100 ms × 2^attempt`, cap 30 s, reset on first event of a
 *   new connection). The most-recently-seen event id is replayed on each
 *   retry so consumers see seamless replay/`gap` behaviour. Native
 *   `EventSource` does the equivalent automatically.
 *
 * - **Gap events surface to consumer (§7.5/§7.6).** The wrapper does NOT
 *   re-fetch `/v1/state/:ensemble` on `gap` or `chat.compressed`; those
 *   are application-level concerns that the consumer (TUI / web dashboard)
 *   handles. The wrapper just relays events faithfully.
 *
 * - **Cancellation contract (§7.4).** Two paths:
 *   - `subscribe(..., { signal })` — when the external `AbortSignal`
 *     aborts, the wrapper closes the underlying transport and ends the
 *     iterator.
 *   - `for await … break` — the JavaScript runtime invokes the iterator's
 *     `return()` method, which in turn calls `controller.abort('iterator.return')`
 *     and tears down the transport. Without this, an idle SSE stream would
 *     leak the underlying socket.
 */

import { readPortFile } from '../http/port-file';
import {
  SSE_EVENT_KINDS,
  type EventIdToken,
  type SseEventKind,
  type SubscribeOptions,
  type SubscribeTopic,
  type TempoEvent,
} from '../http/event-types';

// ── Constants ──────────────────────────────────────────────────────────────

const DEFAULT_HOST = '127.0.0.1';
const DEFAULT_PORT = 8473;
const RECONNECT_INITIAL_MS = 100;
const RECONNECT_MAX_MS = 30_000;

const SSE_KIND_SET: ReadonlySet<string> = new Set(SSE_EVENT_KINDS);

// ── Public surface ─────────────────────────────────────────────────────────

/**
 * Dependencies the wrapper needs at construction time. All fields are
 * optional with sensible Node 20+ defaults; tests override them.
 */
export interface SubscribeDeps {
  /**
   * Daemon HTTP base URL (e.g. `http://127.0.0.1:8473`). When omitted, the
   * URL is derived per-call from `~/.agent-tempo/daemon.port` with a
   * `127.0.0.1:8473` fallback. Re-read on every reconnect so a daemon
   * restart on a new port heals automatically.
   */
  baseUrl?: string;
  /**
   * Bearer token for `Authorization`. When omitted, no auth header is
   * sent — correct for the loopback default path. Bearer mode is required
   * when bind addr is non-loopback or the request `Origin` is non-loopback
   * (SSE-PROTOCOL.md §3); supply the token explicitly in those cases.
   *
   * **Setting this forces the fetch transport** — native `EventSource`
   * cannot attach an `Authorization` header on the initial connect.
   */
  token?: string;
  /** Override `fetch` — used by tests to drive the wrapper deterministically. */
  fetchImpl?: typeof fetch;
  /**
   * Override the `EventSource` constructor. When omitted, the global
   * `EventSource` is used if available (browsers); when neither is
   * present (Node 20), the wrapper falls back to fetch.
   */
  EventSourceImpl?: typeof EventSource;
  /**
   * Override sleep — used by tests to fast-forward backoff. Accepts an
   * `AbortSignal` so the wrapper can wake early on abort.
   */
  sleep?: (ms: number, signal?: AbortSignal) => Promise<void>;
}

/**
 * Build the `subscribe` method for a TempoClient instance. Returns a
 * function with two overloads — per-ensemble (`subscribe(ensemble, opts)`)
 * and global (`subscribe(opts)`).
 */
export function createSubscribe(deps: SubscribeDeps = {}) {
  const sleepFn = deps.sleep ?? defaultSleep;

  function subscribe(
    ensemble: string,
    opts?: SubscribeOptions,
  ): AsyncIterable<TempoEvent>;
  function subscribe(opts?: SubscribeOptions): AsyncIterable<TempoEvent>;
  function subscribe(
    arg1?: string | SubscribeOptions,
    arg2?: SubscribeOptions,
  ): AsyncIterable<TempoEvent> {
    const scope: SubscribeScope =
      typeof arg1 === 'string'
        ? { type: 'ensemble', ensemble: arg1 }
        : { type: 'global' };
    const opts = (typeof arg1 === 'string' ? arg2 : arg1) ?? {};
    return makeIterable({ scope, opts, deps, sleep: sleepFn });
  }

  return subscribe;
}

// ── Internal types ─────────────────────────────────────────────────────────

type SubscribeScope =
  | { type: 'ensemble'; ensemble: string }
  | { type: 'global' };

interface RunArgs {
  scope: SubscribeScope;
  opts: SubscribeOptions;
  deps: SubscribeDeps;
  sleep: (ms: number, signal?: AbortSignal) => Promise<void>;
}

interface RawSseEvent {
  id?: string;
  event?: string;
  data: string;
}

// ── AsyncIterable plumbing ────────────────────────────────────────────────

function makeIterable(args: RunArgs): AsyncIterable<TempoEvent> {
  return {
    [Symbol.asyncIterator]() {
      return makeIterator(args);
    },
  };
}

/**
 * Build the AsyncIterator. Bridges the run loop (which pushes events) to
 * the consumer (which pulls via `next()`) through a single-element queue
 * with promise-based backpressure.
 */
function makeIterator(args: RunArgs): AsyncIterator<TempoEvent> {
  const externalSignal = args.opts.signal;
  const wrapperController = new AbortController();
  const wrapperSignal = wrapperController.signal;

  // Forward external abort onto the wrapper controller.
  let externalAbortListener: (() => void) | null = null;
  if (externalSignal) {
    if (externalSignal.aborted) {
      wrapperController.abort(externalSignal.reason);
    } else {
      externalAbortListener = () => {
        wrapperController.abort(externalSignal.reason);
      };
      externalSignal.addEventListener('abort', externalAbortListener, {
        once: true,
      });
    }
  }

  function detachExternal(): void {
    if (externalSignal && externalAbortListener) {
      externalSignal.removeEventListener('abort', externalAbortListener);
      externalAbortListener = null;
    }
  }

  // Buffered events ready for the consumer.
  const buffer: TempoEvent[] = [];
  // Promise-based handoff for the next() call awaiting an event.
  let pendingResolve: ((res: IteratorResult<TempoEvent>) => void) | null = null;
  let pendingReject: ((err: unknown) => void) | null = null;
  // Run loop terminal state.
  let done = false;
  let runError: unknown = null;

  function tryDrainPending(): void {
    if (!pendingResolve) return;
    if (buffer.length > 0) {
      const ev = buffer.shift() as TempoEvent;
      const resolve = pendingResolve;
      pendingResolve = null;
      pendingReject = null;
      resolve({ value: ev, done: false });
      return;
    }
    if (done) {
      const resolve = pendingResolve;
      const reject = pendingReject;
      pendingResolve = null;
      pendingReject = null;
      if (runError) reject!(runError);
      else resolve!({ value: undefined as never, done: true });
    }
  }

  const transport = canUseEventSource(args.deps) ? runEventSourceLoop : runFetchLoop;
  const runPromise = transport({
    ...args,
    signal: wrapperSignal,
    onEvent(ev) {
      buffer.push(ev);
      tryDrainPending();
    },
  })
    .catch((err) => {
      runError = err;
    })
    .finally(() => {
      done = true;
      detachExternal();
      tryDrainPending();
    });

  return {
    next(): Promise<IteratorResult<TempoEvent>> {
      if (buffer.length > 0) {
        return Promise.resolve({ value: buffer.shift() as TempoEvent, done: false });
      }
      if (done) {
        if (runError) return Promise.reject(runError);
        return Promise.resolve({ value: undefined as never, done: true });
      }
      return new Promise<IteratorResult<TempoEvent>>((resolve, reject) => {
        pendingResolve = resolve;
        pendingReject = reject;
      });
    },
    async return(): Promise<IteratorResult<TempoEvent>> {
      // Consumer is exiting — `for await … break` lands here. Abort the
      // run loop, drain it, ensure the underlying transport tore down.
      // Without this the SSE socket would leak (§7.4).
      if (!wrapperSignal.aborted) wrapperController.abort('iterator.return');
      detachExternal();
      try {
        await runPromise;
      } catch {
        // Swallow — the consumer has explicitly chosen to stop.
      }
      return { value: undefined as never, done: true };
    },
    async throw(err: unknown): Promise<IteratorResult<TempoEvent>> {
      if (!wrapperSignal.aborted) wrapperController.abort(err);
      detachExternal();
      try {
        await runPromise;
      } catch {
        // Swallow — caller chose to throw.
      }
      throw err;
    },
  };
}

// ── Transport selection ────────────────────────────────────────────────────

interface InternalRunArgs extends RunArgs {
  signal: AbortSignal;
  onEvent: (ev: TempoEvent) => void;
}

/**
 * Native `EventSource` is the preferred transport when:
 * - it's available in the runtime (browsers; Node 22+ optionally), AND
 * - no bearer token is set (loopback / local dev).
 *
 * Otherwise we fall back to fetch — which gives us full header control
 * for `Authorization: Bearer …` and is the only option in Node 20.
 */
function canUseEventSource(deps: SubscribeDeps): boolean {
  if (deps.token) return false;
  return resolveEventSource(deps) !== undefined;
}

function resolveEventSource(deps: SubscribeDeps): typeof EventSource | undefined {
  if (deps.EventSourceImpl) return deps.EventSourceImpl;
  return (globalThis as { EventSource?: typeof EventSource }).EventSource;
}

// ── EventSource transport ──────────────────────────────────────────────────

/**
 * Open a native `EventSource` and pipe each parsed event to `onEvent`.
 * Native auto-reconnect handles `Last-Event-ID` for in-session drops, so
 * this loop is just: open, listen, close on abort. Errors that the
 * `EventSource` cannot recover from (e.g. 404) bubble up via the silent
 * reconnect cycle — for hard-error visibility callers should set a token
 * (which forces the fetch path) or use `signal` with their own timeout.
 */
async function runEventSourceLoop(args: InternalRunArgs): Promise<void> {
  const { scope, opts, deps, signal, onEvent } = args;
  const ES = resolveEventSource(deps);
  if (!ES) throw new Error('[agent-tempo:subscribe] EventSource not available');

  const url = buildUrl(scope, opts.topics, deps.baseUrl);
  const es = new ES(url);

  // EventSource's `addEventListener` is typed against the DOM `EventListener`
  // signature, which isn't in our `lib: ['ES2022']`. We use a structural
  // listener type and cast at the boundary — the runtime surface is just
  // "callable that accepts a MessageEvent".
  type SseListener = (ev: MessageEvent) => void;
  const listeners: Array<[string, SseListener]> = [];
  for (const kind of SSE_EVENT_KINDS) {
    const listener: SseListener = (ev) => {
      const tempoEvent = parseEventSourceMessage(kind, ev);
      if (tempoEvent) onEvent(tempoEvent);
    };
    (es.addEventListener as (type: string, listener: SseListener) => void)(kind, listener);
    listeners.push([kind, listener]);
  }

  return new Promise<void>((resolve) => {
    const teardown = (): void => {
      // Inline call preserves `this` binding on the EventSource — extracting
      // `es.removeEventListener` to a const would lose it under strict mode.
      for (const [k, l] of listeners) {
        (es.removeEventListener as (type: string, listener: SseListener) => void)(k, l);
      }
      es.close();
      resolve();
    };
    if (signal.aborted) {
      teardown();
      return;
    }
    signal.addEventListener('abort', teardown, { once: true });
  });
}

function parseEventSourceMessage(kind: SseEventKind, ev: MessageEvent): TempoEvent | null {
  let envelope: unknown;
  try {
    envelope = JSON.parse(ev.data);
  } catch {
    return null;
  }
  return liftEnvelope(envelope, kind, ev.lastEventId);
}

// ── Fetch transport ────────────────────────────────────────────────────────

/**
 * The fetch reconnect loop. Opens a `fetch`, parses SSE frames, yields
 * events via `onEvent`, and on transport failure backs off and reopens
 * with the latest tracked `Last-Event-ID`. Returns when `signal.aborted`
 * flips.
 */
async function runFetchLoop(args: InternalRunArgs): Promise<void> {
  const { scope, opts, deps, sleep, signal, onEvent } = args;
  const fetchImpl: typeof fetch = deps.fetchImpl ?? globalFetch();

  // In-session reconnect cursor — populated on each event the wrapper
  // sees, replayed via `Last-Event-ID` on every retry. Caller-controllable
  // resume via `opts.lastEventId` was deliberately dropped (ADR 0010).
  let lastEventId: EventIdToken | undefined = undefined;
  let attempt = 0;

  while (!signal.aborted) {
    let connectionYieldedAny = false;
    try {
      const url = buildUrl(scope, opts.topics, deps.baseUrl);
      const headers = buildHeaders(lastEventId, deps.token);
      const response = await fetchImpl(url, { headers, signal });

      if (signal.aborted) break;

      if (!response.ok) {
        if (isPermanentHttpStatus(response.status)) {
          // 401/404 — surface a hard error; do not retry.
          const body = await safeReadBodyText(response);
          throw new SubscribeHttpError(response.status, body);
        }
        if (response.status === 503) {
          // Connection-cap-exceeded (§9). Honor `Retry-After` if present.
          const retryAfter = parseRetryAfter(response.headers.get('Retry-After'));
          await sleep(retryAfter ?? backoffMs(attempt), signal);
          attempt++;
          continue;
        }
        // Other 4xx/5xx — backoff retry. Drain body so the connection can close.
        await safeReadBodyText(response);
        await sleep(backoffMs(attempt), signal);
        attempt++;
        continue;
      }

      if (!response.body) {
        // Server returned no body — treat as transient, back off and retry.
        await sleep(backoffMs(attempt), signal);
        attempt++;
        continue;
      }

      // Stream the body. parseSseStream throws on signal abort.
      for await (const raw of parseSseStream(response.body, signal)) {
        if (raw.id) lastEventId = raw.id;
        const tempoEvent = parseTempoEvent(raw);
        if (!tempoEvent) continue; // malformed / unknown — skip
        if (!connectionYieldedAny) {
          // First event on a fresh connection — reset the backoff so a
          // brief network blip doesn't poison the retry cadence (§7.5).
          attempt = 0;
          connectionYieldedAny = true;
        }
        onEvent(tempoEvent);
      }

      // Stream ended without abort — server closed the connection or the
      // body iterator finished. Reconnect after backoff with the latest
      // `Last-Event-ID`. A connection that yielded no events at all is
      // treated as a transient failure (count it against the backoff
      // schedule) — otherwise an empty-body server bug would tight-loop.
      if (signal.aborted) break;
      await sleep(connectionYieldedAny ? RECONNECT_INITIAL_MS : backoffMs(attempt), signal);
      if (!connectionYieldedAny) attempt++;
    } catch (err) {
      if (signal.aborted) break;
      if (err instanceof SubscribeHttpError) {
        // Permanent — surface to consumer.
        throw err;
      }
      // Network error / parse error / abort during sleep → backoff retry.
      try {
        await sleep(backoffMs(attempt), signal);
      } catch {
        // sleep aborted — outer loop check will exit.
      }
      attempt++;
    }
  }
}

// ── Errors ─────────────────────────────────────────────────────────────────

/**
 * Surfaced to the consumer when the daemon returned a permanent HTTP
 * status (401 unauthorized, 404 ensemble-not-found). Consumers should not
 * retry on these.
 */
export class SubscribeHttpError extends Error {
  constructor(public readonly status: number, public readonly body: string) {
    super(`SSE subscribe failed: HTTP ${status}${body ? ` — ${body}` : ''}`);
    this.name = 'SubscribeHttpError';
  }
}

function isPermanentHttpStatus(status: number): boolean {
  return status === 401 || status === 404;
}

// ── URL + header construction ──────────────────────────────────────────────

function buildUrl(
  scope: SubscribeScope,
  topics: SubscribeTopic[] | undefined,
  baseUrl: string | undefined,
): string {
  const base = resolveBaseUrl(baseUrl);
  const path =
    scope.type === 'ensemble'
      ? `/v1/events/${encodeURIComponent(scope.ensemble)}`
      : '/v1/events';
  if (!topics || topics.length === 0) return `${base}${path}`;
  const query = topics.map((t) => encodeURIComponent(t)).join(',');
  return `${base}${path}?topics=${query}`;
}

function resolveBaseUrl(override: string | undefined): string {
  if (override) return override.replace(/\/$/, '');
  const port = readPortFile() ?? DEFAULT_PORT;
  return `http://${DEFAULT_HOST}:${port}`;
}

function buildHeaders(
  lastEventId: EventIdToken | undefined,
  token: string | undefined,
): Record<string, string> {
  const h: Record<string, string> = {
    Accept: 'text/event-stream',
  };
  if (lastEventId) h['Last-Event-ID'] = lastEventId;
  if (token) h.Authorization = `Bearer ${token}`;
  return h;
}

// ── SSE parser ─────────────────────────────────────────────────────────────

/**
 * Parse an SSE response body into raw frames. Each yielded `RawSseEvent`
 * corresponds to one `\n\n`-delimited block. Comments (lines starting with
 * `:`) and unrecognised fields (e.g. `retry:`) are skipped per the SSE
 * spec. Throws on abort.
 */
async function* parseSseStream(
  body: ReadableStream<Uint8Array>,
  signal: AbortSignal,
): AsyncGenerator<RawSseEvent> {
  const decoder = new TextDecoder('utf-8');
  const reader = body.getReader();
  let buffer = '';
  // Resume scanning at this index instead of `0`. After we've scanned a
  // chunk and found no `\n`, we record the buffer length so the next
  // chunk's scan starts at the boundary — avoids O(n²) on pathologically
  // large `data:` payloads (spec §5: payloads MAY exceed typical SSE
  // samples; consumers MUST NOT cap line length).
  let scanStart = 0;
  let id: string | undefined;
  let event: string | undefined;
  let data: string[] = [];

  const onAbort = (): void => {
    try {
      reader.cancel().catch(() => {});
    } catch {
      // Reader already released.
    }
  };
  if (signal.aborted) onAbort();
  signal.addEventListener('abort', onAbort, { once: true });

  try {
    while (!signal.aborted) {
      const { value, done } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });

      let nlIdx: number;
      while ((nlIdx = buffer.indexOf('\n', scanStart)) !== -1) {
        const line = buffer.slice(0, nlIdx).replace(/\r$/, '');
        buffer = buffer.slice(nlIdx + 1);
        scanStart = 0;

        if (line === '') {
          // Frame complete.
          if (data.length > 0 || event !== undefined || id !== undefined) {
            yield { id, event, data: data.join('\n') };
          }
          id = undefined;
          event = undefined;
          data = [];
          continue;
        }
        if (line.startsWith(':')) continue; // comment
        const colonIdx = line.indexOf(':');
        const field = colonIdx === -1 ? line : line.slice(0, colonIdx);
        let val = colonIdx === -1 ? '' : line.slice(colonIdx + 1);
        if (val.startsWith(' ')) val = val.slice(1);

        if (field === 'id') id = val;
        else if (field === 'event') event = val;
        else if (field === 'data') data.push(val);
        // `retry:` and unknown fields ignored per SSE spec.
      }
      // No `\n` left in the buffer — record the boundary so the next
      // decoded chunk's scan starts here instead of re-scanning the
      // already-checked prefix.
      scanStart = buffer.length;
    }
  } finally {
    signal.removeEventListener('abort', onAbort);
    try {
      reader.releaseLock();
    } catch {
      // Already released.
    }
  }
}

/**
 * Lift a raw SSE frame into a typed `TempoEvent`. Returns `null` for
 * unknown event kinds (forward compatibility per §6) or invalid JSON
 * payloads — both are skipped silently per the spec.
 */
function parseTempoEvent(raw: RawSseEvent): TempoEvent | null {
  if (!raw.event || !SSE_KIND_SET.has(raw.event)) return null;
  let envelope: unknown;
  try {
    envelope = JSON.parse(raw.data);
  } catch {
    return null;
  }
  return liftEnvelope(envelope, raw.event as SseEventKind, raw.id);
}

/**
 * Unwrap the on-wire envelope `{ v, eventId, payload }` produced by
 * `frameSseEvent` in `src/http/sse-handler.ts`. Returns `null` for
 * structurally-invalid frames so a single bad event can't kill the
 * stream (§6 spec — consumers MUST skip).
 */
function liftEnvelope(
  envelope: unknown,
  type: SseEventKind,
  rawId: string | undefined,
): TempoEvent | null {
  if (typeof envelope !== 'object' || envelope === null) return null;
  const env = envelope as { v?: unknown; eventId?: unknown; payload?: unknown };
  if (typeof env.payload !== 'object' || env.payload === null) return null;
  // `||` (not `??`) — `EventSource.lastEventId` is always a `string` and
  // is `''` when no `id:` line was sent, so we have to coerce the empty
  // string to the envelope's `eventId` like the pre-#351 EventSource
  // parser did. The fetch parser produces `string | undefined`; both
  // paths share this fallback chain.
  const fromEnv = typeof env.eventId === 'string' ? env.eventId : '';
  const eventId = rawId || fromEnv || '0:0';
  return {
    v: 1,
    eventId,
    type,
    payload: env.payload,
  } as TempoEvent;
}

// ── Helpers ────────────────────────────────────────────────────────────────

function backoffMs(attempt: number): number {
  // 100, 200, 400, 800, … capped at 30 000 ms per §7.5.
  return Math.min(RECONNECT_INITIAL_MS * Math.pow(2, attempt), RECONNECT_MAX_MS);
}

function parseRetryAfter(header: string | null): number | null {
  if (!header) return null;
  const seconds = Number(header);
  if (!Number.isFinite(seconds) || seconds < 0) return null;
  return Math.round(seconds * 1000);
}

async function safeReadBodyText(response: Response): Promise<string> {
  try {
    return await response.text();
  } catch {
    return '';
  }
}

function defaultSleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    if (signal?.aborted) {
      reject(signal.reason ?? new DOMException('Aborted', 'AbortError'));
      return;
    }
    const timer = setTimeout(() => {
      cleanup();
      resolve();
    }, ms);
    const onAbort = (): void => {
      clearTimeout(timer);
      cleanup();
      reject(signal!.reason ?? new DOMException('Aborted', 'AbortError'));
    };
    const cleanup = (): void => {
      signal?.removeEventListener('abort', onAbort);
    };
    if (signal) signal.addEventListener('abort', onAbort, { once: true });
  });
}

function globalFetch(): typeof fetch {
  // Node 20+ ships fetch as a global; modern browsers do too. We resolve
  // it lazily so the import doesn't fail at module-load on environments
  // that polyfill late (e.g. tests injecting `fetchImpl`).
  const f = (globalThis as { fetch?: typeof fetch }).fetch;
  if (!f) {
    throw new Error(
      '[agent-tempo:subscribe] global fetch is not available; pass deps.fetchImpl',
    );
  }
  return f;
}
