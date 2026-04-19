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
  SessionMetadata,
  ScheduleEntry,
  EnsembleChatMessage,
  EnsembleChatResult,
} from '../types';
import type { EnsembleSummary } from '../client';

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
export type TuiPhase = 'splash' | 'main' | 'chat' | 'recruit' | 'schedule-create' | 'create-ensemble' | 'error';

// ── Static items (committed scroll history) ──

export interface StaticItem {
  id: string;
  type: 'splash-done' | 'command-output' | 'message' | 'error' | 'info';
  content: string;
  timestamp: number;
  /** Message-specific fields for rich rendering in scrollback. */
  msgDirection?: 'in' | 'out';
  msgSender?: string;
  msgTime?: string;
  msgThirdParty?: boolean;
  msgRouteLabel?: string;
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

/**
 * Wizard Pattern:
 * - Each wizard has a phase (e.g., 'recruit', 'schedule-create', 'create-ensemble')
 * - State: step name, answers accumulator, error, submitting flag, pre-wizard phase/chatTarget
 * - Actions: ENTER_*, *_NEXT_STEP, *_PREV_STEP, *_SUBMIT, *_DONE, EXIT_*
 * - Components: zero-Yoga-node Text renders, manual key handling in App.tsx useInput
 * - Pre-wizard state (phase, chatTarget) is saved on enter and restored on exit
 * - Future: normalize to generic WizardState<TStep, TAnswers> (see #96)
 */

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

// ── Schedule wizard ──

export type ScheduleStep = 'target' | 'message' | 'schedType' | 'timing' | 'timezone' | 'confirm' | 'done';

export type ScheduleType = 'delay' | 'at' | 'every' | 'cron';

export interface ScheduleAnswers {
  target: string;
  message: string;
  schedType: ScheduleType;
  timing: string;
  timezone: string;
  name: string;
}

export interface ScheduleWizardState {
  step: ScheduleStep;
  answers: ScheduleAnswers;
  error?: string;
  submitting?: boolean;
  prePhase: TuiPhase;
  preChatTarget?: string;
}

export const SCHEDULE_STEPS: ScheduleStep[] = ['target', 'message', 'schedType', 'timing', 'timezone', 'confirm'];

export const DEFAULT_SCHEDULE_ANSWERS: ScheduleAnswers = {
  target: '',
  message: '',
  schedType: 'every',
  timing: '',
  timezone: '',
  name: '',
};

export function defaultRecruitAnswers(defaultAgent: 'claude' | 'copilot' = 'claude'): RecruitAnswers {
  return {
    name: '',
    agent: defaultAgent,
    playerType: '',
    workDir: process.cwd(),
    initialMessage: '',
    host: 'localhost',
  };
}

/** @deprecated Use defaultRecruitAnswers(agent) instead. Kept for test compatibility. */
export const DEFAULT_RECRUIT_ANSWERS: RecruitAnswers = defaultRecruitAnswers();

// ── Create Ensemble wizard ──

export type CreateEnsembleStep = 'name' | 'workDir' | 'lineup' | 'confirm' | 'done';

export interface CreateEnsembleAnswers {
  name: string;
  workDir: string;
  lineup: string;
}

export interface CreateEnsembleState {
  step: CreateEnsembleStep;
  answers: CreateEnsembleAnswers;
  error?: string;
  submitting?: boolean;
  prePhase: TuiPhase;
}

export const CREATE_ENSEMBLE_STEPS: CreateEnsembleStep[] = ['name', 'workDir', 'lineup', 'confirm'];

export const DEFAULT_CREATE_ENSEMBLE_ANSWERS: CreateEnsembleAnswers = {
  name: '',
  workDir: process.cwd(),
  lineup: '',
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
  /** Known ensembles (null = not yet loaded, [] = loaded but empty). */
  ensembles: EnsembleSummary[] | null;
  /** Currently highlighted ensemble index (home view). */
  selectedEnsembleIndex: number;

  // ── Ensemble view ──
  /** The ensemble currently being viewed (null = home). */
  activeEnsemble: string | null;
  /** Players in the active ensemble. */
  players: MaestroPlayerInfo[];
  /** True after the first successful player poll. Reset on ensemble switch. */
  playersLoaded: boolean;
  /** Messages in the active ensemble (relay messages). */
  messages: MaestroRelayMessage[];
  /** Conductor history in the active ensemble. */
  conductorHistory: HistoryEntry[];
  /** Active schedules in the ensemble. */
  schedules: ScheduleEntry[];
  /** Maestro conversation (null = loading, [] = loaded but empty). */
  conversation: Array<{ id: string; from: string; to: string; text: string; timestamp: string; direction: 'in' | 'out'; role?: 'maestro-out' | 'maestro-in' | 'conductor-out' | 'conductor-in'; thirdParty?: boolean }> | null;
  /** Aggregated ensemble chat feed (from maestroEnsembleChat query). */
  ensembleChat: EnsembleChatMessage[];
  /** Whether the active ensemble has a conductor. */
  hasConductor: boolean;
  /** Currently highlighted player index (ensemble view). */
  selectedPlayerIndex: number;

  // ── Player view ──
  /** The player currently being inspected (null = not viewing a player). */
  activePlayer: string | null;
  /** Player's workflow metadata. */
  playerMetadata: SessionMetadata | null;
  /** Player's message history (received + sent). */
  playerMessages: Array<Message | (SentMessage & { direction: 'sent' })>;
  /** Scroll offset within the player detail view message list. */
  playerScrollOffset: number;

  // ── Chat shell ──
  /** Committed scroll-up history items. */
  staticItems: StaticItem[];
  /** Player name when in chat mode (bare text sends message to this target). */
  chatTarget?: string;
  /** Name of the conductor in the active ensemble. */
  conductorName?: string;
  /** Locally tracked sent messages (TUI has no workflow to query). */
  sentMessages: Array<{ to: string; text: string; timestamp: string }>;
  /** ID of the last message seen (for detecting new arrivals in polling). */
  lastSeenMessageId?: string;
  /** Player name pending destroy confirmation (PR-H renamed `/stop` → `/destroy`; field name kept for diff hygiene). */
  confirmingStop?: string;
  /** Optional `reason` carried from the `/destroy <player> [reason]` invocation. */
  confirmingStopReason?: string;
  /** Ensemble name pending disband confirmation (null = not confirming). */
  confirmingDisband?: string;
  /** Lineup confirmation state (pending load). */
  confirmingLineup?: { action: 'load'; path: string; summary: string };
  /** Recruit wizard state (active when phase === 'recruit'). */
  recruitState?: RecruitState;
  /** Schedule creation wizard state (active when phase === 'schedule-create'). */
  scheduleWizard?: ScheduleWizardState;
  /** Create ensemble wizard state (active when phase === 'create-ensemble'). */
  createEnsembleState?: CreateEnsembleState;
  /** Status overlay visible (shows player list). */
  statusOverlay: boolean;
  /** Generic command overlay (title + pre-formatted content). Shown by data-display commands. */
  /** Interactive overlay (schedules, gates, stages, worktrees, or generic command). */
  overlay: {
    type: string;
    title: string;
    items: Array<{ id: string; label: string; sublabel?: string }>;
    selectedIndex: number;
    hint: string;
  } | null;
  /** Scroll offset within the status overlay. */
  statusScrollOffset: number;
  /** Command palette state. */
  paletteVisible: boolean;
  paletteIndex: number;
  /** Interactive picker overlay state. */
  pickerVisible: boolean;
  pickerType: 'players' | 'ensembles' | null;
  pickerIntent: 'navigate' | null;
  pickerIndex: number;
  /** Optional status filter for player picker. */
  pickerStatusFilter: string | null;
}

export function initialState(ensemble?: string): TuiState {
  return {
    phase: ensemble ? 'main' : 'splash',
    view: ensemble ? 'ensemble' : 'home',
    splashStatus: 'Starting up...',
    splashChecks: [],
    splashConnected: false,
    splashSummary: undefined,

    ensembles: null,
    selectedEnsembleIndex: 0,

    activeEnsemble: ensemble || null,
    players: [],
    playersLoaded: false,
    messages: [],
    conductorHistory: [],
    schedules: [],
    conversation: null,
    ensembleChat: [],
    hasConductor: false,
    selectedPlayerIndex: 0,

    activePlayer: null,
    playerMetadata: null,
    playerMessages: [],
    playerScrollOffset: 0,

    staticItems: [],
    chatTarget: undefined,
    sentMessages: [],
    statusOverlay: false,
    overlay: null,
    statusScrollOffset: 0,
    paletteVisible: false,
    paletteIndex: 0,
    pickerVisible: false,
    pickerType: null,
    pickerIntent: null,
    pickerIndex: 0,
    pickerStatusFilter: null,
    confirmingStop: undefined,
    confirmingStopReason: undefined,
    scheduleWizard: undefined,
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
  | { type: 'SET_CONVERSATION'; conversation: Array<{ id: string; from: string; to: string; text: string; timestamp: string; direction: 'in' | 'out'; role?: 'maestro-out' | 'maestro-in' | 'conductor-out' | 'conductor-in'; thirdParty?: boolean }> }
  | { type: 'SET_ENSEMBLE_CHAT'; chat: EnsembleChatResult }
  | { type: 'REFRESH_PLAYER_DATA'; metadata: SessionMetadata | null; messages: Array<Message | (SentMessage & { direction: 'sent' })> }
  | { type: 'PLAYER_SCROLL_UP' }
  | { type: 'PLAYER_SCROLL_DOWN' }
  // Chat shell actions
  | { type: 'COMMIT_STATIC'; item: StaticItem }
  | { type: 'SET_CONDUCTOR'; name?: string }
  | { type: 'APPEND_SENT_MESSAGE'; to: string; text: string }
  | { type: 'HYDRATE_SENT_MESSAGES'; messages: Array<{ to: string; text: string; timestamp: string }> }
  | { type: 'ENTER_CHAT'; target: string }
  | { type: 'EXIT_CHAT' }
  // Command palette
  | { type: 'SHOW_PALETTE' }
  | { type: 'HIDE_PALETTE' }
  | { type: 'PALETTE_UP' }
  | { type: 'PALETTE_DOWN'; max?: number }
  | { type: 'PALETTE_SET_INDEX'; index: number }
  // Picker overlay
  | { type: 'SHOW_STATUS' }
  | { type: 'HIDE_STATUS' }
  | { type: 'SHOW_COMMAND_OVERLAY'; title: string; content: string }
  | { type: 'SHOW_OVERLAY'; overlay: { type: string; title: string; items: Array<{ id: string; label: string; sublabel?: string }>; hint: string } }
  | { type: 'HIDE_OVERLAY' }
  | { type: 'OVERLAY_SELECT'; direction: 'up' | 'down' }
  | { type: 'STATUS_SCROLL_UP' }
  | { type: 'STATUS_SCROLL_DOWN' }
  | { type: 'SHOW_PICKER'; pickerType: 'players' | 'ensembles'; intent?: 'navigate'; statusFilter?: string }
  | { type: 'HIDE_PICKER' }
  | { type: 'PICKER_UP' }
  | { type: 'PICKER_DOWN' }
  // Scrollback
  // Stop confirmation
  | { type: 'CONFIRM_STOP'; player: string; reason?: string }
  | { type: 'CANCEL_STOP' }
  // Disband confirmation
  | { type: 'CONFIRM_DISBAND'; ensemble: string }
  | { type: 'CANCEL_DISBAND' }
  // Lineup confirmation
  | { type: 'CONFIRM_LINEUP'; action: 'load'; path: string; summary: string }
  | { type: 'CANCEL_LINEUP' }
  // Recruit wizard
  | { type: 'ENTER_RECRUIT'; answers?: Partial<RecruitAnswers>; defaultAgent?: 'claude' | 'copilot' }
  | { type: 'RECRUIT_NEXT_STEP'; answer: Partial<RecruitAnswers> }
  | { type: 'RECRUIT_PREV_STEP' }
  | { type: 'RECRUIT_SUBMIT' }
  | { type: 'RECRUIT_DONE'; error?: string }
  | { type: 'EXIT_RECRUIT' }
  // Schedule wizard
  | { type: 'ENTER_SCHEDULE_WIZARD'; answers?: Partial<ScheduleAnswers> }
  | { type: 'SCHEDULE_NEXT_STEP'; answer: Partial<ScheduleAnswers> }
  | { type: 'SCHEDULE_PREV_STEP' }
  | { type: 'SCHEDULE_SUBMIT' }
  | { type: 'SCHEDULE_DONE'; error?: string }
  | { type: 'EXIT_SCHEDULE_WIZARD' }
  // Create ensemble wizard
  | { type: 'ENTER_CREATE_ENSEMBLE' }
  | { type: 'CREATE_ENSEMBLE_NEXT_STEP'; answer: Partial<CreateEnsembleAnswers> }
  | { type: 'CREATE_ENSEMBLE_PREV_STEP' }
  | { type: 'CREATE_ENSEMBLE_SUBMIT' }
  | { type: 'CREATE_ENSEMBLE_DONE'; error?: string; ensemble?: string }
  | { type: 'EXIT_CREATE_ENSEMBLE' };

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
        phase: 'main' as TuiPhase,
        activeEnsemble: null,
        activePlayer: null,
        conductorName: undefined,
        chatTarget: undefined,
        players: [],
        playersLoaded: false,
        messages: [],
        sentMessages: [],
        conductorHistory: [],
        schedules: [],
        conversation: null,
        playerMetadata: null,
        playerMessages: [],
        selectedPlayerIndex: 0,
      };

    case 'NAVIGATE_ENSEMBLE':
      return {
        ...state,
        view: 'ensemble',
        phase: 'main' as TuiPhase,
        activeEnsemble: action.ensemble,
        activePlayer: null,
        conductorName: undefined,
        chatTarget: undefined,
        players: [],
        playersLoaded: false,
        messages: [],
        sentMessages: [],
        conductorHistory: [],
        schedules: [],
        conversation: null,
        playerMetadata: null,
        playerMessages: [],
        selectedPlayerIndex: 0,
      };

    case 'NAVIGATE_PLAYER':
      return {
        ...state,
        view: 'player',
        activePlayer: action.playerId,
        playerMetadata: null,
        playerMessages: [],
        playerScrollOffset: 0,
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
        playersLoaded: true,
        messages: action.messages,
        conductorHistory: action.history,
        schedules: action.schedules ?? state.schedules,
        lastSeenMessageId: lastMsg?.id ?? state.lastSeenMessageId,
        // Clamp selection index
        selectedPlayerIndex: Math.min(state.selectedPlayerIndex, Math.max(0, action.players.length - 1)),
      };
    }

