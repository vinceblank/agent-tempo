/**
 * Unit tests for the reset pump (src/pi/reset-pump.ts, 3d D14 + #677 PART B) —
 * drives `tick()` directly with a fake source + fake session/pi (no live Pi /
 * Temporal). Covers the capability branch:
 *   - headless / session-capable → auto clean-wipe (session.newSession) + ack
 *   - interactive (no session, pi present) → operator notice (run /tempo-reset),
 *     id-matched notify-once, ACK-ON-NOTIFY
 */
import { expect } from 'chai';
import { ResetPump, type ResetSource } from '../src/pi/reset-pump';
import type { PendingReset } from '../src/types';
import type {
  ExtensionAPI,
  PiAgentSession,
  PiOutboundMessage,
  PiCustomMessageOptions,
} from '../src/pi/pi-types';

function fakeSession(over: Partial<PiAgentSession> = {}) {
  const calls = { newSession: 0, messages: [] as { msg: PiOutboundMessage; opts?: PiCustomMessageOptions }[] };
  const session: PiAgentSession = {
    sendCustomMessage: (msg, opts) => { calls.messages.push({ msg, opts }); },
    newSession: () => { calls.newSession += 1; },
    ...over,
  };
  return { session, calls };
}

/** Records pi.sendMessage(msg, opts) — the interactive operator-notice route. */
function fakePi() {
  const sent: { msg: PiOutboundMessage; opts?: PiCustomMessageOptions }[] = [];
  const pi = {
    on: () => { /* unused */ },
    registerTool: () => { /* unused */ },
    sendMessage: (msg: PiOutboundMessage, opts?: PiCustomMessageOptions) => { sent.push({ msg, opts }); },
  } as unknown as ExtensionAPI;
  return { pi, sent };
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

describe('ResetPump.tick — session-capable (headless) clean-wipe', () => {
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

  it('fresh=false → no wipe, but ack to clear the slot (no infinite re-poll)', async () => {
    const { source, acked } = fakeSource(PR({ fresh: false }));
    const { session, calls } = fakeSession();
    const pump = new ResetPump({ source, resolveSession: () => session });
    await pump.tick();
    expect(calls.newSession).to.equal(0);
    expect(acked).to.deep.equal(['r1']); // acked anyway (clear), no wipe
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

  it('session.newSession present takes precedence over pi — wipes, NO operator notice', async () => {
    const { source, acked } = fakeSource(PR());
    const { session, calls } = fakeSession();
    const { pi, sent } = fakePi();
    const pump = new ResetPump({ source, resolveSession: () => session, resolvePi: () => pi });
    await pump.tick();
    expect(calls.newSession).to.equal(1);
    expect(sent, 'no operator notice when we can auto-wipe').to.be.empty;
    expect(acked).to.deep.equal(['r1']);
  });
});

describe('ResetPump.tick — interactive operator notice (#677 PART B)', () => {
  it('no session + pi present → operator notice via pi.sendMessage + ack (no wipe)', async () => {
    const { source, acked } = fakeSource(PR());
    const { pi, sent } = fakePi();
    const pump = new ResetPump({ source, resolveSession: () => null, resolvePi: () => pi });
    await pump.tick();
    expect(sent, 'operator notice sent').to.have.length(1);
    expect(sent[0].opts?.triggerTurn, 'non-triggering notice').to.equal(false);
    const body = String(sent[0].msg.content);
    expect(body).to.contain('/tempo-reset');       // tells the operator what to run
    expect(body).to.contain('tempo-conductor');    // surfaces requestedBy
    expect(acked, 'ACK-ON-NOTIFY: request delivered → slot cleared').to.deep.equal(['r1']);
  });

  it('session WITHOUT newSession() but pi present → falls through to operator notice', async () => {
    const { source, acked } = fakeSource(PR());
    const { session, calls } = fakeSession({ newSession: undefined });
    const { pi, sent } = fakePi();
    const pump = new ResetPump({ source, resolveSession: () => session, resolvePi: () => pi });
    await pump.tick();
    expect(calls.newSession).to.equal(0);
    expect(sent).to.have.length(1);
    expect(acked).to.deep.equal(['r1']);
  });

  it('notify-once: the SAME resetId on a later tick does NOT re-notify (still acks)', async () => {
    const pr = PR();
    const { source, acked } = fakeSource(pr); // source keeps returning the same pending reset
    const { pi, sent } = fakePi();
    const pump = new ResetPump({ source, resolveSession: () => null, resolvePi: () => pi });
    await pump.tick();
    await pump.tick();
    expect(sent, 'notice fired exactly once for resetId r1').to.have.length(1);
    expect(acked, 'each present tick acks (idempotent id-matched clear)').to.deep.equal(['r1', 'r1']);
  });

  it('a NEW resetId notifies again (dedup is id-matched, not permanent)', async () => {
    let pr: PendingReset | null = PR({ resetId: 'r1' });
    const acked: string[] = [];
    const source: ResetSource = {
      fetchPendingReset: async () => pr,
      ackReset: async (id) => { acked.push(id); pr = null; }, // ack clears the slot
    };
    const { pi, sent } = fakePi();
    const pump = new ResetPump({ source, resolveSession: () => null, resolvePi: () => pi });

    await pump.tick();                  // notice for r1 + ack (clears slot)
    pr = PR({ resetId: 'r2' });          // a fresh reset request lands
    await pump.tick();                  // notice for r2 + ack

    expect(sent.map((s) => String(s.msg.content).includes('tempo-conductor'))).to.deep.equal([true, true]);
    expect(sent, 'one notice per distinct resetId').to.have.length(2);
    expect(acked).to.deep.equal(['r1', 'r2']);
  });

  it('pending but NO session AND NO pi → leave pending, no notice, no ack (retry next tick)', async () => {
    const { source, acked } = fakeSource(PR());
    const pump = new ResetPump({ source, resolveSession: () => null /* no resolvePi */ });
    await pump.tick();
    expect(acked).to.be.empty;
  });
});
