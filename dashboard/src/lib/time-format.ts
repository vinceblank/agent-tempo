/** Display-time helpers shared by chat surfaces (#389). */

/** ISO timestamp → `"HH:MM"` (zero-padded). Returns `"??:??"` on parse failure. */
export function formatHHMM(iso: string): string {
  try {
    const d = new Date(iso);
    return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
  } catch {
    return '??:??';
  }
}

/**
 * Wall-clock relative formatter for heartbeats / event ages.
 * Returns `"—"` when the input is missing or unparseable so the value
 * row can render the standard placeholder rather than a stale "0s ago".
 */
export function formatRelativeAge(iso: string | undefined, now: number = Date.now()): string {
  if (!iso) return '—';
  const t = Date.parse(iso);
  if (Number.isNaN(t)) return '—';
  const ageMs = Math.max(0, now - t);
  const sec = Math.floor(ageMs / 1000);
  if (sec < 60) return `${sec}s ago`;
  const min = Math.floor(sec / 60);
  if (min < 60) return `${min}m ago`;
  const hr = Math.floor(min / 60);
  return `${hr}h ago`;
}
