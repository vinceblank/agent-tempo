/**
 * Unit tests for the inner-loop HTTP client (src/pi/inner-loop-client.ts, 3c
 * Part 5) — the production InnerLoopRegistry impl the publisher injects.
 *
 * Driven WITHOUT a real daemon: an injected fetch records calls + returns
 * controllable responses; an injected readPort + clock make discovery and the
 * presence rate-limit deterministic. Verifies the locked wire contract: POST
 * ingest URL/headers/bare-frame body + drop-never-throw on non-204; cached
 * presence GET with rate-limit + fail-safe 0; no-op when token/port absent;
 * 32KB DOS backstop.
 */
import { expect } from 'chai';
import { InnerLoopHttpClient, INGEST_TOKEN_ENV, MAX_FRAME_BYTES, type InnerLoopFetch } from '../src/pi/inner-loop-client';
import type { InnerFrame } from '../src/pi/inner-loop-publisher';

interface RecordedCall {
  url: string;
  method: string;
  headers: Record<string, string>;
  body?: string;
}

/** Records calls; each invocation pulls a queued response (or a default 204/200). */
class FakeFetch {
  public readonly calls: RecordedCall[] = [];
  private responders: Array<(call: RecordedCall) => { status: number; json?: unknown }> = [];
  /** Push a responder for the NEXT call. */
  enqueue(r: (call: RecordedCall) => { status: number; json?: unknown }): void {
    this.responders.push(r);
  }
  readonly fn: InnerLoopFetch = (url, init) => {
    const call: RecordedCall = { url, method: init.method, headers: init.headers, body: init.body };
    this.calls.push(call);
    const responder = this.responders.shift();
    const res = responder ? responder(call) : { status: url.endsWith('/presence') ? 200 : 204, json: { subscribers: 0 } };
    return Promise.resolve({
      status: res.status,
      json: async () => res.json ?? {},
    });
  };
}

/** Flush pending microtasks so fire-and-forget .then/.catch run. */
const flush = () => new Promise<void>((r) => setTimeout(r, 0));

const frame = (over: Partial<Extract<InnerFrame, { type: 'inner.turn' }>> = {}): InnerFrame => ({
  type: 'inner.turn', phase: 'start', turnIndex: 0, ts: 1, ...over,
});

const make = (fake: FakeFetch, over: Partial<ConstructorParameters<typeof InnerLoopHttpClient>[0]> = {}) =>
  new InnerLoopHttpClient({
    ensemble: 'ens',
    playerId: 'tempo-eng',
    ingestToken: 'tok-123',
    readPort: () => 8473,
    fetchFn: fake.fn,
    now: () => 1_000_000,
    ...over,
  });

describe('inner-loop client — publish (ingest)', () => {
  it('POSTs the frame to the ingest URL with the ingest-token + content-type', async () => {
    const fake = new FakeFetch();
    make(fake).publish('wf', frame({ turnIndex: 7 }));
    await flush();
    expect(fake.calls).to.have.length(1);
    const c = fake.calls[0];
    expect(c.method).to.equal('POST');
    expect(c.url).to.equal('http://127.0.0.1:8473/v1/players/ens/tempo-eng/inner/ingest');
    expect(c.headers['X-Ingest-Token']).to.equal('tok-123');
    expect(c.headers['Content-Type']).to.equal('application/json');
  });

  it('sends the InnerFrame JSON object DIRECTLY (no wrapper)', async () => {
    const fake = new FakeFetch();
    make(fake).publish('wf', { type: 'inner.tool_call', tool: 'bash', argsSummary: '{"x":1}', ts: 5 });
    await flush();
    expect(JSON.parse(fake.calls[0].body!)).to.deep.equal({
      type: 'inner.tool_call', tool: 'bash', argsSummary: '{"x":1}', ts: 5,
    });
  });

  it('swallows a non-204 response (403/413) without throwing', async () => {
    const fake = new FakeFetch();
    fake.enqueue(() => ({ status: 403 }));
    const client = make(fake);
    expect(() => client.publish('wf', frame())).to.not.throw();
    await flush(); // .then runs, status!==204 path, no throw
    expect(fake.calls).to.have.length(1);
  });

  it('swallows a network error (fetch rejects) without throwing', async () => {
    const rejectingFetch: InnerLoopFetch = () => Promise.reject(new Error('ECONNREFUSED'));
    const client = make(new FakeFetch(), { fetchFn: rejectingFetch });
    expect(() => client.publish('wf', frame())).to.not.throw();
    await flush();
  });

  it('is a no-op when the ingest token is unset', async () => {
    const fake = new FakeFetch();
    make(fake, { ingestToken: undefined }).publish('wf', frame());
    await flush();
    expect(fake.calls).to.have.length(0);
  });

  it('is a no-op when the daemon port is not discoverable (readPort → null)', async () => {
    const fake = new FakeFetch();
    make(fake, { readPort: () => null }).publish('wf', frame());
    await flush();
    expect(fake.calls).to.have.length(0);
  });

  it('drops a frame exceeding the 32KB DOS backstop', async () => {
    const fake = new FakeFetch();
    const huge: InnerFrame = { type: 'inner.thinking', delta: 'x'.repeat(MAX_FRAME_BYTES + 100), kind: 'text' };
    make(fake).publish('wf', huge);
    await flush();
    expect(fake.calls).to.have.length(0);
  });
});

