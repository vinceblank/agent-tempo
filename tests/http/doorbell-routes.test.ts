/**
 * Unit tests for the doorbell SSE route handler (T1.1 PR-1). Focus: the
 * source-plane auth gate (loopback + X-Ingest-Token vs URL workflowId,
 * uniform 403 no-leak — shared with the inner-loop ingress) and the SSE
 * ding/cleanup mechanics. Minimal fake req/res — no real HTTP (mirrors
 * tests/http/inner-loop-routes.test.ts).
 */
import { describe, it, expect } from 'vitest';
import { EventEmitter } from 'events';
import { handleDoorbellSse } from '../../src/http/doorbell-routes';
import { DoorbellRegistry } from '../../src/http/doorbell';
import { IngestTokenRegistry } from '../../src/http/ingest-registry';
import { INGEST_TOKEN_HEADER } from '../../src/http/inner-loop-routes';
import { sessionWorkflowId } from '../../src/config';

const E = 'demo';
const P = 'tempo-worker';
const WF = sessionWorkflowId(E, P);

interface FakeReqOpts {
  remoteAddress?: string | undefined;
  headers?: Record<string, string>;
}
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function fakeReq(opts: FakeReqOpts = {}): any {
  const remoteAddress = 'remoteAddress' in opts ? opts.remoteAddress : '127.0.0.1';
  const req = new EventEmitter() as unknown as Record<string, unknown>;
  req.socket = { remoteAddress };
  req.headers = opts.headers ?? {};
  return req;
}
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function fakeRes(): any {
  const res = new EventEmitter() as unknown as Record<string, unknown> & {
    statusCode: number;
    chunks: string[];
    ended: boolean;
  };
  res.statusCode = 0;
  res.chunks = [];
  res.ended = false;
  res.writeHead = function (status: number) { this.statusCode = status; return this; };
  res.write = function (chunk: string) { this.chunks.push(String(chunk)); return true; };
  res.end = function (payload?: string) {
    if (payload !== undefined) this.chunks.push(String(payload));
    this.ended = true;
    return this;
  };
  res.socket = { writableLength: 0 };
  return res;
}

function setup() {
  const doorbells = new DoorbellRegistry();
  const ingestTokens = new IngestTokenRegistry();
  const token = ingestTokens.mint(WF);
  return { doorbells, ingestTokens, token, deps: { doorbells, ingestTokens } };
}

const tick = () => new Promise((r) => setTimeout(r, 0));

describe('handleDoorbellSse — auth gate (uniform 403, no-leak)', () => {
  it('rejects non-loopback remotes', async () => {
    const { deps, token } = setup();
    const res = fakeRes();
    await handleDoorbellSse(
      fakeReq({ remoteAddress: '10.0.0.5', headers: { [INGEST_TOKEN_HEADER]: token } }),
      res, deps, E, P,
    );
    expect(res.statusCode).toBe(403);
  });

  it('rejects a missing token', async () => {
    const { deps } = setup();
    const res = fakeRes();
    await handleDoorbellSse(fakeReq(), res, deps, E, P);
    expect(res.statusCode).toBe(403);
  });

  it('rejects a wrong token', async () => {
    const { deps } = setup();
    const res = fakeRes();
    await handleDoorbellSse(
      fakeReq({ headers: { [INGEST_TOKEN_HEADER]: 'not-the-token' } }), res, deps, E, P,
    );
    expect(res.statusCode).toBe(403);
  });

  it("rejects another player's valid token (cross-player-spoof guard)", async () => {
    const { deps, ingestTokens } = setup();
    const otherToken = ingestTokens.mint(sessionWorkflowId(E, 'other-player'));
    const res = fakeRes();
    await handleDoorbellSse(
      fakeReq({ headers: { [INGEST_TOKEN_HEADER]: otherToken } }), res, deps, E, P,
    );
    expect(res.statusCode).toBe(403);
  });

  it('never opens a subscription on a denied request', async () => {
    const { deps, doorbells } = setup();
    await handleDoorbellSse(fakeReq(), fakeRes(), deps, E, P);
    expect(doorbells.totalSubscriberCount()).toBe(0);
  });
});

describe('handleDoorbellSse — stream mechanics', () => {
  it('opens 200 SSE, delivers dings, and cleans up on player close', async () => {
    const { deps, doorbells, token } = setup();
    const req = fakeReq({ headers: { [INGEST_TOKEN_HEADER]: token } });
    const res = fakeRes();

    const handler = handleDoorbellSse(req, res, deps, E, P);
    await tick();
    expect(res.statusCode).toBe(200);
    expect(doorbells.subscriberCount(WF)).toBe(1);

    doorbells.ring(E, P);
    await tick();
    expect(res.chunks.join('')).toContain('event: ding');

    // Player destroyed → stream ends with :closed and unsubscribes.
    doorbells.closePlayer(E, P);
    await handler;
    expect(res.chunks.join('')).toContain(':closed');
    expect(res.ended).toBe(true);
    expect(doorbells.totalSubscriberCount()).toBe(0);
  });

  it('unsubscribes when the client disconnects', async () => {
    const { deps, doorbells, token } = setup();
    const req = fakeReq({ headers: { [INGEST_TOKEN_HEADER]: token } });
    const res = fakeRes();

    const handler = handleDoorbellSse(req, res, deps, E, P);
    await tick();
    expect(doorbells.subscriberCount(WF)).toBe(1);

    // Simulate socket close — the close-handler must unsubscribe, which
    // closes the subscription and lets the handler's loop terminate.
    (req as EventEmitter).emit('close');
    await handler;
    expect(doorbells.totalSubscriberCount()).toBe(0);
  });
});
