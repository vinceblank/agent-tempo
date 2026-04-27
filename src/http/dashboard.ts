/**
 * Static-asset handler for the packaged web dashboard (PR-1 of #340).
 *
 * Serves the prebuilt SPA at `/dashboard/*` from `dashboard/dist/`. Wiring
 * lives in {@link ../http/server.ts}; this module is intentionally thin so
 * the routing decisions (pre-auth carve-out vs post-auth dispatch) stay
 * visible at the call site.
 *
 * **Contract**
 *
 * | Path                                | Behaviour                                                   |
 * |-------------------------------------|-------------------------------------------------------------|
 * | `/dashboard` or `/dashboard/`       | Serve `dashboard/dist/index.html`, `Cache-Control: no-cache` |
 * | `/dashboard/<file-with-extension>`  | Serve the file with its MIME type, `immutable` cache; 404 if missing |
 * | `/dashboard/<extensionless-route>`  | SPA fallback to `index.html` (React Router 7 client-side routing) |
 * | `/dashboard/api/*`                  | 404 (reserved for daemon-side dashboard API; pair stub matched earlier) |
 * | `/dashboard/<traversal>` (`..`)     | 404 — `assertSafePath` rejects anything outside `dashboard/dist` |
 *
 * **Cache headers** match the design doc (`docs/design/340-web-dashboard.md` §4.2):
 * - `index.html` → `Cache-Control: no-cache` so dashboard updates ship immediately
 * - hashed assets (`.js`, `.css`, fonts, images) → `Cache-Control: public, max-age=31536000, immutable`
 *
 * The pre-auth `GET /dashboard/api/pair/:token` carve-out (architect §4.1)
 * is matched in `server.ts` before the bearer-auth gate; for PR-1 it returns
 * 501 via {@link handlePairTokenStub}. PR-8 wires the real pair flow.
 */
import { createReadStream, statSync, type Stats } from 'fs';
import { extname, join, resolve } from 'path';
import type { IncomingMessage, ServerResponse } from 'http';
import { assertSafePath } from '../utils/safe-path';
import { errorResponse } from './responses';

/** Repo-relative path from the compiled `dist/` output — the production default. */
export const DASHBOARD_DIST = resolve(__dirname, '..', '..', 'dashboard', 'dist');

/**
 * Mutable dist root used by {@link handleDashboardStatic}. Tests reset
 * this via the `__setDashboardDistRootForTests` hook below; production
 * code never touches it.
 */
let activeDistRoot: string = DASHBOARD_DIST;

/** Long-cache header for hashed Vite output. */
const IMMUTABLE_CACHE = 'public, max-age=31536000, immutable';
/** Short-cache header for `index.html` so SPA updates roll out immediately. */
const HTML_CACHE = 'no-cache';

const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.mjs': 'application/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.map': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.ico': 'image/x-icon',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.ttf': 'font/ttf',
  '.txt': 'text/plain; charset=utf-8',
};

/** Extensions that count as "asset-shaped" — missing files 404 instead of SPA-falling-back. */
const ASSET_EXTENSIONS = new Set(Object.keys(MIME));

/**
 * Serve a request under `/dashboard/*`. The caller in `server.ts` has
 * already URL-parsed the request and gated by prefix, and passes the
 * normalised `pathname` in to avoid a second parse on the hot path.
 */
export function handleDashboardStatic(
  req: IncomingMessage,
  res: ServerResponse,
  pathname: string,
): void {
  const distRoot = activeDistRoot;

  // Strip the `/dashboard` prefix. `/dashboard` or `/dashboard/` ⇒ index.html.
  const relative = pathname.slice('/dashboard'.length);
  if (relative === '' || relative === '/') {
    return serveIndexHtml(res, distRoot);
  }

  // `/dashboard/api/*` is reserved for daemon dashboard API endpoints. The
  // pair-token carve-out is matched earlier in server.ts; anything else
  // under `/api/` is a 404 — never SPA-fall-back, never serve a static
  // file.
  if (relative === '/api' || relative.startsWith('/api/')) {
    return errorResponse(res, 404, { error: 'not-found' });
  }

  // Resolve under `distRoot` and reject any path that escapes the root.
  // The URL parser already normalised `..`, but `assertSafePath` is the
  // canonical traversal guard used elsewhere in the codebase.
  const candidate = resolve(distRoot, '.' + relative);
  try {
    assertSafePath(candidate, [distRoot]);
  } catch {
    return errorResponse(res, 404, { error: 'not-found' });
  }

  const ext = extname(relative).toLowerCase();
  const stat = safeStat(candidate);

  if (stat?.isFile()) {
    return streamFile(res, candidate, ext);
  }

  // No file at that path:
  //   - asset-shaped (has a known extension) ⇒ real 404; never SPA-fall-back
  //     for missing assets, otherwise a missing CSS file silently returns
  //     index.html with content-type text/html and the browser logs MIME
  //     errors.
  //   - extensionless ⇒ SPA fallback to index.html so React Router 7 owns
  //     client-side routing.
  if (ext !== '' && ASSET_EXTENSIONS.has(ext)) {
    return errorResponse(res, 404, { error: 'not-found' });
  }
  return serveIndexHtml(res, distRoot);
}

function serveIndexHtml(res: ServerResponse, distRoot: string): void {
  const indexPath = join(distRoot, 'index.html');
  const stat = safeStat(indexPath);
  if (!stat?.isFile()) {
    return errorResponse(res, 404, { error: 'dashboard-not-built' });
  }
  return streamFile(res, indexPath, '.html');
}

function streamFile(res: ServerResponse, filePath: string, ext: string): void {
  const mime = MIME[ext] ?? 'application/octet-stream';
  const cache = ext === '.html' ? HTML_CACHE : IMMUTABLE_CACHE;
  res.writeHead(200, {
    'Content-Type': mime,
    'Cache-Control': cache,
  });
  const stream = createReadStream(filePath);
  stream.on('error', () => {
    // Headers already written — best we can do is end the response.
    try { res.end(); } catch { /* socket gone */ }
  });
  stream.pipe(res);
}

function safeStat(p: string): Stats | null {
  try { return statSync(p); } catch { return null; }
}

/**
 * Test escape hatch — override the dist root used by
 * {@link handleDashboardStatic}. Pass `null` to restore the production
 * default.
 *
 * **Do not call from production code.** The double-underscore prefix
 * marks this as a test-only hook (see ADR 0006). Used by
 * `tests/http/dashboard-handler.test.ts` to point the handler at a
 * fixture directory without modifying the real `dashboard/dist/`.
 */
export function __setDashboardDistRootForTests(override: string | null): void {
  activeDistRoot = override ?? DASHBOARD_DIST;
}
