/**
 * Unit tests for `handleSseEvent` — the SSE → TUI dispatch projection.
 * See src/tui/sse-handler.ts. Issue #94/#95 PR-4a.
 *
 * The handler is a pure function over `(event, dispatch, ensemble, api)`.
 * These tests inject a recording dispatch and a stub TempoClient so the
 * mapping from each `TempoEvent` kind to the resulting reducer actions
 * can be exercised without mounting the App.
 */
import { describe, it, expect, vi } from 'vitest';
import { handleSseEvent, toMaestroPlayerInfo } from '../../src/tui/sse-handler';
import type { SseRefetchClient } from '../../src/tui/sse-handler';
import { tuiReducer, initialState, type TuiAction } from '../../src/tui/store';
import type { TempoEvent, EnsembleStateV1, PlayerSummaryV1 } from '../../src/http/event-types';
import type { EnsembleChatMessage } from '../../src/types';

// ── Helpers ───────────────────────────────────────────────────────────────

function makeRecorder(): { dispatch: (action: TuiAction) => void; actions: TuiAction[] } {
  const actions: TuiAction[] = [];
  return {
    dispatch: (action: TuiAction) => { actions.push(action); },
    actions,
  };
}

function makeStubClient(overrides: Partial<SseRefetchClient> = {}): SseRefetchClient {
  return {
    getPlayers: async () => [],
    getEnsembleChat: async () => ({ messages: [], total: 0, hasMore: false, hasConductor: false }),
    getSchedules: async () => [],
    isMaestroPaused: async () => false,
    isAnySessionHeld: async () => false,
    ...overrides,
  };
}

function chatMsg(id: string, role: EnsembleChatMessage['role'] = 'maestro-in'): EnsembleChatMessage {
  return {
    id,
    from: 'alice',
    to: 'maestro',
    text: `text-${id}`,
    timestamp: '2026-04-26T12:00:00Z',
    role,
  };
}

function playerSummary(playerId: string, overrides: Partial<PlayerSummaryV1> = {}): PlayerSummaryV1 {
  return {
    playerId,
    ensemble: 'demo',
    hostname: 'host-1',
    isConductor: false,
    agentType: 'claude',
    part: '',
    workDir: '/work',
    ...overrides,
  };
}

function snapshot(overrides: Partial<EnsembleStateV1> = {}): EnsembleStateV1 {
  return {
    v: 1,
    ensemble: 'demo',
    capturedAt: '2026-04-26T12:00:00Z',
    lastEventId: '0:0',
    state: 'online',
    hasConductor: false,
    flags: { paused: false, held: false },
    players: [],
    schedules: [],
    chat: { messages: [], total: 0, hasMore: false },
    hostProfiles: {},
    ...overrides,
  };
}

function ev<T extends TempoEvent['type']>(
  type: T,
  payload: Extract<TempoEvent, { type: T }>['payload'],
  eventId = '100:1',
): TempoEvent {
  return { v: 1, eventId, type, payload } as TempoEvent;
}

// ── Tests ─────────────────────────────────────────────────────────────────

describe('toMaestroPlayerInfo', () => {
  it('drops wire-only fields and preserves the in-memory shape', () => {
    const wire: PlayerSummaryV1 = {
      playerId: 'alice',
      ensemble: 'demo',
      hostname: 'host-1',
      isConductor: true,
      agentType: 'claude',
      playerType: 'tempo-soloist',
      phase: 'attached',
      part: 'building widgets',
      workDir: '/work',
      gitBranch: 'main',
      lastHeartbeatAt: '2026-04-26T12:00:00Z',
      processingSince: '2026-04-26T11:55:00Z',
    };
    const out = toMaestroPlayerInfo(wire);
    expect(out).toEqual({
      playerId: 'alice',
      ensemble: 'demo',
      hostname: 'host-1',
      isConductor: true,
      agentType: 'claude',
      playerType: 'tempo-soloist',
      phase: 'attached',
      part: 'building widgets',
      workDir: '/work',
      gitBranch: 'main',
    });
    // Ensure timestamps don't leak through.
    expect((out as Record<string, unknown>).lastHeartbeatAt).toBeUndefined();
    expect((out as Record<string, unknown>).processingSince).toBeUndefined();
  });
});

