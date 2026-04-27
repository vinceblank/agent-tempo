/**
 * End-to-end tests for the daemon's static dashboard handler — PR-1 of #340.
 *
 * Boots a real HTTP listener on an ephemeral loopback port (matching
 * `tests/http/server.test.ts`'s shape), drops a fixture `dashboard/dist`
 * into a temp directory, and exercises the SPA fallback, MIME / cache
 * headers, traversal defence, and the pre-auth `GET /dashboard/api/pair`
 * carve-out (501 stub, real impl in PR-8).
 */
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { startHttpServer, type HttpServerHandle } from '../../src/http/server';
import { __setDashboardDistRootForTests } from '../../src/http/dashboard';
import type { TempoClient } from '../../src/client/interface';

// ── Test fixtures ────────────────────────────────────────────────────────

function makeFakeClient(): TempoClient {
  const base: Partial<TempoClient> = {
    async listEnsembles() { return []; },
    async getPlayers() { return []; },
    async listHosts() { return []; },
  };
  return new Proxy(base, {
    get(target: Record<string, unknown>, prop: string) {
      if (prop in target) return target[prop];
      return () => { throw new Error(`unstubbed TempoClient.${prop}`); };
    },
  }) as unknown as TempoClient;
}

const PLACEHOLDER_HTML =
  '<!doctype html><html><body><div id="root">Dashboard placeholder</div></body></html>';
const PLACEHOLDER_CSS = 'body{color:#E07A5F}';
const PLACEHOLDER_JS = 'console.log("hashed-asset");';

let tmpDir: string;
let distRoot: string;

beforeAll(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ct-dashboard-'));
  distRoot = path.join(tmpDir, 'dist');
  fs.mkdirSync(path.join(distRoot, 'assets'), { recursive: true });
  fs.writeFileSync(path.join(distRoot, 'index.html'), PLACEHOLDER_HTML);
  fs.writeFileSync(path.join(distRoot, 'assets', 'app-deadbeef.js'), PLACEHOLDER_JS);
  fs.writeFileSync(path.join(distRoot, 'assets', 'app-deadbeef.css'), PLACEHOLDER_CSS);

  // Point the production handler at our fixture dir. Restored in afterAll.
  __setDashboardDistRootForTests(distRoot);
});

afterAll(() => {
  __setDashboardDistRootForTests(null);
  try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch { /* ignore */ }
});

interface Bootstrapped {
  handle: HttpServerHandle;
  url: string;
}

let booted: Bootstrapped[] = [];
afterEach(async () => {
  for (const b of booted) {
    try { await b.handle.close(); } catch { /* ignore */ }
  }
  booted = [];
});

async function boot(opts: {
  bindAddr?: string;
  httpToken?: string;
  allowedOrigins?: string[];
} = {}): Promise<Bootstrapped> {
  const portFile = path.join(tmpDir, `daemon-${process.hrtime.bigint().toString(36)}.port`);
  const handle = await startHttpServer({
    client: makeFakeClient(),
    namespace: 'default',
    version: '0.28.0-test',
    bindAddr: opts.bindAddr ?? '127.0.0.1',
    port: 0,
    httpToken: opts.httpToken,
    allowedOrigins: opts.allowedOrigins,
    portFilePath: portFile,
  });
  const b: Bootstrapped = {
    handle,
    url: `http://${handle.bindAddr}:${handle.port}`,
  };
  booted.push(b);
  return b;
}

// ── Tests ────────────────────────────────────────────────────────────────

describe('GET /dashboard/ — index.html', () => {
  it('serves the placeholder index.html with no-cache', async () => {
    const b = await boot();
    const res = await fetch(`${b.url}/dashboard/`);
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toMatch(/^text\/html/);
    expect(res.headers.get('cache-control')).toBe('no-cache');
    const body = await res.text();
    expect(body).toContain('Dashboard placeholder');
  });

  it('serves index.html for `/dashboard` without trailing slash', async () => {
    const b = await boot();
    const res = await fetch(`${b.url}/dashboard`);
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toMatch(/^text\/html/);
    expect(await res.text()).toContain('Dashboard placeholder');
  });
});

describe('SPA fallback', () => {
  it('returns index.html for an arbitrary client-side route', async () => {
    const b = await boot();
    const res = await fetch(`${b.url}/dashboard/some-route`);
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toMatch(/^text\/html/);
    expect(res.headers.get('cache-control')).toBe('no-cache');
    expect(await res.text()).toContain('Dashboard placeholder');
  });

  it('falls back for nested extensionless routes (React Router 7)', async () => {
    const b = await boot();
    const res = await fetch(`${b.url}/dashboard/workspaces/abc/players/xyz`);
    expect(res.status).toBe(200);
    expect(await res.text()).toContain('Dashboard placeholder');
  });
});

