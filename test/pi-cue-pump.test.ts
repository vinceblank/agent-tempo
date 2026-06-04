/**
 * Unit tests for the Pi cue pump's D10 delivery semantics (src/pi/cue-pump.ts).
 *
 * Verified WITHOUT Temporal or Pi installed — the pump is driven through its
 * real `tick()` path against a fake CueSource + fake PiAgentSession that records
 * the `sendMessage` options. The rule under test:
 *
 *   { deliverAs: msg.isMaestro ? 'steer' : 'followUp', triggerTurn: true }
 *
 *   - operator cue (msg.isMaestro)  → steer    + triggerTurn (interrupt)
 *   - peer cue                      → followUp + triggerTurn (queue, but still
 *                                     wakes a cold-idle agent — the #18 guard)
 *
 * triggerTurn is UNCONDITIONAL: researcher-confirmed that Pi's followUp does not
 * self-wake an idle agent, and triggerTurn is a no-op mid-turn — so there is no
 * busy/idle branching to test.
 */
import { expect } from 'chai';
import { CuePump, type CueSource } from '../src/pi/cue-pump';
import type { Message } from '../src/types';
import type { PiAgentSession, PiOutboundMessage, PiCustomMessageOptions } from '../src/pi/pi-types';

/** Records ack calls; yields its queued cues exactly once. */
class FakeSource implements CueSource {
  public readonly acked: string[][] = [];
  private queued: Message[];
  constructor(pending: Message[]) {
    this.queued = pending;
  }
  async fetchPending(): Promise<Message[]> {
    const out = this.queued;
    this.queued = [];
    return out;
  }
  async ackDelivered(messageIds: string[]): Promise<void> {
    this.acked.push(messageIds);
  }
}

/** Captures every sendCustomMessage(msg, opts) the pump performs. */
class FakeSession implements PiAgentSession {
  public readonly sent: Array<{ msg: PiOutboundMessage; opts?: PiCustomMessageOptions }> = [];
  sendCustomMessage(msg: PiOutboundMessage, opts?: PiCustomMessageOptions): void {
    this.sent.push({ msg, opts });
  }
}

const mkMsg = (over: Partial<Message> = {}): Message => ({
  id: 'm1',
  from: 'peer-1',
  text: 'ping',
  timestamp: '2026-01-01T00:00:00.000Z',
  delivered: false,
  ...over,
});

/** Drive one tick with a single cue and return the recorded delivery + acks. */
async function deliverOne(msg: Message): Promise<{ session: FakeSession; source: FakeSource }> {
  const source = new FakeSource([msg]);
  const session = new FakeSession();
  const pump = new CuePump({ source, resolveSession: () => session });
  await pump.tick();
  return { session, source };
}

describe('Pi cue pump — D10 delivery semantics', () => {
  it('operator cue (isMaestro) → steer + triggerTurn', async () => {
    const { session, source } = await deliverOne(mkMsg({ isMaestro: true, from: 'human' }));
    expect(session.sent).to.have.length(1);
    expect(session.sent[0].opts).to.deep.equal({ deliverAs: 'steer', triggerTurn: true });
    expect(source.acked).to.deep.equal([['m1']]);
  });

  it('peer cue → followUp + triggerTurn', async () => {
    const { session, source } = await deliverOne(mkMsg());
    expect(session.sent).to.have.length(1);
    expect(session.sent[0].opts).to.deep.equal({ deliverAs: 'followUp', triggerTurn: true });
    expect(source.acked).to.deep.equal([['m1']]);
  });

  it('treats isMaestro:false the same as absent (peer path)', async () => {
    const { session } = await deliverOne(mkMsg({ isMaestro: false }));
    expect(session.sent[0].opts).to.deep.equal({ deliverAs: 'followUp', triggerTurn: true });
  });

  it('injects as customType "cue" and prefixes the sender', async () => {
    const { session } = await deliverOne(mkMsg({ from: 'tempo-lead', text: 'status?' }));
    expect(session.sent[0].msg).to.deep.equal({
      customType: 'cue',
      content: '[cue from tempo-lead] status?',
      display: true,
    });
  });
});

describe('Pi cue pump — no live session', () => {
  it('leaves cues queued and acks nothing when no session is attached', async () => {
    const source = new FakeSource([mkMsg()]);
    const pump = new CuePump({ source, resolveSession: () => null });
    await pump.tick();
    expect(source.acked).to.deep.equal([]);
  });
});
