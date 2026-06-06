/**
 * Unit tests for GateRegistry (3d / MD-G) — arm/disarm posture, pending-request
 * lifecycle, operator decide (with 404/409 idempotency), lazy 45s auto-allow,
 * audit emission, and detach/destroy clear. Pure in-memory; injected clock makes
 * the timeout deterministic.
 */
import { describe, it, expect } from 'vitest';
import {
  GateRegistry,
  GATE_AUTO_ALLOW_MS,
  GATE_CLOSED_DENY_MS,
  type GateAuditRecord,
} from '../../src/http/gate-registry';

const E = 'demo';
const WF = 'agent-session-demo-tempo-pi';
const RID = 'req-1';
const META = { tool: 'bash', argsSummary: '{"cmd":"ls"}', sessionId: 'sess-abc', ensemble: E };

/** A registry with a controllable clock + audit + publishToInner spies. */
function setup(startMs = 1_000_000) {
  let nowMs = startMs;
  const audit: GateAuditRecord[] = [];
  const auditEnsembles: string[] = [];
  const published: { workflowId: string; frame: { type: string; [k: string]: unknown } }[] = [];
  const reg = new GateRegistry(
    (r, ens) => { audit.push(r); auditEnsembles.push(ens); },
    () => nowMs,
    undefined, // default 45s
    (workflowId, frame) => published.push({ workflowId, frame: frame as { type: string } }),
  );
  return {
    reg,
    audit,
    auditEnsembles,
    published,
    advance: (ms: number) => { nowMs += ms; },
    set: (ms: number) => { nowMs = ms; },
  };
}

describe('GateRegistry — arm / disarm', () => {
  it('defaults disarmed; arm flips it; disarm flips back; audited each time', () => {
    const { reg, audit, auditEnsembles } = setup();
    expect(reg.isArmed(WF)).toBe(false);
    reg.arm(WF, E, 'tok1234');
    expect(reg.isArmed(WF)).toBe(true);
    reg.disarm(WF);
    expect(reg.isArmed(WF)).toBe(false);
    expect(audit.map((a) => a.kind)).toEqual(['arm', 'disarm']);
    expect(audit[0]).toMatchObject({ kind: 'arm', workflowId: WF, source: 'operator', operatorTokenHint: 'tok1234' });
    // ensemble sidecar (for audit pathing) flows on both records, stashed from arm.
    expect(auditEnsembles).toEqual([E, E]);
  });
});

describe('GateRegistry — pending + operator decide', () => {
  it('open → getResolution pending → decide(allow) → resolved; decision audited', () => {
    const { reg, audit } = setup();
    reg.open(WF, RID, META);
    expect(reg.getResolution(WF, RID)).toEqual({ status: 'pending' });

    const r = reg.decide(WF, RID, 'allow', 'opHint');
    expect(r).toEqual({ ok: true });
    expect(reg.getResolution(WF, RID)).toEqual({ status: 'resolved', decision: 'allow', source: 'operator' });

    const dec = audit.find((a) => a.kind === 'decision');
    expect(dec).toMatchObject({
      kind: 'decision', workflowId: WF, requestId: RID, tool: 'bash',
      decision: 'allow', source: 'operator', sessionId: 'sess-abc', operatorTokenHint: 'opHint',
    });
  });

  it('emits inner.gate_resolved on the player stream when the operator decides', () => {
    const { reg, published } = setup();
    reg.open(WF, RID, META);
    reg.decide(WF, RID, 'deny');
    expect(published).toHaveLength(1);
    expect(published[0].workflowId).toBe(WF);
    expect(published[0].frame).toMatchObject({ type: 'inner.gate_resolved', requestId: RID, decision: 'deny', source: 'operator' });
  });

  it('decide(deny) resolves to deny', () => {
    const { reg } = setup();
    reg.open(WF, RID, META);
    expect(reg.decide(WF, RID, 'deny')).toEqual({ ok: true });
    expect(reg.getResolution(WF, RID)).toEqual({ status: 'resolved', decision: 'deny', source: 'operator' });
  });

  it('decide on an unknown requestId → not-found (404)', () => {
    const { reg } = setup();
    expect(reg.decide(WF, 'nope', 'allow')).toEqual({ ok: false, reason: 'not-found' });
    expect(reg.getResolution(WF, 'nope')).toBeNull();
  });

  it('re-decide an already-decided request → already-decided (409); the recorded answer is NOT flipped', () => {
    const { reg } = setup();
    reg.open(WF, RID, META);
    expect(reg.decide(WF, RID, 'allow')).toEqual({ ok: true });
    expect(reg.decide(WF, RID, 'deny')).toEqual({ ok: false, reason: 'already-decided' });
    expect(reg.getResolution(WF, RID)).toEqual({ status: 'resolved', decision: 'allow', source: 'operator' });
  });

  it('open is idempotent on requestId — a re-open does not reset the entry', () => {
    const { reg } = setup();
    reg.open(WF, RID, META);
    reg.decide(WF, RID, 'allow');
    reg.open(WF, RID, { ...META, tool: 'evil' }); // must NOT clobber the decided entry
    expect(reg.getResolution(WF, RID)).toEqual({ status: 'resolved', decision: 'allow', source: 'operator' });
  });
});

