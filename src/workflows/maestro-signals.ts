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
  CoatCheckEntry,
  CoatCheckEntryHeader,
  AnswerEntry,
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

// ── Coat-check (#318, ADR 0008) ────────────────────────────────────────────
//
// Three updates + one query. `coatCheckGet` is an Update (not a Query) because
// it mutates `lastFetchedAt` / `lastFetchedBy` / `fetchCount` on the entry —
// Temporal Queries cannot mutate. `coatCheckList` stays a Query because it's
// read-only and we don't want operators browsing the list to silently mark
// entries as fetched.
//
// Audit identity (`putBy`, `evictedBy`, `fetchedBy`) is set by the MCP tool
// layer via `getPlayerId()` — the tool schemas have NO `playerId` arg, so
// callers can't spoof. Matches #334's `savedBy` structural-permission pattern.

export interface CoatCheckPutInput {
  summary: string;
  content: string;
  contentType?: string;
  ttlMs?: number;
  /** Audit identity — set by the tool layer, NOT a caller-supplied MCP arg. */
  putBy: string;
}

export interface CoatCheckPutResult {
  ticket: string;
  expiresAt: string;
  slotsUsed: number;
  slotsTotal: number;
}

export interface CoatCheckGetInput {
  ticket: string;
  /** Audit identity — set by the tool layer, NOT a caller-supplied MCP arg. */
  fetchedBy: string;
}

export interface CoatCheckListInput {
  /** Optional `putBy` filter — audit lens for "what did <player> stash?" */
  putBy?: string;
  /** Optional summary-prefix filter. */
  prefix?: string;
  /**
   * When `true`, only return entries with `fetchCount === 0`. Owner cleanup
   * workflow: "show me what nobody's picked up yet."
   */
  unfetchedOnly?: boolean;
}

export interface CoatCheckEvictInput {
  ticket: string;
  /**
   * Audit identity — set by the tool layer. Workflow validator enforces
   * `evictedBy === entry.putBy` OR `evictedBy === <conductor playerId>` so
   * eviction is owner-or-conductor; everyone else gets a
   * `CoatCheckEvictPermissionDenied` ApplicationFailure.
   */
  evictedBy: string;
}

/**
 * Admit a new coat-check entry. Saturation (20-slot cap exhausted) rejects
 * with `CoatCheckSlotsFull` ApplicationFailure carrying the oldest 3 ticket
 * ids in the message. Oversize content rejects with `CoatCheckEntryTooLarge`.
 * Re-export the entry-and-result types so workflow code and tools share one
 * shape.
 */
export const coatCheckPutUpdate = defineUpdate<CoatCheckPutResult, [CoatCheckPutInput]>('coatCheckPut');

/**
 * Fetch a coat-check entry by ticket. Returns the full entry (including
 * content body) on success, or `null` when the ticket is missing / expired /
 * evicted — no error class proliferation for the common "ticket already
 * gone" case. Successful reads mutate `lastFetchedAt` / `lastFetchedBy` /
 * `fetchCount` on the entry; failed reads do not.
 */
export const coatCheckGetUpdate = defineUpdate<CoatCheckEntry | null, [CoatCheckGetInput]>('coatCheckGet');

/**
 * List coat-check entry headers (content omitted) newest-first. Read-only —
 * does NOT bump fetch-audit counters. Optional `putBy` / `prefix` /
 * `unfetchedOnly` filters narrow the result.
 */
export const coatCheckListQuery = defineQuery<CoatCheckEntryHeader[], [CoatCheckListInput?]>('coatCheckList');

/**
 * Evict a coat-check entry by ticket. Owner-or-conductor only — workflow
 * validator rejects mismatched `evictedBy` with `CoatCheckEvictPermissionDenied`.
 * `evicted: false` when the ticket was missing / already expired before the
 * call landed.
 */
export const coatCheckEvictUpdate = defineUpdate<{ evicted: boolean }, [CoatCheckEvictInput]>('coatCheckEvict');

// ══════════════════════════════════════════════════════════════════════════════
// Maestro Q&A answer mailbox (#700 P2) — the coat-check clone for correlated
// answers. The planner (command center) has no Temporal inbox, so a player
// routes its answer through maestro keyed by the planner-supplied `questionId`.
// Audit identity (`from`) is set by the `respond` tool via `getPlayerId()` — no
// spoofable arg, matching coat-check's `putBy` pattern.
// ══════════════════════════════════════════════════════════════════════════════

export interface AnswerPostInput {
  /** Caller-supplied correlation id (the planner mints it; the workflow never does). */
  questionId: string;
  /** Audit identity — set by the `respond` tool layer (`getPlayerId()`), NOT a caller arg. */
  from: string;
  /** The answer body (≤ `MESSAGE_MAX`). */
  text: string;
}

/**
 * Park a correlated answer (player → maestro). Overwriting an existing
 * `questionId` (a retry) does NOT consume a new slot. Saturation
 * (`MAESTRO_ANSWERS_MAX`, post-sweep) rejects with `MaestroAnswersFull`;
 * invalid input rejects with `MaestroAnswerInvalid*`.
 */
export const maestroPostAnswerUpdate = defineUpdate<{ stored: true }, [AnswerPostInput]>('maestroPostAnswer');

/**
 * Read a parked answer by `questionId` (planner → maestro, via the daemon).
 * Returns the entry or `null` when missing / expired (no error class for the
 * common "not answered yet" case). QUERY + TTL (idempotent, reconnect-safe) —
 * a reconnecting planner can re-read its answer until TTL.
 */
export const maestroGetAnswerQuery = defineQuery<AnswerEntry | null, [string]>('maestroGetAnswer');

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

// 2.0 (#788): the legacy `hostProfilesQuery` ('hostProfiles') was removed —
// superseded by `hostProfilesWithExistenceQuery` below, which folds the
// running-check + profiles into a single round-trip. Every consumer uses the
// WithExistence form. Consumers MUST still treat the returned profiles as
// opaque beyond the `hostname` field (validation happens at the join site).

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
