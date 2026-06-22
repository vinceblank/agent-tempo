/**
 * Daemon HTTP `/v1/orphans` route — #579.
 *
 * Coverage (per architect's brief test matrix):
 *   1. Handler happy-path — 2 candidates, one preferredHost matching a live
 *      `HostInfo`, one missing-from-hosts → correct `hostLiveness` join.
 *   2. `?ensemble=<name>` filter forwards to `TempoClient.listAllOrphans`.
 *   3. Partial-tolerance — `listAllOrphans` returns N candidates but the
 *      handler-side join still serves a 200 even if a candidate's
 *      `attachmentInfo.currentAttachment` is absent (no
 *      `lastHeartbeatAt` to project).
 *   4. Bearer auth — non-loopback bind without token → 401; with token → 200.
 *   5. `migrateCommand` rendering (positional player+host; `--yes-steal=`
 *      flag form when `preferredHost` is null).
 */
import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import * as path from 'path';
import * as fs from 'fs';
import * as os from 'os';
import { startHttpServer, type HttpServerHandle } from '../../src/http/server';
import type { TempoClient } from '../../src/client/interface';
import type { HostInfo, AttachmentPhase } from '../../src/types';
import type { OrphanCandidate } from '../../src/reconcile/orphans';
import { renderMigrateCommand, buildOrphanRow } from '../../src/http/orphans';

interface CallLog { method: string; args: unknown[] }

function makeOrphan(p: {
  workflowId: string;
  playerId: string;
  ensemble: string;
  preferredHost?: string | null;
  phase?: AttachmentPhase;
  detachedSince?: string;
  lastHeartbeatAt?: string;
  lastAdapterHost?: string;
}): OrphanCandidate {
  return {
    workflowId: p.workflowId,
    info: {
      phase: p.phase ?? 'detached',
      inFlightCount: 0,
      ...(p.lastHeartbeatAt
        ? {
            currentAttachment: {
              attachmentId: 'att-' + p.workflowId,
              hostname: p.lastAdapterHost ?? 'host-A',
              adapterId: 'claude-code',
              adapterClass: 'interactive',
              claimedAt: '2026-05-16T00:00:00.000Z',
              lastHeartbeatAt: p.lastHeartbeatAt,
              expiresAt: '2026-05-16T00:01:00.000Z',
              leaseMs: 60_000,
              runId: 'run-' + p.workflowId,
            },
          }
        : {}),
    },
    summary: {
      ensemble: p.ensemble,
      playerId: p.playerId,
      ...(p.detachedSince ? { detachedSince: p.detachedSince } : {}),
      ...(p.preferredHost !== undefined ? { preferredHost: p.preferredHost ?? undefined } : {}),
      ...(p.lastAdapterHost
        ? { lastAdapter: { hostname: p.lastAdapterHost, adapterId: 'claude-code' } }
        : {}),
    },
  };
}

function makeHost(name: string, freshness: 'live' | 'stale' = 'live'): HostInfo {
  return {
    hostname: name,
    instances: [],
    recruitReady: freshness === 'live',
    freshness,
    profileStaleness: 'missing',
  };
}

interface MockOptions {
  orphans?: OrphanCandidate[];
  hosts?: HostInfo[];
}

function makeMockClient(opts: MockOptions = {}): { client: TempoClient; calls: CallLog[] } {
  const calls: CallLog[] = [];
  const handler = (method: string, defaultReturn: unknown) =>
    async (...args: unknown[]) => {
      calls.push({ method, args });
      return defaultReturn;
    };
  const base = {
    listAllOrphans: handler('listAllOrphans', opts.orphans ?? []),
    listHosts: handler('listHosts', opts.hosts ?? []),
  };
  const proxy = new Proxy(base as Record<string, unknown>, {
    get(target, prop: string) {
      if (prop in target) return target[prop];
      return () => { throw new Error(`unstubbed TempoClient.${prop}`); };
    },
  });
  return { client: proxy as unknown as TempoClient, calls };
}

let tmpDir: string;
beforeAll(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ct-orphans-'));
});

interface Bootstrapped {
  handle: HttpServerHandle;
  url: string;
  calls: CallLog[];
}
let booted: Bootstrapped[] = [];
afterEach(async () => {
  for (const b of booted) {
    try { await b.handle.close(); } catch { /* ignore */ }
  }
  booted = [];
});

