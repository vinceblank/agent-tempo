/**
 * Unit tests for the 3c inner-loop publisher (src/pi/inner-loop-publisher.ts).
 *
 * Driven WITHOUT live Pi or the daemon: handler methods are called directly and
 * a fake InnerLoopRegistry records publishes + controls presence. An injected
 * clock makes the presence rate-limit + frame timestamps deterministic.
 *
 * Covered: Tier-1 coarse state (currentTool set/clear, context usage from
 * getContextUsage at turn_end), Tier-2 fine frames (tool_call/tool_result/turn/
 * token/thinking), source coalescing (char threshold + kind-switch + manual
 * flush), the subscriber-presence gate (+ rate-limited re-check), and ~2KB
 * summary truncation.
 */
import { expect } from 'chai';
import {
  InnerLoopPublisher,
  truncateSummary,
  type InnerFrame,
  type InnerLoopRegistry,
} from '../src/pi/inner-loop-publisher';
import type { PiExtensionContext, PiContextUsage } from '../src/pi/pi-types';

/** Records publishes; presence is caller-controlled. */
class FakeRegistry implements InnerLoopRegistry {
  public readonly published: Array<{ workflowId: string; frame: InnerFrame }> = [];
  public present = true;
  public subscriberCalls = 0;
  publish(workflowId: string, frame: InnerFrame): void {
    this.published.push({ workflowId, frame });
  }
  subscriberCount(): number {
    this.subscriberCalls++;
    return this.present ? 1 : 0;
  }
  framesOfType<T extends InnerFrame['type']>(type: T): Extract<InnerFrame, { type: T }>[] {
    return this.published.map((p) => p.frame).filter((f) => f.type === type) as Extract<InnerFrame, { type: T }>[];
  }
}

/** Fake ExtensionContext returning a fixed usage. */
const ctxWith = (usage: PiContextUsage | undefined): PiExtensionContext => ({
  getContextUsage: () => usage,
  isIdle: () => false,
});

/** A clock the test advances manually. */
function fakeClock(start = 1_000_000) {
  let t = start;
  return { now: () => t, advance: (ms: number) => { t += ms; } };
}

const make = (reg: FakeRegistry, clock = fakeClock(), over = {}) =>
  new InnerLoopPublisher({
    workflowId: 'wf-1',
    registry: reg,
    now: clock.now,
    ...over,
  });

describe('inner-loop publisher — Tier 1 coarse state', () => {
  it('sets currentTool on tool start and clears it on tool end', () => {
    const reg = new FakeRegistry();
    const pub = make(reg);
    expect(pub.getCoarseState().currentTool).to.equal(null);
    pub.handleToolStart({ toolName: 'bash' });
    expect(pub.getCoarseState().currentTool).to.equal('bash');
    pub.handleToolEnd({ toolName: 'bash', isError: false });
    expect(pub.getCoarseState().currentTool).to.equal(null);
  });

  it('folds getContextUsage tokens+percent into coarse state at turn_end', () => {
    const reg = new FakeRegistry();
    const pub = make(reg);
    pub.handleTurnEnd({ turnIndex: 0 }, ctxWith({ tokens: 1234, contextWindow: 200000, percent: 0.42 }));
    const c = pub.getCoarseState();
    expect(c.contextTokens).to.equal(1234);
    expect(c.contextPercent).to.equal(0.42);
  });

  it('tolerates a missing ctx / undefined usage / null fields without throwing', () => {
    const reg = new FakeRegistry();
    const pub = make(reg);
    pub.handleTurnEnd({ turnIndex: 0 }); // no ctx
    pub.handleTurnEnd({ turnIndex: 1 }, ctxWith(undefined));
    pub.handleTurnEnd({ turnIndex: 2 }, ctxWith({ tokens: null, contextWindow: 200000, percent: null }));
    expect(pub.getCoarseState().contextTokens).to.equal(undefined);
    expect(pub.getCoarseState().contextPercent).to.equal(undefined);
  });

  it('getCoarseState returns a copy (caller cannot mutate internal state)', () => {
    const reg = new FakeRegistry();
    const pub = make(reg);
    pub.handleToolStart({ toolName: 'read' });
    const snap = pub.getCoarseState();
    snap.currentTool = 'tampered';
    expect(pub.getCoarseState().currentTool).to.equal('read');
  });
});

