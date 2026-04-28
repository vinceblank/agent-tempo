/**
 * Static catalog of shipped lineups (PR-F1 of #389).
 *
 * The daemon doesn't expose `/v1/loadouts` yet — once it does (or once
 * PR-E adds the dynamic `useLineups()` hook), the Loadouts screen
 * should swap to that data source. Until then this catalog mirrors the
 * five YAML files under `examples/ensembles/` so the screen has a
 * representative table to render.
 *
 * Counts are kept in sync with the YAML by hand. If they drift, update
 * here when adding/removing players from a shipped lineup.
 */

export interface LoadoutEntry {
  /** YAML basename without the `.yaml` suffix. Stable testid key. */
  name: string;
  /** One-line summary surfaced in the Summary column. */
  summary: string;
  /** Total players (excluding the conductor). */
  players: number;
  /** Where this lineup ships from — "shipped" (in the npm tarball)
   *  vs "custom" (project- or user-scoped overrides). */
  source: 'shipped' | 'custom';
  /** Last-used display string. `'—'` when unknown / never used. */
  lastUsed?: string;
}

export const SHIPPED_LINEUPS: readonly LoadoutEntry[] = [
  {
    name: 'tempo-big-band',
    summary: 'Full-lifecycle development ensemble — design, implement, test, review, and ship.',
    players: 9,
    source: 'shipped',
  },
  {
    name: 'tempo-dev-team',
    summary: 'Development team — conductor, composer, two soloists, and a tuner for feature work.',
    players: 5,
    source: 'shipped',
  },
  {
    name: 'tempo-jam-session',
    summary: 'Exploratory ensemble for spikes, research, and problems where the path forward is unclear.',
    players: 4,
    source: 'shipped',
  },
  {
    name: 'tempo-mock-jam',
    summary: 'All-mock ensemble for autonomous validation harnesses (dev mode only).',
    players: 4,
    source: 'shipped',
  },
  {
    name: 'tempo-review-squad',
    summary: 'Three critics with different focus areas for thorough parallel code review.',
    players: 3,
    source: 'shipped',
  },
] as const;
