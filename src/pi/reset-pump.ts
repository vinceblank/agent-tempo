/**
 * Reset pump (3d D14) — polls the session workflow's single-slot pending reset
 * and performs a CLEAN-WIPE on the live Pi session, then acks it. Sibling to
 * {@link CuePump}: Pi has no reverse-RPC from Temporal, so reset (an operator/
 * conductor CONTROL op — it bypasses the MD-G tool gate) is delivered by polling
 * `pendingReset` and acking via the race-safe `ackReset(resetId)` (the workflow
 * clears the slot only if the id still matches, so a newer reset landing during
 * the wipe is preserved for the next tick).
 *
 * D14 (maintainer-ruled): reset = clean-wipe via Pi `session.newSession()` (fresh
 * context, NO replay). Seeded reset is a separate concern (`restart` +
 * `loadFromState`), so a `fresh:false` here is defensively logged + acked (never
 * silently wiped) — the reset tool only ever sends `fresh:true` today.
 */
import type { PendingReset } from '../types';
import type { PiAgentSession } from './pi-types';

/** Source of the pending reset + ack — satisfied by `PiWorkflowClient`. */
export interface ResetSource {
  fetchPendingReset(): Promise<PendingReset | null>;
  ackReset(resetId: string): Promise<void>;
}

/** Resolves the CURRENT live Pi session at wipe time (re-acquired each tick — D11). */
export type SessionResolver = () => PiAgentSession | null;

export interface ResetPumpOptions {
  source: ResetSource;
  resolveSession: SessionResolver;
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
  private readonly intervalMs: number;
  private timer: ReturnType<typeof setInterval> | null = null;
  private draining = false;

  constructor(opts: ResetPumpOptions) {
    this.source = opts.source;
    this.resolveSession = opts.resolveSession;
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
   * One poll cycle: fetch the pending reset; if present + a live session is
   * attached, perform the wipe and ack. Re-entrancy guarded so a slow tick never
   * overlaps the next interval. Public for unit tests to drive directly.
   */
  async tick(): Promise<void> {
    if (this.draining) return;
    this.draining = true;
    try {
      const pr = await this.source.fetchPendingReset();
      if (!pr) return;

      const session = this.resolveSession();
      if (!session) return; // no live session yet — leave it pending; next tick retries

      await this.performReset(session, pr);
      await this.source.ackReset(pr.resetId);
    } finally {
      this.draining = false;
    }
  }

  /** Wipe (D14 clean-wipe) + deliver the "context wiped" notice. */
  private async performReset(session: PiAgentSession, pr: PendingReset): Promise<void> {
    if (!pr.fresh) {
      // D14: reset is clean-wipe ONLY. A seeded reset would be restart+loadFromState
      // (not this path). Don't guess — log + fall through to ack (clear the slot).
      log(`reset ${pr.resetId}: fresh=false — no wipe (seeded reset is restart's job)`);
      return;
    }
    if (typeof session.newSession !== 'function') {
      log(`reset ${pr.resetId}: session.newSession() unavailable — skipping wipe (will still ack)`);
      return;
    }
    await session.newSession(); // clean-wipe: fresh context, no replay
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
}
