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
 *   2. Server binds to `127.0.0.1:8473` (defaults overridable via
 *      `CLAUDE_TEMPO_HTTP_BIND` / `CLAUDE_TEMPO_DAEMON_PORT`).
 *   3. The bound port is written atomically to `~/.claude-tempo/daemon.port`.
 *   4. Caller `await`s {@link HttpServerHandle.close} on shutdown — drains
 *      in-flight requests, removes the port file, then resolves.
 */
import * as http from 'http';
import type { TempoClient } from '../client/interface';
import { ENV } from '../config';
import {
  bearerRequired,
  extractBearerToken,
  isLoopbackBindAddr,
  loadOrGenerateHttpToken,
  tokensMatch,
} from './auth';
import {
  corsResponseHeaders,
  evaluateOrigin,
  parseCorsOrigins,
  type CorsConfig,
} from './cors';
import {
  DAEMON_PORT_PATH,
  removePortFile,
  writePortFileAtomic,
} from './port-file';
import { errorResponse, jsonResponse } from './responses';
import {
  buildEnsembleSnapshot,
  EnsembleNotFoundError,
} from './snapshot';
import type { HealthV1 } from './event-types';

const log = (...args: unknown[]) =>
  console.error(`[claude-tempo:http ${new Date().toISOString()}]`, ...args);

/** Default bind addr per SSE-PROTOCOL.md §1. */
export const DEFAULT_BIND_ADDR = '127.0.0.1';
/** Default port — `t-e-m-p-o` mnemonic; not IANA-registered. */
export const DEFAULT_PORT = 8473;

export interface HttpServerOptions {
  client: TempoClient;
  namespace: string;
  version: string;
  /** Defaults to `process.env[ENV.HTTP_BIND] || '127.0.0.1'`. */
  bindAddr?: string;
  /** Defaults to `Number(process.env[ENV.DAEMON_PORT]) || 8473`. `0` → ephemeral. */
  port?: number;
  /** Defaults to parsing `process.env[ENV.CORS_ORIGINS]`. */
  allowedOrigins?: string[];
  /**
   * Override the port-file path. Tests pass an isolated temp path so they
   * don't fight production daemons running on the same machine.
   */
  portFilePath?: string;
  /**
   * Inject the bearer token directly. Production callers pass `undefined`
   * so the server reads/auto-generates from `~/.claude-tempo/config.json`.
   */
  httpToken?: string;
  /**
   * Test seam — lets unit tests stub `process.uptime`-style readings.
   */
  startedAtMs?: number;
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
  const httpToken =
    opts.httpToken ?? loadOrGenerateHttpToken({ bearerRequired: !bindIsLoopback });
  if (!bindIsLoopback && !httpToken) {
    throw new Error(
      'Bearer token required for non-loopback bind but none configured. ' +
      'Set httpToken in ~/.claude-tempo/config.json or unset CLAUDE_TEMPO_HTTP_BIND.',
    );
  }

  const startedAt = opts.startedAtMs ?? Date.now();
  // PR-1: no SSE infrastructure → subscriber count is hard-coded zero.
  // PR-2 swaps this for the live `EnsembleEventBus` subscriber set.
  const subscriberCount = () => 0;

  const server = http.createServer((req, res) =>
    handle(req, res, {
      client: opts.client,
      namespace: opts.namespace,
      version: opts.version,
      bindAddr,
      corsConfig,
      httpToken,
      startedAt,
      subscriberCount,
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
  version: string;
  bindAddr: string;
  corsConfig: CorsConfig;
  httpToken: string | null;
  startedAt: number;
  subscriberCount: () => number;
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

  // Authentication gate.
  const originHeader = headerString(req.headers.origin);
  const reqBearer = bearerRequired(ctx.bindAddr, originHeader);
  if (reqBearer) {
    const provided = extractBearerToken(headerString(req.headers.authorization));
    if (!provided || !ctx.httpToken || !tokensMatch(provided, ctx.httpToken)) {
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

  // Method gate — every snapshot endpoint is GET-only.
  if (method !== 'GET') {
    return errorResponse(res, 405, { error: 'method-not-allowed' }, { Allow: 'GET, OPTIONS' });
  }

  if (pathname === '/v1/ensembles') {
    return handleListEnsembles(res, ctx);
  }

  if (pathname === '/v1/hosts') {
    return handleHosts(res, ctx);
  }

  // /v1/state/:ensemble — single capture group.
  const stateMatch = pathname.match(/^\/v1\/state\/([^/]+)$/);
  if (stateMatch) {
    const ensemble = decodeURIComponent(stateMatch[1]);
    return handleState(res, ctx, ensemble);
  }

  // /v1/events* (SSE) — defined in spec but PR-1 doesn't ship streaming.
  // Return a clear "not implemented yet" so consumers don't conflate this
  // with "ensemble doesn't exist".
  if (pathname === '/v1/events' || pathname.startsWith('/v1/events/')) {
    return errorResponse(res, 503, { error: 'streaming-not-implemented' }, { 'Retry-After': '60' });
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
  const body: HealthV1 = {
    ok: true,
    namespace: ctx.namespace,
    version: ctx.version,
    uptimeMs: Math.max(0, Date.now() - ctx.startedAt),
    ensembleCount: 0, // populated below
    subscriberCount: ctx.subscriberCount(),
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

async function handleState(
  res: http.ServerResponse,
  ctx: HandleContext,
  ensemble: string,
): Promise<void> {
  try {
    const snapshot = await buildEnsembleSnapshot(ctx.client, ensemble);
    jsonResponse(res, 200, snapshot);
  } catch (err) {
    if (err instanceof EnsembleNotFoundError) {
      return errorResponse(res, 404, { error: 'ensemble-not-found', ensemble });
    }
    throw err;
  }
}
