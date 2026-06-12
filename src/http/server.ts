/**
 * Daemon HTTP server — PR-1 of #94/#95.
 *
 * Hosts the read-only snapshot endpoints (`/v1/health`, `/v1/ensembles`,
 * `/v1/state/:ensemble`, `/v1/hosts`) defined in `docs/SSE-PROTOCOL.md`.
 * The SSE streaming endpoints (`/v1/events*`) are PR-2.
 *
 * Boot lifecycle:
 *   1. Caller passes a {@link TempoClient}, namespace, and version to
 *      {@link startHttpServer}.
 *   2. Server binds to `127.0.0.1:8473` in production / `:8474` in dev mode
 *      (defaults overridable via `AGENT_TEMPO_HTTP_BIND` /
 *      `AGENT_TEMPO_DAEMON_PORT`; dev profile per ADR 0014 §5.1).
 *   3. The bound port is written atomically to `~/.agent-tempo/daemon.port`.
 *   4. Caller `await`s {@link HttpServerHandle.close} on shutdown — drains
 *      in-flight requests, removes the port file, then resolves.
 */
import * as http from 'http';
import type { TempoClient } from '../client/interface';
import { DEV_DAEMON_PORT, ENV, PROD_DAEMON_PORT, isDevMode } from '../config';
import type { AggregateRunner } from './aggregate';
import {
  bearerRequired,
  extractBearerToken,
  isLoopbackBindAddr,
  loadReadToken,
  loadAdminToken,
  tierForToken,
  requireTier,
  type Tier,
  type TierGuardInput,
  type TierGuardResult,
} from './auth';
import type { InnerLoopRegistry } from './inner-loop';
import type { IngestTokenRegistry } from './ingest-registry';
import { handleInnerIngest, handleInnerPresence, handleInnerSse } from './inner-loop-routes';
import {
  corsResponseHeaders,
  evaluateOrigin,
  parseCorsOrigins,
  type CorsConfig,
} from './cors';
import {
  handleDashboardStatic,
} from './dashboard';
import {
  handlePairConsume,
  handlePairCreate,
} from './dashboard-pair';
import {
  handleFixtureSnapshot,
  handleFixtureSse,
} from './fixtures';
import {
  handleWriteRoute,
  isWriteAction,
} from './writes';
import {
  handleCreateEnsemble,
  handleListAgentTypes,
  handleListLineups,
} from './catalog';
import { handleAsk, handleAnswer } from './qa';
import { handleCoatCheckPut, handleCoatCheckGet } from './coat-check';
import {
  DAEMON_PORT_PATH,
  removePortFile,
  writePortFileAtomic,
} from './port-file';
import { errorResponse, jsonResponse } from './responses';
import { snapshotActionCounters, withActionSource } from '../utils/action-counters';
import {
  buildEnsembleSnapshot,
  EnsembleNotFoundError,
} from './snapshot';
import { handleOrphans } from './orphans';
import {
  ConnectionCap,
  DEFAULT_MAX_CONNECTIONS,
  handleSseRequest,
} from './sse-handler';
import type { HealthV1 } from './event-types';

const log = (...args: unknown[]) =>
  console.error(`[agent-tempo:http ${new Date().toISOString()}]`, ...args);

/** Default bind addr per SSE-PROTOCOL.md §1. */
export const DEFAULT_BIND_ADDR = '127.0.0.1';
/**
 * Default port — `t-e-m-p-o` mnemonic for prod (8473), `+1` for dev (8474).
 * ADR 0014 §5.1 flips this with the rest of the dev profile so prod and dev
 * daemons can coexist on the same machine without binding the same port.
 *
 * Evaluated at module load time. The dev daemon child process inherits
 * `AGENT_TEMPO_DEV_MODE=1` from its parent CLI (set by the
 * `dev-mode-bootstrap` side-effect), so by the time this module loads,
 * `isDevMode()` already returns the correct value.
 */
export const DEFAULT_PORT = isDevMode() ? DEV_DAEMON_PORT : PROD_DAEMON_PORT;

