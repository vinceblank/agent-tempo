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

/** Default number of recent messages to include as context in an encore. */
export const ENCORE_DEFAULT_CONTEXT_MESSAGES = 10;

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
