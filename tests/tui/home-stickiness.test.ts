/**
 * Two related TUI smoke regressions on the post-#306 fix branch.
 *
 * Bug A — `/shutdown` does not actually navigate to the home view.
 *   The reducer set `view: 'home'` and `activeEnsemble: null`, but the 2 s
 *   poller in App.tsx auto-reselects the only ensemble whenever
 *   `!activeEnsemble`, which immediately bounced the user back into the
 *   just-parked ensemble. Fix: NAVIGATE_HOME stamps a
 *   `suppressAutoSelectUntil` timestamp; the poller respects it.
 *
 * Bug B — Status bar player count includes the maestro session.
 *   The maestro is the TUI's own dashboard attachment, not a peer agent.
 *   Showing it in the headline ("2 players (1 active, 1 pending)") was
 *   confusing — fix is `filterRealPlayers` which strips the maestro from
 *   counts but keeps the full list available to `/players` / overlay.
 */
import { describe, it, expect } from 'vitest';
import { initialState, tuiReducer, type TuiState } from '../../src/tui/store';
import { filterRealPlayers, isMaestroPlayer } from '../../src/tui/utils/format';
import type { MaestroPlayerInfo } from '../../src/types';

function makePlayer(over: Partial<MaestroPlayerInfo>): MaestroPlayerInfo {
  return {
    playerId: over.playerId ?? 'p',
    ensemble: 'demo',
    part: '',
    hostname: 'h',
    workDir: '/tmp',
    isConductor: false,
    agentType: 'claude',
    playerType: over.playerType,
    phase: over.phase,
    ...over,
  };
}

// ── Bug A — auto-select suppression ───────────────────────────────────────

describe('NAVIGATE_HOME → suppressAutoSelectUntil', () => {
  it('stamps a future timestamp on NAVIGATE_HOME', () => {
    const before = Date.now();
    const s = tuiReducer(initialState('demo'), { type: 'NAVIGATE_HOME' });
    expect(s.suppressAutoSelectUntil).toBeDefined();
    expect(s.suppressAutoSelectUntil!).toBeGreaterThanOrEqual(before);
    // 5 s window — give a generous upper bound for slow CI.
    expect(s.suppressAutoSelectUntil!).toBeLessThanOrEqual(before + 10_000);
  });

  it('NAVIGATE_ENSEMBLE clears the suppression so the user can re-enter manually', () => {
    let s = tuiReducer(initialState('demo'), { type: 'NAVIGATE_HOME' });
    expect(s.suppressAutoSelectUntil).toBeDefined();
    s = tuiReducer(s, { type: 'NAVIGATE_ENSEMBLE', ensemble: 'demo' });
    expect(s.suppressAutoSelectUntil).toBeUndefined();
    expect(s.activeEnsemble).toBe('demo');
  });
});

/**
 * Mirrors the auto-select gate in `src/tui/App.tsx`'s 2 s poller. Hoisted
 * here so the regression is locked in even if the gate moves around.
 */
function shouldAutoSelect(s: TuiState, ensembleCount: number, now: number): boolean {
  const suppressUntil = s.suppressAutoSelectUntil ?? 0;
  return ensembleCount === 1
    && !s.activeEnsemble
    && s.phase !== 'splash'
    && now >= suppressUntil;
}

describe('poller auto-select gate (mirrors src/tui/App.tsx)', () => {
  it('auto-selects on a fresh home with exactly 1 ensemble', () => {
    const s: TuiState = { ...initialState(), phase: 'main', view: 'home' };
    expect(shouldAutoSelect(s, 1, Date.now())).toBe(true);
  });

  it('does NOT auto-select while NAVIGATE_HOME suppression is active', () => {
    const s = tuiReducer(initialState('demo'), { type: 'NAVIGATE_HOME' });
    // Same poll tick — suppression should be in effect.
    expect(shouldAutoSelect(s, 1, Date.now())).toBe(false);
  });

  it('auto-select resumes after the suppression window expires', () => {
    const s = tuiReducer(initialState('demo'), { type: 'NAVIGATE_HOME' });
    // Far future — well past the 5 s window.
    const future = (s.suppressAutoSelectUntil ?? 0) + 1;
    expect(shouldAutoSelect(s, 1, future)).toBe(true);
  });

  it('still skips auto-select when there is more than 1 ensemble', () => {
    const s: TuiState = { ...initialState(), phase: 'main', view: 'home' };
    expect(shouldAutoSelect(s, 2, Date.now())).toBe(false);
  });

  it('still skips auto-select on splash', () => {
    const s: TuiState = { ...initialState(), phase: 'splash', view: 'home' };
    expect(shouldAutoSelect(s, 1, Date.now())).toBe(false);
  });
});

// ── Bug B — maestro excluded from headline counts ─────────────────────────

describe('isMaestroPlayer / filterRealPlayers', () => {
  it('matches the maestro by playerId', () => {
    expect(isMaestroPlayer({ playerId: 'maestro' })).toBe(true);
  });

  it('matches the maestro by playerType', () => {
    expect(isMaestroPlayer({ playerId: 'someone', playerType: 'maestro' })).toBe(true);
  });

  it('does not match a regular player', () => {
    expect(isMaestroPlayer({ playerId: 'alice', playerType: 'tempo-soloist' })).toBe(false);
  });

  it('filterRealPlayers strips the maestro and preserves order', () => {
    const players = [
      makePlayer({ playerId: 'alice', playerType: 'tempo-soloist' }),
      makePlayer({ playerId: 'maestro', playerType: 'maestro' }),
      makePlayer({ playerId: 'bob', playerType: 'tempo-tuner' }),
    ];
    const real = filterRealPlayers(players);
    expect(real.map((p) => p.playerId)).toEqual(['alice', 'bob']);
  });

  it('filterRealPlayers is a no-op when there is no maestro', () => {
    const players = [
      makePlayer({ playerId: 'alice', playerType: 'tempo-soloist' }),
      makePlayer({ playerId: 'bob', playerType: 'tempo-tuner' }),
    ];
    expect(filterRealPlayers(players).length).toBe(2);
  });

  it('reproduces the user-reported "1 player" headline (was "2 players (1 pending)")', () => {
    const players = [
      makePlayer({ playerId: 'alice', playerType: 'tempo-soloist', phase: 'attached' }),
      makePlayer({ playerId: 'maestro', playerType: 'maestro', phase: 'booting' }),
    ];
    const real = filterRealPlayers(players);
    expect(real.length).toBe(1);
    expect(real[0].playerId).toBe('alice');
  });
});
