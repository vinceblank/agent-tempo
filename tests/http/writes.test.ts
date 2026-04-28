/**
 * End-to-end tests for the daemon's POST write surface — PR-7a of #340.
 *
 * Boots a real listener with a mocked TempoClient that records every
 * call, then hits the write endpoints with `fetch`. Verifies:
 *
 * - Every action routes to the right TempoClient method with the
 *   right args.
 * - Bodies are validated (missing fields, invalid player names,
 *   message-too-long, body-too-large, malformed JSON, ensemble names).
 * - Method-not-allowed regression suite (POST to read routes → 405,
 *   GET to write routes → 405).
 * - Auth posture parity with reads (loopback no-auth, non-loopback
 *   bearer-required).
 * - Error mapping (TempoClient `Error('No session found …')` → 404).
 */
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { startHttpServer, type HttpServerHandle } from '../../src/http/server';
import { WRITE_BODY_MAX } from '../../src/http/writes';
import type { TempoClient } from '../../src/client/interface';

// ── Recording mock client ────────────────────────────────────────────────

interface CallLog {
  method: string;
  args: unknown[];
}

interface MockOptions {
  /** Per-method override: throw this error instead of recording. */
  throws?: Partial<Record<string, Error>>;
  /** Per-method override: return this value instead of the default. */
  returns?: Partial<Record<string, unknown>>;
}

function makeMockClient(opts: MockOptions = {}): { client: TempoClient; calls: CallLog[] } {
  const calls: CallLog[] = [];
  const handler = (method: string, defaultReturn: unknown) =>
    async (...args: unknown[]) => {
      calls.push({ method, args });
      if (opts.throws?.[method]) throw opts.throws[method];
      if (opts.returns && method in opts.returns) return opts.returns[method];
      return defaultReturn;
    };

  const base = {
    ensureMaestroSession: handler('ensureMaestroSession', 'maestro-wf-id'),
    sendAsMaestro: handler('sendAsMaestro', undefined),
    pause: handler('pause', undefined),
    play: handler('play', undefined),
    release: handler('release', { released: ['p1'], errors: [] }),
    recruit: handler('recruit', { playerId: 'tempo-eng', entryId: 'entry-1' }),
    restart: handler('restart', { playerId: 'tempo-eng', entryId: 'restart-1' }),
    destroy: handler('destroy', undefined),
    detach: handler('detach', undefined),
    recall: handler('recall', { messages: [] }),
    listEnsembles: handler('listEnsembles', []),
    getPlayers: handler('getPlayers', []),
    getEnsembleChat: handler('getEnsembleChat', { messages: [], total: 0, hasMore: false, hasConductor: false }),
    getSchedules: handler('getSchedules', []),
    isMaestroPaused: handler('isMaestroPaused', false),
    isAnySessionHeld: handler('isAnySessionHeld', false),
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

// ── Boot helpers ─────────────────────────────────────────────────────────

let tmpDir: string;
beforeAll(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ct-writes-'));
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

async function boot(opts: {
  mock?: MockOptions;
  bindAddr?: string;
  httpToken?: string;
  allowedOrigins?: string[];
} = {}): Promise<Bootstrapped> {
  const { client, calls } = makeMockClient(opts.mock);
  const portFile = path.join(tmpDir, `daemon-${process.hrtime.bigint().toString(36)}.port`);
  const handle = await startHttpServer({
    client,
    namespace: 'default',
    version: '0.28.0-test',
    bindAddr: opts.bindAddr ?? '127.0.0.1',
    port: 0,
    httpToken: opts.httpToken,
    allowedOrigins: opts.allowedOrigins,
    portFilePath: portFile,
  });
  const b: Bootstrapped = { handle, url: `http://${handle.bindAddr}:${handle.port}`, calls };
  booted.push(b);
  return b;
}

async function postJson(url: string, body: unknown, headers: Record<string, string> = {}): Promise<Response> {
  return fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...headers },
    body: JSON.stringify(body),
  });
}

