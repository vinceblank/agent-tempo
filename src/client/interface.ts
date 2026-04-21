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
  HostInfo,
} from '../types';
import type { RestoreOrphansSummary } from '../reconcile/orphans';

// ── Recall (#128) ──

/**
 * Raw (unfiltered, unsorted, unsliced) output of `TempoClient.recall`.
 * The shared formatter at `src/utils/recall-format.ts` turns this into a
 * timeline + pagination header; returning the raw shape keeps every
 * surface's presentation logic testable without booting a client.
 */
export interface RecallClientResult {
  received: Message[];
  sent: SentMessage[];
}

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
  /** Player the restart was queued for. */
  playerId: string;
  /** Target host — `undefined` when the caller didn't specify and the activity uses `preferredHost`. */
  host?: string;
  /** Outbox entry id; callers can poll `submitOutbox` history or `outboxQuery` for status. */
  entryId: string;
}

// ── #287: ensemble-scope verb summaries ──

/** Per-target outcome returned by `shutdown`. */
export interface EnsembleShutdownDetail {
  playerId: string;
  outcome: 'detaching' | 'skipped-self' | 'failed';
  error?: string;
}

export interface EnsembleShutdownSummary {
  detached: number;
  skipped: number;
  failed: number;
  maestroPaused: boolean;
  schedulerPaused: boolean;
  details: EnsembleShutdownDetail[];
}

/** Per-target outcome returned by ensemble-scope `destroy`. */
export interface EnsembleDestroyDetail {
  target: string;
  outcome: 'destroyed' | 'terminated' | 'skipped-self' | 'failed';
  error?: string;
}

export interface EnsembleDestroySummary {
  destroyed: number;
  terminated: number;
  failed: number;
  details: EnsembleDestroyDetail[];
}

// ── Public Types ──

export interface EnsembleSummary {
  name: string;
  playerCount: number;
  hasConductor: boolean;
  conductorStatus?: string;
  /**
   * `'running'` when any session is in a live phase,
   * `'parked'` when every session is `detached`. Populated by
   * {@link TempoClient.listEnsembles}; absent on `discoverEnsembles` results.
   */
  state?: 'running' | 'parked';
}

/** Options for {@link TempoClient.createEnsemble}. */
export interface CreateEnsembleOpts {
  /** New ensemble name. Must pass `validateEnsembleName`. */
  ensemble: string;
  /** Working directory for the spawned conductor terminal. Defaults to `process.cwd()`. */
  workDir?: string;
  /** Optional lineup name or path forwarded to `claude-tempo up --lineup …`. */
  lineup?: string;
}

export interface TempoClient {
  /** Discover all running ensembles across the cluster. */
  discoverEnsembles(): Promise<EnsembleSummary[]>;
  /**
   * List every ensemble with at least one live workflow, splitting running
   * from parked (all-sessions-detached) via `state`.
   */
  listEnsembles(): Promise<EnsembleSummary[]>;
  /**
   * Create a new ensemble + conductor session. Shells out to `claude-tempo
   * up <name>` so the spawned conductor terminal matches the CLI path.
   */
  createEnsemble(opts: CreateEnsembleOpts): Promise<void>;
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
  /**
   * #287: Terminally destroy a workflow. Single-player when `playerId` is
   * given; ensemble-scope (peer sessions → scheduler → maestro → conductor)
   * when `playerId` is omitted. Ensemble-scope returns a count summary.
   */
  destroy(ensemble: string, playerId?: string, reason?: string): Promise<void | EnsembleDestroySummary>;
  /**
   * #287: Pause every session in the ensemble + scheduler + maestro. MCP
   * counterpart of the `pause` tool. Replaces the v0.26 `pauseEnsemble` shape.
   */
  pause(ensemble: string): Promise<void>;
  /**
   * #287: Unpause every session + scheduler + maestro. `release: true` also
   * fans out `releaseHeld` so any held sessions deliver their buffered task
   * messages. MCP counterpart of the `play` tool.
   */
  play(ensemble: string, opts?: { release?: boolean }): Promise<void>;
  /**
   * #287: Graceful ensemble teardown — fan-out detach + pause scheduler +
   * pause maestro. Workflows survive in `detached`; pair with `restore`.
   */
  shutdown(ensemble: string, opts?: { deadlineMs?: number; reason?: string }): Promise<EnsembleShutdownSummary>;
  /**
   * #287: Bring the ensemble back up after `shutdown`. Reattaches all local
   * orphans (delegates to the shared `restoreOrphansOnce` helper) and
   * unpauses the scheduler + maestro. Does NOT spawn a conductor terminal
   * — CLI owns that (design #285 S4).
   */
  restore(ensemble: string): Promise<RestoreOrphansSummary>;
  /** PR-D: Migrate a player to a different host — sugar for restart({host}). */
  migrate(ensemble: string, playerId: string, host: string, opts?: Omit<RestartClientOpts, 'host'>): Promise<RestartClientResult>;
  /** PR-D: Query a player's V2 attachment lifecycle state. */
  attachmentInfo(ensemble: string, playerId: string): Promise<AttachmentInfo>;
  /**
   * #128: Fetch a player's raw message timeline (received + sent). Throws
   * when the session cannot be resolved. Callers are expected to feed the
   * result through the shared `formatRecall` helper for filter / sort /
   * slice / render; the client stays presentation-free.
   */
  recall(ensemble: string, playerId: string): Promise<RecallClientResult>;
  /**
   * #274: List all daemons polling this Temporal namespace, joined with
   * their boot-signaled capability profiles. Consumers typically feed
   * the result through `formatHostList` for a consistent UX across
   * CLI / TUI / MCP. `force: true` bypasses the 3-second result cache.
   */
  listHosts(opts?: { force?: boolean }): Promise<HostInfo[]>;
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
