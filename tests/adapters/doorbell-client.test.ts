/**
 * T1.1 PR-2 — DoorbellClient + SdkAttachment doorbell wiring unit tests.
 *
 * Everything injected — no sockets, no timers beyond the identity-guard
 * test, no Temporal. The §5 failure table is the spec: every failure mode
 * must degrade to silent disconnected polling, indistinguishable from a
 * doorbell that never existed.
 */
import { describe, it, expect } from 'vitest';
import {
  DoorbellClient,
  DingParser,
  doorbellReconnectDelayMs,
  type DoorbellFetch,
} from '../../src/adapters/sdk/doorbell-client';
import {
  IdleBackoff,
  SDK_POLL_DOORBELL_MAX_MS,
  SDK_POLL_MAX_MS,
  resolveDoorbellCeilingMs,
} from '../../src/adapters/sdk/idle-backoff';

const enc = new TextEncoder();

/** Async-iterable SSE body from raw text chunks. */
function body(chunks: string[]): AsyncIterable<Uint8Array> {
  return (async function* () {
    for (const c of chunks) yield enc.encode(c);
  })();
}

describe('DingParser', () => {
  it('counts ding events and ignores keepalives / closed markers', () => {
    const p = new DingParser();
    expect(p.feed('event: ding\ndata: {}\n\n')).toBe(1);
    expect(p.feed(':ka\n\n')).toBe(0);
    expect(p.feed(':closed\n\n')).toBe(0);
  });

  it('handles events split across arbitrary chunk boundaries', () => {
    const p = new DingParser();
    expect(p.feed('event: di')).toBe(0);
    expect(p.feed('ng\ndata: {}\n')).toBe(0); // block not terminated yet
    expect(p.feed('\nevent: ding\ndata: {}\n\n')).toBe(2);
  });

  it('counts multiple dings in one chunk', () => {
    const p = new DingParser();
    expect(p.feed('event: ding\ndata: {}\n\nevent: ding\ndata: {}\n\n')).toBe(2);
  });
});

describe('doorbellReconnectDelayMs', () => {
  it('doubles from 1s and caps at 30s', () => {
    expect(doorbellReconnectDelayMs(0)).toBe(1_000);
    expect(doorbellReconnectDelayMs(1)).toBe(2_000);
    expect(doorbellReconnectDelayMs(5)).toBe(30_000);
    expect(doorbellReconnectDelayMs(1000)).toBe(30_000); // no overflow
  });
});

/** Common harness: scripted fetch outcomes + counting callbacks. */
function harness(outcomes: Array<
  | { kind: 'stream'; chunks: string[] }
  | { kind: 'status'; status: number }
  | { kind: 'reject' }
>, opts: { stopAfterSleeps?: number } = {}) {
  const dings: number[] = [];
  const transitions: boolean[] = [];
  const logs: string[] = [];
  const sleeps: number[] = [];
  let fetches = 0;
  const fetchFn: DoorbellFetch = async () => {
    const o = outcomes[Math.min(fetches, outcomes.length - 1)];
    fetches++;
    if (o.kind === 'reject') throw new Error('ECONNREFUSED');
    if (o.kind === 'status') return { status: o.status, body: null };
    return { status: 200, body: body(o.chunks) };
  };
  const client: DoorbellClient = new DoorbellClient({
    ensemble: 'ens',
    playerId: 'player',
    ingestToken: 'tok',
    readPort: () => 8473,
    fetchFn,
    sleep: async (ms) => {
      sleeps.push(ms);
      if (opts.stopAfterSleeps !== undefined && sleeps.length >= opts.stopAfterSleeps) {
        client.stop();
      }
    },
    log: (...a) => logs.push(a.map(String).join(' ')),
    onDing: () => dings.push(fetches),
    onConnectionChange: (c) => transitions.push(c),
  });
  return { client, dings, transitions, logs, sleeps, fetchCount: () => fetches };
}

