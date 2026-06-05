/**
 * Restore-resume regression for an in-memory Pi player (H2 / #645, OPT-A outcome).
 *
 * OPT-A finding: Pi's `loadFromState` restart-resume already works via existing
 * machinery — `deliverRestart` → `receiveMessage('self-restart')` (covered by
 * #334) → the cue pump injects the restored-state cue into the live
 * `SessionManager.inMemory` Pi session. No production code was needed.
 *
 * This test locks the NEW composition that H2 relies on: the cue-pump CALL
 * CONTRACT for a `self-restart` cue (non-maestro → `followUp`, `triggerTurn`
 * unconditional). It does NOT re-cover #334's deliverRestart→self-restart half.
 *
 * SCOPE — this locks the cue-pump CALL CONTRACT only. That these exact options
 * land + wake a fresh `SessionManager.inMemory` Pi session is RUNTIME-VERIFIED by
 * the researcher's hermetic Pi-0.78 smoke (cue lands in `agent.state.messages` +
 * the in-memory manager; an idle session → `triggerTurn` falls through to a NEW
 * turn per agent-session.js:987-988, `'followUp'` being a streaming-time
 * qualifier). Pi's internal routing is Pi's code — not exercised here.
 *
 * Verified WITHOUT Temporal or Pi installed (fake CueSource + recording session).
 */
import { expect } from 'chai';
import { CuePump, type CueSource } from '../src/pi/cue-pump';
import type { Message } from '../src/types';
import type { PiAgentSession, PiOutboundMessage, PiCustomMessageOptions } from '../src/pi/pi-types';

/** Yields its queued cues exactly once; records ack ids. */
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

// The exact restored-state cue body agent-tempo delivers on loadFromState
// restart — src/activities/outbox.ts:1056 (`from: 'self-restart'`).
const STATE_KEY = 'default';
const RESTORED_BODY = `🎵 **Restored state — "${STATE_KEY}"** (saved 2026-06-05T00:00:00.000Z by tempo-eng)\n\nprior working context here`;

/** One self-restart cue, exactly as #334's deliverRestart enqueues it. */
const selfRestartCue = (): Message => ({
  id: 'm1',
  from: 'self-restart',
  text: RESTORED_BODY,
  timestamp: '2026-06-05T00:00:00.000Z',
  delivered: false,
  isMaestro: false,
});

describe('Pi cue pump — in-memory restore (H2 / self-restart composition)', () => {
  it('injects the self-restart cue once as followUp + triggerTurn, then acks it', async () => {
    const source = new FakeSource([selfRestartCue()]);
    const session = new FakeSession();
    const pump = new CuePump({ source, resolveSession: () => session });

    await pump.tick();

    // Exactly one injection.
    expect(session.sent).to.have.length(1);
    const { msg, opts } = session.sent[0];

    // msg: a "cue" custom message carrying the restored-state body, sender-prefixed.
    expect(msg.customType).to.equal('cue');
    expect(msg.display).to.equal(true);
    expect(msg.content).to.be.a('string');
    expect(msg.content.startsWith('[cue from self-restart] ')).to.equal(true);
    expect(msg.content).to.contain(RESTORED_BODY); // body preserved verbatim

    // opts: non-maestro self-restart → followUp (queue, not steer); triggerTurn
    // unconditional so an idle restored session is actually woken (the #18 guard).
    expect(opts).to.deep.equal({ deliverAs: 'followUp', triggerTurn: true });

    // Acked by id so the workflow stops re-delivering it.
    expect(source.acked).to.deep.equal([['m1']]);
  });
});
