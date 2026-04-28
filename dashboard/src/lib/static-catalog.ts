/**
 * Static fallback catalog for player-types + lineups.
 *
 * The wire endpoints `/v1/agent-types` and `/v1/lineups` (#400) ARE
 * the canonical source — the wizards consume them via
 * `useAgentTypes()` / `useLineups()`. This module ships a hardcoded
 * mirror used only as the **error-state fallback** so the pickers
 * stay usable when the daemon is unreachable (network blip,
 * pre-startup, etc.).
 *
 * Both arrays conform to the wire-row shapes (`AgentTypeRow` /
 * `LineupRow`) — no shape adaptation needed at the picker boundary.
 * Refresh manually when shipped catalog rows change in
 * `examples/agents/` or `examples/ensembles/`.
 */
import type { AgentTypeRow, LineupRow } from './client';

/**
 * Shipped player types (`examples/agents/*.md`). Order intentional —
 * tempo-conductor first because the create-ensemble flow most often
 * needs it; remaining types in alphabetical order.
 */
export const SHIPPED_PLAYER_TYPES: ReadonlyArray<AgentTypeRow> = [
  {
    name: 'tempo-conductor',
    description: 'Orchestrates the ensemble — breaks down tasks, delegates, synthesizes.',
    source: 'shipped',
  },
  {
    name: 'tempo-composer',
    description: 'Software architect — designs system structure, defines interfaces.',
    source: 'shipped',
  },
  {
    name: 'tempo-critic',
    description: 'Code reviewer — evaluates changes for correctness and quality.',
    source: 'shipped',
  },
  {
    name: 'tempo-improv',
    description: 'Researcher and explorer — investigates unknowns, runs spikes.',
    source: 'shipped',
  },
  {
    name: 'tempo-liner',
    description: 'Documentation specialist — README, CHANGELOG, PR descriptions.',
    source: 'shipped',
  },
  {
    name: 'tempo-roadie',
    description: 'DevOps engineer — CI/CD, deployments, infrastructure.',
    source: 'shipped',
  },
  {
    name: 'tempo-soloist',
    description: 'Senior engineer — implements features, fixes bugs, writes tests.',
    source: 'shipped',
  },
  {
    name: 'tempo-tuner',
    description: 'QA engineer — designs test strategies, finds bugs, validates edges.',
    source: 'shipped',
  },
];

/**
 * Shipped lineups (`examples/ensembles/*.yaml`). Player counts are
 * approximate (drawn from each YAML's `players` array length); refresh
 * them when the YAML changes.
 */
export const SHIPPED_LINEUPS: ReadonlyArray<LineupRow> = [
  {
    name: 'tempo-dev-team',
    description: 'Conductor + composer + soloist + tuner + critic — full dev cycle.',
    players: 5,
    source: 'shipped',
  },
  {
    name: 'tempo-big-band',
    description: 'Every shipped player type — the maximum ensemble.',
    players: 8,
    source: 'shipped',
  },
  {
    name: 'tempo-review-squad',
    description: 'Conductor + critic + tuner — focused on code review and QA.',
    players: 3,
    source: 'shipped',
  },
  {
    name: 'tempo-jam-session',
    description: 'Conductor + 2 soloists + critic — quick exploratory work.',
    players: 4,
    source: 'shipped',
  },
  {
    name: 'tempo-mock-jam',
    description: 'Dev-mode all-mock ensemble for adapter testing.',
    players: 4,
    source: 'shipped',
  },
];

/** Sentinel value used for "no lineup" / blank-ensemble flow. */
export const BLANK_LINEUP_SENTINEL = '__blank__';
