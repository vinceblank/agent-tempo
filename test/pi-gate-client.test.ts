/**
 * Unit tests for the gate poll-bridge client (src/pi/gate-client.ts, 3d MD-G) —
 * the subprocess side that polls the daemon for the operator's decision.
 *
 * Driven WITHOUT a real daemon: an injected fetch returns controllable
 * resolutions; an injected clock + sleep make the poll loop + timeout
 * deterministic (sleep advances the clock so the bounded loop terminates fast).
 */
import { expect } from 'chai';
import { GateClient, type GateFetch } from '../src/pi/gate-client';

const E = 'demo';
const P = 'tempo-pi';
const RID = 'req-1';

interface Resp { status: number; json?: unknown }

/** A controllable clock; `sleep` advances it so the timeout loop is deterministic. */
function clock(start = 0) {
  let t = start;
  return {
    now: () => t,
    sleep: (ms: number) => { t += ms; return Promise.resolve(); },
    advance: (ms: number) => { t += ms; },
  };
}

/** Fetch that replays a queue of responses (last one repeats). */
function fakeFetch(queue: Resp[]): { fn: GateFetch; calls: string[] } {
  const calls: string[] = [];
  let i = 0;
  const fn: GateFetch = (url) => {
    calls.push(url);
    const r = queue[Math.min(i, queue.length - 1)];
    i++;
    return Promise.resolve({ status: r.status, json: async () => r.json ?? {} });
  };
  return { fn, calls };
}

function client(over: Partial<ConstructorParameters<typeof GateClient>[0]> = {}) {
  const c = clock();
  const gc = new GateClient({
    ensemble: E, playerId: P, ingestToken: 'tok', readPort: () => 1234,
    now: c.now, sleep: c.sleep, pollIntervalMs: 1000, timeoutMs: 50000,
    ...over,
  });
  return { gc, c };
}

describe('GateClient.awaitDecision', () => {
  it('resolved allow → allow', async () => {
    const { fn } = fakeFetch([{ status: 200, json: { status: 'resolved', decision: 'allow', source: 'operator' } }]);
    const { gc } = client({ fetchFn: fn });
    expect(await gc.awaitDecision(RID)).to.equal('allow');
  });

  it('resolved deny → deny (the only blocking effect)', async () => {
    const { fn } = fakeFetch([{ status: 200, json: { status: 'resolved', decision: 'deny', source: 'operator' } }]);
    const { gc } = client({ fetchFn: fn });
    expect(await gc.awaitDecision(RID)).to.equal('deny');
  });

  it('resolved auto-allow → allow', async () => {
    const { fn } = fakeFetch([{ status: 200, json: { status: 'resolved', decision: 'auto-allow', source: 'timeout' } }]);
    const { gc } = client({ fetchFn: fn });
    expect(await gc.awaitDecision(RID)).to.equal('allow');
  });

  it('polls through pending → resolves when the operator decides', async () => {
    const { fn, calls } = fakeFetch([
      { status: 200, json: { status: 'pending' } },
      { status: 200, json: { status: 'pending' } },
      { status: 200, json: { status: 'resolved', decision: 'deny', source: 'operator' } },
    ]);
    const { gc } = client({ fetchFn: fn });
    expect(await gc.awaitDecision(RID)).to.equal('deny');
    expect(calls.length).to.equal(3);
  });

  it('404 (registration race) is retried, not treated as a decision', async () => {
    const { fn } = fakeFetch([
      { status: 404 },
      { status: 200, json: { status: 'resolved', decision: 'allow', source: 'operator' } },
    ]);
    const { gc } = client({ fetchFn: fn });
    expect(await gc.awaitDecision(RID)).to.equal('allow');
  });

  it('no ingest token → immediate allow (gate is a daemon-mediated feature)', async () => {
    const { fn, calls } = fakeFetch([{ status: 200, json: { status: 'resolved', decision: 'deny' } }]);
    const { gc } = client({ fetchFn: fn, ingestToken: undefined });
    expect(await gc.awaitDecision(RID)).to.equal('allow');
    expect(calls.length).to.equal(0); // never hit the wire
  });

  it('timeout (daemon unreachable / always pending) → allow (autonomous-first), bounded', async () => {
    const { fn, calls } = fakeFetch([{ status: 200, json: { status: 'pending' } }]);
    const { gc } = client({ fetchFn: fn, pollIntervalMs: 1000, timeoutMs: 5000 });
    expect(await gc.awaitDecision(RID)).to.equal('allow');
    // ~5 polls (5000/1000) before the deadline — bounded, not infinite.
    expect(calls.length).to.be.greaterThan(0).and.lessThan(8);
  });

  it('an aborted signal → allow, stops polling (never blocks a dying turn)', async () => {
    const { fn, calls } = fakeFetch([{ status: 200, json: { status: 'pending' } }]);
    const { gc } = client({ fetchFn: fn });
    const ac = new AbortController();
    ac.abort();
    expect(await gc.awaitDecision(RID, { signal: ac.signal })).to.equal('allow');
    expect(calls.length).to.equal(0); // aborted before the first poll
  });

  it('null port (daemon HTTP down) is retried, then times out to allow', async () => {
    const { fn } = fakeFetch([{ status: 200, json: { status: 'pending' } }]);
    const { gc } = client({ fetchFn: fn, readPort: () => null, timeoutMs: 3000 });
    expect(await gc.awaitDecision(RID)).to.equal('allow');
  });
});
