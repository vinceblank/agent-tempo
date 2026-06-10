/**
 * End-to-end tests for the daemon HTTP server. Boots a real listener on
 * an ephemeral loopback port, hits the snapshot endpoints with `fetch`,
 * and asserts the wire contract from `docs/SSE-PROTOCOL.md`.
 *
 * No SSE coverage in PR-1 — `/v1/events*` returns 503.
 */
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach } from 'vitest';
import { startHttpServer, type HttpServerHandle } from '../../src/http/server';
import {
  recordAction,
  withActionSource,
  __resetActionCountersForTests,
} from '../../src/utils/action-counters';
import type { TempoClient } from '../../src/client/interface';
import type { HealthV1, EnsembleStateV1 } from '../../src/http/event-types';
import type { MaestroPlayerInfo, HostInfo } from '../../src/types';

// ── Test fixtures ────────────────────────────────────────────────────────

const samplePlayer: MaestroPlayerInfo = {
  playerId: 'tempo-eng',
  ensemble: 'demo',
  part: 'fixing things',
  hostname: 'eng-host',
  workDir: '/repo',
  isConductor: false,
  agentType: 'claude',
  phase: 'attached',
};

const sampleHost: HostInfo = {
  hostname: 'eng-host',
  instances: [{
    pid: 1, version: '0.27.0', identity: 'agent-tempo:eng-host:1:0.27.0',
    lastAccessTime: '2026-04-26T12:00:00.000Z',
    hasWorkflowWorker: true, hasActivityWorker: true, hasHostQueueWorker: true,
  }],
  recruitReady: true,
  freshness: 'live',
  profile: {
    hostname: 'eng-host', version: '0.27.0', defaultAgent: 'claude',
    platform: 'linux', capabilities: [],
  },
  profileStaleness: 'fresh',
};

function makeFakeClient(over: Partial<TempoClient> = {}): TempoClient {
  const base: Partial<TempoClient> = {
    async listEnsembles() {
      return [{ name: 'demo', playerCount: 1, hasConductor: true, state: 'online' }];
    },
    async getPlayers() { return [samplePlayer]; },
    async getEnsembleChat() {
      return { messages: [], total: 0, hasMore: false, hasConductor: true };
    },
    async getSchedules() { return []; },
    async isMaestroPaused() { return false; },
    async isAnySessionHeld() { return false; },
    async listHosts() { return [sampleHost]; },
    // Issue #399 DB1a — sentinel defaults so server tests don't need
    // to stub the new fan-out methods unless they exercise them.
    async getEnsembleMeta() {
      return { description: '', startedAt: '', currentBpm: 0, tempoSeries: [] };
    },
    async getPlayerWireMeta() { return null; },
  };
  // Cast through unknown — fields not in `over` and not in `base` will throw
  // if any handler reaches them, which is the right behaviour: PR-1 must
  // not depend on TempoClient methods outside the snapshot surface.
  return new Proxy({ ...base, ...over }, {
    get(target: Record<string, unknown>, prop: string) {
      if (prop in target) return target[prop];
      return () => { throw new Error(`unstubbed TempoClient.${String(prop)}`); };
    },
  }) as unknown as TempoClient;
}

// ── Spin-up helper ───────────────────────────────────────────────────────

interface Bootstrapped {
  handle: HttpServerHandle;
  url: string;
  portFile: string;
}

let tmpDir: string;
beforeAll(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ct-http-'));
});
afterAll(() => {
  try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch { /* ignore */ }
});

let booted: Bootstrapped[] = [];
afterEach(async () => {
  for (const b of booted) {
    try { await b.handle.close(); } catch { /* ignore */ }
  }
  booted = [];
});

async function boot(opts: {
  client?: TempoClient;
  bindAddr?: string;
  httpToken?: string;
  allowedOrigins?: string[];
} = {}): Promise<Bootstrapped> {
  const portFile = path.join(tmpDir, `daemon-${process.hrtime.bigint().toString(36)}.port`);
  const handle = await startHttpServer({
    client: opts.client ?? makeFakeClient(),
    namespace: 'default',
    taskQueue: 'agent-tempo-test',
    version: '0.27.0-test',
    bindAddr: opts.bindAddr ?? '127.0.0.1',
    port: 0, // ephemeral
    httpToken: opts.httpToken,
    allowedOrigins: opts.allowedOrigins,
    portFilePath: portFile,
  });
  const b: Bootstrapped = {
    handle,
    url: `http://${handle.bindAddr}:${handle.port}`,
    portFile,
  };
  booted.push(b);
  return b;
}

