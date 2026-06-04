/**
 * Unit tests for the inner-loop HTTP route handlers (src/http/inner-loop-routes.ts,
 * 3c Tier-2). Focus: the security gates (loopback + ingest-token vs URL
 * workflowId, uniform 403-no-leak) and the 204/200 success shapes. Minimal
 * fake req/res — no real HTTP.
 */
import { describe, it, expect } from 'vitest';
import {
  handleInnerIngest,
  handleInnerPresence,
  isLoopbackRemote,
  INGEST_TOKEN_HEADER,
} from '../../src/http/inner-loop-routes';
import { InnerLoopRegistry } from '../../src/http/inner-loop';
import { IngestTokenRegistry } from '../../src/http/ingest-registry';
import { sessionWorkflowId } from '../../src/config';
import type { InnerFrame } from '../../src/pi/inner-loop-publisher';

const E = 'demo';
const P = 'tempo-pi';
const WF = sessionWorkflowId(E, P);
const FRAME: InnerFrame = { type: 'inner.tool_call', tool: 'bash', argsSummary: '{"cmd":"ls"}', ts: 1 };

interface FakeReqOpts {
  remoteAddress?: string | undefined;
  headers?: Record<string, string>;
  body?: string;
}
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function fakeReq(opts: FakeReqOpts = {}): any {
  const chunks = opts.body !== undefined ? [Buffer.from(opts.body, 'utf8')] : [];
  // Preserve an EXPLICIT `remoteAddress: undefined` (don't default it) so the
  // "absent address" case is testable; only default when the key is omitted.
  const remoteAddress = 'remoteAddress' in opts ? opts.remoteAddress : '127.0.0.1';
  return {
    socket: { remoteAddress },
    headers: opts.headers ?? {},
    async *[Symbol.asyncIterator]() { for (const c of chunks) yield c; },
  };
}
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function fakeRes(): any {
  return {
    statusCode: 0,
    body: undefined as unknown,
    writeHead(status: number) { this.statusCode = status; return this; },
    end(payload?: Buffer | string) {
      if (payload !== undefined) this.body = Buffer.isBuffer(payload) ? payload.toString('utf8') : payload;
      return this;
    },
  };
}

function setup(): { innerLoop: InnerLoopRegistry; ingestTokens: IngestTokenRegistry; token: string; deps: { innerLoop: InnerLoopRegistry; ingestTokens: IngestTokenRegistry } } {
  const innerLoop = new InnerLoopRegistry();
  const ingestTokens = new IngestTokenRegistry();
  const token = ingestTokens.mint(WF);
  return { innerLoop, ingestTokens, token, deps: { innerLoop, ingestTokens } };
}

describe('isLoopbackRemote', () => {
  it('accepts loopback addresses, rejects others/absent', () => {
    expect(isLoopbackRemote(fakeReq({ remoteAddress: '127.0.0.1' }))).toBe(true);
    expect(isLoopbackRemote(fakeReq({ remoteAddress: '::1' }))).toBe(true);
    expect(isLoopbackRemote(fakeReq({ remoteAddress: '::ffff:127.0.0.1' }))).toBe(true);
    expect(isLoopbackRemote(fakeReq({ remoteAddress: '10.0.0.5' }))).toBe(false);
    expect(isLoopbackRemote(fakeReq({ remoteAddress: undefined }))).toBe(false);
  });
});