describe('handleSseEvent — snapshot', () => {
  it('replaces players, schedules, chat, flags, and conductor in one shot', async () => {
    const { dispatch, actions } = makeRecorder();
    const api = makeStubClient();
    const snap = snapshot({
      hasConductor: true,
      flags: { paused: true, held: false },
      players: [
        playerSummary('alice', { isConductor: true }),
        playerSummary('bob'),
      ],
      schedules: [],
      chat: {
        messages: [chatMsg('m1', 'maestro-in'), chatMsg('m2', 'maestro-out')],
        total: 2,
        hasMore: false,
      },
    });

    await handleSseEvent(ev('snapshot', snap), dispatch, 'demo', api);

    const types = actions.map((a) => a.type);
    // #358: SET_CONDUCTOR removed — conductor identity derives from
    // `players` (REFRESH_ENSEMBLE_DATA) at render time.
    expect(types).toEqual([
      'REFRESH_ENSEMBLE_DATA',
      'SET_ENSEMBLE_CHAT',
      'SET_ENSEMBLE_PAUSED',
      'SET_ENSEMBLE_HELD',
      'SET_CONVERSATION',
    ]);

    const refresh = actions[0] as Extract<TuiAction, { type: 'REFRESH_ENSEMBLE_DATA' }>;
    expect(refresh.players.map((p) => p.playerId)).toEqual(['alice', 'bob']);
    expect(refresh.schedules).toEqual([]);
    // The conductor row is preserved with isConductor: true so derived
    // views can identify it without a dedicated SET_CONDUCTOR action.
    const conductorRow = refresh.players.find((p) => p.isConductor);
    expect(conductorRow?.playerId).toBe('alice');

    const setChat = actions[1] as Extract<TuiAction, { type: 'SET_ENSEMBLE_CHAT' }>;
    expect(setChat.chat.hasConductor).toBe(true);
    expect(setChat.chat.messages).toHaveLength(2);

    const paused = actions[2] as Extract<TuiAction, { type: 'SET_ENSEMBLE_PAUSED' }>;
    expect(paused.paused).toBe(true);

    const conv = actions[4] as Extract<TuiAction, { type: 'SET_CONVERSATION' }>;
    expect(conv.conversation.map((c) => c.direction)).toEqual(['in', 'out']);
  });

  it('does not project a conductor when the snapshot has none (#358)', async () => {
    // Pre-#358: handler dispatched SET_CONDUCTOR conditionally on
    // `players.find(isConductor)`. Post-#358: the action is gone entirely;
    // the snapshot just dispatches REFRESH_ENSEMBLE_DATA and the StatusBar
    // derives the badge from `players.some(isConductor)`. This test
    // verifies the dispatched action set is the steady-state snapshot
    // sequence (no leftover conductor signal) and that the players slice
    // contains no conductor.
    const { dispatch, actions } = makeRecorder();
    const api = makeStubClient();
    const snap = snapshot({ players: [playerSummary('bob')] });
    await handleSseEvent(ev('snapshot', snap), dispatch, 'demo', api);
    const types = actions.map((a) => a.type);
    expect(types).toEqual([
      'REFRESH_ENSEMBLE_DATA',
      'SET_ENSEMBLE_CHAT',
      'SET_ENSEMBLE_PAUSED',
      'SET_ENSEMBLE_HELD',
      'SET_CONVERSATION',
    ]);
    const refresh = actions[0] as Extract<TuiAction, { type: 'REFRESH_ENSEMBLE_DATA' }>;
    expect(refresh.players.some((p) => p.isConductor)).toBe(false);
  });

  /**
   * Regression guard — issue #351. When a snapshot lands with a
   * conductor in `players[]` AND chat messages in `chat`, both must
   * leak through to the store: the conductor identity (so the StatusBar
   * doesn't show "No conductor") and the chat messages projected into
   * a conversation (so ChatView doesn't stay on "Loading messages...").
   * The bug at #351 was upstream in the wire parser, but this test
   * locks the projection contract here so a future refactor can't drop
   * either dispatch silently. Companion to the wire-level regression
   * test in `tests/client/subscribe.test.ts`.
   *
   * #358 update: the conductor identity now flows through
   * REFRESH_ENSEMBLE_DATA's `players[]` (each entry carries
   * `isConductor`) instead of a dedicated SET_CONDUCTOR action.
   */
  it('preserves conductor identity AND chat content on snapshot (#351 regression guard)', async () => {
    const { dispatch, actions } = makeRecorder();
    const api = makeStubClient();
    const snap = snapshot({
      hasConductor: true,
      players: [
        playerSummary('alice'), // non-conductor first to prove `find` works
        playerSummary('boss', { isConductor: true }),
      ],
      chat: {
        messages: [chatMsg('m1', 'maestro-in'), chatMsg('m2', 'conductor-out')],
        total: 2,
        hasMore: false,
      },
    });

    await handleSseEvent(ev('snapshot', snap), dispatch, 'demo', api);

    // The conductor must be present in REFRESH_ENSEMBLE_DATA's `players`
    // with `isConductor: true` so StatusBar's derived check does NOT
    // render "⚠ No conductor".
    const refreshAction = actions.find(
      (a): a is Extract<TuiAction, { type: 'REFRESH_ENSEMBLE_DATA' }> => a.type === 'REFRESH_ENSEMBLE_DATA',
    );
    expect(refreshAction).toBeDefined();
    const conductorRow = refreshAction!.players.find((p) => p.isConductor);
    expect(conductorRow?.playerId).toBe('boss');

    // SET_ENSEMBLE_CHAT must carry the messages and `hasConductor: true`.
    const chatAction = actions.find(
      (a): a is Extract<TuiAction, { type: 'SET_ENSEMBLE_CHAT' }> => a.type === 'SET_ENSEMBLE_CHAT',
    );
    expect(chatAction).toBeDefined();
    expect(chatAction!.chat.messages.map((m) => m.id)).toEqual(['m1', 'm2']);
    expect(chatAction!.chat.hasConductor).toBe(true);

    // SET_CONVERSATION must dispatch a non-null array so ChatView leaves
    // its "Loading messages..." placeholder. Empty arrays count — only
    // `null` keeps the loader on screen.
    const convAction = actions.find(
      (a): a is Extract<TuiAction, { type: 'SET_CONVERSATION' }> => a.type === 'SET_CONVERSATION',
    );
    expect(convAction).toBeDefined();
    expect(Array.isArray(convAction!.conversation)).toBe(true);
    expect(convAction!.conversation).toHaveLength(2);
  });
});