// ── Tests ────────────────────────────────────────────────────────────────

describe('startHttpServer — port file lifecycle', () => {
  it('writes the bound port to the port file on listen, removes on close', async () => {
    const b = await boot();
    expect(fs.readFileSync(b.portFile, 'utf8')).toBe(String(b.handle.port));
    await b.handle.close();
    booted = booted.filter((x) => x !== b);
    expect(fs.existsSync(b.portFile)).toBe(false);
  });
});

describe('GET /v1/health', () => {
  it('returns the §4.1 shape and is never authenticated', async () => {
    const b = await boot();
    const res = await fetch(`${b.url}/v1/health`);
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toMatch(/^application\/json/);
    const body = await res.json() as HealthV1;
    expect(body.ok).toBe(true);
    expect(body.namespace).toBe('default');
    // #444 — taskQueue surfaced so the dashboard can reflect the live runtime
    // queue (e.g. `agent-tempo` vs `agent-tempo-dev`) instead of a default.
    expect(body.taskQueue).toBe('agent-tempo-test');
    expect(body.version).toBe('0.27.0-test');
    expect(body.subscriberCount).toBe(0);
    expect(body.ensembleCount).toBe(1);
    expect(typeof body.uptimeMs).toBe('number');
    expect(body.uptimeMs).toBeGreaterThanOrEqual(0);
  });
  it('still returns 200 when listEnsembles fails (degrades to count=0)', async () => {
    const client = makeFakeClient({
      async listEnsembles() { throw new Error('temporal down'); },
    });
    const b = await boot({ client });
    const res = await fetch(`${b.url}/v1/health`);
    expect(res.status).toBe(200);
    const body = await res.json() as HealthV1;
    expect(body.ok).toBe(true);
    expect(body.ensembleCount).toBe(0);
  });
});

describe('GET /v1/ensembles', () => {
  it('returns the listEnsembles array verbatim', async () => {
    const b = await boot();
    const res = await fetch(`${b.url}/v1/ensembles`);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(Array.isArray(body)).toBe(true);
    expect(body[0]).toMatchObject({ name: 'demo', state: 'online', hasConductor: true });
  });
});

describe('GET /v1/state/:ensemble', () => {
  it('returns the EnsembleStateV1 snapshot with the PR-1 sentinel', async () => {
    const b = await boot();
    const res = await fetch(`${b.url}/v1/state/demo`);
    expect(res.status).toBe(200);
    const body = await res.json() as EnsembleStateV1;
    expect(body.v).toBe(1);
    expect(body.ensemble).toBe('demo');
    expect(body.lastEventId).toBe('0:0');
    expect(body.players).toHaveLength(1);
    expect(body.hostProfiles).toHaveProperty('eng-host');
  });
  it('returns 404 ensemble-not-found for unknown ensembles', async () => {
    const b = await boot();
    const res = await fetch(`${b.url}/v1/state/missing`);
    expect(res.status).toBe(404);
    const body = await res.json();
    expect(body).toEqual({ error: 'ensemble-not-found', ensemble: 'missing' });
  });
  it('decodes URL-encoded ensemble names', async () => {
    const client = makeFakeClient({
      async listEnsembles() {
        return [{ name: 'a/b c', playerCount: 0, hasConductor: false, state: 'online' as const }];
      },
      async getPlayers() { return []; },
      async getEnsembleChat() {
        return { messages: [], total: 0, hasMore: false, hasConductor: false };
      },
    });
    const b = await boot({ client });
    const res = await fetch(`${b.url}/v1/state/${encodeURIComponent('a/b c')}`);
    expect(res.status).toBe(200);
    const body = await res.json() as EnsembleStateV1;
    expect(body.ensemble).toBe('a/b c');
  });
});

