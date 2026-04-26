/**
 * TempoClient — public interface and related types.
 *
 * Extracted from `src/tui/client.ts` so that non-TUI consumers (CLI, tests,
 * external integrations) can depend on the interface without pulling in Ink/React.
 */
import type {
  AgentType,
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

// ── #306: Recruit (direct TempoClient path) ──

/**
 * Options for {@link TempoClient.recruit} — direct submit of a `recruit`
 * outbox entry from the caller's maestro session. Mirrors the `recruit`
 * MCP tool's parameters, minus the conductor-only bits handled by the
 * `load_lineup` flow. The TUI uses this to bypass the conductor LLM hop
 * for UI-initiated recruiting (the prior path routed through the
 * maestro hub → conductor → MCP tool, which required a live conductor).
 */
export interface RecruitClientOpts {
  name: string;
  workDir: string;
  agent?: AgentType;
  /** Agent type name from the subagent registry (e.g. "tempo-soloist"). */
  playerType?: string;
  isConductor?: boolean;
  initialMessage?: string;
  systemPrompt?: string;
  host?: string;
  /** When true, spawn process but lock outbox until `release`. */
  held?: boolean;
}

export interface RecruitClientResult {
  playerId: string;
  /** Outbox entry id submitted on the maestro session's workflow. */
  entryId: string;
}

// ── #306: Release (direct TempoClient path) ──

export interface ReleaseClientResult {
  /** Names of players released, in scan order. */
  released: string[];
  /** Soft-failure diagnostics per player, if any. */
  errors: Array<{ playerId: string; error: string }>;
}

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
   * Lifecycle classification populated by {@link TempoClient.listEnsembles}
   * (absent on `discoverEnsembles` results):
   *
   * - `'online'`  — maestro hub is unpaused (`maestroPaused === false`).
   * - `'paused'`  — maestro hub is paused **and** at least one session is
   *                 still in a live attachment phase. Operationally this is
   *                 a `/pause` (resume in place via `/play`).
   * - `'offline'` — maestro hub is paused **and** no live adapters remain.
   *                 Operationally this is a `/shutdown` (requires `/restore`).
   */
  state?: 'online' | 'paused' | 'offline';
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
  /**
   * Spawn a conductor terminal for an existing ensemble — the restore-
   * after-shutdown path. Shells out to `claude-tempo up <name>` which is
   * idempotent at the workflow layer. Semantically distinct from
   * {@link TempoClient.createEnsemble}: this fires on an ensemble that
   * already exists; a "create" contradiction would mislead future readers.
   */
  spawnConductor(opts: { ensemble: string; workDir?: string }): Promise<void>;
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
  /**
   * #306: Recruit a player directly via the caller's maestro session outbox.
   * Replaces the legacy TUI path of routing `/recruit …` through the
   * conductor's Claude Code session. Structural-op parity with the `recruit`
   * MCP tool — enqueues a `recruit` outbox entry; the dispatch loop spawns
   * the process. The conductor's LLM is never in the critical path.
   */
  recruit(ensemble: string, opts: RecruitClientOpts): Promise<RecruitClientResult>;
  /**
   * #306: Release held players directly via the caller's maestro session
   * outbox. Without `playerId`, scans the ensemble for sessions whose
   * outbox is locked and enqueues a `release` entry for each. With
   * `playerId`, releases just that session. Structural-op parity with
   * the `release` MCP tool.
   */
  release(ensemble: string, playerId?: string): Promise<ReleaseClientResult>;
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
  /**
   * Bug B: Read the maestro hub's `maestroPaused` flag for an ensemble.
   * Returns `false` when the hub workflow doesn't exist (treat absence as
   * "not paused" — the StatusBar renders nothing for the bare-ensemble case).
   * The TUI polls this so a paused conductor swallowing messages becomes
   * visible (status bar segment + tooltip-style hint to type `/play`).
   */
  isMaestroPaused(ensemble: string): Promise<boolean>;
  /**
   * #306 follow-up: True when at least one session in the ensemble has its
   * outbox locked (i.e. is `held`). Companion to {@link isMaestroPaused};
   * the two are orthogonal — `/load_lineup` flips both, `/pause` flips just
   * paused, `/recruit --held` flips just held. The TUI polls this to surface
   * a yellow `held` segment + a `Tip: /go` hint, so users don't sit paused
   * watching held players that need releasing.
   *
   * Skips the maestro session (the TUI's own dashboard attachment) so a
   * locked maestro outbox — never a real held-player state — doesn't
   * trigger the indicator. Returns `false` when the scan or every per-
   * session query fails (treat absence as "not held").
   */
  isAnySessionHeld(ensemble: string): Promise<boolean>;
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
