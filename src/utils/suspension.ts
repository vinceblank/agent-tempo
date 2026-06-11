/**
 * Suspension (pause/hold) preflight + warning formatting — issue #752 (B4c
 * of docs/design/temporal-cost-rearchitecture.md).
 *
 * **Motivating incident (2026-06-10)**: a fresh post-crash ensemble came up
 * paused (the intentional #172 warm-hold design); every `cue` reported
 * success; the messages sat in the senders' outboxes for ~5 hours because
 * nothing surfaced the suspension. Pause is a *message brake, not an agent
 * brake* — `canDispatch()` (session.ts) gates outbox dispatch while the
 * tools keep returning success.
 *
 * This module makes suspension LOUD without changing any mechanics:
 *   - `checkSuspension` — bounded, soft-failing reads of the three
 *     suspension axes (maestro/ensemble paused, session paused, session
 *     held/outboxLocked). Every query is wrapped in
 *     `queryHandleWithTimeout` and maps failure → `false` so a missing
 *     maestro hub or a pre-pause-era workflow can never break a cue.
 *   - `formatSuspensionWarning` / `formatSuspensionBanner` — pure
 *     formatters. Both name the resume verb (`play`, with
 *     `release: true` for held sessions) per the issue's AC.
 *
 * Additive only: no wire names are touched — `maestroPaused`, `paused`,
 * and `outboxLocked` are existing stable queries (docs/WIRE-PROTOCOL.md).
 */
import type { Client, WorkflowHandle } from '@temporalio/client';
import { maestroWorkflowId } from '../config';
import { maestroPausedQuery } from '../workflows/maestro-signals';
import { pausedQuery, outboxLockedQuery } from '../workflows/signals';
import { queryHandleWithTimeout } from './query-timeout';

/**
 * Per-query ceiling for the suspension preflight. Matches the cue tool's
 * phase-preflight budget (`CUE_PHASE_PREFLIGHT_TIMEOUT_MS`): operator-
 * interactive paths shouldn't stall on a wedged worker — a timeout simply
 * means "no warning", never an error.
 */
export const SUSPENSION_PREFLIGHT_TIMEOUT_MS = 1000;

/** Pause/hold flags for one session workflow. */
export interface SessionSuspension {
  /** `pausedQuery` — outbox dispatch suspended (ensemble-wide pause fan-out). */
  paused: boolean;
  /** `outboxLockedQuery` — warm hold (recruited `held: true`, not yet released). */
  held: boolean;
}

/** Combined suspension snapshot for a cue/broadcast/banner decision. */
export interface SuspensionState {
  /** Maestro hub `maestroPaused` — the authoritative ensemble-wide flag. */
  ensemblePaused: boolean;
  /** The calling session's own flags (its outbox carries outbound cues). */
  self: SessionSuspension;
  /** The cue target's flags. Absent when no target applies (broadcast, banners). */
  target?: SessionSuspension;
}

const NOT_SUSPENDED: SessionSuspension = { paused: false, held: false };

/** Bounded, soft-failing query — any failure (missing workflow, pre-pause-era
 * build, wedged worker timeout) reads as `false`. */
async function queryFlag(
  handle: WorkflowHandle,
  queryDef: typeof pausedQuery | typeof outboxLockedQuery | typeof maestroPausedQuery,
  timeoutMs: number,
): Promise<boolean> {
  try {
    return (await queryHandleWithTimeout(handle, queryDef, { timeoutMs })) === true;
  } catch {
    return false;
  }
}

async function querySessionSuspension(
  handle: WorkflowHandle,
  timeoutMs: number,
): Promise<SessionSuspension> {
  const [paused, held] = await Promise.all([
    queryFlag(handle, pausedQuery, timeoutMs),
    queryFlag(handle, outboxLockedQuery, timeoutMs),
  ]);
  return { paused, held };
}

/**
 * Read the suspension axes relevant to the caller, in parallel, each bounded
 * by `timeoutMs` (default {@link SUSPENSION_PREFLIGHT_TIMEOUT_MS}).
 *
 * Pass `self` for tools that enqueue on the caller's own outbox (cue,
 * broadcast — a suspended *sender* is exactly the silent-wedge incident);
 * pass `target` on cue so a paused/held recipient is also surfaced. Omit
 * both for ensemble-level banners (1 query total).
 */
