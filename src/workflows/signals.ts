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
  EncoreOutboxEntry,
  QualityGate,
  QualityGateCriterion,
  WorktreeEntry,
  StageEntry,
  StagePlayerStatus,
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

// ── Conductor Signals ──

export const commandSignal = defineSignal<[{ text: string; source: string; replyTo?: string }]>('command');
export const playerReportSignal = defineSignal<[{ playerId: string; text: string; type: 'result' | 'blocker' | 'question' }]>('playerReport');

// ── Conductor Queries ──

export const historyQuery = defineQuery<HistoryEntry[]>('history');

// ── Atomic Status Transition ──

/** Atomically transition status from expectedStatus to newStatus. Returns true on success, false if current status didn't match. */
export const checkAndSetStatusUpdate = defineUpdate<boolean, [{ expectedStatus: string; newStatus: string }]>('checkAndSetStatus');

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
