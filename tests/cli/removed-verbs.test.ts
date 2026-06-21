/**
 * Unit tests for the removed-verb lookup table (#288 / design #285).
 *
 * The breaking-change posture of #285 removed ten CLI verbs with no alias
 * period. Each removed verb should produce a friendly error pointing at
 * the command-center board equivalent instead of silently hitting the
 * default "Unknown command" branch.
 *
 * #432 promoted `pause` from a removed verb to a dev-mode-live verb (see
 * `src/cli/dev-verbs.ts`). The row was deleted from REMOVED_VERBS in the
 * same PR so the verb's "live in dev mode" status is single-sourced.
 *
 * #789 deleted the Ink TUI and added `tui` to the table (a bare `agent-tempo`
 * now lands on status + hints) and repointed every hint from "Use the TUI" to
 * "Use the command-center board" — the TUI's parity replacement. The table now
 * enumerates ten verbs.
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
  // `pause` removed from this list by #432 — promoted to a dev-mode verb.
  'resume',
  // `tui` added by #789 — the Ink TUI was deleted; a bare `agent-tempo` now
  // lands on status + hints, and `agent-tempo tui` gets a migration hint.
  'tui',
];

describe('REMOVED_VERBS', () => {
  it('enumerates the ten verbs still removed (post-#432 pause→dev-mode; post-#789 tui added)', () => {
    expect(Object.keys(REMOVED_VERBS).sort()).toEqual([...EXPECTED_VERBS].sort());
  });

  it('names a board equivalent for every removed verb', () => {
    for (const verb of EXPECTED_VERBS) {
      expect(REMOVED_VERBS[verb], `verb "${verb}" missing hint`).toBeTruthy();
    }
  });

  it('does NOT include `pause` (promoted to dev-mode-live in #432)', () => {
    // Mirrors the cross-surface invariant tested in
    // `test/cli-dev-verbs.test.ts` (DEV_VERBS ↔ REMOVED_VERBS) — `pause`
    // is now in `DEV_VERBS`, so it must be absent from this table.
    expect(REMOVED_VERBS).not.toHaveProperty('pause');
  });
});

describe('removedVerbMessage', () => {
  it('includes the verb, the board equivalent, and the #285 link', () => {
    for (const verb of EXPECTED_VERBS) {
      const msg = removedVerbMessage(verb);
      expect(msg).toContain(`"${verb}"`);
      expect(msg).toContain('Use the command-center board');
      expect(msg).toContain('agent-tempo command-center → ');
      expect(msg).toContain(REMOVED_VERBS[verb]);
      expect(msg).toContain('github.com/vinceblank/agent-tempo/issues/285');
    }
  });

  it('points `resume` at the new `/play` verb (renamed from `/resume` to avoid colliding with `claude --resume`)', () => {
    expect(removedVerbMessage('resume')).toContain('/play');
  });
});