describe('inner-loop publisher — Tier 2 fine frames', () => {
  it('forwards inner.tool_call with a summarized args payload', () => {
    const reg = new FakeRegistry();
    const clock = fakeClock();
    const pub = make(reg, clock);
    pub.handleToolCall({ toolName: 'bash', input: { command: 'ls -la' } });
    const [f] = reg.framesOfType('inner.tool_call');
    expect(f).to.exist;
    expect(f.tool).to.equal('bash');
    expect(f.argsSummary).to.equal('{"command":"ls -la"}');
    expect(f.ts).to.equal(clock.now());
  });

  it('forwards inner.tool_result with result summary + isError', () => {
    const reg = new FakeRegistry();
    const pub = make(reg);
    pub.handleToolEnd({ toolName: 'bash', result: { stdout: 'ok' }, isError: true });
    const [f] = reg.framesOfType('inner.tool_result');
    expect(f.tool).to.equal('bash');
    expect(f.resultSummary).to.equal('{"stdout":"ok"}');
    expect(f.isError).to.equal(true);
  });

  it('forwards inner.turn start/end with turnIndex', () => {
    const reg = new FakeRegistry();
    const pub = make(reg);
    pub.handleTurnStart({ turnIndex: 3 });
    pub.handleTurnEnd({ turnIndex: 3 }, ctxWith(undefined));
    const turns = reg.framesOfType('inner.turn');
    expect(turns.map((t) => t.phase)).to.deep.equal(['start', 'end']);
    expect(turns[0].turnIndex).to.equal(3);
  });

  it('forwards inner.token at turn_end when usage is known', () => {
    const reg = new FakeRegistry();
    const pub = make(reg);
    pub.handleTurnEnd({ turnIndex: 0 }, ctxWith({ tokens: 500, contextWindow: 200000, percent: 0.1 }));
    const [tok] = reg.framesOfType('inner.token');
    expect(tok).to.deep.equal({ type: 'inner.token', contextTokens: 500, contextPercent: 0.1 });
  });

  it('does NOT forward inner.token when usage is unknown', () => {
    const reg = new FakeRegistry();
    const pub = make(reg);
    pub.handleTurnEnd({ turnIndex: 0 }, ctxWith(undefined));
    expect(reg.framesOfType('inner.token')).to.have.length(0);
  });
});

describe('inner-loop publisher — thinking/text coalescing', () => {
  it('buffers deltas and flushes one frame on manual flush (single turn of text)', () => {
    const reg = new FakeRegistry();
    const pub = make(reg);
    pub.handleMessageUpdate({ assistantMessageEvent: { type: 'thinking_delta', delta: 'Hel' } });
    pub.handleMessageUpdate({ assistantMessageEvent: { type: 'thinking_delta', delta: 'lo' } });
    expect(reg.framesOfType('inner.thinking')).to.have.length(0); // not flushed yet
    pub.flushPending();
    const [f] = reg.framesOfType('inner.thinking');
    expect(f).to.deep.equal({ type: 'inner.thinking', delta: 'Hello', kind: 'thinking' });
  });

  it('flushes automatically when the char threshold is crossed', () => {
    const reg = new FakeRegistry();
    const pub = make(reg, fakeClock(), { coalesceChars: 8 });
    pub.handleMessageUpdate({ assistantMessageEvent: { type: 'text_delta', delta: '12345' } });
    expect(reg.framesOfType('inner.thinking')).to.have.length(0);
    pub.handleMessageUpdate({ assistantMessageEvent: { type: 'text_delta', delta: '678' } }); // total 8 ≥ 8
    const f = reg.framesOfType('inner.thinking');
    expect(f).to.have.length(1);
    expect(f[0]).to.deep.equal({ type: 'inner.thinking', delta: '12345678', kind: 'text' });
  });

  it('flushes the prior buffer when the delta kind switches (preserves order)', () => {
    const reg = new FakeRegistry();
    const pub = make(reg);
    pub.handleMessageUpdate({ assistantMessageEvent: { type: 'thinking_delta', delta: 'plan' } });
    pub.handleMessageUpdate({ assistantMessageEvent: { type: 'text_delta', delta: 'answer' } }); // kind switch flushes 'plan'
    pub.flushPending();
    const f = reg.framesOfType('inner.thinking');
    expect(f).to.deep.equal([
      { type: 'inner.thinking', delta: 'plan', kind: 'thinking' },
      { type: 'inner.thinking', delta: 'answer', kind: 'text' },
    ]);
  });

  it('ignores empty deltas and non-text variants (toolcall_delta)', () => {
    const reg = new FakeRegistry();
    const pub = make(reg);
    pub.handleMessageUpdate({ assistantMessageEvent: { type: 'thinking_delta', delta: '' } });
    pub.handleMessageUpdate({ assistantMessageEvent: { type: 'toolcall_delta', delta: '{"a":' } });
    pub.handleMessageUpdate({ assistantMessageEvent: {} });
    pub.flushPending();
    expect(reg.framesOfType('inner.thinking')).to.have.length(0);
  });

  it('turn_end flushes pending deltas before the turn frame', () => {
    const reg = new FakeRegistry();
    const pub = make(reg);
    pub.handleMessageUpdate({ assistantMessageEvent: { type: 'text_delta', delta: 'trailing' } });
    pub.handleTurnEnd({ turnIndex: 0 }, ctxWith(undefined));
    const types = reg.published.map((p) => p.frame.type);
    // thinking flushed BEFORE the turn-end frame.
    expect(types.indexOf('inner.thinking')).to.be.lessThan(types.indexOf('inner.turn'));
  });
});

