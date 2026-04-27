/**
 * Cross-device pairing flow — `dashboard-pair.ts` (PR-8 of #340).
 *
 * Drives the in-memory pending-pairing map directly so we don't need
 * to spin up the HTTP server for every assertion. Tests cover:
 *   - mint produces a base64url 32-byte token
 *   - consume hands back the bearer for a valid token
 *   - second consume of the same token returns 410 (single-use)
 *   - expired tokens return 410 + are swept from the map
 *   - mint without a bearer returns 400 (loopback no-op posture)
 *   - logs only the token prefix, never the full token (security)
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { IncomingMessage, ServerResponse } from 'http';
import { Socket } from 'net';
import {
  MAX_PENDING_PAIRINGS,
  PAIR_TTL_MS,
  __pendingPairingsCountForTests,
  __resetPairingsForTests,
  __sweepExpiredForTests,
  handlePairConsume,
  handlePairCreate,
  mintPairToken,
} from '../../src/http/dashboard-pair';

interface MockResponse {
  status: number;
  headers: Record<string, string | number>;
  body: unknown;
}

/** Minimal `IncomingMessage` for the handlers — they don't read the body. */
function makeReq(): IncomingMessage {
  return new IncomingMessage(new Socket());
}

/**
 * `ServerResponse`-compatible spy that captures `writeHead` + `end`
 * payloads so tests can assert on status + JSON body without booting
 * a real HTTP listener.
 */
function makeRes(): { res: ServerResponse; recorded: () => MockResponse } {
  let status = 0;
  let headers: Record<string, string | number> = {};
  let bodyChunks: Buffer[] = [];
  const res = new ServerResponse(makeReq());
  // Override `writeHead` + `end` to capture instead of writing to a
  // socket. Using `Object.assign` keeps the original prototype intact
  // for any property the handler reads incidentally.
  Object.assign(res, {
    writeHead(s: number, h: Record<string, string | number>) {
      status = s;
      headers = h;
      return res;
    },
    end(chunk?: Buffer | string) {
      if (chunk) {
        bodyChunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
      }
      return res;
    },
  });
  return {
    res,
    recorded: () => ({
      status,
      headers,
      body: bodyChunks.length > 0 ? JSON.parse(Buffer.concat(bodyChunks).toString('utf8')) : null,
    }),
  };
}

beforeEach(() => {
  __resetPairingsForTests();
});

afterEach(() => {
  __resetPairingsForTests();
});

describe('mintPairToken', () => {
  it('produces a base64url string of >= 32 chars (256 bits of entropy)', () => {
    const t = mintPairToken();
    // 32 bytes → 43 base64url chars (no padding).
    expect(t.length).toBeGreaterThanOrEqual(32);
    expect(t).toMatch(/^[A-Za-z0-9_-]+$/);
  });

  it('produces unique tokens (collision rate is astronomically low)', () => {
    const tokens = new Set<string>();
    for (let i = 0; i < 50; i++) tokens.add(mintPairToken());
    expect(tokens.size).toBe(50);
  });
});

describe('handlePairCreate (POST /dashboard/api/pair)', () => {
  it('mints a token, returns 201 + { token, expiresAt }, with TTL ~5min', () => {
    const { res, recorded } = makeRes();
    const before = Date.now();
    handlePairCreate(makeReq(), res, 'operator-bearer');
    const after = Date.now();
    const r = recorded();
    expect(r.status).toBe(201);
    const body = r.body as { token: string; expiresAt: number };
    expect(body.token).toMatch(/^[A-Za-z0-9_-]+$/);
    // Floor / ceiling sanity — expiresAt within [now+TTL-100ms, now+TTL+100ms]
    expect(body.expiresAt).toBeGreaterThanOrEqual(before + PAIR_TTL_MS - 100);
    expect(body.expiresAt).toBeLessThanOrEqual(after + PAIR_TTL_MS + 100);
    expect(__pendingPairingsCountForTests()).toBe(1);
  });

  it('returns 400 with `pair-requires-bearer` when no bearer is provided', () => {
    const { res, recorded } = makeRes();
    handlePairCreate(makeReq(), res, null);
    const r = recorded();
    expect(r.status).toBe(400);
    expect(r.body).toMatchObject({ error: 'pair-requires-bearer' });
    expect(__pendingPairingsCountForTests()).toBe(0);
  });

  it('returns 503 once the pending-pairings cap is reached', () => {
    // Defence-in-depth: cap protects against a script-spam mint loop
    // bloating memory between sweeps. Mint up to the cap, then assert
    // the next mint is rejected.
    for (let i = 0; i < MAX_PENDING_PAIRINGS; i++) {
      handlePairCreate(makeReq(), makeRes().res, `bearer-${i}`);
    }
    expect(__pendingPairingsCountForTests()).toBe(MAX_PENDING_PAIRINGS);

    const { res, recorded } = makeRes();
    handlePairCreate(makeReq(), res, 'bearer-overflow');
    const r = recorded();
    expect(r.status).toBe(503);
    expect(r.body).toMatchObject({ error: 'pair-pending-cap' });
    // Cap held — no overflow entry stored.
    expect(__pendingPairingsCountForTests()).toBe(MAX_PENDING_PAIRINGS);
  });
});