    case 'SET_CONVERSATION':
      return { ...state, conversation: action.conversation };

    case 'SET_ENSEMBLE_CHAT':
      return {
        ...state,
        ensembleChat: action.chat.messages,
        hasConductor: action.chat.hasConductor,
      };

    case 'REFRESH_PLAYER_DATA':
      return {
        ...state,
        playerMetadata: action.metadata,
        playerMessages: action.messages,
      };

    case 'PLAYER_SCROLL_UP':
      if (state.playerScrollOffset <= 0) return state;
      return { ...state, playerScrollOffset: state.playerScrollOffset - 1 };

    case 'PLAYER_SCROLL_DOWN': {
      const maxScroll = Math.max(0, state.playerMessages.length - 20);
      if (state.playerScrollOffset >= maxScroll) return state;
      return { ...state, playerScrollOffset: state.playerScrollOffset + 1 };
    }

    // ── Selection & Focus ──

    // ── Chat shell ──

    case 'COMMIT_STATIC': {
      const newItems = [...state.staticItems, action.item];
      // Trim to last 500 entries for memory management
      const trimmed = newItems.length > 500 ? newItems.slice(-500) : newItems;
      return { ...state, staticItems: trimmed };
    }

    // ── Command palette ──

    case 'SHOW_PALETTE':
      if (state.paletteVisible && state.paletteIndex === 0) return state;
      return { ...state, paletteVisible: true, paletteIndex: 0 };