describe('handleSseEvent — incremental player events', () => {
  it('player.added dispatches UPSERT_PLAYER with the wire-projected shape', async () => {
    const { dispatch, actions } = makeRecorder();
    const api = makeStubClient();
    await handleSseEvent(
      ev('player.added', playerSummary('alice', { phase: 'attached' })),
      dispatch,
      'demo',
      api,
    );
    expect(actions).toHaveLength(1);
    const a = actions[0] as Extract<TuiAction, { type: 'UPSERT_PLAYER' }>;
    expect(a.type).toBe('UPSERT_PLAYER');
    expect(a.player.playerId).toBe('alice');
    expect(a.player.phase).toBe('attached');
  });

  it('player.phase_changed dispatches PATCH_PLAYER_PHASE (phase-only patch)', async () => {
    const { dispatch, actions } = makeRecorder();
    const api = makeStubClient();
    await handleSseEvent(
      ev('player.phase_changed', {
        playerId: 'alice',
        ensemble: 'demo',
        phase: 'awaiting',
        at: '2026-04-26T12:00:00Z',
      }),
      dispatch,
      'demo',
      api,
    );
    expect(actions).toHaveLength(1);
    const a = actions[0] as Extract<TuiAction, { type: 'PATCH_PLAYER_PHASE' }>;
    expect(a.type).toBe('PATCH_PLAYER_PHASE');
    expect(a.playerId).toBe('alice');
    expect(a.phase).toBe('awaiting');
  });

  /**
   * Regression — issue #351 (bug 2). Verifies the phase-only patch
   * pipeline (handler → reducer) preserves hostname/part/isConductor
   * across a phase transition. Pre-fix: `player.phase_changed` ran the
   * `player.added` projection which synthesised empty defaults that
   * the reducer's spread merge then clobbered onto real values cached
   * from the snapshot — first phase flicker would wipe the row.
   */
  it('player.phase_changed does NOT clobber hostname/part/isConductor on first transition (#351)', async () => {
    // Seed the store with a fully-populated player from a snapshot.
    let state = initialState();
    state = tuiReducer(state, {
      type: 'UPSERT_PLAYER',
      player: {
        playerId: 'alice',
        ensemble: 'demo',
        hostname: 'main-laptop',
        isConductor: true,
        agentType: 'claude',
        playerType: 'tempo-conductor',
        phase: 'attached',
        part: 'leading the band',
        workDir: '/work',
        gitBranch: 'main',
      },
    });

    // Now feed the sparse phase_changed event through the SSE handler
    // and apply the dispatched action to the reducer.
    const { dispatch, actions } = makeRecorder();
    const api = makeStubClient();
    await handleSseEvent(
      ev('player.phase_changed', {
        playerId: 'alice',
        ensemble: 'demo',
        phase: 'processing',
        at: '2026-04-26T12:00:00Z',
      }),
      dispatch,
      'demo',
      api,
    );
    expect(actions).toHaveLength(1);
    state = tuiReducer(state, actions[0]);

    const after = state.players.find((p) => p.playerId === 'alice');
    expect(after).toBeDefined();
    // Phase advanced…
    expect(after!.phase).toBe('processing');
    // …but every other field that wasn't on the wire payload survives.
    expect(after!.hostname).toBe('main-laptop');
    expect(after!.part).toBe('leading the band');
    expect(after!.isConductor).toBe(true);
    expect(after!.playerType).toBe('tempo-conductor');
    expect(after!.workDir).toBe('/work');
    expect(after!.gitBranch).toBe('main');
  });

  it('player.removed dispatches REMOVE_PLAYER', async () => {
    const { dispatch, actions } = makeRecorder();
    const api = makeStubClient();
    await handleSseEvent(
      ev('player.removed', {
        playerId: 'alice',
        ensemble: 'demo',
        removedAt: '2026-04-26T12:00:00Z',
        reason: 'destroyed',
      }),
      dispatch,
      'demo',
      api,
    );
    expect(actions).toEqual([{ type: 'REMOVE_PLAYER', playerId: 'alice' }]);
  });
});

