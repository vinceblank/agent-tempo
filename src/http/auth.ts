/**
 * Authentication for the daemon HTTP surface (SSE-PROTOCOL.md §3).
 *
 * **Two modes**:
 *
 * - **Loopback** (default, no auth) — bind addr is loopback AND the request
 *   has no `Origin` header (curl, supervisord) OR `Origin` resolves to a
 *   loopback host. Single-user dev workflows hit this path.
 *
 * - **Bearer** — required when bind addr is non-loopback (`0.0.0.0`) OR
 *   when the request's `Origin` is non-loopback. Defends against DNS
 *   rebinding even on a loopback-bound daemon: a malicious page on the
 *   user's machine resolving `evil.com` to `127.0.0.1` cannot read the
 *   daemon without the bearer token.
 *
 * `/v1/health` is **never authenticated** — it's the liveness probe used
 * by reverse proxies, supervisord, and the TUI bootstrap state machine.
 *
 * **Token storage** (§3.1) — `~/.claude-tempo/config.json` field
 * `httpToken`. Auto-generated on first daemon boot when bearer mode is
 * required and no token is set: `crypto.randomBytes(32).toString('base64url')`,
 * 0600 on POSIX. Rotation = delete the field; next daemon boot regenerates.
 */
import * as crypto from 'crypto';
import { loadConfigFile, saveConfigFile, type PersistedConfig } from '../config';

/** Hostnames that count as loopback for §3 mode determination. */
const LOOPBACK_HOSTS = new Set(['127.0.0.1', '::1', '[::1]', 'localhost']);

/**
 * Is the bind address effectively loopback? `0.0.0.0` is NOT loopback
 * (it binds every interface, including external ones).
 */
export function isLoopbackBindAddr(bindAddr: string): boolean {
  return LOOPBACK_HOSTS.has(bindAddr);
}

/**
 * Parse an `Origin` header to a hostname. Returns `null` when the header
 * is absent, empty, or unparseable as a URL — caller decides the policy.
 */
export function originHost(originHeader: string | undefined): string | null {
  if (!originHeader) return null;
  try {
    const url = new URL(originHeader);
    return url.hostname;
  } catch {
    return null;
  }
}

/**
 * Decide whether bearer mode applies to this request, given the daemon's
 * bind addr and the request's `Origin` header.
 *
 * - bind addr non-loopback → always bearer (`true`)
 * - no Origin header on loopback bind → loopback mode (`false`)
 * - Origin host is loopback on loopback bind → loopback mode (`false`)
 * - Origin host is non-loopback OR unparseable on loopback bind → bearer (`true`)
 */
export function bearerRequired(
  bindAddr: string,
  originHeader: string | undefined,
): boolean {
  if (!isLoopbackBindAddr(bindAddr)) return true;
  if (!originHeader) return false;
  const host = originHost(originHeader);
  if (host == null) return true; // unparseable Origin → fail safe
  return !LOOPBACK_HOSTS.has(host);
}

/**
 * Extract the Bearer token from an `Authorization` header. Returns `null`
 * when the header is missing or doesn't start with the `Bearer ` prefix
 * (case-sensitive per RFC 6750 §2.1). Whitespace inside the token is
 * preserved — comparison is constant-time exact match.
 */
export function extractBearerToken(authHeader: string | undefined): string | null {
  if (!authHeader) return null;
  const prefix = 'Bearer ';
  if (!authHeader.startsWith(prefix)) return null;
  return authHeader.slice(prefix.length);
}

/**
 * Constant-time token comparison. Falls back to a length-mismatch fast
 * path before `crypto.timingSafeEqual` which throws on differing lengths.
 */
export function tokensMatch(received: string, expected: string): boolean {
  if (received.length !== expected.length) return false;
  const a = Buffer.from(received, 'utf8');
  const b = Buffer.from(expected, 'utf8');
  return crypto.timingSafeEqual(a, b);
}

/**
 * Load (or auto-generate) the daemon's HTTP bearer token.
 *
 * - When `bearerRequired` is true and the persisted config has no
 *   `httpToken`, generate one (`crypto.randomBytes(32).toString('base64url')`)
 *   and persist it via `saveConfigFile` (which sets 0600 on POSIX).
 * - When `bearerRequired` is false, return whatever is in the config
 *   without generating — operators may still want a token saved for
 *   future use, and we shouldn't write secrets the user didn't request.
 */
export function loadOrGenerateHttpToken(opts: {
  bearerRequired: boolean;
  load?: () => PersistedConfig;
  save?: (cfg: PersistedConfig) => void;
}): string | null {
  const load = opts.load ?? loadConfigFile;
  const save = opts.save ?? saveConfigFile;

  const cfg = load();
  if (cfg.httpToken && typeof cfg.httpToken === 'string' && cfg.httpToken.length > 0) {
    return cfg.httpToken;
  }
  if (!opts.bearerRequired) return null;
  // Auto-generate. base64url chars are safe inside Authorization values.
  const token = crypto.randomBytes(32).toString('base64url');
  save({ ...cfg, httpToken: token });
  return token;
}
