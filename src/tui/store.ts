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
  ScheduleEntry,
} from '../types';
import type { EnsembleSummary } from './client';

// ── State ──

/**
 * TuiView tracks the *navigation hierarchy* (home → ensemble → player).
 * It determines what data to fetch and what breadcrumb context to show.
 */
export type TuiView = 'home' | 'ensemble' | 'player';

/**
 * TuiPhase tracks the *application lifecycle* (splash → main → chat/error).
 * It determines which component renders in the live content area.
 * A phase can span multiple views (e.g., 'main' shows either home or ensemble view).
 */
export type TuiPhase = 'splash' | 'connecting' | 'connected' | 'main' | 'chat' | 'recruit' | 'error';

// ── Static items (committed scroll history) ──

export interface StaticItem {
  id: string;
  type: 'splash-done' | 'command-output' | 'message' | 'error' | 'info';
  content: string;
  timestamp: number;
}

// ── Recruit wizard ──

export type RecruitStep = 'name' | 'agent' | 'type' | 'workDir' | 'message' | 'host' | 'confirm' | 'done';

export interface RecruitAnswers {
  name: string;
  agent: 'claude' | 'copilot';
  playerType: string;
  workDir: string;
  initialMessage: string;
  host: string;
}

export interface RecruitState {
  step: RecruitStep;
  answers: RecruitAnswers;
  /** Error from the recruit API call, if any. */
  error?: string;
  /** Whether the recruit API call is in progress. */
  submitting?: boolean;
  /** Phase before entering the wizard (restored on exit). */
  preRecruitPhase: TuiPhase;
  /** Chat target before entering the wizard (restored on exit). */
  preRecruitChatTarget?: string;
}

export const RECRUIT_STEPS: RecruitStep[] = ['name', 'agent', 'type', 'workDir', 'message', 'host', 'confirm'];

export const DEFAULT_RECRUIT_ANSWERS: RecruitAnswers = {
  name: '',
  agent: 'claude',
  playerType: '',
  workDir: process.cwd(),
  initialMessage: '',
  host: 'localhost',
};

export interface TuiState {
  phase: TuiPhase;
  /** Current view in the navigation hierarchy. */
  view: TuiView;
  /** Error message when phase === 'error'. */
  error?: string;
  /** Splash screen status text. */
  splashStatus: string;
  /** Progressive checklist items shown during splash. */
  splashChecks: Array<{ label: string; done: boolean; error?: boolean }>;
  /** Whether the splash connection sequence is complete. */
  splashConnected: boolean;
  /** Summary info shown in splash after connection. */
  splashSummary?: {
    ensemble: string;
    playerCount: number;
    conductor?: string;
    scheduleCount?: number;
  };

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
  /** Active schedules in the ensemble. */
  schedules: ScheduleEntry[];
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
  /** ID of the last message seen (for detecting new arrivals in polling). */
  lastSeenMessageId?: string;
  /** Player name pending stop confirmation (null = not confirming). */
  confirmingStop?: string;
  /** Lineup confirmation state (pending load). */
  confirmingLineup?: { action: 'load'; path: string; summary: string };
  /** Recruit wizard state (active when phase === 'recruit'). */
  recruitState?: RecruitState;
}

export function initialState(ensemble?: string): TuiState {
  return {
    phase: 'splash',
    view: ensemble ? 'ensemble' : 'home',
    splashStatus: 'Starting up...',
    splashChecks: [],
    splashConnected: false,
    splashSummary: undefined,

    ensembles: [],
    selectedEnsembleIndex: 0,

    activeEnsemble: ensemble || null,
    players: [],
    messages: [],
    conductorHistory: [],
    schedules: [],
    selectedPlayerIndex: 0,

    activePlayer: null,
    playerMetadata: null,
    playerMessages: [],

    focusZone: 'sidebar',
    inputText: '',

    staticItems: [],
    inputValue: '',
    chatTarget: undefined,
    confirmingStop: undefined,
  };
}

// ── Actions ──