    case 'HIDE_PALETTE':
      if (!state.paletteVisible && state.paletteIndex === 0) return state;
      return { ...state, paletteVisible: false, paletteIndex: 0 };

    case 'PALETTE_UP': {
      // #108: identity-preserving — returning `{ ...state, paletteIndex: same }`
      // forces a re-render of the full app tree even when the value didn't change
      // (e.g. holding arrow-up at index 0). Mirrors the OVERLAY_SELECT pattern
      // below. See CLAUDE.md "Reducer state identity matters".
      const next = Math.max(0, state.paletteIndex - 1);
      if (next === state.paletteIndex) return state;
      return { ...state, paletteIndex: next };
    }

    case 'PALETTE_DOWN': {
      // #108: same identity-preserving guard — holding arrow-down at the clamped
      // max must not trigger spurious re-renders.
      const next = state.paletteIndex + 1;
      const clamped = action.max != null ? Math.min(next, action.max) : next;
      if (clamped === state.paletteIndex) return state;
      return { ...state, paletteIndex: clamped };
    }

    case 'PALETTE_SET_INDEX':
      return { ...state, paletteIndex: action.index };

    // ── Picker overlay ──

    case 'SHOW_STATUS':
      return { ...state, statusOverlay: true, statusScrollOffset: 0 };
    case 'HIDE_STATUS':
      return { ...state, statusOverlay: false, statusScrollOffset: 0 };

