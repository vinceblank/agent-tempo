import { defineSignal, defineQuery, defineUpdate } from '@temporalio/workflow';
// Issue #172 (v0.26 simplification): the `setPendingStartupContext` update
// and `pendingStartupContext` query were removed. Hold-on-startup is now
// driven by baking the conductor's lineup instructions + banner/directive
// directly into `SessionInput.messages[]` at workflow creation — no
// workflow state, no `receiveMessage` interceptor. See CHANGELOG.

import type {
  SessionMetadata,
  Message,
  SentMessage,
  HistoryEntry,
  OutboxEntry,
  OutboxEntryInput,
  QualityGate,
  WorktreeEntry,
  StageEntry,
  AttachmentToken,
  AttachmentInfo,
  AdapterClass,
  DetachReason,
  OrphanSummary,
  PlayerStateEntry,
} from '../types';

// Re-export types for convenience within workflow code
export type {
  SessionMetadata,
  SessionInput,
  Message,
  Command,
  PlayerReport,
  SentMessage,
  HistoryEntry,
  OutboxEntry,
  OutboxEntryInput,
  OutboxEntryStatus,
  CueOutboxEntry,
  RecruitOutboxEntry,
  ReportOutboxEntry,
  StopOutboxEntry,
  ReleaseOutboxEntry,
  SpawnOutboxEntry,
  AgentType,
  QualityGate,
  QualityGateCriterion,
  WorktreeEntry,
  StageEntry,
  StagePlayerStatus,
  AttachmentToken,
  AttachmentInfo,
  AttachmentPhase,
  Attachment,
  AdapterClass,
  AdapterDescriptor,
  DetachReason,
  AdapterDirective,
  OrphanSummary,
  PlayerStateEntry,
} from '../types';

// ── Player Signals ──

// `isScheduled` + `scheduleName` are set by `src/activities/schedule-fire.ts`
// when the message originated from the scheduler workflow — allows dashboards
// and consumers to distinguish scheduled fires from direct cues. Documented in
// docs/WIRE-PROTOCOL.md; runtime senders have populated both fields since the
// scheduler shipped, but the TS type drifted (#251). Optional everywhere.
// `broadcastId` (#357) is an additive optional field — same id on every fan-out
// target of one `broadcast` invocation. The TUI uses it to fold N deliveries
// into one chat row.
// `attachmentTicket` (#318) is an additive optional field — coat-check ticket
// the sender stashed via `coat_check_put`; the recipient pulls the body via
// `coat_check_get`. Backward-compatible — pre-#318 cues simply don't have it.
export const receiveMessageSignal = defineSignal<[{ from: string; text: string; isMaestro?: boolean; isScheduled?: boolean; scheduleName?: string; responseRequested?: boolean; broadcastId?: string; attachmentTicket?: string }]>('receiveMessage');
export const recordSentMessageSignal = defineSignal<[{ to: string; text: string; broadcastId?: string }]>('recordSentMessage');
export const setPartSignal = defineSignal<[string]>('setPart');
export const markDeliveredSignal = defineSignal<[string[]]>('markDelivered');
export const setNameSignal = defineSignal<[string]>('setName');
export const updateMetadataSignal = defineSignal<[{ hostname?: string; gitBranch?: string; gitRoot?: string; terminatedBy?: string; enableStaleDetection?: boolean; playerType?: string; playerTypeDescription?: string; worktreePath?: string; sessionId?: string }]>('updateMetadata');

// ── Player Queries ──

export const getPartQuery = defineQuery<string>('getPart');
export const getMetadataQuery = defineQuery<SessionMetadata>('getMetadata');
export const pendingMessagesQuery = defineQuery<Message[]>('pendingMessages');
export const allMessagesQuery = defineQuery<Message[]>('allMessages');
export const allSentMessagesQuery = defineQuery<SentMessage[]>('allSentMessages');

// ── Hold / Release ──

/** Release a held session — unlocks the outbox and delivers the stored initial message. */
export const releaseHeldSignal = defineSignal('releaseHeld');
/** Query whether the session's outbox is locked (warm hold). */
export const outboxLockedQuery = defineQuery<boolean>('outboxLocked');
/** Set the paused state for the session (ensemble-wide pause/resume). */
export const setPausedSignal = defineSignal<[boolean]>('setPaused');
/** Query whether the session is paused. */
export const pausedQuery = defineQuery<boolean>('paused');

// ── Conductor Signals ──

export const commandSignal = defineSignal<[{ text: string; source: string; replyTo?: string }]>('command');
export const playerReportSignal = defineSignal<[{ playerId: string; text: string; type: 'result' | 'blocker' | 'question' }]>('playerReport');

// ── Conductor Queries ──

export const historyQuery = defineQuery<HistoryEntry[]>('history');

