/**
 * TempoClient — public interface and related types.
 *
 * Extracted from `src/tui/client.ts` so that non-TUI consumers (CLI, tests,
 * external integrations) can depend on the interface without pulling in Ink/React.
 */
import type {
  MaestroPlayerInfo,
  MaestroRelayMessage,
  HistoryEntry,
  Message,
  SentMessage,
  SessionMetadata,
  ScheduleEntry,
  QualityGate,
  StageEntry,
  WorktreeEntry,
  EnsembleChatResult,
} from '../types';

// ── Public Types ──

export interface EnsembleSummary {
  name: string;
  playerCount: number;
  hasConductor: boolean;
  conductorStatus?: string;
}

export interface TempoClient {
  /** Discover all running ensembles across the cluster. */
  discoverEnsembles(): Promise<EnsembleSummary[]>;
  /** Get current player snapshot for an ensemble. */
  getPlayers(ensemble: string): Promise<MaestroPlayerInfo[]>;
  /** Get recent messages for an ensemble. */
  getMessages(ensemble: string, limit?: number): Promise<MaestroRelayMessage[]>;
  /** Get conductor command/report history for an ensemble. */
  getConductorHistory(ensemble: string): Promise<HistoryEntry[]>;
  /** Get a player's message history (received + sent). */
  getPlayerMessages(ensemble: string, playerId: string): Promise<Array<Message | (SentMessage & { direction: 'sent' })>>;
  /** Get a player's workflow metadata. */
  getPlayerMetadata(ensemble: string, playerId: string): Promise<SessionMetadata | null>;
  /** Send a command to an ensemble's conductor via Maestro. Returns command ID. */
  sendCommand(ensemble: string, text: string, source: string): Promise<string>;
  /** Send a message to a specific player in an ensemble. Returns message ID. */
  sendMessage(ensemble: string, to: string, text: string, source: string): Promise<string>;
  /** Terminate a player's workflow. */
  terminatePlayer(ensemble: string, playerId: string): Promise<void>;
  /** Get active schedules for an ensemble. */
  getSchedules(ensemble: string): Promise<ScheduleEntry[]>;
  /** Cancel a named schedule in an ensemble. */
  cancelSchedule(ensemble: string, name: string): Promise<void>;
  /** Get quality gates from the conductor workflow. */
  getGates(ensemble: string): Promise<QualityGate[]>;
  /** Get stages from the conductor workflow. */
  getStages(ensemble: string): Promise<StageEntry[]>;
  /** Get worktrees from the conductor workflow. */
  getWorktrees(ensemble: string): Promise<WorktreeEntry[]>;
  /** Get aggregated ensemble chat (maestro + conductor traffic). */
  getEnsembleChat(ensemble: string, offset?: number, limit?: number): Promise<EnsembleChatResult>;
  /** Encore (revive) a stale player directly via the maestro session's outbox. */
  encorePlayer(ensemble: string, playerId: string): Promise<void>;
  /** Disband an ensemble: terminate all sessions, scheduler, and maestro workflows. */
  disbandEnsemble(ensemble: string): Promise<{ terminated: number }>;
  /** Check if the Temporal connection is alive. */
  isConnected(): Promise<boolean>;
  /** Check if the Global Maestro workflow is running. */
  hasGlobalMaestro(): Promise<boolean>;

  // ── Maestro session (TUI-owned workflow for two-way messaging) ──

  /** Ensure a maestro session workflow exists for the ensemble (create or reuse). */
  ensureMaestroSession(ensemble: string): Promise<string>;
  /** Send a message as the maestro to a target player. */
  sendAsMaestro(ensemble: string, targetPlayer: string, text: string): Promise<void>;
  /** Get messages received + sent by the maestro session. */
  getMaestroMessages(ensemble: string): Promise<{ received: Message[]; sent: SentMessage[] }>;
}
