/**
 * Bug B: StatusBar paused indicator + reducer contract tests.
 *
 * The conductor's session-level `paused` flag gates the outbox dispatcher
 * (`canDispatch = … && !paused`), so a paused ensemble silently swallows
 * typed messages. The fix surfaces a yellow "⏸ paused" segment in the
 * StatusBar so users see why their input isn't getting a reply.
 *
 * Tests cover:
 *  - SET_ENSEMBLE_PAUSED reducer flips the flag and is identity-preserving
 *    when the value didn't change (avoids spurious StatusBar re-renders).
 *  - NAVIGATE_HOME / NAVIGATE_ENSEMBLE reset `ensemblePaused` so a stale
 *    paused-from-other-ensemble doesn't bleed across nav transitions.
 *  - buildStatusBarSegments emits the paused segment when, and ONLY when,
 *    the active-ensemble guard is satisfied — never on the home view.
 *  - The paused segment renders before the "No conductor" warning so the
 *    most actionable state reads first when both apply.
 */
import { describe, it, expect } from 'vitest';
import { initialState, tuiReducer, type TuiState } from '../../src/tui/store';
import { buildStatusBarSegments, type StatusBarProps } from '../../src/tui/components/StatusBar';
import { THEME } from '../../src/tui/utils/theme';

const PAUSED_LABEL = '⏸ paused';

function defaultProps(overrides: Partial<StatusBarProps> = {}): StatusBarProps {
  return {
    ensemble: 'demo',
    players: [],
    playersLoaded: true,
    scheduleCount: 0,
    connected: true,
    ...overrides,
  };
}

describe('SET_ENSEMBLE_PAUSED reducer (Bug B)', () => {
  it('flips ensemblePaused from false to true', () => {
    const s0 = initialState('demo');
    expect(s0.ensemblePaused).toBe(false);
    const s1 = tuiReducer(s0, { type: 'SET_ENSEMBLE_PAUSED', paused: true });
    expect(s1.ensemblePaused).toBe(true);
  });

  it('flips ensemblePaused from true to false', () => {
    const seeded: TuiState = { ...initialState('demo'), ensemblePaused: true };
    const s1 = tuiReducer(seeded, { type: 'SET_ENSEMBLE_PAUSED', paused: false });
    expect(s1.ensemblePaused).toBe(false);
  });

  it('is identity-preserving when the value did not change', () => {
    // Required to avoid a StatusBar re-render every poll tick (the poll
    // queries isMaestroPaused on a 2s interval; without identity stability
    // the entire footer would reconcile twice per ensemble even when the
    // pause state has been quiet for hours).
    const s0 = initialState('demo');
    const s1 = tuiReducer(s0, { type: 'SET_ENSEMBLE_PAUSED', paused: false });
    expect(s1).toBe(s0);
  });

  it('NAVIGATE_HOME clears a stale ensemblePaused', () => {
    const seeded: TuiState = { ...initialState('demo'), ensemblePaused: true };
    const s1 = tuiReducer(seeded, { type: 'NAVIGATE_HOME' });
    expect(s1.ensemblePaused).toBe(false);
  });

  it('NAVIGATE_ENSEMBLE resets ensemblePaused on the new ensemble', () => {
    // Cross-ensemble navigation must not carry a stale paused flag — the
    // poll re-syncs from the new ensemble's hub on the next tick.
    const seeded: TuiState = { ...initialState('demo'), ensemblePaused: true };
    const s1 = tuiReducer(seeded, { type: 'NAVIGATE_ENSEMBLE', ensemble: 'other' });
    expect(s1.ensemblePaused).toBe(false);
    expect(s1.activeEnsemble).toBe('other');
  });
});

describe('buildStatusBarSegments paused indicator (Bug B)', () => {
  it('does NOT emit the paused segment when ensemblePaused is undefined', () => {
    const segments = buildStatusBarSegments(defaultProps());
    const texts = segments.map((s) => s.text);
    expect(texts.some((t) => t.includes('paused'))).toBe(false);
  });

  it('does NOT emit the paused segment when ensemblePaused is false', () => {
    const segments = buildStatusBarSegments(defaultProps({ ensemblePaused: false }));
    expect(segments.some((s) => s.text.includes('paused'))).toBe(false);
  });

  it('emits a yellow paused segment when ensemblePaused is true', () => {
    const segments = buildStatusBarSegments(defaultProps({ ensemblePaused: true }));
    const paused = segments.find((s) => s.text === PAUSED_LABEL);
    expect(paused).toBeDefined();
    expect(paused?.color).toBe(THEME.warning);
    expect(paused?.key).toBe('pa');
  });

  it('does NOT emit the paused segment on the home view (ensemble === null)', () => {
    // The StatusBar shows `no ensemble` on the home view; a `paused` flag
    // belongs to a specific ensemble and would be meaningless there.
    const segments = buildStatusBarSegments(defaultProps({
      ensemble: null,
      ensemblePaused: true,
    }));
    expect(segments.some((s) => s.text.includes('paused'))).toBe(false);
  });

  it('renders paused BEFORE the "No conductor" warning when both apply', () => {
    // Most-actionable-first ordering: `/play` is the obvious next step;
    // dropping `/play` should also clear the No-conductor advisory if the
    // conductor was the lone session.
    const segments = buildStatusBarSegments(defaultProps({
      ensemblePaused: true,
      conductorName: undefined, // no conductor
    }));
    const pausedIdx = segments.findIndex((s) => s.text === PAUSED_LABEL);
    const noConductorIdx = segments.findIndex((s) => s.text.includes('No conductor'));
    expect(pausedIdx).toBeGreaterThan(-1);
    expect(noConductorIdx).toBeGreaterThan(-1);
    expect(pausedIdx).toBeLessThan(noConductorIdx);
  });

  it('produces a status bar reading like `demo · 0 players · ⏸ paused · ● Connected`', () => {
    // Sanity: the concatenated text matches the user-facing layout the
    // task description sketched out.
    const segments = buildStatusBarSegments(defaultProps({
      ensemble: 'demo',
      ensemblePaused: true,
      conductorName: 'conductor', // suppress No-conductor advisory
    }));
    const concat = segments.map((s) => s.text).join('');
    expect(concat).toContain('demo');
    expect(concat).toContain('0 players');
    expect(concat).toContain(PAUSED_LABEL);
    expect(concat).toContain('Connected');
    // Order check: ensemble → players → paused → connected
    expect(concat.indexOf('demo'))
      .toBeLessThan(concat.indexOf('0 players'));
    expect(concat.indexOf('0 players'))
      .toBeLessThan(concat.indexOf(PAUSED_LABEL));
    expect(concat.indexOf(PAUSED_LABEL))
      .toBeLessThan(concat.indexOf('Connected'));
  });
});
