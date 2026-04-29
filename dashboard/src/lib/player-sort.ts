/**
 * Player ordering — conductor first, then alphabetical by playerId.
 *
 * #462 — every dashboard surface that renders the active-players list should
 * put the conductor at index 0 regardless of name. The conductor is the
 * orchestration hub; its position is operationally meaningful, not
 * alphabetical. Critical for preview slices (`EnsembleCard.tsx` shows the
 * first 5; `Workspace.tsx` event log shows the first 6) — without this sort
 * the conductor can fall off the preview entirely on a 6+ player ensemble.
 *
 * Pure function — no React, no hooks. Callers wrap in `useMemo` over the
 * snapshot's players array. The compare-style export (`conductorFirst`)
 * is for `[...players].sort(conductorFirst)` patterns; `sortConductorFirst`
 * is the immutable convenience wrapper that returns a fresh array so call
 * sites don't have to spread.
 */

/**
 * Strict-minimum shape — every surface that calls this passes either a
 * `PlayerSummaryV1` (snapshot/SSE) or the legacy `PlayerInfo` (cached
 * client read). Both expose `isConductor` and `playerId`; nothing else
 * is consulted.
 */
interface PlayerLike {
  isConductor?: boolean;
  playerId: string;
}

/**
 * Compare two players for the conductor-first ordering. Use directly with
 * `Array.prototype.sort` (in-place) or `toSorted` (immutable).
 *
 *   - Conductor before non-conductor (regardless of name).
 *   - Otherwise stable alphabetical by playerId via `localeCompare`.
 *
 * Note: in a healthy ensemble exactly one player has `isConductor === true`.
 * The "both conductors" path falls through to alphabetical, same as the
 * "neither conductor" path — a degenerate state that shouldn't happen on
 * the wire but won't break the sort if it does.
 */
export function conductorFirst<T extends PlayerLike>(a: T, b: T): number {
  if (a.isConductor && !b.isConductor) return -1;
  if (!a.isConductor && b.isConductor) return 1;
  return a.playerId.localeCompare(b.playerId);
}

/**
 * Return a new array sorted by {@link conductorFirst}. Use at render sites
 * that want to preserve the input array's identity for downstream memo
 * keys (the snapshot's `players` reference). Calling `[...players].sort(...)`
 * inline works too — this helper is here for read-site clarity.
 */
export function sortConductorFirst<T extends PlayerLike>(players: readonly T[]): T[] {
  return [...players].sort(conductorFirst);
}
