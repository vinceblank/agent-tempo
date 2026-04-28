/**
 * Static fallback catalog for player-types + lineups. PR-E of #389.
 *
 * The wizards (Recruit, CreateEnsemble) need pickable lists, but the
 * daemon doesn't yet expose `/v1/agent-types` or `/v1/lineups`
 * endpoints. Until those land we hardcode the shipped catalog from
 * `examples/agents/` and `examples/ensembles/` so the UI works end-to-end.
 *
 * Wire-gap follow-up (architect-tracked): replace the constants with
 * TanStack queries once daemon endpoints exist:
 *   - GET /v1/agent-types  → replaces SHIPPED_PLAYER_TYPES
 *   - GET /v1/lineups      → replaces SHIPPED_LINEUPS
 * Mock-client fixtures will need a hostList-style stub at the same
 * time. Each consumer reads from this module — flip it to query
 * results in one place when the wire arrives.
 */

export interface PlayerType {
  /** Stable id matching the markdown filename (sans `.md`). */
  name: string;
  /** One-line summary surfaced in the picker `desc` slot. */
  summary: string;
}

/**
 * Shipped player types (`examples/agents/*.md`). Order intentional —
 * tempo-conductor first because the create-ensemble flow most often
 * needs it; remaining types in alphabetical order.
 */
export const SHIPPED_PLAYER_TYPES: ReadonlyArray<PlayerType> = [
  {
    name: 'tempo-conductor',
    summary: 'Orchestrates the ensemble — breaks down tasks, delegates, synthesizes.',
  },
  {
    name: 'tempo-composer',
    summary: 'Software architect — designs system structure, defines interfaces.',
  },
  {
    name: 'tempo-critic',
    summary: 'Code reviewer — evaluates changes for correctness and quality.',
  },
  {
    name: 'tempo-improv',
    summary: 'Researcher and explorer — investigates unknowns, runs spikes.',
  },
  {
    name: 'tempo-liner',
    summary: 'Documentation specialist — README, CHANGELOG, PR descriptions.',
  },
  {
    name: 'tempo-roadie',
    summary: 'DevOps engineer — CI/CD, deployments, infrastructure.',
  },
  {
    name: 'tempo-soloist',
    summary: 'Senior engineer — implements features, fixes bugs, writes tests.',
  },
  {
    name: 'tempo-tuner',
    summary: 'QA engineer — designs test strategies, finds bugs, validates edges.',
  },
];

export interface Lineup {
  /** Filename stem (e.g. "tempo-dev-team"). */
  name: string;
  /** One-line summary shown under the lineup name in the picker. */
  summary: string;
  /** Approximate player count — wizards use this for the `· N players` qualifier. */
  players: number;
}

/**
 * Shipped lineups (`examples/ensembles/*.yaml`). Player counts are
 * approximate (drawn from each YAML's `players` array length); refresh
 * them when the YAML changes.
 */
export const SHIPPED_LINEUPS: ReadonlyArray<Lineup> = [
  {
    name: 'tempo-dev-team',
    summary: 'Conductor + composer + soloist + tuner + critic — full dev cycle.',
    players: 5,
  },
  {
    name: 'tempo-big-band',
    summary: 'Every shipped player type — the maximum ensemble.',
    players: 8,
  },
  {
    name: 'tempo-review-squad',
    summary: 'Conductor + critic + tuner — focused on code review and QA.',
    players: 3,
  },
  {
    name: 'tempo-jam-session',
    summary: 'Conductor + 2 soloists + critic — quick exploratory work.',
    players: 4,
  },
  {
    name: 'tempo-mock-jam',
    summary: 'Dev-mode all-mock ensemble for adapter testing.',
    players: 4,
  },
];

/** Sentinel value used for "no lineup" / blank-ensemble flow. */
export const BLANK_LINEUP_SENTINEL = '__blank__';
