/**
 * Overflow-route fixture catalog (#492).
 *
 * The `/__overflow/<Component>?regime=<...>` route shim (registered in
 * dev-mode-only at `router.tsx`) reads from this module to pre-seed
 * TanStack Query caches with predictable, regime-keyed fixture data
 * BEFORE the target screen mounts. Components then render off the
 * seeded cache — no `/v1/*` calls, no daemon required — exactly what
 * the Walk A overflow Playwright tests need to run unconditionally.
 *
 * ## Regimes
 *
 *   - **`'long'`** — long-tail-realistic content (FQDN hostnames,
 *     long-but-natural ensemble names, multi-sentence descriptions).
 *     The default mode the Walk A tests inject extra content on top of.
 *   - **`'short'`** — canonical/short content. Useful for "is the
 *     layout sane at the boring case" assertions.
 *   - **`'i18n'`** — i18n stress (non-ASCII labels, wide glyphs).
 *     Catches `.page-actions` button row collisions etc.
 *   - **`'stress'`** — synthetic worst-case (very long strings, no
 *     break opportunities). Catches class-A self-overflow.
 *
 * Single source of truth lives in `dashboard/test-fixtures/overflow.json`;
 * this module re-shapes those raw values into wire-typed objects
 * (`EnsembleSummary`, `EnsembleStateV1`, `HostInfo`, `LineupRow`,
 * `AgentTypeRow`) so the seeded cache is structurally identical to a
 * real `/v1/*` response.
 *
 * **Production-safety**: the route that consumes these fixtures is
 * `import.meta.env.DEV`-gated in the router, so neither the fixtures
 * nor the shim screen reach a production bundle. The fixtures file
 * itself imports cleanly in any mode — gating the route is what
 * matters.
 */
import type { EnsembleSummary, EnsembleStateV1, HostInfo } from './client';
import type { AgentTypeRow, LineupRow } from './client';
import type { PlayerSummaryV1 } from 'claude-tempo/http/event-types';
import overflowFixtures from '../../test-fixtures/overflow.json' with { type: 'json' };

/** Supported regime values for the `?regime=` query param. */
export const OVERFLOW_REGIMES = ['long', 'short', 'i18n', 'stress'] as const;
export type OverflowRegime = (typeof OVERFLOW_REGIMES)[number];

export function isOverflowRegime(s: string | null): s is OverflowRegime {
  return s !== null && (OVERFLOW_REGIMES as readonly string[]).includes(s);
}

// ── Raw fixture access ─────────────────────────────────────────────────

interface RawFixtures {
  playerTypeSlugs: { canonical: string[]; longTail: string[]; stress: string[] };
  ensembleNames: { canonical: string[]; longTail: string[]; stress: string[] };
  descriptions: { canonical: string[]; longTail: string[]; stress: string[] };
  hostnames: { short: string[]; fqdn: string[]; stress: string[] };
  playerNames: { canonical: string[]; longTail: string[]; stress: string[] };
}

const raw = overflowFixtures as unknown as RawFixtures;

/** Catalog shape — every fixture group carries at least one of these
 *  keys; missing keys fall back to whichever non-empty bucket exists. */
interface FixtureCatalog {
  canonical?: string[];
  longTail?: string[];
  stress?: string[];
  short?: string[];
  fqdn?: string[];
}

/** Pick a regime-appropriate slice from a fixture catalog. Falls back
 *  via the order `requested → longTail/fqdn → canonical/short → stress`
 *  so a caller passing an unusual catalog shape still gets a non-empty
 *  array back. */
function pick(triple: FixtureCatalog, regime: OverflowRegime): string[] {
  const fallback = triple.canonical ?? triple.short ?? triple.longTail ?? triple.fqdn ?? triple.stress ?? [];
  switch (regime) {
    case 'short':
      // `canonical` for ensembles/descriptions, `short` for hostnames.
      return triple.short ?? triple.canonical ?? fallback;
    case 'long':
      return triple.longTail ?? triple.fqdn ?? fallback;
    case 'stress':
      return triple.stress ?? fallback;
    case 'i18n':
      // No dedicated i18n bucket in the JSON — the stress catalog holds
      // a non-ASCII ensemble name (`"アンサンブル-多文字-テスト…"`); reuse it.
      return triple.stress ?? fallback;
  }
}

