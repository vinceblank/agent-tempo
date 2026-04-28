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
  if (hr < 24) return `${hr}h ago`;
  const day = Math.floor(hr / 24);
  return `${day}d ago`;
}

/**
 * Format an elapsed duration as a compact "Xh Ym" / "Xm" / "Xs" /
 * "—" string. Used by the EnsembleCard / Workspace uptime stat
 * (`now - getEnsembleStartTimeQuery`) and the Hosts uptime column
 * (`now - HostProfile.daemonStartedAt`).
 *
 * Returns `"—"` for `undefined`, negative values (clock skew), and
 * non-finite inputs.
 *
 * Note: parent repo's `src/utils/duration.ts` exports `formatDurationMs`
 * which returns single-unit (`"5h"`); this dashboard helper returns
 * compound (`"1h 14m"`) for grid-aligned display. Different output
 * shapes serve different surfaces — keep both.
 */
export function formatDuration(ms: number | undefined): string {
  if (ms === undefined || !Number.isFinite(ms) || ms < 0) return '—';
  const sec = Math.floor(ms / 1000);
  if (sec < 60) return `${sec}s`;
  const min = Math.floor(sec / 60);
  if (min < 60) return `${min}m`;
  const hr = Math.floor(min / 60);
  const remMin = min % 60;
  if (hr < 24) return remMin ? `${hr}h ${remMin}m` : `${hr}h`;
  const day = Math.floor(hr / 24);
  const remHr = hr % 24;
  return remHr ? `${day}d ${remHr}h` : `${day}d`;
}

/**
 * Format a Q5.7 lease window for the PlayerDetail "lease" KV row.
 * Renders `"expires in 54s"` while live, `"expired"` once the
 * deadline passes, and `"—"` when the field is null/missing
 * (phase ∈ booting/detached/gone).
 */
export function formatLeaseRemaining(
  expiresAt: number | null | undefined,
  now: number = Date.now(),
): string {
  if (expiresAt == null || !Number.isFinite(expiresAt)) return '—';
  const deltaMs = expiresAt - now;
  if (deltaMs <= 0) return 'expired';
  const sec = Math.floor(deltaMs / 1000);
  if (sec < 60) return `expires in ${sec}s`;
  const min = Math.floor(sec / 60);
  if (min < 60) return `expires in ${min}m`;
  const hr = Math.floor(min / 60);
  return `expires in ${hr}h`;
}

/**
 * Truncate a UUID-style runId to `XXXX·XXXX` (first 4 + middle dot +
 * last 4) for the PlayerDetail KV. Returns `"—"` for empty/missing.
 * Short inputs (≤8 chars) pass through unchanged.
 */
export function formatRunId(runId: string | undefined): string {
  if (!runId) return '—';
  const s = runId.trim();
  if (s.length === 0) return '—';
  if (s.length <= 8) return s;
  return `${s.slice(0, 4)}·${s.slice(-4)}`;
}

/**
 * Snapshot `startedAt` ISO → uptime display string (`"1h 14m"`) or
 * `null` when the field is missing / unparseable. Used by both the
 * EnsembleCard uptime stat and the Workspace uptime page-pill — keeps
 * the parse + delta + formatDuration sequence in one place.
 */
export function formatUptimeFromIso(
  startedAt: string | undefined,
  now: number = Date.now(),
): string | null {
  if (!startedAt) return null;
  const startMs = Date.parse(startedAt);
  if (!Number.isFinite(startMs)) return null;
  const out = formatDuration(now - startMs);
  return out === '—' ? null : out;
}
