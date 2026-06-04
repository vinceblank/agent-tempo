/**
 * Inner-loop HTTP client (3c Part 5) — the PRODUCTION {@link InnerLoopRegistry}
 * impl the {@link InnerLoopPublisher} injects.
 *
 * Why HTTP, not in-process: a headless Pi player is a DETACHED subprocess,
 * separate from the daemon that hosts the real fine-tail registry + SSE
 * side-channel. So `publish` / `subscriberCount` are thin loopback-HTTP calls to
 * the daemon, discovered via the port-file. This client lives on the player side
 * of that boundary; lead owns the daemon endpoints.
 *
 * LOCKED wire contract (lead, Part 4):
 *   - Discovery: {@link readPortFile} → daemon HTTP port (`null` ⇒ daemon HTTP
 *     not up ⇒ no-op gracefully). Base `http://127.0.0.1:${port}` (loopback only).
 *   - Auth: `X-Ingest-Token: <token>` on BOTH calls, from `AGENT_TEMPO_INGEST_TOKEN`
 *     (threaded in at spawn). Token unset ⇒ no-op (publish drops, presence ⇒ 0).
 *   - POST `/v1/players/:ensemble/:playerId/inner/ingest` — body = the InnerFrame
 *     JSON object DIRECTLY (no wrapper), ≤32KB (DOS backstop). 204 ⇒ ok; ANY
 *     other status / network error ⇒ DROP the frame, never throw, never block
 *     the Pi loop (fire-and-forget).
 *   - GET `/v1/players/:ensemble/:playerId/inner/presence` — 200 `{subscribers:number}`;
 *     anything else (e.g. 403) ⇒ treat as 0.
 *
 * `subscriberCount` MUST be synchronous (the interface) — it returns a CACHED
 * value, refreshed stale-while-revalidate: each call fires a rate-limited
 * background GET (≤1/`presencePollMs`) and returns the last known count (default
 * 0 until the first GET resolves, and on any failure — fail-safe: unknown ⇒ no
 * forwarding). The publisher additionally rate-limits how often it calls this.
 */
import { readPortFile } from '../http/port-file';
import type { InnerFrame, InnerLoopRegistry } from './inner-loop-publisher';

/** Env var carrying the per-player ingest token (threaded in at spawn). */
export const INGEST_TOKEN_ENV = 'AGENT_TEMPO_INGEST_TOKEN';
/** DOS backstop — frames over this are dropped (summaries are already ~2KB-truncated). */
export const MAX_FRAME_BYTES = 32 * 1024;
const DEFAULT_PRESENCE_POLL_MS = 1000;

/** Minimal `fetch` shape this client needs — injectable for tests. */
export type InnerLoopFetch = (
  url: string,
  init: { method: string; headers: Record<string, string>; body?: string },
) => Promise<{ status: number; json(): Promise<unknown> }>;

export interface InnerLoopHttpClientOptions {
  /** The player's ensemble (URL path segment). */
  ensemble: string;
  /** The player's id (URL path segment). */
  playerId: string;
  /** Ingest token. Defaults to `process.env[INGEST_TOKEN_ENV]`. */
  ingestToken?: string;
  /** Daemon port discovery. Defaults to {@link readPortFile}. */
  readPort?: () => number | null;
  /** HTTP transport. Defaults to global `fetch` (no-op if absent). */
  fetchFn?: InnerLoopFetch;
  /** Min interval between presence GETs (default 1000ms). */
  presencePollMs?: number;
  /** Injected clock (tests). Defaults to `Date.now`. */
  now?: () => number;
}

const log = (...args: unknown[]): void => {
  // eslint-disable-next-line no-console
  console.error('[agent-tempo:pi]', ...args);
};

/** Default transport — global `fetch` adapted to {@link InnerLoopFetch}, or a no-op. */
function resolveFetch(): InnerLoopFetch | null {
  const g = (globalThis as { fetch?: unknown }).fetch;
  if (typeof g !== 'function') return null;
  return g as unknown as InnerLoopFetch;
}

