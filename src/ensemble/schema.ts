// Ensemble lineup types — defines the structure of a saved/loaded ensemble configuration.

import type { MockMode } from '../types';

export interface EnsembleLineup {
  name: string;
  description?: string;
  /**
   * Every ensemble defines exactly one conductor — the default chat target,
   * the home for system messages, and the anchor for `getEnsembleChat`.
   * Inner fields remain optional: unset `name` defaults to `"conductor"` and
   * unset `agent` falls back to `CLAUDE_TEMPO_DEFAULT_AGENT`.
   */
  conductor: {
    name?: string;        // custom conductor name (defaults to "conductor")
    type?: string;        // agent definition name (e.g., "tempo-conductor")
    /** "default", "copilot", "mock" (dev mode only), or path to agent .md file. */
    agent?: string;
    instructions?: string; // natural language instructions sent as initialMessage
    /**
     * Mock-adapter mode — only consulted when `agent: "mock"`. Mirrors the
     * same field on players. Defaults to `echo` when omitted.
     */
    mockMode?: MockMode;
    /**
     * Scenario reference for `agent: "mock"` + `mockMode: "scripted"`.
     * Bare name (resolved against shipped `scenarios/`), absolute path,
     * or relative path.
     */
    mockScenario?: string;
  };
  players: Array<{
    name: string;
    type?: string;        // agent definition name (e.g., "tempo-soloist")
    workDir?: string;     // defaults to cwd if omitted
    /**
     * "default", "copilot", path to agent .md file, or "mock" (dev-mode
     * only — ADR 0014 §4 / PR-2). Mock players are headless subprocesses
     * with no terminal window, suitable for autonomous validation
     * harnesses (e.g. the `tempo-mock-jam` lineup).
     */
    agent?: string;
    instructions?: string;
    allowedTools?: string[]; // Tool restrictions (e.g., ["Read", "Glob", "Grep"])
    /**
     * Mock-adapter mode (only consulted when `agent: "mock"`). One of
     * `echo` / `scripted` / `silent` / `chaos`. ADR 0014 §4.2. Defaults
     * to `echo` when omitted. PR-3 added `silent` + `chaos`.
     */
    mockMode?: MockMode;
    /**
     * Scenario reference for `agent: "mock"` + `mockMode: "scripted"` —
     * bare name (resolved against shipped `scenarios/`), absolute path,
     * or relative path. CLI `--scenario` flag overrides this when set.
     */
    mockScenario?: string;
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
