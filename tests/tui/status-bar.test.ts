/**
 * Bug B: StatusBar paused indicator + reducer contract tests.
 *
 * The conductor's session-level `paused` flag gates the outbox dispatcher
 * (`canDispatch = … && !paused`), so a paused ensemble silently swallows
 * typed messages. The fix surfaces a yellow "⏸ paused" segment in the
 * StatusBar so users see why their input isn't getting a reply.
 *
 * #306 follow-up extends coverage to the held indicator. `outboxLocked`
 * is orthogonal to the maestro-paused flag — `/load_lineup` flips both
 * at once but `/play` only clears pause. Without surfacing held alongside
 * paused (and with a combined glyph when both apply), users would unpause
 * an ensemble and watch every player stay frozen.
 *
 * Tests cover:
 *  - SET_ENSEMBLE_PAUSED / SET_ENSEMBLE_HELD reducers flip their flag and
 *    are identity-preserving when the value didn't change (avoids spurious
 *    StatusBar re-renders).
 *  - NAVIGATE_HOME / NAVIGATE_ENSEMBLE reset both flags so stale
 *    paused/held from another ensemble doesn't bleed across nav.
 *  - buildStatusBarSegments emits the paused/held segment when, and ONLY
 *    when, the active-ensemble guard is satisfied — never on home.
 *  - paused-only, held-only, both, and neither yield distinct segment
 *    labels (`⏸ paused`, `⊕ held`, `⏸⊕ paused + held`, none).
 *  - The paused/held segment renders before the "No conductor" warning so
 *    the most actionable state reads first when both apply.
 */
import { describe, it, expect } from 'vitest';
import { initialState, tuiReducer, type TuiState } from '../../src/tui/store';
import { buildStatusBarSegments, type StatusBarProps } from '../../src/tui/components/StatusBar';
import { THEME } from '../../src/tui/utils/theme';
import type { MaestroPlayerInfo } from '../../src/types';

const PAUSED_LABEL = '⏸ paused';
const HELD_LABEL = '⊕ held';
const COMBINED_LABEL = '⏸⊕ paused + held';

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

/**
 * #358: helper for tests that need a conductor in the `players` array. The
 * StatusBar derives the badge from `players.some(p => p.isConductor)` rather
 * than a separate cached field, so a player entry with `isConductor: true`
 * is the new equivalent of the old `conductorName: 'conductor'` prop.
 */
