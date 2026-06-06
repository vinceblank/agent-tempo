/**
 * Reset pump (3d D14 + #677 PART B) — polls the session workflow's single-slot
 * pending reset and DELIVERS it, then acks. Sibling to {@link CuePump}: Pi has no
 * reverse-RPC from Temporal, so reset (an operator/conductor CONTROL op — it
 * bypasses the MD-G tool gate) is delivered by polling `pendingReset` and acking
 * via the race-safe `ackReset(resetId)` (the workflow clears the slot only if the
 * id still matches, so a newer reset landing during delivery is preserved).
 *
 * D14 (maintainer-ruled): reset = clean-wipe (fresh context, NO replay). Seeded
 * reset is a separate concern (`restart` + `loadFromState`), so a `fresh:false`
 * here is defensively logged + acked — the reset tool only ever sends `fresh:true`.
 *
 * ── CAPABILITY BRANCH (#677 PART B) ──
 * Delivery depends on what's attached, NOT a mode flag:
 *   1. HEADLESS / session-capable — `session.newSession()` exists → AUTO clean-wipe
 *      in place, then ack.
 *   2. INTERACTIVE — Pi 0.78.1's SessionStartEvent has no `session` field, so
 *      `rt.session` is null AND `newSession` is command-context-ONLY (not on the
 *      SDK session): the pump CANNOT auto-wipe an interactive conductor. Instead it
 *      NOTIFIES the operator (via the stable `pi.sendMessage` handle) to run
 *      `/tempo-reset` themselves — ACK-ON-NOTIFY, id-matched so the notice fires
 *      ONCE per resetId (no per-tick spam). Operator-mediated is the ceiling.
 *   3. Nothing attached yet — leave pending; retry next tick.
 */
import type { PendingReset } from '../types';
import type { ExtensionAPI, PiAgentSession } from './pi-types';

/** Source of the pending reset + ack — satisfied by `PiWorkflowClient`. */
export interface ResetSource {
  fetchPendingReset(): Promise<PendingReset | null>;
  ackReset(resetId: string): Promise<void>;
}

/** Resolves the CURRENT live Pi session at wipe time (re-acquired each tick — D11). */
export type SessionResolver = () => PiAgentSession | null;

/** Resolves the CURRENT Pi `ExtensionAPI` handle (interactive operator-notice route — D11). */
export type PiResolver = () => ExtensionAPI | null;

export interface ResetPumpOptions {
  source: ResetSource;
  resolveSession: SessionResolver;
  /**
   * #677 PART B — the live `pi` handle for the interactive operator-notice route.
   * Re-resolved each tick (repointed on instance rebuild). Absent → no notify path
   * (legacy/headless-only callers); the pump still auto-wipes when a session with
   * `newSession()` is present.
   */
  resolvePi?: PiResolver;
  /** Poll interval (ms). */
  intervalMs?: number;
}

const DEFAULT_POLL_MS = 1_000;

const log = (...args: unknown[]): void => {
  // eslint-disable-next-line no-console
  console.error('[agent-tempo:pi]', ...args);
};

export class ResetPump {
  private readonly source: ResetSource;
  private readonly resolveSession: SessionResolver;
  private readonly resolvePi: PiResolver;
  private readonly intervalMs: number;
  private timer: ReturnType<typeof setInterval> | null = null;
  private draining = false;
  /**
   * #677 PART B — the resetId we've already surfaced as an operator notice, so the
   * "run /tempo-reset" notice fires ONCE per request (id-matched). Cleared when the
   * slot empties or a wipe happens.
   */
  private lastNotifiedResetId: string | null = null;

  constructor(opts: ResetPumpOptions) {
    this.source = opts.source;
    this.resolveSession = opts.resolveSession;
    this.resolvePi = opts.resolvePi ?? (() => null);
    this.intervalMs = opts.intervalMs ?? DEFAULT_POLL_MS;
  }

