/**
 * Idle poll backoff (#749, T0.2 of the #747 Tier-0 cost epic).
 *
 * Every SDK-class adapter (copilot, claude-api, opencode,
 * claude-code-headless, mock) drives a `pendingMessages` poll loop against
 * its session workflow. Pre-#749 all five polled at a fixed 2s cadence —
 * 43,200 billable queries/day/player even when the player sat idle
 * overnight. Temporal Cloud bills queries as actions (1 each), so idle
 * polling was the dominant per-player line item
 * (docs/design/temporal-cost-rearchitecture.md, driver #3).
 *
 * This helper implements true IDLE backoff: each empty poll stretches the
 * next delay by {@link SDK_POLL_BACKOFF_FACTOR} up to {@link SDK_POLL_MAX_MS};
 * any delivered message snaps back to {@link SDK_POLL_BASE_MS} so an active
 * conversation keeps the legacy 2s responsiveness. Steady-state idle lands
 * at one query per 30s = 2,880/day — a 15× reduction (43,200 ÷ 2,880;
 * ratio locked by a unit test).
 *
 * Trade-off (accepted in #749): the FIRST cue to a long-idle player waits up
 * to 30s before the adapter notices. Delivery itself is unchanged — the
 * workflow inbox is durable and the next poll drains the full batch. The
 * T1.1 doorbell (push delivery) later removes even that latency.
 *
 * Pure and timer-free — callers own the `setTimeout`/`sleep`; this class
 * only computes delays. That keeps it unit-testable without fake timers.
 *
 * **This file runs in the Node.js adapter process, NOT the Temporal workflow
 * sandbox.**
 */
import { ENV } from '../../config';

/** Fast-poll cadence while a conversation is active (legacy behavior). */
export const SDK_POLL_BASE_MS = 2_000;
/** Growth factor per consecutive empty poll. Matches the interactive
 * claude-code poller's error-backoff factor (adapter.ts) — one family of
 * curves across the codebase. */
export const SDK_POLL_BACKOFF_FACTOR = 1.5;
/** Idle ceiling. 15× the base — the steady-state idle cadence. */
export const SDK_POLL_MAX_MS = 30_000;

/** Parse a positive-integer env override; fall back on absent/garbage. */
function envInt(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw === undefined || raw === '') return fallback;
  const n = Number.parseInt(raw, 10);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

export interface IdleBackoffConfig {
  baseMs: number;
  factor: number;
  maxMs: number;
}

/**
 * Resolve the poll-backoff config, honoring the `AGENT_TEMPO_SDK_POLL_BASE_MS`
 * / `AGENT_TEMPO_SDK_POLL_MAX_MS` env overrides (read at call time, not module
 * load, so tests and spawners can set them per-process). Setting
 * `..._MAX_MS` equal to `..._BASE_MS` pins the legacy fixed cadence —
 * the dev/test escape hatch.
 */
export function resolveIdleBackoffConfig(): IdleBackoffConfig {
  const baseMs = envInt(ENV.SDK_POLL_BASE_MS, SDK_POLL_BASE_MS);
  const maxMs = Math.max(baseMs, envInt(ENV.SDK_POLL_MAX_MS, SDK_POLL_MAX_MS));
  return { baseMs, factor: SDK_POLL_BACKOFF_FACTOR, maxMs };
}

/**
 * Pure delay computer for an idle-backoff poll loop.
 *
 * Usage per tick:
 *
 * ```ts
 * const delay = backoff.next(messages.length > 0);
 * await sleep(delay);
 * ```
 *
 * - `next(true)`  → conversation is live: reset to `baseMs` and return it.
 * - `next(false)` → idle tick: grow the delay by `factor` (capped at `maxMs`)
 *                   and return the grown value. Matches the reference
 *                   poller's grow-then-sleep shape.
 * - `reset()`     → external "activity happened" signal (e.g. an SDK turn
 *                   just finished and follow-ups are likely).
 */
export class IdleBackoff {
  private readonly cfg: IdleBackoffConfig;
  private currentMs: number;

  constructor(cfg: IdleBackoffConfig = resolveIdleBackoffConfig()) {
    this.cfg = cfg;
    this.currentMs = cfg.baseMs;
  }

  /** The delay the next idle sleep would use (read-only; for logs/tests). */
  get current(): number {
    return this.currentMs;
  }

  /** Compute the next poll delay from this tick's outcome. */
  next(hadActivity: boolean): number {
    if (hadActivity) {
      this.currentMs = this.cfg.baseMs;
    } else {
      this.currentMs = Math.min(this.currentMs * this.cfg.factor, this.cfg.maxMs);
    }
    return this.currentMs;
  }

  /** Snap back to the fast cadence. */
  reset(): void {
    this.currentMs = this.cfg.baseMs;
  }
}