describe('GateRegistry — 45s auto-allow (lazy on poll)', () => {
  it('stays pending before the deadline, then auto-allows (source timeout) and audits it', () => {
    const { reg, audit, advance } = setup();
    reg.open(WF, RID, META);

    advance(GATE_AUTO_ALLOW_MS - 1);
    expect(reg.getResolution(WF, RID)).toEqual({ status: 'pending' });
    expect(audit.some((a) => a.kind === 'decision')).toBe(false);

    advance(1); // now exactly at the deadline
    expect(reg.getResolution(WF, RID)).toEqual({ status: 'resolved', decision: 'auto-allow', source: 'timeout' });
    const dec = audit.find((a) => a.kind === 'decision');
    expect(dec).toMatchObject({ decision: 'auto-allow', source: 'timeout', requestId: RID, tool: 'bash' });
  });

  it('emits inner.gate_resolved (source timeout) on auto-allow', () => {
    const { reg, published, advance } = setup();
    reg.open(WF, RID, META);
    advance(GATE_AUTO_ALLOW_MS);
    reg.getResolution(WF, RID);
    expect(published.at(-1)?.frame).toMatchObject({ type: 'inner.gate_resolved', requestId: RID, decision: 'auto-allow', source: 'timeout' });
  });

  it('an operator decision BEFORE the deadline wins — no auto-allow afterward', () => {
    const { reg, advance } = setup();
    reg.open(WF, RID, META);
    reg.decide(WF, RID, 'deny');
    advance(GATE_AUTO_ALLOW_MS * 2);
    expect(reg.getResolution(WF, RID)).toEqual({ status: 'resolved', decision: 'deny', source: 'operator' });
  });

  it('auto-allow is recorded once — a second poll returns the same resolved answer without re-auditing', () => {
    const { reg, audit, advance } = setup();
    reg.open(WF, RID, META);
    advance(GATE_AUTO_ALLOW_MS);
    reg.getResolution(WF, RID);
    reg.getResolution(WF, RID);
    expect(audit.filter((a) => a.kind === 'decision')).toHaveLength(1);
  });
});

