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
  AttachmentInfo,
} from '../types';

// ── PR-D verb options ──

export interface RestartClientOpts {
  /** Target host (defaults to session's preferredHost or last-known hostname). */
  host?: string;
  /** Skip context replay. */
  fresh?: boolean;
  /** Steal a live attachment via forceDetach. */
  force?: boolean;
  /** Number of recent messages to include in context replay. */
  contextMessages?: number;
  /** Identifier of the invoker for audit messages (default: 'cli'). */
  invokerPlayerId?: string;
}

export interface RestartClientResult {
  playerId: string;
  host: string;
  attachmentId: string;
  spawnEntryId: string;
  phaseBefore: string;
  contextReplayed: boolean;
}

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
  /** PR-D: Restart a player — §8.2 algorithm. Works on any non-`gone` phase. */
  restart(ensemble: string, playerId: string, opts?: RestartClientOpts): Promise<RestartClientResult>;
  /** PR-D: Gracefully detach a player's adapter. Workflow survives in `detached`. */
  detach(ensemble: string, playerId: string, deadlineMs?: number): Promise<void>;
  /** PR-D: Terminally destroy a player's workflow. */
  destroy(ensemble: string, playerId: string, reason?: string): Promise<void>;
  /** PR-D: Migrate a player to a different host — sugar for restart({host}). */
  migrate(ensemble: string, playerId: string, host: string, opts?: Omit<RestartClientOpts, 'host'>): Promise<RestartClientResult>;
  /** PR-D: Query a player's V2 attachment lifecycle state. */
  attachmentInfo(ensemble: string, playerId: string): Promise<AttachmentInfo>;
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
