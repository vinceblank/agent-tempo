/**
 * Unit tests for the TUI reducer (src/tui/store.ts).
 *
 * Pure function tests — no Temporal, no mocks, no async. Runs in milliseconds.
 *
 * Covers:
 *   - Navigation (NAVIGATE_HOME, NAVIGATE_ENSEMBLE, NAVIGATE_PLAYER)
 *   - Player scroll (PLAYER_SCROLL_UP, PLAYER_SCROLL_DOWN)
 *   - Picker actions (SHOW_PICKER, PICKER_UP, PICKER_DOWN, HIDE_PICKER)
 *   - Command palette (SHOW_PALETTE, HIDE_PALETTE, PALETTE_UP, PALETTE_DOWN)
 *   - Reducer identity (no-op actions return same reference)
 *   - Recruit wizard step progression
 *   - Schedule wizard step progression
 */
import { expect } from 'chai';
import {
  tuiReducer,
  initialState,
  TuiState,
  TuiAction,
  RECRUIT_STEPS,
  SCHEDULE_STEPS,
  defaultRecruitAnswers,
  DEFAULT_SCHEDULE_ANSWERS,
  CREATE_ENSEMBLE_STEPS,
  DEFAULT_CREATE_ENSEMBLE_ANSWERS,
} from '../src/tui/store';
import type { MaestroPlayerInfo, SessionMetadata } from '../src/types';

function apply(state: TuiState, ...actions: TuiAction[]): TuiState {
  return actions.reduce((s, a) => tuiReducer(s, a), state);
}

function makePlayer(id: string, overrides?: Partial<MaestroPlayerInfo>): MaestroPlayerInfo {
  return {
    playerId: id,
    ensemble: 'test',
    part: '',
    hostname: 'test-host',
    workDir: '/tmp',
    isConductor: false,
    agentType: 'claude',
    ...overrides,
  };
}

// ─────────────────────────────────────────────
// Navigation
// ─────────────────────────────────────────────

