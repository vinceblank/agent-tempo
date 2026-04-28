/**
 * Static fallback catalog of shipped lineups (PR-F1 of #389).
 *
 * The daemon's `/v1/lineups` endpoint (#400) is now canonical; the
 * Loadouts screen consumes it via `useLineups()`. This module ships a
 * hardcoded mirror used as the **eager-fallback** so the table stays
 * populated when the daemon is unreachable or while the query loads.
 *
 * Conforms to the wire-row shape (`LineupRow`) — no shape adapter
 * needed at the consumer boundary. Refresh manually when shipped
 * lineup rows change in `examples/ensembles/`.
 *
 * **Consolidation note**: PR-DB2 #415 added a parallel
 * `lib/static-catalog.SHIPPED_LINEUPS` that mirrors the same data.
 * Two fallback modules will coexist until the architect harmonises
 * them; the audit doc tracks the consolidation.
 */
import type { LineupRow } from './client';

export const SHIPPED_LINEUPS: ReadonlyArray<LineupRow> = [
  {
    name: 'tempo-big-band',
    description:
      'Full-lifecycle development ensemble — design, implement, test, review, and ship.',
    players: 9,
    source: 'shipped',
  },
  {
    name: 'tempo-dev-team',
    description:
      'Development team — conductor, composer, two soloists, and a tuner for feature work.',
    players: 5,
    source: 'shipped',
  },
  {
    name: 'tempo-jam-session',
    description:
      'Exploratory ensemble for spikes, research, and problems where the path forward is unclear.',
    players: 4,
    source: 'shipped',
  },
  {
    name: 'tempo-mock-jam',
    description:
      'All-mock ensemble for autonomous validation harnesses (dev mode only).',
    players: 4,
    source: 'shipped',
  },
  {
    name: 'tempo-review-squad',
    description:
      'Three critics with different focus areas for thorough parallel code review.',
    players: 3,
    source: 'shipped',
  },
];
