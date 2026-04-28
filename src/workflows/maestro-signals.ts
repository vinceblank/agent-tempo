import { defineSignal, defineQuery, defineUpdate } from '@temporalio/workflow';
import type {
  MaestroPlayerInfo,
  MaestroEvent,
  MaestroPendingCommand,
  MaestroRelayMessage,
  EnsembleChatResult,
  EnsembleChatQuery,
  Message,
  SentMessage,
  HostProfile,
} from '../types';

// Re-export types for convenience within workflow code
export type {
  MaestroPlayerInfo,
  MaestroEvent,
  MaestroPendingCommand,
  MaestroInput,
  MaestroRelayMessage,
  GlobalMaestroInput,
  EnsembleChatMessage,
  EnsembleChatResult,
  EnsembleChatQuery,
  ChatHighWater,
} from '../types';
export { ZERO_CHAT_HIGH_WATER } from '../types';

// ── Per-Ensemble Maestro Signals (existing) ──

/** Gracefully shut down the Maestro workflow. */
export const maestroShutdownSignal = defineSignal('maestroShutdown');

/** Set the ensemble-wide paused state. */
export const maestroSetPausedSignal = defineSignal<[boolean]>('maestroSetPaused');

/**
 * #399 W1 (Q5.1) — set the ensemble's mission-flavor description.
 *
 * Surfaced on the dashboard EnsembleCard. Conductors are encouraged to
 * keep this short (~80 chars, soft cap 100) and refresh at milestone
 * boundaries — see the conductor agent definition for the responsibility
 * note. Empty string clears the description.
 */
export const setEnsembleDescriptionSignal = defineSignal<[string]>('setEnsembleDescription');

// ── Per-Ensemble Maestro Queries (existing) ──

/** Get the current snapshot of all players in the ensemble. */
export const maestroPlayersQuery = defineQuery<MaestroPlayerInfo[]>('maestroPlayers');

/** Get the event log (ring buffer, max 200 entries). */
export const maestroEventsQuery = defineQuery<MaestroEvent[]>('maestroEvents');

/** Query whether the ensemble is paused. */
export const maestroPausedQuery = defineQuery<boolean>('maestroPaused');

/** Get pending commands (queued but not yet relayed to conductor). */
export const maestroPendingCommandsQuery = defineQuery<MaestroPendingCommand[]>('maestroPendingCommands');

/** Paginated ensemble chat from cached state (maestro + conductor traffic). */
export const maestroEnsembleChatQuery = defineQuery<
  EnsembleChatResult,
  [EnsembleChatQuery]
>('maestroEnsembleChat');

/**
 * #399 W1 (Q5.1) — current ensemble description (mission-flavor text).
 * Empty string when no description has been set.
 */
export const getEnsembleDescriptionQuery = defineQuery<string>('getEnsembleDescription');

/**
 * #399 W1 (Q5.3a) — ISO timestamp of the maestro's first start
 * (`workflowInfo().startTime`, preserved across continueAsNew via
 * `MaestroInput.startTimeIso`). Dashboard derives uptime client-side.
 */
export const getEnsembleStartTimeQuery = defineQuery<string>('getEnsembleStartTime');

/**
 * #399 W1 (Q5.6 Flavor B) — current ensemble BPM derived from the last
 * minute of activity (the two most recent 30-second buckets). Returns
 * `0` when activity hasn't yet accumulated a bucket.
 */
export const getCurrentBpmQuery = defineQuery<number>('getCurrentBpm');

/**
 * #399 W1 (Q5.6 Flavor B) — most recent 60 finished 30-second activity
 * buckets (oldest-first). Each entry is a count of player-activity
 * deltas accumulated during that window. Used by the dashboard's
 * `TempoStrip` sparkline.
 */
export const getTempoSeriesQuery = defineQuery<number[]>('getTempoSeries');

// ── Per-Ensemble Maestro Updates (existing) ──

/** Queue a command to be relayed to the conductor. Returns the command ID. */
export const maestroSendCommandUpdate = defineUpdate<string, [{ text: string; source: string; replyTo?: string }]>('maestroSendCommand');

// ══════════════════════════════════════════════════════════════════════════════
// Global Maestro — single instance handling ALL ensembles
// ══════════════════════════════════════════════════════════════════════════════

// ── Global Maestro Signals ──