describe('TUI reducer', function () {
  describe('initialState', function () {
    it('defaults to splash phase with no ensemble', function () {
      const s = initialState();
      expect(s.phase).to.equal('splash');
      expect(s.view).to.equal('home');
      expect(s.activeEnsemble).to.be.null;
    });

    it('starts in main phase when ensemble provided', function () {
      const s = initialState('my-ensemble');
      expect(s.phase).to.equal('main');
      expect(s.view).to.equal('ensemble');
      expect(s.activeEnsemble).to.equal('my-ensemble');
    });

    it('starts with null ensembles and conversation (loading state)', function () {
      const s = initialState();
      expect(s.ensembles).to.be.null;
      expect(s.conversation).to.be.null;
    });

    it('REFRESH_ENSEMBLES transitions from null to array', function () {
      const s = tuiReducer(initialState(), { type: 'REFRESH_ENSEMBLES', ensembles: [] });
      expect(s.ensembles).to.deep.equal([]);
    });
  });

  describe('NAVIGATE_HOME', function () {
    it('resets activeEnsemble and view to home', function () {
      const s = apply(initialState('test'), { type: 'NAVIGATE_HOME' });
      expect(s.view).to.equal('home');
      expect(s.activeEnsemble).to.be.null;
      expect(s.phase).to.equal('main');
    });

    it('clears players, messages, sentMessages, conversation, schedules', function () {
      let s = initialState('test');
      s = { ...s, players: [makePlayer('a')], sentMessages: [{ to: 'a', text: 'hi', timestamp: '' }], conversation: [{ id: '1', from: 'a', to: 'b', text: 'x', timestamp: '', direction: 'in' as const }], schedules: [{ name: 'x', message: '', target: '', createdBy: '', nextFireAt: '', firedCount: 0, type: 'once' }] };
      s = tuiReducer(s, { type: 'NAVIGATE_HOME' });
      expect(s.players).to.have.lengthOf(0);
      expect(s.sentMessages).to.have.lengthOf(0);
      expect(s.conversation).to.be.null;
      expect(s.schedules).to.have.lengthOf(0);
    });

    it('clears activePlayer and resets playerMessages', function () {
      let s = initialState('test');
      s = { ...s, activePlayer: 'p1', playerMessages: [{ id: '1', from: 'a', text: 'x', timestamp: '', delivered: true }] };
      s = tuiReducer(s, { type: 'NAVIGATE_HOME' });
      expect(s.activePlayer).to.be.null;
      expect(s.playerMessages).to.have.lengthOf(0);
    });

    it('clears chatTarget and conductorName', function () {
      let s = initialState('test');
      s = { ...s, chatTarget: 'player1', conductorName: 'conductor' };
      s = tuiReducer(s, { type: 'NAVIGATE_HOME' });
      expect(s.chatTarget).to.be.undefined;
      expect(s.conductorName).to.be.undefined;
    });
  });

  describe('NAVIGATE_ENSEMBLE', function () {
    it('sets activeEnsemble and switches to ensemble view', function () {
      const s = apply(initialState(), { type: 'NAVIGATE_ENSEMBLE', ensemble: 'my-ens' });
      expect(s.activeEnsemble).to.equal('my-ens');
      expect(s.view).to.equal('ensemble');
      expect(s.phase).to.equal('main');
    });

    it('clears stale data from previous ensemble', function () {
      let s = initialState('old-ens');
      s = { ...s, players: [makePlayer('a')], messages: [{ id: '1', ensemble: 'old', from: 'a', to: 'b', text: 'x', timestamp: '', direction: 'inbound' }], sentMessages: [{ to: 'a', text: 'hi', timestamp: '' }], conductorHistory: [{ type: 'command', timestamp: '', data: { text: '', source: '', timestamp: '' } }] };
      s = tuiReducer(s, { type: 'NAVIGATE_ENSEMBLE', ensemble: 'new-ens' });
      expect(s.activeEnsemble).to.equal('new-ens');
      expect(s.players).to.have.lengthOf(0);
      expect(s.messages).to.have.lengthOf(0);
      expect(s.sentMessages).to.have.lengthOf(0);
      expect(s.conductorHistory).to.have.lengthOf(0);
      expect(s.conversation).to.be.null;
    });

    it('resets selectedPlayerIndex to 0', function () {
      let s = initialState('test');
      s = { ...s, selectedPlayerIndex: 5 };
      s = tuiReducer(s, { type: 'NAVIGATE_ENSEMBLE', ensemble: 'new' });
      expect(s.selectedPlayerIndex).to.equal(0);
    });
  });

  describe('NAVIGATE_PLAYER', function () {
    it('sets activePlayer and switches to player view', function () {
      const s = apply(initialState('test'), { type: 'NAVIGATE_PLAYER', playerId: 'player-1' });
      expect(s.activePlayer).to.equal('player-1');
      expect(s.view).to.equal('player');
    });

    it('resets playerScrollOffset to 0', function () {
      let s = initialState('test');
      s = { ...s, playerScrollOffset: 10 };
      s = tuiReducer(s, { type: 'NAVIGATE_PLAYER', playerId: 'p1' });
      expect(s.playerScrollOffset).to.equal(0);
    });

    it('clears playerMetadata and playerMessages', function () {
      let s = initialState('test');
      s = { ...s, playerMetadata: { playerId: 'p1', ensemble: 'test', hostname: 'h', workDir: '/tmp', isConductor: false } as SessionMetadata, playerMessages: [{ id: '1', from: 'a', text: 'x', timestamp: '', delivered: true }] };
      s = tuiReducer(s, { type: 'NAVIGATE_PLAYER', playerId: 'p1' });
      expect(s.playerMetadata).to.be.null;
      expect(s.playerMessages).to.have.lengthOf(0);
    });

  });

  // ─────────────────────────────────────────────
  // Player scroll
  // ─────────────────────────────────────────────

  describe('PLAYER_SCROLL_UP', function () {
    it('decrements playerScrollOffset', function () {
      let s = initialState('test');
      s = { ...s, playerScrollOffset: 3 };
      s = tuiReducer(s, { type: 'PLAYER_SCROLL_UP' });
      expect(s.playerScrollOffset).to.equal(2);
    });

    it('clamps at 0', function () {
      const s = initialState('test');
      expect(s.playerScrollOffset).to.equal(0);
      const result = tuiReducer(s, { type: 'PLAYER_SCROLL_UP' });
      expect(result.playerScrollOffset).to.equal(0);
    });

    it('returns same reference when already at 0 (identity)', function () {
      const s = initialState('test');
      const result = tuiReducer(s, { type: 'PLAYER_SCROLL_UP' });
      expect(result).to.equal(s);
    });
  });

  describe('PLAYER_SCROLL_DOWN', function () {
    it('increments playerScrollOffset', function () {
      let s = initialState('test');
      // Need enough messages for scroll to work (max = messages.length - 20)
      const msgs = Array.from({ length: 30 }, (_, i) => ({ id: `${i}`, from: 'a', text: 'x', timestamp: '', delivered: true }));
      s = { ...s, playerMessages: msgs, playerScrollOffset: 0 };
      s = tuiReducer(s, { type: 'PLAYER_SCROLL_DOWN' });
      expect(s.playerScrollOffset).to.equal(1);
    });

    it('clamps at max (messages.length - 20)', function () {
      let s = initialState('test');
      const msgs = Array.from({ length: 25 }, (_, i) => ({ id: `${i}`, from: 'a', text: 'x', timestamp: '', delivered: true }));
      s = { ...s, playerMessages: msgs, playerScrollOffset: 5 }; // max = 25 - 20 = 5
      const result = tuiReducer(s, { type: 'PLAYER_SCROLL_DOWN' });
      expect(result.playerScrollOffset).to.equal(5);
    });

    it('returns same reference when at max (identity)', function () {
      let s = initialState('test');
      const msgs = Array.from({ length: 25 }, (_, i) => ({ id: `${i}`, from: 'a', text: 'x', timestamp: '', delivered: true }));
      s = { ...s, playerMessages: msgs, playerScrollOffset: 5 };
      const result = tuiReducer(s, { type: 'PLAYER_SCROLL_DOWN' });
      expect(result).to.equal(s);
    });

    it('clamps max at 0 when fewer than 20 messages', function () {
      let s = initialState('test');
      s = { ...s, playerMessages: [{ id: '1', from: 'a', text: 'x', timestamp: '', delivered: true }], playerScrollOffset: 0 };
      const result = tuiReducer(s, { type: 'PLAYER_SCROLL_DOWN' });
      expect(result).to.equal(s);
    });
  });

  // ─────────────────────────────────────────────
  // Picker actions
  // ─────────────────────────────────────────────

  describe('SHOW_PICKER', function () {
    it('shows picker with type and resets index', function () {
      const s = tuiReducer(initialState('test'), { type: 'SHOW_PICKER', pickerType: 'players' });
      expect(s.pickerVisible).to.be.true;
      expect(s.pickerType).to.equal('players');
      expect(s.pickerIndex).to.equal(0);
    });

    it('stores navigate intent', function () {
      const s = tuiReducer(initialState('test'), { type: 'SHOW_PICKER', pickerType: 'ensembles', intent: 'navigate' });
      expect(s.pickerIntent).to.equal('navigate');
    });
  });

  describe('PICKER_DOWN', function () {
    it('increments pickerIndex', function () {
      let s = initialState('test');
      s = { ...s, pickerVisible: true, pickerType: 'players', players: [makePlayer('a'), makePlayer('b'), makePlayer('c')] };
      s = tuiReducer(s, { type: 'PICKER_DOWN' });
      expect(s.pickerIndex).to.equal(1);
    });

    it('clamps at max (players.length - 1)', function () {
      let s = initialState('test');
      s = { ...s, pickerVisible: true, pickerType: 'players', players: [makePlayer('a'), makePlayer('b')], pickerIndex: 1 };
      const result = tuiReducer(s, { type: 'PICKER_DOWN' });
      expect(result.pickerIndex).to.equal(1);
    });

    it('returns same reference when at max (identity)', function () {
      let s = initialState('test');
      s = { ...s, pickerVisible: true, pickerType: 'players', players: [makePlayer('a')], pickerIndex: 0 };
      const result = tuiReducer(s, { type: 'PICKER_DOWN' });
      expect(result).to.equal(s);
    });

    it('clamps based on ensembles when pickerType is ensembles (includes __create__ item)', function () {
      let s = initialState();
      s = { ...s, pickerVisible: true, pickerType: 'ensembles', ensembles: [{ name: 'a', playerCount: 1, hasConductor: false }], pickerIndex: 0 };
      const result = tuiReducer(s, { type: 'PICKER_DOWN' });
      // 1 ensemble + 1 __create__ sentinel = 2 items, so index 0 can go to 1
      expect(result.pickerIndex).to.equal(1);
    });
  });

  describe('PICKER_UP', function () {
    it('decrements pickerIndex', function () {
      let s = initialState('test');
      s = { ...s, pickerVisible: true, pickerType: 'players', players: [makePlayer('a'), makePlayer('b')], pickerIndex: 1 };
      s = tuiReducer(s, { type: 'PICKER_UP' });
      expect(s.pickerIndex).to.equal(0);
    });

    it('clamps at 0', function () {
      let s = initialState('test');
      s = { ...s, pickerVisible: true, pickerIndex: 0 };
      s = tuiReducer(s, { type: 'PICKER_UP' });
      expect(s.pickerIndex).to.equal(0);
    });
  });

  describe('HIDE_PICKER', function () {
    it('resets picker state', function () {
      let s = initialState('test');
      s = { ...s, pickerVisible: true, pickerType: 'players', pickerIntent: 'navigate', pickerIndex: 3 };
      s = tuiReducer(s, { type: 'HIDE_PICKER' });
      expect(s.pickerVisible).to.be.false;
      expect(s.pickerType).to.be.null;
      expect(s.pickerIntent).to.be.null;
      expect(s.pickerIndex).to.equal(0);
    });
  });

  // ─────────────────────────────────────────────
  // Command palette
  // ─────────────────────────────────────────────

  describe('SHOW_PALETTE', function () {
    it('shows palette and resets index', function () {
      const s = tuiReducer(initialState('test'), { type: 'SHOW_PALETTE' });
      expect(s.paletteVisible).to.be.true;
      expect(s.paletteIndex).to.equal(0);
    });

    it('returns same reference when already visible with index 0 (identity)', function () {
      let s = initialState('test');
      s = { ...s, paletteVisible: true, paletteIndex: 0 };
      const result = tuiReducer(s, { type: 'SHOW_PALETTE' });
      expect(result).to.equal(s);
    });
  });

  describe('HIDE_PALETTE', function () {
    it('hides palette and resets index', function () {
      let s = initialState('test');
      s = { ...s, paletteVisible: true, paletteIndex: 3 };
      s = tuiReducer(s, { type: 'HIDE_PALETTE' });
      expect(s.paletteVisible).to.be.false;
      expect(s.paletteIndex).to.equal(0);
    });

    it('returns same reference when already hidden with index 0 (identity)', function () {
      const s = initialState('test');
      expect(s.paletteVisible).to.be.false;
      expect(s.paletteIndex).to.equal(0);
      const result = tuiReducer(s, { type: 'HIDE_PALETTE' });
      expect(result).to.equal(s);
    });
  });

  describe('PALETTE_UP', function () {
    it('decrements paletteIndex', function () {
      let s = initialState('test');
      s = { ...s, paletteVisible: true, paletteIndex: 2 };
      s = tuiReducer(s, { type: 'PALETTE_UP' });
      expect(s.paletteIndex).to.equal(1);
    });

    it('clamps at 0', function () {
      let s = initialState('test');
      s = { ...s, paletteVisible: true, paletteIndex: 0 };
      s = tuiReducer(s, { type: 'PALETTE_UP' });
      expect(s.paletteIndex).to.equal(0);
    });
  });

  describe('PALETTE_DOWN', function () {
    it('increments paletteIndex', function () {
      let s = initialState('test');
      s = { ...s, paletteVisible: true, paletteIndex: 0 };
      s = tuiReducer(s, { type: 'PALETTE_DOWN' });
      expect(s.paletteIndex).to.equal(1);
    });

    it('clamps at max when provided', function () {
      let s = initialState('test');
      s = { ...s, paletteVisible: true, paletteIndex: 4 };
      s = tuiReducer(s, { type: 'PALETTE_DOWN', max: 5 });
      expect(s.paletteIndex).to.equal(5);
      s = tuiReducer(s, { type: 'PALETTE_DOWN', max: 5 });
      expect(s.paletteIndex).to.equal(5); // clamped
    });
  });

  // ─────────────────────────────────────────────
  // Status overlay
  // ─────────────────────────────────────────────

  describe('Status overlay', function () {
    it('SHOW_STATUS opens overlay and resets scroll', function () {
      const s = tuiReducer(initialState('test'), { type: 'SHOW_STATUS' });
      expect(s.statusOverlay).to.be.true;
      expect(s.statusScrollOffset).to.equal(0);
    });

    it('HIDE_STATUS closes overlay and resets scroll', function () {
      let s = initialState('test');
      s = { ...s, statusOverlay: true, statusScrollOffset: 5 };
      s = tuiReducer(s, { type: 'HIDE_STATUS' });
      expect(s.statusOverlay).to.be.false;
      expect(s.statusScrollOffset).to.equal(0);
    });

    it('STATUS_SCROLL_DOWN increments', function () {
      let s = initialState('test');
      s = { ...s, statusOverlay: true, statusScrollOffset: 2 };
      s = tuiReducer(s, { type: 'STATUS_SCROLL_DOWN' });
      expect(s.statusScrollOffset).to.equal(3);
    });

    it('STATUS_SCROLL_UP decrements and clamps at 0', function () {
      let s = initialState('test');
      s = { ...s, statusOverlay: true, statusScrollOffset: 1 };
      s = tuiReducer(s, { type: 'STATUS_SCROLL_UP' });
      expect(s.statusScrollOffset).to.equal(0);
      s = tuiReducer(s, { type: 'STATUS_SCROLL_UP' });
      expect(s.statusScrollOffset).to.equal(0);
    });
  });

  // ─────────────────────────────────────────────
  // Data refresh actions
  // ─────────────────────────────────────────────

  describe('REFRESH_PLAYER_DATA', function () {
    it('stores metadata and messages', function () {
      const meta: SessionMetadata = { playerId: 'p1', ensemble: 'test', hostname: 'h', workDir: '/tmp', isConductor: false, gitBranch: 'main' };
      const msgs = [
        { id: '1', from: 'a', text: 'hello', timestamp: '2026-01-01T00:00:00Z', delivered: true },
        { id: '2', from: 'b', text: 'world', timestamp: '2026-01-01T00:01:00Z', delivered: true },
      ];
      let s = initialState('test');
      s = apply(s, { type: 'NAVIGATE_PLAYER', playerId: 'p1' });
      s = tuiReducer(s, { type: 'REFRESH_PLAYER_DATA', metadata: meta, messages: msgs });
      expect(s.playerMetadata).to.deep.equal(meta);
      expect(s.playerMessages).to.have.lengthOf(2);
    });

    it('replaces previous data on refresh', function () {
      let s = initialState('test');
      const oldMeta: SessionMetadata = { playerId: 'p1', ensemble: 'test', hostname: 'h', workDir: '/tmp', isConductor: false };
      s = { ...s, playerMetadata: oldMeta, playerMessages: [{ id: '1', from: 'a', text: 'old', timestamp: '', delivered: true }] };
      const newMeta: SessionMetadata = { playerId: 'p1', ensemble: 'test', hostname: 'h', workDir: '/tmp', isConductor: false, gitBranch: 'feat' };
      s = tuiReducer(s, { type: 'REFRESH_PLAYER_DATA', metadata: newMeta, messages: [] });
      expect(s.playerMetadata).to.deep.equal(newMeta);
      expect(s.playerMessages).to.have.lengthOf(0);
    });

    it('accepts null metadata', function () {
      const s = tuiReducer(initialState('test'), { type: 'REFRESH_PLAYER_DATA', metadata: null, messages: [] });
      expect(s.playerMetadata).to.be.null;
    });
  });

  describe('REFRESH_ENSEMBLE_DATA', function () {
    it('stores players and schedules', function () {
      const players = [makePlayer('a'), makePlayer('b')];
      const s = tuiReducer(initialState('test'), {
        type: 'REFRESH_ENSEMBLE_DATA',
        players,
        messages: [],
        history: [],
        schedules: [{ name: 'sched1', message: 'hi', target: 'a', createdBy: 'b', nextFireAt: '', firedCount: 0, type: 'interval' as const }],
      });
      expect(s.players).to.have.lengthOf(2);
      expect(s.schedules).to.have.lengthOf(1);
    });

    it('clamps selectedPlayerIndex to new player count', function () {
      let s = initialState('test');
      s = { ...s, selectedPlayerIndex: 5 };
      s = tuiReducer(s, {
        type: 'REFRESH_ENSEMBLE_DATA',
        players: [makePlayer('a'), makePlayer('b')],
        messages: [],
        history: [],
      });
      expect(s.selectedPlayerIndex).to.equal(1); // clamped to length - 1
    });

    it('preserves schedules when not provided', function () {
      let s = initialState('test');
      s = { ...s, schedules: [{ name: 'x', message: '', target: '', createdBy: '', nextFireAt: '', firedCount: 0, type: 'once' as const }] };
      s = tuiReducer(s, { type: 'REFRESH_ENSEMBLE_DATA', players: [], messages: [], history: [] });
      expect(s.schedules).to.have.lengthOf(1);
    });
  });

  describe('SET_CONVERSATION', function () {
    it('replaces conversation array', function () {
      const convo = [
        { id: '1', from: 'a', to: 'b', text: 'hi', timestamp: '2026-01-01T00:00:00Z', direction: 'in' as const },
      ];
      const s = tuiReducer(initialState('test'), { type: 'SET_CONVERSATION', conversation: convo });
      expect(s.conversation).to.deep.equal(convo);
    });
  });

  // ─────────────────────────────────────────────
  // Picker intent defaults
  // ─────────────────────────────────────────────

  describe('SHOW_PICKER intent', function () {
    it('defaults pickerIntent to null when no intent provided', function () {
      const s = tuiReducer(initialState('test'), { type: 'SHOW_PICKER', pickerType: 'players' });
      expect(s.pickerIntent).to.be.null;
    });

    it('stores navigate intent', function () {
      const s = tuiReducer(initialState('test'), { type: 'SHOW_PICKER', pickerType: 'players', intent: 'navigate' });
      expect(s.pickerIntent).to.equal('navigate');
    });

    it('HIDE_PICKER clears intent', function () {
      let s = tuiReducer(initialState('test'), { type: 'SHOW_PICKER', pickerType: 'players', intent: 'navigate' });
      s = tuiReducer(s, { type: 'HIDE_PICKER' });
      expect(s.pickerIntent).to.be.null;
    });
  });

  // ─────────────────────────────────────────────
  // Reducer identity (no-op returns same reference)
  // ─────────────────────────────────────────────

  describe('reducer identity', function () {
    it('HYDRATE_SENT_MESSAGES with no new messages returns same reference', function () {
      let s = initialState('test');
      s = { ...s, sentMessages: [{ to: 'a', text: 'hello', timestamp: '2024-01-01T00:00:00Z' }] };
      const result = tuiReducer(s, {
        type: 'HYDRATE_SENT_MESSAGES',
        messages: [{ to: 'a', text: 'hello', timestamp: '2024-01-01T00:00:00Z' }],
      });
      expect(result).to.equal(s);
    });

    it('RECRUIT_NEXT_STEP with no recruitState returns same reference', function () {
      const s = initialState('test');
      const result = tuiReducer(s, { type: 'RECRUIT_NEXT_STEP', answer: {} });
      expect(result).to.equal(s);
    });

    it('RECRUIT_PREV_STEP at first step returns same reference', function () {
      let s = apply(initialState('test'), { type: 'ENTER_RECRUIT' });
      expect(s.recruitState!.step).to.equal('name'); // first step
      const result = tuiReducer(s, { type: 'RECRUIT_PREV_STEP' });
      expect(result).to.equal(s);
    });
  });

  // ─────────────────────────────────────────────
  // Recruit wizard
  // ─────────────────────────────────────────────

  describe('Recruit wizard', function () {
    it('ENTER_RECRUIT sets phase and initial step', function () {
      const s = tuiReducer(initialState('test'), { type: 'ENTER_RECRUIT' });
      expect(s.phase).to.equal('recruit');
      expect(s.recruitState).to.exist;
      expect(s.recruitState!.step).to.equal('name');
      expect(s.recruitState!.preRecruitPhase).to.equal('main');
    });

    it('ENTER_RECRUIT merges partial answers', function () {
      const s = tuiReducer(initialState('test'), { type: 'ENTER_RECRUIT', answers: { name: 'my-player' } });
      expect(s.recruitState!.answers.name).to.equal('my-player');
      expect(s.recruitState!.answers.agent).to.equal('claude'); // default preserved
    });

    it('progresses through all steps: name → agent → type → workDir → message → host → confirm', function () {
      let s = tuiReducer(initialState('test'), { type: 'ENTER_RECRUIT' });
      expect(s.recruitState!.step).to.equal('name');

      s = tuiReducer(s, { type: 'RECRUIT_NEXT_STEP', answer: { name: 'test-player' } });
      expect(s.recruitState!.step).to.equal('agent');
      expect(s.recruitState!.answers.name).to.equal('test-player');

      s = tuiReducer(s, { type: 'RECRUIT_NEXT_STEP', answer: { agent: 'copilot' } });
      expect(s.recruitState!.step).to.equal('type');
      expect(s.recruitState!.answers.agent).to.equal('copilot');

      s = tuiReducer(s, { type: 'RECRUIT_NEXT_STEP', answer: { playerType: 'tempo-soloist' } });
      expect(s.recruitState!.step).to.equal('workDir');

      s = tuiReducer(s, { type: 'RECRUIT_NEXT_STEP', answer: { workDir: '/tmp/test' } });
      expect(s.recruitState!.step).to.equal('message');

      s = tuiReducer(s, { type: 'RECRUIT_NEXT_STEP', answer: { initialMessage: 'Build feature X' } });
      expect(s.recruitState!.step).to.equal('host');

      s = tuiReducer(s, { type: 'RECRUIT_NEXT_STEP', answer: { host: 'remote-1' } });
      expect(s.recruitState!.step).to.equal('confirm');
    });

    it('RECRUIT_PREV_STEP goes back one step', function () {
      let s = tuiReducer(initialState('test'), { type: 'ENTER_RECRUIT' });
      s = tuiReducer(s, { type: 'RECRUIT_NEXT_STEP', answer: { name: 'test' } });
      expect(s.recruitState!.step).to.equal('agent');
      s = tuiReducer(s, { type: 'RECRUIT_PREV_STEP' });
      expect(s.recruitState!.step).to.equal('name');
    });

    it('RECRUIT_SUBMIT sets submitting flag', function () {
      let s = tuiReducer(initialState('test'), { type: 'ENTER_RECRUIT' });
      s = tuiReducer(s, { type: 'RECRUIT_SUBMIT' });
      expect(s.recruitState!.submitting).to.be.true;
    });

    it('RECRUIT_DONE sets step to done and clears submitting', function () {
      let s = tuiReducer(initialState('test'), { type: 'ENTER_RECRUIT' });
      s = tuiReducer(s, { type: 'RECRUIT_SUBMIT' });
      s = tuiReducer(s, { type: 'RECRUIT_DONE' });
      expect(s.recruitState!.step).to.equal('done');
      expect(s.recruitState!.submitting).to.be.false;
      expect(s.recruitState!.error).to.be.undefined;
    });

    it('RECRUIT_DONE with error stores the error', function () {
      let s = tuiReducer(initialState('test'), { type: 'ENTER_RECRUIT' });
      s = tuiReducer(s, { type: 'RECRUIT_DONE', error: 'Name taken' });
      expect(s.recruitState!.error).to.equal('Name taken');
    });

    it('EXIT_RECRUIT restores previous phase and clears wizard state', function () {
      let s = initialState('test');
      s = { ...s, phase: 'chat' as any, chatTarget: 'player1' };
      s = tuiReducer(s, { type: 'ENTER_RECRUIT' });
      expect(s.recruitState!.preRecruitPhase).to.equal('chat');
      expect(s.recruitState!.preRecruitChatTarget).to.equal('player1');
      s = tuiReducer(s, { type: 'EXIT_RECRUIT' });
      expect(s.phase).to.equal('chat');
      expect(s.chatTarget).to.equal('player1');
      expect(s.recruitState).to.be.undefined;
    });
  });

  // ─────────────────────────────────────────────
  // Copilot bridge / recruit defaults
  // ─────────────────────────────────────────────

  describe('Copilot bridge recruit defaults', function () {
    it('ENTER_RECRUIT with defaultAgent copilot sets agent to copilot', function () {
      const s = tuiReducer(initialState('test'), { type: 'ENTER_RECRUIT', defaultAgent: 'copilot' });
      expect(s.recruitState).to.exist;
      expect(s.recruitState!.answers.agent).to.equal('copilot');
    });

    it('defaultRecruitAnswers(copilot) returns copilot agent', function () {
      const answers = defaultRecruitAnswers('copilot');
      expect(answers.agent).to.equal('copilot');
      // Other fields should still have defaults
      expect(answers.name).to.equal('');
      expect(answers.workDir).to.be.a('string'); // defaults to cwd
    });

    it('explicit agent override beats defaultAgent', function () {
      const s = tuiReducer(initialState('test'), {
        type: 'ENTER_RECRUIT',
        answers: { agent: 'claude' },
        defaultAgent: 'copilot',
      });
      expect(s.recruitState).to.exist;
      expect(s.recruitState!.answers.agent).to.equal('claude');
    });
  });

  // ─────────────────────────────────────────────
  // @player dedup (ConversationStream merge logic)
  // ─────────────────────────────────────────────
  // NOTE: The @player sent message dedup logic lives inside ConversationStream's
  // render function (allConvoMsgs merge with sentMessages). It matches on:
  //   direction === 'out' && |timestamp diff| < 30s && text prefix match (60 chars)
  // This prevents duplicate display when the server echoes back a sent message.
  // Testing requires component rendering (Ink + React) — not feasible in pure reducer tests.
  // Covered by manual TUI testing.

  // ─────────────────────────────────────────────
  // Schedule wizard
  // ─────────────────────────────────────────────

  describe('Schedule wizard', function () {
    it('ENTER_SCHEDULE_WIZARD sets phase and initial step', function () {
      const s = tuiReducer(initialState('test'), { type: 'ENTER_SCHEDULE_WIZARD' });
      expect(s.phase).to.equal('schedule-create');
      expect(s.scheduleWizard).to.exist;
      expect(s.scheduleWizard!.step).to.equal('target');
    });

    it('ENTER_SCHEDULE_WIZARD merges partial answers', function () {
      const s = tuiReducer(initialState('test'), { type: 'ENTER_SCHEDULE_WIZARD', answers: { target: 'player1' } });
      expect(s.scheduleWizard!.answers.target).to.equal('player1');
      expect(s.scheduleWizard!.answers.schedType).to.equal('every'); // default
    });

    it('progresses through steps: target → message → schedType → timing → confirm', function () {
      let s = tuiReducer(initialState('test'), { type: 'ENTER_SCHEDULE_WIZARD' });
      expect(s.scheduleWizard!.step).to.equal('target');

      s = tuiReducer(s, { type: 'SCHEDULE_NEXT_STEP', answer: { target: 'player1' } });
      expect(s.scheduleWizard!.step).to.equal('message');

      s = tuiReducer(s, { type: 'SCHEDULE_NEXT_STEP', answer: { message: 'Check status' } });
      expect(s.scheduleWizard!.step).to.equal('schedType');

      s = tuiReducer(s, { type: 'SCHEDULE_NEXT_STEP', answer: { schedType: 'every' } });
      expect(s.scheduleWizard!.step).to.equal('timing');

      // Non-cron: should skip timezone
      s = tuiReducer(s, { type: 'SCHEDULE_NEXT_STEP', answer: { timing: '5m' } });
      expect(s.scheduleWizard!.step).to.equal('confirm');
    });

    it('includes timezone step for cron type', function () {
      let s = tuiReducer(initialState('test'), { type: 'ENTER_SCHEDULE_WIZARD' });
      s = tuiReducer(s, { type: 'SCHEDULE_NEXT_STEP', answer: { target: 'p1' } });
      s = tuiReducer(s, { type: 'SCHEDULE_NEXT_STEP', answer: { message: 'hi' } });
      s = tuiReducer(s, { type: 'SCHEDULE_NEXT_STEP', answer: { schedType: 'cron' } });
      expect(s.scheduleWizard!.step).to.equal('timing');

      s = tuiReducer(s, { type: 'SCHEDULE_NEXT_STEP', answer: { timing: '0 9 * * 1-5' } });
      expect(s.scheduleWizard!.step).to.equal('timezone');

      s = tuiReducer(s, { type: 'SCHEDULE_NEXT_STEP', answer: { timezone: 'America/New_York' } });
      expect(s.scheduleWizard!.step).to.equal('confirm');
    });

    it('SCHEDULE_PREV_STEP goes back and skips timezone for non-cron', function () {
      let s = tuiReducer(initialState('test'), { type: 'ENTER_SCHEDULE_WIZARD' });
      s = tuiReducer(s, { type: 'SCHEDULE_NEXT_STEP', answer: { target: 'p1' } });
      s = tuiReducer(s, { type: 'SCHEDULE_NEXT_STEP', answer: { message: 'hi' } });
      s = tuiReducer(s, { type: 'SCHEDULE_NEXT_STEP', answer: { schedType: 'every' } });
      s = tuiReducer(s, { type: 'SCHEDULE_NEXT_STEP', answer: { timing: '5m' } });
      expect(s.scheduleWizard!.step).to.equal('confirm');

      s = tuiReducer(s, { type: 'SCHEDULE_PREV_STEP' });
      // Should skip timezone (non-cron) and go back to timing
      expect(s.scheduleWizard!.step).to.equal('timing');
    });

    it('SCHEDULE_SUBMIT sets submitting flag', function () {
      let s = tuiReducer(initialState('test'), { type: 'ENTER_SCHEDULE_WIZARD' });
      s = tuiReducer(s, { type: 'SCHEDULE_SUBMIT' });
      expect(s.scheduleWizard!.submitting).to.be.true;
    });

    it('SCHEDULE_DONE sets step to done and clears submitting', function () {
      let s = tuiReducer(initialState('test'), { type: 'ENTER_SCHEDULE_WIZARD' });
      s = tuiReducer(s, { type: 'SCHEDULE_SUBMIT' });
      s = tuiReducer(s, { type: 'SCHEDULE_DONE' });
      expect(s.scheduleWizard!.step).to.equal('done');
      expect(s.scheduleWizard!.submitting).to.be.false;
    });

    it('SCHEDULE_DONE with error stores the error', function () {
      let s = tuiReducer(initialState('test'), { type: 'ENTER_SCHEDULE_WIZARD' });
      s = tuiReducer(s, { type: 'SCHEDULE_DONE', error: 'Bad cron' });
      expect(s.scheduleWizard!.error).to.equal('Bad cron');
    });

    it('EXIT_SCHEDULE_WIZARD restores previous phase', function () {
      let s = initialState('test');
      s = { ...s, phase: 'chat' as any, chatTarget: 'p1' };
      s = tuiReducer(s, { type: 'ENTER_SCHEDULE_WIZARD' });
      expect(s.scheduleWizard!.prePhase).to.equal('chat');
      s = tuiReducer(s, { type: 'EXIT_SCHEDULE_WIZARD' });
      expect(s.phase).to.equal('chat');
      expect(s.chatTarget).to.equal('p1');
      expect(s.scheduleWizard).to.be.undefined;
    });
  });

  // ─────────────────────────────────────────────
  // Chat actions
  // ─────────────────────────────────────────────

  describe('Chat actions', function () {
    it('ENTER_CHAT sets phase and chatTarget', function () {
      const s = tuiReducer(initialState('test'), { type: 'ENTER_CHAT', target: 'player1' });
      expect(s.phase).to.equal('chat');
      expect(s.chatTarget).to.equal('player1');
    });

    it('EXIT_CHAT restores main phase and clears chatTarget', function () {
      let s = tuiReducer(initialState('test'), { type: 'ENTER_CHAT', target: 'p1' });
      s = tuiReducer(s, { type: 'EXIT_CHAT' });
      expect(s.phase).to.equal('main');
      expect(s.chatTarget).to.be.undefined;
    });

    it('COMMIT_STATIC appends to staticItems', function () {
      const s = tuiReducer(initialState('test'), {
        type: 'COMMIT_STATIC',
        item: { id: 'test-1', type: 'info', content: 'hello', timestamp: Date.now() },
      });
      expect(s.staticItems).to.have.lengthOf(1);
      expect(s.staticItems[0].content).to.equal('hello');
    });

    it('COMMIT_STATIC trims to 500 entries', function () {
      let s = initialState('test');
      s = { ...s, staticItems: Array.from({ length: 500 }, (_, i) => ({ id: `s-${i}`, type: 'info' as const, content: `${i}`, timestamp: i })) };
      s = tuiReducer(s, { type: 'COMMIT_STATIC', item: { id: 'new', type: 'info', content: 'overflow', timestamp: 999 } });
      expect(s.staticItems).to.have.lengthOf(500);
      expect(s.staticItems[499].id).to.equal('new');
    });
  });

  // ─────────────────────────────────────────────
  // Stop/Disband/Lineup confirmation
  // ─────────────────────────────────────────────

  describe('Confirmation dialogs', function () {
    it('CONFIRM_STOP / CANCEL_STOP', function () {
      let s = tuiReducer(initialState('test'), { type: 'CONFIRM_STOP', player: 'victim' });
      expect(s.confirmingStop).to.equal('victim');
      s = tuiReducer(s, { type: 'CANCEL_STOP' });
      expect(s.confirmingStop).to.be.undefined;
    });

    it('CONFIRM_DISBAND / CANCEL_DISBAND', function () {
      let s = tuiReducer(initialState('test'), { type: 'CONFIRM_DISBAND', ensemble: 'ens-1' });
      expect(s.confirmingDisband).to.equal('ens-1');
      s = tuiReducer(s, { type: 'CANCEL_DISBAND' });
      expect(s.confirmingDisband).to.be.undefined;
    });

    it('CONFIRM_LINEUP / CANCEL_LINEUP', function () {
      let s = tuiReducer(initialState('test'), { type: 'CONFIRM_LINEUP', action: 'load', path: '/tmp/lineup.yml', summary: '3 players' });
      expect(s.confirmingLineup).to.deep.equal({ action: 'load', path: '/tmp/lineup.yml', summary: '3 players' });
      s = tuiReducer(s, { type: 'CANCEL_LINEUP' });
      expect(s.confirmingLineup).to.be.undefined;
    });
  });

  // ─────────────────────────────────────────────
  // Create Ensemble wizard
  // ─────────────────────────────────────────────

  describe('Create Ensemble wizard', function () {
    it('ENTER_CREATE_ENSEMBLE sets phase and initial step', function () {
      const s = tuiReducer(initialState('test'), { type: 'ENTER_CREATE_ENSEMBLE' });
      expect(s.phase).to.equal('create-ensemble');
      expect(s.createEnsembleState).to.exist;
      expect(s.createEnsembleState!.step).to.equal('name');
      expect(s.createEnsembleState!.prePhase).to.equal('main');
    });

    it('progresses through steps: name → workDir → lineup → confirm', function () {
      let s = tuiReducer(initialState('test'), { type: 'ENTER_CREATE_ENSEMBLE' });
      expect(s.createEnsembleState!.step).to.equal('name');

      s = tuiReducer(s, { type: 'CREATE_ENSEMBLE_NEXT_STEP', answer: { name: 'my-ensemble' } });
      expect(s.createEnsembleState!.step).to.equal('workDir');
      expect(s.createEnsembleState!.answers.name).to.equal('my-ensemble');

      s = tuiReducer(s, { type: 'CREATE_ENSEMBLE_NEXT_STEP', answer: { workDir: '/tmp' } });
      expect(s.createEnsembleState!.step).to.equal('lineup');

      s = tuiReducer(s, { type: 'CREATE_ENSEMBLE_NEXT_STEP', answer: { lineup: 'dev-team' } });
      expect(s.createEnsembleState!.step).to.equal('confirm');
    });

    it('CREATE_ENSEMBLE_PREV_STEP goes back one step', function () {
      let s = tuiReducer(initialState('test'), { type: 'ENTER_CREATE_ENSEMBLE' });
      s = tuiReducer(s, { type: 'CREATE_ENSEMBLE_NEXT_STEP', answer: { name: 'test' } });
      expect(s.createEnsembleState!.step).to.equal('workDir');
      s = tuiReducer(s, { type: 'CREATE_ENSEMBLE_PREV_STEP' });
      expect(s.createEnsembleState!.step).to.equal('name');
    });

    it('CREATE_ENSEMBLE_PREV_STEP at first step returns same reference', function () {
      const s = tuiReducer(initialState('test'), { type: 'ENTER_CREATE_ENSEMBLE' });
      const result = tuiReducer(s, { type: 'CREATE_ENSEMBLE_PREV_STEP' });
      expect(result).to.equal(s);
    });

    it('CREATE_ENSEMBLE_SUBMIT sets submitting flag', function () {
      let s = tuiReducer(initialState('test'), { type: 'ENTER_CREATE_ENSEMBLE' });
      s = tuiReducer(s, { type: 'CREATE_ENSEMBLE_SUBMIT' });
      expect(s.createEnsembleState!.submitting).to.be.true;
    });

    it('CREATE_ENSEMBLE_DONE with ensemble navigates to it', function () {
      let s = tuiReducer(initialState('test'), { type: 'ENTER_CREATE_ENSEMBLE' });
      s = tuiReducer(s, { type: 'CREATE_ENSEMBLE_DONE', ensemble: 'new-ens' });
      expect(s.phase).to.equal('main');
      expect(s.view).to.equal('ensemble');
      expect(s.activeEnsemble).to.equal('new-ens');
      expect(s.createEnsembleState).to.be.undefined;
    });

    it('CREATE_ENSEMBLE_DONE with error shows error on done step', function () {
      let s = tuiReducer(initialState('test'), { type: 'ENTER_CREATE_ENSEMBLE' });
      s = tuiReducer(s, { type: 'CREATE_ENSEMBLE_DONE', error: 'Name taken' });
      expect(s.createEnsembleState!.step).to.equal('done');
      expect(s.createEnsembleState!.error).to.equal('Name taken');
      expect(s.createEnsembleState!.submitting).to.be.false;
    });

    it('EXIT_CREATE_ENSEMBLE restores previous phase', function () {
      let s = initialState('test');
      s = { ...s, phase: 'chat' as any };
      s = tuiReducer(s, { type: 'ENTER_CREATE_ENSEMBLE' });
      expect(s.createEnsembleState!.prePhase).to.equal('chat');
      s = tuiReducer(s, { type: 'EXIT_CREATE_ENSEMBLE' });
      expect(s.phase).to.equal('chat');
      expect(s.createEnsembleState).to.be.undefined;
    });
  });

  // ─────────────────────────────────────────────
  // Loading state
  // ─────────────────────────────────────────────

  describe('playersLoaded flag', function () {
    it('starts as false in initial state', function () {
      expect(initialState('test').playersLoaded).to.be.false;
    });

    it('set to true by REFRESH_ENSEMBLE_DATA', function () {
      let s = initialState('test');
      expect(s.playersLoaded).to.be.false;
      s = tuiReducer(s, { type: 'REFRESH_ENSEMBLE_DATA', players: [makePlayer('a')], messages: [], history: [] });
      expect(s.playersLoaded).to.be.true;
    });

    it('reset to false by NAVIGATE_ENSEMBLE', function () {
      let s = initialState('test');
      s = tuiReducer(s, { type: 'REFRESH_ENSEMBLE_DATA', players: [], messages: [], history: [] });
      expect(s.playersLoaded).to.be.true;
      s = tuiReducer(s, { type: 'NAVIGATE_ENSEMBLE', ensemble: 'new-ens' });
      expect(s.playersLoaded).to.be.false;
    });

    it('reset to false by NAVIGATE_HOME', function () {
      let s = initialState('test');
      s = tuiReducer(s, { type: 'REFRESH_ENSEMBLE_DATA', players: [], messages: [], history: [] });
      s = tuiReducer(s, { type: 'NAVIGATE_HOME' });
      expect(s.playersLoaded).to.be.false;
    });
  });

  // ─────────────────────────────────────────────
  // Overlay actions
  // ─────────────────────────────────────────────

  describe('Overlay actions', function () {
    const sampleOverlay = {
      type: 'schedules',
      title: 'Schedules',
      items: [
        { id: 's1', label: 'Daily report' },
        { id: 's2', label: 'Weekly sync', sublabel: 'cron: 0 9 * * 1' },
        { id: 's3', label: 'Hourly ping' },
      ],
      hint: 'n=new  d=delete  esc=close',
    };

    it('SHOW_OVERLAY sets overlay with selectedIndex=0', function () {
      const s = tuiReducer(initialState('test'), { type: 'SHOW_OVERLAY', overlay: sampleOverlay });
      expect(s.overlay).to.not.be.null;
      expect(s.overlay!.type).to.equal('schedules');
      expect(s.overlay!.title).to.equal('Schedules');
      expect(s.overlay!.items).to.have.length(3);
      expect(s.overlay!.selectedIndex).to.equal(0);
      expect(s.overlay!.hint).to.equal('n=new  d=delete  esc=close');
    });

    it('SHOW_OVERLAY resets selectedIndex to 0', function () {
      let s = tuiReducer(initialState('test'), { type: 'SHOW_OVERLAY', overlay: sampleOverlay });
      s = tuiReducer(s, { type: 'OVERLAY_SELECT', direction: 'down' });
      expect(s.overlay!.selectedIndex).to.equal(1);
      s = tuiReducer(s, { type: 'SHOW_OVERLAY', overlay: sampleOverlay });
      expect(s.overlay!.selectedIndex).to.equal(0);
    });

    it('HIDE_OVERLAY clears overlay to null', function () {
      let s = tuiReducer(initialState('test'), { type: 'SHOW_OVERLAY', overlay: sampleOverlay });
      s = tuiReducer(s, { type: 'HIDE_OVERLAY' });
      expect(s.overlay).to.be.null;
    });

    it('OVERLAY_SELECT up wraps from 0 to last item', function () {
      let s = tuiReducer(initialState('test'), { type: 'SHOW_OVERLAY', overlay: sampleOverlay });
      expect(s.overlay!.selectedIndex).to.equal(0);
      s = tuiReducer(s, { type: 'OVERLAY_SELECT', direction: 'up' });
      expect(s.overlay!.selectedIndex).to.equal(2); // wraps to last
    });

    it('OVERLAY_SELECT down wraps from last to 0', function () {
      let s = tuiReducer(initialState('test'), { type: 'SHOW_OVERLAY', overlay: sampleOverlay });
      s = tuiReducer(s, { type: 'OVERLAY_SELECT', direction: 'down' });
      s = tuiReducer(s, { type: 'OVERLAY_SELECT', direction: 'down' });
      expect(s.overlay!.selectedIndex).to.equal(2);
      s = tuiReducer(s, { type: 'OVERLAY_SELECT', direction: 'down' });
      expect(s.overlay!.selectedIndex).to.equal(0); // wraps to first
    });

    it('OVERLAY_SELECT identity when single item', function () {
      const singleItem = { ...sampleOverlay, items: [{ id: 'only', label: 'Only one' }] };
      let s = tuiReducer(initialState('test'), { type: 'SHOW_OVERLAY', overlay: singleItem });
      const before = s;
      s = tuiReducer(s, { type: 'OVERLAY_SELECT', direction: 'down' });
      expect(s).to.equal(before); // same reference — no change
    });

    it('SHOW_COMMAND_OVERLAY maps to overlay with single-item array', function () {
      const s = tuiReducer(initialState('test'), { type: 'SHOW_COMMAND_OVERLAY', title: 'Help', content: 'Commands...' });
      expect(s.overlay).to.not.be.null;
      expect(s.overlay!.type).to.equal('command');
      expect(s.overlay!.title).to.equal('Help');
      expect(s.overlay!.items).to.have.length(1);
      expect(s.overlay!.items[0].id).to.equal('_');
      expect(s.overlay!.items[0].label).to.equal('Commands...');
      expect(s.overlay!.hint).to.include('esc');
    });
  });

  // ─────────────────────────────────────────────
  // APPEND_SENT_MESSAGE
  // ─────────────────────────────────────────────

  describe('APPEND_SENT_MESSAGE', function () {
    it('appends with correct to/text and ISO timestamp', function () {
      const s = tuiReducer(initialState('test'), { type: 'APPEND_SENT_MESSAGE', to: 'player1', text: 'hello' });
      expect(s.sentMessages).to.have.length(1);
      expect(s.sentMessages[0].to).to.equal('player1');
      expect(s.sentMessages[0].text).to.equal('hello');
      // Timestamp should be a valid ISO string
      expect(new Date(s.sentMessages[0].timestamp).toISOString()).to.equal(s.sentMessages[0].timestamp);
    });

    it('caps at 200 messages (oldest removed)', function () {
      let s = initialState('test');
      for (let i = 0; i < 210; i++) {
        s = tuiReducer(s, { type: 'APPEND_SENT_MESSAGE', to: 'p', text: `msg-${i}` });
      }
      expect(s.sentMessages).to.have.length(200);
      expect(s.sentMessages[0].text).to.equal('msg-10'); // first 10 trimmed
      expect(s.sentMessages[199].text).to.equal('msg-209');
    });

    it('creates new reference', function () {
      const s0 = initialState('test');
      const s1 = tuiReducer(s0, { type: 'APPEND_SENT_MESSAGE', to: 'p', text: 'hi' });
      expect(s1).to.not.equal(s0);
      expect(s1.sentMessages).to.not.equal(s0.sentMessages);
    });
  });

  // ─────────────────────────────────────────────
  // HYDRATE_SENT_MESSAGES
  // ─────────────────────────────────────────────

  describe('HYDRATE_SENT_MESSAGES', function () {
    it('merges new messages without duplicating existing', function () {
      let s = tuiReducer(initialState('test'), { type: 'APPEND_SENT_MESSAGE', to: 'p', text: 'existing' });
      const ts = s.sentMessages[0].timestamp;
      s = tuiReducer(s, {
        type: 'HYDRATE_SENT_MESSAGES',
        messages: [
          { to: 'p', text: 'existing', timestamp: ts },  // duplicate
          { to: 'p', text: 'new-msg', timestamp: new Date().toISOString() },
        ],
      });
      expect(s.sentMessages).to.have.length(2);
      expect(s.sentMessages[1].text).to.equal('new-msg');
    });

    it('empty hydration returns same reference', function () {
      const s0 = tuiReducer(initialState('test'), { type: 'APPEND_SENT_MESSAGE', to: 'p', text: 'hi' });
      const ts = s0.sentMessages[0].timestamp;
      const s1 = tuiReducer(s0, {
        type: 'HYDRATE_SENT_MESSAGES',
        messages: [{ to: 'p', text: 'hi', timestamp: ts }], // all dupes
      });
      expect(s1).to.equal(s0); // same reference — no change
    });
  });

  // ─────────────────────────────────────────────
  // RECRUIT_SUBMIT / RECRUIT_DONE / EXIT_RECRUIT
  // ─────────────────────────────────────────────

  describe('RECRUIT_SUBMIT / RECRUIT_DONE / EXIT_RECRUIT', function () {
    it('RECRUIT_SUBMIT sets submitting=true', function () {
      let s = tuiReducer(initialState('test'), { type: 'ENTER_RECRUIT' });
      s = tuiReducer(s, { type: 'RECRUIT_SUBMIT' });
      expect(s.recruitState!.submitting).to.be.true;
    });

    it('RECRUIT_DONE sets step=done, clears submitting, stores error', function () {
      let s = tuiReducer(initialState('test'), { type: 'ENTER_RECRUIT' });
      s = tuiReducer(s, { type: 'RECRUIT_SUBMIT' });
      s = tuiReducer(s, { type: 'RECRUIT_DONE', error: 'Name taken' });
      expect(s.recruitState!.step).to.equal('done');
      expect(s.recruitState!.submitting).to.be.false;
      expect(s.recruitState!.error).to.equal('Name taken');
    });

    it('RECRUIT_DONE with no error has error undefined', function () {
      let s = tuiReducer(initialState('test'), { type: 'ENTER_RECRUIT' });
      s = tuiReducer(s, { type: 'RECRUIT_SUBMIT' });
      s = tuiReducer(s, { type: 'RECRUIT_DONE' });
      expect(s.recruitState!.step).to.equal('done');
      expect(s.recruitState!.error).to.be.undefined;
    });

    it('EXIT_RECRUIT restores preRecruitPhase and preRecruitChatTarget', function () {
      let s = initialState('test');
      s = { ...s, phase: 'chat' as any, chatTarget: 'soloist' };
      s = tuiReducer(s, { type: 'ENTER_RECRUIT' });
      expect(s.recruitState!.preRecruitPhase).to.equal('chat');
      expect(s.recruitState!.preRecruitChatTarget).to.equal('soloist');
      s = tuiReducer(s, { type: 'EXIT_RECRUIT' });
      expect(s.phase).to.equal('chat');
      expect(s.chatTarget).to.equal('soloist');
      expect(s.recruitState).to.be.undefined;
    });
  });
});
