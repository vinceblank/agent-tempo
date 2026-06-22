/**
 * End-to-end tests for daemon test-fixture mode — PR-3 of #340.
 *
 * Boots a real HTTP listener on an ephemeral loopback port and hits the
 * fixture endpoints with `fetch`. Verifies the canned snapshot is
 * returned verbatim, unknown fixtures 404, the SSE stream emits the
 * expected event sequence (including the #357 broadcast-collapse
 * fixture), and bearer auth still applies on non-loopback origins.
 */
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { startHttpServer, type HttpServerHandle } from '../../src/http/server';
import { getFixture } from '../../src/http/fixtures';
import type { TempoClient } from '../../src/client/interface';
import type { EnsembleStateV1 } from '../../src/http/event-types';

// ── Test fixtures (the test scaffolding, not to be confused with daemon fixtures) ─

function makeFakeClient(): TempoClient {
  const base: Partial<TempoClient> = {
    async listEnsembles() { return []; },
    async listHosts() { return []; },
  };
  return new Proxy(base, {
    get(target: Record<string, unknown>, prop: string) {
      if (prop in target) return target[prop];
      return () => { throw new Error(`unstubbed TempoClient.${prop}`); };
    },
  }) as unknown as TempoClient;
}

let tmpDir: string;

beforeAll(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ct-fixture-mode-'));
});

afterAll(() => {
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
    taskQueue: 'agent-tempo-test',
    version: '0.28.0-test',
    bindAddr: opts.bindAddr ?? '127.0.0.1',
    port: 0,
    readToken: opts.httpToken,
    allowedOrigins: opts.allowedOrigins,
    portFilePath: portFile,
  });
  const b: Bootstrapped = { handle, url: `http://${handle.bindAddr}:${handle.port}` };
  booted.push(b);
  return b;
}

/** Read an SSE response body until the server closes the connection. */
async function readSseBody(res: Response): Promise<string> {
  const reader = res.body!.getReader();
  const decoder = new TextDecoder();
  let body = '';
  // Cap on bytes so a runaway fixture can't hang the test. The chat-stress
  // fixture is the largest at ~30 KB; 256 KB is comfortable headroom.
  const MAX_BYTES = 256 * 1024;
  while (body.length < MAX_BYTES) {
    const { done, value } = await reader.read();
    if (done) break;
    if (value) body += decoder.decode(value);
  }
  return body;
}

/** Parse SSE frames into `{ id, type, data }` records. */
function parseSseFrames(body: string): { id?: string; type?: string; data?: unknown }[] {
  return body.split('\n\n')
    .filter((chunk) => chunk.trim().length > 0 && !chunk.startsWith(':'))
    .map((chunk) => {
      const out: { id?: string; type?: string; data?: unknown } = {};
      for (const line of chunk.split('\n')) {
        if (line.startsWith('id: ')) out.id = line.slice(4);
        else if (line.startsWith('event: ')) out.type = line.slice(7);
        else if (line.startsWith('data: ')) out.data = JSON.parse(line.slice(6));
      }
      return out;
    });
}

// ── Tests ────────────────────────────────────────────────────────────────

describe('GET /v1/state/:ensemble?fixture=<name>', () => {
  it('returns the canned snapshot verbatim for a known fixture', async () => {
    const b = await boot();
    const res = await fetch(`${b.url}/v1/state/anything?fixture=empty-ensemble`);
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toMatch(/^application\/json/);
    const body = await res.json() as EnsembleStateV1;
    expect(body).toEqual(getFixture('empty-ensemble')!.snapshot);
  });

  it('returns 404 unknown-fixture for an unknown name', async () => {
    const b = await boot();
    const res = await fetch(`${b.url}/v1/state/x?fixture=does-not-exist`);
    expect(res.status).toBe(404);
    const body = await res.json();
    expect(body).toEqual({ error: 'unknown-fixture', fixture: 'does-not-exist' });
  });

  it('ignores the URL ensemble path segment and returns the fixture\'s ensemble', async () => {
    const b = await boot();
    const res = await fetch(`${b.url}/v1/state/totally-different?fixture=single-conductor`);
    expect(res.status).toBe(200);
    const body = await res.json() as EnsembleStateV1;
    expect(body.ensemble).toBe('demo-conductor');
    expect(body.players).toHaveLength(1);
    expect(body.players[0].isConductor).toBe(true);
  });
});

describe('GET /v1/events/:ensemble?fixture=<name>', () => {
  it('emits a snapshot prelude followed by the canned events', async () => {
    const b = await boot();
    const res = await fetch(`${b.url}/v1/events/x?fixture=empty-ensemble`);
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toMatch(/^text\/event-stream/);
    const frames = parseSseFrames(await readSseBody(res));
    // empty-ensemble has 0 events ⇒ exactly one frame: the snapshot prelude.
    expect(frames).toHaveLength(1);
    expect(frames[0].type).toBe('snapshot');
  });

  it('eight-player-broadcast emits 8 chat.appended frames sharing one broadcastId (#357)', async () => {
    const b = await boot();
    const res = await fetch(`${b.url}/v1/events/x?fixture=eight-player-broadcast`);
    expect(res.status).toBe(200);
    const frames = parseSseFrames(await readSseBody(res));
    const chatFrames = frames.filter((f) => f.type === 'chat.appended');
    expect(chatFrames).toHaveLength(8);
    const broadcastIds = new Set(
      chatFrames.map((f) => ((f.data as { payload: { broadcastId?: string } }).payload).broadcastId),
    );
    expect(broadcastIds.size).toBe(1);
    expect([...broadcastIds][0]).toMatch(/^bcast-/);
  });

  it('returns 404 unknown-fixture for an unknown name', async () => {
    const b = await boot();
    const res = await fetch(`${b.url}/v1/events/x?fixture=does-not-exist`);
    expect(res.status).toBe(404);
    const body = await res.json();
    expect(body).toEqual({ error: 'unknown-fixture', fixture: 'does-not-exist' });
  });

  it('sse-reconnect emits a gap event between chat frames', async () => {
    const b = await boot();
    const res = await fetch(`${b.url}/v1/events/x?fixture=sse-reconnect`);
    expect(res.status).toBe(200);
    const frames = parseSseFrames(await readSseBody(res));
    const types = frames.map((f) => f.type);
    expect(types).toContain('gap');
    // Order check — gap shouldn't be the first or last event.
    const gapIdx = types.indexOf('gap');
    expect(gapIdx).toBeGreaterThan(0);
    expect(gapIdx).toBeLessThan(frames.length - 1);
  });
});

describe('Auth — fixture mode honours the existing bearer-auth gate', () => {
  it('rejects /v1/state/x?fixture=... with 401 when bearer is required and absent', async () => {
    const b = await boot({ httpToken: 'test-token' });
    const res = await fetch(`${b.url}/v1/state/x?fixture=empty-ensemble`, {
      headers: { origin: 'https://evil.com' },
    });
    expect(res.status).toBe(401);
  });

  it('serves the fixture when the bearer matches', async () => {
    const b = await boot({
      httpToken: 'test-token',
      allowedOrigins: ['https://dash.example.com'],
    });
    const res = await fetch(`${b.url}/v1/state/x?fixture=empty-ensemble`, {
      headers: {
        origin: 'https://dash.example.com',
        authorization: 'Bearer test-token',
      },
    });
    expect(res.status).toBe(200);
    const body = await res.json() as EnsembleStateV1;
    expect(body.ensemble).toBe('demo-empty');
  });
});
