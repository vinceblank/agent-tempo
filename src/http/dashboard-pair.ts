/**
 * Dashboard QR-code pairing flow — PR-8 of #340.
 *
 * Replaces the 501 stub `handlePairTokenStub` from
 * `src/http/dashboard.ts` (PR-1) with the real two-endpoint flow:
 *
 *   POST /dashboard/api/pair         (post-auth)
 *     The CLI invokes this when the operator runs `claude-tempo
 *     dashboard --pair`. Mints a single-use, 5-minute, base64url
 *     32-byte token. The token is paired with the operator's bearer
 *     for delivery on consume.
 *
 *   GET  /dashboard/api/pair/:token  (pre-auth carve-out, parallel
 *                                     to /v1/health)
 *     The dashboard SPA calls this on first mount when it sees
 *     `?pair=<token>` in the URL. Exchanges the token for the
 *     daemon's bearer + a TTL hint. Marks the token used so a
 *     second consume returns 410 Gone.
 *
 * State is in-memory (`Map<token, PendingPairing>`) — daemon restart
 * invalidates outstanding pairings, which ADR 0013 documents as an
 * acceptable trade for v1 (operator re-runs `--pair` after a
 * restart; pairings are inherently transient).
 *
 * Token lifecycle:
 *   created   → mint adds to `pendingPairings`
 *   consumed  → first GET marks `used: true` + immediately deletes
 *               from the map so a leaked token can't even attempt a
 *               second exchange. (The check is "absent or used".)
 *   expired   → swept every {@link PAIR_SWEEP_INTERVAL_MS} or
 *               opportunistically on consume; returns 410 in both
 *               cases.
 *
 * Security posture:
 *   - The token is 32 bytes of `crypto.randomBytes` rendered as
 *     base64url. ~256 bits of entropy; brute-force is infeasible
 *     within the 5-min window.
 *   - The token is short-TTL by design — we don't persist it across
 *     daemon restarts and we don't surface it on logs above prefix.
 *   - We never log the full token. `pair.minted` / `pair.consumed`
 *     log lines carry only the first 8 chars (`tokenPrefix`) for
 *     correlating with telemetry.
 *   - The mint endpoint requires a bearer (it's behind the standard
 *     auth gate). The consume endpoint does NOT require a bearer —
 *     the token IS the auth, parallel to `/v1/health` per
 *     `docs/design/340-web-dashboard.md` §4.1.
 */
import type { IncomingMessage, ServerResponse } from 'http';
import { randomBytes } from 'crypto';
import { errorResponse, jsonResponse } from './responses';

/** TTL for a pending pairing — 5 minutes, hard ceiling. */
export const PAIR_TTL_MS = 5 * 60 * 1000;

/** How often the sweep removes expired entries; cheaper than per-request. */
export const PAIR_SWEEP_INTERVAL_MS = 60 * 1000;

/** Bytes of entropy in the token; rendered as base64url (no padding). */
const PAIR_TOKEN_BYTES = 32;

/**
 * Hard cap on simultaneous pending pairings. Defence-in-depth against
 * an abusive operator (or a script in the operator's terminal)
 * hammering `claude-tempo dashboard --pair` faster than the 60-second
 * sweep can reclaim memory. With 5-min TTL the natural ceiling is one
 * mint per second × 300 seconds = 300 entries; cap at 100 forces a
 * 503 long before that becomes load-bearing.
 */
export const MAX_PENDING_PAIRINGS = 100;

interface PendingPairing {
  /** Bearer to hand back to the SPA on consume. */
  bearer: string;
  /** Absolute ms epoch after which the pairing is expired. */
  expiresAt: number;
}

/**
 * In-memory pending-pairing map. Module-level so a single daemon
 * shares one map across requests; tests reset via
 * `__resetPairingsForTests`.
 */
const pendingPairings = new Map<string, PendingPairing>();

let sweepTimer: ReturnType<typeof setInterval> | null = null;

function scheduleSweep(): void {
  if (sweepTimer) return;
  sweepTimer = setInterval(() => sweepExpired(), PAIR_SWEEP_INTERVAL_MS);
  // Don't keep the daemon process alive on a sweep timer alone.
  if (typeof sweepTimer.unref === 'function') sweepTimer.unref();
}

/** Strip every entry whose `expiresAt` is in the past. */
function sweepExpired(now: number = Date.now()): number {
  let removed = 0;
  for (const [token, p] of pendingPairings) {
    if (p.expiresAt <= now) {
      pendingPairings.delete(token);
      removed++;
    }
  }
  return removed;
}

