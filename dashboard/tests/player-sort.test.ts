/**
 * #462 — conductor-first player ordering helper.
 *
 * Pins the two-rule contract every dashboard surface relies on:
 *   1. Conductor before any non-conductor regardless of name.
 *   2. Otherwise stable alphabetical by `playerId.localeCompare`.
 *
 * Critical for the slice-truncation case the helper exists to prevent —
 * EnsembleCard previews the first 5 players, the Workspace event log
 * previews the first 6, and without this sort a 7+ player ensemble
 * could silently drop the conductor from the preview.
 */
import { describe, it, expect } from 'vitest';
import { conductorFirst, sortConductorFirst } from '../src/lib/player-sort';

interface TestPlayer {
  playerId: string;
  isConductor?: boolean;
}

describe('conductorFirst comparator (#462)', () => {
  it('returns -1 when only `a` is the conductor', () => {
    expect(conductorFirst(
      { playerId: 'z-conductor', isConductor: true },
      { playerId: 'alice', isConductor: false },
    )).toBe(-1);
  });

  it('returns +1 when only `b` is the conductor', () => {
    expect(conductorFirst(
      { playerId: 'alice', isConductor: false },
      { playerId: 'z-conductor', isConductor: true },
    )).toBeGreaterThan(0);
  });

  it('falls through to alphabetical when neither is the conductor', () => {
    expect(conductorFirst(
      { playerId: 'alice', isConductor: false },
      { playerId: 'bob', isConductor: false },
    )).toBeLessThan(0);
    expect(conductorFirst(
      { playerId: 'bob', isConductor: false },
      { playerId: 'alice', isConductor: false },
    )).toBeGreaterThan(0);
  });

  it('treats undefined isConductor as false (snapshot may omit the flag)', () => {
    expect(conductorFirst(
      { playerId: 'a', isConductor: true },
      { playerId: 'b' },  // isConductor omitted
    )).toBe(-1);
  });

  it('falls through to alphabetical in the degenerate "both conductors" path', () => {
    // Shouldn't happen on the wire (one conductor per ensemble) but the
    // sort must not crash if it ever does — pick alphabetical as the
    // tie-breaker rather than asserting the invariant client-side.
    expect(conductorFirst(
      { playerId: 'b', isConductor: true },
      { playerId: 'a', isConductor: true },
    )).toBeGreaterThan(0);
  });
});

describe('sortConductorFirst — immutable wrapper (#462)', () => {
  it('returns conductor at index 0 regardless of name', () => {
    // Build the canonical tripwire: conductor named to sort LAST
    // alphabetically + two non-conductors that sort before it. Without
    // the rule the conductor would land at index 2; with it, index 0.
    const players: TestPlayer[] = [
      { playerId: 'alice', isConductor: false },
      { playerId: 'bob', isConductor: false },
      { playerId: 'z-conductor', isConductor: true },
    ];
    const sorted = sortConductorFirst(players);
    expect(sorted.map((p) => p.playerId)).toEqual(['z-conductor', 'alice', 'bob']);
  });

  it('preserves alphabetical secondary order among non-conductors', () => {
    const players: TestPlayer[] = [
      { playerId: 'charlie' },
      { playerId: 'alice' },
      { playerId: 'bob' },
    ];
    expect(sortConductorFirst(players).map((p) => p.playerId))
      .toEqual(['alice', 'bob', 'charlie']);
  });

  it('does not mutate the input array (immutable contract)', () => {
    const input: TestPlayer[] = [
      { playerId: 'alice' },
      { playerId: 'z-conductor', isConductor: true },
    ];
    const inputBefore = [...input];
    const sorted = sortConductorFirst(input);
    // Input untouched; sorted is a new array with new ordering.
    expect(input).toEqual(inputBefore);
    expect(sorted).not.toBe(input);
  });

  it('handles empty + single-player edge cases without throwing', () => {
    expect(sortConductorFirst([])).toEqual([]);
    expect(sortConductorFirst([{ playerId: 'solo' }])).toEqual([{ playerId: 'solo' }]);
    expect(sortConductorFirst([{ playerId: 'lonely-conductor', isConductor: true }]))
      .toEqual([{ playerId: 'lonely-conductor', isConductor: true }]);
  });

  it('preserves conductor in slice-truncated previews (the latent dropout case)', () => {
    // The whole reason this helper exists: EnsembleCard previews 5,
    // event-log previews 6. A 7-player ensemble with a late-alphabetical
    // conductor name would push the conductor past index 5/6 without
    // sorting first.
    const players: TestPlayer[] = [
      { playerId: 'alpha' }, { playerId: 'bravo' }, { playerId: 'charlie' },
      { playerId: 'delta' }, { playerId: 'echo' }, { playerId: 'foxtrot' },
      { playerId: 'zulu-conductor', isConductor: true },
    ];
    const previewFive = sortConductorFirst(players).slice(0, 5);
    expect(previewFive[0].playerId).toBe('zulu-conductor');
    expect(previewFive).toHaveLength(5);
    // Sanity: the first 4 non-conductor slots are alphabetically the
    // earliest non-conductors, NOT the order they appeared in input.
    expect(previewFive.slice(1).map((p) => p.playerId))
      .toEqual(['alpha', 'bravo', 'charlie', 'delta']);
  });
});