  start(): void {
    if (this.timer) return;
    this.timer = setInterval(() => {
      this.tick().catch((err) => log('reset-pump tick failed:', err));
    }, this.intervalMs);
    if (typeof this.timer.unref === 'function') this.timer.unref();
  }

  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  /**
   * One poll cycle (#677 PART B capability branch). Re-entrancy guarded so a slow
   * tick never overlaps the next interval. Public for unit tests to drive directly.
   *
   *   1. no pending                → clear dedup, done.
   *   2. fresh=false               → log + ack (clear slot; seeded reset is restart's job).
   *   3. session.newSession() avail → AUTO clean-wipe + ack (headless / session-capable).
   *   4. else pi.sendMessage avail  → operator notice (once per id) + ack (interactive).
   *   5. else                       → nothing attached yet; leave pending, retry.
   */
  async tick(): Promise<void> {
    if (this.draining) return;
    this.draining = true;
    try {
      const pr = await this.source.fetchPendingReset();
      if (!pr) {
        this.lastNotifiedResetId = null; // slot empty → forget the last notice
        return;
      }

      if (!pr.fresh) {
        // D14: reset is clean-wipe ONLY. A seeded reset is restart+loadFromState
        // (not this path). Don't guess — log + ack (clear the slot).
        log(`reset ${pr.resetId}: fresh=false — no wipe (seeded reset is restart's job)`);
        await this.source.ackReset(pr.resetId);
        this.lastNotifiedResetId = null;
        return;
      }

      // (3) Session-capable (headless) → auto clean-wipe in place.
      const session = this.resolveSession();
      if (session && typeof session.newSession === 'function') {
        await this.performWipe(session, pr);
        await this.source.ackReset(pr.resetId);
        this.lastNotifiedResetId = null;
        return;
      }

      // (4) Interactive → can't auto-wipe; notify the operator to run /tempo-reset.
      const pi = this.resolvePi();
      if (pi && typeof pi.sendMessage === 'function') {
        if (this.lastNotifiedResetId !== pr.resetId) {
          this.notifyOperator(pi, pr); // ONCE per resetId (no per-tick spam)
          this.lastNotifiedResetId = pr.resetId;
        }
        // ACK-ON-NOTIFY: the request has been DELIVERED to the operator (the most
        // an interactive conductor can do); clear the slot so it doesn't re-poll.
        await this.source.ackReset(pr.resetId);
        return;
      }

      // (5) Nothing attached yet — leave it pending; next tick retries.
    } finally {
      this.draining = false;
    }
  }

  /** D14 clean-wipe (caller guarantees `fresh` + `newSession`) + the "context wiped" notice. */
  private async performWipe(session: PiAgentSession, pr: PendingReset): Promise<void> {
    // `newSession` is optional on the slice; tick() gated `typeof === 'function'`
    // before calling, so the assertion is sound (the doc-comment states the contract).
    await session.newSession!(); // clean-wipe: fresh context, no replay
    const by = pr.requestedBy ? ` (requested by ${pr.requestedBy})` : '';
    const notice = `[reset] context wiped — fresh start${by}.${pr.reason ? ` reason: ${pr.reason}` : ''}`;
    log(notice);
    // Surface the notice INTO the fresh session (after the wipe, so it survives),
    // non-triggering so it doesn't kick off an unsolicited turn — the agent reads
    // it on its next cue.
    try {
      await session.sendCustomMessage(
        { customType: 'system', content: notice, display: true },
        { deliverAs: 'followUp', triggerTurn: false },
      );
    } catch (err) {
      log(`reset ${pr.resetId}: notice injection failed (non-fatal):`, err);
    }
  }

  /**
   * Interactive operator notice (#677 PART B). The pump can't reach `newSession`
   * (command-context-only), so it asks the human to run `/tempo-reset`. Sent via
   * the stable `pi.sendMessage` handle, non-triggering (it's an instruction, not a
   * turn). Best-effort: a failed notice never throws the tick.
   */
  private notifyOperator(pi: ExtensionAPI, pr: PendingReset): void {
    const by = pr.requestedBy ? ` by ${pr.requestedBy}` : '';
    const reason = pr.reason ? ` (reason: ${pr.reason})` : '';
    const notice =
      `⟳ context reset requested${by}${reason} — run /tempo-reset to clean-wipe this ` +
      `session's context. agent-tempo can't auto-reset an interactive Pi conductor.`;
    try {
      pi.sendMessage?.(
        { customType: 'system', content: notice, display: true },
        { deliverAs: 'followUp', triggerTurn: false },
      );
      log(`reset ${pr.resetId}: interactive — notified operator to run /tempo-reset`);
    } catch (err) {
      log(`reset ${pr.resetId}: operator notice failed (non-fatal):`, err);
    }
  }
}
