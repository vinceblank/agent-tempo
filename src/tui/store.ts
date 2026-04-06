/**
 * TUI state management — useReducer + React context.
 * No external state libraries. All state flows through a single dispatch.
 *
 * Supports multi-ensemble navigation: home -> ensemble -> player views.
 */
import type {
  MaestroPlayerInfo,
  MaestroRelayMessage,
  HistoryEntry,
  Message,
  SentMessage,
} from '../types';
import type { EnsembleSummary } from './core-api';

// ── State ──

export type TuiView = 'home' | 'ensemble' | 'player';
export type TuiPhase = 'splash' | 'connecting' | 'connected' | 'main' | 'chat' | 'recruit' | 'error';

// ── Static items (committed scroll history) ──

export interface StaticItem {
  id: string;
  type: 'splash-done' | 'command-output' | 'message' | 'error' | 'info';
  content: string;
  timestamp: number;
}

export interface TuiState {
  phase: TuiPhase;
  /** Current view in the navigation hierarchy. */
  view: TuiView;
  /** Error message when phase === 'error'. */
  error?: string;
  /** Splash screen status text. */
  splashStatus: string;

  // ── Home view ──
  /** Known ensembles. */
  ensembles: EnsembleSummary[];
  /** Currently highlighted ensemble index (home view). */
  selectedEnsembleIndex: number;

  // ── Ensemble view ──
  /** The ensemble currently being viewed (null = home). */
  activeEnsemble: string | null;
  /** Players in the active ensemble. */
  players: MaestroPlayerInfo[];
  /** Messages in the active ensemble (relay messages). */
  messages: MaestroRelayMessage[];
  /** Conductor history in the active ensemble. */
  conductorHistory: HistoryEntry[];
  /** Currently highlighted player index (ensemble view). */
  selectedPlayerIndex: number;

  // ── Player view ──
  /** The player currently being inspected (null = not viewing a player). */
  activePlayer: string | null;
  /** Player's workflow metadata. */
  playerMetadata: any;
  /** Player's message history (received + sent). */
  playerMessages: Array<Message | (SentMessage & { direction: 'sent' })>;

  // ── Focus & input ──
  /** Which zone has keyboard focus. */
  focusZone: 'sidebar' | 'timeline' | 'input';
  /** Current text in the input bar. */
  inputText: string;

  // ── Chat shell ──
  /** Committed scroll-up history items. */
  staticItems: StaticItem[];
  /** Current prompt input value. */
  inputValue: string;
  /** Player name when in chat mode (bare text sends cue to this target). */
  chatTarget?: string;
}

export function initialState(ensemble?: string): TuiState {
  return {
    phase: 'splash',
    view: ensemble ? 'ensemble' : 'home',
    splashStatus: 'Starting up...',

    ensembles: [],
    selectedEnsembleIndex: 0,

    activeEnsemble: ensemble || null,
    players: [],
    messages: [],
    conductorHistory: [],
    selectedPlayerIndex: 0,

    activePlayer: null,
    playerMetadata: null,
    playerMessages: [],

    focusZone: 'sidebar',
    inputText: '',

    staticItems: [],
    inputValue: '',
    chatTarget: undefined,
  };
}

// ── Actions ──

export type TuiAction =
  | { type: 'SET_PHASE'; phase: TuiPhase; error?: string }
  | { type: 'SET_SPLASH_STATUS'; status: string }
  // Navigation
  | { type: 'NAVIGATE_HOME' }
  | { type: 'NAVIGATE_ENSEMBLE'; ensemble: string }
  | { type: 'NAVIGATE_PLAYER'; playerId: string }
  // Data refresh
  | { type: 'REFRESH_ENSEMBLES'; ensembles: EnsembleSummary[] }
  | { type: 'REFRESH_ENSEMBLE_DATA'; players: MaestroPlayerInfo[]; messages: MaestroRelayMessage[]; history: HistoryEntry[] }
  | { type: 'REFRESH_PLAYER_DATA'; metadata: any; messages: Array<Message | (SentMessage & { direction: 'sent' })> }
  // Selection
  | { type: 'SELECT_NEXT' }
  | { type: 'SELECT_PREV' }
  | { type: 'CYCLE_FOCUS' }
  | { type: 'SET_INPUT_TEXT'; text: string }
  // Chat shell actions
  | { type: 'COMMIT_STATIC'; item: StaticItem }
  | { type: 'SET_INPUT'; value: string }
  | { type: 'ENTER_CHAT'; target: string }
  | { type: 'EXIT_CHAT' }
  // Legacy compat — used by current App.tsx during transition
  | { type: 'REFRESH_ALL'; players: MaestroPlayerInfo[]; messages: MaestroRelayMessage[]; history: HistoryEntry[] };

