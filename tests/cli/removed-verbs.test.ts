/**
 * Unit tests for the removed-verb lookup table (#288 / design #285).
 *
 * The breaking-change posture of #285 removes ten CLI verbs with no alias
 * period. Each removed verb should produce a friendly error pointing at
 * the TUI equivalent instead of silently hitting the default "Unknown
 * command" branch.
 */
import { describe, it, expect } from 'vitest';
import { REMOVED_VERBS, removedVerbMessage } from '../../src/cli/removed-verbs';

const EXPECTED_VERBS = [
  'stop',
  'conduct',
  'start',
  'disband',
  'detach',
  'restart',
  'recruit',
  'migrate',
  'pause',
  'resume',
];

describe('REMOVED_VERBS', () => {
  it('enumerates all ten verbs removed in #288', () => {
    expect(Object.keys(REMOVED_VERBS).sort()).toEqual([...EXPECTED_VERBS].sort());
  });

  it('names a TUI equivalent for every removed verb', () => {
    for (const verb of EXPECTED_VERBS) {
      expect(REMOVED_VERBS[verb], `verb "${verb}" missing hint`).toBeTruthy();
    }
  });
});

describe('removedVerbMessage', () => {
  it('includes the verb, the TUI equivalent, and the #285 link', () => {
    for (const verb of EXPECTED_VERBS) {
      const msg = removedVerbMessage(verb);
      expect(msg).toContain(`"${verb}"`);
      expect(msg).toContain('Use the TUI');
      expect(msg).toContain('claude-tempo → ');
      expect(msg).toContain(REMOVED_VERBS[verb]);
      expect(msg).toContain('github.com/vinceblank/claude-tempo/issues/285');
    }
  });

  it('points `resume` at the new `/play` verb (renamed from `/resume` to avoid colliding with `claude --resume`)', () => {
    expect(removedVerbMessage('resume')).toContain('/play');
  });
});