    case 'SHOW_COMMAND_OVERLAY':
      return { ...state, overlay: { type: 'command', title: action.title, items: [{ id: '_', label: action.content }], selectedIndex: 0, hint: 'esc \u2014 close' } };

    case 'SHOW_OVERLAY':
      return { ...state, overlay: { ...action.overlay, selectedIndex: 0 } };
    case 'HIDE_OVERLAY':
      if (!state.overlay) return state;
      return { ...state, overlay: null };
    case 'OVERLAY_SELECT': {
      if (!state.overlay || state.overlay.items.length === 0) return state;
      const len = state.overlay.items.length;
      const idx = action.direction === 'up'
        ? (state.overlay.selectedIndex - 1 + len) % len
        : (state.overlay.selectedIndex + 1) % len;
      if (idx === state.overlay.selectedIndex) return state;
      return { ...state, overlay: { ...state.overlay, selectedIndex: idx } };
    }
    case 'STATUS_SCROLL_UP': {
      const next = Math.max(0, state.statusScrollOffset - 1);
      if (next === state.statusScrollOffset) return state;
      return { ...state, statusScrollOffset: next };
    }
    case 'STATUS_SCROLL_DOWN':
      // #250: intentional — no upper-bound clamp lives in the reducer. The max
      // offset depends on `players.length` and `contentHeight`, neither of which
      // the reducer can see. `StatusOverlay` performs the final clamp via
      // `Math.min(scrollOffset, max)` at render (components/StatusOverlay.tsx).
      // Leaving the reducer unbounded + render-time clamping is cheaper than
      // threading the render-time max back through every dispatch.
      return { ...state, statusScrollOffset: state.statusScrollOffset + 1 };

