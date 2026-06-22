/**
 * Unit tests for the removed-verb lookup table (#288 / design #285).
 *
 * The breaking-change posture of #285 removed ten CLI verbs with no alias
 * period. Each removed verb should produce a friendly error pointing at
 * the surviving operator surface instead of silently hitting the default
 * "Unknown command" branch.
 *
 * #432 promoted `pause` from a removed verb to a dev-mode-live verb (see
 * `src/cli/dev-verbs.ts`); #789 deleted the Ink TUI — hints now point at
 * the command-center (mission-control) / dashboard, and `tui` itself
 * joined the table (the whole file deletes as a unit after one 2.0
 * release, per docs/design/v2-scoping.md §C.3).
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
  // #789 — the TUI launch verb itself joined the table when the TUI died.
  'tui',
];

describe('REMOVED_VERBS', () => {
  it('enumerates the ten removed verbs (post-#432 pause promotion, post-#789 tui addition)', () => {
    expect(Object.keys(REMOVED_VERBS).sort()).toEqual([...EXPECTED_VERBS].sort());
  });

  it('names a replacement-surface hint for every removed verb', () => {
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

  it('#789: no hint points at the deleted TUI', () => {
    for (const [verb, hint] of Object.entries(REMOVED_VERBS)) {
      expect(hint, `verb "${verb}" hint still references the TUI`).not.toMatch(/\bTUI\b/);
    }
  });
});

describe('removedVerbMessage', () => {
  it('includes the verb, the replacement hint, and the #285 link', () => {
    for (const verb of EXPECTED_VERBS) {
      const msg = removedVerbMessage(verb);
      expect(msg).toContain(`"${verb}"`);
      expect(msg).toContain(REMOVED_VERBS[verb]);
      expect(msg).toContain('github.com/vinceblank/agent-tempo/issues/285');
    }
  });

  it('action verbs point at the command-center (#789 hint rewrite)', () => {
    for (const verb of ['stop', 'start', 'disband', 'detach', 'restart', 'recruit', 'migrate', 'resume']) {
      expect(removedVerbMessage(verb)).toContain('agent-tempo command-center');
    }
  });

  it('points `resume` at the new `/play` verb (renamed from `/resume` to avoid colliding with `claude --resume`)', () => {
    expect(removedVerbMessage('resume')).toContain('/play');
  });

  it('`tui` points at the status home, command-center, and dashboard', () => {
    const msg = removedVerbMessage('tui');
    expect(msg).toContain('agent-tempo command-center');
    expect(msg).toContain('agent-tempo dashboard');
  });
});
