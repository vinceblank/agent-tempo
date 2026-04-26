/**
 * Unit tests for the TUI reducer — state-identity and transition correctness.
 * See src/tui/store.ts. Issue #105, Phase 1.
 *
 * Per CLAUDE.md's "Reducer state identity matters" rule:
 * returning `{ ...state, field: sameValue }` creates a new object reference
 * and triggers a re-render even when nothing changed. These tests lock in
 * no-op identity for the transitions that have been hardened.
 */
import { describe, it, expect } from 'vitest';
import { initialState, tuiReducer, type TuiAction, type TuiState } from '../../src/tui/store';
import type { MaestroPlayerInfo } from '../../src/types';

function s0(): TuiState {
  return initialState('demo');
}

describe('tuiReducer — no-op identity', () => {
  it('unknown action returns the same state reference', () => {
    const s = s0();
    const out = tuiReducer(s, { type: 'NOT_A_REAL_ACTION' } as unknown as TuiAction);
    expect(out).toBe(s);
  });

  it('HIDE_OVERLAY returns same reference when already hidden', () => {
    const s = s0();
    expect(s.overlay).toBeNull();
    const out = tuiReducer(s, { type: 'HIDE_OVERLAY' });
    expect(out).toBe(s);
  });

  it('OVERLAY_SELECT returns same reference when selection cannot change', () => {
    // Overlay with a single item — up/down cycling lands on the same index.
    const s: TuiState = {
      ...s0(),
      overlay: {
        type: 'command',
        title: 'Test',
        items: [{ id: '1', label: 'only' }],
        selectedIndex: 0,
        hint: 'esc',
      },
    };
    const out = tuiReducer(s, { type: 'OVERLAY_SELECT', direction: 'down' });
    expect(out).toBe(s);
  });

  it('PLAYER_SCROLL_UP at offset 0 returns same reference', () => {
    const s: TuiState = { ...s0(), playerScrollOffset: 0 };
    const out = tuiReducer(s, { type: 'PLAYER_SCROLL_UP' });
    expect(out).toBe(s);
  });

  it('PLAYER_SCROLL_DOWN at max returns same reference', () => {
    // With no player messages, maxScroll = 0, offset can't advance.
    const s: TuiState = { ...s0(), playerMessages: [], playerScrollOffset: 0 };
    const out = tuiReducer(s, { type: 'PLAYER_SCROLL_DOWN' });
    expect(out).toBe(s);
  });

  it('SHOW_PALETTE when already visible at index 0 returns same reference', () => {
    const s: TuiState = { ...s0(), paletteVisible: true, paletteIndex: 0 };
    const out = tuiReducer(s, { type: 'SHOW_PALETTE' });
    expect(out).toBe(s);
  });

  it('HIDE_PALETTE when already hidden at index 0 returns same reference', () => {
    const s = s0();
    expect(s.paletteVisible).toBe(false);
    expect(s.paletteIndex).toBe(0);
    const out = tuiReducer(s, { type: 'HIDE_PALETTE' });
    expect(out).toBe(s);
  });

  // ── Identity-rule assertions (fixed in #108) ──
  // Before #108, PALETTE_UP/DOWN always returned `{ ...state, paletteIndex: next }`
  // even when `next === state.paletteIndex`, forcing a full re-render on every
  // arrow-key repeat at the top (or clamped bottom) of the palette. These tests
  // pin the OVERLAY_SELECT-style identity-preserving pattern — if a future edit
  // reintroduces the spread-always form, `expect(out).toBe(s)` will fail.
  it('PALETTE_UP at index 0 returns the same reference (identity rule)', () => {
    const s = { ...s0(), paletteIndex: 0 };
    const out = tuiReducer(s, { type: 'PALETTE_UP' });
    expect(out).toBe(s);
  });

  it('PALETTE_UP above index 0 produces a new state with decremented index', () => {
    const s = { ...s0(), paletteIndex: 3 };
    const out = tuiReducer(s, { type: 'PALETTE_UP' });
    expect(out).not.toBe(s);
    expect(out.paletteIndex).toBe(2);
  });

  it('PALETTE_DOWN at clamped max returns the same reference (identity rule)', () => {
    const s = { ...s0(), paletteIndex: 5 };
    const out = tuiReducer(s, { type: 'PALETTE_DOWN', max: 5 });
    expect(out).toBe(s);
  });

  it('PALETTE_DOWN below clamped max produces a new state with incremented index', () => {
    const s = { ...s0(), paletteIndex: 2 };
    const out = tuiReducer(s, { type: 'PALETTE_DOWN', max: 5 });
    expect(out).not.toBe(s);
    expect(out.paletteIndex).toBe(3);
  });

  // ── Identity-rule assertions (fixed in #244) ──
  // STATUS_SCROLL_UP and PICKER_UP both used `Math.max(0, ...)` spread with no
  // identity guard, returning `{ ...state, ... }` even when already at 0. The
  // fix mirrors the OVERLAY_SELECT / PALETTE_UP pattern.
  it('STATUS_SCROLL_UP at offset 0 returns the same reference (identity rule)', () => {
    const s = { ...s0(), statusScrollOffset: 0 };
    const out = tuiReducer(s, { type: 'STATUS_SCROLL_UP' });
    expect(out).toBe(s);
  });

  it('STATUS_SCROLL_UP above offset 0 produces a new state with decremented offset', () => {
    const s = { ...s0(), statusScrollOffset: 3 };
    const out = tuiReducer(s, { type: 'STATUS_SCROLL_UP' });
    expect(out).not.toBe(s);
    expect(out.statusScrollOffset).toBe(2);
  });

  // #250 design-contract pin: STATUS_SCROLL_DOWN intentionally does NOT
  // upper-bound the offset in the reducer — the max depends on
  // `players.length` + `contentHeight`, both invisible to the reducer.
  // `StatusOverlay` clamps at render time via `Math.min(scrollOffset, max)`.
  // This test fails if someone adds an upper-bound clamp here without also
  // updating the render layer and the action shape.
  it('STATUS_SCROLL_DOWN always increments (render layer owns the upper-bound clamp)', () => {
    const s = { ...s0(), statusScrollOffset: 9_999 };
    const out = tuiReducer(s, { type: 'STATUS_SCROLL_DOWN' });
    expect(out).not.toBe(s);
    expect(out.statusScrollOffset).toBe(10_000);
  });

  it('PICKER_UP at index 0 returns the same reference (identity rule)', () => {
    const s = { ...s0(), pickerIndex: 0 };
    const out = tuiReducer(s, { type: 'PICKER_UP' });
    expect(out).toBe(s);
  });

  it('PICKER_UP above index 0 produces a new state with decremented index', () => {
    const s = { ...s0(), pickerIndex: 4 };
    const out = tuiReducer(s, { type: 'PICKER_UP' });
    expect(out).not.toBe(s);
    expect(out.pickerIndex).toBe(3);
  });
});

