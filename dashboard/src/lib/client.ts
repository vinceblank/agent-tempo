/**
 * Browser-mode TempoClient — PR-4 of #340.
 *
 * The dashboard is a browser app, so it cannot use the daemon-side
 * `createTempoClientCore` factory: that one wraps a `@temporalio/client`
 * `Client` (gRPC, `node:*` deps) and would balloon the bundle. Instead,
 * this file ships a thin **HTTP-only** client that hits `/v1/*` directly
 * — exactly the surface the daemon's HTTP layer exposes
 * (see `docs/SSE-PROTOCOL.md`).
 *
 * Wire types (`EnsembleSummary`, `EnsembleStateV1`, `TempoEvent`) are
 * imported from the parent repo via the `claude-tempo/*` path alias —
 * **types only**, no runtime deps that could pull in Temporal/Node code.
 * If a wire type changes shape upstream, this module's `tsc` build
 * fails; that's the drift guard the architect asked for in risk #14
 * (PR-3) and risk #2 (PR-4).
 *
 * Architectural deviation from the brief:
 * The conductor's brief said "instantiate `createTempoClientCore` from
 * `claude-tempo/client/core`". That factory takes a Temporal `Client`
 * — not browser-friendly. The architect's design doc §6.1 used the
 * same name as illustrative pseudocode, but the practical answer is
 * a separate browser-mode HTTP client. Documented here so future
 * readers understand why we don't reuse the daemon-side factory.
 */
import type {
  EnsembleStateV1,
  TempoEvent,
  SubscribeOptions,
} from 'claude-tempo/http/event-types';
import type { EnsembleSummary } from 'claude-tempo/client/interface';
import type { HostInfo } from 'claude-tempo/types';
import { logEvent } from './log';
import { getBearerToken } from './auth';

export type { EnsembleStateV1, TempoEvent, EnsembleSummary, HostInfo };

/**
 * Surface the dashboard depends on. Strict subset of the daemon's HTTP
 * API; intentionally smaller than `TempoClientCore` because the
 * dashboard never needs Temporal-direct queries.
 *
 * Reads (PR-4) ride GET; writes (PR-7a) ride POST under the same
 * auth model. See `docs/SSE-PROTOCOL.md` § 11b for the wire contract.
 */
export interface DashboardTempoClient {
  /** GET `/v1/ensembles` — list every live ensemble. */
  listEnsembles(): Promise<EnsembleSummary[]>;
  /** GET `/v1/state/:ensemble` — full ensemble snapshot. */
  state(ensemble: string): Promise<EnsembleStateV1>;
  /** GET `/v1/hosts` — host profiles + freshness/instance info. */
  hosts(): Promise<HostInfo[]>;
  /**
   * Subscribe to per-ensemble SSE events. Yields `TempoEvent`s in order;
   * caller iterates with `for await`. Pass `opts.signal` to abort.
   */
  subscribe(ensemble: string, opts?: SubscribeOptions): AsyncIterable<TempoEvent>;

  // ── Mutations (PR-7b of #340) ────────────────────────────────────

  /** POST `/v1/ensembles/:ensemble/cue` — send a message to a player. */
  cue(ensemble: string, to: string, message: string): Promise<CueResult>;
  /** POST `/v1/ensembles/:ensemble/pause` — pause maestro + scheduler + every session. */
  pause(ensemble: string): Promise<void>;
  /** POST `/v1/ensembles/:ensemble/play` — unpause; `release: true` also fans out releaseHeld. */
  play(ensemble: string, opts?: { release?: boolean }): Promise<void>;
  /** POST `/v1/ensembles/:ensemble/release` — release held sessions in the ensemble. */
  release(ensemble: string, playerId?: string): Promise<ReleaseResult>;
  /** POST `/v1/ensembles/:ensemble/recruit` — spawn a new player. */
  recruit(ensemble: string, opts: RecruitOpts): Promise<RecruitResult>;
  /**
   * POST `/v1/ensembles` — create a fresh ensemble. Wire-pending: the
   * daemon endpoint isn't shipped yet (architect-tracked follow-up).
   * The client method posts in anticipation of that endpoint; until it
   * lands callers should expect a 404 and surface it gracefully.
   */
  createEnsemble(opts: CreateEnsembleOpts): Promise<CreateEnsembleResult>;
}

