/**
 * Cue pump combined intake (T0.3 of #747, #750) — unit tests driving `tick()`
 * with a fake `IntakeSource` (no live Pi / Temporal).
 *
 * Locks the transport-only contract:
 *   - with `intakeSource`, a tick issues ONE combined fetch and ZERO legacy
 *     `fetchPending` / `fetchPendingReset` calls (the 2→1 action win);
 *   - reset-before-cues ordering survives — with BOTH pending in one tick,
 *     the clean-wipe (`newSession`) lands BEFORE the cue is injected, so the
 *     cue arrives into the fresh context (D14 + S3 semantics);
 *   - acks are unchanged (`ackReset(resetId)` id flows through; delivered
 *     cue ids ack via the cue source);
 *   - without `intakeSource`, the legacy two-fetch path still runs (old
 *     callers / pre-#750 fallback configuration);
 *   - a combined-fetch failure fails only that tick — the next tick retries
 *     (re-entrancy guard released).
 */
import { expect } from 'chai';
import {
  CuePump,
  type CueSource,
  type ResetSource,
  type IntakeSource,
  type MessageInjector,
} from '../src/pi/cue-pump';
import type { Message, PendingReset } from '../src/types';
import type { PiAgentSession, PiOutboundMessage, PiCustomMessageOptions } from '../src/pi/pi-types';

const MSG = (over: Partial<Message> = {}): Message => ({
  id: 'm1',
  from: 'alice',
  text: 'hello',
  timestamp: '2026-06-11T00:00:00Z',
  delivered: false,
  ...over,
});

const PR = (over: Partial<PendingReset> = {}): PendingReset => ({
  resetId: 'r1',
  fresh: true,
  requestedBy: 'tempo-conductor',
  requestedAt: '2026-06-11T00:00:00Z',
  ...over,
});

/** Cue source that counts legacy fetches and records acks. */
function countingCueSource(pending: Message[] = []) {
  const src = {
    fetches: 0,
    acked: [] as string[][],
    async fetchPending(): Promise<Message[]> { src.fetches += 1; return pending; },
    async ackDelivered(ids: string[]): Promise<void> { if (ids.length > 0) src.acked.push(ids); },
  };
  return src as CueSource & { fetches: number; acked: string[][] };
}

/** Reset source that counts legacy fetches and records acks. */
function countingResetSource(reset: PendingReset | null = null) {
  const src = {
    fetches: 0,
    acked: [] as string[],
    async fetchPendingReset(): Promise<PendingReset | null> { src.fetches += 1; return reset; },
    async ackReset(id: string): Promise<void> { src.acked.push(id); },
  };
  return src as ResetSource & { fetches: number; acked: string[] };
}

function countingIntakeSource(messages: Message[], pendingReset: PendingReset | null) {
  const src = {
    fetches: 0,
    async fetchIntake() { src.fetches += 1; return { messages, pendingReset }; },
  };
  return src as IntakeSource & { fetches: number };
}

/** Ordered event log shared between the fake session (wipe) and injector (cues). */
function instrumentedTargets(events: string[]) {
  const session: PiAgentSession = {
    sendCustomMessage: () => { /* reset notice — not order-relevant */ },
    newSession: () => { events.push('wipe'); },
  };
  const injector: MessageInjector = {
    inject: (msg: PiOutboundMessage, _opts: PiCustomMessageOptions) => {
      events.push(`inject:${String(msg.content)}`);
    },
    lastTurnStartAt: () => Date.now(), // a turn "just started" — no escalation noise
  };
  return { session, injector };
}

describe('CuePump combined intake (#750)', () => {
  it('one combined fetch per tick; legacy fetches NOT called', async () => {
    const cueSource = countingCueSource();
    const resetSource = countingResetSource();
    const intake = countingIntakeSource([], null);
    const pump = new CuePump({
      source: cueSource,
      resetSource,
      intakeSource: intake,
      resolveInjector: () => null,
    });

    await pump.tick();
    await pump.tick();

    expect(intake.fetches).to.equal(2);          // 1 per tick
    expect(cueSource.fetches).to.equal(0);       // legacy cue fetch bypassed
    expect(resetSource.fetches).to.equal(0);     // legacy reset fetch bypassed
  });

  it('reset + cues in the SAME tick: wipe lands BEFORE the cue injection, both ack', async () => {
    const events: string[] = [];
    const { session, injector } = instrumentedTargets(events);
    const cueSource = countingCueSource();
    const resetSource = countingResetSource();
    const msg = MSG({ text: 'post-wipe cue' });
    const intake = countingIntakeSource([msg], PR());

    const pump = new CuePump({
      source: cueSource,
      resetSource,
      intakeSource: intake,
      resolveInjector: () => injector,
      resolveSession: () => session,
    });
    await pump.tick();

    // Ordering: clean-wipe strictly before the cue hits the (fresh) session.
    expect(events[0]).to.equal('wipe');
    expect(events.some((e) => e.startsWith('inject:') && e.includes('post-wipe cue'))).to.equal(true);
    expect(events.indexOf('wipe')).to.be.lessThan(
      events.findIndex((e) => e.startsWith('inject:')),
    );

    // Acks unchanged: reset by id via resetSource; cue ids via cue source.
    expect(resetSource.acked).to.deep.equal(['r1']);
    expect(cueSource.acked).to.deep.equal([[msg.id]]);
  });

  it('without intakeSource the legacy two-fetch path still runs (pre-#750 config)', async () => {
    const cueSource = countingCueSource();
    const resetSource = countingResetSource();
    const pump = new CuePump({
      source: cueSource,
      resetSource,
      resolveInjector: () => null,
    });

    await pump.tick();
    expect(cueSource.fetches).to.equal(1);
    expect(resetSource.fetches).to.equal(1);
  });

  it('a combined-fetch failure fails only that tick — the next tick retries', async () => {
    let calls = 0;
    const intake: IntakeSource = {
      fetchIntake: async () => {
        calls += 1;
        if (calls === 1) throw new Error('transient query failure');
        return { messages: [], pendingReset: null };
      },
    };
    const pump = new CuePump({
      source: countingCueSource(),
      resetSource: countingResetSource(),
      intakeSource: intake,
      resolveInjector: () => null,
    });

    let firstTickError: unknown = null;
    await pump.tick().catch((err) => { firstTickError = err; });
    expect((firstTickError as Error)?.message).to.contain('transient query failure');

    // Re-entrancy guard released — the next tick proceeds normally.
    await pump.tick();
    expect(calls).to.equal(2);
  });

  it('known-empty prefetched reset (null) skips the legacy reset fetch entirely', async () => {
    const resetSource = countingResetSource(PR()); // would return a reset if asked…
    const intake = countingIntakeSource([], null); // …but the combined fetch says empty
    const pump = new CuePump({
      source: countingCueSource(),
      resetSource,
      intakeSource: intake,
      resolveInjector: () => null,
    });

    await pump.tick();
    expect(resetSource.fetches).to.equal(0); // null means KNOWN empty — no second ask
    expect(resetSource.acked).to.be.empty;
  });
});
