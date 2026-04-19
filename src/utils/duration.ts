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