export interface CueResult {
  ok: true;
  ensemble: string;
  to: string;
}

export interface ReleaseResult {
  released: string[];
  errors: Array<{ playerId: string; error: string }>;
}

export interface RecruitOpts {
  name: string;
  workDir: string;
  agent?: 'claude' | 'copilot';
  playerType?: string;
  host?: string;
  isConductor?: boolean;
  initialMessage?: string;
  systemPrompt?: string;
  held?: boolean;
}

export interface RecruitResult {
  playerId: string;
  entryId: string;
}

export interface CreateEnsembleOpts {
  /** Ensemble name — must satisfy the wire's name regex. */
  name: string;
  /** Optional lineup name from `examples/ensembles/`; omit for blank ensemble. */
  lineup?: string;
  /** Default host for recruits inside the ensemble. */
  host?: string;
  /** Whether new recruits start in `held` mode (`hold`) or run immediately. */
  startMode?: 'hold' | 'release-immediately';
  /** Conductor system-prompt override sent on the first recruit. */
  conductorInstructions?: string;
}

export interface CreateEnsembleResult {
  ensemble: string;
  conductorPlayerId?: string;
}

export interface DashboardClientOpts {
  /** Origin to hit (defaults to `window.location.origin`). */
  baseUrl?: string;
  /** Bearer override (defaults to `getBearerToken()` from `./auth`). */
  bearer?: string | null;
  /** Fetch override — tests pass a mock. */
  fetchImpl?: typeof fetch;
}

/**
 * Build a browser-mode `DashboardTempoClient`. Reads bearer from
 * `localStorage` per call so a paste-then-reload flow picks up the
 * new token without rebuilding the client.
 */
export function createDashboardClient(opts: DashboardClientOpts = {}): DashboardTempoClient {
  const baseUrl = opts.baseUrl ?? (typeof window !== 'undefined' ? window.location.origin : '');
  const fetchImpl = opts.fetchImpl ?? fetch.bind(globalThis);

  function authHeaders(): Record<string, string> {
    const token = opts.bearer === undefined ? getBearerToken() : opts.bearer;
    return token ? { Authorization: `Bearer ${token}` } : {};
  }

  async function getJson<T>(path: string): Promise<T> {
    const res = await fetchImpl(`${baseUrl}${path}`, {
      method: 'GET',
      headers: { Accept: 'application/json', ...authHeaders() },
      credentials: 'same-origin',
    });
    if (!res.ok) {
      const body = await safeReadText(res);
      throw new HttpError(res.status, body || res.statusText, path);
    }
    return res.json() as Promise<T>;
  }

  async function postJson<T>(path: string, body: unknown = {}): Promise<T> {
    const res = await fetchImpl(`${baseUrl}${path}`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Accept: 'application/json',
        ...authHeaders(),
      },
      credentials: 'same-origin',
      body: JSON.stringify(body),
    });
    if (!res.ok) {
      const errBody = await safeReadText(res);
      throw new HttpError(res.status, errBody || res.statusText, path);
    }
    // 202 / 200 with JSON body. Some endpoints return shape-bearing JSON
    // (release, recruit); others return `{ ok, ensemble, ... }` ack
    // shapes. Both are valid `T`.
    return res.json() as Promise<T>;
  }

  function ensemblePath(ensemble: string, action: string): string {
    return `/v1/ensembles/${encodeURIComponent(ensemble)}/${action}`;
  }

  return {
    async listEnsembles() {
      return getJson<EnsembleSummary[]>('/v1/ensembles');
    },
    async state(ensemble: string) {
      const path = `/v1/state/${encodeURIComponent(ensemble)}`;
      return getJson<EnsembleStateV1>(path);
    },
    async hosts() {
      return getJson<HostInfo[]>('/v1/hosts');
    },
    subscribe(ensemble, subOpts = {}) {
      return makeSseIterable(baseUrl, ensemble, subOpts, authHeaders());
    },

    // ── Mutations (PR-7b) ─────────────────────────────────────────

    async cue(ensemble, to, message) {
      return postJson<CueResult>(ensemblePath(ensemble, 'cue'), { to, message });
    },
    async pause(ensemble) {
      await postJson(ensemblePath(ensemble, 'pause'));
    },
    async play(ensemble, opts) {
      const body = opts?.release === true ? { release: true } : {};
      await postJson(ensemblePath(ensemble, 'play'), body);
    },
    async release(ensemble, playerId) {
      const body = playerId !== undefined ? { playerId } : {};
      return postJson<ReleaseResult>(ensemblePath(ensemble, 'release'), body);
    },
    async recruit(ensemble, opts) {
      return postJson<RecruitResult>(ensemblePath(ensemble, 'recruit'), opts);
    },
    async createEnsemble(opts) {
      // Wire-pending — daemon doesn't expose POST /v1/ensembles yet.
      // postJson surfaces the 404 to the mutation hook, which toasts a
      // wire-gap message rather than a generic failure.
      return postJson<CreateEnsembleResult>('/v1/ensembles', opts);
    },
  };
}