// ── Processing Lifecycle (fixes #99; phase machine hook in v0.25) ──
// Suppress stale detection while the adapter is in a blocking operation (e.g. LLM tool call).
// `messageId` is required for idempotency — at-least-once update retries otherwise corrupt the set.
//
// v0.25 extends the input to carry `expectedAttachmentId` and the return to carry
// `inFlightCount`. The MVP shape (`{ messageId }`, `void`) remains supported by the
// compat shim; when `expectedAttachmentId` is absent the handler operates on whatever
// attachment is currently active (reconstructing MVP semantics).
//
// Post-PR-C, adapters always provide `expectedAttachmentId` so the workflow can reject
// updates intended for a superseded attachment.

/** Signal that the adapter has started processing an inbound message (blocking LLM/tool call). */
export const processingStartUpdate = defineUpdate<
  { inFlightCount: number },
  [{ messageId: string; expectedAttachmentId?: string }]
>('processingStart');
/** Signal that the adapter has finished processing an inbound message. */
export const processingEndUpdate = defineUpdate<
  { inFlightCount: number },
  [{ messageId: string; expectedAttachmentId?: string }]
>('processingEnd');
/** Query currently in-flight message IDs. */
export const inFlightMessagesQuery = defineQuery<string[]>('inFlightMessages');

// ── Destroy Verb (fixes #102; terminal per §8.5) ──
// Permanent, terminal teardown. Once destroyed, the workflow refuses all attach-adjacent ops
// and adapters (bridge) must exit cleanly instead of reconnecting.

/** Destroy the session: abandon in-flight outbox per §2.5, emit audit event, COMPLETE. */
export const destroyUpdate = defineUpdate<void, [{ reason?: string; terminatedBy?: string }]>('destroy');
/** Query whether the session has been destroyed. */
export const isDestroyedQuery = defineQuery<boolean>('isDestroyed');

// ── v0.25 Attachment Lifecycle (design §§8, §9.2, §11.1) ──

/**
 * Transactionally claim or renew the attachment lease on this workflow.
 *
 * - **First claim**: `expectedAttachmentId` absent, no live attachment → fresh `Attachment`
 *   created, phase `booting → attached` (or `detached → attached`).
 * - **Renewal**: `expectedAttachmentId` matches current attachment AND lease not expired
 *   → extend `expiresAt` and `lastHeartbeatAt`. Returns same token.
 * - **Conflict**: live attachment held by a different claimant → rejects with
 *   `AttachmentConflict` ApplicationFailure.
 * - **WorkflowGone**: phase is `gone` → rejects with `WorkflowGone`.
 */
export const claimAttachmentUpdate = defineUpdate<
  AttachmentToken,
  [{
    host: string;
    adapterId: string;
    adapterClass: AdapterClass;
    leaseMs: number;
    /** Present on renewal; absent on fresh claim. */
    expectedAttachmentId?: string;
  }]
>('claimAttachment');

/**
 * Revoke the current attachment. Options for drain-grace behavior during `draining` phase.
 * Returns `{ reaped: true }` when a live attachment was revoked, `{ reaped: false }` when
 * already detached (idempotent).
 */
export const forceDetachUpdate = defineUpdate<
  { reaped: boolean; previousAttachmentId?: string },
  [{
    reason: DetachReason;
    /** If provided, only act if the current attachmentId matches. Prevents TOCTOU. */
    expectedAttachmentId?: string;
    /** 0 = immediate; >0 = wait up to this long for `drainingDeadline` first. */
    gracePeriodMs: number;
  }]
>('forceDetach');

/**
 * Queue a spawn-outbox entry carrying the claim token. Called by `restart` after a successful
 * `claimAttachment`. Workflow-side spawn-failure rollback lives in §8.4.
 */
export const enqueueSpawnUpdate = defineUpdate<
  { spawnEntryId: string },
  [{
    host: string;
    attachmentId: string;
    runId: string;
    resume: boolean;
    sessionId?: string;
    adapterId: string;
    /** Resolved agent definition so restart spawns `--agent`/`--system-prompt`
     *  the same way recruit does. See #184. */
    agentDefinition?: string;
    agentDefinitionPath?: string;
    nativeResolvable?: boolean;
    /** #131 Phase C — claude-api model id carried across restart. */
    model?: string;
  }]
>('enqueueSpawn');

/** Record a preferred host for daemon reconcile-on-boot targeting. */
export const setPreferredHostUpdate = defineUpdate<void, [{ host: string }]>('setPreferredHost');

// ── v0.25 Attachment Signals ──

/**
 * Liveness heartbeat from the adapter. Resets `lastHeartbeatAt` and extends `expiresAt` to
 * `workflow.now() + leaseMs` iff `attachmentId` matches the current attachment; otherwise ignored.
 *
 * 3c Tier-1 (additive, optional, non-breaking): the heartbeat doubles as the
 * coarse-activity piggyback. `currentTool` (null = idle), `contextTokens`, and
 * `contextPercent` (Pi `getContextUsage`, pull-only — no token event exists)
 * refresh the workflow's queryable coarse state read by `getCoarseActivityQuery`.
 * Omitted by senders that don't report coarse — the handler merges field-wise.
 */