describe('DoorbellClient', () => {
  it('no ingest token → never subscribes, one breadcrumb, no callbacks (§5 row 6)', async () => {
    let fetched = 0;
    const logs: string[] = [];
    const c = new DoorbellClient({
      ensemble: 'e',
      playerId: 'p',
      ingestToken: undefined,
      readPort: () => 8473,
      fetchFn: async () => { fetched++; return { status: 200, body: body([]) }; },
      log: (...a) => logs.push(a.map(String).join(' ')),
      onDing: () => { throw new Error('must not ding'); },
    });
    c.start();
    await new Promise((r) => setTimeout(r, 10));
    expect(fetched).toBe(0);
    expect(logs.some((l) => l.includes('doorbell disabled'))).toBe(true);
    c.stop();
  });

  it('delivers dings and fires connected/disconnected transitions', async () => {
    const h = harness(
      [{ kind: 'stream', chunks: ['event: ding\ndata: {}\n\n', ':ka\n\n', 'event: ding\ndata: {}\n\n'] }],
      { stopAfterSleeps: 1 },
    );
    h.client.start();
    await new Promise((r) => setTimeout(r, 25));
    expect(h.dings.length).toBe(2);
    expect(h.transitions).toEqual([true, false]); // open → stream end
    expect(h.logs.filter((l) => l.includes('doorbell connected')).length).toBe(1);
    expect(h.logs.filter((l) => l.includes('doorbell disconnected')).length).toBe(1);
  });

  it('403 from the route → silent disconnected retry, no dings, no transitions (§5 row 5)', async () => {
    const h = harness([{ kind: 'status', status: 403 }], { stopAfterSleeps: 3 });
    h.client.start();
    await new Promise((r) => setTimeout(r, 25));
    expect(h.dings.length).toBe(0);
    expect(h.transitions).toEqual([]); // never connected — nothing to transition
    expect(h.fetchCount()).toBe(3);
    // Reconnect backoff grows while never-connected.
    expect(h.sleeps).toEqual([1_000, 2_000, 4_000]);
  });

  it('connect refused → same silent retry path (§5 row 4)', async () => {
    const h = harness([{ kind: 'reject' }], { stopAfterSleeps: 2 });
    h.client.start();
    await new Promise((r) => setTimeout(r, 25));
    expect(h.dings.length).toBe(0);
    expect(h.transitions).toEqual([]);
    expect(h.sleeps).toEqual([1_000, 2_000]);
  });

  it('port file missing → no fetch at all, retries until the daemon appears (§5 row 4)', async () => {
    let fetched = 0;
    const sleeps: number[] = [];
    // eslint-disable-next-line prefer-const
    let c: DoorbellClient;
    c = new DoorbellClient({
      ensemble: 'e',
      playerId: 'p',
      ingestToken: 'tok',
      readPort: () => null,
      fetchFn: async () => { fetched++; return { status: 200, body: body([]) }; },
      sleep: async (ms) => { sleeps.push(ms); if (sleeps.length >= 2) c.stop(); },
      log: () => {},
      onDing: () => {},
    });
    c.start();
    await new Promise((r) => setTimeout(r, 25));
    expect(fetched).toBe(0);
    expect(sleeps.length).toBe(2);
  });

  it('a stream that opened resets the reconnect curve (healthy daemon bounce ⇒ 1s re-subscribe)', async () => {
    const h = harness(
      [
        { kind: 'reject' },
        { kind: 'reject' },
        { kind: 'stream', chunks: [':ka\n\n'] }, // opens, then ends
        { kind: 'reject' },
      ],
      { stopAfterSleeps: 4 },
    );
    h.client.start();
    await new Promise((r) => setTimeout(r, 25));
    // fail(1s), fail(2s), open-then-end(reset ⇒ 1s), fail(2s)
    expect(h.sleeps).toEqual([1_000, 2_000, 1_000, 2_000]);
  });

  it('an onDing throw is swallowed — the doorbell can never escalate (§5 invariant)', async () => {
    const logs: string[] = [];
    const transitions: boolean[] = [];
    // eslint-disable-next-line prefer-const
    let c: DoorbellClient;
    let sleeps = 0;
    c = new DoorbellClient({
      ensemble: 'e',
      playerId: 'p',
      ingestToken: 'tok',
      readPort: () => 8473,
      fetchFn: async () => ({ status: 200, body: body(['event: ding\ndata: {}\n\n']) }),
      sleep: async () => { sleeps++; if (sleeps >= 1) c.stop(); },
      log: (...a) => logs.push(a.map(String).join(' ')),
      onDing: () => { throw new Error('consumer bug'); },
      onConnectionChange: (x) => transitions.push(x),
    });
    c.start();
    await new Promise((r) => setTimeout(r, 25));
    expect(logs.some((l) => l.includes('onDing threw'))).toBe(true);
    expect(transitions).toEqual([true, false]); // stream still completed normally
  });
});

