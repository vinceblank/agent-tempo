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
 * **Token storage** (§3.1) — `~/.agent-tempo/config.json` field
 * `httpToken`. Auto-generated on first daemon boot when bearer mode is
 * required and no token is set: `crypto.randomBytes(32).toString('base64url')`,
 * 0600 on POSIX. Rotation = delete the field; next daemon boot regenerates.
 */
import * as crypto from 'crypto';
import { ENV, loadConfigFile, saveConfigFile, type PersistedConfig } from '../config';

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
 * Constant-time token comparison.
 *
 * **Length-leak tradeoff** (PR-1 review followup): the leading
 * length-mismatch short-circuit reveals the expected token length to a
 * timing observer who can measure the difference between "rejected
 * before constant-time compare" and "ran the full constant-time
 * compare". Mitigations considered:
 *
 *  1. Pad the received token to a fixed length before comparison.
 *     Adds branching in the pad path that itself can leak via timing.
 *  2. Use HMAC-then-compare to render length irrelevant at the cost of
 *     an extra hash per request.
 *
 * Neither is worth it for a token whose length is fixed by our own
 * generator (`crypto.randomBytes(32).toString('base64url')` is always
 * 43 chars). An attacker observing length learns nothing they can't
 * trivially guess from inspecting the daemon's source. Without the
 * length gate `crypto.timingSafeEqual` throws on mismatched lengths,
 * which would force a try/catch in the hot path with worse timing
 * properties. Document the assumption here so a future contributor
 * reading "constant-time" doesn't assume length is also blinded.
 */
export function tokensMatch(received: string, expected: string): boolean {
  if (received.length !== expected.length) return false;
  const a = Buffer.from(received, 'utf8');
  const b = Buffer.from(expected, 'utf8');
  return crypto.timingSafeEqual(a, b);
}

/**
 * @deprecated 3e — superseded by {@link loadRbacTokens} (read + admin split).
 * Kept only until every caller migrates; do NOT add new callers. Resolves the
 * legacy single `httpToken` (env-less) for back-compat shims.
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
  const token = crypto.randomBytes(32).toString('base64url');
  save({ ...cfg, httpToken: token });
  return token;
}

// ── 3e RBAC token model (MD-E) ──────────────────────────────────────────────

/** Resolved RBAC tokens for the daemon HTTP surface (3e). */
export interface RbacTokens {
  /** T1 read token (env > config.json > auto-gen), or `null` when none + not required. */
  readToken: string | null;
  /** T1+T2+T3 admin token — ENV-VAR-ONLY, or `null` when unset (→ 503 on T≥2). */
  adminToken: string | null;
  /**
   * True when a LEGACY `httpToken` (no `readToken`) was adopted as the read token.
   * The daemon emits a one-time startup warning so the operator sets an admin token.
   */
  legacyMigrated: boolean;
}

/** Admin token — ENV-VAR-ONLY (never config.json/disk, never auto-generated). */
export function loadAdminToken(env: NodeJS.ProcessEnv = process.env): string | null {
  const t = env[ENV.HTTP_ADMIN_TOKEN];
  return t && t.length > 0 ? t : null;
}

/**
 * Read token (T1). Priority: env `AGENT_TEMPO_HTTP_READ_TOKEN` > config.json
 * `readToken` > LEGACY config.json `httpToken` (adopted → `legacy:true`) >
 * auto-generate when bearer mode is required (persisted as `readToken`).
 */
export function loadReadToken(opts: {
  bearerRequired: boolean;
  env?: NodeJS.ProcessEnv;
  load?: () => PersistedConfig;
  save?: (cfg: PersistedConfig) => void;
}): { token: string | null; legacy: boolean } {
  const env = opts.env ?? process.env;
  const load = opts.load ?? loadConfigFile;
  const save = opts.save ?? saveConfigFile;

  const envTok = env[ENV.HTTP_READ_TOKEN];
  if (envTok && envTok.length > 0) return { token: envTok, legacy: false };

  const cfg = load();
  if (cfg.readToken && cfg.readToken.length > 0) return { token: cfg.readToken, legacy: false };
  // LEGACY: a pre-3e single `httpToken` becomes the READ token (T1) — NOT admin.
  if (cfg.httpToken && cfg.httpToken.length > 0) return { token: cfg.httpToken, legacy: true };

  if (!opts.bearerRequired) return { token: null, legacy: false };
  const token = crypto.randomBytes(32).toString('base64url');
  save({ ...cfg, readToken: token });
  return { token, legacy: false };
}

