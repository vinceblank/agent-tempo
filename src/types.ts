// Shared types used by both workflow code (V8 sandbox) and Node.js server code.
// This file must NOT import from @temporalio/* — it's pure TypeScript types.

export type AgentType = 'claude' | 'copilot';

export interface SessionMetadata {
  playerId: string;
  ensemble: string;
  hostname: string;
  workDir: string;
  gitRoot?: string;
  gitBranch?: string;
  isConductor: boolean;
  agentType?: AgentType;
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
  autoSummary?: string;
  /** Disable stale session detection (for passive mailbox workflows like maestro) */
  disableStaleDetection?: boolean;
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
  type: 'once' | 'interval';
}