/** Notify the global Maestro of a relayed message (for Phase 2 push-based updates). */
export const maestroNotifyMessageSignal = defineSignal<[MaestroRelayMessage]>('maestroNotifyMessage');

/**
 * #274 — daemon advertises its capability profile at boot.
 *
 * Payload typed as `Record<string, unknown>` at the wire boundary so the
 * global maestro handler can accept additive fields from future daemon
 * versions without breaking. Handler validates ONLY `hostname` (required,
 * `PLAYER_NAME_REGEX`, ≤64 chars); all other fields stored opaquely. Per-
 * field Zod validation happens at the `listHosts` join site in
 * `src/utils/hosts.ts`, never here. See #274 architect delta AC3c (M9).
 *
 * Daemons MUST scrub PII before signaling (AC5c / M10) — claudeBin is
 * basename only; availableAgentTypes is type names only; no absolute
 * paths, env vars, or user-home fragments.
 */
export const hostProfileSignal = defineSignal<[Record<string, unknown>]>('hostProfile');

// ── Global Maestro Queries ──

/** Get the list of known ensembles. */
export const maestroEnsemblesQuery = defineQuery<string[]>('maestroEnsembles');

/** Get players grouped by ensemble. */
export const maestroPlayersByEnsembleQuery = defineQuery<Record<string, MaestroPlayerInfo[]>>('maestroPlayersByEnsemble');

/** Get recent messages across all ensembles (ring buffer, max 500). */
export const maestroRecentMessagesQuery = defineQuery<MaestroRelayMessage[]>('maestroRecentMessages');

/**
 * #274 — the `hostname → HostProfile` map maintained by the global maestro.
 *
 * Returned as a plain `Record<string, HostProfile>` (not a `Map`) so the
 * default Temporal payload converter serializes it without a codec tweak.
 * The `src/utils/hosts.ts` join helper consumes this and reconstructs a
 * `Map`-shaped view at the consumer boundary if callers find it useful.
 *
 * Consumers MUST treat the returned profiles as opaque beyond the
 * `hostname` field — per-field validation happens at the join site, not
 * at query time.
 */
export const hostProfilesQuery = defineQuery<Record<string, HostProfile>>('hostProfiles');

/**
 * #280 — combined existence + profiles query.
 *
 * Saves a round-trip on the `listHosts` cache-miss path: the prior
 * implementation called `handle.describe()` to confirm the workflow was
 * `RUNNING` then `handle.query('hostProfiles')` to fetch the data — two
 * sequential RPCs against the same handle. Callers can now hit a single
 * query: success → `{ exists: true, profiles }`; transport failure
 * (workflow not found, terminated, unreachable) → caller catches and
 * treats as `null` (i.e. "missing"). The `exists: true` flag is set
 * explicitly by the handler so future variants — e.g. an "I'm running
 * but in degraded mode" signal — could carry `exists: false` over the
 * wire without breaking older clients.
 *
 * Wire-protocol additive change (new query, no rename) — the legacy
 * `hostProfiles` query stays for backwards compatibility.
 */
export const hostProfilesWithExistenceQuery = defineQuery<{
  exists: boolean;
  profiles: Record<string, HostProfile>;
}>('hostProfilesWithExistence');

// ── Global Maestro Updates ──

/** Send a message to a player in a specific ensemble. Returns the message ID. */
export const maestroSendMessageUpdate = defineUpdate<
  string,
  [{ ensemble: string; to: string; text: string; source: string }]
>('maestroSendMessage');

/** Fetch a player's message history (received + sent). Returns merged timeline. */
export const maestroFetchPlayerMessagesUpdate = defineUpdate<
  Array<Message | (SentMessage & { direction: 'sent' })>,
  [{ ensemble: string; playerId: string }]
>('maestroFetchPlayerMessages');

/** Fetch a conductor's command/report history for an ensemble. */
export const maestroFetchConductorHistoryUpdate = defineUpdate<
  { success: boolean; history: Array<{ type: string; timestamp: string; data: unknown }>; error?: string },
  [{ ensemble: string }]
>('maestroFetchConductorHistory');

/** Queue a command to be relayed to a specific ensemble's conductor. Returns the command ID. */
export const maestroGlobalSendCommandUpdate = defineUpdate<
  string,
  [{ ensemble: string; text: string; source: string; replyTo?: string }]
>('maestroGlobalSendCommand');
