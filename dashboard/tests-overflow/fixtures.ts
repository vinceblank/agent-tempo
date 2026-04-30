/**
 * Fixture loader for the dashboard overflow CI guardrail suite.
 *
 * Source of truth is `dashboard/test-fixtures/overflow.json` (committed in
 * PR #484, promoted from the audit doc's working artifact). This module
 * re-exports the canonical content values that both walker specs
 * (`cards-headers-wizards.overflow.spec.ts` + `tables-sidebar-chat.overflow.spec.ts`)
 * consume — keeping inline string literals out of the spec files so a
 * future audit can update the fixture once and have both specs re-pin.
 *
 * See `docs/design/dashboard-overflow-audit-v0.28.10.md` §1.6 for the
 * full fixture catalog.
 */
import overflowFixtures from '../test-fixtures/overflow.json' with { type: 'json' };

interface OverflowFixtures {
  playerTypeSlugs: { canonical: string[]; longTail: string[]; stress: string[] };
  ensembleNames: { canonical: string[]; longTail: string[]; stress: string[] };
  descriptions: { canonical: string[]; longTail: string[]; stress: string[] };
  hostnames: { short: string[]; fqdn: string[]; stress: string[] };
  playerNames: { canonical: string[]; longTail: string[]; stress: string[] };
  ensembleSizeProfiles: Record<string, { name: string; playerCount: number; purpose: string }>;
  viewports: {
    canonical: Array<{ label: string; w: number; h: number }>;
    boundary: Array<{ label: string; w: number; h: number }>;
  };
}

const f = overflowFixtures as unknown as OverflowFixtures;

// ── Player-type slugs ─────────────────────────────────────────────────

/** Longest shipped/long-tail player-type slug — `my-tempo-researcher` (19 chars). */
export const LONG_TAIL_PLAYER_TYPE_SLUG = f.playerTypeSlugs.longTail[3];

/** Synthetic-stress player-type slug — 260+ chars, no spaces. */
export const STRESS_PLAYER_TYPE_SLUG = f.playerTypeSlugs.stress[0];

// ── Ensemble names ────────────────────────────────────────────────────

/** Longest production-realistic ensemble name — `tempo-impl-feature-flag-rollout-q3` (34 chars). */
export const LONG_TAIL_ENSEMBLE_NAME = f.ensembleNames.longTail[0];

/** Synthetic-stress ensemble name — 175+ chars, hyphenated. */
export const STRESS_ENSEMBLE_NAME = f.ensembleNames.stress[0];

/** Stress ensemble name — no spaces or hyphens, 128 chars. */
export const STRESS_ENSEMBLE_NAME_NO_BREAKS = f.ensembleNames.stress[1];

// ── Descriptions ──────────────────────────────────────────────────────

/** Synthetic-stress description — 530+ chars, no spaces. */
export const STRESS_DESCRIPTION_UNBREAKABLE = f.descriptions.stress[0];

/** Long-tail-realistic description — 200+ chars natural language. */
export const LONG_TAIL_DESCRIPTION = f.descriptions.longTail[0];

// ── Hostnames ─────────────────────────────────────────────────────────

/** Production-realistic FQDN — Kubernetes-pod shape, 63 chars. */
export const FQDN_HOSTNAME = f.hostnames.fqdn[2];

// ── Player names ──────────────────────────────────────────────────────

/** Long-tail player name — `tempo-design-handoff-rev-4-engineer` (35 chars). */
export const LONG_TAIL_PLAYER_NAME = f.playerNames.longTail[3];

// ── Viewports ─────────────────────────────────────────────────────────

/** Canonical viewport breakpoints — Desktop / Laptop / Tablet / Phone. */
export const CANONICAL_VIEWPORTS = f.viewports.canonical;

/** Boundary viewport pairs — straddling 1200/900/520 CQ tiers. */
export const BOUNDARY_VIEWPORTS = f.viewports.boundary;

// ── Layout constants (not in JSON — measured from CSS) ────────────────

/**
 * Card grid gap from `.ensembles-grid { gap: 14px }` — used by class-B
 * adjacent-card overlap measurement to distinguish "card touched gap"
 * from "card overlapped neighbor".
 */
export const CARDS_GRID_GAP_PX = 14;