describe('tuiReducer — state transitions', () => {
  it('SET_PHASE updates phase and clears error when omitted', () => {
    const s = { ...s0(), error: 'old error' };
    const out = tuiReducer(s, { type: 'SET_PHASE', phase: 'main' });
    expect(out.phase).toBe('main');
    expect(out.error).toBeUndefined();
  });

  it('REFRESH_ENSEMBLE_DATA populates players without re-ordering subsequent actions', () => {
    // Calling REFRESH_ENSEMBLE_DATA twice with the same order should preserve player order.
    const players: MaestroPlayerInfo[] = [
      { playerId: 'alice', ensemble: 'demo', part: '', hostname: '', workDir: '', isConductor: false, agentType: 'claude' },
      { playerId: 'bob', ensemble: 'demo', part: '', hostname: '', workDir: '', isConductor: false, agentType: 'claude' },
    ];
    const s1 = tuiReducer(s0(), {
      type: 'REFRESH_ENSEMBLE_DATA',
      players,
      messages: [],
      history: [],
    });
    expect(s1.players.map((p) => p.playerId)).toEqual(['alice', 'bob']);
    expect(s1.playersLoaded).toBe(true);

    const s2 = tuiReducer(s1, {
      type: 'REFRESH_ENSEMBLE_DATA',
      players,
      messages: [],
      history: [],
    });
    expect(s2.players.map((p) => p.playerId)).toEqual(['alice', 'bob']);
  });

  it('REFRESH_ENSEMBLE_DATA clamps selectedPlayerIndex when player count shrinks', () => {
    // Start with 3 players and selection at index 2
    const three: MaestroPlayerInfo[] = ['a', 'b', 'c'].map((id) => ({
      playerId: id, ensemble: 'demo', part: '', hostname: '', workDir: '', isConductor: false, agentType: 'claude',
    }));
    const s1 = tuiReducer({ ...s0(), selectedPlayerIndex: 2 }, {
      type: 'REFRESH_ENSEMBLE_DATA',
      players: three,
      messages: [],
      history: [],
    });
    expect(s1.selectedPlayerIndex).toBe(2);

    // Next refresh has only 1 player — selection should clamp to 0
    const one = three.slice(0, 1);
    const s2 = tuiReducer(s1, {
      type: 'REFRESH_ENSEMBLE_DATA',
      players: one,
      messages: [],
      history: [],
    });
    expect(s2.selectedPlayerIndex).toBe(0);
  });

  it('REFRESH_ENSEMBLES clamps selectedEnsembleIndex when list shrinks', () => {
    const s1 = tuiReducer({ ...s0(), selectedEnsembleIndex: 5 }, {
      type: 'REFRESH_ENSEMBLES',
      ensembles: [
        { name: 'a', playerCount: 1, hasConductor: false },
        { name: 'b', playerCount: 1, hasConductor: false },
      ],
    });
    expect(s1.selectedEnsembleIndex).toBe(1);

    // Empty list → index 0
    const s2 = tuiReducer(s1, { type: 'REFRESH_ENSEMBLES', ensembles: [] });
    expect(s2.selectedEnsembleIndex).toBe(0);
  });

  it('ENTER_CHAT / EXIT_CHAT round-trip preserves prior chat target handling', () => {
    const s1 = tuiReducer(s0(), { type: 'ENTER_CHAT', target: 'alice' });
    expect(s1.phase).toBe('chat');
    expect(s1.chatTarget).toBe('alice');
    const s2 = tuiReducer(s1, { type: 'EXIT_CHAT' });
    expect(s2.phase).toBe('main');
    expect(s2.chatTarget).toBeUndefined();
  });

  it('HYDRATE_SENT_MESSAGES dedupes the same message and returns same reference on no-op', () => {
    const msg = { to: 'alice', text: 'hi', timestamp: '2026-01-01T00:00:00.000Z' };
    const s1 = tuiReducer(s0(), { type: 'HYDRATE_SENT_MESSAGES', messages: [msg] });
    expect(s1.sentMessages).toHaveLength(1);

    // Re-hydrating the same message should NOT duplicate — and should return same reference.
    const s2 = tuiReducer(s1, { type: 'HYDRATE_SENT_MESSAGES', messages: [msg] });
    expect(s2).toBe(s1);
    expect(s2.sentMessages).toHaveLength(1);
  });

  it('APPEND_SENT_MESSAGE caps the sentMessages buffer at 200', () => {
    let s: TuiState = s0();
    for (let i = 0; i < 205; i++) {
      s = tuiReducer(s, { type: 'APPEND_SENT_MESSAGE', to: 'alice', text: `msg-${i}` });
    }
    expect(s.sentMessages.length).toBe(200);
    // Oldest messages dropped; the last one is present.
    expect(s.sentMessages[s.sentMessages.length - 1].text).toBe('msg-204');
  });

  it('COMMIT_STATIC caps the staticItems buffer at 500', () => {
    let s: TuiState = s0();
    for (let i = 0; i < 505; i++) {
      s = tuiReducer(s, {
        type: 'COMMIT_STATIC',
        item: { id: `i-${i}`, type: 'info', content: `entry-${i}`, timestamp: i },
      });
    }
    expect(s.staticItems.length).toBe(500);
    expect(s.staticItems[s.staticItems.length - 1].content).toBe('entry-504');
  });
});