// ── Tests ────────────────────────────────────────────────────────────────

describe('POST /v1/ensembles/:ensemble/cue', () => {
  it('routes to ensureMaestroSession + sendAsMaestro and returns 202', async () => {
    const b = await boot();
    const res = await postJson(`${b.url}/v1/ensembles/demo/cue`, {
      to: 'tempo-eng',
      message: 'time to ship',
    });
    expect(res.status).toBe(202);
    expect(b.calls.find((c) => c.method === 'ensureMaestroSession')?.args).toEqual(['demo']);
    expect(b.calls.find((c) => c.method === 'sendAsMaestro')?.args).toEqual([
      'demo', 'tempo-eng', 'time to ship',
    ]);
  });

  it('400 missing-field on absent `to`', async () => {
    const b = await boot();
    const res = await postJson(`${b.url}/v1/ensembles/demo/cue`, { message: 'x' });
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body).toEqual({ error: 'missing-field', field: 'to' });
  });

  it('400 invalid-player-name on bad `to`', async () => {
    const b = await boot();
    const res = await postJson(`${b.url}/v1/ensembles/demo/cue`, {
      to: 'has spaces',
      message: 'x',
    });
    expect(res.status).toBe(400);
    expect((await res.json()).error).toBe('invalid-player-name');
  });

  it('413 message-too-long when message exceeds MESSAGE_MAX', async () => {
    const b = await boot();
    const res = await postJson(`${b.url}/v1/ensembles/demo/cue`, {
      to: 'tempo-eng',
      message: 'a'.repeat(102_401),
    });
    expect(res.status).toBe(413);
    expect((await res.json()).error).toBe('message-too-long');
  });
});

describe('POST /v1/ensembles/:ensemble/pause + /play + /release', () => {
  it('pause routes to client.pause', async () => {
    const b = await boot();
    const res = await postJson(`${b.url}/v1/ensembles/demo/pause`, {});
    expect(res.status).toBe(202);
    expect(b.calls.find((c) => c.method === 'pause')?.args).toEqual(['demo']);
  });

  it('play with empty body calls play with no opts (release omitted)', async () => {
    const b = await boot();
    const res = await postJson(`${b.url}/v1/ensembles/demo/play`, {});
    expect(res.status).toBe(202);
    const playCall = b.calls.find((c) => c.method === 'play');
    // Optional-prop signature — handler passes `undefined` rather than
    // `{ release: false }` so the absent case is signal-clean.
    expect(playCall?.args).toEqual(['demo', undefined]);
  });

  it('play with release=true forwards the flag', async () => {
    const b = await boot();
    const res = await postJson(`${b.url}/v1/ensembles/demo/play`, { release: true });
    expect(res.status).toBe(202);
    const playCall = b.calls.find((c) => c.method === 'play');
    expect(playCall?.args).toEqual(['demo', { release: true }]);
  });

  it('release with playerId forwards single-player release', async () => {
    const b = await boot();
    const res = await postJson(`${b.url}/v1/ensembles/demo/release`, { playerId: 'tempo-eng' });
    expect(res.status).toBe(200);
    expect(b.calls.find((c) => c.method === 'release')?.args).toEqual(['demo', 'tempo-eng']);
    expect(await res.json()).toEqual({ released: ['p1'], errors: [] });
  });

  it('release without playerId fans out across the ensemble', async () => {
    const b = await boot();
    const res = await postJson(`${b.url}/v1/ensembles/demo/release`, {});
    expect(res.status).toBe(200);
    expect(b.calls.find((c) => c.method === 'release')?.args).toEqual(['demo', undefined]);
  });
});