export interface HttpServerOptions {
  client: TempoClient;
  namespace: string;
  /**
   * Shared task queue the daemon's workers poll. Surfaced verbatim on
   * `GET /v1/health` so the dashboard's Settings → Connection panel
   * reflects the runtime queue (#444).
   */
  taskQueue: string;
  version: string;
  /** Defaults to `process.env[ENV.HTTP_BIND] || '127.0.0.1'`. */
  bindAddr?: string;
  /**
   * Defaults to `Number(process.env[ENV.DAEMON_PORT]) || DEFAULT_PORT` —
   * where {@link DEFAULT_PORT} is `8473` in production and `8474` in dev
   * mode (ADR 0014 §5.1). `0` → ephemeral.
   */
  port?: number;
  /** Defaults to parsing `process.env[ENV.CORS_ORIGINS]`. */
  allowedOrigins?: string[];
  /**
   * Override the port-file path. Tests pass an isolated temp path so they
   * don't fight production daemons running on the same machine.
   */
  portFilePath?: string;
  /**
   * @deprecated 3e — back-compat alias for {@link readToken}. A single injected
   * bearer is treated as the READ token (T1). Prefer `readToken`/`adminToken`.
   */
  httpToken?: string;
  /** 3e — inject the read-tier (T1) token directly (tests). Overrides config/env. */
  readToken?: string;
  /** 3e — inject the admin (T1+T2+T3) token directly (tests). Overrides env. */
  adminToken?: string;
  /**
   * Test seam — lets unit tests stub `process.uptime`-style readings.
   */
  startedAtMs?: number;
  /**
   * Aggregate poll loop + per-ensemble buses. When provided, the
   * server lights up `/v1/events/:ensemble` and `/v1/events` (PR-2).
   * When absent, those routes return `503 streaming-not-implemented`
   * (PR-1 behavior).
   */
  aggregate?: AggregateRunner;
  /**
   * Process-wide SSE connection cap. Defaults to
   * `Number(process.env[ENV.SSE_MAX_CONNECTIONS]) || 100`. Set to a
   * low value in tests to exercise the 503 path.
   */
  maxSseConnections?: number;
  /**
   * 3c Tier-2 — the inner-loop fine-tail registry (off-wire SSE sink) and the
   * ingest-token registry (source-plane auth). When both are provided the
   * `/v1/players/:e/:p/inner` egress + `/inner/ingest` + `/inner/presence`
   * ingress routes light up; absent → those routes 404/503. The daemon
   * constructs + shares these (the outbox mints ingest tokens into the same
   * `ingestTokens` instance the server validates against).
   */
  innerLoop?: InnerLoopRegistry;
  ingestTokens?: IngestTokenRegistry;
}

export interface HttpServerHandle {
  /** The actual port the server is listening on (after `.listen()` resolves). */
  readonly port: number;
  /** The actual bind address. */
  readonly bindAddr: string;
  /**
   * Subscriber count — always `0` in PR-1; PR-2 wires this to the live
   * SSE subscriber set. Exposed for the `/v1/health` payload.
   */
  readonly subscriberCount: () => number;
  /** Drain + close the listener. Removes the port file. */
  close(): Promise<void>;
}

/**
 * Start the HTTP server. Resolves once the listener is bound and the
 * port file has been written.
 */