describe('inner-loop publisher — subscriber-presence gate', () => {
  it('does NOT forward when no subscriber is present', () => {
    const reg = new FakeRegistry();
    reg.present = false;
    const pub = make(reg);
    pub.handleTurnStart({ turnIndex: 0 });
    pub.handleToolEnd({ toolName: 'bash', isError: false });
    expect(reg.published).to.have.length(0);
  });

  it('forwards once a subscriber appears', () => {
    const reg = new FakeRegistry();
    reg.present = true;
    const pub = make(reg);
    pub.handleTurnStart({ turnIndex: 0 });
    expect(reg.published).to.have.length(1);
  });

  it('rate-limits subscriberCount re-checks to once per presencePollMs', () => {
    const reg = new FakeRegistry();
    const clock = fakeClock();
    const pub = make(reg, clock, { presencePollMs: 1000 });
    // 3 forwards within the same window → exactly ONE subscriberCount call.
    pub.handleTurnStart({ turnIndex: 0 });
    pub.handleTurnStart({ turnIndex: 1 });
    pub.handleTurnStart({ turnIndex: 2 });
    expect(reg.subscriberCalls).to.equal(1);
    // advance past the window → next forward re-checks.
    clock.advance(1000);
    pub.handleTurnStart({ turnIndex: 3 });
    expect(reg.subscriberCalls).to.equal(2);
  });

  it('does NOT buffer thinking deltas while absent (zero hot-path work, no late flush)', () => {
    const reg = new FakeRegistry();
    const clock = fakeClock();
    reg.present = false;
    const pub = make(reg, clock, { presencePollMs: 1000 });
    pub.handleMessageUpdate({ assistantMessageEvent: { type: 'thinking_delta', delta: 'secret' } });
    pub.handleMessageUpdate({ assistantMessageEvent: { type: 'thinking_delta', delta: 'plan' } });
    // A subscriber appears later — nothing was buffered while absent, so a flush
    // after the window yields no back-dated thinking frame.
    reg.present = true;
    clock.advance(1000);
    pub.flushPending();
    expect(reg.framesOfType('inner.thinking')).to.have.length(0);
  });

  it('does NOT stringify a tool result while absent (gate precedes truncateSummary)', () => {
    const reg = new FakeRegistry();
    reg.present = false;
    const pub = make(reg);
    // A getter that throws if read proves the summary was never computed.
    const exploding = { get blows(): string { throw new Error('stringified while absent!'); } };
    expect(() => pub.handleToolEnd({ toolName: 'bash', result: exploding, isError: false })).to.not.throw();
    expect(reg.published).to.have.length(0);
    // Coarse currentTool clear still happened (always-on, ungated).
    expect(pub.getCoarseState().currentTool).to.equal(null);
  });

  it('picks up a presence change after the poll window elapses', () => {
    const reg = new FakeRegistry();
    const clock = fakeClock();
    reg.present = false;
    const pub = make(reg, clock, { presencePollMs: 1000 });
    pub.handleTurnStart({ turnIndex: 0 });
    expect(reg.published).to.have.length(0); // gated off
    reg.present = true;
    clock.advance(1000);
    pub.handleTurnStart({ turnIndex: 1 });
    expect(reg.published).to.have.length(1); // now flowing
  });
});

describe('inner-loop publisher — truncateSummary', () => {
  it('passes through short values unchanged', () => {
    expect(truncateSummary('hello')).to.equal('hello');
    expect(truncateSummary({ a: 1 })).to.equal('{"a":1}');
    expect(truncateSummary(null)).to.equal('');
  });

  it('truncates oversized values with a marker, staying within budget', () => {
    const big = 'x'.repeat(5000);
    const out = truncateSummary(big, 2048);
    expect(out.length).to.be.at.most(2048);
    expect(out.endsWith('…[truncated]')).to.equal(true);
  });

  it('summaries in forwarded frames are bounded by maxSummaryChars', () => {
    const reg = new FakeRegistry();
    const pub = make(reg, fakeClock(), { maxSummaryChars: 64 });
    pub.handleToolEnd({ toolName: 'bash', result: 'y'.repeat(1000), isError: false });
    const [f] = reg.framesOfType('inner.tool_result');
    expect(f.resultSummary.length).to.be.at.most(64);
  });
});