async function boot(opts: MockOptions = {}, serverOpts: { bindAddr?: string; httpToken?: string; allowedOrigins?: string[] } = {}): Promise<Bootstrapped> {
  const { client, calls } = makeMockClient(opts);
  const portFile = path.join(tmpDir, `daemon-${process.hrtime.bigint().toString(36)}.port`);
  const handle = await startHttpServer({
    client,
    namespace: 'default',
    taskQueue: 'agent-tempo-test',
    version: '0.28.0-test',
    bindAddr: serverOpts.bindAddr ?? '127.0.0.1',
    port: 0,
    portFilePath: portFile,
    ...(serverOpts.httpToken ? { readToken: serverOpts.httpToken } : {}),
    ...(serverOpts.allowedOrigins ? { allowedOrigins: serverOpts.allowedOrigins } : {}),
  });
  const b: Bootstrapped = { handle, url: `http://${handle.bindAddr}:${handle.port}`, calls };
  booted.push(b);
  return b;
}

// ── Pure-helper coverage (no listener) ─────────────────────────────────────

describe('renderMigrateCommand', () => {
  it('renders positional player+host when preferredHost is known', () => {
    expect(renderMigrateCommand({
      playerId: 'tempo-eng',
      preferredHost: 'host-A',
      dashboardHost: 'host-B',
      lastAdapterHost: 'host-A',
    })).toBe('/migrate tempo-eng host-A');
  });

  it('falls back to --force --yes-steal=<lastKnown> when preferredHost is null', () => {
    expect(renderMigrateCommand({
      playerId: 'tempo-eng',
      preferredHost: null,
      dashboardHost: 'host-B',
      lastAdapterHost: 'host-A',
    })).toBe('/migrate tempo-eng host-B --force --yes-steal=host-A');
  });

  it('substitutes (unknown) when even lastAdapterHost is null', () => {
    expect(renderMigrateCommand({
      playerId: 'orphan-x',
      preferredHost: null,
      dashboardHost: 'host-B',
      lastAdapterHost: null,
    })).toBe('/migrate orphan-x host-B --force --yes-steal=(unknown)');
  });
});

describe('buildOrphanRow', () => {
  const dashboardHost = 'host-D';
  it('joins liveness from the hosts map', () => {
    const candidate = makeOrphan({
      workflowId: 'agent-session-jam-alice', playerId: 'alice', ensemble: 'jam',
      preferredHost: 'host-A', phase: 'detached', detachedSince: '2026-05-16T00:00:00.000Z',
    });
    const hostsByName = new Map([['host-A', makeHost('host-A', 'live')]]);
    const row = buildOrphanRow({ candidate, hostsByName, dashboardHost });
    expect(row.playerId).toBe('alice');
    expect(row.workflowId).toBe('agent-session-jam-alice');
    expect(row.preferredHost).toBe('host-A');
    expect(row.hostLiveness).toBe('live');
    expect(row.phase).toBe('detached');
    expect(row.detachedSince).toBe('2026-05-16T00:00:00.000Z');
    expect(row.migrateCommand).toBe('/migrate alice host-A');
  });

  it('reports stale liveness when the matching host is stale', () => {
    const candidate = makeOrphan({
      workflowId: 'w1', playerId: 'alice', ensemble: 'jam', preferredHost: 'host-A',
    });
    const hostsByName = new Map([['host-A', makeHost('host-A', 'stale')]]);
    expect(buildOrphanRow({ candidate, hostsByName, dashboardHost }).hostLiveness).toBe('stale');
  });

  it('reports missing liveness when preferredHost is absent from hosts snapshot', () => {
    const candidate = makeOrphan({
      workflowId: 'w1', playerId: 'alice', ensemble: 'jam', preferredHost: 'host-Gone',
    });
    const hostsByName = new Map([['host-A', makeHost('host-A', 'live')]]);
    expect(buildOrphanRow({ candidate, hostsByName, dashboardHost }).hostLiveness).toBe('missing');
  });

  it('reports missing liveness when preferredHost is null', () => {
    const candidate = makeOrphan({
      workflowId: 'w1', playerId: 'orphan', ensemble: 'jam', preferredHost: null,
      lastAdapterHost: 'host-Gone',
    });
    const hostsByName = new Map([['host-A', makeHost('host-A', 'live')]]);
    const row = buildOrphanRow({ candidate, hostsByName, dashboardHost });
    expect(row.preferredHost).toBeNull();
    expect(row.hostLiveness).toBe('missing');
    expect(row.migrateCommand).toBe('/migrate orphan host-D --force --yes-steal=host-Gone');
  });
});

