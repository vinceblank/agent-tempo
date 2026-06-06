/**
 * Gate poll-bridge client (3d / MD-G) — the SUBPROCESS side of the operator gate.
 *
 * When the Pi `tool_call` handler engages the gate, it awaits {@link
 * GateClient.awaitDecision}, which polls the daemon's resolution route
 * (`GET /v1/players/:e/:p/gate/:requestId/resolution`, ingest-token auth, same
 * loopback boundary as the 3c inner-loop) until the operator decides OR the
 * daemon's authoritative 45s auto-allow lands. R1 (resolved): Pi awaits the
 * returned `tool_call` Promise, so this inline poll-await is safe.
 *
 * TWO bounds, BOTH required (architect/conductor):
 *   - `signal` (Pi's `ctx.signal`): if the turn is cancelled (Esc/abort), the
 *     poll stops immediately and resolves `allow` (the tool won't run anyway —
 *     never leave the loop hung; Pi #2381).
 *   - `timeoutMs`: a safety net for an UNREACHABLE daemon. `open` (monitored) is
 *     autonomous-first → timeout resolves `allow`; `closed` (supervised) is
 *     fail-closed → timeout resolves `deny`.
 * In the normal case the daemon answers first (operator decision, or its lazy
 * auto-allow / auto-deny), so this subprocess deadline is only the daemon-down
 * backstop. The `closed` deadline is DERIVED from the daemon's 300s auto-deny
 * (+ buffer, ≥310s) so the daemon's *audited* auto-deny is RECEIVED first.
 *
 * Effect mapping (#700 / G): operator `deny` + supervised timeout `auto-deny` →
 * `deny` (block the tool); `allow` / `auto-allow` / abort → `allow` (permit);
 * deadline/daemon-down → `allow` (open) or `deny` (closed). The (b) backstop:
 * `closed` + no ingest token → `deny`, never the silent-allow no-op. Network/
 * transport errors on a single poll are swallowed (retry next tick).
 *
 * Client-side ONLY (src/pi). Not imported by workflows.
 */
import { readPortFile } from '../http/port-file';
import { GATE_CLOSED_DENY_MS } from '../http/gate-registry';
import type { GateFailMode } from '../http/gate-registry';

/** Env var carrying the per-player ingest token (threaded in at spawn, shared w/ inner-loop). */
export const INGEST_TOKEN_ENV = 'AGENT_TEMPO_INGEST_TOKEN';
/** Default poll cadence — reuse the inner-loop short-poll so a fresh decision lands within ~1s. */
const DEFAULT_POLL_MS = 1_000;
/**
 * Subprocess deadline for `open` (monitored) — slightly beyond the daemon's 45s
 * auto-allow so, when the daemon is reachable, its authoritative answer always
 * wins; this only fires when the daemon is unreachable.
 */
const DEFAULT_TIMEOUT_MS = 50_000;
/**
 * Buffer added to the daemon's closed-deny fuse to DERIVE the client `closed`
 * deadline. Keeps the invariant `client_closed > daemon_closed` so the daemon's
 * *audited* `auto-deny` is RECEIVED before the client's own fallback fires (the
 * fallback denies anyway, but losing the daemon's audit record is a regression).
 */
const CLOSED_TIMEOUT_BUFFER_MS = 10_000;
/**
 * ★ Subprocess deadline for `closed` (supervised) — DERIVED from the daemon's
 * single-source {@link GATE_CLOSED_DENY_MS} (never hard-coded), so a future bump
 * of the daemon timeout can't silently reincarnate the fail-open-via-drift bug.
 * Invariant: `CLOSED_TIMEOUT_MS (≥310s) > GATE_CLOSED_DENY_MS (300s)`.
 */
const CLOSED_TIMEOUT_MS = GATE_CLOSED_DENY_MS + CLOSED_TIMEOUT_BUFFER_MS;

/** What the handler does with the result. */
export type GateEffect = 'allow' | 'deny';

/** Minimal `fetch` shape (injectable for tests) — same contract as the inner-loop client. */
export type GateFetch = (
  url: string,
  init: { method: string; headers: Record<string, string> },
) => Promise<{ status: number; json(): Promise<unknown> }>;

export interface GateClientOptions {
  ensemble: string;
  playerId: string;
  ingestToken?: string;
  readPort?: () => number | null;
  fetchFn?: GateFetch;
  pollIntervalMs?: number;
  /** `open`-mode (monitored) deadline. Defaults to {@link DEFAULT_TIMEOUT_MS} (50s). */
  timeoutMs?: number;
  /** `closed`-mode (supervised) deadline. Defaults to the DERIVED {@link CLOSED_TIMEOUT_MS} (≥310s). */
  closedTimeoutMs?: number;
  now?: () => number;
  /** Cancellable wait (tests inject a synchronous/controllable one). */
  sleep?: (ms: number, signal?: AbortSignal) => Promise<void>;
}

const log = (...args: unknown[]): void => {
  // eslint-disable-next-line no-console
  console.error('[agent-tempo:pi]', ...args);
};

function resolveFetch(): GateFetch | null {
  const g = (globalThis as { fetch?: unknown }).fetch;
  return typeof g === 'function' ? (g as unknown as GateFetch) : null;
}