describe('POST /v1/ensembles/:ensemble/recruit', () => {
  it('routes to client.recruit and returns the result', async () => {
    const b = await boot();
    const res = await postJson(`${b.url}/v1/ensembles/demo/recruit`, {
      name: 'tempo-eng',
      workDir: '/repo',
      agent: 'claude',
      initialMessage: 'go',
    });
    expect(res.status).toBe(202);
    const body = await res.json();
    expect(body).toEqual({ playerId: 'tempo-eng', entryId: 'entry-1' });
    const recruitCall = b.calls.find((c) => c.method === 'recruit');
    expect(recruitCall?.args[0]).toBe('demo');
    expect(recruitCall?.args[1]).toMatchObject({
      name: 'tempo-eng',
      workDir: '/repo',
      agent: 'claude',
      initialMessage: 'go',
    });
  });

  it('400 missing-field on absent `name` or `workDir`', async () => {
    const b = await boot();
    const res = await postJson(`${b.url}/v1/ensembles/demo/recruit`, { workDir: '/repo' });
    expect(res.status).toBe(400);
    expect((await res.json()).field).toBe('name');
  });

  it('400 invalid-agent on unknown agent type', async () => {
    const b = await boot();
    const res = await postJson(`${b.url}/v1/ensembles/demo/recruit`, {
      name: 'x', workDir: '/y', agent: 'rogue',
    });
    expect(res.status).toBe(400);
    expect((await res.json()).error).toBe('invalid-agent');
  });

  describe('agent allowlist + dev-mode gate (#388)', () => {
    // Capture per-test (not per-block): a sibling test that mutates the env
    // var would otherwise be captured as the "prior" value and restored
    // incorrectly for the rest of this block.
    let prevDevMode: string | undefined;
    beforeEach(() => { prevDevMode = process.env.CLAUDE_TEMPO_DEV_MODE; });
    afterEach(() => {
      if (prevDevMode === undefined) delete process.env.CLAUDE_TEMPO_DEV_MODE;
      else process.env.CLAUDE_TEMPO_DEV_MODE = prevDevMode;
    });

    it('prod mode: agent "mock" is rejected with allowed=[claude,copilot]', async () => {
      delete process.env.CLAUDE_TEMPO_DEV_MODE;
      const b = await boot();
      const res = await postJson(`${b.url}/v1/ensembles/demo/recruit`, {
        name: 'alice', workDir: '/repo', agent: 'mock',
      });
      expect(res.status).toBe(400);
      const body = await res.json();
      expect(body.error).toBe('invalid-agent');
      expect(body.allowed).toEqual(['claude', 'copilot']);
    });

    it('dev mode: agent "mock" is accepted and forwarded to client.recruit', async () => {
      process.env.CLAUDE_TEMPO_DEV_MODE = '1';
      const b = await boot();
      const res = await postJson(`${b.url}/v1/ensembles/demo/recruit`, {
        name: 'alice', workDir: '/repo', agent: 'mock',
      });
      expect(res.status).toBe(202);
      const recruitCall = b.calls.find((c) => c.method === 'recruit');
      expect(recruitCall?.args[1]).toMatchObject({ name: 'alice', agent: 'mock' });
    });

    it('dev mode: agent "claude" still works (parity with prod)', async () => {
      process.env.CLAUDE_TEMPO_DEV_MODE = '1';
      const b = await boot();
      const res = await postJson(`${b.url}/v1/ensembles/demo/recruit`, {
        name: 'alice', workDir: '/repo', agent: 'claude',
      });
      expect(res.status).toBe(202);
      const recruitCall = b.calls.find((c) => c.method === 'recruit');
      expect(recruitCall?.args[1]).toMatchObject({ agent: 'claude' });
    });

    it('dev mode: unknown agent rejected with allowed=[claude,copilot,mock]', async () => {
      process.env.CLAUDE_TEMPO_DEV_MODE = '1';
      const b = await boot();
      const res = await postJson(`${b.url}/v1/ensembles/demo/recruit`, {
        name: 'alice', workDir: '/repo', agent: 'banana',
      });
      expect(res.status).toBe(400);
      const body = await res.json();
      expect(body.error).toBe('invalid-agent');
      expect(body.allowed).toEqual(['claude', 'copilot', 'mock']);
    });
  });
});

