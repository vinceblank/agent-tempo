/**
 * Cue pump — pulls cues queued on the session workflow and injects them into
 * the LIVE Pi session via `sendMessage`, then acks them.
 *
 * Pi has no reverse-RPC into a running session from Temporal, so (like the
 * existing adapters) we poll `pendingMessages` and ack via `markDelivered`.
 * Injection uses D10's FLIPPED default: `deliverAs: 'steer'` + `triggerTurn:
 * true` — steer interrupts any in-flight turn so a cue lands promptly.
 *
 * Adapted from Pi's `examples/extensions/file-trigger.ts`.
 */
import type { Message } from '../types';
import type { PiAgentSession } from './pi-types';

/** Source of pending cues + ack — satisfied by `PiWorkflowClient`. */
export interface CueSource {
  fetchPending(): Promise<Message[]>;
  ackDelivered(messageIds: string[]): Promise<void>;
}

/**
 * Resolves the CURRENT live Pi session at injection time. Re-acquired on every
 * tick rather than captured once, so a session switch (D11) never injects into
 * a stale session. Returns `null` when no session is attached.
 */
export type SessionResolver = () => PiAgentSession | null;

export interface CuePumpOptions {
  source: CueSource;
  resolveSession: SessionResolver;
  /** Poll interval (ms). */
  intervalMs?: number;
}

const DEFAULT_POLL_MS = 1_000;

const log = (...args: unknown[]): void => {
  // eslint-disable-next-line no-console
  console.error('[agent-tempo:pi]', ...args);
};

export class CuePump {
  private readonly source: CueSource;
  private readonly resolveSession: SessionResolver;
  private readonly intervalMs: number;
  private timer: ReturnType<typeof setInterval> | null = null;
  private draining = false;

  constructor(opts: CuePumpOptions) {
    this.source = opts.source;
    this.resolveSession = opts.resolveSession;
    this.intervalMs = opts.intervalMs ?? DEFAULT_POLL_MS;
  }

  start(): void {
    if (this.timer) return;
    this.timer = setInterval(() => {
      this.tick().catch((err) => log('cue-pump tick failed:', err));
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
   * One poll cycle: fetch pending cues, inject each into the live session, ack
   * the ones successfully injected. Re-entrancy guarded so a slow tick never
   * overlaps the next interval.
   */
  async tick(): Promise<void> {
    if (this.draining) return;
    this.draining = true;
    try {
      const pending = await this.source.fetchPending();
      if (pending.length === 0) return;

      const session = this.resolveSession();
      if (!session) {
        // No live session yet — leave cues queued; next tick retries.
        return;
      }

      const delivered: string[] = [];
      for (const msg of pending) {
        try {
          await this.injectCue(session, msg);
          delivered.push(msg.id);
        } catch (err) {
          log(`failed to inject cue ${msg.id}:`, err);
          // Stop on first failure — preserve ordering; retry next tick.
          break;
        }
      }
      await this.source.ackDelivered(delivered);
    } finally {
      this.draining = false;
    }
  }

  /** Inject one cue into the live session (D10: steer + triggerTurn). */
  private async injectCue(session: PiAgentSession, msg: Message): Promise<void> {
    const content = msg.from ? `[cue from ${msg.from}] ${msg.text}` : msg.text;
    await session.sendMessage(
      { customType: 'cue', content, display: true },
      { deliverAs: 'steer', triggerTurn: true },
    );
  }
}
