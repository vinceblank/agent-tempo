/**
 * Daemon coat-check routes (#713 / #42) — POST /coat-check + GET /coat-check/:ticket.
 *
 * Boots a real listener with a recording mock client. Verifies: put stamps the
 * operator (`maestro`) audit identity + returns the ticket, get redeems with the
 * same identity, validation (missing fields / oversize / bad ttl / bad ticket),
 * error mapping (slots-full → 409, not-found → 404), and the Tier-2 auth posture
 * (both put AND get are admin-only — get redeems via a fetch-audit-mutating Update).
 */
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { startHttpServer, type HttpServerHandle } from '../../src/http/server';
import type { TempoClient } from '../../src/client/interface';
import type { CoatCheckEntry } from '../../src/types';
import type { CoatCheckPutResult } from '../../src/workflows/maestro-signals';
import { COAT_CHECK_CONTENT_MAX, COAT_CHECK_TTL_MAX_MS } from '../../src/utils/validation';

interface CallLog { method: string; args: unknown[] }

const PUT_RESULT: CoatCheckPutResult = {
  ticket: 'tkt-abc123',
  expiresAt: '2026-06-14T00:00:00.000Z',
  slotsUsed: 1,
  slotsTotal: 20,
};

const ENTRY: CoatCheckEntry = {
  summary: 'a stashed plan',
  content: '# Plan\nDo the thing.',
  contentType: 'text/markdown',
  putBy: 'maestro',
  putAt: '2026-06-07T00:00:00.000Z',
  expiresAt: '2026-06-14T00:00:00.000Z',
  size: 19,
  fetchCount: 0,
};

function makeMockClient(opts: { throws?: Partial<Record<string, Error>>; entry?: CoatCheckEntry | null } = {}):
  { client: TempoClient; calls: CallLog[] } {
  const calls: CallLog[] = [];
  const handler = (method: string, ret: unknown) => async (...args: unknown[]) => {
    calls.push({ method, args });
    if (opts.throws?.[method]) throw opts.throws[method];
    return ret;
  };
  const base: Record<string, unknown> = {
    coatCheckPut: handler('coatCheckPut', PUT_RESULT),
    coatCheckGet: handler('coatCheckGet', opts.entry === undefined ? ENTRY : opts.entry),
  };
  const proxy = new Proxy(base, {
    get(target, prop: string) {
      if (prop in target) return target[prop];
      return () => { throw new Error(`unstubbed TempoClient.${prop}`); };
    },
  });
  return { client: proxy as unknown as TempoClient, calls };
}

let tmpDir: string;
beforeAll(() => { tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ct-coatcheck-')); });
afterAll(() => { try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch { /* ignore */ } });

let booted: HttpServerHandle[] = [];
afterEach(async () => {
  for (const h of booted) { try { await h.close(); } catch { /* ignore */ } }
  booted = [];
});

async function boot(
  mock: ReturnType<typeof makeMockClient>,
  auth: { httpToken?: string; adminToken?: string; allowedOrigins?: string[] } = {},
): Promise<{ url: string; calls: CallLog[] }> {
  const handle = await startHttpServer({
    client: mock.client,
    namespace: 'default',
    taskQueue: 'agent-tempo-test',
    version: '0.0.0-test',
    bindAddr: '127.0.0.1',
    port: 0,
    httpToken: auth.httpToken,
    adminToken: auth.adminToken,
    allowedOrigins: auth.allowedOrigins,
    portFilePath: path.join(tmpDir, `daemon-${process.hrtime.bigint().toString(36)}.port`),
  });
  booted.push(handle);
  return { url: `http://${handle.bindAddr}:${handle.port}`, calls: mock.calls };
}

describe('POST /v1/ensembles/:e/coat-check (#713)', () => {
  it('stashes + returns the ticket and stamps the maestro audit identity', async () => {
    const b = await boot(makeMockClient());
    const res = await fetch(`${b.url}/v1/ensembles/demo/coat-check`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ summary: 's', content: 'hello', contentType: 'text/markdown', ttlMs: 3600_000 }),
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toMatchObject({ ok: true, ensemble: 'demo', ticket: 'tkt-abc123', slotsUsed: 1, slotsTotal: 20 });
    const put = b.calls.find((c) => c.method === 'coatCheckPut');
    expect(put?.args[0]).toBe('demo');
    expect(put?.args[1]).toMatchObject({ summary: 's', content: 'hello', contentType: 'text/markdown', ttlMs: 3600_000, putBy: 'maestro' });
  });

  it('400 on missing summary / missing content', async () => {
    const b = await boot(makeMockClient());
    const post = (body: unknown) => fetch(`${b.url}/v1/ensembles/demo/coat-check`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
    });
    expect((await post({ content: 'x' })).status).toBe(400); // no summary
    expect((await post({ summary: 's' })).status).toBe(400); // no content
  });

  it('413 when content exceeds the coat-check byte cap', async () => {
    const b = await boot(makeMockClient());
    const res = await fetch(`${b.url}/v1/ensembles/demo/coat-check`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ summary: 's', content: 'x'.repeat(COAT_CHECK_CONTENT_MAX + 1) }),
    });
    expect(res.status).toBe(413);
    // The Temporal layer must NOT be reached — the HTTP layer caps first.
    expect(b.calls.find((c) => c.method === 'coatCheckPut')).toBeUndefined();
  });

  it('400 on a non-integer / out-of-range ttlMs', async () => {
    const b = await boot(makeMockClient());
    const post = (ttlMs: unknown) => fetch(`${b.url}/v1/ensembles/demo/coat-check`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ summary: 's', content: 'x', ttlMs }),
    });
    expect((await post('3600000')).status).toBe(400);              // string, not number
    expect((await post(1.5)).status).toBe(400);                    // non-integer
    expect((await post(COAT_CHECK_TTL_MAX_MS + 1)).status).toBe(400); // over max
  });

  it('maps CoatCheckSlotsFull → 409', async () => {
    const b = await boot(makeMockClient({ throws: { coatCheckPut: new Error('CoatCheckSlotsFull: oldest tickets are a, b, c') } }));
    const res = await fetch(`${b.url}/v1/ensembles/demo/coat-check`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ summary: 's', content: 'x' }),
    });
    expect(res.status).toBe(409);
  });

  it('maps a "workflow not found" throw → 404', async () => {
    const b = await boot(makeMockClient({ throws: { coatCheckPut: new Error('workflow not found') } }));
    const res = await fetch(`${b.url}/v1/ensembles/demo/coat-check`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ summary: 's', content: 'x' }),
    });
    expect(res.status).toBe(404);
  });

  it('405 on GET to the 2-segment put route', async () => {
    const b = await boot(makeMockClient());
    const res = await fetch(`${b.url}/v1/ensembles/demo/coat-check`);
    expect(res.status).toBe(405);
  });
});

