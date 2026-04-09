// Shared types used by both workflow code (V8 sandbox) and Node.js server code.
// This file must NOT import from @temporalio/* — it's pure TypeScript types.

export type AgentType = 'claude' | 'copilot';

export type SessionStatus = 'active' | 'stale' | 'pending' | 'terminated' | 'blocked';

export interface SessionMetadata {
  playerId: string;
  ensemble: string;
  hostname: string;
  workDir: string;
  gitRoot?: string;
  gitBranch?: string;
  isConductor: boolean;
  agentType?: AgentType;
  status?: SessionStatus;
  /** Agent definition name (e.g., "tempo-soloist"). */
  playerType?: string;
  /** Short description from the agent definition. */
  playerTypeDescription?: string;
  /** Player ID of who recruited this player. */
  recruitedBy?: string;
  /** Worktree path if this session was spawned in an isolated worktree. */
  worktreePath?: string;
  /** Claude Code session UUID — used for deterministic --resume on encore. */
  claudeSessionId?: string;
}

export interface AgentTypeInfo {
  name: string;
  description?: string;
  source: 'project' | 'user' | 'shipped';
  path: string;
  nativeResolvable: boolean;
  allowedTools?: string[];
}

export interface SessionInput {
  metadata: SessionMetadata;
  /** Restored from continue-as-new */
  part?: string;
  /** Restored from continue-as-new (undelivered only) */
  messages?: Message[];
  /** Restored from continue-as-new */
  sentMessages?: SentMessage[];
  /** Restored from continue-as-new (conductor only) */
  commandHistory?: Command[];
  /** Restored from continue-as-new (conductor only) */
  reportHistory?: PlayerReport[];
  /** Restored from continue-as-new (pending/processing entries only) */
  outbox?: OutboxEntry[];
  autoSummary?: string;
  /** Disable stale session detection (for passive mailbox workflows like maestro) */
  disableStaleDetection?: boolean;
  /** Restored from continue-as-new: last inbound message with responseRequested=true */
  lastInboundRRTime?: number;
  /** Restored from continue-as-new: last outbound activity timestamp */
  lastOutboundTime?: number;
  /** Restored from continue-as-new (conductor only) */
  qualityGates?: QualityGate[];
  /** Restored from continue-as-new (conductor only) */
  worktrees?: WorktreeEntry[];
  /** Restored from continue-as-new (conductor only) */
  stages?: StageEntry[];
  /** Temporal config passed through for outbox activities (non-secret fields only). */
  temporalConfig?: {
    temporalAddress: string;
    temporalNamespace: string;
    taskQueue: string;
  };
}

export interface Message {
  id: string;
  from: string;
  text: string;
  timestamp: string;
  delivered: boolean;
  /** True when sent from the Maestro dashboard by a human. */
  isMaestro?: boolean;
}

export interface SentMessage {
  id: string;
  to: string;
  text: string;
  timestamp: string;
}

export interface Command {
  text: string;
  source: string;
  replyTo?: string;
  timestamp: string;
}

export interface PlayerReport {
  playerId: string;
  text: string;
  type: 'result' | 'blocker' | 'question';
  timestamp: string;
}

export interface HistoryEntry {
  type: 'command' | 'report';
  timestamp: string;
  data: Command | PlayerReport;
}

// ── Outbox Types ──

export type OutboxEntryStatus = 'pending' | 'processing' | 'delivered' | 'failed';

interface OutboxEntryBase {
  id: string;
  createdAt: string;
  status: OutboxEntryStatus;
  error?: string;
  deliveredAt?: string;
}

export interface CueOutboxEntry extends OutboxEntryBase {
  type: 'cue';
  targetPlayerId: string;
  message: string;
}

export interface RecruitOutboxEntry extends OutboxEntryBase {
  type: 'recruit';
  targetName: string;
  workDir: string;
  isConductor: boolean;
  initialMessage?: string;
  agent: AgentType;
  systemPrompt?: string;
  targetHostname?: string;
  /** Agent type name (e.g., "tempo-soloist"). */
  agentDefinition?: string;
  /** Resolved absolute path to .md file (for shipped fallback). */
  agentDefinitionPath?: string;
  /** Short description from the agent definition frontmatter. */
  agentDefinitionDescription?: string;
  /** Whether the agent definition is in a Claude Code-resolvable location. */
  nativeResolvable?: boolean;
  /** Tool restrictions from the agent definition frontmatter. */
  allowedTools?: string[];
  /** Custom claude binary path (from config.claudeBin). */
  claudeBin?: string;
}

