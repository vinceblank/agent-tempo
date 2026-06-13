/**
 * Daemon-side cue-deliverability preflight (#822).
 *
 * The maestro-outbox write endpoints (`POST .../cue`, `.../ask`, `.../reset`,
 * and the board `/handoff` which routes through `.../cue`) historically enqueued
 * to ANY target phase and returned a bare `202 { ok: true }` — so the
 * command-center board rendered a confident `✓` even when the target had no live
 * adapter (phase `detached`/`gone`) and the message merely queued on the
 * workflow inbox, undelivered until re-attach. The MCP `cue` tool already guards
 * this (`UNDELIVERABLE_PHASES` in `src/tools/cue.ts`) but it runs in-process
 * before the Temporal write; the HTTP surface skipped the preflight entirely.
 *
 * This helper mirrors that phase check for the HTTP write surface, with one
 * deliberate product divergence (design note Part 2, Ruling A): the operator
 * board is **warn-but-queue**, NOT hard-fail like the MCP tool. The MCP tool
 * serves an autonomous LLM that should re-route; the board serves a human
 * operator who wants the message to durably land and just needs to KNOW it's
 * queued, not delivered. So the endpoint keeps the enqueue and returns the
 * target's deliverability so the board can render `⚠ queued (detached — delivers
 * on re-attach)` instead of `✓`.
 *
 * Soft-failing: the preflight is bounded (1s) and never blocks the enqueue. On
 * timeout / query error / unresolvable target it reports `'live'` (best-effort —
 * the same posture as the MCP tool's preflight catch).
 */
import type { TempoClient } from '../client/interface';
import type { AttachmentPhase } from '../types';

/**
 * Phases where the target has no live adapter, so a cue/ask/reset queues on the
 * workflow inbox undelivered (auto-redelivers on re-attach). Mirrors
 * `UNDELIVERABLE_PHASES` in `src/tools/cue.ts` — `draining` is deliberately
 * EXCLUDED (a brief mid-shutdown state whose adapter is still consuming pending
 * messages; flagging it would false-positive on normal teardown).
 */
export const UNDELIVERABLE_PHASES: ReadonlySet<AttachmentPhase> =
  new Set<AttachmentPhase>(['detached', 'gone']);

/** Bounded preflight window — matches the MCP cue tool's 1s operator-interactive cap. */
export const DELIVERABILITY_PREFLIGHT_TIMEOUT_MS = 1000;

/** `'queued'` = enqueued but no live adapter to receive now; `'live'` = a live
 *  adapter is (or is best-effort assumed) present. */
export type Delivery = 'queued' | 'live';

export interface DeliverabilityResult {
  delivery: Delivery;
  /** The observed phase, when the preflight query succeeded. */
  phase?: AttachmentPhase;
}

/** Resolve `p`, or reject with a timeout after `ms`. */
function withTimeout<T>(p: Promise<T>, ms: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('deliverability preflight timed out')), ms);
    if (typeof (timer as { unref?: () => void }).unref === 'function') {
      (timer as { unref: () => void }).unref();
    }
    p.then(
      (v) => {
        clearTimeout(timer);
        resolve(v);
      },
      (err) => {
        clearTimeout(timer);
        reject(err);
      },
    );
  });
}

/**
 * Bounded, soft-failing phase preflight. Returns `{ delivery: 'queued', phase }`
 * ONLY when an undeliverable phase is positively observed; on timeout / query
 * error / unresolvable target it returns `{ delivery: 'live' }` (best-effort —
 * never block the enqueue). Pure of HTTP concerns so `writes.ts` and `qa.ts`
 * share one implementation.
 */
export async function checkDeliverability(
  client: TempoClient,
  ensemble: string,
  playerId: string,
): Promise<DeliverabilityResult> {
  try {
    const info = await withTimeout(
      client.attachmentInfo(ensemble, playerId),
      DELIVERABILITY_PREFLIGHT_TIMEOUT_MS,
    );
    const phase = info?.phase;
    if (phase !== undefined && UNDELIVERABLE_PHASES.has(phase)) {
      return { delivery: 'queued', phase };
    }
    return { delivery: 'live', ...(phase !== undefined ? { phase } : {}) };
  } catch {
    // Timed out / query threw / no session — proceed best-effort (the message
    // still enqueues; auto-redelivery on re-attach applies). Matches the MCP
    // cue tool's soft-fail-to-best-effort posture.
    return { delivery: 'live' };
  }
}

/**
 * Build the additive deliverability fields folded into the `202` JSON body of an
 * outbox-enqueue endpoint. Superset shape satisfying both the design note
 * (`delivery`/`phase`) and the QA regression bar (`queued`/`warning`):
 *
 * - undeliverable → `{ delivery:'queued', phase, queued:true, warning:'queued-undeliverable (<phase>)' }`
 * - live → `{ delivery:'live', queued:false }` (NO `warning` field — a healthy
 *   target must read as a clean success)
 */
export function deliverabilityResponseFields(
  r: DeliverabilityResult,
): { delivery: Delivery; queued: boolean; phase?: AttachmentPhase; warning?: string } {
  if (r.delivery === 'queued') {
    return {
      delivery: 'queued',
      queued: true,
      ...(r.phase !== undefined ? { phase: r.phase } : {}),
      warning: `queued-undeliverable${r.phase !== undefined ? ` (${r.phase})` : ''}`,
    };
  }
  return {
    delivery: 'live',
    queued: false,
    ...(r.phase !== undefined ? { phase: r.phase } : {}),
  };
}