describe('IdleBackoff doorbell ceiling (T1.1)', () => {
  it('setCeiling raises the idle cap to the doorbell ceiling and restores the T0.2 floor', () => {
    const b = new IdleBackoff({ baseMs: 2_000, factor: 2, maxMs: SDK_POLL_MAX_MS });
    b.setCeiling(SDK_POLL_DOORBELL_MAX_MS);
    let d = 0;
    for (let i = 0; i < 10; i++) d = b.next(false);
    expect(d).toBe(SDK_POLL_DOORBELL_MAX_MS); // grows past 30s to 60s while connected
    // Disconnect: ceiling back to 30s — an inflated current self-heals on next().
    b.setCeiling(SDK_POLL_MAX_MS);
    expect(b.next(false)).toBe(SDK_POLL_MAX_MS);
  });

  it('setCeiling clamps to ≥ base so the curve cannot invert', () => {
    const b = new IdleBackoff({ baseMs: 2_000, factor: 2, maxMs: 30_000 });
    b.setCeiling(1); // nonsense override
    expect(b.next(false)).toBe(2_000);
  });

  it('constructor copies the config — setCeiling never writes through to a shared object', () => {
    const cfg = { baseMs: 2_000, factor: 2, maxMs: 30_000 };
    const b = new IdleBackoff(cfg);
    b.setCeiling(60_000);
    expect(cfg.maxMs).toBe(30_000);
  });

  it('resolveDoorbellCeilingMs defaults to 60s', () => {
    expect(resolveDoorbellCeilingMs()).toBe(SDK_POLL_DOORBELL_MAX_MS);
  });
});

// ── SdkAttachment pollSleep / wakePollSleep ───────────────────────────────
import { SdkAttachment } from '../../src/adapters/sdk/base';
import type { AdapterDescriptor } from '../../src/types';

class TestAttachment extends SdkAttachment {
  readonly descriptor: AdapterDescriptor = {
    adapterId: 'test',
    adapterClass: 'sdk',
    blocksOnLLMTurn: true,
    heartbeatMs: 30_000,
  };
  protected onSuperseded(): void { /* no-op */ }
  sleepPub(ms: number): Promise<void> { return this.pollSleep(ms); }
  wakePub(): void { this.wakePollSleep(); }
}

/** Resolve-order probe: resolves true if `p` settles within `ms`. */
async function settlesWithin(p: Promise<void>, ms: number): Promise<boolean> {
  let timer: NodeJS.Timeout;
  const timedOut = new Promise<boolean>((r) => { timer = setTimeout(() => r(false), ms); });
  const settled = p.then(() => true);
  const result = await Promise.race([settled, timedOut]);
  clearTimeout(timer!);
  return result;
}

describe('SdkAttachment pollSleep (T1.1)', () => {
  it('a wake (ding) ends a parked sleep immediately', async () => {
    const a = new TestAttachment();
    const sleep = a.sleepPub(60_000);
    a.wakePub();
    expect(await settlesWithin(sleep, 100)).toBe(true);
  });

  it('a wake while mid-tick (no parked sleep) makes the NEXT sleep return instantly — hints are consumed, not lost', async () => {
    const a = new TestAttachment();
    a.wakePub(); // ding lands while the loop is processing
    expect(await settlesWithin(a.sleepPub(60_000), 100)).toBe(true);
    // The bit was consumed — a subsequent sleep parks normally.
    expect(await settlesWithin(a.sleepPub(60_000), 50)).toBe(false);
  });

  it('without a wake, pollSleep behaves like a plain sleep', async () => {
    const a = new TestAttachment();
    expect(await settlesWithin(a.sleepPub(10), 500)).toBe(true);
  });

  it('a stale abandoned sleep cannot clobber a newer sleep\'s waker (identity guard)', async () => {
    const a = new TestAttachment();
    const abandoned = a.sleepPub(20); // slot overwritten by the next call
    const live = a.sleepPub(60_000);
    await abandoned; // its timer fires — must NOT null the live waker
    a.wakePub();
    expect(await settlesWithin(live, 100)).toBe(true);
  });
});