export interface ReportOutboxEntry extends OutboxEntryBase {
  type: 'report';
  text: string;
  reportType: 'result' | 'blocker' | 'question' | 'update';
}

export interface StopOutboxEntry extends OutboxEntryBase {
  type: 'stop';
  targetPlayerId: string;
}

export interface EncoreOutboxEntry extends OutboxEntryBase {
  type: 'encore';
  targetPlayerId: string;
  targetHostname?: string;
  contextMessageCount?: number;
  /** Custom claude binary path (from config.claudeBin). */
  claudeBin?: string;
}

export type OutboxEntry = CueOutboxEntry | RecruitOutboxEntry | ReportOutboxEntry | StopOutboxEntry | EncoreOutboxEntry;

/** Distributive Omit that works correctly on union types. */
type DistributiveOmit<T, K extends keyof any> = T extends any ? Omit<T, K> : never;

/** Input type for submitting outbox entries — auto-fields (id, createdAt, status, error, deliveredAt) are added by the workflow. */
export type OutboxEntryInput = DistributiveOmit<OutboxEntry, 'id' | 'createdAt' | 'status' | 'error' | 'deliveredAt'>;

// ── Quality Gate Types ──

export interface QualityGateCriterion {
  text: string;
  status: 'pending' | 'passed' | 'failed';
  evaluatedBy?: string;
  evaluatedAt?: string;
  notes?: string;
}

export interface QualityGate {
  /** Unique key identifying the task this gate covers. */
  task: string;
  criteria: QualityGateCriterion[];
  createdBy: string;
  createdAt: string;
  /** Derived: all passed → passed, any failed → failed, else open. */
  status: 'open' | 'passed' | 'failed';
}

// ── Worktree Types ──

export interface WorktreeEntry {
  /** Player name assigned to this worktree. */
  player: string;
  /** Absolute path to worktree directory. */
  path: string;
  /** Git branch for this worktree. */
  branch: string;
  /** Original git root (for git worktree remove). */
  gitRoot: string;
  /** ISO timestamp of creation. */
  createdAt: string;
  /** Player ID of creator. */
  createdBy: string;
}

// ── Stage Types ──

export interface StagePlayerStatus {
  playerId: string;
  status: 'waiting' | 'reported' | 'blocked';
  reportType?: 'result' | 'blocker' | 'question' | 'update';
  reportText?: string;
  reportedAt?: string;
}

export interface StageEntry {
  /** Unique name identifying this stage. */
  name: string;
  /** Players tracked in this stage. */
  players: StagePlayerStatus[];
  /** Aggregate status: active until all report or a blocker halts. */
  status: 'active' | 'complete' | 'failed' | 'cancelled';
  /** What happens when a player reports a blocker. */
  failurePolicy: 'halt' | 'continue';
  /** ISO timestamp of creation. */
  createdAt: string;
  /** Player ID of the conductor that created the stage. */
  createdBy: string;
  /** ISO timestamp of completion/failure/cancellation. */
  completedAt?: string;
}

export interface ScheduleEntry {
  /** Unique name for this schedule (used as key for add/replace/remove). */
  name: string;
  /** The message text to deliver when the schedule fires. */
  message: string;
  /** Target player name to deliver the cue to. */
  target: string;
  /** Player name of whoever created this schedule. */
  createdBy: string;
  /** ISO timestamp of the next fire time. */
  nextFireAt: string;
  /** Interval in milliseconds for repeating schedules. */
  interval?: number;
  /** ISO timestamp after which the schedule should be removed. */
  until?: string;
  /** Number of remaining fires (decremented each fire, removed at 0). */
  remainingCount?: number;
  /** Total number of times this schedule has fired. */
  firedCount: number;
  /** Schedule type for display purposes. */
  type: 'once' | 'interval' | 'cron';
  /** Cron expression string (e.g., "0 9 * * 1-5"). Stored for re-computing next fire. */
  cronExpression?: string;
  /** IANA timezone for cron evaluation (e.g., "America/New_York"). Defaults to UTC. */
  timezone?: string;
}

// ── Maestro Types ──