    case 'SHOW_PICKER':
      return { ...state, pickerVisible: true, pickerType: action.pickerType, pickerIntent: action.intent || null, pickerIndex: 0, pickerStatusFilter: action.statusFilter || null };

    case 'HIDE_PICKER':
      return { ...state, pickerVisible: false, pickerType: null, pickerIntent: null, pickerIndex: 0, pickerStatusFilter: null };

    case 'PICKER_UP': {
      const next = Math.max(0, state.pickerIndex - 1);
      if (next === state.pickerIndex) return state;
      return { ...state, pickerIndex: next };
    }

    case 'PICKER_DOWN': {
      const maxIdx = (state.pickerType === 'ensembles' ? (state.ensembles?.length ?? 0) : state.players.length - 1);
      if (state.pickerIndex >= maxIdx) return state;
      return { ...state, pickerIndex: state.pickerIndex + 1 };
    }

    case 'SET_CONDUCTOR':
      return { ...state, conductorName: action.name };

    case 'APPEND_SENT_MESSAGE': {
      const newSent = [...state.sentMessages, { to: action.to, text: action.text, timestamp: new Date().toISOString() }];
      const trimmedSent = newSent.length > 200 ? newSent.slice(-200) : newSent;
      return { ...state, sentMessages: trimmedSent };
    }

