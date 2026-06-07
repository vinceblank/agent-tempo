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
  enforcedFailMode,
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
    reg.setPolicy(WF, 'monitored'); // #712: failMode is policy-driven — monitored ⇒ open ⇒ auto-allow
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
    reg.setPolicy(WF, 'monitored');
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
    reg.setPolicy(WF, 'monitored');
    reg.open(WF, RID, META);
    advance(GATE_AUTO_ALLOW_MS);
    reg.getResolution(WF, RID);
    reg.getResolution(WF, RID);
    expect(audit.filter((a) => a.kind === 'decision')).toHaveLength(1);
  });
});

describe('GateRegistry — policy-driven failMode fuses (#700 fuses, #712 source)', () => {
  // #712: the stored failMode is computed from the player's DURABLE policy
  // (set via setPolicy), NOT the frame claim. supervised → closed; monitored → open.

  it('supervised → stays pending past the 45s open fuse, then auto-DENIES at GATE_CLOSED_DENY_MS', () => {
    const { reg, audit, advance } = setup();
    reg.setPolicy(WF, 'supervised');
    reg.open(WF, RID, META);

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

  it('supervised → emits inner.gate_resolved (auto-deny, source timeout) on the closed fuse', () => {
    const { reg, published, advance } = setup();
    reg.setPolicy(WF, 'supervised');
    reg.open(WF, RID, META);
    advance(GATE_CLOSED_DENY_MS);
    reg.getResolution(WF, RID);
    expect(published.at(-1)?.frame).toMatchObject({ type: 'inner.gate_resolved', requestId: RID, decision: 'auto-deny', source: 'timeout' });
  });

  it('monitored → auto-ALLOWS at the 45s fuse (MD-G unchanged)', () => {
    const { reg, advance } = setup();
    reg.setPolicy(WF, 'monitored');
    reg.open(WF, RID, META);
    advance(GATE_AUTO_ALLOW_MS);
    expect(reg.getResolution(WF, RID)).toEqual({ status: 'resolved', decision: 'auto-allow', source: 'timeout' });
  });

  it('#712: the player policy drives ALL its requests UNIFORMLY (no per-request frame mixing)', () => {
    const { reg, advance } = setup();
    reg.setPolicy(WF, 'supervised');
    // Even a frame claiming 'open' is enforced closed — both requests go closed.
    reg.open(WF, 'r1', { ...META, failMode: 'open' });
    reg.open(WF, 'r2', { ...META, failMode: 'closed' });

    advance(GATE_AUTO_ALLOW_MS); // the open fuse — neither resolves (both enforced closed)
    expect(reg.getResolution(WF, 'r1')).toEqual({ status: 'pending' });
    expect(reg.getResolution(WF, 'r2')).toEqual({ status: 'pending' });

    advance(GATE_CLOSED_DENY_MS - GATE_AUTO_ALLOW_MS);
    expect(reg.getResolution(WF, 'r1')).toMatchObject({ decision: 'auto-deny' });
    expect(reg.getResolution(WF, 'r2')).toMatchObject({ decision: 'auto-deny' });
  });

  it('an operator decision on a supervised request still wins before the fuse', () => {
    const { reg, advance } = setup();
    reg.setPolicy(WF, 'supervised');
    reg.open(WF, RID, META);
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

describe('GateRegistry — #712 daemon failMode cross-check (durable-policy-authoritative)', () => {
  it('enforcedFailMode: monitored/autonomous → open; supervised/observe-only/unknown → closed', () => {
    expect(enforcedFailMode('monitored')).toBe('open');
    expect(enforcedFailMode('autonomous')).toBe('open');
    expect(enforcedFailMode('supervised')).toBe('closed');
    expect(enforcedFailMode('observe-only')).toBe('closed');
    expect(enforcedFailMode(undefined)).toBe('closed'); // no-fail-open
  });

  it('setPolicy/getPolicy round-trips; clearPlayer drops it (per-player lifecycle)', () => {
    const { reg } = setup();
    expect(reg.getPolicy(WF)).toBeUndefined();
    reg.setPolicy(WF, 'supervised');
    expect(reg.getPolicy(WF)).toBe('supervised');
    reg.clearPlayer(WF);
    expect(reg.getPolicy(WF)).toBeUndefined();
  });

  it('★ supervised: open() FORCES closed regardless of the frame claim (open | absent | closed) → auto-deny', () => {
    for (const claim of ['open', 'closed', undefined] as const) {
      const { reg, advance } = setup();
      reg.setPolicy(WF, 'supervised');
      reg.open(WF, RID, { ...META, ...(claim ? { failMode: claim } : {}) });
      advance(GATE_CLOSED_DENY_MS); // closed fuse
      expect(reg.getResolution(WF, RID)).toMatchObject({ status: 'resolved', decision: 'auto-deny', source: 'timeout' });
    }
  });

  it('monitored: open() resolves open (auto-allow @45s, MD-G unchanged)', () => {
    const { reg, advance } = setup();
    reg.setPolicy(WF, 'monitored');
    reg.open(WF, RID, { ...META, failMode: 'open' });
    advance(GATE_AUTO_ALLOW_MS);
    expect(reg.getResolution(WF, RID)).toMatchObject({ status: 'resolved', decision: 'auto-allow' });
  });

  it('observe-only: open() forces closed (most-restrictive; defense-in-depth)', () => {
    const { reg, advance } = setup();
    reg.setPolicy(WF, 'observe-only');
    reg.open(WF, RID, { ...META, failMode: 'open' });
    advance(GATE_CLOSED_DENY_MS);
    expect(reg.getResolution(WF, RID)).toMatchObject({ decision: 'auto-deny' });
  });

  it('★ UNKNOWN policy (never set — post-restart pre-resolve): open() enforces closed (NO-FAIL-OPEN)', () => {
    const { reg, advance } = setup();
    reg.open(WF, RID, { ...META, failMode: 'open' }); // no setPolicy
    advance(GATE_CLOSED_DENY_MS);
    expect(reg.getResolution(WF, RID)).toMatchObject({ decision: 'auto-deny' });
  });

  it('★ override-audit: frame claims open but policy enforces closed → NEUTRAL-FACTUAL failmode-override record', () => {
    const { reg, audit } = setup();
    reg.setPolicy(WF, 'supervised');
    reg.open(WF, RID, { ...META, failMode: 'open' });
    const override = audit.find((a) => a.kind === 'failmode-override');
    expect(override).toMatchObject({
      kind: 'failmode-override', workflowId: WF, requestId: RID, tool: 'bash',
      claimedFailMode: 'open', enforcedFailMode: 'closed', policy: 'supervised',
    });
  });

  it('override-audit records policy:"unknown" when the policy was never resolved', () => {
    const { reg, audit } = setup();
    reg.open(WF, RID, { ...META, failMode: 'open' }); // unknown → enforced closed
    expect(audit.find((a) => a.kind === 'failmode-override')).toMatchObject({ policy: 'unknown', enforcedFailMode: 'closed' });
  });

  it('NO override-audit when the frame already claims closed (agent honored its policy)', () => {
    const { reg, audit } = setup();
    reg.setPolicy(WF, 'supervised');
    reg.open(WF, RID, { ...META, failMode: 'closed' });
    expect(audit.some((a) => a.kind === 'failmode-override')).toBe(false);
  });

  it('NO override-audit for a monitored player claiming open (legitimate, no downgrade)', () => {
    const { reg, audit } = setup();
    reg.setPolicy(WF, 'monitored');
    reg.open(WF, RID, { ...META, failMode: 'open' });
    expect(audit.some((a) => a.kind === 'failmode-override')).toBe(false);
  });
});
