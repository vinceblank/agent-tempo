/**
 * Daemon HTTP catalog routes — issue #400.
 *
 * Boots a real listener with a mocked TempoClient, then exercises the
 * three new catalog endpoints. The two GETs touch the local
 * filesystem (the daemon's own `examples/` dir, since these tests
 * don't shadow `AGENT_TEMPO_HOME`). The POST flow records every
 * `client.recruit` call so we can assert the conductor + lineup
 * fan-out without a live Temporal namespace.
 */
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { startHttpServer, type HttpServerHandle } from '../../src/http/server';
import type { TempoClient } from '../../src/client/interface';
import type { EnsembleSummary } from '../../src/client/interface';

interface CallLog {
  method: string;
  args: unknown[];
}

interface MockOptions {
  ensembles?: EnsembleSummary[];
  /** Per-method override: throw this error instead of recording. */
  throws?: Partial<Record<string, Error>>;
}

function makeMockClient(opts: MockOptions = {}): { client: TempoClient; calls: CallLog[] } {
  const calls: CallLog[] = [];
  const handler = (method: string, defaultReturn: unknown) =>
    async (...args: unknown[]) => {
      calls.push({ method, args });
      if (opts.throws?.[method]) throw opts.throws[method];
      return defaultReturn;
    };

  const base = {
    listEnsembles: handler('listEnsembles', opts.ensembles ?? []),
    recruit: handler('recruit', { playerId: 'tempo-eng', entryId: 'entry-1' }),
    listHosts: handler('listHosts', []),
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
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ct-catalog-'));
});
afterAll(() => {
  try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch { /* ignore */ }
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

async function boot(opts: MockOptions = {}): Promise<Bootstrapped> {
  const { client, calls } = makeMockClient(opts);
  const portFile = path.join(tmpDir, `daemon-${process.hrtime.bigint().toString(36)}.port`);
  const handle = await startHttpServer({
    client,
    namespace: 'default',
    taskQueue: 'claude-tempo-test',
    version: '0.28.0-test',
    bindAddr: '127.0.0.1',
    port: 0,
    portFilePath: portFile,
  });
  const b: Bootstrapped = { handle, url: `http://${handle.bindAddr}:${handle.port}`, calls };
  booted.push(b);
  return b;
}

async function postJson(url: string, body: unknown): Promise<Response> {
  return fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
}

// ── GET /v1/agent-types ─────────────────────────────────────────────────────

describe('GET /v1/agent-types', () => {
  it('returns the shipped catalog with name + description + source per row', async () => {
    const b = await boot();
    const res = await fetch(`${b.url}/v1/agent-types`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { agentTypes: Array<{ name: string; source: string }> };
    expect(Array.isArray(body.agentTypes)).toBe(true);
    expect(body.agentTypes.length).toBeGreaterThanOrEqual(8);
    // tempo-conductor is always shipped — pin the row shape.
    const conductor = body.agentTypes.find((t) => t.name === 'tempo-conductor');
    expect(conductor).toBeDefined();
    expect(['project', 'user', 'shipped']).toContain(conductor!.source);
  });

  it('does not leak the on-disk path (privacy contract)', async () => {
    const b = await boot();
    const res = await fetch(`${b.url}/v1/agent-types`);
    const body = (await res.json()) as { agentTypes: Array<Record<string, unknown>> };
    for (const row of body.agentTypes) {
      expect(row).not.toHaveProperty('path');
    }
  });
});

// ── GET /v1/lineups ─────────────────────────────────────────────────────────

describe('GET /v1/lineups', () => {
  it('returns the shipped lineup catalog with player counts', async () => {
    const b = await boot();
    const res = await fetch(`${b.url}/v1/lineups`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { lineups: Array<{ name: string; players: number; source: string }> };
    expect(Array.isArray(body.lineups)).toBe(true);
    // Five shipped lineups under examples/ensembles/.
    const shipped = body.lineups.filter((l) => l.source === 'shipped');
    expect(shipped.length).toBeGreaterThanOrEqual(5);
    const devTeam = shipped.find((l) => l.name === 'tempo-dev-team');
    expect(devTeam).toBeDefined();
    expect(devTeam!.players).toBeGreaterThan(0);
  });
});

// ── POST /v1/ensembles ──────────────────────────────────────────────────────

describe('POST /v1/ensembles', () => {
  it('400 missing-field on absent name', async () => {
    const b = await boot();
    const res = await postJson(`${b.url}/v1/ensembles`, {});
    expect(res.status).toBe(400);
    expect((await res.json()).error).toBe('missing-field');
  });

  it('400 invalid-ensemble-name on bad name', async () => {
    const b = await boot();
    const res = await postJson(`${b.url}/v1/ensembles`, { name: 'has spaces' });
    expect(res.status).toBe(400);
    expect((await res.json()).error).toBe('invalid-ensemble-name');
  });

  it('400 invalid-start-mode on unknown startMode', async () => {
    const b = await boot();
    const res = await postJson(`${b.url}/v1/ensembles`, {
      name: 'demo', startMode: 'sideways',
    });
    expect(res.status).toBe(400);
    expect((await res.json()).error).toBe('invalid-start-mode');
  });

  it('400 invalid-lineup when the lineup name does not resolve', async () => {
    const b = await boot();
    const res = await postJson(`${b.url}/v1/ensembles`, {
      name: 'demo', lineup: 'no-such-lineup',
    });
    expect(res.status).toBe(400);
    expect((await res.json()).error).toBe('invalid-lineup');
  });

  it('409 ensemble-exists when an ensemble with that name is already live', async () => {
    const b = await boot({
      ensembles: [{
        name: 'demo', playerCount: 1, hasConductor: true, state: 'online',
      }],
    });
    const res = await postJson(`${b.url}/v1/ensembles`, { name: 'demo' });
    expect(res.status).toBe(409);
    expect((await res.json()).error).toBe('ensemble-exists');
  });

  it('201 with conductor recruit on a fresh ensemble (no lineup)', async () => {
    const b = await boot();
    const res = await postJson(`${b.url}/v1/ensembles`, { name: 'fresh' });
    expect(res.status).toBe(201);
    const body = await res.json();
    expect(body.ensemble).toBe('fresh');
    expect(body.conductorPlayerId).toBe('conductor');
    // recruit was called exactly once (conductor) — no lineup players.
    const recruits = b.calls.filter((c) => c.method === 'recruit');
    expect(recruits).toHaveLength(1);
    const [ensemble, opts] = recruits[0].args as [string, Record<string, unknown>];
    expect(ensemble).toBe('fresh');
    expect(opts.isConductor).toBe(true);
    expect(opts.name).toBe('conductor');
  });

  it('201 fans out to lineup players when a known lineup is supplied', async () => {
    const b = await boot();
    const res = await postJson(`${b.url}/v1/ensembles`, {
      name: 'team', lineup: 'tempo-dev-team',
    });
    expect(res.status).toBe(201);
    const body = await res.json();
    expect(body.lineup).toBe('tempo-dev-team');
    // First recruit is the conductor; subsequent are the lineup
    // players. tempo-dev-team has ≥3 player rows so we expect ≥4
    // total recruits (conductor + players).
    const recruits = b.calls.filter((c) => c.method === 'recruit');
    expect(recruits.length).toBeGreaterThan(1);
    expect((recruits[0].args[1] as Record<string, unknown>).isConductor).toBe(true);
    expect(body.recruitedPlayers).toBe(recruits.length - 1);
  });

  it('startMode=hold passes held: true to every recruit', async () => {
    const b = await boot();
    const res = await postJson(`${b.url}/v1/ensembles`, {
      name: 'paused', startMode: 'hold',
    });
    expect(res.status).toBe(201);
    const recruit = b.calls.find((c) => c.method === 'recruit')!;
    expect((recruit.args[1] as Record<string, unknown>).held).toBe(true);
  });

  it('conductorInstructions is forwarded as initialMessage to the conductor recruit', async () => {
    const b = await boot();
    const res = await postJson(`${b.url}/v1/ensembles`, {
      name: 'guided',
      conductorInstructions: 'Coordinate the dashboard rebuild.',
    });
    expect(res.status).toBe(201);
    const recruit = b.calls.find((c) => c.method === 'recruit')!;
    expect((recruit.args[1] as Record<string, unknown>).initialMessage).toBe(
      'Coordinate the dashboard rebuild.',
    );
  });

  it('500 conductor-recruit-failed when client.recruit throws', async () => {
    const b = await boot({
      throws: { recruit: new Error('temporal unreachable') },
    });
    const res = await postJson(`${b.url}/v1/ensembles`, { name: 'doomed' });
    expect(res.status).toBe(500);
    expect((await res.json()).error).toBe('conductor-recruit-failed');
  });
});
