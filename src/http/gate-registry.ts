/**
 * Operator-gate registry (3d / MD-G) — the DAEMON-LOCAL state for the live
 * tool-call approve/deny gate on a headless Pi player. Per-player (keyed by the
 * fixed session `workflowId`), it holds two things:
 *
 *   1. ARMED state — whether an operator has armed the gate for this player.
 *      When disarmed, the player's `tool_call` handler never engages the gate
 *      (MD-C decides immediately); when armed, a non-`low-risk` tool routes here
 *      for an operator decision.
 *   2. PENDING requests — one entry per in-flight gated tool call, keyed by a
 *      caller-supplied `requestId`. The operator resolves it (POST /gate/:id);
 *      the Pi subprocess POLLS for the resolution (GET /gate/:id/resolution) and
 *      resolves its awaited `tool_call` Promise on a non-pending answer.
 *
 * ── Per-request fail-mode timeout (R3 + #700 / G) ──
 * Every pending request carries a `failMode` (sourced from the agent's durable
 * `guardrailPolicy`, defaulting `'open'`):
 *   - `'open'` (monitored, autonomous-first, R3 maintainer-LOCKED) — no operator
 *     decision after {@link GATE_AUTO_ALLOW_MS} resolves to `auto-allow` so an
 *     unsupervised run never stalls (and Pi #2381 — a `tool_call` handler that
 *     never resolves hangs the loop — can't bite).
 *   - `'closed'` (supervised) — no operator decision after
 *     {@link GATE_CLOSED_DENY_MS} resolves to `auto-deny`: opting into
 *     supervision means silence ≠ consent, so a dangerous op is DENIED (not
 *     hung — liveness preserved) when the operator is absent.
 * Expiry is LAZY-ON-POLL (computed from `createdAt` vs the injected clock at
 * {@link GateRegistry.getResolution} time) — no daemon timer, fully
 * deterministic under test. The Pi-side poll loop additionally bounds itself +
 * honors `ctx.signal`, so the loop is bounded on BOTH sides.
 *
 * ── Audit (R5, security-locked) ──
 * Every posture change (arm / disarm) and every decision (operator allow|deny,
 * timeout auto-allow) is handed to the injected {@link GateAuditSink} — the
 * daemon wires the append-only JSONL writer
 * (`~/.agent-tempo/gate-audit/<ensemble>/<workflowId>.jsonl`). The registry owns
 * the auto-allow decision point, so it MUST audit that one; arm/disarm/operator
 * decisions are audited here too for a single sink.
 *
 * ── gate_resolved on the /inner stream (architect-ruled DI) ──
 * When a decision lands, the registry emits an `inner.gate_resolved` frame so the
 * operator sees the outcome. To avoid a circular import (GateRegistry ↔ the
 * inner-loop module), the publish path is an INJECTED {@link PublishToInner}
 * callback — the daemon wires it to `innerLoop.publish`. The registry imports
 * only the InnerFrame TYPE (erased at compile), never the inner-loop runtime.
 *
 * This module is daemon-side ONLY (loopback HTTP boundary, off Temporal, off the
 * coordination bus). Nothing here is imported by `src/workflows/`.
 */
import type { InnerFrame } from '../pi/inner-loop-publisher';

/**
 * MONITORED (fail-OPEN) timeout: a pending request auto-ALLOWS after this long
 * (R3, locked). The cheap-if-wrong fuse for an otherwise-autonomous agent the
 * operator is merely watching.
 *
 * ★ SINGLE-SOURCE HOME for the gate timeouts (#700 / G anti-drift). The
 * subprocess gate-client DERIVES its client-side closed deadline from
 * {@link GATE_CLOSED_DENY_MS} (+ buffer) so the invariant
 * `client_closed > daemon_closed` can't drift — see `src/pi/gate-client.ts`.
 */
export const GATE_AUTO_ALLOW_MS = 45_000;