/** HTTP error from a fetch — surfaces status + path for query error UIs. */
export class HttpError extends Error {
  constructor(
    public readonly status: number,
    public readonly body: string,
    public readonly path: string,
  ) {
    super(`HTTP ${status} ${path}: ${body}`);
    this.name = 'HttpError';
  }
}

async function safeReadText(res: Response): Promise<string> {
  try { return await res.text(); } catch { return ''; }
}

// ── SSE wrapper ──────────────────────────────────────────────────────────

/**
 * Build the SSE AsyncIterable. Uses native `EventSource` when no bearer
 * is needed (loopback dev); falls back to a `fetch().body` reader when
 * a bearer must be sent (cross-device pair flow, PR-7+).
 *
 * Reconnect semantics are deferred to the underlying transport —
 * `EventSource` reconnects automatically; the fetch path here keeps it
 * simple for PR-4 and surfaces a `gap` event to the consumer instead of
 * silently re-fetching. Per §7.5 the consumer (queries.ts via sse.ts)
 * decides what to do with `gap`.
 */
function makeSseIterable(
  baseUrl: string,
  ensemble: string,
  opts: SubscribeOptions,
  authHeaders: Record<string, string>,
): AsyncIterable<TempoEvent> {
  return {
    [Symbol.asyncIterator]() {
      return makeSseIterator(baseUrl, ensemble, opts, authHeaders);
    },
  };
}

function makeSseIterator(
  baseUrl: string,
  ensemble: string,
  opts: SubscribeOptions,
  authHeaders: Record<string, string>,
): AsyncIterator<TempoEvent> {
  const url = `${baseUrl}/v1/events/${encodeURIComponent(ensemble)}`;
  const wantsBearer = !!authHeaders.Authorization;
  const hasNativeES = typeof EventSource !== 'undefined';
  const useEventSource = hasNativeES && !wantsBearer;

  const buffer: TempoEvent[] = [];
  let pending: ((r: IteratorResult<TempoEvent>) => void) | null = null;
  let pendingRej: ((e: unknown) => void) | null = null;
  let done = false;
  let runErr: unknown = null;

  const ctrl = new AbortController();
  if (opts.signal?.aborted) {
    ctrl.abort(opts.signal.reason);
  } else if (opts.signal) {
    opts.signal.addEventListener('abort', () => ctrl.abort(opts.signal!.reason), { once: true });
  }

  function tryDrain(): void {
    if (!pending) return;
    if (buffer.length > 0) {
      const ev = buffer.shift() as TempoEvent;
      const r = pending;
      pending = null;
      pendingRej = null;
      r({ value: ev, done: false });
      return;
    }
    if (done) {
      const resolve = pending;
      const reject = pendingRej;
      pending = null;
      pendingRej = null;
      if (runErr) reject!(runErr);
      else resolve!({ value: undefined as never, done: true });
    }
  }

  function push(ev: TempoEvent): void {
    buffer.push(ev);
    tryDrain();
  }

  const runPromise = useEventSource
    ? runEventSource(url, ctrl.signal, push)
    : runFetchStream(url, authHeaders, ctrl.signal, push);

  runPromise
    .catch((err) => { runErr = err; })
    .finally(() => { done = true; tryDrain(); });

  return {
    next(): Promise<IteratorResult<TempoEvent>> {
      if (buffer.length > 0) {
        return Promise.resolve({ value: buffer.shift() as TempoEvent, done: false });
      }
      if (done) {
        if (runErr) return Promise.reject(runErr);
        return Promise.resolve({ value: undefined as never, done: true });
      }
      return new Promise<IteratorResult<TempoEvent>>((resolve, reject) => {
        pending = resolve;
        pendingRej = reject;
      });
    },
    async return(): Promise<IteratorResult<TempoEvent>> {
      if (!ctrl.signal.aborted) ctrl.abort('iterator.return');
      try { await runPromise; } catch { /* swallowed — explicit teardown */ }
      return { value: undefined as never, done: true };
    },
  };
}