/** Load both RBAC tokens. The daemon calls this once at startup. */
export function loadRbacTokens(opts: {
  bearerRequired: boolean;
  env?: NodeJS.ProcessEnv;
  load?: () => PersistedConfig;
  save?: (cfg: PersistedConfig) => void;
}): RbacTokens {
  const { token: readToken, legacy } = loadReadToken(opts);
  const adminToken = loadAdminToken(opts.env);
  return { readToken, adminToken, legacyMigrated: legacy };
}

/** Access tiers (MD-E): 1 = read/observe, 2 = write/mutate, 3 = supervisory (inner-tail). */
export type Tier = 1 | 2 | 3;

/**
 * Granted tier for a presented bearer, given the RBAC tokens (timing-safe).
 * Admin grants the FULL ladder (3 ⊇ 2 ⊇ 1); read grants T1 only; no match → 0.
 * There is no T2-only token — T2 and T3 are both "admin required".
 */
export function tierForToken(
  presented: string,
  tokens: { readToken: string | null; adminToken: string | null },
): 0 | 1 | 3 {
  if (tokens.adminToken && tokensMatch(presented, tokens.adminToken)) return 3;
  if (tokens.readToken && tokensMatch(presented, tokens.readToken)) return 1;
  return 0;
}

export interface TierGuardInput {
  /** Daemon bind address — decides loopback trust. */
  bindAddr: string;
  /** Request `Origin` header (may be absent for a non-browser client). */
  originHeader: string | undefined;
  /** Request `Authorization` header. */
  authHeader: string | undefined;
  /** Read-tier token, or `null`. */
  readToken: string | null;
  /** Admin token, or `null` when unset (→ 503 on T≥2). */
  adminToken: string | null;
}

export type TierGuardResult =
  | { ok: true }
  | { ok: false; status: 401; error: 'unauthorized' }
  | { ok: false; status: 403; error: 'insufficient-tier'; detail: string }
  | { ok: false; status: 503; error: 'admin-token-not-configured'; detail: string };

/** Migration hint surfaced in the 403 body so a read-token holder knows what's missing. */
const INSUFFICIENT_TIER_HINT =
  'This token is read-tier. Writes and the inner-tail require the admin token (set AGENT_TEMPO_HTTP_ADMIN_TOKEN).';
const ADMIN_UNSET_HINT =
  'Set AGENT_TEMPO_HTTP_ADMIN_TOKEN (env-var only) to enable writes / inner-tail.';

/**
 * Authorization guard (3e MD-E). Assumes the shared upstream pass already settled
 * AUTHENTICATION + CORS + the DNS-rebind/Origin defense (architect's Layer 2);
 * this is Layer-3 authZ — it ONLY decides tier ≥ N and emits 503/403/401.
 *
 * Matrix (bearer mode):
 *   - loopback (`!bearerRequired`)        → PASS all tiers (local-trust short-circuit).
 *   - N ≥ 2 AND adminToken unset          → 503 admin-token-not-configured.
 *   - no/invalid bearer (granted 0)       → 401 unauthorized.
 *   - granted < N (read token on T≥2)     → 403 insufficient-tier (+ migration hint).
 *   - granted ≥ N (admin, or read on T1)  → PASS.
 *
 * Keyed off the `Authorization` bearer only (no `Origin`/cookie requirement) so a
 * headless Node client passes once its token validates. View-agnostic by design.
 */
export function requireTier(tier: Tier, input: TierGuardInput): TierGuardResult {
  // Loopback trust: local clients (TUI / CLI / future Pi widget) get full access.
  if (!bearerRequired(input.bindAddr, input.originHeader)) return { ok: true };
  // A tier that needs admin is UNAVAILABLE when no admin token is configured —
  // the honest answer is 503, regardless of what the caller presents.
  if (tier >= 2 && input.adminToken === null) {
    return { ok: false, status: 503, error: 'admin-token-not-configured', detail: ADMIN_UNSET_HINT };
  }
  const provided = extractBearerToken(input.authHeader);
  if (!provided) return { ok: false, status: 401, error: 'unauthorized' };
  const granted = tierForToken(provided, input);
  if (granted === 0) return { ok: false, status: 401, error: 'unauthorized' };
  if (granted < tier) {
    return { ok: false, status: 403, error: 'insufficient-tier', detail: INSUFFICIENT_TIER_HINT };
  }
  return { ok: true };
}
