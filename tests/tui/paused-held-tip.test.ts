/**
 * #306 follow-up: Pinned paused/held tip — render-boundary contract tests.
 *
 * `/load_lineup` flips two orthogonal flags simultaneously: `maestroPaused`
 * (drives the StatusBar `⏸ paused` segment) and `outboxLocked` per session
 * (drives the new `⊕ held` segment). Resuming requires BOTH `/play` (clears
 * pause) AND `/go` (releases held) — so the tip below the input tells the
 * user which command(s) they need to dispatch.
 *
 * These tests pin the pure-logic contract — the `pinnedTipLine` helper and
 * the `countPinnedTipLines` accounting — without rendering Ink.
 */
import { describe, it, expect } from 'vitest';
import { initialState, type TuiState } from '../../src/tui/store';
import { pinnedTipLine, countPinnedTipLines } from '../../src/tui/App';

function seed(overrides: Partial<TuiState> = {}): TuiState {
  return { ...initialState('demo'), ...overrides };
}

describe('pinnedTipLine (#306 follow-up)', () => {
  it('returns null when neither paused nor held is active', () => {
    expect(pinnedTipLine(seed())).toBeNull();
    expect(countPinnedTipLines(seed())).toBe(0);
  });

  it('emits the paused-only tip when only ensemblePaused is true', () => {
    const tip = pinnedTipLine(seed({ ensemblePaused: true }));
    expect(tip).not.toBeNull();
    expect(tip?.key).toBe('tip-paused');
    expect(tip?.text).toBe('Tip: Type /play to resume.');
  });

  it('emits the held-only tip when only ensembleHeld is true', () => {
    const tip = pinnedTipLine(seed({ ensembleHeld: true }));
    expect(tip).not.toBeNull();
    expect(tip?.key).toBe('tip-held');
    expect(tip?.text).toBe('Tip: Type /go to release held players.');
  });

  it('emits the combined tip when both flags are true', () => {
    // This is the key UX failure mode the fix addresses: a `/load_lineup`
    // flow that flips both flags simultaneously. The user must dispatch
    // BOTH commands to fully resume; a single-command tip would mislead.
    const tip = pinnedTipLine(seed({ ensemblePaused: true, ensembleHeld: true }));
    expect(tip).not.toBeNull();
    expect(tip?.key).toBe('tip-paused-held');
    expect(tip?.text).toBe(
      'Tip: Type /play to unpause + /go to release held players.',
    );
  });

  it('returns null on the home view even when flags are set', () => {
    // The home view hides the prompt entirely (see `hidePrompt` in App.tsx),
    // so a tip that anchors below the prompt would be visually orphaned.
    // Reset-on-NAVIGATE_HOME also clears these flags, but defense-in-depth.
    const homeState: TuiState = {
      ...seed({ ensemblePaused: true, ensembleHeld: true }),
      activeEnsemble: null,
    };
    expect(pinnedTipLine(homeState)).toBeNull();
    expect(countPinnedTipLines(homeState)).toBe(0);
  });

  it('keys are stable so Ink can reconcile efficiently across renders', () => {
    const t1 = pinnedTipLine(seed({ ensemblePaused: true }));
    const t2 = pinnedTipLine(seed({ ensemblePaused: true }));
    expect(t1?.key).toBe(t2?.key);
  });

  it('countPinnedTipLines returns 1 when a tip is active, 0 otherwise', () => {
    expect(countPinnedTipLines(seed())).toBe(0);
    expect(countPinnedTipLines(seed({ ensemblePaused: true }))).toBe(1);
    expect(countPinnedTipLines(seed({ ensembleHeld: true }))).toBe(1);
    expect(countPinnedTipLines(seed({ ensemblePaused: true, ensembleHeld: true }))).toBe(1);
  });
});