// ── Per-player destructive actions (restart / destroy / detach / recall) ──
//
// Each route lives under `/v1/ensembles/:ensemble/<action>` and takes
// `{ playerId, reason? }` (plus per-action extras). Bodies are validated
// upfront; missing/invalid playerId fast-fails 400 without touching the
// client. The 404 mapping is a single `mapWriteError` path so we only
// re-prove it once per file (already covered for `release`).

describe('POST /v1/ensembles/:ensemble/restart', () => {
  it('routes to client.restart with (ensemble, playerId) and returns 202', async () => {
    const b = await boot();
    const res = await postJson(`${b.url}/v1/ensembles/demo/restart`, {
      playerId: 'tempo-eng',
    });
    expect(res.status).toBe(202);
    expect(b.calls.find((c) => c.method === 'restart')?.args).toEqual(['demo', 'tempo-eng']);
    expect(await res.json()).toEqual({ playerId: 'tempo-eng', entryId: 'restart-1' });
  });

  it('400 missing-field on absent playerId', async () => {
    const b = await boot();
    const res = await postJson(`${b.url}/v1/ensembles/demo/restart`, {});
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: 'missing-field', field: 'playerId' });
  });

  it('400 invalid-player-name on bad playerId', async () => {
    const b = await boot();
    const res = await postJson(`${b.url}/v1/ensembles/demo/restart`, {
      playerId: 'has spaces',
    });
    expect(res.status).toBe(400);
    expect((await res.json()).error).toBe('invalid-player-name');
  });

  it('404 session-not-found when client throws "No session found"', async () => {
    const b = await boot({
      mock: { throws: { restart: new Error('No session found with name "ghost" in ensemble "demo".') } },
    });
    const res = await postJson(`${b.url}/v1/ensembles/demo/restart`, { playerId: 'ghost' });
    expect(res.status).toBe(404);
    expect((await res.json()).error).toBe('session-not-found');
  });
});

describe('POST /v1/ensembles/:ensemble/destroy', () => {
  it('routes to client.destroy with (ensemble, playerId, reason?) and returns 202', async () => {
    const b = await boot();
    const res = await postJson(`${b.url}/v1/ensembles/demo/destroy`, {
      playerId: 'tempo-eng',
      reason: 'qa cleanup',
    });
    expect(res.status).toBe(202);
    expect(b.calls.find((c) => c.method === 'destroy')?.args).toEqual([
      'demo', 'tempo-eng', 'qa cleanup',
    ]);
    expect(await res.json()).toEqual({ ok: true, ensemble: 'demo', playerId: 'tempo-eng' });
  });

  it('forwards undefined reason when the body omits it', async () => {
    const b = await boot();
    await postJson(`${b.url}/v1/ensembles/demo/destroy`, { playerId: 'tempo-eng' });
    expect(b.calls.find((c) => c.method === 'destroy')?.args).toEqual([
      'demo', 'tempo-eng', undefined,
    ]);
  });

  it('400 missing-field on absent playerId', async () => {
    const b = await boot();
    const res = await postJson(`${b.url}/v1/ensembles/demo/destroy`, { reason: 'x' });
    expect(res.status).toBe(400);
    expect((await res.json()).field).toBe('playerId');
  });

  it('404 session-not-found when client throws', async () => {
    const b = await boot({
      mock: { throws: { destroy: new Error('No session found with name "ghost".') } },
    });
    const res = await postJson(`${b.url}/v1/ensembles/demo/destroy`, { playerId: 'ghost' });
    expect(res.status).toBe(404);
  });
});

