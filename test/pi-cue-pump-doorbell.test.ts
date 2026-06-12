/**
 * T1.1 PR-3 — cue-pump doorbell + idle-backoff tests.
 *
 * The MED-risk surface per the design doc: #677 escalation/re-entrancy. The
 * load-bearing assertions here:
 *   - ding-during-tick COALESCES to exactly one immediate follow-up tick,
 *     never a concurrent tick (the sequential loop is the structural
 *     guarantee; these tests pin it);
 *   - D14 reset-priority survives — a ding-triggered tick still processes
 *     pendingReset BEFORE injecting cues;
 *   - tick() activity reporting drives the backoff curve (cues / pending
 *     reset / left-pending reset ⇒ base cadence; empty ⇒ stretch);
 *   - real-wire e2e: pump + DoorbellClient against PR-1's actual route +
 *     registry + token mint — ring ⇒ sub-second injection from a stretched
 *     pump.
 */
import { expect } from 'chai';
import * as http from 'http';
import type { AddressInfo } from 'net';
import { CuePump, type MessageInjector } from '../src/pi/cue-pump';
import { IdleBackoff } from '../src/adapters/sdk/idle-backoff';
import { handleDoorbellSse } from '../src/http/doorbell-routes';
import { DoorbellRegistry } from '../src/http/doorbell';
import { IngestTokenRegistry } from '../src/http/ingest-registry';
import { sessionWorkflowId } from '../src/config';
import type { Message, PendingReset } from '../src/types';

const msg = (id: string, text = `text-${id}`): Message =>
  ({ id, from: 'peer', text } as unknown as Message);

/** Controllable intake + cue/reset sources with call accounting. */
function fakeSources(opts: { messages?: Message[][]; pendingReset?: PendingReset | null } = {}) {
  const batches = opts.messages ?? [];
  let fetchCount = 0;
  let inFlight = 0;
  let maxInFlight = 0;
  const acked: string[][] = [];
  const resetAcks: string[] = [];
  /** Optional gate — when set, fetchIntake parks until released (slow-tick simulation). */
  let gate: (() => void) | null = null;
  const gatePromise: { current: Promise<void> | null } = { current: null };
  return {
    source: {
      fetchPending: async () => batches.shift() ?? [],
      ackDelivered: async (ids: string[]) => { if (ids.length) acked.push(ids); },
    },
    resetSource: {
      fetchPendingReset: async () => opts.pendingReset ?? null,
      ackReset: async (id: string) => { resetAcks.push(id); },
    },
    intakeSource: {
      fetchIntake: async () => {
        fetchCount++;
        inFlight++;
        maxInFlight = Math.max(maxInFlight, inFlight);
        if (gatePromise.current) await gatePromise.current;
        inFlight--;
        const pr = opts.pendingReset ?? null;
        if (opts.pendingReset !== undefined) opts.pendingReset = null; // one-shot reset
        return { messages: batches.shift() ?? [], pendingReset: pr };
      },
    },
    holdNextFetches: () => {
      gatePromise.current = new Promise<void>((r) => { gate = r; });
    },
    releaseFetches: () => {
      gatePromise.current = null;
      gate?.();
      gate = null;
    },
    stats: () => ({ fetchCount, maxInFlight, acked, resetAcks }),
  };
}

function recordingInjector(): { injector: MessageInjector; injected: string[] } {
  const injected: string[] = [];
  return {
    injected,
    injector: {
      inject: async (m) => { injected.push(String(m.content)); },
      lastTurnStartAt: () => Date.now(), // turns always "started" — no escalation noise
    },
  };
}

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

