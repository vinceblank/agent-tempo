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

// ── Player saveable state (#334 PR-1) ──────────────────────────────────────
//
// Per-session, player-curated state slots. Sized per design §3.3:
//   per-key 32 KiB × max 4 slots → 128 KiB structural max per session.
// At a 1.2 MiB p99 session footprint, that lands at ~33 % of Temporal's
// 4 MiB CAN-payload ceiling — comfortable. Saturation refuses with a
// `PlayerStateSlotsFull` ApplicationFailure rather than evicting LRU
// (Anthropic harness-design blog: explicit eviction reinforces authorial
// discipline). See docs/adr/0011-player-saveable-state.md.

/** Default slot key when callers omit `key`. */
export const PLAYER_STATE_DEFAULT_KEY = 'main';

/** Slot keys: alphanumeric + underscore + hyphen. Mirrors PLAYER_NAME_REGEX shape. */
export const PLAYER_STATE_KEY_REGEX = /^[a-zA-Z0-9_-]+$/;

/** Maximum slot key length. */
export const PLAYER_STATE_KEY_MAX = 32;

/** Maximum content size per slot — 32 KiB. Mirrors coat-check's per-entry cap. */
export const PLAYER_STATE_CONTENT_MAX = 32 * 1024;

/** Maximum number of populated slots per player. Saturation rejects with `PlayerStateSlotsFull`. */
export const PLAYER_STATE_SLOTS_MAX = 4;

// ── Coat-check (#318, ADR 0008) ────────────────────────────────────────────
//
// Ensemble-shared, ticket-keyed stash for content too large to inline in a
// `cue` message body. Lives on per-ensemble Maestro workflow state.
//
// Sizing per the #318 architect verdict (which adjusts ADR 0008's 50-slot
// proposal):
//   per-entry 32 KiB × max 20 slots → 640 KiB structural max per ensemble.
//   That lands at ~16 % of Temporal's 4 MiB CAN-payload ceiling — comfortable
//   headroom on top of existing maestro state (~316 KiB). Saturation refuses
//   with a `CoatCheckSlotsFull` ApplicationFailure rather than evicting LRU
//   — cross-host scope makes silent peer eviction a sharper footgun than
//   the rejection's diagnostic UX.

/** Coat-check ticket id pattern. Alphanumeric + underscore + hyphen, generated server-side via `uuid4()`. */
export const COAT_CHECK_TICKET_REGEX = /^[a-zA-Z0-9_-]+$/;

/** Maximum coat-check ticket id length. Generous to accommodate uuid4 + future versioning prefixes. */
export const COAT_CHECK_TICKET_MAX = 64;

/** Maximum content size per coat-check entry — 32 KiB. Mirrors `PLAYER_STATE_CONTENT_MAX`. */
export const COAT_CHECK_CONTENT_MAX = 32 * 1024;

/** Maximum summary length per coat-check entry — short, listing-friendly preamble. */
export const COAT_CHECK_SUMMARY_MAX = 500;

/** Maximum free-form contentType string (e.g. `'text/markdown'`). */
export const COAT_CHECK_CONTENT_TYPE_MAX = 64;

/** Maximum populated coat-check slots per ensemble. Saturation rejects with `CoatCheckSlotsFull`. */
export const COAT_CHECK_SLOTS_MAX = 20;

/** Minimum allowed `ttlMs` argument on `coat_check_put` — 1 hour. */
export const COAT_CHECK_TTL_MIN_MS = 60 * 60 * 1000;

/** Maximum allowed `ttlMs` argument on `coat_check_put` — 30 days. */
export const COAT_CHECK_TTL_MAX_MS = 30 * 24 * 60 * 60 * 1000;

/** Default `ttlMs` when caller omits the argument — 7 days. */
export const COAT_CHECK_TTL_DEFAULT_MS = 7 * 24 * 60 * 60 * 1000;

// ── Maestro Q&A answer mailbox (#700 P2) ───────────────────────────────────

/**
 * TTL for a parked Q&A answer — fixed 1 hour (shorter than coat-check's 7d;
 * a correlated Q&A answer is transient). Expiry is derived from `answeredAt`,
 * swept by the pure sweep in the maestro 5s refresh tick.
 */
export const MAESTRO_ANSWER_TTL_MS = 60 * 60 * 1000;

/** Maximum populated answer slots per ensemble. Saturation rejects after sweep (mirrors `COAT_CHECK_SLOTS_MAX`). */
export const MAESTRO_ANSWERS_MAX = 20;

/** Maximum length of a planner-supplied Q&A `questionId` (correlation id). */
export const QUESTION_ID_MAX = 128;

/** Allowed shape for a `questionId` — url/path-safe so it rides a cue marker + a GET route segment. */
export const QUESTION_ID_REGEX = /^[a-zA-Z0-9_-]+$/;

/**
 * Maximum length of the ensemble description set via
 * `set_ensemble_description` (#399 W1, Q5.1). Soft cap — the MCP tool
 * boundary rejects oversized inputs; the maestro workflow clamps as a
 * defence-in-depth measure.
 */
export const ENSEMBLE_DESCRIPTION_MAX = 100;

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