describe('Asset MIME + cache headers', () => {
  it('serves hashed JS with application/javascript + immutable cache', async () => {
    const b = await boot();
    const res = await fetch(`${b.url}/dashboard/assets/app-deadbeef.js`);
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toMatch(/^application\/javascript/);
    expect(res.headers.get('cache-control')).toBe('public, max-age=31536000, immutable');
    expect(await res.text()).toBe(PLACEHOLDER_JS);
  });

  it('serves hashed CSS with text/css + immutable cache', async () => {
    const b = await boot();
    const res = await fetch(`${b.url}/dashboard/assets/app-deadbeef.css`);
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toMatch(/^text\/css/);
    expect(res.headers.get('cache-control')).toBe('public, max-age=31536000, immutable');
    expect(await res.text()).toBe(PLACEHOLDER_CSS);
  });

  it('returns a real 404 for missing asset-shaped paths (no SPA fallback)', async () => {
    const b = await boot();
    const res = await fetch(`${b.url}/dashboard/missing.css`);
    expect(res.status).toBe(404);
    expect(res.headers.get('content-type')).toMatch(/^application\/json/);
    const body = await res.json();
    expect(body).toEqual({ error: 'not-found' });
  });
});

describe('Pre-auth pair-token carve-out (PR-8 — real flow)', () => {
  it('GET /dashboard/api/pair/:token returns 410 Gone for unknown tokens', async () => {
    // The real pair flow (PR-8) treats unknown / expired / consumed
    // tokens uniformly as 410 Gone with `pair-token-invalid` so an
    // attacker can't distinguish "never minted" from "already used".
    const b = await boot();
    const res = await fetch(`${b.url}/dashboard/api/pair/abc123`);
    expect(res.status).toBe(410);
    const body = await res.json();
    expect(body).toEqual({ error: 'pair-token-invalid' });
  });

  it('blocks path-traversal attempts (URL normaliser drops `..` segments)', async () => {
    const b = await boot();
    // `fetch()` normalises the path client-side before the request leaves
    // the runtime, so the daemon receives the already-normalised
    // `/dashboard/api/v1/state`. The pair-token regex doesn't match it,
    // and the defence-in-depth in `handleDashboardStatic` (the `/api/*`
    // 404 plus `assertSafePath` containment check) would also reject a
    // literal `..` if a non-normalising client ever delivered one.
    const res = await fetch(`${b.url}/dashboard/api/pair/../v1/state`);
    expect(res.status).toBe(404);
    const body = await res.json();
    expect(body).toEqual({ error: 'not-found' });
  });

  it('rejects extra segments after the token (regex is single-segment)', async () => {
    const b = await boot();
    const res = await fetch(`${b.url}/dashboard/api/pair/abc/extra`);
    expect(res.status).toBe(404);
    const body = await res.json();
    expect(body).toEqual({ error: 'not-found' });
  });

  it('POST /dashboard/api/pair reaches the auth gate (401 when bearer missing)', async () => {
    // Force bearer mode via non-loopback Origin header (DNS-rebind defence).
    // The pair *consume* carve-out is GET-only, so POST falls through to
    // the bearer gate.
    const b = await boot({ httpToken: 'test-token' });
    const res = await fetch(`${b.url}/dashboard/api/pair`, {
      method: 'POST',
      headers: { origin: 'https://evil.com' },
    });
    expect(res.status).toBe(401);
  });
});

describe('Static handler is post-auth on non-loopback origins', () => {
  it('rejects /dashboard/ without bearer when Origin is non-loopback', async () => {
    const b = await boot({
      httpToken: 'test-token',
      allowedOrigins: ['https://dash.example.com'],
    });
    const res = await fetch(`${b.url}/dashboard/`, {
      headers: { origin: 'https://dash.example.com' },
    });
    expect(res.status).toBe(401);
  });

  it('serves /dashboard/ when bearer matches', async () => {
    const b = await boot({
      httpToken: 'test-token',
      allowedOrigins: ['https://dash.example.com'],
    });
    const res = await fetch(`${b.url}/dashboard/`, {
      headers: {
        origin: 'https://dash.example.com',
        authorization: 'Bearer test-token',
      },
    });
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toMatch(/^text\/html/);
  });
});