describe('handleSseEvent — chat + flags + schedules', () => {
  it('chat.appended dispatches APPEND_CHAT_MESSAGE', async () => {
    const { dispatch, actions } = makeRecorder();
    const api = makeStubClient();
    const m = chatMsg('m1');
    await handleSseEvent(ev('chat.appended', m), dispatch, 'demo', api);
    expect(actions).toEqual([{ type: 'APPEND_CHAT_MESSAGE', message: m }]);
  });

  it('flags.changed dispatches both SET_ENSEMBLE_PAUSED and SET_ENSEMBLE_HELD', async () => {
    const { dispatch, actions } = makeRecorder();
    const api = makeStubClient();
    await handleSseEvent(
      ev('flags.changed', {
        ensemble: 'demo',
        paused: true,
        held: true,
        at: '2026-04-26T12:00:00Z',
      }),
      dispatch,
      'demo',
      api,
    );
    expect(actions.map((a) => a.type)).toEqual(['SET_ENSEMBLE_PAUSED', 'SET_ENSEMBLE_HELD']);
  });

  it('schedules.changed dispatches SET_SCHEDULES', async () => {
    const { dispatch, actions } = makeRecorder();
    const api = makeStubClient();
    await handleSseEvent(
      ev('schedules.changed', {
        ensemble: 'demo',
        schedules: [],
        at: '2026-04-26T12:00:00Z',
      }),
      dispatch,
      'demo',
      api,
    );
    expect(actions).toEqual([{ type: 'SET_SCHEDULES', schedules: [] }]);
  });
});