describe('POST /v1/ensembles/:ensemble/detach', () => {
  it('routes to client.detach with (ensemble, playerId) and returns 202', async () => {
    const b = await boot();
    const res = await postJson(`${b.url}/v1/ensembles/demo/detach`, {
      playerId: 'tempo-eng',
    });
    expect(res.status).toBe(202);
    expect(b.calls.find((c) => c.method === 'detach')?.args).toEqual([
      'demo', 'tempo-eng', undefined,
    ]);
    expect(await res.json()).toEqual({ ok: true, ensemble: 'demo', playerId: 'tempo-eng' });
  });

  it('forwards numeric deadlineMs when supplied', async () => {
    const b = await boot();
    await postJson(`${b.url}/v1/ensembles/demo/detach`, {
      playerId: 'tempo-eng',
      deadlineMs: 8000,
    });
    expect(b.calls.find((c) => c.method === 'detach')?.args).toEqual([
      'demo', 'tempo-eng', 8000,
    ]);
  });

  it('400 invalid-field on non-numeric deadlineMs', async () => {
    const b = await boot();
    const res = await postJson(`${b.url}/v1/ensembles/demo/detach`, {
      playerId: 'tempo-eng',
      deadlineMs: 'soon',
    });
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: 'invalid-field', field: 'deadlineMs' });
    // Strict-validate means the client must NOT have been called.
    expect(b.calls.find((c) => c.method === 'detach')).toBeUndefined();
  });

  it('400 missing-field on absent playerId', async () => {
    const b = await boot();
    const res = await postJson(`${b.url}/v1/ensembles/demo/detach`, {});
    expect(res.status).toBe(400);
    expect((await res.json()).field).toBe('playerId');
  });
});

describe('POST /v1/ensembles/:ensemble/recall', () => {
  it('routes to client.recall and returns 200 with the result', async () => {
    const b = await boot({ mock: { returns: { recall: { messages: [{ id: 'm1' }] } } } });
    const res = await postJson(`${b.url}/v1/ensembles/demo/recall`, {
      playerId: 'tempo-eng',
    });
    // Recall is read-shaped (returns the timeline), so 200 not 202 —
    // documented in the writes.ts handler.
    expect(res.status).toBe(200);
    expect(b.calls.find((c) => c.method === 'recall')?.args).toEqual(['demo', 'tempo-eng']);
    expect(await res.json()).toEqual({ messages: [{ id: 'm1' }] });
  });

  it('400 missing-field on absent playerId', async () => {
    const b = await boot();
    const res = await postJson(`${b.url}/v1/ensembles/demo/recall`, {});
    expect(res.status).toBe(400);
    expect((await res.json()).field).toBe('playerId');
  });

  it('404 session-not-found when client throws', async () => {
    const b = await boot({
      mock: { throws: { recall: new Error('No session found with name "ghost".') } },
    });
    const res = await postJson(`${b.url}/v1/ensembles/demo/recall`, { playerId: 'ghost' });
    expect(res.status).toBe(404);
  });
});

describe('Body parsing edge cases', () => {
  it('413 body-too-large rejects bodies over 1 MiB', async () => {
    const b = await boot();
    const huge = 'x'.repeat(WRITE_BODY_MAX + 1024);
    const res = await fetch(`${b.url}/v1/ensembles/demo/pause`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: huge,
    });
    expect(res.status).toBe(413);
  });

  it('400 invalid-json on malformed JSON', async () => {
    const b = await boot();
    const res = await fetch(`${b.url}/v1/ensembles/demo/pause`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: '{ not valid',
    });
    expect(res.status).toBe(400);
    expect((await res.json()).error).toBe('invalid-json');
  });

  it('empty body is treated as `{}` for endpoints that allow it', async () => {
    const b = await boot();
    const res = await fetch(`${b.url}/v1/ensembles/demo/pause`, { method: 'POST' });
    expect(res.status).toBe(202);
  });

  it('400 invalid-ensemble-name on a malformed ensemble path', async () => {
    const b = await boot();
    const res = await postJson(`${b.url}/v1/ensembles/${encodeURIComponent('!!!')}/pause`, {});
    expect(res.status).toBe(400);
    expect((await res.json()).error).toBe('invalid-ensemble-name');
  });
});