describe('CuePump — T1.1 idle backoff activity reporting', function () {
  it('tick() returns false on an empty intake, true when cues are pending', async function () {
    const s = fakeSources({ messages: [[msg('a')], []] });
    const { injector } = recordingInjector();
    const pump = new CuePump({
      source: s.source,
      intakeSource: s.intakeSource,
      resolveInjector: () => injector,
    });
    expect(await pump.tick()).to.equal(true);  // batch ['a']
    expect(await pump.tick()).to.equal(false); // empty
  });

  it('tick() reports activity when cues are HELD (no injector) — fast retry while attaching', async function () {
    const s = fakeSources({ messages: [[msg('a')]] });
    const pump = new CuePump({
      source: s.source,
      intakeSource: s.intakeSource,
      resolveInjector: () => null,
    });
    expect(await pump.tick()).to.equal(true);
    expect(s.stats().acked).to.deep.equal([]); // held, not acked
  });

  it('tick() reports activity for a pending reset, including the left-pending branch (nothing attached)', async function () {
    const pr: PendingReset = { resetId: 'r1', fresh: true } as PendingReset;
    const s = fakeSources({ pendingReset: pr });
    const pump = new CuePump({
      source: s.source,
      resetSource: s.resetSource,
      intakeSource: s.intakeSource,
      resolveInjector: () => null, // nothing attached — reset stays pending
    });
    expect(await pump.tick()).to.equal(true);
    expect(s.stats().resetAcks).to.deep.equal([]); // branch 5: left pending
  });

  it('ding() snaps an injected backoff back to base', function () {
    const backoff = new IdleBackoff({ baseMs: 1_000, factor: 2, maxMs: 30_000 });
    const pump = new CuePump({
      source: fakeSources().source,
      resolveInjector: () => null,
      backoff,
    });
    for (let i = 0; i < 6; i++) backoff.next(false);
    expect(backoff.current).to.equal(30_000);
    pump.ding();
    expect(backoff.current).to.equal(1_000);
    pump.stop();
  });
});

describe('CuePump — ding-during-tick coalescing (#677 re-entrancy)', function () {
  it('dings landing mid-tick coalesce into EXACTLY one immediate follow-up tick, never concurrent', async function () {
    const s = fakeSources({ messages: [[], [], []] });
    const { injector } = recordingInjector();
    const pump = new CuePump({
      source: s.source,
      intakeSource: s.intakeSource,
      resolveInjector: () => injector,
      intervalMs: 60_000, // without a ding, the loop would sleep a minute between ticks
    });

    s.holdNextFetches(); // first tick will park inside fetchIntake
    pump.start();
    await until(() => s.stats().fetchCount === 1); // tick 1 is mid-flight

    pump.ding();
    pump.ding(); // a second mid-tick ding must coalesce with the first
    await sleep(20);
    expect(s.stats().fetchCount).to.equal(1); // still mid-tick — nothing concurrent

    s.releaseFetches();
    // The coalesced wake yields exactly ONE immediate follow-up tick…
    await until(() => s.stats().fetchCount === 2);
    await sleep(50);
    // …and only one: tick 3 would otherwise wait the 60s backoff delay.
    expect(s.stats().fetchCount).to.equal(2);
    expect(s.stats().maxInFlight).to.equal(1); // NEVER overlapped
    pump.stop();
  });

  it('a ding while the loop SLEEPS triggers the next tick immediately', async function () {
    const s = fakeSources({ messages: [[], [msg('cued')]] });
    const { injector, injected } = recordingInjector();
    const pump = new CuePump({
      source: s.source,
      intakeSource: s.intakeSource,
      resolveInjector: () => injector,
      intervalMs: 60_000,
    });
    pump.start();
    await until(() => s.stats().fetchCount === 1); // first (empty) tick done; loop sleeping ~60s
    pump.ding();
    await until(() => injected.length === 1); // sub-second injection, not 60s
    expect(injected[0]).to.include('cued');
    pump.stop();
  });
});

