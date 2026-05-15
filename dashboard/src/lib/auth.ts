/**
 * Bearer-token storage for the dashboard.
 *
 * **PR-4 scope**: thin localStorage wrapper. The cross-device pairing
 * flow (PR-7/8 of #340) lands a real `?pair=<token>` exchange that
 * writes the bearer here; for now operators can paste manually via
 * future settings UI, or run loopback (no auth required).
 *
 * The key is namespaced so a future multi-daemon dashboard can hold
 * different tokens for different daemons. Single-daemon dev: only the
 * default key is read.
 */

const STORAGE_KEY = 'agent-tempo:bearer';

/** Read the saved bearer token, or `null` when none / unavailable. */
export function getBearerToken(): string | null {
  if (typeof window === 'undefined') return null;
  try {
    const v = window.localStorage?.getItem(STORAGE_KEY);
    return v && v.length > 0 ? v : null;
  } catch {
    return null;
  }
}

/** Save a bearer token. Pass `null` to clear. */
export function setBearerToken(token: string | null): void {
  if (typeof window === 'undefined') return;
  try {
    if (token) window.localStorage?.setItem(STORAGE_KEY, token);
    else window.localStorage?.removeItem(STORAGE_KEY);
  } catch {
    /* ignore — private mode / quota */
  }
}