/**
 * SUPERVISED (fail-CLOSED) timeout (#700 / G): a `closed` pending request
 * auto-DENIES after this long on operator absence / daemon-down. Deliberately
 * MUCH longer than the 45s monitored fuse — auto-deny is destructive (it kills a
 * legit op the operator was about to approve), so it pairs with the inner-loop
 * `gate_pending` notify and a generous 5-min window. Do NOT reuse the 45s
 * constant for closed.
 */
export const GATE_CLOSED_DENY_MS = 300_000;

/**
 * Per-request fail posture (#700 / G). Sourced from the requesting agent's
 * durable `guardrailPolicy` and carried on the `gate_pending` frame — NOT an
 * operator-arm property (a headless supervised player holds only the ingest
 * token and can't operator-arm). `'open'` = today's MD-G monitored behavior
 * (auto-ALLOW); `'closed'` = supervised (auto-DENY).
 */
export type GateFailMode = 'open' | 'closed';

/**
 * Terminal decision on a gated tool call. `auto-allow` = the open (monitored)
 * timeout fired; `auto-deny` = the closed (supervised) timeout fired. The two
 * timeout outcomes are kept DISTINCT (not collapsed into plain allow/deny) so
 * the audit sink can tell an operator decision from a timeout, and a monitored
 * auto-allow from a supervised auto-deny.
 */
export type GateDecision = 'allow' | 'deny' | 'auto-allow' | 'auto-deny';

/** Who/what produced a decision. */
export type GateDecisionSource = 'operator' | 'timeout';

/** Metadata the source attaches when opening a gate request (for operator display + audit). */
export interface GateRequestMeta {
  /** The tool being gated (already classified non-`low-risk`). */
  tool: string;
  /** A bounded summary of the tool args (source-truncated, ≤ a couple KB). */
  argsSummary: string;
  /** The player's Pi conversation id, if known (audit only). */
  sessionId?: string;
  /**
   * The player's ensemble — stashed per-player so the audit sink can path the
   * JSONL under `<ensemble>/<workflowId>.jsonl` (workflowId is not cleanly
   * splittable since both ensemble + playerId may contain hyphens).
   */
  ensemble?: string;
  /**
   * Per-request fail posture (#700 / G). `'closed'` (supervised) → auto-DENY
   * after {@link GATE_CLOSED_DENY_MS}; `'open'` (monitored, **default**) →
   * auto-ALLOW after {@link GATE_AUTO_ALLOW_MS}. Carried on the `gate_pending`
   * frame from the agent's durable `guardrailPolicy`; omitted ⇒ `'open'`.
   */
  failMode?: GateFailMode;
}

/** The poll answer the Pi subprocess receives from GET /gate/:requestId/resolution. */
export type GateResolution =
  | { status: 'pending' }
  | { status: 'resolved'; decision: GateDecision; source: GateDecisionSource };

/** One audited gate event (R5 schema, security-locked; `kind` discriminator per architect). */
export type GateAuditRecord =
  | {
      kind: 'decision';
      ts: string;
      workflowId: string;
      sessionId?: string;
      requestId: string;
      tool: string;
      argsSummary: string;
      decision: GateDecision;
      source: GateDecisionSource;
      operatorTokenHint?: string;
    }
  | {
      kind: 'arm' | 'disarm';
      ts: string;
      workflowId: string;
      source: 'operator';
      operatorTokenHint?: string;
    };

/**
 * Append-only audit sink (daemon wires the JSONL writer; tests inject a spy).
 * `ensemble` is a SIDECAR (not part of the locked record schema) the writer uses
 * to path `<ensemble>/<workflowId>.jsonl`; `''` when unknown.
 */
export type GateAuditSink = (record: GateAuditRecord, ensemble: string) => void;

/**
 * Injected publish path for the `inner.gate_resolved` outcome frame (architect's
 * DI to avoid a GateRegistry ↔ inner-loop circular import). Daemon wires it to
 * `innerLoop.publish`; tests inject a spy; default is a no-op.
 */
export type PublishToInner = (workflowId: string, frame: InnerFrame) => void;