export const heartbeatSignal = defineSignal<[{
  attachmentId: string;
  at: string;
  currentTool?: string | null;
  contextTokens?: number;
  contextPercent?: number;
}]>('heartbeat');

/**
 * Adapter-, conductor-, or operator-initiated request to detach gracefully.
 * Phase transitions to `draining`; outbox continues to drain up to `deadlineMs` then
 * the main loop reaps.
 */
export const requestDetachSignal = defineSignal<[{ reason: DetachReason; deadlineMs: number }]>('requestDetach');

/**
 * Final acknowledgement from a detaching adapter. Collapses `draining → detached` immediately
 * if `attachmentId` matches the current attachment; ignored on `detached` (no-op).
 */
export const adapterExitedSignal = defineSignal<[{ attachmentId: string; reason: DetachReason }]>('adapterExited');

// ── v0.25 Attachment Queries ──

/** Current attachment state + phase + in-flight count. Read by adapters, tools, and the TUI. */
export const attachmentInfoQuery = defineQuery<AttachmentInfo>('attachmentInfo');

/**
 * Daemon and CLI `restore` summary — metadata to render a detached-orphan card and decide
 * whether auto-restore applies.
 */
export const orphanSummaryQuery = defineQuery<OrphanSummary>('orphanSummary');

// ── Player Saveable State (#334 PR-1, ADR 0011) ──
//
// Per-session, player-curated state slots. Player-only writes (no `playerId`
// arg → tool wires the calling player's own handle); peer reads via
// `playerStateQuery`. Sized per design §3.3: max 4 slots × 32 KiB content
// = 128 KiB structural max. Saturation rejects with `PlayerStateSlotsFull`
// rather than evicting LRU.
//
// Validators run pre-handler so size/slot-cap rejections never commit
// history events. See `src/utils/validation.ts` for the constants.

/**
 * Save curated state for the calling player into a named slot.
 *
 * Validation (pre-handler):
 *  - `key` matches `PLAYER_STATE_KEY_REGEX` (alphanumeric + underscore + hyphen,
 *    1–32 chars). `PlayerStateInvalidKey` on mismatch.
 *  - `content` byte length ≤ `PLAYER_STATE_CONTENT_MAX` (32 KiB).
 *    `PlayerStateContentTooLarge` on overflow.
 *  - When the key is new and slots already at `PLAYER_STATE_SLOTS_MAX` (4),
 *    rejects with `PlayerStateSlotsFull` and lists existing keys so the LLM
 *    can pick which slot to clear.
 *
 * On success, writes `{ content, savedAt: workflowNow().toISOString(), savedBy }`
 * to `playerState[key]`. Carried via `continueAsNew`.
 */
export const savePlayerStateUpdate = defineUpdate<
  { saved: true; savedAt: string },
  [{ key: string; content: string; savedBy: string }]
>('savePlayerState');

/**
 * Clear the named slot. Returns `{ cleared: true }` if the slot existed,
 * `{ cleared: false }` if it was already empty (idempotent). Validates `key`
 * against `PLAYER_STATE_KEY_REGEX`.
 */
export const clearPlayerStateUpdate = defineUpdate<
  { cleared: boolean },
  [{ key: string }]
>('clearPlayerState');

/**
 * Read the named slot. Returns `null` when the slot is empty.
 * `key` defaults to `PLAYER_STATE_DEFAULT_KEY` ('main').
 *
 * Peer-readable: any player in the ensemble may query any other player's
 * saved state (audit identity is the entry's `savedBy`). Mirrors the
 * `recall`/`attachment_info` ergonomics.
 */
export const playerStateQuery = defineQuery<
  PlayerStateEntry | null,
  [{ key?: string }]
>('playerState');

/** List names of populated slots (sorted). Returns `[]` when no slots are saved. */
export const playerStateKeysQuery = defineQuery<string[]>('playerStateKeys');

// ── Outbox Update + Query ──

export const submitOutboxUpdate = defineUpdate<string, [OutboxEntryInput]>('submitOutbox');
export const outboxQuery = defineQuery<OutboxEntry[]>('outbox');

// ── #399 W2 — Session wire extensions (Q5.2 / Q5.5 / Q5.6 / Q5.7) ──
//
// Additive queries that surface session-level fields the dashboard
// renders as `"—"` placeholders today. All counters live on the session
// workflow + carry across continueAsNew via SessionInput.

