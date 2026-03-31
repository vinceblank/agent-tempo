// Re-export types from the parent project.
// These are inlined to avoid Turbopack ESM/CJS module format conflicts
// when resolving files under the parent package.json ("type": "commonjs").

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
  part?: string;
  messages?: Message[];
  sentMessages?: SentMessage[];
  commandHistory?: Command[];
  reportHistory?: PlayerReport[];
  autoSummary?: string;
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
