/**
 * Structured console logging for the dashboard.
 *
 * State transitions, mutations, and SSE events go through `logEvent` so the
 * conductor's autonomous validation script can grep `[agent-tempo:dashboard]`
 * via `mcp__claude-in-chrome__read_console_messages` without parsing the DOM.
 * Mirrors the `[agent-tempo:adapter]` format from `src/adapters/base.ts`
 * (#249) so the same regex-based reader works across both surfaces.
 *
 * Output format (one line per event):
 *
 *   [agent-tempo:dashboard] <action> key=value key=value
 *
 * Values are JSON-stringified so strings carry their quotes (which makes them
 * unambiguously match-able vs. numbers/booleans). See `dashboard/README.md`
 * § Testability for the conventions.
 */

const LOG_PREFIX = '[agent-tempo:dashboard]';

export type LogLevel = 'debug' | 'info' | 'warn' | 'error';

/**
 * Whether debug-level logs should fire. Two opt-ins (either is sufficient):
 *   - `?debug=1` (or any value) on the URL
 *   - `localStorage.agentTempoDebug === 'true'`
 *
 * The check is done per call rather than cached so toggling localStorage in a
 * running session takes effect immediately. The cost is negligible — the
 * gate runs only when `level === 'debug'`.
 */
function debugEnabled(): boolean {
  if (typeof window === 'undefined') return false;
  try {
    if (new URLSearchParams(window.location.search).has('debug')) return true;
  } catch {
    /* malformed URL — fall through to localStorage check */
  }
  try {
    return window.localStorage?.getItem('agentTempoDebug') === 'true';
  } catch {
    return false;
  }
}

function formatKvs(kvs: Record<string, unknown>): string {
  const entries = Object.entries(kvs);
  if (entries.length === 0) return '';
  return entries.map(([k, v]) => `${k}=${JSON.stringify(v)}`).join(' ');
}

/**
 * Emit a structured log line. `level` defaults to `'info'`; `'debug'` is
 * gated by the `debugEnabled()` check. `kvs` is optional and may be omitted
 * for action-only events (`logEvent('app-mounted')`).
 */
export function logEvent(
  action: string,
  kvs: Record<string, unknown> = {},
  level: LogLevel = 'info',
): void {
  if (level === 'debug' && !debugEnabled()) return;
  const formatted = formatKvs(kvs);
  const line = formatted ? `${LOG_PREFIX} ${action} ${formatted}` : `${LOG_PREFIX} ${action}`;
  // `console[level]` is supported by every modern browser. We don't fall back
  // to `console.log` for unknown levels because the type system already
  // constrains `level` to `LogLevel`.
  console[level](line);
}