/** Default cancellable sleep — resolves after `ms`, or early if `signal` aborts. */
function defaultSleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal?.aborted) { resolve(); return; }
    const timer = setTimeout(() => { signal?.removeEventListener('abort', onAbort); resolve(); }, ms);
    const onAbort = (): void => { clearTimeout(timer); resolve(); };
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}

/**
 * Loopback poll-bridge to the daemon gate. Construct one per headless player.
 * The `awaitDecision` poll is the only public surface used by the engagement path.
 */
export class GateClient {
  private readonly ensemble: string;
  private readonly playerId: string;
  private readonly ingestToken: string | undefined;
  private readonly readPort: () => number | null;
  private readonly fetchFn: GateFetch | null;
  private readonly pollIntervalMs: number;
  private readonly timeoutMs: number;
  private readonly closedTimeoutMs: number;
  private readonly now: () => number;
  private readonly sleep: (ms: number, signal?: AbortSignal) => Promise<void>;

  constructor(opts: GateClientOptions) {
    this.ensemble = opts.ensemble;
    this.playerId = opts.playerId;
    this.ingestToken = opts.ingestToken ?? process.env[INGEST_TOKEN_ENV];
    this.readPort = opts.readPort ?? (() => readPortFile());
    this.fetchFn = opts.fetchFn ?? resolveFetch();
    this.pollIntervalMs = opts.pollIntervalMs ?? DEFAULT_POLL_MS;
    this.timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.closedTimeoutMs = opts.closedTimeoutMs ?? CLOSED_TIMEOUT_MS;
    this.now = opts.now ?? Date.now;
    this.sleep = opts.sleep ?? defaultSleep;
  }

  private get enabled(): boolean {
    return Boolean(this.ingestToken) && this.fetchFn !== null;
  }

  private resolutionUrl(port: number, requestId: string): string {
    return `http://127.0.0.1:${port}/v1/players/` +
      `${encodeURIComponent(this.ensemble)}/${encodeURIComponent(this.playerId)}/gate/` +
      `${encodeURIComponent(requestId)}/resolution`;
  }

  /** One poll. Returns the effect on a resolved answer, or null to keep polling. */
  private async pollOnce(requestId: string): Promise<GateEffect | null> {
    const port = this.readPort();
    if (port == null) return null; // daemon HTTP down → keep trying until the bound
    try {
      const res = await this.fetchFn!(this.resolutionUrl(port, requestId), {
        method: 'GET',
        headers: { 'X-Ingest-Token': this.ingestToken! },
      });
      if (res.status !== 200) return null; // 404 (not-yet-registered race) / 403 → retry
      const data = (await res.json()) as { status?: unknown; decision?: unknown };
      if (data.status !== 'resolved') return null;
      // operator deny + supervised timeout auto-deny → deny; allow + auto-allow → allow.
      // (#700 / G bug-2 fix: 'auto-deny' ≠ 'deny' must still map to deny, or a
      // supervised closed-deny silently fail-opens at the client.)
      return data.decision === 'deny' || data.decision === 'auto-deny' ? 'deny' : 'allow';
    } catch {
      return null; // transport error → retry next tick
    }
  }

  /**
   * Poll the daemon for the operator's decision on `requestId`, blocking until
   * resolved / timeout / abort. The fail posture is per-request (#700 / G),
   * threaded via `opts.failMode` (defaults `'open'` → today's behavior verbatim):
   *
   *   - `'open'` (monitored) — FAIL-OPEN: `allow` unless the operator explicitly
   *     denied; without a token/transport, deadline, or daemon-down → `allow`.
   *   - `'closed'` (supervised) — FAIL-CLOSED: `deny` on deadline / daemon-down,
   *     and the (b) no-token BACKSTOP — a supervised player MUST have an ingest
   *     token to poll; `!enabled` + `closed` → `deny`, never the silent-allow
   *     no-op (that would be the exact fail-open leak supervised exists to
   *     prevent). The closed deadline is DERIVED to be ≥ the daemon's 300s
   *     auto-deny + buffer, so the daemon's *audited* auto-deny is received first.
   *
   * ABORT (turn cancelled) returns `allow` in BOTH modes — the tool won't run
   * anyway; denying a dead turn is moot + would spuriously audit a deny.
   */
  async awaitDecision(
    requestId: string,
    opts: { signal?: AbortSignal; timeoutMs?: number; failMode?: GateFailMode } = {},
  ): Promise<GateEffect> {
    const closed = opts.failMode === 'closed';
    if (!this.enabled) return closed ? 'deny' : 'allow'; // (b) backstop: no token + supervised must NOT allow
    const deadline = this.now() + (opts.timeoutMs ?? (closed ? this.closedTimeoutMs : this.timeoutMs));
    while (this.now() < deadline) {
      if (opts.signal?.aborted) return 'allow'; // (a) cancelled turn — moot, allow in BOTH modes
      const effect = await this.pollOnce(requestId);
      if (effect !== null) return effect;
      await this.sleep(this.pollIntervalMs, opts.signal);
    }
    if (closed) {
      log(`gate decision timed out for ${requestId} (supervised, daemon unreachable?) — auto-DENY`);
      return 'deny'; // fail-closed backstop (daemon-down / deadline)
    }
    log(`gate decision timed out for ${requestId} (daemon unreachable?) — auto-allow`);
    return 'allow'; // autonomous-first backstop (daemon-down)
  }
}