describe('GET /v1/hosts', () => {
  it('returns the listHosts array', async () => {
    const b = await boot();
    const res = await fetch(`${b.url}/v1/hosts`);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body[0].hostname).toBe('eng-host');
  });
});

describe('GET /v1/debug/action-counters (#753)', () => {
  it('serves the in-memory per-source snapshot', async () => {
    __resetActionCountersForTests();
    try {
      withActionSource('maestro', () => recordAction('query'));
      recordAction('list', 'aggregate');
      const b = await boot();
      const res = await fetch(`${b.url}/v1/debug/action-counters`);
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.total).toBe(2);
      expect(body.bySource.maestro).toEqual({ query: 1, total: 1 });
      expect(body.bySource.aggregate).toEqual({ list: 1, total: 1 });
      expect(Date.parse(body.sinceIso)).not.toBeNaN();
    } finally {
      __resetActionCountersForTests();
    }
  });

  it('is GET-only', async () => {
    const b = await boot();
    const res = await fetch(`${b.url}/v1/debug/action-counters`, { method: 'POST' });
    expect(res.status).toBe(405);
  });
});

describe('routing edges', () => {
  it('returns 404 for unknown paths', async () => {
    const b = await boot();
    const res = await fetch(`${b.url}/v1/nope`);
    expect(res.status).toBe(404);
    const body = await res.json();
    expect(body).toEqual({ error: 'not-found' });
  });
  it('returns 503 streaming-not-implemented for /v1/events*', async () => {
    const b = await boot();
    const res = await fetch(`${b.url}/v1/events`);
    expect(res.status).toBe(503);
    expect(res.headers.get('retry-after')).toBe('60');
    const r2 = await fetch(`${b.url}/v1/events/demo`);
    expect(r2.status).toBe(503);
  });
  it('returns 405 method-not-allowed on a POST to a still-GET-only path', async () => {
    // POST /v1/ensembles is the create-ensemble route as of issue #400.
    // /v1/hosts is still GET-only, so it pins the method-gate behaviour.
    const b = await boot();
    const res = await fetch(`${b.url}/v1/hosts`, { method: 'POST' });
    expect(res.status).toBe(405);
    expect(res.headers.get('allow')).toBe('GET, OPTIONS');
  });
  it('handles OPTIONS preflight on loopback (no auth, but still answers)', async () => {
    const b = await boot();
    const res = await fetch(`${b.url}/v1/state/demo`, { method: 'OPTIONS' });
    expect(res.status).toBe(204);
    expect(res.headers.get('access-control-allow-methods')).toBe('GET, OPTIONS');
  });
});

describe('bearer auth (forced via non-loopback Origin on loopback bind)', () => {
  it('rejects with 401 when bearer is required but token mismatches', async () => {
    // Loopback bind, but Origin is non-loopback → bearer required (DNS rebind defense).
    const b = await boot({ httpToken: 'good-token' });
    const res = await fetch(`${b.url}/v1/ensembles`, {
      headers: { origin: 'https://evil.com' },
    });
    expect(res.status).toBe(401);
  });
  it('accepts the request when the bearer matches', async () => {
    const b = await boot({ httpToken: 'good-token', allowedOrigins: ['https://dashboard.example.com'] });
    const res = await fetch(`${b.url}/v1/ensembles`, {
      headers: {
        origin: 'https://dashboard.example.com',
        authorization: 'Bearer good-token',
      },
    });
    expect(res.status).toBe(200);
    expect(res.headers.get('access-control-allow-origin')).toBe('https://dashboard.example.com');
  });
  it('rejects a non-allowlisted Origin with 403 (after passing bearer)', async () => {
    const b = await boot({
      httpToken: 'good-token',
      allowedOrigins: ['https://dashboard.example.com'],
    });
    const res = await fetch(`${b.url}/v1/ensembles`, {
      headers: { origin: 'https://other.example.com', authorization: 'Bearer good-token' },
    });
    expect(res.status).toBe(403);
  });
  it('serves /v1/health without auth even when bearer would otherwise be required', async () => {
    const b = await boot({ httpToken: 'good-token' });
    const res = await fetch(`${b.url}/v1/health`, {
      headers: { origin: 'https://evil.com' },
    });
    expect(res.status).toBe(200);
  });
});
