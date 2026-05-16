// Ensemble lineup types — defines the structure of a saved/loaded ensemble configuration.

import type { MockMode } from '../types';

/**
 * Spawn mode for an interactive `claude-code` player.
 *
 * - `'terminal'` (default) — open a per-recruit terminal window via
 *   `spawnInTerminal`. Adapter owns the pty; restart-with-replay works.
 * - `'bg'` (experimental, ADR 0016) — hand the session to Anthropic's
 *   per-user Claude Code supervisor via `claude --bg`. No terminal window;
 *   session is visible in `claude agents` and `~/.claude/daemon/roster.json`.
 *   Requires `experimental.spawn: true` at the lineup root. Silently
 *   ignored for non-claude-code adapters (the lineup loader emits a warning).
 *
 * See `docs/ops/bg-spawn.md` for the upstream `--bg --resume` limitation
 * (restart with `transcript: 'replay'` is unavailable under `'bg'`).
 */
export type SpawnMode = 'terminal' | 'bg';

/**
 * Top-level experimental opt-in block — generic, reusable.
 *
 * Each boolean gates one experimental knob. Today only `spawn` (ADR 0016)
 * is wired; future opt-ins (`experimental: { foo: true }`) reuse the
 * shape so users have a single, obvious place to look for "what am I
 * opting into."
 */
export interface ExperimentalBlock {
  /**
   * When `true`, the lineup loader accepts `spawn: 'bg'` at the
   * top level and per-player. Absence (or `false`) makes any `spawn: 'bg'`
   * value a hard validation error.
   */
  spawn?: boolean;
}

export interface EnsembleLineup {
  name: string;
  description?: string;
  /**
   * Top-level experimental opt-ins. See {@link ExperimentalBlock}.
   */
  experimental?: ExperimentalBlock;
  /**
   * Lineup-wide default spawn mode for interactive `claude-code` players.
   * Per-player `spawn` overrides this. Defaults to `'terminal'` when
   * omitted. `'bg'` requires `experimental.spawn: true`.
   */
  spawn?: SpawnMode;
  /**
   * Every ensemble defines exactly one conductor — the default chat target,
   * the home for system messages, and the anchor for `getEnsembleChat`.
   * Inner fields remain optional: unset `name` defaults to `"conductor"` and
   * unset `agent` falls back to `AGENT_TEMPO_DEFAULT_AGENT`.
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
    /**
     * Per-player spawn mode override for interactive `claude-code` players.
     * Precedence: per-player `spawn` > lineup `spawn` > built-in default
     * `'terminal'`. `'bg'` requires `experimental.spawn: true` at the
     * lineup root. Silently ignored for non-claude-code adapters.
     */
    spawn?: SpawnMode;
    /** Transient: resolved agent definition name (set by loadAndResolveLineup). */
    _agentDefinition?: string;
    /** Transient: resolved absolute path to .md file (set by loadAndResolveLineup). */
    _agentDefinitionPath?: string;
    /**
     * Transient: resolved spawn mode after precedence + experimental gate
     * (set by `loadLineup`). Always populated; the dispatcher reads this
     * and skips its own precedence logic.
     */
    _spawn?: SpawnMode;
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