describe('handleSseEvent — gap recovery', () => {
  it('on `gap`, refetches the snapshot slices and dispatches REFRESH_ENSEMBLE_DATA + SET_ENSEMBLE_CHAT + flags + conversation', async () => {
    const { dispatch, actions } = makeRecorder();
    const fetchedChat = {
      messages: [chatMsg('after-gap', 'maestro-in')],
      total: 1,
      hasMore: false,
      hasConductor: false,
    };
    const getPlayers = vi.fn(async () => [{
      playerId: 'alice',
      ensemble: 'demo',
      part: '',
      hostname: 'host-1',
      workDir: '/work',
      isConductor: false,
      agentType: 'claude',
    }]);
    const getEnsembleChat = vi.fn(async () => fetchedChat);
    const getSchedules = vi.fn(async () => []);
    const isMaestroPaused = vi.fn(async () => true);
    const isAnySessionHeld = vi.fn(async () => false);
    const api: SseRefetchClient = {
      getPlayers,
      getEnsembleChat,
      getSchedules,
      isMaestroPaused,
      isAnySessionHeld,
    };

    await handleSseEvent(
      ev('gap', { from: '99:0', to: '100:0', reason: 'epoch-mismatch' }),
      dispatch,
      'demo',
      api,
    );

    expect(getPlayers).toHaveBeenCalledWith('demo');
    expect(getEnsembleChat).toHaveBeenCalledWith('demo', 0, 50);
    expect(getSchedules).toHaveBeenCalledWith('demo');
    expect(isMaestroPaused).toHaveBeenCalledWith('demo');
    expect(isAnySessionHeld).toHaveBeenCalledWith('demo');

    expect(actions.map((a) => a.type)).toEqual([
      'REFRESH_ENSEMBLE_DATA',
      'SET_ENSEMBLE_CHAT',
      'SET_ENSEMBLE_PAUSED',
      'SET_ENSEMBLE_HELD',
      'SET_CONVERSATION',
    ]);
    expect((actions[2] as { paused: boolean }).paused).toBe(true);
  });

  it('swallows recovery errors so a transient failure doesn\'t bubble up to the subscribe loop', async () => {
    const { dispatch, actions } = makeRecorder();
    const api: SseRefetchClient = {
      getPlayers: async () => { throw new Error('boom'); },
      getEnsembleChat: async () => ({ messages: [], total: 0, hasMore: false, hasConductor: false }),
      getSchedules: async () => [],
      isMaestroPaused: async () => false,
      isAnySessionHeld: async () => false,
    };
    // Suppress the expected console.error from the recovery path.
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

    await expect(handleSseEvent(
      ev('gap', { from: '99:0', to: '100:0', reason: 'epoch-mismatch' }),
      dispatch,
      'demo',
      api,
    )).resolves.toBeUndefined();
    expect(actions).toHaveLength(0);
    errSpy.mockRestore();
  });
});

describe('handleSseEvent — chat.compressed soft gap', () => {
  it('refetches only the chat slice and dispatches SET_ENSEMBLE_CHAT + SET_CONVERSATION', async () => {
    const { dispatch, actions } = makeRecorder();
    const fetchedChat = {
      messages: [chatMsg('after-compressed', 'maestro-in')],
      total: 1,
      hasMore: false,
      hasConductor: true,
    };
    const getEnsembleChat = vi.fn(async () => fetchedChat);
    const getPlayers = vi.fn(async () => []);
    const getSchedules = vi.fn(async () => []);
    const isMaestroPaused = vi.fn(async () => false);
    const isAnySessionHeld = vi.fn(async () => false);
    const api: SseRefetchClient = {
      getPlayers,
      getEnsembleChat,
      getSchedules,
      isMaestroPaused,
      isAnySessionHeld,
    };

    await handleSseEvent(
      ev('chat.compressed', { dropped: 12, since: '50:1' }),
      dispatch,
      'demo',
      api,
    );

    // Only the chat slice was re-fetched — other slices left alone.
    expect(getEnsembleChat).toHaveBeenCalledTimes(1);
    expect(getPlayers).not.toHaveBeenCalled();
    expect(getSchedules).not.toHaveBeenCalled();
    expect(isMaestroPaused).not.toHaveBeenCalled();
    expect(isAnySessionHeld).not.toHaveBeenCalled();

    expect(actions.map((a) => a.type)).toEqual(['SET_ENSEMBLE_CHAT', 'SET_CONVERSATION']);
    expect((actions[0] as { chat: { hasConductor: boolean } }).chat.hasConductor).toBe(true);
  });
});

describe('handleSseEvent — noop kinds', () => {
  it.each(['heartbeat', 'throttled', 'ensemble.created', 'ensemble.destroyed', 'host_profile.changed'] as const)(
    'event %s does not dispatch anything',
    async (kind) => {
      const { dispatch, actions } = makeRecorder();
      const api = makeStubClient();
      // Build a permissive payload — handler doesn't read it for these kinds.
      const payload = {} as never;
      await handleSseEvent({ v: 1, eventId: '1:1', type: kind, payload }, dispatch, 'demo', api);
      expect(actions).toEqual([]);
    },
  );
});
