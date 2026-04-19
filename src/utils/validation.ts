/**
 * Shared input validation constants for player names, ensemble names, messages, etc.
 * Used by MCP tool Zod schemas and config validation.
 */

/** Player names: alphanumeric, hyphens, underscores. */
export const PLAYER_NAME_REGEX = /^[a-zA-Z0-9_-]+$/;
export const PLAYER_NAME_MAX = 64;

/**
 * Ensemble names: must start and end with alphanumeric, may contain dots, hyphens, underscores.
 * Minimum 1 char (single alphanumeric), maximum 64 chars.
 */
export const ENSEMBLE_NAME_REGEX = /^[a-zA-Z0-9]([a-zA-Z0-9._-]{0,62}[a-zA-Z0-9])?$/;

/** Stage name max length. */
export const STAGE_NAME_MAX = 64;

/** Maximum players per stage. */
export const STAGE_PLAYERS_MAX = 20;

/** Maximum message size for cue/report (100KB). */
export const MESSAGE_MAX = 102400;

/** Maximum part (status) length. */
export const PART_MAX = 500;

/** Maximum file path length. */
export const PATH_MAX = 1024;

/** Maximum schedule name length. */
export const SCHEDULE_NAME_MAX = 64;

/** Maximum schedule message size (10KB). */
export const SCHEDULE_MESSAGE_MAX = 10240;

/** Maximum cron expression length. */
export const CRON_EXPRESSION_MAX = 128;

/** Maximum quality gate task name length. */
export const GATE_TASK_MAX = 64;

/** Maximum number of criteria per quality gate. */
export const GATE_CRITERIA_MAX = 20;

/** Maximum length for individual criterion text. */
export const GATE_CRITERION_TEXT_MAX = 512;

/** Maximum length for gate criterion notes. */
export const GATE_NOTES_MAX = 1024;

/** Timeout for npm install in worktrees (60s). */
export const WORKTREE_INSTALL_TIMEOUT = 60000;

// `BLOCKED_WINDOW_MS` constant removed in v0.26 (#175 / #178) — the blocked
// session heuristic it gated was replaced by the attachment-phase lifecycle.

/** Maximum length for message preview truncation. */
export const PREVIEW_MAX_LENGTH = 200;

/** Maximum `contextMessages` arg for restart / migrate tools (QA B4). */
export const RESTART_CONTEXT_MESSAGES_MAX = 50;

/** Maximum `deadlineMs` arg for detach tool. */
export const MAX_DETACH_DEADLINE_MS = 120_000;

/**
 * Default graceful-detach deadline used by `deliverRestart`'s Step 2
 * (`requestDetach` before a forced attachment handover). Internal, not
 * user-controllable — well below `MAX_DETACH_DEADLINE_MS`. Extracted from
 * a raw `5_000` literal in PR #136 F5 follow-up (#139).
 */
export const DEFAULT_RESTART_DETACH_DEADLINE_MS = 5_000;

/**
 * Default attachment lease (ms) used by `deliverRestart`'s Step 4
 * (`claimAttachment`). Ninety seconds gives the freshly-spawned adapter
 * enough runway to boot, renew, and begin heartbeating. Extracted from a
 * raw `90_000` literal in PR #136 F5 follow-up (#139).
 */
export const DEFAULT_RESTART_LEASE_MS = 90_000;

/**
 * Whether a session should be included in a broadcast based on its attachment phase.
 *
 * Option-B mapping (see #176 PR description):
 *   - `attached` / `processing` / `awaiting` → include (talkable)
 *   - `booting`                              → exclude (not ready — legacy "pending")
 *   - `draining` / `detached`                → include only if includeDisconnected
 *   - `gone`                                 → exclude (terminal — legacy "terminated")
 *
 * Undefined phase (older workflows pre-attachment-lifecycle, or transient
 * search-attribute propagation) is treated as `booting` — safe default.
 *
 * The `includeDisconnected` parameter is surfaced to callers via the `includeStale`
 * MCP tool argument (kept for wire compat; description updated).
 */
export function shouldIncludeInBroadcast(phase: string | undefined, includeDisconnected: boolean): boolean {
  const p = phase || 'booting';
  if (p === 'gone' || p === 'booting') return false;
  if ((p === 'draining' || p === 'detached') && !includeDisconnected) return false;
  return true;
}

/** Validate a player name string. Returns an error message or null if valid. */
export function validatePlayerName(name: string): string | null {
  if (name.length > PLAYER_NAME_MAX) {
    return `Name too long (${name.length} chars, max ${PLAYER_NAME_MAX}).`;
  }
  if (!PLAYER_NAME_REGEX.test(name)) {
    return `Invalid name "${name}". Names must contain only letters, numbers, hyphens, and underscores.`;
  }
  return null;
}

/** Validate an ensemble name string. Returns an error message or null if valid. */
export function validateEnsembleName(name: string): string | null {
  if (!ENSEMBLE_NAME_REGEX.test(name)) {
    return `Invalid ensemble name "${name}". Must start/end with alphanumeric, may contain letters, numbers, dots, hyphens, underscores (max 64 chars).`;
  }
  return null;
}
