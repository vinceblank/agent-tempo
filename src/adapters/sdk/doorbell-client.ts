/**
 * DoorbellClient — adapter-side consumer of the daemon's cue doorbell
 * (T1.1 PR-2, design: docs/design/t11-cue-doorbell.md §2.3/§2.4).
 *
 * Subscribes to `GET /doorbell/:ensemble/:playerId` (SSE; loopback +
 * `X-Ingest-Token`) and fires `onDing` per coalesced ring. The §1 invariant
 * governs everything here: **doorbell loss must be indistinguishable from
 * doorbell-never-sent** —
 *
 *   - A ding is a HINT, not a guarantee: the daemon's pending bit is
 *     level-triggered and coalesced, so a ding can arrive for a message the
 *     poll loop already fetched (one wasted query, §5 row 2) and a ring can
 *     be lost entirely (fallback poll delivers within the ceiling, §5 row 1).
 *   - EVERY failure (no token, port file missing, route 404/403/500, daemon
 *     down, stream drop) degrades to silent disconnected state + reconnect
 *     with capped backoff. NO error escalation, ever — a player must behave
 *     identically whether the doorbell never existed or just died (§5).
 *   - Connection-state transitions emit exactly one `[agent-tempo:doorbell]`
 *     breadcrumb each (the #249 observability lesson) — that is the only
 *     above-debug logging in this file.
 *
 * Discovery/auth follow the locked inner-loop ingress contract
 * (`src/pi/inner-loop-client.ts`): port via {@link readPortFile} (`null` ⇒
 * daemon HTTP not up), loopback base `http://127.0.0.1:{port}`, token from
 * `AGENT_TEMPO_INGEST_TOKEN` (threaded at spawn; absent ⇒ never subscribes ⇒
 * pure T0.2 behavior).
 *
 * **This file runs in the Node.js adapter process, NOT the Temporal workflow
 * sandbox.**
 */
import { ENV } from '../../config';
import { readPortFile } from '../../http/port-file';

const defaultLog = (...args: unknown[]): void =>
  console.error('[agent-tempo:doorbell]', ...args);

/** Reconnect backoff: 1s doubling to a 30s cap (same family as the daemon's bind retry, #768). */
export function doorbellReconnectDelayMs(retry: number, baseMs = 1_000, capMs = 30_000): number {
  return Math.min(capMs, baseMs * 2 ** Math.min(retry, 31));
}

/**
 * Minimal streaming-fetch shape this client needs — injectable for tests.
 * `body` must be an async-iterable of byte chunks (Node 18+ global `fetch`
 * response bodies are).
 */
export type DoorbellFetch = (
  url: string,
  init: { headers: Record<string, string>; signal: AbortSignal },
) => Promise<{ status: number; body: AsyncIterable<Uint8Array> | null }>;

export interface DoorbellClientOptions {
  /** The player's ensemble (URL path segment). */
  ensemble: string;
  /** The player's id (URL path segment). */
  playerId: string;
  /** Fired once per `ding` event (already coalesced daemon-side). */
  onDing: () => void;
  /**
   * Fired on connected/disconnected transitions. Drives the idle-poll
   * ceiling (connected ⇒ 60s, disconnected ⇒ the T0.2 30s floor). Never
   * fired redundantly (true→true / false→false).
   */
  onConnectionChange?: (connected: boolean) => void;
  /** Ingest token. Defaults to `process.env[ENV.INGEST_TOKEN]`. */
  ingestToken?: string;
  /** Daemon port discovery. Defaults to {@link readPortFile}. */
  readPort?: () => number | null;
  /** HTTP transport. Defaults to global `fetch` (client disabled if absent). */
  fetchFn?: DoorbellFetch;
  /** Test seam — defaults to a real setTimeout sleep. */
  sleep?: (ms: number) => Promise<void>;
  log?: (...args: unknown[]) => void;
  /** Reconnect backoff knobs (tests). */
  baseDelayMs?: number;
  maxDelayMs?: number;
}

