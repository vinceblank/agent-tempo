// Ensemble lineup types — defines the structure of a saved/loaded ensemble configuration.

export interface EnsembleLineup {
  name: string;
  description?: string;
  conductor?: {
    name?: string;        // custom conductor name (defaults to "conductor")
    type?: string;        // agent definition name (e.g., "tempo-conductor")
    agent?: string;       // "default", "copilot", or path to agent .md file
    instructions?: string; // natural language instructions sent as initialMessage
  };
  players: Array<{
    name: string;
    type?: string;        // agent definition name (e.g., "tempo-soloist")
    workDir?: string;     // defaults to cwd if omitted
    agent?: string;       // "default", "copilot", or path to agent .md file
    instructions?: string;
    allowedTools?: string[]; // Tool restrictions (e.g., ["Read", "Glob", "Grep"])
    isolation?: 'worktree'; // Run in a git worktree for code isolation
    branch?: string;        // Branch name for the worktree (defaults to {ensemble}/{player-name})
    /** Transient: resolved agent definition name (set by loadAndResolveLineup). */
    _agentDefinition?: string;
    /** Transient: resolved absolute path to .md file (set by loadAndResolveLineup). */
    _agentDefinitionPath?: string;
  }>;
  schedules?: Array<{
    name: string;
    message: string;
    target: string;       // player name or "all" for fan-out
    at?: string;          // ISO datetime
    delay?: string;       // duration like "10m"
    every?: string;       // recurring interval like "1h"
    cron?: string;        // cron expression like "0 9 * * 1-5"
    timezone?: string;    // IANA timezone for cron (e.g., "America/New_York")
    until?: string;       // ISO datetime
    count?: number;       // max fires
  }>;
}