/** Result of an operator decision attempt — drives the route's HTTP status. */
export type DecideResult =
  | { ok: true }
  | { ok: false; reason: 'not-found' }      // unknown requestId → 404
  | { ok: false; reason: 'already-decided' }; // re-decide → 409 (idempotency)

interface PendingRequest {
  readonly tool: string;
  readonly argsSummary: string;
  readonly sessionId?: string;
  readonly createdAt: number;
  /** Per-request fail posture (#700 / G); set at open() from the gate_pending frame. */
  readonly failMode: GateFailMode;
  decision: GateDecision | null;
  source: GateDecisionSource | null;
}

interface PlayerGate {
  armed: boolean;
  /** Stashed for audit pathing — set on the first arm()/open() that names it. */
  ensemble: string;
  readonly pending: Map<string, PendingRequest>;
}

/**
 * Per-daemon operator-gate registry, keyed by the player's fixed session
 * `workflowId`. One instance is constructed in the daemon and shared between the
 * Temporal worker (auto-disarm on detach/destroy) and the HTTP gate routes —
 * the same singleton-sharing pattern as the 3c InnerLoop/IngestToken registries.
 */
export class GateRegistry {
  private readonly gates = new Map<string, PlayerGate>();

  constructor(
    private readonly audit: GateAuditSink = () => {},
    private readonly now: () => number = Date.now,
    private readonly autoAllowMs: number = GATE_AUTO_ALLOW_MS,
    private readonly publishToInner: PublishToInner = () => {},
    private readonly closedDenyMs: number = GATE_CLOSED_DENY_MS,
  ) {}

  /** Emit an `inner.gate_resolved` outcome frame on the player's /inner stream. */
  private emitResolved(workflowId: string, requestId: string, decision: GateDecision, source: GateDecisionSource): void {
    this.publishToInner(workflowId, { type: 'inner.gate_resolved', requestId, decision, source, ts: this.now() });
  }

  private gate(workflowId: string): PlayerGate {
    let g = this.gates.get(workflowId);
    if (!g) {
      g = { armed: false, ensemble: '', pending: new Map() };
      this.gates.set(workflowId, g);
    }
    return g;
  }

  private nowIso(): string {
    // `now` is injectable; format the same epoch ms the registry reasons about so
    // audit timestamps line up with the lazy-expiry clock under test.
    return new Date(this.now()).toISOString();
  }

  // ── Arm / disarm (operator posture; audited) ───────────────────────────────

  /** Arm the gate for a player — subsequent non-`low-risk` tools route to the operator. */
  arm(workflowId: string, ensemble: string, operatorTokenHint?: string): void {
    const g = this.gate(workflowId);
    g.armed = true;
    if (ensemble) g.ensemble = ensemble;
    this.audit({ kind: 'arm', ts: this.nowIso(), workflowId, source: 'operator', ...(operatorTokenHint ? { operatorTokenHint } : {}) }, g.ensemble);
  }

  /** Disarm the gate — new tools no longer engage it (in-flight pending still resolvable / auto-allow). */
  disarm(workflowId: string, operatorTokenHint?: string): void {
    const g = this.gate(workflowId);
    g.armed = false;
    this.audit({ kind: 'disarm', ts: this.nowIso(), workflowId, source: 'operator', ...(operatorTokenHint ? { operatorTokenHint } : {}) }, g.ensemble);
  }

  /** Whether the gate is currently armed for a player (the engagement predicate reads this). */
  isArmed(workflowId: string): boolean {
    return this.gates.get(workflowId)?.armed ?? false;
  }

  // ── Pending requests (source opens; operator decides; source polls) ─────────

  /**
   * Open (or return the existing) pending request for a gated tool call.
   * Idempotent on `requestId` — a retried open returns the existing entry so the
   * source can safely re-register before polling. Does NOT audit (the request
   * isn't a decision); the decision/auto-allow audit records carry tool+args.
   */
  open(workflowId: string, requestId: string, meta: GateRequestMeta): void {
    const g = this.gate(workflowId);
    if (meta.ensemble) g.ensemble = meta.ensemble;
    if (g.pending.has(requestId)) return;
    g.pending.set(requestId, {
      tool: meta.tool,
      argsSummary: meta.argsSummary,
      sessionId: meta.sessionId,
      createdAt: this.now(),
      failMode: meta.failMode ?? 'open',
      decision: null,
      source: null,
    });
  }