    case 'HYDRATE_SENT_MESSAGES': {
      // Merge server-side sent messages, dedup by text+timestamp
      const existing = new Set(state.sentMessages.map(m => `${m.text.slice(0, 60)}:${m.timestamp}`));
      const newMsgs = action.messages.filter(m => !existing.has(`${m.text.slice(0, 60)}:${m.timestamp}`));
      if (newMsgs.length === 0) return state;
      return { ...state, sentMessages: [...state.sentMessages, ...newMsgs] };
    }

    case 'ENTER_CHAT':
      return { ...state, phase: 'chat' as TuiPhase, chatTarget: action.target };

    case 'EXIT_CHAT':
      return { ...state, phase: 'main' as TuiPhase, chatTarget: undefined };

    // ── Destroy confirmation (PR-H: was `/stop`; renamed to `/destroy`) ──

    case 'CONFIRM_STOP':
      return {
        ...state,
        confirmingStop: action.player,
        ...(action.reason !== undefined ? { confirmingStopReason: action.reason } : { confirmingStopReason: undefined }),
      };

    case 'CANCEL_STOP':
      return { ...state, confirmingStop: undefined, confirmingStopReason: undefined };

    // ── Disband confirmation ──

    case 'CONFIRM_DISBAND':
      return { ...state, confirmingDisband: action.ensemble };

    case 'CANCEL_DISBAND':
      return { ...state, confirmingDisband: undefined };

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
          answers: { ...defaultRecruitAnswers(action.defaultAgent), ...action.answers },
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

    // ── Schedule wizard ──

    case 'ENTER_SCHEDULE_WIZARD':
      return {
        ...state,
        phase: 'schedule-create' as TuiPhase,
        scheduleWizard: {
          step: 'target',
          answers: { ...DEFAULT_SCHEDULE_ANSWERS, ...action.answers },
          prePhase: state.phase,
          preChatTarget: state.chatTarget,
        },
      };

    case 'SCHEDULE_NEXT_STEP': {
      if (!state.scheduleWizard) return state;
      const answers = { ...state.scheduleWizard.answers, ...action.answer };
      const currentIdx = SCHEDULE_STEPS.indexOf(state.scheduleWizard.step);
      // Skip timezone step for non-cron types
      let nextIdx = currentIdx + 1;
      if (SCHEDULE_STEPS[nextIdx] === 'timezone' && answers.schedType !== 'cron') {
        nextIdx++;
      }
      const nextStep = SCHEDULE_STEPS[nextIdx] ?? state.scheduleWizard.step;
      return {
        ...state,
        scheduleWizard: { ...state.scheduleWizard, step: nextStep, answers },
      };
    }

