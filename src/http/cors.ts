/**
 * CORS handling for the daemon HTTP surface (SSE-PROTOCOL.md §3.2).
 *
 * **Only enforced in bearer mode.** Loopback-mode requests skip CORS
 * entirely — there's no cross-origin worry when the daemon and consumer
 * share a host with no Origin or a loopback Origin.
 *
 * **Defaults**:
 * - Allowlist: `localhost:*` and `127.0.0.1:*` echoed back
 * - `Access-Control-Allow-Credentials: false` (non-configurable)
 * - `Access-Control-Allow-Methods: GET, OPTIONS` (non-configurable)
 * - `Access-Control-Allow-Headers: Authorization, Last-Event-ID` (non-configurable)
 * - `Access-Control-Max-Age: 600` (non-configurable)
 *
 * Override the allowlist via `AGENT_TEMPO_CORS_ORIGINS` — comma-separated
 * explicit origins (e.g. `https://dashboard.example.com,https://localhost:3000`).
 * Wildcards are NOT supported. `*` is incompatible with credentials, and
 * we want operators to opt every origin in deliberately.
 */
import { isLoopbackBindAddr } from './auth';

/** Hostnames that always pass the default allowlist. */
const LOOPBACK_HOSTS = new Set(['127.0.0.1', '::1', 'localhost']);

export interface CorsConfig {
  /** Explicit list from `AGENT_TEMPO_CORS_ORIGINS`. Empty → defaults only. */
  allowedOrigins: string[];
}

/**
 * Parse the comma-separated env var. Empty / undefined → empty list.
 * Trims whitespace; rejects empty entries; preserves case (Origin
 * comparison is case-sensitive per RFC 6454 §4).
 */
export function parseCorsOrigins(raw: string | undefined): string[] {
  if (!raw) return [];
  return raw
    .split(',')
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}

/**
 * Decide if `originHeader` is allowed. Pass `true` for `bearerActive` only
 * when bearer mode applies to the request — loopback mode short-circuits
 * to `true` (no enforcement).
 *
 * Returns the value to echo on `Access-Control-Allow-Origin`, or `null`
 * if the origin should be rejected. The default loopback allowlist
 * (`localhost:*`, `127.0.0.1:*`) matches by hostname only; ports are
 * always permitted because operators frequently bind dev servers to
 * arbitrary ports.
 */
export function evaluateOrigin(
  originHeader: string | undefined,
  config: CorsConfig,
  bearerActive: boolean,
): { allowed: boolean; echo: string | null } {
  // Loopback mode: never enforce. No ACAO header set unless caller picks
  // a permissive value — leave the decision to the response builder.
  if (!bearerActive) return { allowed: true, echo: null };

  if (!originHeader) {
    // Bearer mode but no Origin (e.g. server-to-server fetch). Allow
    // by default; the bearer token still gates content. Browser fetches
    // always include Origin — this branch is for non-browser callers.
    return { allowed: true, echo: null };
  }

  // Explicit allowlist takes precedence.
  if (config.allowedOrigins.length > 0) {
    if (config.allowedOrigins.includes(originHeader)) {
      return { allowed: true, echo: originHeader };
    }
    return { allowed: false, echo: null };
  }

  // Default: any port on a loopback hostname.
  let host: string | null = null;
  try {
    const url = new URL(originHeader);
    host = url.hostname;
  } catch {
    return { allowed: false, echo: null };
  }
  if (host && LOOPBACK_HOSTS.has(host)) {
    return { allowed: true, echo: originHeader };
  }
  return { allowed: false, echo: null };
}

/**
 * Static CORS response headers — independent of the request's Origin.
 * The dynamic `Access-Control-Allow-Origin` comes from
 * {@link evaluateOrigin}.
 */
export function corsResponseHeaders(): Record<string, string> {
  return {
    'Access-Control-Allow-Methods': 'GET, OPTIONS',
    'Access-Control-Allow-Headers': 'Authorization, Last-Event-ID',
    'Access-Control-Allow-Credentials': 'false',
    'Access-Control-Max-Age': '600',
    Vary: 'Origin',
  };
}

/**
 * Convenience wrapper — should the daemon enforce CORS at all? `true`
 * iff the bind addr is non-loopback (every connection is bearer-mode)
 * OR the operator opted into bearer mode by setting an explicit
 * allowlist via `AGENT_TEMPO_CORS_ORIGINS`.
 *
 * Used at boot time to decide whether to install the CORS middleware
 * or no-op it. Per-request bearer determination still happens via
 * {@link bearerRequired} — this helper is a startup short-circuit.
 */
export function corsEnforced(bindAddr: string, allowedOrigins: string[]): boolean {
  return !isLoopbackBindAddr(bindAddr) || allowedOrigins.length > 0;
}