export async function startHttpServer(opts: HttpServerOptions): Promise<HttpServerHandle> {
  const bindAddr = opts.bindAddr ?? process.env[ENV.HTTP_BIND] ?? DEFAULT_BIND_ADDR;
  const portEnv = process.env[ENV.DAEMON_PORT];
  const port = opts.port ?? (portEnv != null && portEnv !== '' ? Number(portEnv) : DEFAULT_PORT);
  if (!Number.isInteger(port) || port < 0 || port > 65535) {
    throw new Error(`Invalid HTTP port: ${port}`);
  }

  const allowedOrigins =
    opts.allowedOrigins ?? parseCorsOrigins(process.env[ENV.CORS_ORIGINS]);
  const corsConfig: CorsConfig = { allowedOrigins };

  // Bearer token resolution: if bind addr is non-loopback, force token
  // generation now so the daemon doesn't crash mid-request when the first
  // bearer-required call shows up.
  const bindIsLoopback = isLoopbackBindAddr(bindAddr);
  // 3e RBAC token resolution. Back-compat: a single `httpToken` option (or a
  // legacy config.json `httpToken`) is adopted as the READ token (T1); the ADMIN
  // token is env-var-only. Explicit `readToken`/`adminToken` options override
  // (used by tests). loopback bind ⇒ no bearer required ⇒ tokens may be null.
  let readToken: string | null;
  let legacyMigrated = false;
  if (opts.readToken !== undefined) {
    readToken = opts.readToken;
  } else if (opts.httpToken !== undefined) {
    // Back-compat: a single injected bearer is treated as the READ token (T1).
    readToken = opts.httpToken;
  } else {
    const loaded = loadReadToken({ bearerRequired: !bindIsLoopback });
    readToken = loaded.token;
    legacyMigrated = loaded.legacy;
  }
  const adminToken = opts.adminToken ?? loadAdminToken();
  if (!bindIsLoopback && !readToken) {
    throw new Error(
      'Bearer token required for non-loopback bind but none configured. ' +
      'Set AGENT_TEMPO_HTTP_READ_TOKEN (or readToken in ~/.agent-tempo/config.json), ' +
      'or unset AGENT_TEMPO_HTTP_BIND.',
    );
  }
  // 3e MD-E — one-time startup warnings (non-blocking).
  //
  // (1) Legacy migration: a pre-3e single `httpToken` was adopted as the READ
  //     token (T1) and no admin token is configured, so writes / inner-tail
  //     (all Tier ≥ 2) will 503 until an admin token is set.
  if (legacyMigrated && adminToken === null) {
    log(
      'NOTICE: adopted legacy config.json `httpToken` as the read-tier token. ' +
      'Writes and the inner-tail are admin-only and will return ' +
      '503 until you set AGENT_TEMPO_HTTP_ADMIN_TOKEN (env-var only).',
    );
  }
  // (2) Plaintext-bearer exposure: binding to a non-loopback address serves the
  //     bearer token over cleartext HTTP. Suppressible, never blocking.
  if (!bindIsLoopback && process.env[ENV.TLS_ACKNOWLEDGED] !== '1') {
    log(
      `WARNING: binding to non-loopback ${bindAddr} serves the bearer token over ` +
      'plaintext HTTP. Terminate TLS at a reverse proxy, or tunnel via SSH/Tailscale. ' +
      `Set ${ENV.TLS_ACKNOWLEDGED}=1 to acknowledge and suppress this warning.`,
    );
  }

  const startedAt = opts.startedAtMs ?? Date.now();
  // §7.3 process-wide cap. Defaults to 100 per spec; env var override.
  const capLimitEnv = process.env[ENV.SSE_MAX_CONNECTIONS];
  const capLimit =
    opts.maxSseConnections ??
    (capLimitEnv != null && capLimitEnv !== '' ? Number(capLimitEnv) : DEFAULT_MAX_CONNECTIONS);
  if (!Number.isInteger(capLimit) || capLimit < 1) {
    throw new Error(`Invalid SSE max connections: ${capLimit}`);
  }
  const sseConnectionCap = new ConnectionCap(capLimit);
  // Subscriber count = aggregate's live SSE subscribers. Falls back to
  // 0 when no aggregate (PR-1 server, no SSE).
  const subscriberCount = () =>
    opts.aggregate ? opts.aggregate.totalSubscriberCount() : 0;

  const server = http.createServer((req, res) =>
    handle(req, res, {
      client: opts.client,
      namespace: opts.namespace,
      taskQueue: opts.taskQueue,
      version: opts.version,
      bindAddr,
      corsConfig,
      readToken,
      adminToken,
      startedAt,
      subscriberCount,
      aggregate: opts.aggregate ?? null,
      sseConnectionCap,
      innerLoop: opts.innerLoop ?? null,
      ingestTokens: opts.ingestTokens ?? null,
    }).catch((err) => {
      log('unhandled handler error:', err instanceof Error ? err.message : err);
      if (!res.headersSent) {
        try {
          errorResponse(res, 500, { error: 'internal-error' });
        } catch { /* socket already closed */ }
      } else {
        try { res.end(); } catch { /* ignore */ }
      }
    }),
  );

  // Defensive: per-connection timeout so a wedged client can't hold a
  // socket indefinitely on the daemon. Snapshot endpoints respond fast;
  // PR-2 will need a much longer / disabled timeout for SSE streams.
  server.requestTimeout = 30_000;
  server.headersTimeout = 35_000;
  // TCP keepalive — matches §1 contract.
  server.keepAliveTimeout = 60_000;

  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, bindAddr, () => {
      server.removeListener('error', reject);
      resolve();
    });
  });

  const address = server.address();
  const boundPort =
    typeof address === 'object' && address ? address.port : port;

  // Port file → atomic write so a racing reader never sees a half-written
  // value. Skip write if the caller asked for ephemeral binding without a
  // port-file override (tests).
  const portFilePath = opts.portFilePath ?? DAEMON_PORT_PATH;
  try {
    await writePortFileAtomic(portFilePath, boundPort);
    log(`listening on http://${bindAddr}:${boundPort} (port file: ${portFilePath})`);
  } catch (err) {
    log('failed to write port file (non-fatal):', err instanceof Error ? err.message : err);
  }

  // Track open sockets so `close()` can force-close them after a graceful
  // window — Node's `server.close()` only stops accepting new connections.
  const sockets = new Set<import('net').Socket>();
  server.on('connection', (socket) => {
    sockets.add(socket);
    socket.on('close', () => sockets.delete(socket));
  });

  return {
    port: boundPort,
    bindAddr,
    subscriberCount,
    async close(): Promise<void> {
      // Stop accepting new connections immediately, then give live sockets
      // a 5 s window to drain before destroying them.
      const closing = new Promise<void>((resolve) => {
        server.close(() => resolve());
      });
      const drainDeadline = setTimeout(() => {
        for (const s of sockets) s.destroy();
      }, 5_000);
      drainDeadline.unref();
      try { await closing; } finally { clearTimeout(drainDeadline); }
      removePortFile(portFilePath);
      log('server closed');
    },
  };
}

// ── Request handling ─────────────────────────────────────────────────────

