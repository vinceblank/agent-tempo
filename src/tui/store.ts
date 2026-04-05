/**
 * TUI state management — useReducer + React context.
 * No external state libraries. All state flows through a single dispatch.
 */
import type {
  MaestroPlayerInfo,
  MaestroEvent,
  HistoryEntry,
} from '../types';

// ── State ──

export type TuiPhase = 'splash' | 'connecting' | 'connected' | 'error';

export interface TuiState {
  phase: TuiPhase;
  /** Error message when phase === 'error'. */
  error?: string;
  /** Ensemble name. */
  ensemble: string;
  /** Current player snapshot. */
  players: MaestroPlayerInfo[];
  /** Event log (most recent last). */
  events: MaestroEvent[];
  /** Conductor command/report history. */
  conductorHistory: HistoryEntry[];
  /** Splash screen status text. */
  splashStatus: string;
  /** Whether the input bar is focused. */
  inputFocused: boolean;
  /** Active panel for keyboard navigation. */
  activePanel: 'ensemble' | 'chat' | 'activity' | 'input';
}

export function initialState(ensemble: string): TuiState {
  return {
    phase: 'splash',
    ensemble,
    players: [],
    events: [],
    conductorHistory: [],
    splashStatus: 'Starting up...',
    inputFocused: false,
    activePanel: 'input',
  };
}

// ── Actions ──

export type TuiAction =
  | { type: 'SET_PHASE'; phase: TuiPhase; error?: string }
  | { type: 'SET_SPLASH_STATUS'; status: string }
  | { type: 'UPDATE_PLAYERS'; players: MaestroPlayerInfo[] }
  | { type: 'UPDATE_EVENTS'; events: MaestroEvent[] }
  | { type: 'UPDATE_CONDUCTOR_HISTORY'; history: HistoryEntry[] }
  | { type: 'REFRESH_ALL'; players: MaestroPlayerInfo[]; events: MaestroEvent[]; history: HistoryEntry[] }
  | { type: 'SET_INPUT_FOCUSED'; focused: boolean }
  | { type: 'SET_ACTIVE_PANEL'; panel: TuiState['activePanel'] };

// ── Reducer ──

export function tuiReducer(state: TuiState, action: TuiAction): TuiState {
  switch (action.type) {
    case 'SET_PHASE':
      return { ...state, phase: action.phase, error: action.error };
    case 'SET_SPLASH_STATUS':
      return { ...state, splashStatus: action.status };
    case 'UPDATE_PLAYERS':
      return { ...state, players: action.players };
    case 'UPDATE_EVENTS':
      return { ...state, events: action.events };
    case 'UPDATE_CONDUCTOR_HISTORY':
      return { ...state, conductorHistory: action.history };
    case 'REFRESH_ALL':
      return {
        ...state,
        players: action.players,
        events: action.events,
        conductorHistory: action.history,
      };
    case 'SET_INPUT_FOCUSED':
      return { ...state, inputFocused: action.focused };
    case 'SET_ACTIVE_PANEL':
      return { ...state, activePanel: action.panel };
    default:
      return state;
  }
}
