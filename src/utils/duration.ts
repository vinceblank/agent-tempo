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
