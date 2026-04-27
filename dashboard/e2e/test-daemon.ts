/**
 * Lightweight test daemon for Playwright e2e — PR-8 of #340.
 *
 * Pure-Node http server that mirrors just enough of the production
 * surface for the smoke pack:
 *
 *   - Static dashboard at `/dashboard/*` (serves `dashboard/dist/`)
 *   - `POST /dashboard/api/pair` (mints in-memory tokens)
 *   - `GET /dashboard/api/pair/:token` (consumes; 410 on second use)
 *   - `/v1/*` returns 503 — specs that need them use Playwright's
 *     `page.route` to mock those responses
 *
 * **Why NOT import from `../../src/http/server.ts`**: the parent
 * repo's HTTP layer transitively pulls in `@temporalio/*`, the MCP
 * SDK, and other heavy modules. Spawning that chain just to test
 * the dashboard's HTTP surface is wasteful, and it tangles the
 * dashboard's `tsconfig` (`bundler` resolution) with the parent's
 * (`commonjs` + dist build artefacts). A 100-line Node-only mock
 * keeps the e2e spawn under 50 ms and the test daemon resilient to
 * unrelated parent-repo build state.
 *
 * The pair-flow contract (token shape, 5-min TTL, single-use, 410
 * status) mirrors `src/http/dashboard-pair.ts` exactly. If the
 * production handler ever drifts from that contract, the
 * dedicated unit suite (`tests/http/dashboard-pair.test.ts`) will
 * fail first, then this mock can be re-aligned.
 */
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { createReadStream, statSync, type Stats } from 'node:fs';
import { dirname, extname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomBytes } from 'node:crypto';

// ES-module equivalent of `__dirname` — Playwright runs the spec
// file as ESM (TS via @playwright/test's bundled transform), so the
// CommonJS globals aren't defined.
const __dirname_ = dirname(fileURLToPath(import.meta.url));

export interface TestDaemonHandle {
  readonly port: number;
  readonly origin: string;
  close(): Promise<void>;
}

const PAIR_TTL_MS = 5 * 60 * 1000;
const DASHBOARD_DIST = resolve(__dirname_, '..', 'dist');

const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
};

interface PendingPair {
  bearer: string;
  expiresAt: number;
}

export async function bootTestDaemon(): Promise<TestDaemonHandle> {
  const pendingPairs = new Map<string, PendingPair>();

  const server = createServer((req: IncomingMessage, res: ServerResponse) => {
    const method = req.method ?? 'GET';
    const url = new URL(req.url ?? '/', `http://${req.headers.host}`);
    const pathname = url.pathname;

    // Pair-token consume — pre-auth carve-out (mirrors production).
    const consume = pathname.match(/^\/dashboard\/api\/pair\/([^/]+)$/);
    if (method === 'GET' && consume) {
      const token = consume[1];
      const entry = pendingPairs.get(token);
      const now = Date.now();
      if (!entry || entry.expiresAt <= now) {
        if (entry) pendingPairs.delete(token);
        return json(res, 410, { error: 'pair-token-invalid' });
      }
      pendingPairs.delete(token);
      return json(res, 200, { bearer: entry.bearer, expiresAt: entry.expiresAt });
    }

    // Pair-token mint — post-auth.
    if (method === 'POST' && pathname === '/dashboard/api/pair') {
      const auth = req.headers.authorization;
      const match = auth?.match(/^Bearer (.+)$/);
      if (!match) return json(res, 400, { error: 'pair-requires-bearer' });
      const token = randomBytes(32).toString('base64url');
      const expiresAt = Date.now() + PAIR_TTL_MS;
      pendingPairs.set(token, { bearer: match[1], expiresAt });
      return json(res, 201, { token, expiresAt });
    }

    // `/v1/*` 503 — specs mock these via Playwright `page.route`.
    if (pathname.startsWith('/v1/')) {
      return json(res, 503, { error: 'mock-no-temporal' });
    }

    // Static dashboard SPA.
    if (pathname === '/dashboard' || pathname.startsWith('/dashboard/')) {
      return serveStatic(res, pathname);
    }

    json(res, 404, { error: 'not-found' });
  });

  await new Promise<void>((resolveListen) => server.listen(0, '127.0.0.1', () => resolveListen()));
  const address = server.address();
  if (!address || typeof address === 'string') {
    throw new Error('test daemon failed to bind');
  }
  const port = address.port;
  return {
    port,
    origin: `http://127.0.0.1:${port}`,
    async close() {
      await new Promise<void>((resolveClose) => server.close(() => resolveClose()));
    },
  };
}

function json(res: ServerResponse, status: number, body: unknown): void {
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(payload),
    'Cache-Control': 'no-store',
  });
  res.end(payload);
}

function serveStatic(res: ServerResponse, pathname: string): void {
  const relative = pathname.slice('/dashboard'.length);
  // `/dashboard` or `/dashboard/` → index.html
  if (relative === '' || relative === '/') {
    return streamFile(res, join(DASHBOARD_DIST, 'index.html'), '.html');
  }
  const candidate = resolve(DASHBOARD_DIST, '.' + relative);
  // Reject path traversal — `resolve` may have hopped out of DASHBOARD_DIST.
  if (!candidate.startsWith(DASHBOARD_DIST)) {
    return json(res, 404, { error: 'not-found' });
  }
  const ext = extname(relative).toLowerCase();
  const stat = safeStat(candidate);
  if (stat?.isFile()) return streamFile(res, candidate, ext);
  // Asset-shaped missing → 404; extensionless → SPA fallback.
  if (ext) return json(res, 404, { error: 'not-found' });
  return streamFile(res, join(DASHBOARD_DIST, 'index.html'), '.html');
}

function streamFile(res: ServerResponse, filePath: string, ext: string): void {
  const mime = MIME[ext] ?? 'application/octet-stream';
  const cache = ext === '.html' ? 'no-cache' : 'public, max-age=31536000, immutable';
  res.writeHead(200, { 'Content-Type': mime, 'Cache-Control': cache });
  const stream = createReadStream(filePath);
  stream.on('error', () => {
    try {
      res.end();
    } catch {
      /* socket gone */
    }
  });
  stream.pipe(res);
}

function safeStat(p: string): Stats | null {
  try {
    return statSync(p);
  } catch {
    return null;
  }
}