describe('Method-not-allowed regression suite', () => {
  // POST `/v1/ensembles` is the create-ensemble route (issue #400) —
  // no longer 405. POST to a still-GET-only endpoint (`/v1/hosts`)
  // pins the gate's behaviour.
  it('POST to a known read endpoint (e.g. /v1/hosts) → 405', async () => {
    const b = await boot();
    const res = await fetch(`${b.url}/v1/hosts`, { method: 'POST' });
    expect(res.status).toBe(405);
    expect(res.headers.get('allow')).toBe('GET, OPTIONS');
  });

  it('GET to a write endpoint → 405 with Allow: POST, OPTIONS', async () => {
    const b = await boot();
    const res = await fetch(`${b.url}/v1/ensembles/demo/cue`);
    expect(res.status).toBe(405);
    expect(res.headers.get('allow')).toBe('POST, OPTIONS');
  });

  it('unknown action under /v1/ensembles/:e/<x> → 404, not 405', async () => {
    const b = await boot();
    // Use an obviously-non-action verb — `destroy` was the previous
    // probe but landed as a real action in this PR, so pick something
    // structurally unlikely to ship as a route.
    const res = await fetch(`${b.url}/v1/ensembles/demo/notarealaction`, { method: 'POST' });
    expect(res.status).toBe(404);
  });
});

describe('Auth posture — parity with reads', () => {
  it('non-loopback origin without bearer → 401', async () => {
    const b = await boot({ httpToken: 'good-token' });
    const res = await fetch(`${b.url}/v1/ensembles/demo/pause`, {
      method: 'POST',
      headers: { origin: 'https://evil.com' },
    });
    expect(res.status).toBe(401);
  });

  it('non-loopback origin with valid bearer → success', async () => {
    const b = await boot({
      httpToken: 'good-token',
      allowedOrigins: ['https://dash.example.com'],
    });
    const res = await fetch(`${b.url}/v1/ensembles/demo/pause`, {
      method: 'POST',
      headers: {
        origin: 'https://dash.example.com',
        authorization: 'Bearer good-token',
      },
    });
    expect(res.status).toBe(202);
  });

  it('loopback no-Origin → no auth required (parity with reads)', async () => {
    const b = await boot({ httpToken: 'good-token' });
    const res = await fetch(`${b.url}/v1/ensembles/demo/pause`, { method: 'POST' });
    expect(res.status).toBe(202);
  });
});

describe('Error mapping', () => {
  it('"No session found" from TempoClient → 404 session-not-found', async () => {
    const b = await boot({
      mock: { throws: { release: new Error('No session found with name "ghost" in ensemble "demo".') } },
    });
    const res = await postJson(`${b.url}/v1/ensembles/demo/release`, { playerId: 'ghost' });
    expect(res.status).toBe(404);
    expect((await res.json()).error).toBe('session-not-found');
  });

  it('"Unknown agent type" → 400 unknown-agent-type', async () => {
    const b = await boot({
      mock: { throws: { recruit: new Error('Unknown agent type "rogue"') } },
    });
    const res = await postJson(`${b.url}/v1/ensembles/demo/recruit`, {
      name: 'x', workDir: '/y',
    });
    expect(res.status).toBe(400);
    expect((await res.json()).error).toBe('unknown-agent-type');
  });

  it('arbitrary errors → 500 write-failed', async () => {
    const b = await boot({
      mock: { throws: { pause: new Error('temporal unavailable') } },
    });
    const res = await postJson(`${b.url}/v1/ensembles/demo/pause`, {});
    expect(res.status).toBe(500);
    expect((await res.json()).error).toBe('write-failed');
  });
});