// ── Reducer ──

export function tuiReducer(state: TuiState, action: TuiAction): TuiState {
  switch (action.type) {
    case 'SET_PHASE':
      return { ...state, phase: action.phase, error: action.error };

    case 'SET_SPLASH_STATUS':
      return { ...state, splashStatus: action.status };

    // ── Navigation ──

    case 'NAVIGATE_HOME':
      return {
        ...state,
        view: 'home',
        activeEnsemble: null,
        activePlayer: null,
        players: [],
        messages: [],
        conductorHistory: [],
        playerMetadata: null,
        playerMessages: [],
        selectedPlayerIndex: 0,
        focusZone: 'sidebar',
        inputText: '',
      };

    case 'NAVIGATE_ENSEMBLE':
      return {
        ...state,
        view: 'ensemble',
        activeEnsemble: action.ensemble,
        activePlayer: null,
        players: [],
        messages: [],
        conductorHistory: [],
        playerMetadata: null,
        playerMessages: [],
        selectedPlayerIndex: 0,
        focusZone: 'sidebar',
        inputText: '',
      };

    case 'NAVIGATE_PLAYER':
      return {
        ...state,
        view: 'player',
        activePlayer: action.playerId,
        playerMetadata: null,
        playerMessages: [],
        focusZone: 'timeline',
      };

    // ── Data refresh ──

    case 'REFRESH_ENSEMBLES':
      return {
        ...state,
        ensembles: action.ensembles,
        // Clamp selection index
        selectedEnsembleIndex: Math.min(state.selectedEnsembleIndex, Math.max(0, action.ensembles.length - 1)),
      };

    case 'REFRESH_ENSEMBLE_DATA':
      return {
        ...state,
        players: action.players,
        messages: action.messages,
        conductorHistory: action.history,
        // Clamp selection index
        selectedPlayerIndex: Math.min(state.selectedPlayerIndex, Math.max(0, action.players.length - 1)),
      };

    case 'REFRESH_PLAYER_DATA':
      return {
        ...state,
        playerMetadata: action.metadata,
        playerMessages: action.messages,
      };

    // Legacy compat — maps to REFRESH_ENSEMBLE_DATA
    case 'REFRESH_ALL':
      return {
        ...state,
        players: action.players,
        messages: action.messages,
        conductorHistory: action.history,
        selectedPlayerIndex: Math.min(state.selectedPlayerIndex, Math.max(0, action.players.length - 1)),
      };

    // ── Selection & Focus ──

    case 'SELECT_NEXT': {
      if (state.view === 'home') {
        const max = Math.max(0, state.ensembles.length - 1);
        return { ...state, selectedEnsembleIndex: Math.min(state.selectedEnsembleIndex + 1, max) };
      }
      if (state.view === 'ensemble' && state.focusZone === 'sidebar') {
        const max = Math.max(0, state.players.length - 1);
        return { ...state, selectedPlayerIndex: Math.min(state.selectedPlayerIndex + 1, max) };
      }
      return state;
    }

    case 'SELECT_PREV': {
      if (state.view === 'home') {
        return { ...state, selectedEnsembleIndex: Math.max(0, state.selectedEnsembleIndex - 1) };
      }
      if (state.view === 'ensemble' && state.focusZone === 'sidebar') {
        return { ...state, selectedPlayerIndex: Math.max(0, state.selectedPlayerIndex - 1) };
      }
      return state;
    }

    case 'CYCLE_FOCUS': {
      const zones: TuiState['focusZone'][] = ['sidebar', 'timeline', 'input'];
      const currentIdx = zones.indexOf(state.focusZone);
      const nextIdx = (currentIdx + 1) % zones.length;
      return { ...state, focusZone: zones[nextIdx] };
    }

    case 'SET_INPUT_TEXT':
      return { ...state, inputText: action.text };

    // ── Chat shell ──

    case 'COMMIT_STATIC':
      return { ...state, staticItems: [...state.staticItems, action.item] };

    case 'SET_INPUT':
      return { ...state, inputValue: action.value };

    case 'ENTER_CHAT':
      return { ...state, phase: 'chat' as TuiPhase, chatTarget: action.target };

    case 'EXIT_CHAT':
      return { ...state, phase: 'main' as TuiPhase, chatTarget: undefined };

    default:
      return state;
  }
}
