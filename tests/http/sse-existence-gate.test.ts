/**
 * SSE existence-gate fallback (#673) — GET /v1/events/:ensemble.
 *
 * The gate first checks Temporal VISIBILITY (`listEnsembles`, eventually
 * consistent on Cloud). When that misses (a just-created ensemble not yet
 * indexed), it falls back to a STRONGLY-CONSISTENT `ensembleExists` (maestro-hub
 * describe). Regression for the macOS + Temporal Cloud first-run hang where the
 * gate 404'd a live ensemble → the subscribe client treated 404 as permanent →
 * the TUI stuck on "Loading messages…".
 */
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { describe, it, expect, beforeAll, afterAll, afterEach } from 'vitest';
import { startHttpServer, type HttpServerHandle } from '../../src/http/server';
import { AggregateRunner } from '../../src/http/aggregate';
import type { TempoClient } from '../../src/client/interface';

/** Visibility-MISS client (listEnsembles empty) with a controllable strong check. */
function makeClient(ensembleExists: () => Promise<boolean>): TempoClient {
  const base: Partial<TempoClient> = {
    // Visibility miss — the eventual-consistency window we're simulating.
    async listEnsembles() { return []; },
    ensembleExists,
    // Snapshot surface (used once the gate allows + the stream opens).
    async getPlayers() { return []; },
    async getEnsembleChat() { return { messages: [], total: 0, hasMore: false, hasConductor: false }; },
    async getSchedules() { return []; },
    async isMaestroPaused() { return false; },
    async isAnySessionHeld() { return false; },
    async listHosts() { return []; },
    async getEnsembleMeta() { return { description: '', startedAt: '', currentBpm: 0, tempoSeries: [] }; },
    async getPlayerWireMeta() { return null; },
  };
  return new Proxy(base, {
    get(target: Record<string, unknown>, prop: string) {
      if (prop in target) return target[prop];
      return () => { throw new Error(`unstubbed TempoClient.${String(prop)}`); };
    },
  }) as unknown as TempoClient;
}

let tmpDir: string;
beforeAll(() => { tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ct-sse-gate-')); });
afterAll(() => { try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch { /* ignore */ } });

interface Booted { handle: HttpServerHandle; url: string; aggregate: AggregateRunner; }
let booted: Booted[] = [];
afterEach(async () => {
  for (const b of booted) {
    try { b.aggregate.close(); } catch { /* ignore */ }
    try { await b.handle.close(); } catch { /* ignore */ }
  }
  booted = [];
});

async function boot(ensembleExists: () => Promise<boolean>): Promise<Booted> {
  const client = makeClient(ensembleExists);
  const aggregate = new AggregateRunner({ client, bootEpoch: 1 });
  const portFile = path.join(tmpDir, `daemon-${process.hrtime.bigint().toString(36)}.port`);
  const handle = await startHttpServer({
    client,
    namespace: 'default',
    taskQueue: 'agent-tempo-test',
    version: '0.0.0-test',
    bindAddr: '127.0.0.1',
    port: 0,
    portFilePath: portFile,
    aggregate,
  });
  const b: Booted = { handle, url: `http://${handle.bindAddr}:${handle.port}`, aggregate };
  booted.push(b);
  return b;
}

describe('GET /v1/events/:ensemble — existence-gate fallback (#673)', () => {
  it('404s when BOTH visibility AND the strong maestro-hub check miss (genuinely absent)', async () => {
    const b = await boot(async () => false);
    const res = await fetch(`${b.url}/v1/events/missing`);
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: 'ensemble-not-found', ensemble: 'missing' });
  });

  it('ALLOWS the stream on a visibility miss when the maestro hub is RUNNING (the bug)', async () => {
    const b = await boot(async () => true); // listEnsembles empty, but hub RUNNING
    const ac = new AbortController();
    const res = await fetch(`${b.url}/v1/events/demo`, { signal: ac.signal });
    try {
      // NOT 404 — the strong check rescued the just-created ensemble. The SSE
      // stream opens (200, text/event-stream) instead of the permanent 404 that
      // wedged the TUI.
      expect(res.status).toBe(200);
      expect(res.headers.get('content-type') ?? '').toContain('text/event-stream');
    } finally {
      ac.abort(); // close the stream so the test doesn't hang
    }
  });
});
