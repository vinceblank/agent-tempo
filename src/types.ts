// Shared types used by both workflow code (V8 sandbox) and Node.js server code.
// This file must NOT import from @temporalio/* — it's pure TypeScript types.

export type AgentType = 'claude' | 'copilot';

export type SessionStatus = 'active' | 'stale' | 'pending' | 'terminated';

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
  /** Restored from continue-as-new (conductor only) */
  qualityGates?: QualityGate[];
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
}

export interface ReportOutboxEntry extends OutboxEntryBase {
  type: 'report';
  text: string;
  reportType: 'result' | 'blocker' | 'question';
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
