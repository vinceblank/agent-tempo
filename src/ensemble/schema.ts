// Ensemble blueprint types — defines the structure of a saved/loaded ensemble configuration.

export interface EnsembleBlueprint {
  name: string;
  description?: string;
  conductor?: {
    agent?: string;       // "default", "copilot", or path to agent .md file
    instructions?: string; // natural language instructions sent as initialMessage
  };
  players: Array<{
    name: string;
    type?: string;        // agent definition name (e.g., "architect")
    workDir?: string;     // defaults to cwd if omitted
    agent?: string;       // "default", "copilot", or path to agent .md file
    instructions?: string;
    /** Transient: resolved agent definition name (set by loadAndResolveBlueprint). */
    _agentDefinition?: string;
    /** Transient: resolved absolute path to .md file (set by loadAndResolveBlueprint). */
    _agentDefinitionPath?: string;
  }>;
  schedules?: Array<{
    name: string;
    message: string;
    target: string;       // player name or "all" for fan-out
    at?: string;          // ISO datetime
    delay?: string;       // duration like "10m"
    every?: string;       // recurring interval like "1h"
    until?: string;       // ISO datetime
    count?: number;       // max fires
  }>;
}