interface HandleContext {
  client: TempoClient;
  namespace: string;
  taskQueue: string;
  version: string;
  bindAddr: string;
  corsConfig: CorsConfig;
  /** 3e RBAC read-tier token (T1), or null. */
  readToken: string | null;
  /** 3e RBAC admin token (T1+T2+T3) — env-var-only, or null when unset. */
  adminToken: string | null;
  startedAt: number;
  subscriberCount: () => number;
  /** Present when PR-2 streaming is wired; null on PR-1-only deployments. */
  aggregate: AggregateRunner | null;
  /** Process-wide SSE subscriber cap (§7.3). */
  sseConnectionCap: ConnectionCap;
  /** 3c Tier-2 inner-loop fine-tail sink (off-wire) — null when unwired. */
  innerLoop: InnerLoopRegistry | null;
  /** 3c Tier-2 ingest-token registry (source-plane auth) — null when unwired. */
  ingestTokens: IngestTokenRegistry | null;
}

/**
 * Top-level request dispatcher — exported for unit tests that want to
 * exercise the handler without spinning up a real listener.
 */
export async function handle(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  ctx: HandleContext,
): Promise<void> {
  const method = (req.method ?? 'GET').toUpperCase();
  const url = new URL(req.url ?? '/', `http://${ctx.bindAddr}`);
  const pathname = url.pathname;

  // CORS preflight short-circuit. Always answer OPTIONS — even in
  // loopback mode — with `204 No Content` and the static headers, so
  // browsers performing a preflight against a loopback dashboard get a
  // clean answer.
  if (method === 'OPTIONS') {
    return handleOptions(req, res, ctx);
  }

  // Health is always reachable, never authenticated, never CORS-gated.
  if (method === 'GET' && pathname === '/v1/health') {
    return handleHealth(res, ctx);
  }

  // Pre-auth carve-out for the cross-device pairing-token consume endpoint
  // (see docs/design/340-web-dashboard.md §4.1). The token IS the auth —
  // single-use, 5-min TTL, opaque base64url. Real pair flow lands here
  // in PR-8 of #340.
  //
  // Regex is intentionally tight — `[^/]+` rejects extra path segments and
  // (after URL-parser normalisation) traversal attempts; both fall through
  // to the post-auth `/dashboard/api/*` 404.
  const pairConsumeMatch = pathname.match(/^\/dashboard\/api\/pair\/([^/]+)$/);
  if (method === 'GET' && pairConsumeMatch) {
    return handlePairConsume(req, res, pairConsumeMatch[1]);
  }

  // 3c Tier-2 INGRESS (publisher → daemon). Matched BEFORE the outer bearer
  // gate: these use their OWN source-plane auth (loopback `socket.remoteAddress`
  // + `X-Ingest-Token` vs the URL workflowId), so a localhost Pi subprocess
  // reaches them regardless of the daemon's bind address. Only live when the
  // daemon wired the registries; else they fall through to the 404/405 path.
  if (ctx.innerLoop && ctx.ingestTokens) {
    const innerDeps = { innerLoop: ctx.innerLoop, ingestTokens: ctx.ingestTokens };
    const ingestMatch = pathname.match(/^\/v1\/players\/([^/]+)\/([^/]+)\/inner\/ingest$/);
    if (ingestMatch) {
      if (method !== 'POST') {
        return errorResponse(res, 405, { error: 'method-not-allowed' }, { Allow: 'POST' });
      }
      return handleInnerIngest(req, res, innerDeps, decodeURIComponent(ingestMatch[1]), decodeURIComponent(ingestMatch[2]));
    }
    const presenceMatch = pathname.match(/^\/v1\/players\/([^/]+)\/([^/]+)\/inner\/presence$/);
    if (presenceMatch) {
      if (method !== 'GET') {
        return errorResponse(res, 405, { error: 'method-not-allowed' }, { Allow: 'GET' });
      }
      return handleInnerPresence(req, res, innerDeps, decodeURIComponent(presenceMatch[1]), decodeURIComponent(presenceMatch[2]));
    }
  }

  // Layer 2 — shared AUTHENTICATION + Origin/DNS-rebind defense (architect's
  // decomposition). bearerRequired() carries the Origin-rebind logic; a request
  // in bearer mode must present a token granting at LEAST a tier (read or admin).
  // This is the single shared upstream pass — the per-route TIER authorization
  // (Layer 3, `gateTier(N)` / inline `requireTier(3)`) refines it below: reads → T1,
  // writes/pair-mint → T2 (admin), the /inner tail → T3 (admin).
  const originHeader = headerString(req.headers.origin);
  const reqBearer = bearerRequired(ctx.bindAddr, originHeader);
  if (reqBearer) {
    const provided = extractBearerToken(headerString(req.headers.authorization));
    if (!provided || tierForToken(provided, ctx) === 0) {
      writeCorsHeaders(res, originHeader, ctx, reqBearer);
      return errorResponse(res, 401, { error: 'unauthorized' });
    }
  }

  // CORS allowlist check (only enforced in bearer mode).
  const cors = evaluateOrigin(originHeader, ctx.corsConfig, reqBearer);
  if (!cors.allowed) {
    return errorResponse(res, 403, { error: 'origin-not-allowed' });
  }
  if (cors.echo) {
    res.setHeader('Access-Control-Allow-Origin', cors.echo);
    res.setHeader('Vary', 'Origin');
  }

  // Layer 3 — per-route AUTHORIZATION (3e MD-E). The tier-guard input is
  // resolved ONCE here off the shared L2 pass (bindAddr + Origin + the two
  // RBAC tokens) and reused by every `gateTier(N)` call below — reads require
  // T1, the write/pair-mint surface requires T2 (admin). The grandfathered T3
  // /inner egress site (3c) keeps its own inline `requireTier(3)` by design.
  //
  // This is defense-in-depth ON TOP of the L2 token-validity floor above (which
  // already rejects an unrecognized bearer with 401): the explicit per-route
  // guard keeps each surface protected at its declared tier even if the L2 floor
  // is later relaxed, and makes the required tier self-documenting + greppable.
  const tierInput: TierGuardInput = {
    bindAddr: ctx.bindAddr,
    originHeader,
    authHeader: headerString(req.headers.authorization),
    readToken: ctx.readToken,
    adminToken: ctx.adminToken,
  };
  /**
   * Write a tier-denial response, surfacing requireTier's actionable `detail`
   * hint on 403 (insufficient-tier) / 503 (admin-unset) when present (3e ruling
   * #3). The hint is operator guidance — e.g. "set AGENT_TEMPO_HTTP_ADMIN_TOKEN"
   * — NOT a sensitive leak (security-confirmed). Shared by `gateTier` and the
   * inline T3 /inner egress site so every tier denial carries the same body shape.
   */
  const denyTier = (r: Exclude<TierGuardResult, { ok: true }>): void => {
    errorResponse(
      res,
      r.status,
      'detail' in r ? { error: r.error, detail: r.detail } : { error: r.error },
    );
  };
  /**
   * Apply a per-route tier guard against the L2-resolved input. On failure it
   * writes the 401/403/503 response and returns `false` (caller returns); on
   * success returns `true`. Loopback requests short-circuit to PASS inside
   * {@link requireTier} (local-trust → full tier).
   */
  const gateTier = (n: Tier): boolean => {
    const g = requireTier(n, tierInput);
    if (g.ok) return true;
    denyTier(g);
    return false;
  };

  // #700 P2 — Q&A ask/answer routes. Matched BEFORE the generic 2-segment
  // writeMatch below (which would otherwise 404 `/ask` as an unknown write
  // action). `ask` is a write (Tier 2); `answer` is a read (covered by the
  // global bearer/loopback gate already applied upstream).
  const askMatch = pathname.match(/^\/v1\/ensembles\/([^/]+)\/ask$/);
  if (askMatch) {
    const ensemble = decodeURIComponent(askMatch[1]);
    if (!gateTier(2)) return; // write
    if (method !== 'POST') {
      return errorResponse(res, 405, { error: 'method-not-allowed' }, { Allow: 'POST, OPTIONS' });
    }
    return handleAsk(req, res, ctx.client, ctx.aggregate, ensemble);
  }
  const answerMatch = pathname.match(/^\/v1\/ensembles\/([^/]+)\/answer\/([^/]+)$/);
  if (answerMatch) {
    const ensemble = decodeURIComponent(answerMatch[1]);
    const questionId = decodeURIComponent(answerMatch[2]);
    // Read-tier gate (T1) — answer content is per-player data; enforce the read
    // bearer per-route like every other GET (/v1/ensembles, /hosts, /orphans, …).
    // Without this, a non-loopback bind (LAN/Tailscale) would serve answers with
    // no auth. (greenfield review catch.)
    if (!gateTier(1)) return;
    if (method !== 'GET') {
      return errorResponse(res, 405, { error: 'method-not-allowed' }, { Allow: 'GET, OPTIONS' });
    }
    return handleAnswer(res, ctx.client, ensemble, questionId);
  }

  // #713 — coat-check HTTP routes. The POST (2-segment) MUST be matched BEFORE
  // the generic writeMatch below, which would otherwise 404 `coat-check` as an
  // unknown write action. Both are Tier 2 (admin): `put` is a write; `get`
  // REDEEMS via a maestro Update that bumps fetch-audit counters (not a pure read).
  const coatCheckPutMatch = pathname.match(/^\/v1\/ensembles\/([^/]+)\/coat-check$/);
  if (coatCheckPutMatch) {
    const ensemble = decodeURIComponent(coatCheckPutMatch[1]);
    if (!gateTier(2)) return; // write
    if (method !== 'POST') {
      return errorResponse(res, 405, { error: 'method-not-allowed' }, { Allow: 'POST, OPTIONS' });
    }
    return handleCoatCheckPut(req, res, ctx.client, ensemble);
  }
  const coatCheckGetMatch = pathname.match(/^\/v1\/ensembles\/([^/]+)\/coat-check\/([^/]+)$/);
  if (coatCheckGetMatch) {
    const ensemble = decodeURIComponent(coatCheckGetMatch[1]);
    const ticket = decodeURIComponent(coatCheckGetMatch[2]);
    if (!gateTier(2)) return; // redeem mutates fetch-audit counters → Tier 2
    if (method !== 'GET') {
      return errorResponse(res, 405, { error: 'method-not-allowed' }, { Allow: 'GET, OPTIONS' });
    }
    return handleCoatCheckGet(res, ctx.client, ensemble, ticket);
  }

  // Write surface (PR-7a of #340) — POST `/v1/ensembles/:ensemble/<action>`
  // Match BEFORE the GET-only method gate; everything else (POST to a
  // read endpoint, GET to a write endpoint) flows into the 405 fallback
  // below with the right `Allow` header.
  const writeMatch = pathname.match(/^\/v1\/ensembles\/([^/]+)\/([^/]+)$/);
  if (writeMatch) {
    const ensemble = decodeURIComponent(writeMatch[1]);
    const action = writeMatch[2];
    if (isWriteAction(action)) {
      // L3 — the mutate surface is admin-only (Tier 2). Gate before the method
      // check so an under-privileged caller can't probe the write verbs via 405.
      if (!gateTier(2)) return;
      if (method !== 'POST') {
        return errorResponse(res, 405, { error: 'method-not-allowed' }, { Allow: 'POST, OPTIONS' });
      }
      return handleWriteRoute(req, res, ctx.client, ensemble, action);
    }
    // Unknown action under /v1/ensembles/:e/<x> → 404 (don't 405; the
    // path simply isn't a known endpoint).
    return errorResponse(res, 404, { error: 'not-found' });
  }

  // Create-ensemble route (issue #400) — POST `/v1/ensembles`. Sits
  // alongside the writeMatch above so it's reached before the GET-only
  // gate; the GET on the same path (list ensembles) is handled below.
  if (pathname === '/v1/ensembles' && method === 'POST') {
    if (!gateTier(2)) return; // L3 — create-ensemble is a write (Tier 2).
    return handleCreateEnsemble(req, res, ctx.client);
  }

  // POST `/dashboard/api/pair` — mint a pairing for cross-device QR (PR-8
  // of #340). Sits AFTER the bearer-auth gate so the operator on the host
  // proves authority before issuing a token; the token's GET-side consume
  // is the carve-out above the auth gate.
  if (method === 'POST' && pathname === '/dashboard/api/pair') {
    // L3 — minting a cross-device pairing token is an admin operation (Tier 2):
    // it grants a bearer-equivalent capability, so it must require the admin token.
    if (!gateTier(2)) return;
    const provided = extractBearerToken(headerString(req.headers.authorization));
    return handlePairCreate(req, res, provided);
  }

  // Method gate — read endpoints are GET-only. Both POST paths above
  // (PR-7a writes, PR-8 pair-mint) handle their own method matching;
  // everything else falls through here.
  if (method !== 'GET') {
    return errorResponse(res, 405, { error: 'method-not-allowed' }, { Allow: 'GET, OPTIONS' });
  }

  // Static dashboard SPA (PR-1 of #340). Sits behind the bearer-auth gate
  // so non-loopback binds (LAN, Tailscale) require the same bearer the
  // `/v1/*` API uses. The pre-auth pair-token carve-out above is the
  // single exception that bootstraps cross-device pairing.
  if (pathname === '/dashboard' || pathname.startsWith('/dashboard/')) {
    if (!gateTier(1)) return; // L3 — the dashboard SPA is read-tier (Tier 1).
    return handleDashboardStatic(req, res, pathname);
  }

  if (pathname === '/v1/ensembles') {
    if (!gateTier(1)) return; // L3 — read (Tier 1).
    return handleListEnsembles(res, ctx);
  }

  if (pathname === '/v1/hosts') {
    if (!gateTier(1)) return; // L3 — read (Tier 1).
    return handleHosts(res, ctx);
  }

  // #579 — cluster-wide cross-host orphan listing for the dashboard.
  // Same bearer + CORS gate as `/v1/hosts`; optional `?ensemble=<name>`
  // narrows to one ensemble.
  if (pathname === '/v1/orphans') {
    if (!gateTier(1)) return; // L3 — read (Tier 1).
    const ensembleFilter = url.searchParams.get('ensemble') ?? undefined;
    return handleOrphans(res, {
      client: ctx.client,
      // os.hostname() is OS-cached + sub-millisecond — no need to thread
      // through HandleContext just for one rendering site.
      dashboardHost: require('os').hostname(),
    }, ensembleFilter);
  }

  // Catalog reads (issue #400) — `listAgentTypes` / `listLineups`
  // touch local fs only, no Temporal calls; cheap to serve per-request.
  if (pathname === '/v1/agent-types') {
    if (!gateTier(1)) return; // L3 — read (Tier 1).
    return handleListAgentTypes(res);
  }
  if (pathname === '/v1/lineups') {
    if (!gateTier(1)) return; // L3 — read (Tier 1).
    return handleListLineups(res);
  }

  // #753 — per-source Temporal action counters for the DAEMON process
  // (maestro / aggregate / outbox / schedule / reconcile sources live
  // here; adapter and Pi processes self-report via their periodic
  // `[agent-tempo:action-counters]` log line instead). Pure in-memory
  // read — zero Temporal calls.
  if (pathname === '/v1/debug/action-counters') {
    if (!gateTier(1)) return; // L3 — read (Tier 1).
    return handleActionCounters(res);
  }

  // /v1/state/:ensemble — single capture group.
  const stateMatch = pathname.match(/^\/v1\/state\/([^/]+)$/);
  if (stateMatch) {
    if (!gateTier(1)) return; // L3 — read (Tier 1); covers the fixture path too.
    const ensemble = decodeURIComponent(stateMatch[1]);
    // Fixture mode (PR-3 of #340) — `?fixture=<name>` short-circuits the
    // live snapshot with canned data. Sits behind the bearer-auth gate.
    const fixtureName = url.searchParams.get('fixture');
    if (fixtureName) {
      return handleFixtureSnapshot(res, fixtureName);
    }
    return handleState(res, ctx, ensemble);
  }

  // /v1/events* (SSE). Dispatch to the SSE handler when an aggregate
  // is wired; otherwise stay on the PR-1 503 placeholder so the route
  // signals "feature exists, not yet wired" rather than "ensemble
  // doesn't exist".
  if (pathname === '/v1/events') {
    if (!gateTier(1)) return; // L3 — read/observe stream (Tier 1).
    if (!ctx.aggregate) {
      return errorResponse(res, 503, { error: 'streaming-not-implemented' }, { 'Retry-After': '60' });
    }
    // T0.4/#751 (#763) — first-subscriber wake: if the cloud-profile
    // demand gate stretched the poll, snap back + tick immediately so a
    // fresh board doesn't wait out the idle reconcile interval.
    ctx.aggregate.wake();
    return handleSseRequest(req, res, {
      client: ctx.client,
      bus: ctx.aggregate.globalBus(),
      emitSnapshot: false,
      cap: ctx.sseConnectionCap,
    });
  }
  const evtMatch = pathname.match(/^\/v1\/events\/([^/]+)$/);
  if (evtMatch) {
    if (!gateTier(1)) return; // L3 — read/observe stream (Tier 1); covers fixture too.
    const ensemble = decodeURIComponent(evtMatch[1]);
    // Fixture mode (PR-3 of #340) — `?fixture=<name>` short-circuits both
    // the existence check and the aggregate poll loop with a canned event
    // sequence. Sits behind the bearer-auth gate.
    const fixtureName = url.searchParams.get('fixture');
    if (fixtureName) {
      return handleFixtureSse(req, res, fixtureName);
    }
    if (!ctx.aggregate) {
      return errorResponse(res, 503, { error: 'streaming-not-implemented' }, { 'Retry-After': '60' });
    }
    // Validate existence before opening the SSE stream — clean 404 when
    // the ensemble was never live, instead of an empty stream.
    //
    // #673 — `listEnsembles` is a Temporal VISIBILITY query (eventually
    // consistent; ~seconds behind on Temporal Cloud), so immediately after
    // `up`/creation the just-started maestro hub isn't indexed yet and this
    // gate would 404 — which the subscribe client classes as PERMANENT, leaving
    // the TUI stuck on "Loading messages…". Before 404'ing, fall back to a
    // STRONGLY-CONSISTENT describe of the maestro hub (`ensembleExists`): a
    // RUNNING hub means the ensemble is live even if visibility hasn't caught up.
    const list = await ctx.client.listEnsembles().catch(() => []);
    if (!list.find((e) => e.name === ensemble)) {
      const existsStrong = await ctx.client.ensembleExists(ensemble).catch(() => false);
      if (!existsStrong) {
        return errorResponse(res, 404, { error: 'ensemble-not-found', ensemble });
      }
    }
    const bus = ctx.aggregate.getOrCreateEnsembleBus(ensemble);
    // T0.4/#751 (#763) — first-subscriber wake (see the global route above).
    ctx.aggregate.wake();
    return handleSseRequest(req, res, {
      client: ctx.client,
      bus,
      emitSnapshot: true,
      ensemble,
      cap: ctx.sseConnectionCap,
    });
  }

  // 3c Tier-2 EGRESS — operator/widget inner-loop SSE fine tail. After the outer
  // bearer gate (so it's already authenticated); the explicit `requireTier(3)`
  // marks the tier for 3e (today the outer bearer already satisfied it — 3e
  // relaxes the outer gate to a read token and this guard demands the admin
  // token, no call-site change). View-agnostic: bearer-keyed, NO Origin
  // requirement, plain `event:`/`data:` framing (fetch + Node-client consumable).
  const innerSseMatch = pathname.match(/^\/v1\/players\/([^/]+)\/([^/]+)\/inner$/);
  if (innerSseMatch) {
    if (!ctx.innerLoop || !ctx.ingestTokens) {
      return errorResponse(res, 503, { error: 'streaming-not-implemented' }, { 'Retry-After': '60' });
    }
    const tier = requireTier(3, {
      bindAddr: ctx.bindAddr,
      originHeader,
      authHeader: headerString(req.headers.authorization),
      readToken: ctx.readToken,
      adminToken: ctx.adminToken,
    });
    if (!tier.ok) { denyTier(tier); return; }
    return handleInnerSse(
      req, res,
      { innerLoop: ctx.innerLoop, ingestTokens: ctx.ingestTokens },
      decodeURIComponent(innerSseMatch[1]),
      decodeURIComponent(innerSseMatch[2]),
    );
  }

  return errorResponse(res, 404, { error: 'not-found' });
}