/**
 * Loopback-HTTP {@link InnerLoopRegistry}. Construct one per headless player with
 * its ensemble + playerId; the publisher calls `publish` / `subscriberCount`.
 * The `workflowId` argument is the player's own and is unused — the URL is built
 * from the ctor ensemble + playerId.
 */
export class InnerLoopHttpClient implements InnerLoopRegistry {
  private readonly ensemble: string;
  private readonly playerId: string;
  private readonly ingestToken: string | undefined;
  private readonly readPort: () => number | null;
  private readonly fetchFn: InnerLoopFetch | null;
  private readonly presencePollMs: number;
  private readonly now: () => number;

  /** Last presence count from the daemon. 0 until the first GET resolves / on failure. */
  private cachedSubscribers = 0;
  private lastPresenceRefresh = -Infinity;

  constructor(opts: InnerLoopHttpClientOptions) {
    this.ensemble = opts.ensemble;
    this.playerId = opts.playerId;
    this.ingestToken = opts.ingestToken ?? process.env[INGEST_TOKEN_ENV];
    this.readPort = opts.readPort ?? (() => readPortFile());
    this.fetchFn = opts.fetchFn ?? resolveFetch();
    this.presencePollMs = opts.presencePollMs ?? DEFAULT_PRESENCE_POLL_MS;
    this.now = opts.now ?? Date.now;
  }

  /** Whether the client can talk to the daemon at all (token + transport present). */
  private get enabled(): boolean {
    return Boolean(this.ingestToken) && this.fetchFn !== null;
  }

  private baseUrl(port: number): string {
    return `http://127.0.0.1:${port}/v1/players/` +
      `${encodeURIComponent(this.ensemble)}/${encodeURIComponent(this.playerId)}/inner`;
  }

  /** Fire-and-forget POST of one frame. Drops (never throws/blocks) on any failure. */
  publish(_workflowId: string, frame: InnerFrame): void {
    if (!this.enabled) return;
    const port = this.readPort();
    if (port == null) return; // daemon HTTP not up → drop gracefully

    let body: string;
    try {
      body = JSON.stringify(frame);
    } catch {
      return; // unserializable frame → drop
    }
    if (Buffer.byteLength(body, 'utf8') > MAX_FRAME_BYTES) {
      log(`inner frame ${frame.type} exceeds ${MAX_FRAME_BYTES}B — dropped`);
      return;
    }

    void this.fetchFn!(`${this.baseUrl(port)}/ingest`, {
      method: 'POST',
      headers: { 'X-Ingest-Token': this.ingestToken!, 'Content-Type': 'application/json' },
      body,
    })
      .then((res) => {
        if (res.status !== 204) {
          // 403 (loopback/token/shape) / 413 (oversize) / other — drop silently.
        }
      })
      .catch(() => { /* network error — drop, never propagate into the Pi loop */ });
  }

  /** Synchronous cached presence (stale-while-revalidate). Default 0 / fail-safe 0. */
  subscriberCount(_workflowId: string): number {
    this.maybeRefreshPresence();
    return this.cachedSubscribers;
  }

  /** Fire a rate-limited background presence GET that updates the cache. */
  private maybeRefreshPresence(): void {
    if (!this.enabled) return;
    const t = this.now();
    if (t - this.lastPresenceRefresh < this.presencePollMs) return;
    const port = this.readPort();
    if (port == null) return;
    this.lastPresenceRefresh = t;

    void this.fetchFn!(`${this.baseUrl(port)}/presence`, {
      method: 'GET',
      headers: { 'X-Ingest-Token': this.ingestToken! },
    })
      .then(async (res) => {
        if (res.status !== 200) {
          this.cachedSubscribers = 0; // 403/etc → treat as no subscribers
          return;
        }
        try {
          const data = (await res.json()) as { subscribers?: unknown };
          this.cachedSubscribers = typeof data.subscribers === 'number' ? data.subscribers : 0;
        } catch {
          this.cachedSubscribers = 0;
        }
      })
      .catch(() => { this.cachedSubscribers = 0; });
  }
}