// ── EnsembleSummary[] for the list query ─────────────────────────────

/**
 * Build the EnsembleSummary list that seeds `ENSEMBLES_QUERY_KEY`.
 *
 * The list-cardinality per regime is deliberately conservative — the
 * `short` regime returns ONE ensemble (the minimal seed that makes
 * `[data-testid^="ensemble-card-"]` selectors resolve), and only the
 * `long`/`stress` regimes scale up to multiple ensembles to exercise
 * the cards-grid layout under load. The narrow-viewport refutation
 * tests (`H10` page-pills × page-actions collision) hold against the
 * single-ensemble baseline; multi-ensemble seeds inflate the pill
 * count enough to actually overlap actions at ≤899px, which is a
 * real layout brittleness worth flagging as future work (#494 scope)
 * but is OUT of scope for the route-shim landing.
 *
 * Returns at least one ensemble in every regime so the selectors
 * always resolve.
 */
export function fixtureEnsembleList(regime: OverflowRegime): EnsembleSummary[] {
  const cap = regime === 'short' ? 1 : 3;
  const names = pick(raw.ensembleNames, regime).slice(0, cap);
  // Guarantee ≥1 entry — if a regime's catalog is unexpectedly empty
  // we still want the page to render an ensemble-card grid so the
  // existing test selectors work.
  if (names.length === 0) names.push('tempo-jam');
  return names.map((name, i) => ({
    name,
    // #574: in 'short' the matching `fixtureEnsembleSnapshot` seeds 6
    // players to exercise the H13 5-avatar cap; keep playerCount in
    // lockstep so cards that display the summary count agree with the
    // roster they render. Other regimes' counts are unchanged (3 + i).
    playerCount: regime === 'short' ? 6 : 3 + i,
    hasConductor: true,
    state: 'online',
  }));
}

/**
 * Build a per-ensemble snapshot for `ensembleQueryKey(name)`. Mirrors
 * the daemon's `EnsembleStateV1` shape; the EnsembleCard reads
 * `description`, `currentBpm`, `startedAt`, and the `players` array
 * from this snapshot for the rich card body.
 */
export function fixtureEnsembleSnapshot(
  regime: OverflowRegime,
  ensembleName: string,
): EnsembleStateV1 {
  const descriptions = pick(raw.descriptions, regime);
  const description = descriptions[0] ?? '';
  const hostnameCatalog = pick(raw.hostnames, regime);
  const hostname = hostnameCatalog[0] ?? 'main-laptop';
  const playerNames = pick(raw.playerNames, regime);
  const conductorName = playerNames[0] ?? 'tempo-conductor';
  const leadName = playerNames[1] ?? 'tempo-eng';
  const startedAt = new Date(Date.now() - 3_600_000).toISOString(); // 1h ago
  // #574: in the 'short' regime, seed 6 players so the H13 ec-roster test's
  // 5-avatar slice cap is visually exercised (5 avatars rendered + 1 dropped
  // by the JSX `.slice(0, 5)`). Other regimes keep the 2-player seed they
  // had before — the only test currently invoking 'short' is H13's roster
  // baseline, and changing 'long' / 'stress' / 'i18n' would force a refresh
  // of every Overview-card baseline they touch for no incremental gain.
  const extraPlayerCount = regime === 'short' ? 4 : 0;
  const players: PlayerSummaryV1[] = [
    {
      playerId: conductorName,
      ensemble: ensembleName,
      hostname,
      isConductor: true,
      agentType: 'claude',
      playerType: 'tempo-conductor',
      phase: 'attached',
      part: 'PO session',
      workDir: '/repo',
      gitBranch: 'main',
    },
    {
      playerId: leadName,
      ensemble: ensembleName,
      hostname,
      isConductor: false,
      agentType: 'claude',
      playerType: 'my-tempo-engineer',
      phase: 'attached',
      part: 'Engineer session',
      workDir: '/repo',
      gitBranch: 'main',
    },
    // #574: anonymous fill players so 'short' reaches 6 total — enough to
    // exercise the H13 5-avatar cap visually. Indices 2-5 reuse playerNames
    // from the catalog (falling back to deterministic synthesized names) so
    // the roster keeps recognizable identities rather than `player-3` etc.
    ...Array.from({ length: extraPlayerCount }, (_, idx): PlayerSummaryV1 => ({
      playerId: playerNames[idx + 2] ?? `tempo-player-${idx + 3}`,
      ensemble: ensembleName,
      hostname,
      isConductor: false,
      agentType: 'claude',
      playerType: 'my-tempo-engineer',
      phase: 'attached',
      part: 'Engineer session',
      workDir: '/repo',
      gitBranch: 'main',
    })),
  ];
  return {
    v: 1,
    ensemble: ensembleName,
    capturedAt: new Date().toISOString(),
    lastEventId: '0:0',
    state: 'online',
    hasConductor: true,
    flags: { paused: false, held: false },
    players,
    schedules: [],
    chat: { messages: [], total: 0, hasMore: false },
    hostProfiles: {},
    description,
    startedAt,
    currentBpm: regime === 'stress' ? 9999 : 42,
    tempoSeries: [],
  };
}

