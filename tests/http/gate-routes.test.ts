/**
 * Unit tests for the 3d operator-gate route handlers (src/http/gate-routes.ts).
 * Minimal fake req/res (no real HTTP). The OPERATOR routes (arm/disarm/decide)
 * assume server.ts has already applied requireTier(3) — these tests exercise the
 * handler bodies + status mapping. The SOURCE route (resolution) owns its own
 * INGRESS gate (loopback + ingest-token), tested here.
 */
import { describe, it, expect } from 'vitest';
import {
  handleGateArm, handleGateDisarm, handleGateDecide, handleGateResolution,
} from '../../src/http/gate-routes';
import { GateRegistry } from '../../src/http/gate-registry';
import { IngestTokenRegistry } from '../../src/http/ingest-registry';
import { INGEST_TOKEN_HEADER } from '../../src/http/inner-loop-routes';
import { sessionWorkflowId } from '../../src/config';

const E = 'demo';
const P = 'tempo-pi';
const WF = sessionWorkflowId(E, P);
const RID = 'req-1';

interface FakeReqOpts { remoteAddress?: string | undefined; headers?: Record<string, string>; body?: string }
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function fakeReq(opts: FakeReqOpts = {}): any {
  const chunks = opts.body !== undefined ? [Buffer.from(opts.body, 'utf8')] : [];
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
    end(payload?: Buffer | string) { if (payload !== undefined) this.body = Buffer.isBuffer(payload) ? payload.toString('utf8') : payload; return this; },
  };
}

function setup() {
  const gate = new GateRegistry();
  const ingestTokens = new IngestTokenRegistry();
  const token = ingestTokens.mint(WF);
  return { gate, ingestTokens, token, deps: { gate, ingestTokens } };
}

describe('handleGateArm / handleGateDisarm (operator plane)', () => {
  it('arm → 204 and the registry is armed; disarm → 204 and disarmed', () => {
    const { gate, deps } = setup();
    const r1 = fakeRes();
    handleGateArm(fakeReq({ headers: { authorization: 'Bearer abcdef123456' } }), r1, deps, E, P);
    expect(r1.statusCode).toBe(204);
    expect(gate.isArmed(WF)).toBe(true);

    const r2 = fakeRes();
    handleGateDisarm(fakeReq(), r2, deps, E, P);
    expect(r2.statusCode).toBe(204);
    expect(gate.isArmed(WF)).toBe(false);
  });
});

describe('handleGateDecide (operator plane)', () => {
  it('valid decision allow → 204 and the request resolves', async () => {
    const { gate, deps } = setup();
    gate.open(WF, RID, { tool: 'bash', argsSummary: '{}' });
    const res = fakeRes();
    await handleGateDecide(fakeReq({ body: JSON.stringify({ decision: 'allow' }) }), res, deps, E, P, RID);
    expect(res.statusCode).toBe(204);
    expect(gate.getResolution(WF, RID)).toEqual({ status: 'resolved', decision: 'allow', source: 'operator' });
  });

  it('unknown requestId → 404', async () => {
    const { deps } = setup();
    const res = fakeRes();
    await handleGateDecide(fakeReq({ body: JSON.stringify({ decision: 'allow' }) }), res, deps, E, P, 'nope');
    expect(res.statusCode).toBe(404);
  });

  it('already-decided → 409 (idempotency)', async () => {
    const { gate, deps } = setup();
    gate.open(WF, RID, { tool: 'bash', argsSummary: '{}' });
    gate.decide(WF, RID, 'allow');
    const res = fakeRes();
    await handleGateDecide(fakeReq({ body: JSON.stringify({ decision: 'deny' }) }), res, deps, E, P, RID);
    expect(res.statusCode).toBe(409);
  });

  it('bad decision value → 400', async () => {
    const { gate, deps } = setup();
    gate.open(WF, RID, { tool: 'bash', argsSummary: '{}' });
    const res = fakeRes();
    await handleGateDecide(fakeReq({ body: JSON.stringify({ decision: 'maybe' }) }), res, deps, E, P, RID);
    expect(res.statusCode).toBe(400);
  });

  it('malformed JSON body → 400', async () => {
    const { gate, deps } = setup();
    gate.open(WF, RID, { tool: 'bash', argsSummary: '{}' });
    const res = fakeRes();
    await handleGateDecide(fakeReq({ body: '{not json' }), res, deps, E, P, RID);
    expect(res.statusCode).toBe(400);
  });
});

describe('handleGateResolution (source plane — ingest-token INGRESS)', () => {
  it('valid loopback + token → 200 with the resolution', () => {
    const { gate, token, deps } = setup();
    gate.open(WF, RID, { tool: 'bash', argsSummary: '{}' });
    const res = fakeRes();
    handleGateResolution(fakeReq({ headers: { [INGEST_TOKEN_HEADER]: token } }), res, deps, E, P, RID);
    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body as string)).toEqual({ status: 'pending' });
  });

  it('resolved request → 200 with decision + source', () => {
    const { gate, token, deps } = setup();
    gate.open(WF, RID, { tool: 'bash', argsSummary: '{}' });
    gate.decide(WF, RID, 'allow');
    const res = fakeRes();
    handleGateResolution(fakeReq({ headers: { [INGEST_TOKEN_HEADER]: token } }), res, deps, E, P, RID);
    expect(JSON.parse(res.body as string)).toEqual({ status: 'resolved', decision: 'allow', source: 'operator' });
  });

  it('unknown requestId (but valid auth) → 404', () => {
    const { token, deps } = setup();
    const res = fakeRes();
    handleGateResolution(fakeReq({ headers: { [INGEST_TOKEN_HEADER]: token } }), res, deps, E, P, 'nope');
    expect(res.statusCode).toBe(404);
  });

  it('non-loopback → 403 (uniform, no leak)', () => {
    const { gate, token, deps } = setup();
    gate.open(WF, RID, { tool: 'bash', argsSummary: '{}' });
    const res = fakeRes();
    handleGateResolution(fakeReq({ remoteAddress: '10.0.0.5', headers: { [INGEST_TOKEN_HEADER]: token } }), res, deps, E, P, RID);
    expect(res.statusCode).toBe(403);
  });

  it('missing / wrong token → 403', () => {
    const { deps } = setup();
    const r1 = fakeRes();
    handleGateResolution(fakeReq(), r1, deps, E, P, RID);
    expect(r1.statusCode).toBe(403);
    const r2 = fakeRes();
    handleGateResolution(fakeReq({ headers: { [INGEST_TOKEN_HEADER]: 'wrong' } }), r2, deps, E, P, RID);
    expect(r2.statusCode).toBe(403);
  });

  it('CROSS-PLAYER: a token minted for another player → 403', () => {
    const { gate, ingestTokens, deps } = setup();
    gate.open(WF, RID, { tool: 'bash', argsSummary: '{}' });
    const otherToken = ingestTokens.mint(sessionWorkflowId(E, 'other'));
    const res = fakeRes();
    handleGateResolution(fakeReq({ headers: { [INGEST_TOKEN_HEADER]: otherToken } }), res, deps, E, P, RID);
    expect(res.statusCode).toBe(403);
  });
});