describe('GET /v1/ensembles/:e/coat-check/:ticket (#713)', () => {
  it('redeems + returns the entry, stamping the maestro fetch identity', async () => {
    const b = await boot(makeMockClient());
    const res = await fetch(`${b.url}/v1/ensembles/demo/coat-check/tkt-abc123`);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toMatchObject({ ok: true, ensemble: 'demo', ticket: 'tkt-abc123', found: true });
    expect(body.entry).toEqual(ENTRY);
    const get = b.calls.find((c) => c.method === 'coatCheckGet');
    expect(get?.args).toEqual(['demo', { ticket: 'tkt-abc123', fetchedBy: 'maestro' }]);
  });

  it('returns found:false + entry:null when the ticket is gone', async () => {
    const b = await boot(makeMockClient({ entry: null }));
    const res = await fetch(`${b.url}/v1/ensembles/demo/coat-check/tkt-gone`);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toMatchObject({ found: false, entry: null });
  });

  it('400 on an invalid ticket shape', async () => {
    const b = await boot(makeMockClient());
    const res = await fetch(`${b.url}/v1/ensembles/demo/coat-check/${encodeURIComponent('bad ticket!')}`);
    expect(res.status).toBe(400);
  });
});

describe('coat-check auth posture (#713 — both routes Tier 2)', () => {
  // Unlike the /answer read (Tier 1), the coat-check GET redeems via a maestro
  // Update that mutates fetch-audit counters → it is NOT a pure read, so both
  // put AND get demand the admin token.
  it('POST cross-origin with only the READ bearer → 403 (Tier 2)', async () => {
    const b = await boot(makeMockClient(), {
      httpToken: 'read-token', adminToken: 'admin-token', allowedOrigins: ['https://dash.example.com'],
    });
    const res = await fetch(`${b.url}/v1/ensembles/demo/coat-check`, {
      method: 'POST',
      headers: { origin: 'https://dash.example.com', authorization: 'Bearer read-token', 'content-type': 'application/json' },
      body: JSON.stringify({ summary: 's', content: 'x' }),
    });
    expect(res.status).toBe(403);
  });

  it('GET redeem cross-origin with only the READ bearer → 403 (Tier 2)', async () => {
    const b = await boot(makeMockClient(), {
      httpToken: 'read-token', adminToken: 'admin-token', allowedOrigins: ['https://dash.example.com'],
    });
    const res = await fetch(`${b.url}/v1/ensembles/demo/coat-check/tkt-abc123`, {
      headers: { origin: 'https://dash.example.com', authorization: 'Bearer read-token' },
    });
    expect(res.status).toBe(403);
  });

  it('POST + GET cross-origin WITH the admin bearer → 200', async () => {
    const b = await boot(makeMockClient(), {
      httpToken: 'read-token', adminToken: 'admin-token', allowedOrigins: ['https://dash.example.com'],
    });
    const put = await fetch(`${b.url}/v1/ensembles/demo/coat-check`, {
      method: 'POST',
      headers: { origin: 'https://dash.example.com', authorization: 'Bearer admin-token', 'content-type': 'application/json' },
      body: JSON.stringify({ summary: 's', content: 'x' }),
    });
    expect(put.status).toBe(200);
    const get = await fetch(`${b.url}/v1/ensembles/demo/coat-check/tkt-abc123`, {
      headers: { origin: 'https://dash.example.com', authorization: 'Bearer admin-token' },
    });
    expect(get.status).toBe(200);
  });
});