/** Snapshot of a player as seen by the Maestro workflow. */
export interface MaestroPlayerInfo {
  playerId: string;
  ensemble: string;
  part: string;
  hostname: string;
  workDir: string;
  gitRoot?: string;
  gitBranch?: string;
  isConductor: boolean;
  agentType: string;
  playerType?: string;
  status?: string;
}

/** A message relayed through the global Maestro for dashboard visibility. */
export interface MaestroRelayMessage {
  id: string;
  ensemble: string;
  from: string;
  to: string;
  text: string;
  timestamp: string;
  direction: 'inbound' | 'outbound';
}

/** Input for the global Maestro workflow. */
export interface GlobalMaestroInput {
  /** Restored from continue-as-new. */
  knownEnsembles?: string[];
  /** Restored from continue-as-new. */
  playersByEnsemble?: Record<string, MaestroPlayerInfo[]>;
  /** Restored from continue-as-new (ring buffer, max 500). */
  recentMessages?: MaestroRelayMessage[];
  /** Restored from continue-as-new (ring buffer, max 500). */
  events?: MaestroEvent[];
  /** Restored from continue-as-new. */
  pendingCommands?: MaestroPendingCommand[];
  /** Refresh interval in milliseconds (default 10000). Lowered in tests. */
  pollIntervalMs?: number;
}

/** An event generated by diffing consecutive Maestro snapshots. */
export interface MaestroEvent {
  type: 'player_joined' | 'player_left' | 'status_changed' | 'part_changed';
  playerId: string;
  timestamp: string;
  oldValue?: string;
  newValue?: string;
}

/** A command queued via the maestroSendCommand update, awaiting relay. */
export interface MaestroPendingCommand {
  id: string;
  text: string;
  source: string;
  replyTo?: string;
  createdAt: string;
  status: 'pending' | 'delivered' | 'failed';
  error?: string;
  /** Ensemble to route to (used by global Maestro only). */
  ensemble?: string;
}

/** A single message in the aggregated ensemble chat feed. */
export interface EnsembleChatMessage {
  id: string;
  from: string;
  to: string;
  /** Truncated to 500 chars max. Full text available via getPlayerMessages. */
  text: string;
  timestamp: string;
  /**
   * Message perspective:
   * - 'maestro-out': maestro (you) sent to a player
   * - 'maestro-in': a player sent to maestro (you)
   * - 'conductor-out': conductor sent to a non-maestro player
   * - 'conductor-in': a non-maestro player sent to conductor
   */
  role: 'maestro-out' | 'maestro-in' | 'conductor-out' | 'conductor-in';
}

/** Input for the maestroEnsembleChat query. */
export interface EnsembleChatQuery {
  /** Messages to skip from the tail (default 0). */
  offset?: number;
  /** Max messages to return (default 50, max 200). */
  limit?: number;
}

/** Result from the maestroEnsembleChat query. */
export interface EnsembleChatResult {
  messages: EnsembleChatMessage[];
  /** Total message count in cache. */
  total: number;
  /** True if messages exist beyond offset+limit. */
  hasMore: boolean;
  /** Whether a conductor was found during last refresh. */
  hasConductor: boolean;
}

/** High-water marks for incremental chat fetch. */
export interface ChatHighWater {
  maestroRecv: number;
  maestroSent: number;
  conductorRecv: number;
  conductorSent: number;
}

/** Zero-value for ChatHighWater — use as default when no prior fetch. */
export const ZERO_CHAT_HIGH_WATER: ChatHighWater = {
  maestroRecv: 0, maestroSent: 0, conductorRecv: 0, conductorSent: 0,
};

/** Input for the Maestro workflow. */
export interface MaestroInput {
  ensemble: string;
  /** Restored from continue-as-new. */
  players?: MaestroPlayerInfo[];
  /** Restored from continue-as-new (ring buffer, max 200). */
  events?: MaestroEvent[];
  /** Restored from continue-as-new. */
  pendingCommands?: MaestroPendingCommand[];
  /** Refresh interval in milliseconds (default 10000). Lowered in tests. */
  pollIntervalMs?: number;
  /** Restored from continue-as-new (ring buffer, max 500). */
  cachedChat?: EnsembleChatMessage[];
  /** Metadata about last chat refresh. */
  cachedChatMeta?: { hasConductor: boolean };
  /** High-water marks for incremental chat fetch. */
  chatHighWater?: ChatHighWater;
}
