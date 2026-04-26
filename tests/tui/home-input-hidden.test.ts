/**
 * #306 follow-up: Hide the chat input on the home view.
 *
 * The HomeView is a wizard/picker (arrow keys to navigate, Enter to select
 * a row). It owns Enter via its own `useInput` hook. Before this fix the
 * App also rendered PromptArea below the home view, which had two failure
 * modes:
 *
 *   1. There was no ensemble to chat with — the input had no target, so
 *      typing into it produced confusing "no active ensemble" notifications.
 *   2. PromptArea's `useInput` consumed Enter alongside HomeView's, so a
 *      single keystroke fired both the empty-buffer submit AND the row
 *      selection. Double action, very confusing.
 *
 * The Splash phase already follows the right pattern — it short-circuits the
 * main render and produces no PromptArea at all. Home now mirrors that.
 *
 * These tests pin the pure-logic guard (`isHomeView`) and the FOOTER_LINES
 * accounting that depends on it, without needing to render Ink.
 */
import { describe, it, expect } from 'vitest';
import { initialState, type TuiState } from '../../src/tui/store';
import { isHomeView } from '../../src/tui/App';

function seed(overrides: Partial<TuiState> = {}): TuiState {
  return { ...initialState('demo'), ...overrides };
}

describe('isHomeView (#306) — render guard for PromptArea', () => {
  it('returns true when phase=main AND view=home', () => {
    expect(isHomeView(seed({ phase: 'main', view: 'home' }))).toBe(true);
  });

  it('returns false on the splash phase even if view is still "home"', () => {
    // Splash bypasses the main render entirely with its own short-circuit;
    // isHomeView must NOT also fire there or the home guard would
    // double-toggle and we'd lose the splash's no-prompt behaviour.
    expect(isHomeView(seed({ phase: 'splash', view: 'home' }))).toBe(false);
  });

  it('returns false on the ensemble view', () => {
    // Once the user picks an ensemble, view flips to "ensemble" and the
    // chat input becomes a valid target — must render normally.
    expect(isHomeView(seed({ phase: 'main', view: 'ensemble' }))).toBe(false);
  });

  it('returns false on the player detail view', () => {
    expect(isHomeView(seed({ phase: 'main', view: 'player' }))).toBe(false);
  });

  it('returns false during wizard phases (recruit, schedule-create, create-ensemble)', () => {
    // Wizards have their own keyboard handling and the App's render branch
    // returns early to render the wizard. The PromptArea guard does not
    // need to fire — but the home check must still report false so the
    // calling code does not subtract prompt rows from FOOTER_LINES twice.
    expect(isHomeView(seed({ phase: 'recruit', view: 'home' }))).toBe(false);
    expect(isHomeView(seed({ phase: 'schedule-create', view: 'home' }))).toBe(false);
    expect(isHomeView(seed({ phase: 'create-ensemble', view: 'home' }))).toBe(false);
  });

  it('returns false on the chat phase (per-player chat target)', () => {
    expect(isHomeView(seed({ phase: 'chat', view: 'ensemble' }))).toBe(false);
  });

  it('returns false on the error phase', () => {
    expect(isHomeView(seed({ phase: 'error', view: 'home' }))).toBe(false);
  });

  it('is a pure function — same input, same output', () => {
    const s = seed({ phase: 'main', view: 'home' });
    expect(isHomeView(s)).toBe(isHomeView(s));
  });

  it('only reads phase + view (does not depend on other state fields)', () => {
    // Sanity: dressing the state with unrelated fields must not flip the
    // guard. This pins the guard's narrow surface so future field
    // additions cannot accidentally widen it.
    const dressed = seed({
      phase: 'main',
      view: 'home',
      activeEnsemble: 'demo',
      pickerVisible: true,
      paletteVisible: true,
      confirmingStop: 'someone',
    });
    expect(isHomeView(dressed)).toBe(true);

    const dressedNot = seed({
      phase: 'main',
      view: 'ensemble',
      activeEnsemble: 'demo',
      pickerVisible: true,
      paletteVisible: true,
      confirmingStop: 'someone',
    });
    expect(isHomeView(dressedNot)).toBe(false);
  });
});