/** Pull a single string from a possibly-array header. */
function headerString(v: string | string[] | undefined): string | undefined {
  if (Array.isArray(v)) return v[0];
  return v;
}

/**
 * Apply CORS response headers when bearer mode is active. Used by
 * paths that bypass the main route flow (e.g. 401 short-circuit) so
 * the browser still sees a CORS-compliant response.
 */
function writeCorsHeaders(
  res: http.ServerResponse,
  originHeader: string | undefined,
  ctx: HandleContext,
  bearerActive: boolean,
): void {
  if (!bearerActive) return;
  const cors = evaluateOrigin(originHeader, ctx.corsConfig, bearerActive);
  if (cors.echo) {
    res.setHeader('Access-Control-Allow-Origin', cors.echo);
    res.setHeader('Vary', 'Origin');
  }
}

function handleOptions(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  ctx: HandleContext,
): void {
  const originHeader = headerString(req.headers.origin);
  const bearerActive = bearerRequired(ctx.bindAddr, originHeader);
  const cors = evaluateOrigin(originHeader, ctx.corsConfig, bearerActive);

  // Origin rejected → 403, no ACAO header (browser will block fetch).
  if (!cors.allowed) {
    res.writeHead(403, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end('CORS: origin not allowed');
    return;
  }

  const headers: Record<string, string> = { ...corsResponseHeaders() };
  if (cors.echo) headers['Access-Control-Allow-Origin'] = cors.echo;
  res.writeHead(204, headers);
  res.end();
}

function handleHealth(res: http.ServerResponse, ctx: HandleContext): void {
  // #336 — sample process memory at request time. `process.memoryUsage()`
  // is synchronous + cheap (~microseconds), safe inside a request handler.
  const mem = process.memoryUsage();
  const body: HealthV1 = {
    ok: true,
    namespace: ctx.namespace,
    taskQueue: ctx.taskQueue,
    version: ctx.version,
    uptimeMs: Math.max(0, Date.now() - ctx.startedAt),
    ensembleCount: 0, // populated below
    subscriberCount: ctx.subscriberCount(),
    memory: {
      rss: mem.rss,
      heapTotal: mem.heapTotal,
      heapUsed: mem.heapUsed,
      external: mem.external,
      arrayBuffers: mem.arrayBuffers,
    },
  };
  // Best-effort ensemble count — soft-fail to 0 rather than 500ing on a
  // healthcheck. `/v1/health` MUST stay reachable even when Temporal is
  // wedged; supervisord depends on it.
  ctx.client
    .listEnsembles()
    .then((list) => {
      body.ensembleCount = list.length;
      jsonResponse(res, 200, body);
    })
    .catch(() => {
      jsonResponse(res, 200, body);
    });
}

async function handleListEnsembles(
  res: http.ServerResponse,
  ctx: HandleContext,
): Promise<void> {
  const list = await ctx.client.listEnsembles();
  jsonResponse(res, 200, list);
}

async function handleHosts(
  res: http.ServerResponse,
  ctx: HandleContext,
): Promise<void> {
  // The 3 s cache lives inside `listHosts`; we don't add another layer.
  const hosts = await ctx.client.listHosts();
  jsonResponse(res, 200, hosts);
}

/**
 * #753 — daemon-process per-source Temporal action counters. Pure in-memory
 * read (zero Temporal calls); adapter and Pi processes self-report via their
 * periodic `[agent-tempo:action-counters]` log line instead.
 */
function handleActionCounters(res: http.ServerResponse): void {
  jsonResponse(res, 200, snapshotActionCounters());
}

async function handleState(
  res: http.ServerResponse,
  ctx: HandleContext,
  ensemble: string,
): Promise<void> {
  try {
    // #753 — the on-demand snapshot fans out the same queries as the
    // aggregate poll; meter it under the same source.
    const snapshot = await withActionSource('aggregate', () =>
      buildEnsembleSnapshot(ctx.client, ensemble));
    jsonResponse(res, 200, snapshot);
  } catch (err) {
    if (err instanceof EnsembleNotFoundError) {
      return errorResponse(res, 404, { error: 'ensemble-not-found', ensemble });
    }
    throw err;
  }
}
