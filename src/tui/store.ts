/**
 * TUI state management — useReducer + React context.
 * No external state libraries. All state flows through a single dispatch.
 *
 * Supports multi-ensemble navigation: home -> ensemble -> player views.
 */
import type {
  AttachmentPhase,
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

/** Conversation-entry shape rendered by `ConversationStream`. */
export interface ConversationEntry {
  id: string;
  from: string;
  to: string;
  text: string;
  timestamp: string;
  direction: 'in' | 'out';
  role?: 'maestro-out' | 'maestro-in' | 'conductor-out' | 'conductor-in';
  thirdParty?: boolean;
  /**
   * #357: Mirrors `EnsembleChatMessage.broadcastId`. Threaded through
   * `toConversationEntry` so the TUI's `ConversationStream.foldByBroadcastId`
   * can collapse consecutive entries sharing the same id into one row.
   */
  broadcastId?: string;
}

/**
 * Project an `EnsembleChatMessage` into a `ConversationEntry`. Shared by
 * the reducer's incremental path (`APPEND_CHAT_MESSAGE`) and the SSE
 * snapshot/recovery paths (`src/tui/sse-handler.ts`) so both produce the
 * same shape.
 */
export function toConversationEntry(m: EnsembleChatMessage): ConversationEntry {
  return {
    id: m.id,
    from: m.from,
    to: m.to,
    text: m.text,
    timestamp: m.timestamp,
    direction: m.role === 'maestro-out' ? 'out' : 'in',
    role: m.role,
    thirdParty: m.role === 'conductor-out' || m.role === 'conductor-in',
    // #357: forward broadcastId so the renderer can fold fan-out groups.
    ...(m.broadcastId !== undefined ? { broadcastId: m.broadcastId } : {}),
  };
}

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

// ── Notifications (bottom-pinned, auto-expiring) ──

/**
 * #306: Bottom-pinned ephemeral notifications for errors + warnings.
 *
 * Before #306 these rode `commitStatic('error'|'warn', …)` and scrolled out
 * of view — users missed critical guard errors (e.g. `/destroy conductor`
 * refusals) because a few lines of other output pushed them above the fold.
 * Notifications render below the prompt, auto-dismiss on TTL, and can be
 * dismissed with Esc.
 */
export interface NotificationItem {
  id: number;
  kind: 'error' | 'warn' | 'info';
  content: string;
  timestamp: number;
  /** Absolute ms epoch when this notification should disappear. */
  expiresAt: number;
}

/** Default TTLs by kind — errors get extra time to read. */
export const NOTIFICATION_TTL_MS = {
  error: 8000,
  warn: 5000,
  info: 5000,
} as const;

/** Maximum concurrent notifications; oldest is dropped when exceeded. */
export const NOTIFICATION_CAP = 3;

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
  conversation: ConversationEntry[] | null;
  /** Aggregated ensemble chat feed (from maestroEnsembleChat query). */
  ensembleChat: EnsembleChatMessage[];
  /** Whether the active ensemble has a conductor. */
  hasConductor: boolean;
  /**
   * Bug B: Whether the active ensemble's maestro hub is paused. Polled
   * alongside players/chat. The conductor's session-level `paused` flag
   * blocks outbox dispatch, so the TUI surfaces this in the status bar
   * (`paused` segment) so users don't wonder why typed messages aren't
   * getting a reply. Optimistically toggled by `/pause` and `/play`.
   */
  ensemblePaused: boolean;
  /**
   * #306 follow-up: Whether at least one session in the active ensemble
   * has its outbox locked (`held`). Mirrors {@link ensemblePaused} —
   * polled in the same 2s loop, reset on nav transitions, optimistically
   * cleared by `/play` and `/go`. Drives the StatusBar `held` segment +
   * the "Tip: type /go" hint pinned below the input.
   *
   * Independent of `ensemblePaused` because `/load_lineup` produces
   * paused + held simultaneously, and resuming both requires `/play`
   * AND `/go`. Without surfacing held separately, users got stuck
   * unpausing an ensemble that still had every player frozen.
   */
  ensembleHeld: boolean;
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
  /**
   * #306: Bottom-pinned ephemeral notifications — errors/warnings that must
   * stay visible until dismissed rather than scrolling off the top. The
   * renderer filters expired entries on every tick via a separate state
   * counter so the auto-dismiss doesn't need a reducer pass.
   */
  notifications: NotificationItem[];
  /**
   * #306: Monotonic tick counter — bumped every 500ms by a root-level effect
   * to force re-renders so expired notifications disappear without requiring
   * a reducer action per expiration. Cheap — a single integer diff.
   */
  notificationTick: number;
  /** Player name when in chat mode (bare text sends message to this target). */
  chatTarget?: string;
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
  /**
   * Ensemble name pending `/destroy <ensemble>` typed-name confirmation.
   * Distinct from `confirmingDisband` because the gate is typed-name rather
   * than y/N.
   */
  confirmingEnsembleDestroy?: {
    ensemble: string;
    /** Current contents of the typed-confirmation input. */
    input: string;
    /** Mismatch error shown beneath the input; cleared on next keystroke. */
    error?: string;
    submitting?: boolean;
  };
  /** Lineup confirmation state (pending load). */
  confirmingLineup?: { action: 'load'; path: string; summary: string };
  /** Recruit wizard state (active when phase === 'recruit'). */
  recruitState?: RecruitState;
  /** Schedule creation wizard state (active when phase === 'schedule-create'). */
  scheduleWizard?: ScheduleWizardState;
  /** Create ensemble wizard state (active when phase === 'create-ensemble'). */
  createEnsembleState?: CreateEnsembleState;
  /**
   * Home-view modal overlay. `undefined` = no modal. Restore carries the
   * target ensemble + conductor name + parked player count so the
   * confirmation body doesn't re-query the backend.
   */
  homeModal?:
    | { type: 'new' }
    | { type: 'lineup' }
    | { type: 'restore'; ensemble: string; playerCount: number; conductor?: string };
  /** True while a home-view modal's submit handler is in flight. */
  homeModalSubmitting?: boolean;
  /** Error surfaced inside the active home modal (spawn failure, etc.). */
  homeModalError?: string;
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
    ensemblePaused: false,
    ensembleHeld: false,
    selectedPlayerIndex: 0,

    activePlayer: null,
    playerMetadata: null,
    playerMessages: [],
    playerScrollOffset: 0,

    staticItems: [],
    notifications: [],
    notificationTick: 0,
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
  | { type: 'SET_CONVERSATION'; conversation: ConversationEntry[] }
  | { type: 'SET_ENSEMBLE_CHAT'; chat: EnsembleChatResult }
  // ── #94/#95 PR-4a: incremental updates from the SSE event stream ──
  /** Append one new chat message — used by `event: chat.appended`. Updates `ensembleChat` and `conversation` together. */
  | { type: 'APPEND_CHAT_MESSAGE'; message: EnsembleChatMessage }
  /**
   * Insert or update a player by `playerId` — used by `event: player.added`.
   *
   * **Invariant**: `player` MUST be a complete `MaestroPlayerInfo` snapshot.
   * The reducer's `{...existing, ...incoming}` merge will clobber any fields
   * omitted from `incoming` with `undefined`. For sparse updates (e.g.
   * `phase`-only), use `PATCH_PLAYER_PHASE` (introduced for #351) — extend
   * that pattern to other fields rather than passing partial payloads here.
   */
  | { type: 'UPSERT_PLAYER'; player: MaestroPlayerInfo }
  /**
   * Patch only the `phase` field of an existing player — used by
   * `event: player.phase_changed`. The wire payload for that event is
   * deliberately sparse (only `playerId`, `ensemble`, `phase`, plus a
   * couple of optional timestamps); routing through `UPSERT_PLAYER`
   * would force the handler to fill `hostname`/`part`/`isConductor`
   * with empty defaults, and the reducer's `{...existing, ...incoming}`
   * spread would then clobber the real values cached from the snapshot.
   * Phase-only patching keeps the rest of the row intact. See #351.
   */
  | { type: 'PATCH_PLAYER_PHASE'; playerId: string; phase: AttachmentPhase }
  /** Remove a player by `playerId` — used by `event: player.removed`. */
  | { type: 'REMOVE_PLAYER'; playerId: string }
  /** Replace the schedules slice — used by `event: schedules.changed`. */
  | { type: 'SET_SCHEDULES'; schedules: ScheduleEntry[] }
  | { type: 'REFRESH_PLAYER_DATA'; metadata: SessionMetadata | null; messages: Array<Message | (SentMessage & { direction: 'sent' })> }
  | { type: 'PLAYER_SCROLL_UP' }
  | { type: 'PLAYER_SCROLL_DOWN' }
  // Chat shell actions
  | { type: 'COMMIT_STATIC'; item: StaticItem }
  // Bottom-pinned notifications (#306)
  | { type: 'ADD_NOTIFICATION'; notification: NotificationItem }
  | { type: 'DISMISS_NOTIFICATION'; id: number }
  | { type: 'DISMISS_OLDEST_NOTIFICATION' }
  | { type: 'CLEAR_NOTIFICATIONS' }
  | { type: 'NOTIFICATION_TICK' }
  | { type: 'SET_ENSEMBLE_PAUSED'; paused: boolean }
  | { type: 'SET_ENSEMBLE_HELD'; held: boolean }
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
  // Ensemble-scope /destroy typed-name confirmation
  | { type: 'CONFIRM_ENSEMBLE_DESTROY'; ensemble: string }
  | { type: 'ENSEMBLE_DESTROY_INPUT'; input: string }
  | { type: 'ENSEMBLE_DESTROY_SUBMIT_BUSY' }
  | { type: 'ENSEMBLE_DESTROY_MISMATCH' }
  | { type: 'CANCEL_ENSEMBLE_DESTROY' }
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
  | { type: 'EXIT_CREATE_ENSEMBLE' }
  // Home-view modals
  | { type: 'OPEN_HOME_MODAL'; modal: NonNullable<TuiState['homeModal']> }
  | { type: 'CLOSE_HOME_MODAL' }
  | { type: 'SET_HOME_MODAL_STATUS'; submitting?: boolean; error?: string };

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
      // Auto-select was removed from the poller (#306 follow-up): HomeView
      // is the explicit ensemble picker, so once the user lands on home they
      // stay there until they pick an ensemble themselves. This action just
      // resets ensemble/player state and the chat shell.
      return {
        ...state,
        view: 'home',
        phase: 'main' as TuiPhase,
        activeEnsemble: null,
        activePlayer: null,
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
        ensemblePaused: false,
        ensembleHeld: false,
        selectedPlayerIndex: 0,
      };

    case 'NAVIGATE_ENSEMBLE':
      return {
        ...state,
        view: 'ensemble',
        phase: 'main' as TuiPhase,
        activeEnsemble: action.ensemble,
        activePlayer: null,
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
        ensemblePaused: false,
        ensembleHeld: false,
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

    // ── #94/#95 PR-4a — SSE event stream incremental updates ──

    case 'APPEND_CHAT_MESSAGE': {
      // `chat.appended` SSE events arrive one-per-message. We push onto
      // `ensembleChat` and derive a matching conversation entry via
      // `toConversationEntry` (also used by the snapshot path), so
      // ChatView/ConversationStream see a continuous timeline. Cap the
      // in-memory slice at 500 to bound memory on long-running sessions;
      // PR-4b will adjust this as part of the scroll-view migration.
      const m = action.message;
      const newChat = [...state.ensembleChat, m];
      const cappedChat = newChat.length > 500 ? newChat.slice(-500) : newChat;
      const baseConv = state.conversation ?? [];
      const newConv = [...baseConv, toConversationEntry(m)];
      const cappedConv = newConv.length > 500 ? newConv.slice(-500) : newConv;
      return { ...state, ensembleChat: cappedChat, conversation: cappedConv };
    }

    case 'UPSERT_PLAYER': {
      // `player.added` and `player.phase_changed` both land here — added
      // creates a new entry; phase_changed updates fields on the existing
      // entry. Identity-preserving when the wire payload matches the
      // current cached entry exactly so StatusBar/MainView don't churn
      // on duplicate events (e.g. a quick disconnect/reconnect).
      const incoming = action.player;
      const idx = state.players.findIndex((p) => p.playerId === incoming.playerId);
      if (idx === -1) {
        return { ...state, players: [...state.players, incoming], playersLoaded: true };
      }
      const existing = state.players[idx];
      const merged = { ...existing, ...incoming };
      const fieldsEqual =
        existing.phase === merged.phase
        && existing.part === merged.part
        && existing.hostname === merged.hostname
        && existing.workDir === merged.workDir
        && existing.isConductor === merged.isConductor
        && existing.gitBranch === merged.gitBranch
        && existing.playerType === merged.playerType
        && existing.agentType === merged.agentType;
      if (fieldsEqual) return state;
      const next = state.players.slice();
      next[idx] = merged;
      return { ...state, players: next };
    }

    case 'PATCH_PLAYER_PHASE': {
      // Rationale on the action type. Identity-preserving guard mirrors
      // SET_ENSEMBLE_PAUSED — same StatusBar churn rationale.
      const idx = state.players.findIndex((p) => p.playerId === action.playerId);
      if (idx === -1) return state;
      if (state.players[idx].phase === action.phase) return state;
      const next = state.players.slice();
      next[idx] = { ...state.players[idx], phase: action.phase };
      return { ...state, players: next };
    }

    case 'REMOVE_PLAYER': {
      const next = state.players.filter((p) => p.playerId !== action.playerId);
      if (next.length === state.players.length) return state;
      return {
        ...state,
        players: next,
        selectedPlayerIndex: Math.min(state.selectedPlayerIndex, Math.max(0, next.length - 1)),
      };
    }

    case 'SET_SCHEDULES':
      return { ...state, schedules: action.schedules };

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

    // ── Bottom-pinned notifications (#306) ──

    case 'ADD_NOTIFICATION': {
      const now = Date.now();
      // Filter out expired entries before appending so the cap check isn't
      // polluted by stale notifications that should already be gone.
      const live = state.notifications.filter(n => n.expiresAt > now);
      const appended = [...live, action.notification];
      // Cap at NOTIFICATION_CAP — oldest drops off when exceeded.
      const capped = appended.length > NOTIFICATION_CAP
        ? appended.slice(appended.length - NOTIFICATION_CAP)
        : appended;
      return { ...state, notifications: capped };
    }

    case 'DISMISS_NOTIFICATION': {
      const next = state.notifications.filter(n => n.id !== action.id);
      if (next.length === state.notifications.length) return state;
      return { ...state, notifications: next };
    }

    case 'DISMISS_OLDEST_NOTIFICATION': {
      // Filter-expired-first so Esc acts on what the user actually sees.
      const now = Date.now();
      const live = state.notifications.filter(n => n.expiresAt > now);
      if (live.length === 0) {
        // Still compact if any expired slipped through — keeps the array clean
        if (live.length !== state.notifications.length) {
          return { ...state, notifications: live };
        }
        return state;
      }
      return { ...state, notifications: live.slice(1) };
    }

    case 'CLEAR_NOTIFICATIONS': {
      if (state.notifications.length === 0) return state;
      return { ...state, notifications: [] };
    }

    case 'NOTIFICATION_TICK': {
      // Cheap re-render trigger so expired notifications disappear from the
      // rendered stack without requiring a reducer action per expiration.
      // The render pass filters by `expiresAt > Date.now()`. Only the counter
      // changes — we leave the notifications array alone to avoid thrashing
      // the React children identity.
      return { ...state, notificationTick: state.notificationTick + 1 };
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

    case 'SET_ENSEMBLE_PAUSED':
      // Identity-preserving: skip the dispatch when value didn't change so
      // the StatusBar tree doesn't re-render every poll tick.
      if (state.ensemblePaused === action.paused) return state;
      return { ...state, ensemblePaused: action.paused };

    case 'SET_ENSEMBLE_HELD':
      // Identity-preserving — same rationale as SET_ENSEMBLE_PAUSED. The
      // 2s held-poll would otherwise reconcile the StatusBar every tick
      // even when nothing changed.
      if (state.ensembleHeld === action.held) return state;
      return { ...state, ensembleHeld: action.held };

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

    case 'OPEN_HOME_MODAL':
      return {
        ...state,
        homeModal: action.modal,
        homeModalSubmitting: false,
        homeModalError: undefined,
      };

    case 'CLOSE_HOME_MODAL':
      return {
        ...state,
        homeModal: undefined,
        homeModalSubmitting: false,
        homeModalError: undefined,
      };

    case 'SET_HOME_MODAL_STATUS':
      return {
        ...state,
        homeModalSubmitting: action.submitting ?? state.homeModalSubmitting,
        homeModalError: action.error,
      };

    case 'CONFIRM_ENSEMBLE_DESTROY':
      return {
        ...state,
        confirmingEnsembleDestroy: { ensemble: action.ensemble, input: '' },
      };

    case 'ENSEMBLE_DESTROY_INPUT': {
      if (!state.confirmingEnsembleDestroy) return state;
      return {
        ...state,
        confirmingEnsembleDestroy: {
          ...state.confirmingEnsembleDestroy,
          input: action.input,
          error: undefined,
        },
      };
    }

    case 'ENSEMBLE_DESTROY_SUBMIT_BUSY': {
      if (!state.confirmingEnsembleDestroy) return state;
      return {
        ...state,
        confirmingEnsembleDestroy: { ...state.confirmingEnsembleDestroy, submitting: true, error: undefined },
      };
    }

    case 'ENSEMBLE_DESTROY_MISMATCH': {
      if (!state.confirmingEnsembleDestroy) return state;
      const { ensemble, input } = state.confirmingEnsembleDestroy;
      return {
        ...state,
        confirmingEnsembleDestroy: {
          ...state.confirmingEnsembleDestroy,
          submitting: false,
          error: `"${input}" \u2260 "${ensemble}" \u2014 type the ensemble name exactly to confirm.`,
        },
      };
    }

    case 'CANCEL_ENSEMBLE_DESTROY':
      return { ...state, confirmingEnsembleDestroy: undefined };

    default:
      return state;
  }
}
