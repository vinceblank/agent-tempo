import { defineSignal, defineQuery, defineUpdate } from '@temporalio/workflow';
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
  AttachmentPhase,
  AdapterClass,
  DetachReason,
  OrphanSummary,
} from '../types';

// Re-export types for convenience within workflow code
export type {
  SessionMetadata,
  SessionInput,
  SessionStatus,
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
} from '../types';

// ── Player Signals ──

export const receiveMessageSignal = defineSignal<[{ from: string; text: string; isMaestro?: boolean; responseRequested?: boolean }]>('receiveMessage');
export const recordSentMessageSignal = defineSignal<[{ to: string; text: string }]>('recordSentMessage');
export const setPartSignal = defineSignal<[string]>('setPart');
export const markDeliveredSignal = defineSignal<[string[]]>('markDelivered');
export const setNameSignal = defineSignal<[string]>('setName');
export const updateMetadataSignal = defineSignal<[{ hostname?: string; gitBranch?: string; gitRoot?: string; status?: string; terminatedBy?: string; enableStaleDetection?: boolean; playerType?: string; playerTypeDescription?: string; worktreePath?: string; sessionId?: string }]>('updateMetadata');

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

// ── Pending Startup Context (issue #172) ──
//
// Set via update on a fresh conductor workflow when `load_lineup` is called
// through an initial-startup path (`up --lineup` / `conduct --lineup`). The
// workflow defers the lineup's `conductor.instructions` until the user sends
// their first real message, then prepends the stored context + a "release
// players" directive to that first message so the conductor always acts on
// the user's actual intent rather than the lineup's default behavior.
//
// Conductor-invoked `load_lineup` mid-work is unchanged — it still signals
// instructions immediately.

/**
 * Store pending startup context on the conductor's workflow state. Consumed by
 * the first inbound user message and then cleared. Conductor-only; signalled
 * by the `load_lineup` tool when `initialStartup=true`. Returns the stored
 * context for ack / observability in tests.
 */
export const setPendingStartupContextUpdate = defineUpdate<
  { stored: boolean },
  [{ context: string; playersCount: number }]
>('setPendingStartupContext');

/** Query the currently-stored pending startup context (or null when cleared). */
export const pendingStartupContextQuery = defineQuery<{
  context: string;
  playersCount: number;
} | null>('pendingStartupContext');

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
  }]
>('enqueueSpawn');

/** Record a preferred host for daemon reconcile-on-boot targeting. */
export const setPreferredHostUpdate = defineUpdate<void, [{ host: string }]>('setPreferredHost');

// ── v0.25 Attachment Signals ──

/**
 * Liveness heartbeat from the adapter. Resets `lastHeartbeatAt` and extends `expiresAt` to
 * `workflow.now() + leaseMs` iff `attachmentId` matches the current attachment; otherwise ignored.
 */
export const heartbeatSignal = defineSignal<[{ attachmentId: string; at: string }]>('heartbeat');

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

// ── Outbox Update + Query ──

export const submitOutboxUpdate = defineUpdate<string, [OutboxEntryInput]>('submitOutbox');
export const outboxQuery = defineQuery<OutboxEntry[]>('outbox');

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
