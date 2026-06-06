/**
 * Unit tests for the Pi cue pump (src/pi/cue-pump.ts).
 *
 * Covers, WITHOUT Temporal or Pi installed:
 *   1. D10 delivery semantics through the #677 `pi.sendMessage` route:
 *        { deliverAs: msg.isMaestro ? 'steer' : 'followUp', triggerTurn: true }
 *      - operator cue (msg.isMaestro)  → steer    + triggerTurn (interrupt)
 *      - peer cue                      → followUp + triggerTurn (queue, but still
 *                                        wakes a cold-idle agent — the #18 guard)
 *      triggerTurn is UNCONDITIONAL (Pi's followUp does not self-wake an idle
 *      agent; triggerTurn is a no-op mid-turn — no busy/idle branching).
 *   2. Injector resolution (buildPiInjector): PREFERS `pi.sendMessage`, FALLS BACK
 *      to `session.sendCustomMessage` only when sendMessage is unavailable.
 *   3. Per-tick RE-RESOLUTION: a Pi instance rebuild repoints rt.pi → the very next
 *      tick injects through the NEW pi (the interactive-switch root-cause fix).
 *   4. Escalation: a sendMessage-injected cue with NO turn-start by the next tick
 *      → re-injected via `pi.sendUserMessage` (same text), at most once.
 */
import { expect } from 'chai';
import {
  CuePump,
  buildPiInjector,
  type CueSource,
  type InjectorRuntime,
} from '../src/pi/cue-pump';
import type { Message } from '../src/types';
import type {
  ExtensionAPI,
  PiAgentSession,
  PiOutboundMessage,
  PiCustomMessageOptions,
} from '../src/pi/pi-types';

