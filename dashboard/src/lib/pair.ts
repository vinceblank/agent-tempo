/**
 * Cross-device pair-token consume — PR-8 of #340.
 *
 * The CLI's `claude-tempo dashboard --pair` mints a single-use,
 * 5-minute, base64url 32-byte token and prints a QR-code URL of the
 * form `https://<daemon-url>/dashboard/?pair=<token>`. When the user
 * scans that on their phone the SPA loads with `?pair=<token>` in
 * the query string. This module's `usePairTokenConsume` hook is the
 * SPA-side terminal of that flow:
 *
 *   1. Detect `?pair=<token>` on first mount.
 *   2. ⚠ **Risk #16**: drop `?pair=<token>` from the URL via
 *      `window.history.replaceState({}, '', '/dashboard/')` BEFORE
 *      we ever touch storage. If we wrote the bearer first and the
 *      next render landed on a buggy logger or third-party
 *      analytics, the full token could leak into bookmarks /
 *      browser history. Token-out → bearer-in is the safe order.
 *   3. Exchange the token at `GET /dashboard/api/pair/:token`.
 *      On success the daemon hands back the bearer; we persist it
 *      through `setBearerToken` so subsequent SSE / fetch calls
 *      authenticate.
 *   4. Always log via `logEvent('pair.<state>', { tokenPrefix })` —
 *      first 8 chars of the token only, never the full value.
 *      Mirrors the daemon-side telemetry in `src/http/dashboard-pair.ts`.
 */
import { useEffect, useRef, useState } from 'react';
import { setBearerToken } from './auth';
import { logEvent } from './log';

export type PairState =
  | { kind: 'idle' }
  | { kind: 'consuming'; tokenPrefix: string }
  | { kind: 'paired'; tokenPrefix: string }
  | { kind: 'failed'; tokenPrefix: string; reason: string };

interface PairConsumeResponse {
  bearer: string;
  expiresAt: number;
}

/** Strip `?pair=<token>` from the URL before any other state change. */
export function dropPairTokenFromUrl(): void {
  if (typeof window === 'undefined') return;
  try {
    const url = new URL(window.location.href);
    if (!url.searchParams.has('pair')) return;
    url.searchParams.delete('pair');
    // Preserve hash + other query params; restore pathname as-is so
    // a deep-linked entry like `/dashboard/ensemble/foo?pair=...`
    // doesn't lose its target route.
    window.history.replaceState({}, '', `${url.pathname}${url.search}${url.hash}`);
  } catch {
    /* malformed URL — fall through; token already gone from any subsequent reads */
  }
}

/** First 8 chars of the token — safe for logs and UI status text. */
function prefixOf(token: string): string {
  return token.slice(0, 8);
}

/**
 * Read `?pair=<token>` (if any) and return it, immediately stripping
 * it from the URL. Pure helper exported for tests.
 */
export function consumePairTokenFromUrl(): string | null {
  if (typeof window === 'undefined') return null;
  let token: string | null = null;
  try {
    const url = new URL(window.location.href);
    token = url.searchParams.get('pair');
  } catch {
    /* malformed URL */
  }
  // ⚠ Risk #16 — drop the token from the URL BEFORE storage / any
  // downstream effect can observe it.
  dropPairTokenFromUrl();
  return token && token.length > 0 ? token : null;
}

interface UsePairTokenOpts {
  /** Override the fetch impl (tests). */
  fetchImpl?: typeof fetch;
  /** Origin override; defaults to `window.location.origin`. */
  baseUrl?: string;
}

/**
 * React hook driving the consume flow. Runs once on mount when a
 * `?pair=<token>` is present in the URL; subsequent mounts (e.g.
 * route change) are no-ops.
 */
export function usePairTokenConsume(opts: UsePairTokenOpts = {}): PairState {
  const [state, setState] = useState<PairState>({ kind: 'idle' });
  const ranRef = useRef(false);

  useEffect(() => {
    if (ranRef.current) return;
    ranRef.current = true;

    const token = consumePairTokenFromUrl();
    if (!token) return;

    const tokenPrefix = prefixOf(token);
    setState({ kind: 'consuming', tokenPrefix });
    logEvent('pair.consume-start', { tokenPrefix });

    const baseUrl =
      opts.baseUrl ?? (typeof window !== 'undefined' ? window.location.origin : '');
    const fetchImpl = opts.fetchImpl ?? fetch.bind(globalThis);
    const url = `${baseUrl}/dashboard/api/pair/${encodeURIComponent(token)}`;

    let cancelled = false;
    (async () => {
      try {
        const res = await fetchImpl(url, {
          method: 'GET',
          headers: { Accept: 'application/json' },
          credentials: 'same-origin',
        });
        if (!res.ok) {
          const reason = `http-${res.status}`;
          if (!cancelled) {
            setState({ kind: 'failed', tokenPrefix, reason });
            logEvent('pair.consume-failed', { tokenPrefix, reason }, 'warn');
          }
          return;
        }
        const body = (await res.json()) as PairConsumeResponse;
        if (!body.bearer || typeof body.bearer !== 'string') {
          if (!cancelled) {
            setState({ kind: 'failed', tokenPrefix, reason: 'malformed-response' });
            logEvent('pair.consume-failed', { tokenPrefix, reason: 'malformed-response' }, 'warn');
          }
          return;
        }
        // Race guard: if the component unmounted between the
        // network response and this branch, don't write the bearer
        // — a stale paired-but-unmounted hook would leak the token
        // into localStorage with no UI to surface or revoke it.
        // Both the persistent side effect and the state update sit
        // inside the cancelled-check together.
        if (!cancelled) {
          setBearerToken(body.bearer);
          setState({ kind: 'paired', tokenPrefix });
          logEvent('pair.consume-success', { tokenPrefix });
        }
      } catch (err) {
        const reason = err instanceof Error ? err.message : String(err);
        if (!cancelled) {
          setState({ kind: 'failed', tokenPrefix, reason });
          logEvent('pair.consume-failed', { tokenPrefix, reason }, 'warn');
        }
      }
    })();

    return () => {
      cancelled = true;
    };
    // Mount-once semantics. `opts` is intentionally not in the dep
    // list — the hook is consumer-once and the test override is
    // captured on first call.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return state;
}