describe('inner-loop client — subscriberCount (presence)', () => {
  it('returns 0 before any presence GET resolves, then the cached count after', async () => {
    const fake = new FakeFetch();
    fake.enqueue(() => ({ status: 200, json: { subscribers: 3 } }));
    const client = make(fake);
    expect(client.subscriberCount('wf')).to.equal(0); // fires GET, cache still 0
    await flush();
    expect(client.subscriberCount('wf')).to.equal(3); // cache updated (same window → no 2nd GET)
    expect(fake.calls.filter((c) => c.url.endsWith('/presence'))).to.have.length(1);
  });

  it('GETs presence with the ingest-token header at the presence URL', async () => {
    const fake = new FakeFetch();
    fake.enqueue(() => ({ status: 200, json: { subscribers: 1 } }));
    const client = make(fake);
    client.subscriberCount('wf');
    await flush();
    const c = fake.calls[0];
    expect(c.method).to.equal('GET');
    expect(c.url).to.equal('http://127.0.0.1:8473/v1/players/ens/tempo-eng/inner/presence');
    expect(c.headers['X-Ingest-Token']).to.equal('tok-123');
  });

  it('rate-limits presence GETs to once per presencePollMs', async () => {
    const fake = new FakeFetch();
    let t = 1_000_000;
    const client = make(fake, { now: () => t, presencePollMs: 1000 });
    fake.enqueue(() => ({ status: 200, json: { subscribers: 2 } }));
    client.subscriberCount('wf');
    client.subscriberCount('wf');
    client.subscriberCount('wf');
    await flush();
    expect(fake.calls).to.have.length(1); // 3 calls, same window → 1 GET
    t += 1000; // advance past window
    fake.enqueue(() => ({ status: 200, json: { subscribers: 2 } }));
    client.subscriberCount('wf');
    await flush();
    expect(fake.calls).to.have.length(2);
  });

  it('treats a non-200 presence response (403) as 0 (fail-safe)', async () => {
    const fake = new FakeFetch();
    fake.enqueue(() => ({ status: 200, json: { subscribers: 5 } }));
    let t = 1_000_000;
    const client = make(fake, { now: () => t, presencePollMs: 1000 });
    client.subscriberCount('wf');
    await flush();
    expect(client.subscriberCount('wf')).to.equal(5);
    // Next window: a 403 must reset the cache to 0.
    t += 1000;
    fake.enqueue(() => ({ status: 403 }));
    client.subscriberCount('wf');
    await flush();
    expect(client.subscriberCount('wf')).to.equal(0);
  });

  it('treats a network error as 0 (fail-safe)', async () => {
    let reject = false;
    const fetchFn: InnerLoopFetch = (url) => reject
      ? Promise.reject(new Error('down'))
      : Promise.resolve({ status: 200, json: async () => ({ subscribers: 4 }) });
    let t = 1_000_000;
    const client = new InnerLoopHttpClient({
      ensemble: 'e', playerId: 'p', ingestToken: 'tok', readPort: () => 1, fetchFn, now: () => t, presencePollMs: 1000,
    });
    client.subscriberCount('wf');
    await flush();
    expect(client.subscriberCount('wf')).to.equal(4);
    t += 1000;
    reject = true;
    client.subscriberCount('wf');
    await flush();
    expect(client.subscriberCount('wf')).to.equal(0);
  });

  it('returns 0 and fires no GET when the token is unset', async () => {
    const fake = new FakeFetch();
    const client = make(fake, { ingestToken: undefined });
    expect(client.subscriberCount('wf')).to.equal(0);
    await flush();
    expect(fake.calls).to.have.length(0);
  });
});

describe('inner-loop client — env-token default', () => {
  it('reads the ingest token from AGENT_TEMPO_INGEST_TOKEN when not passed', async () => {
    const prev = process.env[INGEST_TOKEN_ENV];
    process.env[INGEST_TOKEN_ENV] = 'env-tok';
    try {
      const fake = new FakeFetch();
      const client = new InnerLoopHttpClient({ ensemble: 'e', playerId: 'p', readPort: () => 1, fetchFn: fake.fn, now: () => 0 });
      client.publish('wf', frame());
      await flush();
      expect(fake.calls[0].headers['X-Ingest-Token']).to.equal('env-tok');
    } finally {
      if (prev === undefined) delete process.env[INGEST_TOKEN_ENV];
      else process.env[INGEST_TOKEN_ENV] = prev;
    }
  });
});