/** Default transport — global `fetch` adapted to {@link DoorbellFetch}, or `null`. */
function resolveFetch(): DoorbellFetch | null {
  const g = (globalThis as { fetch?: unknown }).fetch;
  if (typeof g !== 'function') return null;
  return g as unknown as DoorbellFetch;
}

/**
 * Cap on the partial-block buffer. Real doorbell blocks are tens of bytes;
 * the daemon is trusted + loopback, so this is a cheap backstop against a
 * pathological stream without `\n\n` terminators growing memory unboundedly
 * — overflow just drops the buffer (a lost ding ≡ never-sent, §1).
 */
const MAX_PARSER_BUFFER = 8 * 1024;

/**
 * Incremental SSE block parser for the doorbell stream. Feed raw text
 * chunks; returns the number of `ding` events completed by this chunk.
 * Keepalive comments (`:ka`) and the `:closed` marker carry no event name
 * and are ignored. Exported @internal for unit tests.
 */
export class DingParser {
  private buffer = '';

  feed(chunk: string): number {
    this.buffer += chunk;
    let dings = 0;
    // SSE events are separated by a blank line. Process every complete
    // block; keep the trailing partial in the buffer.
    let sep = this.buffer.indexOf('\n\n');
    while (sep !== -1) {
      const block = this.buffer.slice(0, sep);
      this.buffer = this.buffer.slice(sep + 2);
      if (/^event:\s*ding\s*$/m.test(block)) dings++;
      sep = this.buffer.indexOf('\n\n');
    }
    if (this.buffer.length > MAX_PARSER_BUFFER) this.buffer = '';
    return dings;
  }
}

/**
 * Wakeable sleep — the ding→immediate-poll primitive, shared by
 * `SdkAttachment` (PR-2) and the Pi cue pump (PR-3, which is NOT an
 * SdkAttachment). Semantics:
 *
 *   - `sleep(ms)` parks until the timer fires OR `wake()` pops it early.
 *   - `wake()` with no parked sleep sets a level-triggered pending bit so
 *     the NEXT `sleep` returns immediately — a ding that lands while the
 *     consumer is mid-tick is consumed, not lost (mirrors the daemon
 *     registry's coalescing; extra wakes coalesce into one).
 *   - One parked sleep at a time (one poll loop per consumer). A STALE
 *     timer from an abandoned sleep (e.g. a `Promise.race` loser) is
 *     identity-guarded so it can never clobber a newer sleep's waker.
 */
export class WakeableSleep {
  private wakeFn: (() => void) | null = null;
  private pending = false;

  sleep(ms: number): Promise<void> {
    if (this.pending) {
      this.pending = false;
      return Promise.resolve();
    }
    return new Promise<void>((resolve) => {
      const wake = (): void => {
        clearTimeout(timer);
        if (this.wakeFn === wake) this.wakeFn = null;
        resolve();
      };
      const timer = setTimeout(() => {
        if (this.wakeFn === wake) this.wakeFn = null;
        resolve();
      }, ms);
      timer.unref?.();
      this.wakeFn = wake;
    });
  }

  wake(): void {
    if (this.wakeFn) {
      this.wakeFn();
    } else {
      this.pending = true;
    }
  }
}

/**
 * Reconnecting SSE consumer for the daemon doorbell. `start()` launches the
 * detached connect loop; `stop()` aborts the live stream and ends it. All
 * callbacks fire on the client's own async path — keep them cheap (the
 * adapters' `onDing` just wakes a sleeping poll loop).
 */
export class DoorbellClient {
  private readonly opts: DoorbellClientOptions;
  private readonly token: string | undefined;
  private readonly readPort: () => number | null;
  private readonly fetchFn: DoorbellFetch | null;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly log: (...args: unknown[]) => void;

  private stopped = false;
  private connected = false;
  private abort: AbortController | null = null;
  private loop: Promise<void> | null = null;

