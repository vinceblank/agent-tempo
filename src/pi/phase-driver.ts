/**
 * Pi-event → attachment-phase state machine (PURE — no Temporal, no Pi imports).
 *
 * This is the de-risking core of the Phase 0 PoC and the primary unit-test
 * target. It translates Pi lifecycle events into (a) the next attachment phase
 * and (b) the workflow action the extension must perform to publish that phase
 * through the EXISTING session-workflow wire surface (claimAttachment /
 * processingStart / processingEnd / requestDetach + adapterExited).
 *
 * Architect's EXACT mapping (do not "improve" without an architect sign-off):
 *
 *   session_start          → claim           → phase `attached`
 *   agent_start            → processingStart → phase `processing`
 *   agent_end              → processingEnd   → phase `awaiting`   (NOT detached!)
 *   session_shutdown       → detach          → phase `draining`   (→ `detached`
 *                                               confirmed workflow-side after
 *                                               adapterExited; see note below)
 *   turn_start  / turn_end          → NONE   → phase UNCHANGED, stamp activity
 *   tool_execution_start / _end     → NONE   → phase UNCHANGED, stamp activity
 *
 * CRITICAL INVARIANT: `turn_*` and `tool_execution_*` fire multiple times mid
 * agent run. If they drove the phase, the session would oscillate
 * processing↔awaiting many times per turn. They are ACTIVITY signals only.
 */

/** Attachment phases — mirrors `AttachmentPhase` in src/types.ts (kept local to stay import-free). */
export type PiPhase =
  | 'booting'
  | 'attached'
  | 'processing'
  | 'awaiting'
  | 'draining'
  | 'detached'
  | 'gone';

/**
 * The workflow-side action the extension should perform in response to an event.
 * `none` means "no phase-affecting workflow call" (activity-only events).
 */
export type WorkflowAction =
  | { kind: 'claim' }
  | { kind: 'processingStart'; messageId: string }
  | { kind: 'processingEnd'; messageId: string }
  | { kind: 'detach' }
  | { kind: 'none' };

export interface PhaseDriverResult {
  /** The workflow call the extension must make (or `none`). */
  action: WorkflowAction;
  /** The phase AFTER applying this event (the driver's local view). */
  phase: PiPhase;
  /** True when this event bumped the last-activity timestamp. */
  activityStamped: boolean;
}

/** Events that stamp last-activity but MUST NOT drive the phase. */
const ACTIVITY_ONLY_EVENTS: ReadonlySet<string> = new Set([
  'turn_start',
  'turn_end',
  'tool_execution_start',
  'tool_execution_end',
]);

/**
 * Stateful (but side-effect-free) translator. One instance per attached Pi
 * session. Re-instantiate on each `session_start` — never reuse across session
 * switches (D11).
 */
export class PhaseDriver {
  private _phase: PiPhase = 'booting';
  private _lastActivityAt: string | null = null;
  /** The in-flight message id between agent_start and agent_end (idempotency). */
  private _currentMessageId: string | null = null;

  get phase(): PiPhase {
    return this._phase;
  }

  get lastActivityAt(): string | null {
    return this._lastActivityAt;
  }

  /**
   * Translate a Pi lifecycle event into a phase transition + workflow action.
   *
   * @param event   Pi lifecycle event name.
   * @param payload Optional `{ messageId }` carried by the event.
   * @param now     ISO timestamp injected by the caller (keeps this pure/testable).
   */
  handle(
    event: string,
    payload: { messageId?: string } = {},
    now: string,
  ): PhaseDriverResult {
    if (ACTIVITY_ONLY_EVENTS.has(event)) {
      // Activity-only: stamp, but DO NOT touch the phase.
      this._lastActivityAt = now;
      return { action: { kind: 'none' }, phase: this._phase, activityStamped: true };
    }

    switch (event) {
      case 'session_start': {
        this._currentMessageId = null; // defensive: fresh attach has no in-flight turn.
        this._phase = 'attached';
        return { action: { kind: 'claim' }, phase: this._phase, activityStamped: false };
      }

      case 'agent_start': {
        // processingStart requires a stable messageId for idempotency. Prefer the
        // event-supplied id; fall back to a now-derived id when Pi omits one.
        const messageId = payload.messageId ?? `pi-turn-${now}`;
        this._currentMessageId = messageId;
        this._phase = 'processing';
        this._lastActivityAt = now;
        return {
          action: { kind: 'processingStart', messageId },
          phase: this._phase,
          activityStamped: true,
        };
      }

      case 'agent_end': {
        // End the IN-FLIGHT turn. agent_end means the agent finished THIS run and
        // is now waiting for input → `awaiting`, NOT `detached`.
        //
        // Hardening (P2-4): end with the id we STARTED the turn with — NOT the
        // payload — so processingStart/End pair EXACTLY (the workflow keys its
        // in-flight set on that id; a mismatched end would orphan the entry). And
        // a spurious / duplicate agent_end with no turn in flight is INERT: it
        // must not synthesize a bogus processingEnd nor flip the phase (which
        // could mask a genuine `processing` state or spuriously leave `awaiting`).
        const inFlightId = this._currentMessageId;
        if (inFlightId === null) {
          return { action: { kind: 'none' }, phase: this._phase, activityStamped: false };
        }
        this._currentMessageId = null;
        this._phase = 'awaiting';
        this._lastActivityAt = now;
        return {
          action: { kind: 'processingEnd', messageId: inFlightId },
          phase: this._phase,
          activityStamped: true,
        };
      }

      case 'session_shutdown': {
        // Graceful teardown: phase → draining; the extension performs
        // requestDetach (→ draining) then adapterExited (→ detached). The
        // `detached` collapse is authoritative WORKFLOW-side; the driver's
        // local view rests at `draining` because the process is exiting.
        // Clear any in-flight turn so a late stray event after shutdown is inert.
        this._currentMessageId = null;
        this._phase = 'draining';
        return { action: { kind: 'detach' }, phase: this._phase, activityStamped: false };
      }

      default:
        // Unknown / unhandled events are inert: no phase change, no activity stamp.
        return { action: { kind: 'none' }, phase: this._phase, activityStamped: false };
    }
  }
}
