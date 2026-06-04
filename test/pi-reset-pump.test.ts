/**
 * Unit tests for the reset pump (src/pi/reset-pump.ts, 3d D14) — drives `tick()`
 * directly with a fake source + fake session (no live Pi / Temporal).
 */
import { expect } from 'chai';
import { ResetPump, type ResetSource } from '../src/pi/reset-pump';
import type { PendingReset } from '../src/types';
import type { PiAgentSession, PiOutboundMessage, PiCustomMessageOptions } from '../src/pi/pi-types';

function fakeSession(over: Partial<PiAgentSession> = {}) {
  const calls = { newSession: 0, messages: [] as { msg: PiOutboundMessage; opts?: PiCustomMessageOptions }[] };
  const session: PiAgentSession = {
    sendCustomMessage: (msg, opts) => { calls.messages.push({ msg, opts }); },
    newSession: () => { calls.newSession += 1; },
    ...over,
  };
  return { session, calls };
}

function fakeSource(reset: PendingReset | null) {
  const acked: string[] = [];
  const source: ResetSource = {
    fetchPendingReset: async () => reset,
    ackReset: async (id) => { acked.push(id); },
  };
  return { source, acked };
}

const PR = (over: Partial<PendingReset> = {}): PendingReset => ({
  resetId: 'r1', fresh: true, requestedBy: 'tempo-conductor', requestedAt: '2026-06-04T00:00:00Z', ...over,
});

describe('ResetPump.tick', () => {
  it('no pending reset → no wipe, no ack', async () => {
    const { source, acked } = fakeSource(null);
    const { session, calls } = fakeSession();
    const pump = new ResetPump({ source, resolveSession: () => session });
    await pump.tick();
    expect(calls.newSession).to.equal(0);
    expect(acked).to.be.empty;
  });

  it('pending fresh reset + live session → newSession() + notice + ack', async () => {
    const { source, acked } = fakeSource(PR());
    const { session, calls } = fakeSession();
    const pump = new ResetPump({ source, resolveSession: () => session });
    await pump.tick();
    expect(calls.newSession).to.equal(1);
    expect(acked).to.deep.equal(['r1']);
    // notice injected (non-triggering), surfacing requestedBy
    expect(calls.messages).to.have.length(1);
    expect(calls.messages[0].opts?.triggerTurn).to.equal(false);
    expect(String(calls.messages[0].msg.content)).to.contain('tempo-conductor');
  });

  it('pending but NO live session → no wipe, no ack (retry next tick)', async () => {
    const { source, acked } = fakeSource(PR());
    const pump = new ResetPump({ source, resolveSession: () => null });
    await pump.tick();
    expect(acked).to.be.empty;
  });

  it('fresh=false → no wipe, but ack to clear the slot (no infinite re-poll)', async () => {
    const { source, acked } = fakeSource(PR({ fresh: false }));
    const { session, calls } = fakeSession();
    const pump = new ResetPump({ source, resolveSession: () => session });
    await pump.tick();
    expect(calls.newSession).to.equal(0);
    expect(acked).to.deep.equal(['r1']); // acked anyway (clear), no wipe
  });

  it('session without newSession() → no wipe, still acks', async () => {
    const { source, acked } = fakeSource(PR());
    const { session, calls } = fakeSession({ newSession: undefined });
    const pump = new ResetPump({ source, resolveSession: () => session });
    await pump.tick();
    expect(calls.newSession).to.equal(0);
    expect(acked).to.deep.equal(['r1']);
  });

  it('notice injection failure is non-fatal — wipe + ack still happen', async () => {
    const { source, acked } = fakeSource(PR());
    const { session, calls } = fakeSession({
      sendCustomMessage: () => { throw new Error('inject boom'); },
    });
    const pump = new ResetPump({ source, resolveSession: () => session });
    await pump.tick();
    expect(calls.newSession).to.equal(1);
    expect(acked).to.deep.equal(['r1']);
  });
});