describe('GateRegistry — per-request failMode (#700 / G)', () => {
  const CLOSED_META = { ...META, failMode: 'closed' as const };

  it('closed request stays pending past the 45s open fuse, then auto-DENIES at GATE_CLOSED_DENY_MS', () => {
    const { reg, audit, advance } = setup();
    reg.open(WF, RID, CLOSED_META);

    // Past the OPEN fuse (45s) — a closed request must NOT auto-allow.
    advance(GATE_AUTO_ALLOW_MS);
    expect(reg.getResolution(WF, RID)).toEqual({ status: 'pending' });

    // Just before the CLOSED fuse — still pending.
    advance(GATE_CLOSED_DENY_MS - GATE_AUTO_ALLOW_MS - 1);
    expect(reg.getResolution(WF, RID)).toEqual({ status: 'pending' });
    expect(audit.some((a) => a.kind === 'decision')).toBe(false);

    // At the closed fuse — auto-DENY (source timeout), audited like auto-allow.
    advance(1);
    expect(reg.getResolution(WF, RID)).toEqual({ status: 'resolved', decision: 'auto-deny', source: 'timeout' });
    const dec = audit.find((a) => a.kind === 'decision');
    expect(dec).toMatchObject({ decision: 'auto-deny', source: 'timeout', requestId: RID, tool: 'bash' });
  });

  it('emits inner.gate_resolved (auto-deny, source timeout) on the closed fuse', () => {
    const { reg, published, advance } = setup();
    reg.open(WF, RID, CLOSED_META);
    advance(GATE_CLOSED_DENY_MS);
    reg.getResolution(WF, RID);
    expect(published.at(-1)?.frame).toMatchObject({ type: 'inner.gate_resolved', requestId: RID, decision: 'auto-deny', source: 'timeout' });
  });

  it('absent failMode ⇒ open: still auto-ALLOWS at the 45s fuse (MD-G unchanged)', () => {
    const { reg, advance } = setup();
    reg.open(WF, RID, META); // no failMode → defaults open
    advance(GATE_AUTO_ALLOW_MS);
    expect(reg.getResolution(WF, RID)).toEqual({ status: 'resolved', decision: 'auto-allow', source: 'timeout' });
  });

  it('failMode is PER-REQUEST: an open and a closed request on the same player resolve at their own fuses', () => {
    const { reg, advance } = setup();
    reg.open(WF, 'open-req', META);
    reg.open(WF, 'closed-req', CLOSED_META);

    advance(GATE_AUTO_ALLOW_MS); // open fuse only
    expect(reg.getResolution(WF, 'open-req')).toEqual({ status: 'resolved', decision: 'auto-allow', source: 'timeout' });
    expect(reg.getResolution(WF, 'closed-req')).toEqual({ status: 'pending' });

    advance(GATE_CLOSED_DENY_MS - GATE_AUTO_ALLOW_MS); // now past the closed fuse too
    expect(reg.getResolution(WF, 'closed-req')).toEqual({ status: 'resolved', decision: 'auto-deny', source: 'timeout' });
  });

  it('an operator decision on a closed request still wins before the fuse', () => {
    const { reg, advance } = setup();
    reg.open(WF, RID, CLOSED_META);
    reg.decide(WF, RID, 'allow');
    advance(GATE_CLOSED_DENY_MS * 2);
    expect(reg.getResolution(WF, RID)).toEqual({ status: 'resolved', decision: 'allow', source: 'operator' });
  });
});

describe('GateRegistry — lifecycle', () => {
  it('clearPlayer drops armed + pending (auto-disarm on detach/destroy)', () => {
    const { reg } = setup();
    reg.arm(WF, E);
    reg.open(WF, RID, META);
    expect(reg.pendingCount(WF)).toBe(1);
    reg.clearPlayer(WF);
    expect(reg.isArmed(WF)).toBe(false);
    expect(reg.pendingCount(WF)).toBe(0);
    expect(reg.getResolution(WF, RID)).toBeNull();
  });

  it('clear() drops every player', () => {
    const { reg } = setup();
    reg.arm(WF, E);
    reg.arm('other-wf', E);
    reg.clear();
    expect(reg.isArmed(WF)).toBe(false);
    expect(reg.isArmed('other-wf')).toBe(false);
  });

  it('pending is per-workflowId — a requestId in one player is invisible to another', () => {
    const { reg } = setup();
    reg.open(WF, RID, META);
    expect(reg.getResolution('other-wf', RID)).toBeNull();
  });
});