// ── HostInfo[] for the host list query ───────────────────────────────

export function fixtureHosts(regime: OverflowRegime): HostInfo[] {
  const names = pick(raw.hostnames, regime);
  const primary = names[0] ?? 'main-laptop';
  return [
    {
      hostname: primary,
      instances: [],
      recruitReady: true,
      freshness: 'live',
      profileStaleness: 'fresh',
      profile: {
        hostname: primary,
        version: '0.28.0',
        defaultAgent: 'claude',
        platform: 'linux',
        capabilities: [],
      },
    },
  ];
}

// ── LineupRow[] for the CreateEnsemble PickerList ────────────────────

/**
 * Seeds the lineup picker. The Walk A CreateEnsemble test injects
 * fixture text into `.picker-row .name` via DOM eval; this fixture
 * just guarantees ≥1 picker row exists at render time so the
 * `await page.waitForSelector('.picker-row')` resolves.
 *
 * `regime` controls the catalog source so a `stress` walk renders
 * pre-stressed rows (e.g. a 260-char player-type slug as the row's
 * `name`). The test can still override via `page.evaluate`.
 */
export function fixtureLineups(regime: OverflowRegime): LineupRow[] {
  const names = pick(raw.ensembleNames, regime).slice(0, 4);
  if (names.length === 0) names.push('tempo-jam');
  const descriptions = pick(raw.descriptions, regime);
  return names.map((name, i) => ({
    name,
    description: descriptions[i % descriptions.length] ?? '',
    players: 3 + i,
    source: i === 0 ? 'shipped' : 'saved',
  }));
}

// ── AgentTypeRow[] for the PlayerTypes catalog screen ───────────────

/**
 * Seeds the PlayerTypes library catalog. Mirrors the `LineupRow`
 * fixture's rationale — guarantees ≥1 row so `.types-grid .display`
 * selectors resolve. The Walk A PlayerTypes test injects stress slugs
 * via DOM eval.
 */
export function fixtureAgentTypes(regime: OverflowRegime): AgentTypeRow[] {
  const slugs = pick(raw.playerTypeSlugs, regime).slice(0, 8);
  if (slugs.length === 0) slugs.push('tempo-conductor');
  return slugs.map((name, i) => ({
    name,
    description: `Fixture player type for overflow regime "${regime}" (row ${i + 1}).`,
    source: i % 3 === 0 ? 'shipped' : i % 3 === 1 ? 'user' : 'project',
  }));
}