describe('handlePairConsume (GET /dashboard/api/pair/:token)', () => {
  it('returns 200 + { bearer, expiresAt } for a valid pending token', () => {
    const mint = makeRes();
    handlePairCreate(makeReq(), mint.res, 'op-bearer');
    const { token } = mint.recorded().body as { token: string };

    const consume = makeRes();
    handlePairConsume(makeReq(), consume.res, token);
    const r = consume.recorded();
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ bearer: 'op-bearer' });
    // Token consumed → removed from the map.
    expect(__pendingPairingsCountForTests()).toBe(0);
  });

  it('returns 410 Gone on unknown tokens (`pair-token-invalid`)', () => {
    const { res, recorded } = makeRes();
    handlePairConsume(makeReq(), res, 'never-minted');
    const r = recorded();
    expect(r.status).toBe(410);
    expect(r.body).toEqual({ error: 'pair-token-invalid' });
  });

  it('second consume of the same token returns 410 (single-use)', () => {
    const mint = makeRes();
    handlePairCreate(makeReq(), mint.res, 'op-bearer');
    const { token } = mint.recorded().body as { token: string };

    handlePairConsume(makeReq(), makeRes().res, token);
    const second = makeRes();
    handlePairConsume(makeReq(), second.res, token);
    expect(second.recorded().status).toBe(410);
  });

  it('expired tokens (sweep) return 410 and are removed', () => {
    // Mint with the real flow, then advance clock past the TTL via
    // the synthetic-now sweep helper. This proves the on-consume
    // freshness check + the sweep both take the entry off the map.
    const mint = makeRes();
    handlePairCreate(makeReq(), mint.res, 'op-bearer');
    const { token, expiresAt } = mint.recorded().body as { token: string; expiresAt: number };
    expect(__pendingPairingsCountForTests()).toBe(1);

    // Sweep at expiresAt + 1 ms
    const removed = __sweepExpiredForTests(expiresAt + 1);
    expect(removed).toBe(1);
    expect(__pendingPairingsCountForTests()).toBe(0);

    const consume = makeRes();
    handlePairConsume(makeReq(), consume.res, token);
    expect(consume.recorded().status).toBe(410);
  });

  it('on-consume freshness check returns 410 even before sweep runs', () => {
    // Don't trigger sweep — just freeze `Date.now` past the TTL.
    const mint = makeRes();
    handlePairCreate(makeReq(), mint.res, 'op-bearer');
    const { token, expiresAt } = mint.recorded().body as { token: string; expiresAt: number };

    const realNow = Date.now;
    Date.now = () => expiresAt + 1;
    try {
      const consume = makeRes();
      handlePairConsume(makeReq(), consume.res, token);
      expect(consume.recorded().status).toBe(410);
    } finally {
      Date.now = realNow;
    }
    // Consume cleaned up the expired entry directly.
    expect(__pendingPairingsCountForTests()).toBe(0);
  });
});

describe('logging', () => {
  it('logs only the token prefix on mint + consume — never the full token', () => {
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      const mint = makeRes();
      handlePairCreate(makeReq(), mint.res, 'op-bearer');
      const { token } = mint.recorded().body as { token: string };

      handlePairConsume(makeReq(), makeRes().res, token);

      // `console.error` receives multi-arg calls; join each call's
      // args so the assertions look at one string per emitted line.
      const lines = errSpy.mock.calls.map((call) => call.map(String).join(' '));
      const mintLine = lines.find((l) => l.includes('pair.minted'));
      const consumeLine = lines.find((l) => l.includes('pair.consumed'));
      expect(mintLine).toBeTruthy();
      expect(consumeLine).toBeTruthy();
      // Prefix appears…
      expect(mintLine).toContain(`tokenPrefix=${token.slice(0, 8)}`);
      // …but the full token never does.
      expect(mintLine).not.toContain(token);
      expect(consumeLine).not.toContain(token);
    } finally {
      errSpy.mockRestore();
    }
  });
});
