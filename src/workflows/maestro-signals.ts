import { defineSignal, defineQuery, defineUpdate } from '@temporalio/workflow';
import type {
  MaestroPlayerInfo,
  MaestroEvent,
  MaestroPendingCommand,
} from '../types';

// Re-export types for convenience within workflow code
export type {
  MaestroPlayerInfo,
  MaestroEvent,
  MaestroPendingCommand,
  MaestroInput,
} from '../types';

// ── Maestro Signals ──

/** Gracefully shut down the Maestro workflow. */
export const maestroShutdownSignal = defineSignal('maestroShutdown');

// ── Maestro Queries ──

/** Get the current snapshot of all players in the ensemble. */
export const maestroPlayersQuery = defineQuery<MaestroPlayerInfo[]>('maestroPlayers');

/** Get the event log (ring buffer, max 200 entries). */
export const maestroEventsQuery = defineQuery<MaestroEvent[]>('maestroEvents');

/** Get pending commands (queued but not yet relayed to conductor). */
export const maestroPendingCommandsQuery = defineQuery<MaestroPendingCommand[]>('maestroPendingCommands');

// ── Maestro Updates ──

/** Queue a command to be relayed to the conductor. Returns the command ID. */
export const maestroSendCommandUpdate = defineUpdate<string, [{ text: string; source: string; replyTo?: string }]>('maestroSendCommand');