/** Generate a fresh token. Exported for tests. */
export function mintPairToken(): string {
  return randomBytes(PAIR_TOKEN_BYTES).toString('base64url');
}

/** First 8 chars of the token — safe to log for telemetry correlation. */
function prefix(token: string): string {
  return token.slice(0, 8);
}

const log = (...args: unknown[]) => console.error('[agent-tempo:pair]', ...args);

/**
 * POST `/dashboard/api/pair` — mint a pairing. Caller is the operator
 * via `claude-tempo dashboard --pair`; the request has already passed
 * the bearer-auth gate so we know the operator is authorised. We
 * accept the operator's bearer from the `Authorization` header and
 * stamp it onto the pending entry so consume can hand it back.
 *
 * Response: `{ token, expiresAt }`. The CLI renders the QR.
 */
export function handlePairCreate(
  req: IncomingMessage,
  res: ServerResponse,
  bearer: string | null,
): void {
  if (!bearer) {
    // Defensive — the caller in `server.ts` already requires bearer
    // mode for non-loopback binds. On loopback there's no bearer to
    // hand back, so the pair flow is a no-op (the SPA on the host
    // doesn't need a token; QR-code-from-mobile is the use case).
    return errorResponse(res, 400, {
      error: 'pair-requires-bearer',
      hint: 'pair flow only meaningful on bearer-protected binds',
    });
  }
  // Opportunistic sweep before the size check — if we're at the cap
  // because the sweep timer hasn't run yet, expired entries should
  // free up first rather than turning every retry into a 503.
  sweepExpired();
  if (pendingPairings.size >= MAX_PENDING_PAIRINGS) {
    log('pair.mint-rejected', `reason=cap-exceeded pending=${pendingPairings.size}`);
    return errorResponse(res, 503, {
      error: 'pair-pending-cap',
      hint: 'too many pending pairings — wait for the 5-min TTL to expire and retry',
    });
  }
  const token = mintPairToken();
  const expiresAt = Date.now() + PAIR_TTL_MS;
  pendingPairings.set(token, { bearer, expiresAt });
  scheduleSweep();
  log('pair.minted', `tokenPrefix=${prefix(token)}`, `expiresAt=${expiresAt}`);
  // No `Cache-Control` override — `jsonResponse` defaults to `no-store`.
  jsonResponse(res, 201, { token, expiresAt });
}

/**
 * GET `/dashboard/api/pair/:token` — exchange the token for the bearer.
 *
 * Single-use: even if expired or never minted, return 410 Gone so an
 * attacker can't distinguish "token never existed" from "token
 * already consumed". The `error` field stays generic
 * (`pair-token-invalid`) for the same reason.
 */
export function handlePairConsume(
  _req: IncomingMessage,
  res: ServerResponse,
  token: string,
): void {
  const now = Date.now();
  const entry = pendingPairings.get(token);
  if (!entry || entry.expiresAt <= now) {
    if (entry) pendingPairings.delete(token); // expired — clean up
    log('pair.consume-rejected', `tokenPrefix=${prefix(token)}`, `reason=invalid-or-expired`);
    return errorResponse(res, 410, { error: 'pair-token-invalid' });
  }
  // Single-use: delete IMMEDIATELY before we even write the response
  // so a duplicate request lands on the "absent" branch above.
  pendingPairings.delete(token);
  log('pair.consumed', `tokenPrefix=${prefix(token)}`);
  jsonResponse(res, 200, {
    bearer: entry.bearer,
    expiresAt: entry.expiresAt,
  });
}

/**
 * Test escape hatch — wipe the in-memory map so each test starts
 * from zero pendingPairings. Production code MUST NOT call this.
 *
 * Following the project's `__<verb><Noun>ForTests` naming convention
 * (ADR 0006). Also stops the sweep timer so vitest exits cleanly.
 */
export function __resetPairingsForTests(): void {
  pendingPairings.clear();
  if (sweepTimer) {
    clearInterval(sweepTimer);
    sweepTimer = null;
  }
}

/** Test-only — peek at the current count of pending pairings. */
export function __pendingPairingsCountForTests(): number {
  return pendingPairings.size;
}

/** Test-only — manually trigger the sweep at a synthetic `now`. */
export function __sweepExpiredForTests(now: number): number {
  return sweepExpired(now);
}
