/**
 * Assumed-extended wire shapes for #399 W1/W2 fields that DB1a (daemon
 * snapshot extension) is landing in parallel with this PR.
 *
 * The dashboard codes against this shape; when DB1a merges, the wire
 * types in `claude-tempo/http/event-types` will match and these locals
 * become functionally redundant. We keep them here as an isolation
 * point so the binding code doesn't sprinkle `(snapshot.data as any)`
 * casts.
 *
 * Each field is optional with the same name + type the conductor
 * locked in for DB1a:
 *
 *   EnsembleStateV1 ← description, startedAt, currentBpm, tempoSeries
 *   PlayerSummaryV1 ← runId, messaging, lease, activityCount,
 *                     lastActivityAt
 *
 * If DB1a's ratification changes any field, swap usage at the call
 * sites — the local interfaces below are the only place to update.
 */
import type {
  EnsembleStateV1,
  PlayerSummaryV1,
} from 'claude-tempo/http/event-types';

/** Q5.5 messaging KV bundle from the session's `getMessagingState`. */
export interface ExtendedMessagingState {
  received: number;
  sent: number;
  /** Pre-formatted "empty" / "N pending" / "N pending (oldest 2m)". */
  outbox: string;
}

/** Q5.7 lease window from the session's `getLeaseState`. */
export interface ExtendedLeaseState {
  /** Epoch ms; null when no active lease. */
  expiresAt: number | null;
  leaseMs: number | null;
}

/** PlayerSummaryV1 + DB1a-projected fields. */
export interface ExtendedPlayerSummaryV1 extends PlayerSummaryV1 {
  /** Q5.2 — workflow runId UUID; truncated to `XXXX·XXXX` at render time. */
  runId?: string;
  /** Q5.5 — received/sent/outbox counters. */
  messaging?: ExtendedMessagingState;
  /** Q5.7 — current attachment lease window. */
  lease?: ExtendedLeaseState;
  /** Q5.6 — monotonic activity counter (already on MaestroPlayerInfo). */
  activityCount?: number;
  /** Q5.6 — ISO timestamp of the last activity-counter bump. */
  lastActivityAt?: string;
}

/** EnsembleStateV1 + DB1a-projected fields. */
export interface ExtendedEnsembleStateV1 extends Omit<EnsembleStateV1, 'players'> {
  /** Q5.1 — mission-flavor text from the maestro's getEnsembleDescription. */
  description?: string;
  /** Q5.3a — ISO start time of the original maestro execution. */
  startedAt?: string;
  /** Q5.6 — ensemble BPM from the maestro's getCurrentBpm. */
  currentBpm?: number;
  /** Q5.6 — 60-element activity sparkline (oldest → newest). */
  tempoSeries?: number[];
  /** Players with the extended per-player projection. */
  players: ExtendedPlayerSummaryV1[];
}

/**
 * Cast the raw snapshot to the extended shape. Centralised so DB1a's
 * landing only requires updating this one helper (or removing it).
 *
 * The cast is sound at runtime because every new field is optional;
 * legacy snapshots simply leave them undefined.
 */
export function asExtended(
  s: EnsembleStateV1 | undefined,
): ExtendedEnsembleStateV1 | undefined {
  return s as ExtendedEnsembleStateV1 | undefined;
}