  /**
   * Operator decision (allow|deny) on a pending request. Returns a result that
   * the route maps to a status: unknown → 404, already-decided → 409 (idempotency
   * guard so a double-POST or a post-timeout race can't flip a recorded answer).
   */
  decide(
    workflowId: string,
    requestId: string,
    decision: 'allow' | 'deny',
    operatorTokenHint?: string,
  ): DecideResult {
    const g = this.gates.get(workflowId);
    const req = g?.pending.get(requestId);
    if (!req) return { ok: false, reason: 'not-found' };
    if (req.decision !== null) return { ok: false, reason: 'already-decided' };
    req.decision = decision;
    req.source = 'operator';
    this.audit({
      kind: 'decision',
      ts: this.nowIso(),
      workflowId,
      ...(req.sessionId ? { sessionId: req.sessionId } : {}),
      requestId,
      tool: req.tool,
      argsSummary: req.argsSummary,
      decision,
      source: 'operator',
      ...(operatorTokenHint ? { operatorTokenHint } : {}),
    }, g?.ensemble ?? '');
    this.emitResolved(workflowId, requestId, decision, 'operator');
    return { ok: true };
  }

  /**
   * The Pi subprocess's poll answer. Returns `null` for an unknown request
   * (route → 404). For a known request: an already-recorded decision, OR — if no
   * decision and the request's fail-mode fuse has elapsed — a freshly-recorded
   * TIMEOUT decision (audited HERE since the registry owns the timeout clock),
   * OR `pending`.
   *
   * The fuse is PER-REQUEST (#700 / G): `open` (monitored, default) auto-ALLOWS
   * after {@link GATE_AUTO_ALLOW_MS}; `closed` (supervised) auto-DENIES after
   * {@link GATE_CLOSED_DENY_MS}. Both are LAZY-ON-POLL (computed from `createdAt`
   * vs the injected clock — no daemon timer, deterministic under test).
   */
  getResolution(workflowId: string, requestId: string): GateResolution | null {
    const g = this.gates.get(workflowId);
    const req = g?.pending.get(requestId);
    if (!req) return null;
    if (req.decision !== null) {
      return { status: 'resolved', decision: req.decision, source: req.source ?? 'operator' };
    }
    const closed = req.failMode === 'closed';
    const fuseMs = closed ? this.closedDenyMs : this.autoAllowMs;
    if (this.now() - req.createdAt >= fuseMs) {
      const decision: GateDecision = closed ? 'auto-deny' : 'auto-allow';
      req.decision = decision;
      req.source = 'timeout';
      this.audit({
        kind: 'decision',
        ts: this.nowIso(),
        workflowId,
        ...(req.sessionId ? { sessionId: req.sessionId } : {}),
        requestId,
        tool: req.tool,
        argsSummary: req.argsSummary,
        decision,
        source: 'timeout',
      }, g?.ensemble ?? '');
      this.emitResolved(workflowId, requestId, decision, 'timeout');
      return { status: 'resolved', decision, source: 'timeout' };
    }
    return { status: 'pending' };
  }

  // ── Lifecycle (auto-disarm on detach/destroy; daemon shutdown) ──────────────

  /**
   * Auto-disarm + drop all pending for a player (detach / destroy). The
   * subprocess is going away, so abandoning its pending requests is correct — a
   * still-polling client would just stop. Idempotent.
   */
  clearPlayer(workflowId: string): void {
    this.gates.delete(workflowId);
  }

  /** Drop every player's gate state (daemon shutdown / clear-all). */
  clear(): void {
    this.gates.clear();
  }

  /** Pending-request count for a player (diagnostics / tests). */
  pendingCount(workflowId: string): number {
    return this.gates.get(workflowId)?.pending.size ?? 0;
  }
}
