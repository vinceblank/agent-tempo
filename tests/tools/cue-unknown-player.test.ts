/**
 * Unit tests for the cue tool's unknown-player error helper (#560).
 *
 * The MCP `cue` tool catches a null result from `resolveSession` and used
 * to surface a generic `"no active session found for 'X'"`. The new
 * `formatUnknownPlayerError` builds an actionable message: fuzzy-match
 * suggestions (Levenshtein ≤ 3), active-player listing, and a note about
 * Claude Code Agent-tool sub-agents not being addressable via cue.
 *
 * Tests target the pure helpers directly — the full cue tool's success
 * path is covered by Temporal integration tests in `test/`; here we
 * exercise just the error-formatting + edit-distance maths.
 */
import { describe, it, expect } from 'vitest';
import {
  formatUnknownPlayerError,
  findClosestPlayers,
  levenshtein,
} from '../../src/tools/cue';

describe('formatUnknownPlayerError', () => {
  it('opens with a clear failure line naming the target', () => {
    const msg = formatUnknownPlayerError('ghost', ['alice', 'bob']);
    expect(msg).toMatch(/^Player "ghost" is not registered with this tempo ensemble\./);
  });

  it('surfaces a fuzzy-match suggestion when a near name exists', () => {
    const msg = formatUnknownPlayerError('alic', ['alice', 'bob', 'carol']);
    expect(msg).toContain('Did you mean: "alice"?');
  });

  it('lists active players when any exist', () => {
    const msg = formatUnknownPlayerError('ghost', ['alice', 'bob']);
    expect(msg).toContain('Active players: alice, bob');
  });

  it('says "no active players" when the ensemble is empty', () => {
    const msg = formatUnknownPlayerError('anyone', []);
    expect(msg).toContain('No active players in this ensemble. Use `recruit` to start one.');
    // No active-players line and no suggestion line should appear.
    expect(msg).not.toContain('Active players:');
    expect(msg).not.toContain('Did you mean:');
  });

  it('always includes the Agent-tool sub-agent hint', () => {
    const msg = formatUnknownPlayerError('tempo-soloist-1234', ['alice']);
    // Hint mentions both the misuse pattern and the recovery surface.
    expect(msg).toMatch(/subagent_type/);
    expect(msg).toMatch(/recruit/);
    expect(msg).toMatch(/ensemble/);
  });

  it('omits "Did you mean" when no candidate is within the edit-distance threshold', () => {
    // 'abcdefg' vs each candidate: 'xyzqrst'=7, 'monorepo'=8, 'mnopqr'=6 — all > 3.
    // (Three-char names like 'bob' are within distance 3 of nearly anything,
    // so we use longer fully-distinct strings here.)
    const msg = formatUnknownPlayerError('abcdefg', ['xyzqrst', 'monorepo', 'mnopqr']);
    expect(msg).not.toContain('Did you mean:');
  });

  it('caps suggestions at 3 even when many candidates are close', () => {
    // 5 candidates within distance 1 of "test": tesx, teyt, test1, tes, ttest
    const msg = formatUnknownPlayerError('test', ['tesx', 'teyt', 'test1', 'tes', 'ttest']);
    const match = msg.match(/Did you mean: ([^?]+)\?/);
    expect(match).not.toBeNull();
    // Count commas + 1 = number of suggestions.
    const count = match![1].split(', ').length;
    expect(count).toBeLessThanOrEqual(3);
  });
});

describe('findClosestPlayers', () => {
  it('returns empty array when target is empty', () => {
    expect(findClosestPlayers('', ['alice', 'bob'])).toEqual([]);
  });

  it('returns empty array when there are no candidates', () => {
    expect(findClosestPlayers('alice', [])).toEqual([]);
  });

  it('returns single-edit-distance match', () => {
    // 'alic' → 'alice' is 1 insertion.
    expect(findClosestPlayers('alic', ['alice', 'bob'])).toEqual(['alice']);
  });

  it('orders by distance ascending, then alphabetically', () => {
    // 'tempo-en' is distance 1 from 'tempo-eng' and 'tempo-pm'… let's pick clearer ones:
    // 'al' → 'alice' (3), 'alf' (1), 'alex' (2). Order should be: alf (1), alex (2), alice (3).
    expect(findClosestPlayers('al', ['alice', 'alf', 'alex'])).toEqual(['alf', 'alex', 'alice']);
  });

  it('filters out candidates beyond the edit-distance threshold (>3)', () => {
    // 'cat' vs 'elephant' is distance 7 — should not appear.
    expect(findClosestPlayers('cat', ['elephant'])).toEqual([]);
  });

  it('includes exact matches at the front (distance 0)', () => {
    // Edge case: the target IS one of the candidates. Real-world this
    // wouldn't happen because resolveSession would have found it — but
    // the helper is robust to it.
    expect(findClosestPlayers('alice', ['alice', 'alic'])).toEqual(['alice', 'alic']);
  });
});

describe('levenshtein', () => {
  it('returns 0 for identical strings', () => {
    expect(levenshtein('abc', 'abc')).toBe(0);
  });

  it('returns length when one string is empty', () => {
    expect(levenshtein('', 'abc')).toBe(3);
    expect(levenshtein('abc', '')).toBe(3);
  });

  it('counts single insertion', () => {
    expect(levenshtein('abc', 'abcd')).toBe(1);
  });

  it('counts single deletion', () => {
    expect(levenshtein('abcd', 'abc')).toBe(1);
  });

  it('counts single substitution', () => {
    expect(levenshtein('abc', 'abd')).toBe(1);
  });

  it('counts transposition as two edits (substitutions)', () => {
    // Plain Levenshtein (not Damerau-Levenshtein) — swapping adjacent
    // chars counts as 2 ops, not 1.
    expect(levenshtein('ab', 'ba')).toBe(2);
  });

  it('handles mixed insertions, deletions, and substitutions', () => {
    expect(levenshtein('kitten', 'sitting')).toBe(3); // classic textbook example
  });

  it('is symmetric: d(a,b) === d(b,a)', () => {
    expect(levenshtein('hello', 'world')).toBe(levenshtein('world', 'hello'));
  });

  it('is case-sensitive (no implicit folding)', () => {
    expect(levenshtein('Alice', 'alice')).toBe(1);
  });
});