    case 'SCHEDULE_PREV_STEP': {
      if (!state.scheduleWizard) return state;
      const currentIdx = SCHEDULE_STEPS.indexOf(state.scheduleWizard.step);
      if (currentIdx <= 0) return state;
      let prevIdx = currentIdx - 1;
      // Skip timezone going back for non-cron
      if (SCHEDULE_STEPS[prevIdx] === 'timezone' && state.scheduleWizard.answers.schedType !== 'cron') {
        prevIdx--;
      }
      const prevStep = SCHEDULE_STEPS[Math.max(0, prevIdx)];
      return {
        ...state,
        scheduleWizard: { ...state.scheduleWizard, step: prevStep },
      };
    }

    case 'SCHEDULE_SUBMIT':
      if (!state.scheduleWizard) return state;
      return {
        ...state,
        scheduleWizard: { ...state.scheduleWizard, submitting: true },
      };

    case 'SCHEDULE_DONE':
      if (!state.scheduleWizard) return state;
      return {
        ...state,
        scheduleWizard: {
          ...state.scheduleWizard,
          step: 'done',
          submitting: false,
          error: action.error,
        },
      };

    case 'EXIT_SCHEDULE_WIZARD': {
      const restoreP = state.scheduleWizard?.prePhase || 'main';
      const restoreC = state.scheduleWizard?.preChatTarget;
      return {
        ...state,
        phase: restoreP,
        chatTarget: restoreC,
        scheduleWizard: undefined,
      };
    }

    // ── Create Ensemble wizard ──

    case 'ENTER_CREATE_ENSEMBLE':
      return {
        ...state,
        phase: 'create-ensemble' as TuiPhase,
        createEnsembleState: {
          step: 'name',
          answers: { ...DEFAULT_CREATE_ENSEMBLE_ANSWERS },
          prePhase: state.phase,
        },
      };

    case 'CREATE_ENSEMBLE_NEXT_STEP': {
      if (!state.createEnsembleState) return state;
      const answers = { ...state.createEnsembleState.answers, ...action.answer };
      const currentIdx = CREATE_ENSEMBLE_STEPS.indexOf(state.createEnsembleState.step);
      const nextStep = CREATE_ENSEMBLE_STEPS[currentIdx + 1] ?? state.createEnsembleState.step;
      return {
        ...state,
        createEnsembleState: { ...state.createEnsembleState, step: nextStep, answers },
      };
    }

    case 'CREATE_ENSEMBLE_PREV_STEP': {
      if (!state.createEnsembleState) return state;
      const currentIdx = CREATE_ENSEMBLE_STEPS.indexOf(state.createEnsembleState.step);
      if (currentIdx <= 0) return state;
      const prevStep = CREATE_ENSEMBLE_STEPS[currentIdx - 1];
      return {
        ...state,
        createEnsembleState: { ...state.createEnsembleState, step: prevStep },
      };
    }

    case 'CREATE_ENSEMBLE_SUBMIT':
      if (!state.createEnsembleState) return state;
      return {
        ...state,
        createEnsembleState: { ...state.createEnsembleState, submitting: true },
      };

    case 'CREATE_ENSEMBLE_DONE':
      if (!state.createEnsembleState) return state;
      if (!action.error && action.ensemble) {
        // Success — navigate to new ensemble
        return {
          ...state,
          phase: 'main' as TuiPhase,
          view: 'ensemble' as TuiView,
          activeEnsemble: action.ensemble,
          createEnsembleState: undefined,
          players: [],
          messages: [],
          sentMessages: [],
          conductorHistory: [],
          schedules: [],
          conversation: null,
          selectedPlayerIndex: 0,
        };
      }
      return {
        ...state,
        createEnsembleState: {
          ...state.createEnsembleState,
          step: 'done',
          submitting: false,
          error: action.error,
        },
      };

    case 'EXIT_CREATE_ENSEMBLE': {
      const restoreCE = state.createEnsembleState?.prePhase || 'main';
      return {
        ...state,
        phase: restoreCE,
        createEnsembleState: undefined,
      };
    }

    default:
      return state;
  }
}