describe('handleInnerIngest — gates + publish', () => {
  it('valid loopback + token → 204 and publishes the frame to subscribers', async () => {
    const { innerLoop, token, deps } = setup();
    const sub = innerLoop.subscribe(WF);
    const res = fakeRes();
    await handleInnerIngest(
      fakeReq({ headers: { [INGEST_TOKEN_HEADER]: token }, body: JSON.stringify(FRAME) }),
      res, deps, E, P,
    );
    expect(res.statusCode).toBe(204);
    expect((await sub.next()).value).toEqual(FRAME);
  });

  it('non-loopback remote → 403 (no publish)', async () => {
    const { innerLoop, token, deps } = setup();
    const sub = innerLoop.subscribe(WF);
    const res = fakeRes();
    await handleInnerIngest(
      fakeReq({ remoteAddress: '10.0.0.5', headers: { [INGEST_TOKEN_HEADER]: token }, body: JSON.stringify(FRAME) }),
      res, deps, E, P,
    );
    expect(res.statusCode).toBe(403);
    // nothing published — next() stays pending
    expect(await Promise.race([sub.next().then(() => 'got'), Promise.resolve('pending')])).toBe('pending');
  });

  it('missing token → 403', async () => {
    const { deps } = setup();
    const res = fakeRes();
    await handleInnerIngest(fakeReq({ body: JSON.stringify(FRAME) }), res, deps, E, P);
    expect(res.statusCode).toBe(403);
  });

  it('wrong token → 403', async () => {
    const { deps } = setup();
    const res = fakeRes();
    await handleInnerIngest(
      fakeReq({ headers: { [INGEST_TOKEN_HEADER]: 'nope' }, body: JSON.stringify(FRAME) }),
      res, deps, E, P,
    );
    expect(res.statusCode).toBe(403);
  });

  it('CROSS-PLAYER: a token minted for another player → 403', async () => {
    const { ingestTokens, deps } = setup();
    const otherToken = ingestTokens.mint(sessionWorkflowId(E, 'other-player'));
    const res = fakeRes();
    await handleInnerIngest(
      fakeReq({ headers: { [INGEST_TOKEN_HEADER]: otherToken }, body: JSON.stringify(FRAME) }),
      res, deps, E, P,
    );
    expect(res.statusCode).toBe(403);
  });

  it('S1: CR/LF in an inner.* frame type → 403 (SSE event-line injection guard)', async () => {
    const { innerLoop, token, deps } = setup();
    const sub = innerLoop.subscribe(WF);
    const res = fakeRes();
    // Starts with `inner.` (passes the prefix check) but smuggles CRLF that would
    // break out of the operator SSE `event:` line — must be rejected pre-registry.
    await handleInnerIngest(
      fakeReq({
        headers: { [INGEST_TOKEN_HEADER]: token },
        body: JSON.stringify({ type: 'inner.tool_call\r\nevent: spoofed', tool: 'x', argsSummary: '', ts: 1 }),
      }),
      res, deps, E, P,
    );
    expect(res.statusCode).toBe(403);
    // nothing published — the malformed frame never reached the registry
    expect(await Promise.race([sub.next().then(() => 'got'), Promise.resolve('pending')])).toBe('pending');
  });

  it('non-inner frame type → 403', async () => {
    const { deps, token } = setup();
    const res = fakeRes();
    await handleInnerIngest(
      fakeReq({ headers: { [INGEST_TOKEN_HEADER]: token }, body: JSON.stringify({ type: 'evil.exec', cmd: 'rm' }) }),
      res, deps, E, P,
    );
    expect(res.statusCode).toBe(403);
  });

  it('invalid JSON body → 403', async () => {
    const { deps, token } = setup();
    const res = fakeRes();
    await handleInnerIngest(
      fakeReq({ headers: { [INGEST_TOKEN_HEADER]: token }, body: '{not json' }),
      res, deps, E, P,
    );
    expect(res.statusCode).toBe(403);
  });

  it('oversize body (>32KB) → 403', async () => {
    const { deps, token } = setup();
    const big = JSON.stringify({ type: 'inner.thinking', kind: 'thinking', delta: 'x'.repeat(40 * 1024) });
    const res = fakeRes();
    await handleInnerIngest(
      fakeReq({ headers: { [INGEST_TOKEN_HEADER]: token }, body: big }),
      res, deps, E, P,
    );
    expect(res.statusCode).toBe(403);
  });
});

describe('handleInnerPresence — gates + count', () => {
  it('valid → 200 with the live subscriber count', () => {
    const { innerLoop, token, deps } = setup();
    innerLoop.subscribe(WF);
    innerLoop.subscribe(WF);
    const res = fakeRes();
    handleInnerPresence(fakeReq({ headers: { [INGEST_TOKEN_HEADER]: token } }), res, deps, E, P);
    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body as string)).toEqual({ subscribers: 2 });
  });

  it('zero subscribers → 200 { subscribers: 0 }', () => {
    const { token, deps } = setup();
    const res = fakeRes();
    handleInnerPresence(fakeReq({ headers: { [INGEST_TOKEN_HEADER]: token } }), res, deps, E, P);
    expect(JSON.parse(res.body as string)).toEqual({ subscribers: 0 });
  });

  it('bad token → 403 (presence is publisher-only — no covert channel)', () => {
    const { deps } = setup();
    const res = fakeRes();
    handleInnerPresence(fakeReq({ headers: { [INGEST_TOKEN_HEADER]: 'nope' } }), res, deps, E, P);
    expect(res.statusCode).toBe(403);
  });

  it('non-loopback → 403', () => {
    const { token, deps } = setup();
    const res = fakeRes();
    handleInnerPresence(fakeReq({ remoteAddress: '10.0.0.5', headers: { [INGEST_TOKEN_HEADER]: token } }), res, deps, E, P);
    expect(res.statusCode).toBe(403);
  });
});