function runEventSource(
  url: string,
  signal: AbortSignal,
  push: (ev: TempoEvent) => void,
): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    const es = new EventSource(url, { withCredentials: true });
    const onAbort = () => { es.close(); resolve(); };
    if (signal.aborted) return onAbort();
    signal.addEventListener('abort', onAbort, { once: true });

    es.onerror = () => {
      // EventSource auto-reconnects; readyState === 2 means closed
      // permanently (e.g. server returned non-2xx). Treat as terminal.
      if (es.readyState === EventSource.CLOSED) {
        signal.removeEventListener('abort', onAbort);
        reject(new Error('SSE connection closed by server'));
      }
    };

    // Per the daemon's wire format: `event:` carries the SSE event kind,
    // `data:` carries `{ v, eventId, payload }` JSON. Subscribe to every
    // kind separately because EventSource only fires `onmessage` for
    // type-less events.
    const SSE_KINDS = [
      'snapshot', 'gap', 'throttled', 'heartbeat',
      'ensemble.created', 'ensemble.destroyed',
      'player.added', 'player.removed', 'player.phase_changed',
      'chat.appended', 'chat.compressed',
      'flags.changed', 'schedules.changed', 'host_profile.changed',
    ] as const;
    for (const kind of SSE_KINDS) {
      es.addEventListener(kind, (ev) => {
        try {
          const wire = JSON.parse((ev as MessageEvent).data) as { eventId: string; payload: unknown };
          push({
            v: 1,
            type: kind,
            eventId: wire.eventId,
            payload: wire.payload,
          } as TempoEvent);
        } catch (err) {
          logEvent('sse.parse-error', {
            kind,
            error: err instanceof Error ? err.message : String(err),
          }, 'warn');
        }
      });
    }
  });
}

async function runFetchStream(
  url: string,
  authHeaders: Record<string, string>,
  signal: AbortSignal,
  push: (ev: TempoEvent) => void,
): Promise<void> {
  const res = await fetch(url, {
    headers: { Accept: 'text/event-stream', ...authHeaders },
    signal,
    credentials: 'same-origin',
  });
  if (!res.ok || !res.body) {
    throw new HttpError(res.status, await safeReadText(res), url);
  }
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buf = '';
  try {
    while (!signal.aborted) {
      const { done, value } = await reader.read();
      if (done) return;
      if (value) buf += decoder.decode(value, { stream: true });
      let nl: number;
      while ((nl = buf.indexOf('\n\n')) !== -1) {
        const frame = buf.slice(0, nl);
        buf = buf.slice(nl + 2);
        const parsed = parseSseFrame(frame);
        if (parsed) push(parsed);
      }
    }
  } finally {
    try { reader.cancel(); } catch { /* ignore */ }
  }
}

function parseSseFrame(frame: string): TempoEvent | null {
  if (!frame || frame.startsWith(':')) return null; // comment-only frame
  let type: string | undefined;
  const dataLines: string[] = [];
  for (const line of frame.split('\n')) {
    if (line.startsWith('event: ')) type = line.slice(7);
    else if (line.startsWith('data: ')) dataLines.push(line.slice(6));
  }
  if (!type || dataLines.length === 0) return null;
  try {
    const wire = JSON.parse(dataLines.join('\n')) as { eventId: string; payload: unknown };
    return {
      v: 1,
      type,
      eventId: wire.eventId,
      payload: wire.payload,
    } as TempoEvent;
  } catch {
    return null;
  }
}
