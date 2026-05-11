/** Parse a duration string like "30s", "10m", "2h", "1d" into milliseconds. */
export function parseDuration(dur: string): number | null {
  const match = dur.match(/^(\d+(?:\.\d+)?)\s*(s|m|h|d)$/i);
  if (!match) return null;
  const value = parseFloat(match[1]);
  switch (match[2].toLowerCase()) {
    case 's': return value * 1000;
    case 'm': return value * 60_000;
    case 'h': return value * 3_600_000;
    case 'd': return value * 86_400_000;
    default: return null;
  }
}

/**
 * Humanise a millisecond count as a short duration string: `30s` / `5m` /
 * `2h` / `1d`. Picks the largest unit whose integer-or-fractional value is
 * ≥ 1. Inverse (roughly) of {@link parseDuration}; matches the output shape
 * several other surfaces emit (scheduler listings, attachment-info CLI).
 *
 * Consolidated here as part of #264 so the shared attachment-info formatter
 * in `src/utils/attachment-format.ts` doesn't drag the CLI-local duplicate.
 * Other local duplicates exist at `src/ensemble/saver.ts` and
 * `src/tools/schedules.ts` — those can be migrated incrementally; leaving
 * them alone keeps this PR's scope tight.
 */
export function formatDurationMs(ms: number): string {
  if (ms >= 86_400_000) return `${ms / 86_400_000}d`;
  if (ms >= 3_600_000) return `${ms / 3_600_000}h`;
  if (ms >= 60_000) return `${ms / 60_000}m`;
  return `${ms / 1000}s`;
}

/**
 * Render an ISO timestamp as a coarse "N{s,m,h,d} ago" string for human-
 * readable listings. Returns `"just now"` for ≤1s, `"unknown"` if the
 * timestamp can't be parsed.
 *
 * `now` is injectable for deterministic tests; defaults to `Date.now()`.
 *
 * **Why a second time helper exists** (the TUI has `formatRelativeTime`
 * in `src/tui/utils/format.ts` doing roughly the same thing):
 * `src/tui/` carries Ink/React transitive imports the headless tools layer
 * mustn't take on. This helper has zero dependencies and is freely
 * importable by any layer. Consolidation across the two homes is tracked
 * as future deduplication work, not in scope here.
 */
export function formatTimeAgo(iso: string, now: number = Date.now()): string {
  const t = Date.parse(iso);
  if (!Number.isFinite(t)) return 'unknown';
  const ms = now - t;
  if (ms < 1000) return 'just now';
  if (ms < 60_000) return `${Math.floor(ms / 1000)}s ago`;
  if (ms < 3_600_000) return `${Math.floor(ms / 60_000)}m ago`;
  if (ms < 86_400_000) return `${Math.floor(ms / 3_600_000)}h ago`;
  return `${Math.floor(ms / 86_400_000)}d ago`;
}
