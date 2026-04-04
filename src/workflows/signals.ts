import { defineSignal, defineQuery, defineUpdate } from '@temporalio/workflow';
import type {
  SessionMetadata,
  Message,
  SentMessage,
  HistoryEntry,
  OutboxEntry,
  OutboxEntryInput,
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
} from '../types';

// ── Player Signals ──

export const receiveMessageSignal = defineSignal<[{ from: string; text: string; isMaestro?: boolean }]>('receiveMessage');
export const recordSentMessageSignal = defineSignal<[{ to: string; text: string }]>('recordSentMessage');
export const setPartSignal = defineSignal<[string]>('setPart');
export const markDeliveredSignal = defineSignal<[string[]]>('markDelivered');
export const setNameSignal = defineSignal<[string]>('setName');
export const updateMetadataSignal = defineSignal<[{ hostname?: string; gitBranch?: string; gitRoot?: string; status?: string; terminatedBy?: string; enableStaleDetection?: boolean }]>('updateMetadata');

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

// ── Outbox Update + Query ──

export const submitOutboxUpdate = defineUpdate<string, [OutboxEntryInput]>('submitOutbox');
export const outboxQuery = defineQuery<OutboxEntry[]>('outbox');
