/**
 * Daemon Q&A routes (#700 P2) — POST /ask + GET /answer/:questionId.
 *
 * Boots a real listener with a recording mock client (no aggregate → the ask
 * route still cues + 202s; `trackAsk` is safely skipped, exercised separately
 * in the aggregate unit test). Verifies: ask cues the target with the
 * `[Q <id>]` marker, answer proxies `getAnswer`, validation + error mapping.
 */
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { startHttpServer, type HttpServerHandle } from '../../src/http/server';
import type { TempoClient } from '../../src/client/interface';
import type { AnswerEntry } from '../../src/types';

interface CallLog { method: string; args: unknown[] }

function makeMockClient(opts: { throws?: Partial<Record<string, Error>>; answer?: AnswerEntry | null; phase?: string } = {}):
  { client: TempoClient; calls: CallLog[] } {
  const calls: CallLog[] = [];
  const handler = (method: string, ret: unknown) => async (...args: unknown[]) => {
    calls.push({ method, args });
    if (opts.throws?.[method]) throw opts.throws[method];
    return ret;
  };
  const base: Record<string, unknown> = {
    ensureMaestroSession: handler('ensureMaestroSession', 'maestro-wf'),
    sendAsMaestro: handler('sendAsMaestro', undefined),
    getAnswer: handler('getAnswer', opts.answer ?? null),
    // #822 — the ask deliverability preflight queries the target phase. Default
    // 'attached' (deliverable); override via `opts.phase` for the detached path.
    attachmentInfo: handler('attachmentInfo', { phase: opts.phase ?? 'attached' }),
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
beforeAll(() => { tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ct-qa-')); });
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

describe('POST /v1/ensembles/:e/ask (#700 P2)', () => {
  it('cues the target with a [Q id] marker + respond instruction and returns 202', async () => {
    const b = await boot(makeMockClient());
    const res = await fetch(`${b.url}/v1/ensembles/demo/ask`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ target: 'tempo-eng', question: 'migration done?', questionId: 'q-1' }),
    });
    expect(res.status).toBe(202);
    const body = await res.json();
    expect(body).toMatchObject({ ok: true, ensemble: 'demo', target: 'tempo-eng', questionId: 'q-1' });
    expect(b.calls.find((c) => c.method === 'ensureMaestroSession')?.args).toEqual(['demo']);
    const sent = b.calls.find((c) => c.method === 'sendAsMaestro');
    expect(sent?.args[0]).toBe('demo');
    expect(sent?.args[1]).toBe('tempo-eng');
    expect(sent?.args[2]).toContain('[Q q-1]');
    expect(sent?.args[2]).toContain('respond');
  });

  // #822 — ask is a cue-class sibling: a detached target parks the [Q] cue.
  it('detached target → 202 + queued:true warning (the [Q] cue queues undelivered)', async () => {
    const b = await boot(makeMockClient({ phase: 'detached' }));
    const res = await fetch(`${b.url}/v1/ensembles/demo/ask`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ target: 'tempo-conductor', question: 'done?', questionId: 'q-9' }),
    });
    expect(res.status).toBe(202);
    const body = await res.json();
    expect(body.queued).toBe(true);
    expect(body.phase).toBe('detached');
    expect(body.warning).toContain('detached');
    // Warn-but-queue: the [Q] cue STILL enqueued + the ask is still tracked.
    expect(b.calls.find((c) => c.method === 'sendAsMaestro')).toBeDefined();
  });

  it('live target → no queued warning (delivery:live)', async () => {
    const b = await boot(makeMockClient({ phase: 'awaiting' }));
    const res = await fetch(`${b.url}/v1/ensembles/demo/ask`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ target: 'tempo-eng', question: 'q', questionId: 'q-2' }),
    });
    const body = await res.json();
    expect(body.delivery).toBe('live');
    expect(body.queued).toBe(false);
    expect(body.warning).toBeUndefined();
  });

  it('400 missing-field / invalid-question-id / invalid-player-name', async () => {
    const b = await boot(makeMockClient());
    const post = (body: unknown) => fetch(`${b.url}/v1/ensembles/demo/ask`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
    });
    expect((await post({ question: 'q', questionId: 'q-1' })).status).toBe(400); // no target
    expect((await post({ target: 't', questionId: 'q-1' })).status).toBe(400); // no question
    expect((await post({ target: 't', question: 'q' })).status).toBe(400);     // no questionId
    expect((await post({ target: 't', question: 'q', questionId: 'bad id!' })).status).toBe(400); // bad qid
    expect((await post({ target: 'has space', question: 'q', questionId: 'q1' })).status).toBe(400); // bad target
  });

  it('maps a "workflow not found" throw to 404', async () => {
    const b = await boot(makeMockClient({ throws: { sendAsMaestro: new Error('workflow not found') } }));
    const res = await fetch(`${b.url}/v1/ensembles/demo/ask`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ target: 'tempo-eng', question: 'q', questionId: 'q-1' }),
    });
    expect(res.status).toBe(404);
  });

  it('405 on GET to the ask route', async () => {
    const b = await boot(makeMockClient());
    const res = await fetch(`${b.url}/v1/ensembles/demo/ask`);
    expect(res.status).toBe(405);
  });
});

