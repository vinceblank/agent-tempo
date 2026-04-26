/**
 * #306 follow-up: Pinned confirmation prompts — render-boundary contract tests.
 *
 * When a `/destroy`, `/disband`, `/destroy <ensemble>`, or `/lineup load`
 * command enters confirmation, the y/N prompt used to live in chat scroll-back
 * via `commitStatic`. New messages would push it off-screen, leaving the user
 * staring at a frozen input. The fix replaces that scroll-back line with a
 * pinned render below the prompt area that persists exactly as long as the
 * corresponding `state.confirming*` field does (no TTL).
 *
 * These tests pin the pure-logic contract — the `pinnedConfirmationLines`
 * helper and the `FOOTER_LINES` accounting — without needing to render Ink.
 */
import { describe, it, expect } from 'vitest';
import { initialState, tuiReducer, type TuiState } from '../../src/tui/store';
import {
  pinnedConfirmationLines,
  countPinnedConfirmationLines,
} from '../../src/tui/App';

function seed(overrides: Partial<TuiState> = {}): TuiState {
  return { ...initialState('demo'), ...overrides };
}

describe('pinnedConfirmationLines (#306)', () => {
  it('returns an empty array when no confirmation state is set', () => {
    expect(pinnedConfirmationLines(seed())).toEqual([]);
    expect(countPinnedConfirmationLines(seed())).toBe(0);
  });

  it('emits a destroy-player prompt when confirmingStop is set', () => {
    const lines = pinnedConfirmationLines(seed({ confirmingStop: 'tester' }));
    expect(lines).toHaveLength(1);
    expect(lines[0].key).toBe('confirm-stop');
    expect(lines[0].text).toContain('Destroy tester');
    expect(lines[0].text).toContain('Press y to confirm');
    expect(lines[0].text).toContain('n to cancel');
  });

  it('appends the reason clause to the destroy-player prompt when present', () => {
    const lines = pinnedConfirmationLines(
      seed({ confirmingStop: 'tester', confirmingStopReason: 'stuck' }),
    );
    expect(lines[0].text).toContain('Reason: stuck.');
  });

  it('omits the reason clause when confirmingStopReason is absent', () => {
    const lines = pinnedConfirmationLines(seed({ confirmingStop: 'tester' }));
    expect(lines[0].text).not.toContain('Reason:');
  });

  it('emits a disband prompt when confirmingDisband is set', () => {
    const lines = pinnedConfirmationLines(seed({ confirmingDisband: 'my-ensemble' }));
    expect(lines).toHaveLength(1);
    expect(lines[0].key).toBe('confirm-disband');
    expect(lines[0].text).toContain('Disband ensemble "my-ensemble"');
    expect(lines[0].text).toContain('All sessions will be terminated');
    expect(lines[0].text).toContain('y to confirm');
  });

  it('emits a typed-name prompt when confirmingEnsembleDestroy is set', () => {
    const lines = pinnedConfirmationLines(
      seed({ confirmingEnsembleDestroy: { ensemble: 'prod-ens', input: '' } }),
    );
    expect(lines).toHaveLength(1);
    expect(lines[0].key).toBe('confirm-ensemble-destroy');
    expect(lines[0].text).toContain('Destroy ensemble "prod-ens"');
    // Typed-name gate — the prompt must not say "Press y"; it must ask for
    // the ensemble name. Guard against a regression to y/N phrasing.
    expect(lines[0].text).toContain('Type the ensemble name to confirm');
    expect(lines[0].text).toContain('Esc to cancel');
    expect(lines[0].text).not.toContain('Press y');
  });

  it('emits a lineup-load prompt when confirmingLineup is set', () => {
    const lines = pinnedConfirmationLines(
      seed({ confirmingLineup: { action: 'load', path: 'tempo-jam.yml', summary: 'Load lineup from: tempo-jam.yml' } }),
    );
    expect(lines).toHaveLength(1);
    expect(lines[0].key).toBe('confirm-lineup');
    expect(lines[0].text).toContain('Load lineup from: tempo-jam.yml');
    expect(lines[0].text).toContain('y to confirm');
  });

  it('stacks multiple pinned lines when several confirmation states coexist', () => {
    // Unusual but not impossible — guard against the render helper
    // dropping all but one line.
    const lines = pinnedConfirmationLines(
      seed({
        confirmingStop: 'alice',
        confirmingDisband: 'demo',
        confirmingLineup: { action: 'load', path: 'x.yml', summary: 'Load lineup from: x.yml' },
      }),
    );
    expect(lines.map(l => l.key)).toEqual([
      'confirm-stop',
      'confirm-disband',
      'confirm-lineup',
    ]);
  });

  it('keys are stable across renders so Ink can reconcile efficiently', () => {
    const lines1 = pinnedConfirmationLines(seed({ confirmingStop: 'tester' }));
    const lines2 = pinnedConfirmationLines(seed({ confirmingStop: 'tester' }));
    expect(lines1[0].key).toBe(lines2[0].key);
  });
});

describe('countPinnedConfirmationLines — FOOTER_LINES reservation (#306)', () => {
  it('returns 0 when no confirmation state is set', () => {
    expect(countPinnedConfirmationLines(seed())).toBe(0);
  });

  it('returns 1 per active confirmation state', () => {
    expect(countPinnedConfirmationLines(seed({ confirmingStop: 'x' }))).toBe(1);
    expect(countPinnedConfirmationLines(seed({ confirmingDisband: 'y' }))).toBe(1);
    expect(
      countPinnedConfirmationLines(
        seed({ confirmingEnsembleDestroy: { ensemble: 'z', input: '' } }),
      ),
    ).toBe(1);
    expect(
      countPinnedConfirmationLines(
        seed({ confirmingLineup: { action: 'load', path: 'p', summary: 's' } }),
      ),
    ).toBe(1);
  });
});

describe('CONFIRM_STOP reducer path (#306) — no scrollback line written', () => {
  // Invariant test: `handleDestroy` used to emit a `COMMIT_STATIC` action so
  // the "Press y to confirm" prompt landed in scroll-back. After #306 that
  // line is rendered from the `confirmingStop` state field instead — no
  // commitStatic. The reducer confirmation path alone should leave
  // staticItems untouched.
  it('CONFIRM_STOP sets confirmingStop without touching staticItems', () => {
    const before = initialState('demo');
    const after = tuiReducer(before, {
      type: 'CONFIRM_STOP',
      player: 'tester',
      reason: 'stuck',
    });
    expect(after.confirmingStop).toBe('tester');
    expect(after.confirmingStopReason).toBe('stuck');
    // The staticItems array must not have grown from CONFIRM_STOP alone.
    expect(after.staticItems).toEqual(before.staticItems);
  });

  it('CANCEL_STOP clears both confirmingStop and confirmingStopReason', () => {
    const seeded: TuiState = {
      ...initialState('demo'),
      confirmingStop: 'tester',
      confirmingStopReason: 'stuck',
    };
    const out = tuiReducer(seeded, { type: 'CANCEL_STOP' });
    expect(out.confirmingStop).toBeUndefined();
    expect(out.confirmingStopReason).toBeUndefined();
  });
});