/**
 * Q5.2 — runId of the current workflow execution. Returned as the raw
 * UUID string from `workflowInfo().runId`; the dashboard truncates to
 * `XXXX·XXXX` (first 4 + last 4 + middle dot) client-side so this query
 * stays a thin pass-through.
 */
export const getRunIdQuery = defineQuery<string>('getRunId');

/**
 * Q5.5 — messaging counters + outbox status summary. The dashboard
 * renders three KV rows under `Messages`. Counters are monotonic
 * across the workflow's lifetime (preserved across continueAsNew via
 * SessionInput).
 *
 * `outbox` is a reduce-helper string: `"empty"` / `"N pending"` /
 * `"N pending (oldest 2m)"` once the oldest pending entry is older than
 * the stale threshold. Computing this server-side keeps the wire shape
 * tight.
 */
export const getMessagingStateQuery = defineQuery<{
  received: number;
  sent: number;
  outbox: string;
}>('getMessagingState');

/**
 * Q5.6 — activity counter + last-activity timestamp. Critical-path for
 * W1's tempo computation: the maestro fan-queries this from each
 * session to compute msgs/min buckets. `activityCount` increments at
 * the same ~20 sites that already update `lastActivityTime` (cue,
 * outbox push, schedule fire, report, recruit, restart, destroy,
 * migrate, etc.). Heartbeats and lifecycle plumbing don't bump it.
 *
 * `lastActivityAt` is ISO so the maestro can compute clock-relative
 * deltas without re-parsing.
 */
export const getActivityStateQuery = defineQuery<{
  activityCount: number;
  lastActivityAt: string;
}>('getActivityState');

/**
 * Q5.7 — current attachment lease window. Returns `{ expiresAt,
 * leaseMs }` as numbers (epoch ms / ms) so the dashboard can compute
 * "expires in 54s" without parsing ISO strings every render. Both
 * fields are `null` when no active lease (phase ∈ booting / detached /
 * gone).
 *
 * The underlying `Attachment.expiresAt` is stored as an ISO string for
 * historical reasons; the query handler parses to epoch ms at the
 * boundary.
 */
export const getLeaseStateQuery = defineQuery<{
  expiresAt: number | null;
  leaseMs: number | null;
}>('getLeaseState');

/**
 * 3c Tier-1 coarse activity — the player's current tool + context-token usage,
 * refreshed by the heartbeat piggyback (`heartbeatSignal`). Read by the snapshot
 * fan-out (`getPlayerWireMeta`) → projected onto `PlayerSummaryV1` → the aggregate
 * poll/diff emits `player.activity`. `currentTool` is `null` when idle/between
 * tools; the context fields are absent when Pi can't report usage (e.g. right
 * after compaction). A live read of volatile state — NOT durable metadata.
 */
export const getCoarseActivityQuery = defineQuery<{
  currentTool: string | null;
  contextTokens?: number;
  contextPercent?: number;
}>('getCoarseActivity');

// ── Test-only Signals ──
//
// **Test-only.** Forces the session workflow's main loop to take the
// `continueAsNew` branch on its next iteration, regardless of
// `workflowInfo().continueAsNewSuggested`. Used by the adapter reconnect test
// (#226) to exercise the CAN-boundary rebind path without spamming ~10k
// history events to hit the server's native suggestion threshold.
//
// Production senders do not exist — the signal is a test fixture. Kept on the
// main signal surface (rather than a side channel) so the workflow worker
// bundle needs no special build flag to accept it. The wire name is a plain
// identifier so the wire-protocol drift detector can match it in the docs
// table (the doc regex in `test/wire-protocol.test.ts` only accepts
// identifier-shaped names to avoid picking up prose false positives).
export const testForceContinueAsNewSignal = defineSignal('testForceContinueAsNew');

// ── Quality Gate Signals + Query (conductor-only) ──

export const setQualityGateSignal = defineSignal<[{ task: string; criteria: string[]; createdBy: string }]>('setQualityGate');
export const evaluateGateCriteriaSignal = defineSignal<[{ task: string; evaluations: Array<{ index: number; status: 'passed' | 'failed'; notes?: string }>; evaluatedBy: string }]>('evaluateGateCriteria');
export const qualityGatesQuery = defineQuery<QualityGate[]>('qualityGates');

// ── Worktree Signals + Query (conductor-only) ──

export const setWorktreeSignal = defineSignal<[WorktreeEntry]>('setWorktree');
export const removeWorktreeSignal = defineSignal<[string]>('removeWorktree');
export const worktreesQuery = defineQuery<WorktreeEntry[]>('worktrees');

// ── Stage Signals + Query (conductor-only) ──

export const setStageSignal = defineSignal<[{ name: string; players: string[]; failurePolicy?: 'halt' | 'continue'; createdBy: string }]>('setStage');
export const cancelStageSignal = defineSignal<[string]>('cancelStage');
export const stagesQuery = defineQuery<StageEntry[]>('stages');
