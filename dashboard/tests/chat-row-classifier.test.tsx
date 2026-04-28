/**
 * #446 — chat-row primary/secondary classifier.
 *
 * `rowToFeedMessage()` decides whether a chat row renders as a
 * full-strength `in` / `out` variant or as the dimmed `route` variant
 * ("overheard side-chatter"). The rule, after #446:
 *
 *   primary  iff  `from === MAESTRO_PLAYER_ID || to === MAESTRO_PLAYER_ID`
 *   route    otherwise
 *
 * The conductor is just another player from the dashboard's POV — its
 * chat with other players is overheard, not primary. Before #446 the
 * classifier branched on `role === 'conductor-out'` only, leaving
 * `conductor-in` (player → conductor) leaking into the primary `in`
 * variant. This file pins the symmetric four-direction matrix so the
 * regression cannot reappear.
 */
import { describe, it, expect } from 'vitest';
import type { PlayerSummaryV1 } from 'claude-tempo/http/event-types';
import type { EnsembleChatMessage } from 'claude-tempo/types';
import { buildFormattedRows } from '../src/lib/chat-format';
import { rowToFeedMessage } from '../src/components/chat/ChatLog';
import { makeChatMessage } from './fixtures/factories';

const PLAYERS = new Map<string, PlayerSummaryV1>();

/** Build a chat message + run it through the live `buildFormattedRows`
 * → `rowToFeedMessage` pipeline, returning the `kind` the renderer
 * would receive. Mirrors the production codepath so the test pins the
 * end-to-end classification, not just the adapter call. */
function classify(m: EnsembleChatMessage) {
  const [row] = buildFormattedRows([m], 'tempo-conductor');
  return rowToFeedMessage(row, PLAYERS).kind;
}

describe('rowToFeedMessage — primary vs secondary classifier (#446)', () => {
  it('maestro → player renders primary (out)', () => {
    expect(
      classify(makeChatMessage({ from: 'maestro', to: 'tempo-eng', role: 'maestro-out' })),
    ).toBe('out');
  });

  it('player → maestro renders primary (in)', () => {
    expect(
      classify(makeChatMessage({ from: 'tempo-eng', to: 'maestro', role: 'maestro-in' })),
    ).toBe('in');
  });

  it('playerA → playerB renders secondary (route)', () => {
    expect(
      classify(
        makeChatMessage({ from: 'tempo-eng', to: 'tempo-tuner', role: 'conductor-out' }),
      ),
    ).toBe('route');
  });

  it('conductor → player renders secondary (route) — conductor is a player', () => {
    expect(
      classify(
        makeChatMessage({
          from: 'tempo-conductor',
          to: 'tempo-eng',
          role: 'conductor-out',
        }),
      ),
    ).toBe('route');
  });

  it('player → conductor renders secondary (route) — the #446 regression', () => {
    // Pre-#446 this fell through to `kind: "in"` (primary) because the
    // role-based classifier only routed `conductor-out`. The from/to
    // rule catches both directions.
    expect(
      classify(
        makeChatMessage({
          from: 'tempo-eng',
          to: 'tempo-conductor',
          role: 'conductor-in',
        }),
      ),
    ).toBe('route');
  });

  it('conductor → conductor self-message renders secondary (route)', () => {
    // Belt-and-braces: a self-cue from the conductor is unlikely on the
    // wire path (cue rejects self-targets in normal flow), but if one
    // ever does land it's still neither end === maestro, so the rule
    // says route. Pinning this prevents a future special-case from
    // accidentally reclassifying it as primary.
    expect(
      classify(
        makeChatMessage({
          from: 'tempo-conductor',
          to: 'tempo-conductor',
          role: 'conductor-out',
        }),
      ),
    ).toBe('route');
  });

  // ── Auxiliary corners (legacy + edge cases) ─────────────────────────

  it('legacy "conductor" literal as recipient renders secondary (route)', () => {
    // Pre-#358 chat history may carry `to: 'conductor'` as the literal
    // string instead of the actual conductor playerId. Neither end is
    // maestro, so route is the correct classification.
    expect(
      classify(
        makeChatMessage({
          from: 'tempo-eng',
          to: 'conductor',
          role: 'conductor-in',
        }),
      ),
    ).toBe('route');
  });

  it('maestro → maestro self-route renders primary (out, from-side wins)', () => {
    // The #360 directed-prefix path already suppresses the recipient
    // label for maestro→maestro. The classifier itself sees `from ===
    // MAESTRO_PLAYER_ID` first and picks `out` — it never has to fall
    // through to the secondary branch.
    expect(
      classify(
        makeChatMessage({ from: 'maestro', to: 'maestro', role: 'maestro-out' }),
      ),
    ).toBe('out');
  });
});