describe('CuePump — D14 reset-priority on ding-triggered ticks', function () {
  it('a ding-triggered tick still processes pendingReset BEFORE injecting cues', async function () {
    const order: string[] = [];
    const pr: PendingReset = { resetId: 'r-ding', fresh: true } as PendingReset;
    let pendingReset: PendingReset | null = null;
    let batch: Message[] = [];
    const pump = new CuePump({
      source: {
        fetchPending: async () => [],
        ackDelivered: async (ids) => { if (ids.length) order.push(`ack:${ids.join(',')}`); },
      },
      resetSource: {
        fetchPendingReset: async () => pendingReset,
        ackReset: async (id) => { order.push(`resetAck:${id}`); },
      },
      intakeSource: {
        fetchIntake: async () => {
          const out = { messages: batch, pendingReset };
          pendingReset = null;
          batch = [];
          return out;
        },
      },
      resolveInjector: () => ({
        inject: async (m) => { order.push(`inject:${String(m.content)}`); },
        lastTurnStartAt: () => Date.now(),
      }),
      // Session-capable → auto clean-wipe route.
      resolveSession: () => ({
        newSession: async () => { order.push('wipe'); },
        sendCustomMessage: async () => { /* post-wipe notice */ },
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      }) as any,
      intervalMs: 60_000,
    });

    pump.start();
    await sleep(30); // first (empty) tick completes; loop is now sleeping ~60s

    // A cue delivery + reset land together; the daemon rings.
    pendingReset = pr;
    batch = [msg('after-reset')];
    pump.ding();

    await until(() => order.some((o) => o.startsWith('ack:')));
    const wipeIdx = order.indexOf('wipe');
    const injectIdx = order.findIndex((o) => o.startsWith('inject:'));
    expect(wipeIdx).to.be.greaterThan(-1);
    expect(injectIdx).to.be.greaterThan(-1);
    expect(wipeIdx).to.be.lessThan(injectIdx); // reset BEFORE cue, even on a ding tick
    expect(order.indexOf('resetAck:r-ding')).to.be.lessThan(injectIdx);
    pump.stop();
  });
});

describe('CuePump — real-wire doorbell e2e (PR-1 route + registry + token mint)', function () {
  const E = 'demo';
  const P = 'pi-player';
  const WF = sessionWorkflowId(E, P);

  it('a registry ring reaches a stretched pump as a sub-second injection', async function () {
    const doorbells = new DoorbellRegistry();
    const ingestTokens = new IngestTokenRegistry();
    const token = ingestTokens.mint(WF);
    const server = http.createServer((req, res) => {
      const m = /^\/doorbell\/([^/]+)\/([^/]+)$/.exec(req.url ?? '');
      if (!m) { res.writeHead(404).end(); return; }
      void handleDoorbellSse(req, res, { doorbells, ingestTokens }, decodeURIComponent(m[1]), decodeURIComponent(m[2]));
    });
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    const port = (server.address() as AddressInfo).port;

    const s = fakeSources({ messages: [[], [msg('rang')]] });
    const { injector, injected } = recordingInjector();
    const pump = new CuePump({
      source: s.source,
      intakeSource: s.intakeSource,
      resolveInjector: () => injector,
      intervalMs: 60_000, // without the doorbell, the second tick is a minute away
      doorbell: { ensemble: E, playerId: P, ingestToken: token, readPort: () => port },
    });
    try {
      pump.start();
      await until(() => doorbells.subscriberCount(WF) === 1); // stream is live
      await until(() => s.stats().fetchCount === 1);          // first (empty) tick done

      doorbells.ring(E, P); // the daemon-side moment a cue lands durably
      await until(() => injected.length === 1);
      expect(injected[0]).to.include('rang');
    } finally {
      pump.stop();
      doorbells.close();
      await new Promise<void>((r) => server.close(() => r()));
    }
  });
});

/** Poll until `cond` or 2s. */
async function until(cond: () => boolean, ms = 2_000): Promise<void> {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    if (cond()) return;
    await sleep(10);
  }
  if (!cond()) throw new Error('until: condition not met within timeout');
}
