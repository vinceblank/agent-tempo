// Shared types used by both workflow code (V8 sandbox) and Node.js server code.
// This file must NOT import from @temporalio/* — it's pure TypeScript types.

export interface SessionMetadata {
  playerId: string;
  ensemble: string;
  hostname: string;
  workDir: string;
  gitRoot?: string;
  gitBranch?: string;
  isConductor: boolean;
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
