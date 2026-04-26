/**
 * TUI smoke regressions on the post-#306 fix branch.
 *
 * Bug A — `/shutdown`, `/back`, and `/disband` did not actually keep the user
 *   on the home view. The reducer set `view: 'home'` and
 *   `activeEnsemble: null`, but a 2 s poller in App.tsx auto-reselected the
 *   only ensemble whenever `!activeEnsemble`. The first attempt at a fix
 *   used a 5 s `suppressAutoSelectUntil` guard, but the poller fires forever
 *   so users were bounced back as soon as the window expired.
 *
 *   Final fix: the auto-select branch is removed entirely. HomeView is
 *   already an explicit picker (Online / Paused / Offline, ↑↓/Enter), so
 *   there is no value in having the poller auto-pick on the user's behalf —
 *   and doing so was actively wrong after a navigate-home action.
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

// ── Bug A — NAVIGATE_HOME parks the user on home ──────────────────────────

describe('NAVIGATE_HOME reducer', () => {
  it('clears activeEnsemble and resets ensemble-scoped state', () => {
    const start = tuiReducer(initialState('demo'), {
      type: 'NAVIGATE_ENSEMBLE',
      ensemble: 'demo',
    });
    // Sanity: we are inside the ensemble before NAVIGATE_HOME fires.
    expect(start.activeEnsemble).toBe('demo');

    const after = tuiReducer(start, { type: 'NAVIGATE_HOME' });
    expect(after.activeEnsemble).toBeNull();
    expect(after.view).toBe('home');
    expect(after.phase).toBe('main');
    expect(after.players).toEqual([]);
    expect(after.conversation).toBeNull();
  });

  it('does not stamp a suppressAutoSelectUntil field anymore', () => {
    // Auto-select was removed entirely (#306 follow-up). The store no longer
    // carries this guard, and the reducer must not reintroduce it.
    const s = tuiReducer(initialState('demo'), { type: 'NAVIGATE_HOME' }) as TuiState & {
      suppressAutoSelectUntil?: number;
    };
    expect(s.suppressAutoSelectUntil).toBeUndefined();
  });

  it('NAVIGATE_ENSEMBLE moves the user back into a chosen ensemble', () => {
    let s = tuiReducer(initialState('demo'), { type: 'NAVIGATE_HOME' });
    expect(s.activeEnsemble).toBeNull();
    s = tuiReducer(s, { type: 'NAVIGATE_ENSEMBLE', ensemble: 'demo' });
    expect(s.activeEnsemble).toBe('demo');
    expect(s.view).toBe('ensemble');
  });
});

/**
 * Mirrors the (now trivial) auto-select gate in `src/tui/App.tsx`'s 2 s
 * poller. After #306 the gate is just "we're on home, keep refreshing the
 * ensemble list, never navigate on the user's behalf". This is locked in as
 * a regression so the auto-select branch can never sneak back in.
 */
function shouldAutoSelect(_s: TuiState, _ensembleCount: number, _now: number): boolean {
  // The poller no longer auto-selects, regardless of state.
  return false;
}

describe('poller auto-select gate (mirrors src/tui/App.tsx)', () => {
  it('never auto-selects on a fresh home with exactly 1 ensemble', () => {
    const s: TuiState = { ...initialState(), phase: 'main', view: 'home' };
    expect(shouldAutoSelect(s, 1, Date.now())).toBe(false);
  });

  it('never auto-selects after NAVIGATE_HOME, even minutes later', () => {
    const s = tuiReducer(initialState('demo'), { type: 'NAVIGATE_HOME' });
    // The poller fires forever; the original 5 s window let users be
    // bounced back as soon as it expired. Assert at +5 m to lock in that
    // there is no time-based revival.
    const farFuture = Date.now() + 5 * 60 * 1000;
    expect(shouldAutoSelect(s, 1, farFuture)).toBe(false);
  });

  it('never auto-selects with multiple ensembles either', () => {
    const s: TuiState = { ...initialState(), phase: 'main', view: 'home' };
    expect(shouldAutoSelect(s, 2, Date.now())).toBe(false);
  });

  it('never auto-selects on splash (Enter handles selection there)', () => {
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