export type TuiAction =
  | { type: 'SET_PHASE'; phase: TuiPhase; error?: string }
  | { type: 'SET_SPLASH_STATUS'; status: string }
  | { type: 'SET_SPLASH_CHECKS'; checks: Array<{ label: string; done: boolean; error?: boolean }> }
  | { type: 'SET_SPLASH_CONNECTED'; summary?: TuiState['splashSummary'] }
  // Navigation
  | { type: 'NAVIGATE_HOME' }
  | { type: 'NAVIGATE_ENSEMBLE'; ensemble: string }
  | { type: 'NAVIGATE_PLAYER'; playerId: string }
  // Data refresh
  | { type: 'REFRESH_ENSEMBLES'; ensembles: EnsembleSummary[] }
  | { type: 'REFRESH_ENSEMBLE_DATA'; players: MaestroPlayerInfo[]; messages: MaestroRelayMessage[]; history: HistoryEntry[]; schedules?: ScheduleEntry[] }
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
  // Stop confirmation
  | { type: 'CONFIRM_STOP'; player: string }
  | { type: 'CANCEL_STOP' }
  // Lineup confirmation
  | { type: 'CONFIRM_LINEUP'; action: 'load'; path: string; summary: string }
  | { type: 'CANCEL_LINEUP' }
  // Recruit wizard
  | { type: 'ENTER_RECRUIT'; answers?: Partial<RecruitAnswers> }
  | { type: 'RECRUIT_NEXT_STEP'; answer: Partial<RecruitAnswers> }
  | { type: 'RECRUIT_PREV_STEP' }
  | { type: 'RECRUIT_SUBMIT' }
  | { type: 'RECRUIT_DONE'; error?: string }
  | { type: 'EXIT_RECRUIT' }
  // Legacy compat — used by current App.tsx during transition
  | { type: 'REFRESH_ALL'; players: MaestroPlayerInfo[]; messages: MaestroRelayMessage[]; history: HistoryEntry[] };

// ── Reducer ──

export function tuiReducer(state: TuiState, action: TuiAction): TuiState {
  switch (action.type) {
    case 'SET_PHASE':
      return { ...state, phase: action.phase, error: action.error };

    case 'SET_SPLASH_STATUS':
      return { ...state, splashStatus: action.status };

    case 'SET_SPLASH_CHECKS':
      return { ...state, splashChecks: action.checks };

    case 'SET_SPLASH_CONNECTED':
      return { ...state, splashConnected: true, splashSummary: action.summary };

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
        schedules: [],
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
        schedules: [],
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

    case 'REFRESH_ENSEMBLE_DATA': {
      const lastMsg = action.messages.length > 0 ? action.messages[action.messages.length - 1] : null;
      return {
        ...state,
        players: action.players,
        messages: action.messages,
        conductorHistory: action.history,
        schedules: action.schedules ?? state.schedules,
        lastSeenMessageId: lastMsg?.id ?? state.lastSeenMessageId,
        // Clamp selection index
        selectedPlayerIndex: Math.min(state.selectedPlayerIndex, Math.max(0, action.players.length - 1)),
      };
    }

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

    // ── Stop confirmation ──

    case 'CONFIRM_STOP':
      return { ...state, confirmingStop: action.player };

    case 'CANCEL_STOP':
      return { ...state, confirmingStop: undefined };

    // ── Lineup confirmation ──

    case 'CONFIRM_LINEUP':
      return { ...state, confirmingLineup: { action: action.action, path: action.path, summary: action.summary } };

    case 'CANCEL_LINEUP':
      return { ...state, confirmingLineup: undefined };

    // ── Recruit wizard ──

    case 'ENTER_RECRUIT':
      return {
        ...state,
        phase: 'recruit' as TuiPhase,
        recruitState: {
          step: 'name',
          answers: { ...DEFAULT_RECRUIT_ANSWERS, ...action.answers },
          preRecruitPhase: state.phase,
          preRecruitChatTarget: state.chatTarget,
        },
      };

    case 'RECRUIT_NEXT_STEP': {
      if (!state.recruitState) return state;
      const answers = { ...state.recruitState.answers, ...action.answer };
      const currentIdx = RECRUIT_STEPS.indexOf(state.recruitState.step);
      const nextStep = RECRUIT_STEPS[currentIdx + 1] ?? state.recruitState.step;
      return {
        ...state,
        recruitState: { ...state.recruitState, step: nextStep, answers },
      };
    }

    case 'RECRUIT_PREV_STEP': {
      if (!state.recruitState) return state;
      const currentIdx = RECRUIT_STEPS.indexOf(state.recruitState.step);
      if (currentIdx <= 0) return state;
      const prevStep = RECRUIT_STEPS[currentIdx - 1];
      return {
        ...state,
        recruitState: { ...state.recruitState, step: prevStep },
      };
    }

    case 'RECRUIT_SUBMIT':
      if (!state.recruitState) return state;
      return {
        ...state,
        recruitState: { ...state.recruitState, submitting: true },
      };

    case 'RECRUIT_DONE':
      if (!state.recruitState) return state;
      return {
        ...state,
        recruitState: {
          ...state.recruitState,
          step: 'done',
          submitting: false,
          error: action.error,
        },
      };

    case 'EXIT_RECRUIT': {
      const restorePhase = state.recruitState?.preRecruitPhase || 'main';
      const restoreChat = state.recruitState?.preRecruitChatTarget;
      return {
        ...state,
        phase: restorePhase,
        chatTarget: restoreChat,
        recruitState: undefined,
      };
    }

    default:
      return state;
  }
}