// ── Endpoint coverage (real listener, mocked TempoClient) ──────────────────

describe('GET /v1/orphans', () => {
  it('happy-path: 2 candidates, joined liveness, capturedAt present', async () => {
    const orphans = [
      makeOrphan({ workflowId: 'w1', playerId: 'alice', ensemble: 'jam', preferredHost: 'host-A' }),
      makeOrphan({ workflowId: 'w2', playerId: 'bob', ensemble: 'jam', preferredHost: 'host-Gone' }),
    ];
    const hosts = [makeHost('host-A', 'live')];
    const b = await boot({ orphans, hosts });
    const res = await fetch(`${b.url}/v1/orphans`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { v: number; capturedAt: string; orphans: Array<{ playerId: string; hostLiveness: string }> };
    expect(body.v).toBe(1);
    expect(body.capturedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    expect(body.orphans).toHaveLength(2);
    expect(body.orphans.find((o) => o.playerId === 'alice')?.hostLiveness).toBe('live');
    expect(body.orphans.find((o) => o.playerId === 'bob')?.hostLiveness).toBe('missing');
  });

  it('forwards ?ensemble=<name> to TempoClient.listAllOrphans', async () => {
    const b = await boot({ orphans: [], hosts: [] });
    await fetch(`${b.url}/v1/orphans?ensemble=jam`);
    const call = b.calls.find((c) => c.method === 'listAllOrphans');
    expect(call).toBeDefined();
    expect((call!.args[0] as { ensemble?: string }).ensemble).toBe('jam');
  });

  it('serves 200 with rows when an orphan candidate has no currentAttachment (partial-tolerance projection)', async () => {
    // queryOrphanedSessions itself drops unreachable candidates; the handler
    // must still serve a 200 when remaining candidates lack
    // `info.currentAttachment` (lastHeartbeatAt → null) — no throw, no 500.
    const orphans = [
      makeOrphan({ workflowId: 'w1', playerId: 'alice', ensemble: 'jam', preferredHost: 'host-A' /* no lastHeartbeatAt */ }),
      makeOrphan({ workflowId: 'w2', playerId: 'bob', ensemble: 'jam', preferredHost: 'host-A', lastHeartbeatAt: '2026-05-16T00:00:00.000Z' }),
    ];
    const b = await boot({ orphans, hosts: [makeHost('host-A', 'live')] });
    const res = await fetch(`${b.url}/v1/orphans`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { orphans: Array<{ playerId: string; lastHeartbeatAt: string | null }> };
    expect(body.orphans).toHaveLength(2);
    expect(body.orphans.find((o) => o.playerId === 'alice')?.lastHeartbeatAt).toBeNull();
    expect(body.orphans.find((o) => o.playerId === 'bob')?.lastHeartbeatAt).toBe('2026-05-16T00:00:00.000Z');
  });

  it('rejects unauthenticated requests when a bearer token is configured', async () => {
    // Loopback bind: bearer-required gate flips on a non-loopback Origin
    // (DNS-rebind defense, §3). Bearer-pass test allowlists the same
    // Origin so CORS doesn't pre-empt the auth check (mirrors
    // tests/http/server.test.ts:270-279).
    const b = await boot(
      { orphans: [], hosts: [] },
      { httpToken: 'secret', allowedOrigins: ['https://dashboard.example.com'] },
    );
    const resAnon = await fetch(`${b.url}/v1/orphans`, {
      headers: { origin: 'https://evil.example' },
    });
    expect(resAnon.status).toBe(401);
    const resAuth = await fetch(`${b.url}/v1/orphans`, {
      headers: {
        origin: 'https://dashboard.example.com',
        authorization: 'Bearer secret',
      },
    });
    expect(resAuth.status).toBe(200);
  });
});