/** Records ack calls; yields its queued cues exactly once. */
class FakeSource implements CueSource {
  public readonly acked: string[][] = [];
  private queued: Message[];
  constructor(pending: Message[] = []) {
    this.queued = pending;
  }
  /** Enqueue more cues for a subsequent tick. */
  enqueue(...msgs: Message[]): void {
    this.queued.push(...msgs);
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

/** Captures pi.sendMessage(msg, opts) + pi.sendUserMessage(content, opts). */
class FakePi implements ExtensionAPI {
  public readonly sent: Array<{ msg: PiOutboundMessage; opts?: PiCustomMessageOptions }> = [];
  public readonly userSent: Array<{ content: string; opts?: { deliverAs?: 'steer' | 'followUp' } }> = [];
  on(): void { /* unused */ }
  registerTool(): void { /* unused */ }
  sendMessage(msg: PiOutboundMessage, opts?: PiCustomMessageOptions): void {
    this.sent.push({ msg, opts });
  }
  sendUserMessage(content: string, opts?: { deliverAs?: 'steer' | 'followUp' }): void {
    this.userSent.push({ content, opts });
  }
}

/** Captures every sendCustomMessage(msg, opts) — the legacy fallback target. */
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

/** Drive one tick with a single cue against a pi-backed runtime; return the recorders. */
async function deliverOne(msg: Message): Promise<{ pi: FakePi; source: FakeSource }> {
  const source = new FakeSource([msg]);
  const pi = new FakePi();
  const rt: InjectorRuntime = { pi, session: null, lastTurnStartAt: null };
  const pump = new CuePump({ source, resolveInjector: () => buildPiInjector(rt) });
  await pump.tick();
  return { pi, source };
}

describe('Pi cue pump — D10 delivery semantics (pi.sendMessage route)', () => {
  it('operator cue (isMaestro) → steer + triggerTurn', async () => {
    const { pi, source } = await deliverOne(mkMsg({ isMaestro: true, from: 'human' }));
    expect(pi.sent).to.have.length(1);
    expect(pi.sent[0].opts).to.deep.equal({ deliverAs: 'steer', triggerTurn: true });
    expect(source.acked).to.deep.equal([['m1']]);
  });

  it('peer cue → followUp + triggerTurn', async () => {
    const { pi, source } = await deliverOne(mkMsg());
    expect(pi.sent).to.have.length(1);
    expect(pi.sent[0].opts).to.deep.equal({ deliverAs: 'followUp', triggerTurn: true });
    expect(source.acked).to.deep.equal([['m1']]);
  });

  it('treats isMaestro:false the same as absent (peer path)', async () => {
    const { pi } = await deliverOne(mkMsg({ isMaestro: false }));
    expect(pi.sent[0].opts).to.deep.equal({ deliverAs: 'followUp', triggerTurn: true });
  });

  it('injects as customType "cue" and prefixes the sender', async () => {
    const { pi } = await deliverOne(mkMsg({ from: 'tempo-lead', text: 'status?' }));
    expect(pi.sent[0].msg).to.deep.equal({
      customType: 'cue',
      content: '[cue from tempo-lead] status?',
      display: true,
    });
  });
});

describe('Pi cue pump — injector resolution (buildPiInjector)', () => {
  it('PREFERS pi.sendMessage over session.sendCustomMessage when both are present', async () => {
    const source = new FakeSource([mkMsg()]);
    const pi = new FakePi();
    const session = new FakeSession();
    const rt: InjectorRuntime = { pi, session, lastTurnStartAt: null };
    const pump = new CuePump({ source, resolveInjector: () => buildPiInjector(rt) });
    await pump.tick();
    expect(pi.sent, 'pi.sendMessage used').to.have.length(1);
    expect(session.sent, 'session.sendCustomMessage NOT used').to.have.length(0);
  });

  it('FALLS BACK to session.sendCustomMessage when pi.sendMessage is unavailable', async () => {
    const source = new FakeSource([mkMsg()]);
    const session = new FakeSession();
    // pi present but WITHOUT a sendMessage method (e.g. an older Pi / fake).
    const piNoSend = { on() {}, registerTool() {} } as unknown as ExtensionAPI;
    const rt: InjectorRuntime = { pi: piNoSend, session, lastTurnStartAt: null };
    const pump = new CuePump({ source, resolveInjector: () => buildPiInjector(rt) });
    await pump.tick();
    expect(session.sent).to.have.length(1);
    expect(session.sent[0].opts).to.deep.equal({ deliverAs: 'followUp', triggerTurn: true });
    expect(source.acked).to.deep.equal([['m1']]);
  });

  it('leaves cues queued and acks nothing when nothing is attached', async () => {
    const source = new FakeSource([mkMsg()]);
    const pump = new CuePump({
      source,
      resolveInjector: () => buildPiInjector({ pi: null, session: null, lastTurnStartAt: null }),
    });
    await pump.tick();
    expect(source.acked).to.deep.equal([]);
  });
});

describe('Pi cue pump — per-tick re-resolution (interactive instance rebuild)', () => {
  it('a Pi instance rebuild (rt.pi repointed) makes the NEXT tick inject through the NEW pi', async () => {
    const source = new FakeSource();
    const pi1 = new FakePi();
    const pi2 = new FakePi();
    // Mutable runtime — the injector is rebuilt from it EACH tick.
    const rt: InjectorRuntime = { pi: pi1, session: null, lastTurnStartAt: null };
    const pump = new CuePump({ source, resolveInjector: () => buildPiInjector(rt) });

    // Tick 1 → pi1.
    source.enqueue(mkMsg({ id: 'a', text: 'first' }));
    await pump.tick();
    expect(pi1.sent.map((s) => s.msg.content)).to.deep.equal(['[cue from peer-1] first']);
    expect(pi2.sent).to.have.length(0);

    // Pi rebuilds the instance on a session switch → rt.pi repointed to pi2.
    rt.pi = pi2;

    // Tick 2 → pi2 (NOT the stale pi1).
    source.enqueue(mkMsg({ id: 'b', text: 'second' }));
    await pump.tick();
    expect(pi2.sent.map((s) => s.msg.content)).to.deep.equal(['[cue from peer-1] second']);
    expect(pi1.sent, 'stale pi1 unused after rebind').to.have.length(1);
  });
});

describe('Pi cue pump — escalation (#677 turn-started → sendUserMessage)', () => {
  it('re-injects via sendUserMessage when no turn started since the sendMessage inject', async () => {
    const source = new FakeSource();
    const pi = new FakePi();
    let clock = 1000;
    // No turn ever starts (lastTurnStartAt stays null).
    const rt: InjectorRuntime = { pi, session: null, lastTurnStartAt: null };
    const pump = new CuePump({ source, resolveInjector: () => buildPiInjector(rt), now: () => clock });

    // Tick 1 — inject the cue via sendMessage (injectedAt = 1000).
    source.enqueue(mkMsg({ from: 'tempo-lead', text: 'wake up' }));
    await pump.tick();
    expect(pi.sent, 'primary route is sendMessage').to.have.length(1);
    expect(pi.userSent, 'no escalation yet').to.have.length(0);

    // Tick 2 — still no turn started → escalate via sendUserMessage with the SAME text.
    clock = 2000;
    await pump.tick();
    expect(pi.userSent, 'escalated once').to.have.length(1);
    expect(pi.userSent[0].content).to.equal('[cue from tempo-lead] wake up');
    // #688 — escalation MUST pass deliverAs:'followUp' (queues when busy/streaming;
    // a bare sendUserMessage throws "Agent is already processing" mid-turn).
    expect(pi.userSent[0].opts).to.deep.equal({ deliverAs: 'followUp' });

    // Tick 3 — escalate-once invariant: no second escalation.
    clock = 3000;
    await pump.tick();
    expect(pi.userSent, 'does not loop').to.have.length(1);
  });

  it('#688: escalation does not throw when the agent is busy mid-turn (followUp queues)', async () => {
    const source = new FakeSource();
    // A pi mimicking Pi's runtime: a bare sendUserMessage (no deliverAs) while a
    // turn is streaming THROWS "Agent is already processing"; followUp queues fine.
    const calls: Array<{ content: string; opts?: { deliverAs?: 'steer' | 'followUp' } }> = [];
    const pi = {
      on() { /* unused */ },
      registerTool() { /* unused */ },
      sendMessage() { /* primary route — unused in this assertion */ },
      sendUserMessage(content: string, opts?: { deliverAs?: 'steer' | 'followUp' }) {
        if (!opts || opts.deliverAs == null) throw new Error('Agent is already processing');
        calls.push({ content, opts });
      },
    } as unknown as ExtensionAPI;
    // A turn was ALREADY in flight BEFORE the inject (the busy false-positive that
    // makes maybeEscalate fire): lastTurnStartAt (500) < injectedAt (1000).
    const rt: InjectorRuntime = { pi, session: null, lastTurnStartAt: 500 };
    let clock = 1000;
    const pump = new CuePump({ source, resolveInjector: () => buildPiInjector(rt), now: () => clock });

    source.enqueue(mkMsg({ text: 'busy cue' }));
    await pump.tick();   // inject via sendMessage (injectedAt = 1000)
    clock = 2000;
    await pump.tick();   // escalates — must NOT throw, and must land via followUp

    expect(calls, 'escalation landed (would be empty if the bare call had thrown)').to.have.length(1);
    expect(calls[0].opts).to.deep.equal({ deliverAs: 'followUp' });
  });

  it('does NOT escalate when a turn started after the inject', async () => {
    const source = new FakeSource();
    const pi = new FakePi();
    let clock = 1000;
    const rt: InjectorRuntime = { pi, session: null, lastTurnStartAt: null };
    const pump = new CuePump({ source, resolveInjector: () => buildPiInjector(rt), now: () => clock });

    // Tick 1 — inject (injectedAt = 1000).
    source.enqueue(mkMsg({ text: 'hello' }));
    await pump.tick();

    // A turn starts AFTER the inject (the triggerTurn wake took).
    rt.lastTurnStartAt = 1500;

    // Tick 2 — turn observed → no escalation.
    clock = 2000;
    await pump.tick();
    expect(pi.userSent, 'cue was picked up — no escalation').to.have.length(0);
  });

  it('the session fallback route is NOT escalation-eligible', async () => {
    const source = new FakeSource();
    const session = new FakeSession();
    const rt: InjectorRuntime = { pi: null, session, lastTurnStartAt: null };
    const pump = new CuePump({ source, resolveInjector: () => buildPiInjector(rt) });

    source.enqueue(mkMsg({ text: 'legacy' }));
    await pump.tick();
    await pump.tick(); // a second idle tick must not throw / escalate (no sendUserMessage)
    expect(session.sent).to.have.length(1);
  });
});
