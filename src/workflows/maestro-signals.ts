import { defineSignal, defineQuery, defineUpdate } from '@temporalio/workflow';
import type {
  MaestroPlayerInfo,
  MaestroEvent,
  MaestroPendingCommand,
  MaestroRelayMessage,
  Message,
  SentMessage,
} from '../types';

// Re-export types for convenience within workflow code
export type {
  MaestroPlayerInfo,
  MaestroEvent,
  MaestroPendingCommand,
  MaestroInput,
  MaestroRelayMessage,
  GlobalMaestroInput,
} from '../types';

// ── Per-Ensemble Maestro Signals (existing) ──

/** Gracefully shut down the Maestro workflow. */
export const maestroShutdownSignal = defineSignal('maestroShutdown');

// ── Per-Ensemble Maestro Queries (existing) ──

/** Get the current snapshot of all players in the ensemble. */
export const maestroPlayersQuery = defineQuery<MaestroPlayerInfo[]>('maestroPlayers');

/** Get the event log (ring buffer, max 200 entries). */
export const maestroEventsQuery = defineQuery<MaestroEvent[]>('maestroEvents');

/** Get pending commands (queued but not yet relayed to conductor). */
export const maestroPendingCommandsQuery = defineQuery<MaestroPendingCommand[]>('maestroPendingCommands');

// ── Per-Ensemble Maestro Updates (existing) ──

/** Queue a command to be relayed to the conductor. Returns the command ID. */
export const maestroSendCommandUpdate = defineUpdate<string, [{ text: string; source: string; replyTo?: string }]>('maestroSendCommand');

// ══════════════════════════════════════════════════════════════════════════════
// Global Maestro — single instance handling ALL ensembles
// ══════════════════════════════════════════════════════════════════════════════

// ── Global Maestro Signals ──

/** Notify the global Maestro of a relayed message (for Phase 2 push-based updates). */
export const maestroNotifyMessageSignal = defineSignal<[MaestroRelayMessage]>('maestroNotifyMessage');

// ── Global Maestro Queries ──

/** Get the list of known ensembles. */
export const maestroEnsemblesQuery = defineQuery<string[]>('maestroEnsembles');

/** Get players grouped by ensemble. */
export const maestroPlayersByEnsembleQuery = defineQuery<Record<string, MaestroPlayerInfo[]>>('maestroPlayersByEnsemble');

/** Get recent messages across all ensembles (ring buffer, max 500). */
export const maestroRecentMessagesQuery = defineQuery<MaestroRelayMessage[]>('maestroRecentMessages');

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