  constructor(opts: DoorbellClientOptions) {
    this.opts = opts;
    this.token = opts.ingestToken ?? process.env[ENV.INGEST_TOKEN];
    this.readPort = opts.readPort ?? (() => readPortFile());
    this.fetchFn = opts.fetchFn ?? resolveFetch();
    this.sleep = opts.sleep ?? ((ms) => new Promise<void>((r) => setTimeout(r, ms).unref?.()));
    this.log = opts.log ?? defaultLog;
  }

  /** Whether a doorbell stream is currently live (drives the poll ceiling). */
  get isConnected(): boolean {
    return this.connected;
  }

  /**
   * Launch the connect loop. No token / no fetch ⇒ logs one breadcrumb and
   * never subscribes (§5: pure T0.2 behavior). Idempotent.
   */
  start(): void {
    if (this.loop) return;
    if (!this.token || !this.fetchFn) {
      this.log(
        `doorbell disabled for ${this.opts.ensemble}/${this.opts.playerId} ` +
        `(${!this.token ? 'no ingest token' : 'no fetch transport'}) — polling only`,
      );
      return;
    }
    this.loop = this.runLoop().catch((err) => {
      // The loop swallows everything itself — this is a last-resort guard so
      // an unexpected throw can never escalate out of the doorbell (§5).
      this.log('doorbell loop ended unexpectedly (polling covers):', (err as Error)?.message ?? err);
    });
  }

  /** End the loop and abort any live stream. Idempotent. */
  stop(): void {
    if (this.stopped) return;
    this.stopped = true;
    try { this.abort?.abort(); } catch { /* already settled */ }
    this.setConnected(false);
  }

  private setConnected(connected: boolean): void {
    if (this.connected === connected) return;
    this.connected = connected;
    this.log(
      `doorbell ${connected ? 'connected' : 'disconnected'} ` +
      `(${this.opts.ensemble}/${this.opts.playerId})`,
    );
    try {
      this.opts.onConnectionChange?.(connected);
    } catch (err) {
      this.log('onConnectionChange threw (ignored):', (err as Error)?.message ?? err);
    }
  }

  private async runLoop(): Promise<void> {
    for (let retry = 0; !this.stopped; retry++) {
      const streamed = await this.connectOnce();
      if (this.stopped) return;
      // A stream that delivered ANY bytes proves the daemon was reachable —
      // reset the reconnect curve so a healthy-but-bounced daemon comes back
      // at 1s, not wherever a prior outage left the counter.
      if (streamed) retry = 0;
      await this.sleep(doorbellReconnectDelayMs(retry, this.opts.baseDelayMs, this.opts.maxDelayMs));
    }
  }

  /**
   * One subscribe attempt. Returns `true` when the stream OPENED (HTTP 200)
   * regardless of how it ended. Every failure path is silent-by-design
   * below the transition breadcrumb.
   */
  private async connectOnce(): Promise<boolean> {
    const port = this.readPort();
    if (port === null) return false; // daemon HTTP not up — §5 "daemon down" row
    const url = `http://127.0.0.1:${port}/doorbell/${encodeURIComponent(this.opts.ensemble)}/${encodeURIComponent(this.opts.playerId)}`;
    this.abort = new AbortController();
    try {
      const res = await this.fetchFn!(url, {
        headers: { 'x-ingest-token': this.token! },
        signal: this.abort.signal,
      });
      if (res.status !== 200 || !res.body) return false; // 403/404/5xx — §5 "route" rows
      this.setConnected(true);
      const parser = new DingParser();
      const decoder = new TextDecoder();
      for await (const chunk of res.body) {
        if (this.stopped) break;
        const dings = parser.feed(decoder.decode(chunk, { stream: true }));
        for (let i = 0; i < dings; i++) {
          try {
            this.opts.onDing();
          } catch (err) {
            this.log('onDing threw (ignored):', (err as Error)?.message ?? err);
          }
        }
      }
      return true;
    } catch {
      // Connect refused / aborted / read error — disconnected state covers it.
      return false;
    } finally {
      this.abort = null;
      this.setConnected(false);
    }
  }
}