// ── #94/#95 PR-4a — SSE event stream incremental updates ──

describe('tuiReducer — SSE incremental actions', () => {
  function makePlayer(playerId: string, overrides: Partial<MaestroPlayerInfo> = {}): MaestroPlayerInfo {
    return {
      playerId,
      ensemble: 'demo',
      part: '',
      hostname: 'host-1',
      workDir: '/work',
      isConductor: false,
      agentType: 'claude',
      ...overrides,
    };
  }

  it('UPSERT_PLAYER inserts when playerId is unknown and sets playersLoaded', () => {
    const s = s0();
    expect(s.playersLoaded).toBe(false);
    const out = tuiReducer(s, { type: 'UPSERT_PLAYER', player: makePlayer('alice') });
    expect(out.players.map((p) => p.playerId)).toEqual(['alice']);
    expect(out.playersLoaded).toBe(true);
  });

  it('UPSERT_PLAYER merges fields onto an existing entry', () => {
    const s: TuiState = { ...s0(), players: [makePlayer('alice', { phase: 'attached' })] };
    const out = tuiReducer(s, {
      type: 'UPSERT_PLAYER',
      player: makePlayer('alice', { phase: 'awaiting' }),
    });
    expect(out.players).toHaveLength(1);
    expect(out.players[0].phase).toBe('awaiting');
  });

  it('UPSERT_PLAYER returns same reference when nothing changed (no-op identity)', () => {
    const existing = makePlayer('alice', { phase: 'attached', part: 'x' });
    const s: TuiState = { ...s0(), players: [existing] };
    const out = tuiReducer(s, {
      type: 'UPSERT_PLAYER',
      player: { ...existing },
    });
    expect(out).toBe(s);
  });

  it('REMOVE_PLAYER drops the matching player and clamps selectedPlayerIndex', () => {
    const s: TuiState = {
      ...s0(),
      players: [makePlayer('alice'), makePlayer('bob'), makePlayer('carol')],
      selectedPlayerIndex: 2,
    };
    const out = tuiReducer(s, { type: 'REMOVE_PLAYER', playerId: 'carol' });
    expect(out.players.map((p) => p.playerId)).toEqual(['alice', 'bob']);
    expect(out.selectedPlayerIndex).toBe(1);
  });

  it('REMOVE_PLAYER returns same reference when playerId is not present', () => {
    const s: TuiState = { ...s0(), players: [makePlayer('alice')] };
    const out = tuiReducer(s, { type: 'REMOVE_PLAYER', playerId: 'ghost' });
    expect(out).toBe(s);
  });

  it('SET_SCHEDULES replaces the schedules slice', () => {
    const s = s0();
    const schedules = [{
      name: 'nightly',
      target: 'alice',
      message: 'tick',
      schedType: 'cron' as const,
      cron: '0 0 * * *',
      tz: 'UTC',
      nextFire: '2026-04-27T00:00:00Z',
    }];
    const out = tuiReducer(s, { type: 'SET_SCHEDULES', schedules });
    expect(out.schedules).toBe(schedules);
  });

  it('APPEND_CHAT_MESSAGE pushes onto ensembleChat and conversation', () => {
    const s = s0();
    const m = {
      id: 'm1',
      from: 'alice',
      to: 'maestro',
      text: 'hello',
      timestamp: '2026-04-26T12:00:00Z',
      role: 'maestro-in' as const,
    };
    const out = tuiReducer(s, { type: 'APPEND_CHAT_MESSAGE', message: m });
    expect(out.ensembleChat).toHaveLength(1);
    expect(out.ensembleChat[0].id).toBe('m1');
    expect(out.conversation).toHaveLength(1);
    expect(out.conversation![0].direction).toBe('in');
  });

  it('APPEND_CHAT_MESSAGE caps both ensembleChat and conversation at 500', () => {
    let s: TuiState = s0();
    for (let i = 0; i < 505; i++) {
      s = tuiReducer(s, {
        type: 'APPEND_CHAT_MESSAGE',
        message: {
          id: `m-${i}`,
          from: 'alice',
          to: 'maestro',
          text: `t-${i}`,
          timestamp: '2026-04-26T12:00:00Z',
          role: 'maestro-in',
        },
      });
    }
    expect(s.ensembleChat).toHaveLength(500);
    expect(s.conversation).toHaveLength(500);
    expect(s.ensembleChat[s.ensembleChat.length - 1].id).toBe('m-504');
  });
});