export async function checkSuspension(
  client: Client,
  ensemble: string,
  opts: { self?: WorkflowHandle; target?: WorkflowHandle; timeoutMs?: number } = {},
): Promise<SuspensionState> {
  // Belt-and-braces: this preflight is purely advisory — ANY failure
  // (including a client without a live workflow service) must read as
  // "not suspended", never as a cue/banner error.
  try {
    const timeoutMs = opts.timeoutMs ?? SUSPENSION_PREFLIGHT_TIMEOUT_MS;
    const maestroHandle = client.workflow.getHandle(maestroWorkflowId(ensemble));

    const [ensemblePaused, self, target] = await Promise.all([
      queryFlag(maestroHandle, maestroPausedQuery, timeoutMs),
      opts.self ? querySessionSuspension(opts.self, timeoutMs) : Promise.resolve(NOT_SUSPENDED),
      opts.target ? querySessionSuspension(opts.target, timeoutMs) : Promise.resolve(undefined),
    ]);

    return { ensemblePaused, self, ...(target !== undefined ? { target } : {}) };
  } catch {
    return { ensemblePaused: false, self: NOT_SUSPENDED };
  }
}

/** The resume instruction every warning/banner ends with — single source of
 * truth so the verb hint can't drift between surfaces. */
export const RESUME_HINT =
  'Resume with the `play` tool — use `play { release: true }` to also release held sessions.';

/**
 * Cause phrases for the active suspension axes — pure, deterministic order
 * (ensemble → self → target). Empty array when nothing is suspended.
 *
 * Each phrase states the *operational consequence* honestly:
 *  - sender-side suspension (ensemble/self) → the just-queued outbox entry
 *    will NOT dispatch until resume;
 *  - target paused → it receives but cannot reply;
 *  - target held → it was recruited on warm hold and is waiting for release.
 */
export function describeSuspensionCauses(
  state: SuspensionState,
  opts: { targetPlayerId?: string } = {},
): string[] {
  const causes: string[] = [];
  if (state.ensemblePaused) causes.push('the ensemble is PAUSED');
  if (state.self.paused && !state.ensemblePaused) causes.push('your session is PAUSED');
  if (state.self.held) causes.push('your session is HELD (outbox locked)');
  const t = opts.targetPlayerId ?? 'the target';
  if (state.target?.paused && !state.ensemblePaused) {
    causes.push(`"${t}" is PAUSED (it can receive but cannot reply)`);
  }
  if (state.target?.held) {
    causes.push(`"${t}" is HELD (recruited on warm hold, awaiting release)`);
  }
  return causes;
}

/**
 * Warning block appended to a cue/broadcast success response when any
 * suspension axis is active. `null` when fully unsuspended.
 *
 * Wording contract (#752 AC): the message IS queued and WILL deliver on
 * resume; the resume verb is named explicitly.
 */
export function formatSuspensionWarning(
  state: SuspensionState,
  opts: { targetPlayerId?: string } = {},
): string | null {
  const causes = describeSuspensionCauses(state, opts);
  if (causes.length === 0) return null;
  return (
    `⚠ SUSPENDED: ${causes.join('; ')}. ` +
    `The message IS queued durably and will deliver automatically on resume — ` +
    `but nobody will act on it until then. ${RESUME_HINT}`
  );
}

/**
 * Status banner for `ensemble` / `who_am_i` output. `null` when nothing is
 * suspended. Multi-line: one ⏸ line per active axis + the resume hint.
 */
export function formatSuspensionBanner(
  state: SuspensionState,
  ensemble: string,
): string | null {
  const lines: string[] = [];
  if (state.ensemblePaused) {
    lines.push(`⏸ ENSEMBLE PAUSED — "${ensemble}" outbox dispatch and scheduler fires are suspended; cues queue silently.`);
  }
  if (state.self.paused && !state.ensemblePaused) {
    lines.push('⏸ YOUR SESSION IS PAUSED — your outgoing cues/reports will queue, not send.');
  }
  if (state.self.held) {
    lines.push('⏸ YOUR SESSION IS HELD — outbox locked since recruit (warm hold); your outgoing cues/reports will queue, not send.');
  }
  if (lines.length === 0) return null;
  lines.push(RESUME_HINT);
  return lines.join('\n');
}