function makeConductor(playerId = 'conductor'): MaestroPlayerInfo {
  return {
    playerId,
    ensemble: 'demo',
    part: 'Conductor',
    hostname: 'host',
    workDir: '/tmp',
    isConductor: true,
    agentType: 'claude',
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

describe('SET_ENSEMBLE_HELD reducer (#306 follow-up)', () => {
  it('flips ensembleHeld from false to true', () => {
    const s0 = initialState('demo');
    expect(s0.ensembleHeld).toBe(false);
    const s1 = tuiReducer(s0, { type: 'SET_ENSEMBLE_HELD', held: true });
    expect(s1.ensembleHeld).toBe(true);
  });

  it('flips ensembleHeld from true to false', () => {
    const seeded: TuiState = { ...initialState('demo'), ensembleHeld: true };
    const s1 = tuiReducer(seeded, { type: 'SET_ENSEMBLE_HELD', held: false });
    expect(s1.ensembleHeld).toBe(false);
  });

  it('is identity-preserving when the value did not change', () => {
    // Same rationale as SET_ENSEMBLE_PAUSED — the held poll runs every 2s
    // and would otherwise force a StatusBar reconcile every tick even when
    // nothing changed.
    const s0 = initialState('demo');
    const s1 = tuiReducer(s0, { type: 'SET_ENSEMBLE_HELD', held: false });
    expect(s1).toBe(s0);
  });

  it('NAVIGATE_HOME clears a stale ensembleHeld', () => {
    const seeded: TuiState = { ...initialState('demo'), ensembleHeld: true };
    const s1 = tuiReducer(seeded, { type: 'NAVIGATE_HOME' });
    expect(s1.ensembleHeld).toBe(false);
  });

  it('NAVIGATE_ENSEMBLE resets ensembleHeld on the new ensemble', () => {
    const seeded: TuiState = { ...initialState('demo'), ensembleHeld: true };
    const s1 = tuiReducer(seeded, { type: 'NAVIGATE_ENSEMBLE', ensemble: 'other' });
    expect(s1.ensembleHeld).toBe(false);
    expect(s1.activeEnsemble).toBe('other');
  });

  it('paused and held are independent — flipping one does not touch the other', () => {
    // Critical orthogonality contract: `/load_lineup` flips both, `/pause`
    // flips only paused, `/recruit --held` flips only held. The reducer
    // must preserve this independence.
    const s0 = initialState('demo');
    const s1 = tuiReducer(s0, { type: 'SET_ENSEMBLE_PAUSED', paused: true });
    expect(s1.ensemblePaused).toBe(true);
    expect(s1.ensembleHeld).toBe(false);
    const s2 = tuiReducer(s1, { type: 'SET_ENSEMBLE_HELD', held: true });
    expect(s2.ensemblePaused).toBe(true);
    expect(s2.ensembleHeld).toBe(true);
    const s3 = tuiReducer(s2, { type: 'SET_ENSEMBLE_PAUSED', paused: false });
    expect(s3.ensemblePaused).toBe(false);
    expect(s3.ensembleHeld).toBe(true);
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
    // #358: empty `players` array → no conductor → "⚠ No conductor" warning.
    const segments = buildStatusBarSegments(defaultProps({
      ensemblePaused: true,
      players: [],
    }));
    const pausedIdx = segments.findIndex((s) => s.text === PAUSED_LABEL);
    const noConductorIdx = segments.findIndex((s) => s.text.includes('No conductor'));
    expect(pausedIdx).toBeGreaterThan(-1);
    expect(noConductorIdx).toBeGreaterThan(-1);
    expect(pausedIdx).toBeLessThan(noConductorIdx);
  });

  it('produces a status bar reading like `demo · 1 player · ⏸ paused · ● Connected`', () => {
    // Sanity: the concatenated text matches the user-facing layout the
    // task description sketched out.
    // #358: a conductor entry in `players` suppresses the No-conductor advisory.
    const segments = buildStatusBarSegments(defaultProps({
      ensemble: 'demo',
      ensemblePaused: true,
      players: [makeConductor()],
    }));
    const concat = segments.map((s) => s.text).join('');
    expect(concat).toContain('demo');
    expect(concat).toContain('1 player');
    expect(concat).toContain(PAUSED_LABEL);
    expect(concat).toContain('Connected');
    // Order check: ensemble → players → paused → connected
    expect(concat.indexOf('demo'))
      .toBeLessThan(concat.indexOf('1 player'));
    expect(concat.indexOf('1 player'))
      .toBeLessThan(concat.indexOf(PAUSED_LABEL));
    expect(concat.indexOf(PAUSED_LABEL))
      .toBeLessThan(concat.indexOf('Connected'));
  });
});

describe('buildStatusBarSegments held + combined indicators (#306 follow-up)', () => {
  it('emits NO held/paused segment when both flags are false', () => {
    const segments = buildStatusBarSegments(defaultProps({
      ensemblePaused: false,
      ensembleHeld: false,
    }));
    const text = segments.map((s) => s.text).join('');
    expect(text).not.toContain('paused');
    expect(text).not.toContain('held');
  });

  it('emits the held-only segment when only ensembleHeld is true', () => {
    const segments = buildStatusBarSegments(defaultProps({
      ensemblePaused: false,
      ensembleHeld: true,
    }));
    const seg = segments.find((s) => s.text === HELD_LABEL);
    expect(seg).toBeDefined();
    expect(seg?.color).toBe(THEME.warning);
    expect(seg?.key).toBe('pa');
    // And NOT the paused label.
    expect(segments.some((s) => s.text === PAUSED_LABEL)).toBe(false);
    expect(segments.some((s) => s.text === COMBINED_LABEL)).toBe(false);
  });

  it('emits the paused-only segment when only ensemblePaused is true', () => {
    const segments = buildStatusBarSegments(defaultProps({
      ensemblePaused: true,
      ensembleHeld: false,
    }));
    expect(segments.some((s) => s.text === PAUSED_LABEL)).toBe(true);
    expect(segments.some((s) => s.text === HELD_LABEL)).toBe(false);
    expect(segments.some((s) => s.text === COMBINED_LABEL)).toBe(false);
  });

  it('emits the combined `paused + held` segment when both flags are true', () => {
    // The combined glyph variant scans cleaner than two adjacent yellow
    // segments, and pairs with the matching pinned tip below the input.
    const segments = buildStatusBarSegments(defaultProps({
      ensemblePaused: true,
      ensembleHeld: true,
    }));
    const seg = segments.find((s) => s.text === COMBINED_LABEL);
    expect(seg).toBeDefined();
    expect(seg?.color).toBe(THEME.warning);
    // And NOT the standalone labels.
    expect(segments.some((s) => s.text === PAUSED_LABEL)).toBe(false);
    expect(segments.some((s) => s.text === HELD_LABEL)).toBe(false);
  });

  it('does NOT emit the held segment on the home view (ensemble === null)', () => {
    const segments = buildStatusBarSegments(defaultProps({
      ensemble: null,
      ensembleHeld: true,
    }));
    expect(segments.some((s) => s.text.includes('held'))).toBe(false);
  });

  it('renders held BEFORE the "No conductor" warning when both apply', () => {
    // #358: empty `players` array → no conductor → "⚠ No conductor" warning.
    const segments = buildStatusBarSegments(defaultProps({
      ensembleHeld: true,
      players: [],
    }));
    const heldIdx = segments.findIndex((s) => s.text === HELD_LABEL);
    const noConductorIdx = segments.findIndex((s) => s.text.includes('No conductor'));
    expect(heldIdx).toBeGreaterThan(-1);
    expect(noConductorIdx).toBeGreaterThan(-1);
    expect(heldIdx).toBeLessThan(noConductorIdx);
  });
});

describe('buildStatusBarSegments conductor derivation (#358)', () => {
  it('shows "No conductor" warning when players array contains no conductor', () => {
    // The active-ensemble guard requires `ensemble && playersLoaded`. With
    // a non-empty players list and no `isConductor: true` entry, the badge
    // must surface so users see the missing-conductor state.
    const nonConductor: MaestroPlayerInfo = {
      playerId: 'tempo-eng',
      ensemble: 'demo',
      part: 'Engineer',
      hostname: 'host',
      workDir: '/tmp',
      isConductor: false,
      agentType: 'claude',
    };
    const segments = buildStatusBarSegments(defaultProps({ players: [nonConductor] }));
    expect(segments.some((s) => s.text.includes('No conductor'))).toBe(true);
  });

  it('suppresses the "No conductor" warning when a player has isConductor: true', () => {
    const segments = buildStatusBarSegments(defaultProps({ players: [makeConductor()] }));
    expect(segments.some((s) => s.text.includes('No conductor'))).toBe(false);
  });

  it('reacts to incremental UPSERT_PLAYER without a snapshot — pre-#358 regression', () => {
    // Pre-#358: the StatusBar read a separate `state.conductorName` field
    // populated only by the snapshot path. An incremental `player.added`
    // event with `isConductor: true` (routed via UPSERT_PLAYER) would NOT
    // update `conductorName`, so the badge stayed stuck on "No conductor"
    // until the next snapshot intervened.
    //
    // Post-#358: the badge derives from `state.players`, which UPSERT_PLAYER
    // updates directly. This test verifies the regression doesn't recur.
    const s0: TuiState = { ...initialState('demo'), playersLoaded: true };
    const before = buildStatusBarSegments({
      ensemble: s0.activeEnsemble,
      players: s0.players,
      playersLoaded: s0.playersLoaded,
      scheduleCount: 0,
      connected: true,
    });
    expect(before.some((seg) => seg.text.includes('No conductor'))).toBe(true);

    const s1 = tuiReducer(s0, { type: 'UPSERT_PLAYER', player: makeConductor() });
    const after = buildStatusBarSegments({
      ensemble: s1.activeEnsemble,
      players: s1.players,
      playersLoaded: s1.playersLoaded,
      scheduleCount: 0,
      connected: true,
    });
    expect(after.some((seg) => seg.text.includes('No conductor'))).toBe(false);
  });
});