describe('GET /v1/ensembles/:e/answer/:questionId (#700 P2)', () => {
  it('returns answered:false + answer:null when unanswered', async () => {
    const b = await boot(makeMockClient({ answer: null }));
    const res = await fetch(`${b.url}/v1/ensembles/demo/answer/q-1`);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toMatchObject({ ok: true, ensemble: 'demo', questionId: 'q-1', answered: false, answer: null });
    expect(b.calls.find((c) => c.method === 'getAnswer')?.args).toEqual(['demo', 'q-1']);
  });

  it('returns the entry when answered', async () => {
    const entry: AnswerEntry = { questionId: 'q-1', from: 'tempo-eng', text: 'done', answeredAt: '2026-01-01T00:00:00.000Z' };
    const b = await boot(makeMockClient({ answer: entry }));
    const res = await fetch(`${b.url}/v1/ensembles/demo/answer/q-1`);
    const body = await res.json();
    expect(body.answered).toBe(true);
    expect(body.answer).toEqual(entry);
  });

  it('400 on an invalid questionId shape', async () => {
    const b = await boot(makeMockClient());
    const res = await fetch(`${b.url}/v1/ensembles/demo/answer/${encodeURIComponent('bad id!')}`);
    expect(res.status).toBe(400);
  });
});

describe('Q&A auth posture (#700 P2 — read/write tiers)', () => {
  // The answer GET is a READ (Tier 1); the ask POST is a WRITE (Tier 2). Both
  // enforce per-route on a non-loopback (cross-origin) request — the read-gate
  // is the greenfield must-fix (without it, GET /answer leaked content unauthed).
  it('GET /answer cross-origin WITHOUT a bearer → 401 (read-gate enforced)', async () => {
    const b = await boot(makeMockClient(), { httpToken: 'read-token' });
    const res = await fetch(`${b.url}/v1/ensembles/demo/answer/q-1`, { headers: { origin: 'https://evil.com' } });
    expect(res.status).toBe(401);
  });

  it('GET /answer cross-origin WITH the read bearer → 200 (read = Tier 1)', async () => {
    const b = await boot(makeMockClient({ answer: null }), {
      httpToken: 'read-token', adminToken: 'admin-token', allowedOrigins: ['https://dash.example.com'],
    });
    const res = await fetch(`${b.url}/v1/ensembles/demo/answer/q-1`, {
      headers: { origin: 'https://dash.example.com', authorization: 'Bearer read-token' },
    });
    expect(res.status).toBe(200);
  });

  it('POST /ask cross-origin with only the READ bearer → 403 (ask is Tier 2, needs admin)', async () => {
    const b = await boot(makeMockClient(), {
      httpToken: 'read-token', adminToken: 'admin-token', allowedOrigins: ['https://dash.example.com'],
    });
    const res = await fetch(`${b.url}/v1/ensembles/demo/ask`, {
      method: 'POST',
      headers: { origin: 'https://dash.example.com', authorization: 'Bearer read-token', 'content-type': 'application/json' },
      body: JSON.stringify({ target: 'eng', question: 'q', questionId: 'q-1' }),
    });
    expect(res.status).toBe(403);
  });
});
