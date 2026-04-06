/**
 * Root TUI application component — chat-focused shell with slash commands.
 *
 * Layout (top to bottom):
 * - TitleBar (pinned)
 * - Divider
 * - Static scroll-up history
 * - Live content area (splash, main, chat, error)
 * - Divider
 * - PromptArea (pinned)
 */
import React, { useReducer, useEffect, useCallback, useMemo } from 'react';
import { useInk } from './ink-context';
import { tuiReducer, initialState } from './store';
import type { StaticItem } from './store';
import { Splash } from './components/Splash';
import { MainView } from './components/MainView';
import { ChatView } from './components/ChatView';
import type { ChatMessage } from './components/ChatView';
import { ErrorView } from './components/ErrorView';
import { RecruitWizard } from './components/RecruitWizard';
import { TitleBar } from './components/TitleBar';
import { PromptArea } from './components/PromptArea';
import { parseCommand, isValidCommand, formatHelpSummary, COMMANDS } from './commands';
import { THEME } from './utils/theme';
import type { TempoClient } from './client';

// eslint-disable-next-line @typescript-eslint/no-var-requires
const packageVersion: string = require('../../package.json').version;

interface AppProps {
  api: TempoClient;
  /** If provided, start directly in ensemble view. */
  ensemble?: string;
}

let staticIdCounter = 0;
function nextStaticId(): string {
  return `static-${++staticIdCounter}`;
}

/** Color for static item text. */
function staticItemColor(item: StaticItem): string {
  switch (item.type) {
    case 'error': return THEME.error;
    case 'message': return THEME.accent;
    case 'splash-done': return THEME.success;
    case 'info': return THEME.textMuted;
    case 'command-output': return THEME.text;
    default: return THEME.text;
  }
}

export function App({ api, ensemble }: AppProps) {
  const { Box, Text, Static, useApp, useInput } = useInk();
  const [state, dispatch] = useReducer(tuiReducer, initialState(ensemble));
  const { exit } = useApp();

  // ── Global keybindings ──
  useInput(useCallback((input: string, key: any) => {
    if (key.ctrl && input === 'c') {
      exit();
    }
  }, [exit]));

  // ── Context string for title bar ──
  const contextString = useMemo(() => {
    if (state.phase === 'splash') return 'Starting up...';
    if (state.phase === 'error') return 'Error';
    if (state.chatTarget) {
      const player = state.players.find(p => p.playerId === state.chatTarget);
      const status = player?.status || 'unknown';
      return `cue \u2192 ${state.chatTarget} \u00b7 ${status}`;
    }
    if (state.activeEnsemble) {
      const count = state.players.length;
      return `${state.activeEnsemble} \u00b7 ${count} player${count !== 1 ? 's' : ''} \u00b7 Connected`;
    }
    const count = state.ensembles.length;
    return `${count} ensemble${count !== 1 ? 's' : ''} \u00b7 Connected`;
  }, [state.phase, state.chatTarget, state.activeEnsemble, state.players, state.ensembles]);

  // ── Hint text for prompt area ──
  const promptHints = useMemo(() => {
    if (state.phase === 'recruit') {
      return 'Follow the prompts above. Esc to cancel.';
    }
    if (state.chatTarget) {
      return 'Type a message to send, or /back to exit chat mode';
    }
    return '/cue /recruit /stop /broadcast /help /quit';
  }, [state.phase, state.chatTarget]);

  // ── Command submission handler ──
  const handleSubmit = useCallback(async (input: string) => {
    const trimmed = input.trim();
    if (!trimmed) return;

    dispatch({ type: 'SET_INPUT', value: '' });

    const parsed = parseCommand(trimmed);

    if (parsed) {
      // Slash command
      if (parsed.name === 'quit') {
        exit();
        return;
      }
      if (parsed.name === 'back') {
        if (state.chatTarget) {
          dispatch({ type: 'EXIT_CHAT' });
        } else if (state.activeEnsemble) {
          dispatch({ type: 'NAVIGATE_HOME' });
        }
        return;
      }
      if (parsed.name === 'help') {
        dispatch({
          type: 'COMMIT_STATIC',
          item: {
            id: nextStaticId(),
            type: 'command-output',
            content: formatHelpSummary(),
            timestamp: Date.now(),
          },
        });
        return;
      }

      if (!isValidCommand(parsed.name)) {
        dispatch({
          type: 'COMMIT_STATIC',
          item: {
            id: nextStaticId(),
            type: 'error',
            content: `Unknown command: /${parsed.name}. Type /help for available commands.`,
            timestamp: Date.now(),
          },
        });
        return;
      }

      // Command exists but handler not yet implemented
      const cmd = COMMANDS[parsed.name];
      if (!cmd.handler) {
        dispatch({
          type: 'COMMIT_STATIC',
          item: {
            id: nextStaticId(),
            type: 'info',
            content: `/${parsed.name}: coming soon. Usage: ${cmd.usage}`,
            timestamp: Date.now(),
          },
        });
        return;
      }

      // Execute handler
      try {
        const ctx = { activeEnsemble: state.activeEnsemble };
        await cmd.handler(parsed.args, dispatch, api, ctx);
      } catch (err) {
        dispatch({
          type: 'COMMIT_STATIC',
          item: {
            id: nextStaticId(),
            type: 'error',
            content: `Error running /${parsed.name}: ${err}`,
            timestamp: Date.now(),
          },
        });
      }
    } else if (state.chatTarget) {
      // Bare text in chat mode → send cue to target
      if (!state.activeEnsemble) {
        dispatch({
          type: 'COMMIT_STATIC',
          item: { id: nextStaticId(), type: 'error', content: 'No active ensemble. Use /ensemble <name> first.', timestamp: Date.now() },
        });
        return;
      }
      try {
        await api.sendMessage(state.activeEnsemble, state.chatTarget, trimmed, 'tui');
        dispatch({
          type: 'COMMIT_STATIC',
          item: {
            id: nextStaticId(),
            type: 'message',
            content: `\u2714 ${state.chatTarget}: ${trimmed}`,
            timestamp: Date.now(),
          },
        });
      } catch (err) {
        dispatch({
          type: 'COMMIT_STATIC',
          item: {
            id: nextStaticId(),
            type: 'error',
            content: `\u2717 Failed to deliver: ${err}`,
            timestamp: Date.now(),
          },
        });
      }
    } else {
      // Bare text in main mode — hint to use commands
      dispatch({
        type: 'COMMIT_STATIC',
        item: {
          id: nextStaticId(),
          type: 'info',
          content: 'Use /commands to interact. Type /help for available commands.',
          timestamp: Date.now(),
        },
      });
    }
  }, [state.chatTarget, state.activeEnsemble, api, exit]);

  // ── Startup sequence: splash → main/connected ──
  useEffect(() => {
    let cancelled = false;

    async function connect() {
      const splashStart = Date.now();
      const MIN_SPLASH_MS = 2500;
      type Check = { label: string; done: boolean; error?: boolean };
      const checks: Check[] = [];

      // Helper: push a check and dispatch
      function addCheck(label: string, done: boolean, error?: boolean) {
        checks.push({ label, done, error });
        if (!cancelled) dispatch({ type: 'SET_SPLASH_CHECKS', checks: [...checks] });
      }

      // Helper: mark the last pending check as done
      function completeLastCheck() {
        if (checks.length > 0) {
          checks[checks.length - 1] = { ...checks[checks.length - 1], done: true };
          if (!cancelled) dispatch({ type: 'SET_SPLASH_CHECKS', checks: [...checks] });
        }
      }

      // Step 1: Connect to Temporal
      dispatch({ type: 'SET_SPLASH_STATUS', status: 'Connecting to Temporal...' });
      addCheck('Connecting to Temporal server...', false);

      const connected = await api.isConnected();
      if (cancelled) return;

      if (!connected) {
        checks[checks.length - 1] = { label: 'Cannot reach Temporal server', done: true, error: true };
        dispatch({ type: 'SET_SPLASH_CHECKS', checks: [...checks] });
        dispatch({ type: 'SET_PHASE', phase: 'error', error: 'Cannot connect to Temporal. Run `claude-tempo up` first.' });
        return;
      }

      completeLastCheck();
      checks[checks.length - 1] = { label: 'Temporal server connected', done: true };
      dispatch({ type: 'SET_SPLASH_CHECKS', checks: [...checks] });

      // Step 2: Discover ensembles / load data
      dispatch({ type: 'SET_SPLASH_STATUS', status: 'Discovering ensembles...' });
      addCheck('Discovering ensembles...', false);

      let playerCount = 0;
      let conductorName: string | undefined;
      let scheduleCount = 0;
      let ensembleName = state.activeEnsemble || 'all';

      if (state.activeEnsemble) {
        try {
          const [players, messages, history, schedules] = await Promise.all([
            api.getPlayers(state.activeEnsemble),
            api.getMessages(state.activeEnsemble, 50),
            api.getConductorHistory(state.activeEnsemble),
            api.getSchedules(state.activeEnsemble),
          ]);
          if (cancelled) return;
          dispatch({ type: 'REFRESH_ENSEMBLE_DATA', players, messages, history, schedules });
          playerCount = players.length;
          conductorName = players.find(p => p.isConductor)?.playerId;
          scheduleCount = schedules.length;
          ensembleName = state.activeEnsemble;
        } catch {
          // Non-fatal — will retry in poll loop
        }
      } else {
        try {
          const ensembles = await api.discoverEnsembles();
          if (cancelled) return;
          dispatch({ type: 'REFRESH_ENSEMBLES', ensembles });
          if (ensembles.length > 0) {
            playerCount = ensembles.reduce((sum, e) => sum + e.playerCount, 0);

            // Auto-select: if exactly 1 ensemble, switch to it; if multiple, pick the first
            const autoSelect = ensembles[0].name;
            dispatch({ type: 'NAVIGATE_ENSEMBLE', ensemble: autoSelect });
            ensembleName = autoSelect;

            // Load data for the auto-selected ensemble
            try {
              const [players, messages, history, schedules] = await Promise.all([
                api.getPlayers(autoSelect),
                api.getMessages(autoSelect, 50),
                api.getConductorHistory(autoSelect),
                api.getSchedules(autoSelect),
              ]);
              if (cancelled) return;
              dispatch({ type: 'REFRESH_ENSEMBLE_DATA', players, messages, history, schedules });
              playerCount = players.length;
              conductorName = players.find(p => p.isConductor)?.playerId;
              scheduleCount = schedules.length;
            } catch {
              // Non-fatal
            }
          } else {
            ensembleName = 'no ensembles';
          }
        } catch {
          // Non-fatal
        }
      }

      if (cancelled) return;

      // Complete ensemble check
      completeLastCheck();
      checks[checks.length - 1] = { label: `Ensemble ${ensembleName} connected`, done: true };
      dispatch({ type: 'SET_SPLASH_CHECKS', checks: [...checks] });

      // Step 3: Player summary
      const activeCount = playerCount;
      addCheck(`${activeCount} player${activeCount !== 1 ? 's' : ''} found`, true);
      if (conductorName) {
        addCheck(`Conductor: ${conductorName}`, true);
      }

      // Mark splash as connected with summary
      dispatch({
        type: 'SET_SPLASH_CONNECTED',
        summary: {
          ensemble: ensembleName,
          playerCount,
          conductor: conductorName,
          scheduleCount: scheduleCount > 0 ? scheduleCount : undefined,
        },
      });

      // Ensure splash is visible for at least MIN_SPLASH_MS
      const elapsed = Date.now() - splashStart;
      if (elapsed < MIN_SPLASH_MS) {
        await new Promise(r => setTimeout(r, MIN_SPLASH_MS - elapsed));
      }

      if (!cancelled) {
        // Commit splash completion to history
        dispatch({
          type: 'COMMIT_STATIC',
          item: {
            id: nextStaticId(),
            type: 'splash-done',
            content: `Connected to Temporal \u2022 ${ensembleName} \u2022 ${playerCount} players \u2022 v${packageVersion}`,
            timestamp: Date.now(),
          },
        });
        dispatch({ type: 'SET_PHASE', phase: 'main' });
      }
    }

    connect().catch((err) => {
      if (!cancelled) {
        dispatch({ type: 'SET_PHASE', phase: 'error', error: String(err) });
      }
    });

    return () => { cancelled = true; };
  }, [api]);

  // ── Polling loop ──
  useEffect(() => {
    if (state.phase !== 'main' && state.phase !== 'chat' && state.phase !== 'connected') return;

    const interval = setInterval(async () => {
      try {
        if (!state.activeEnsemble) {
          const ensembles = await api.discoverEnsembles();
          dispatch({ type: 'REFRESH_ENSEMBLES', ensembles });
        } else {
          const [players, messages, history, schedules] = await Promise.all([
            api.getPlayers(state.activeEnsemble),
            api.getMessages(state.activeEnsemble, 50),
            api.getConductorHistory(state.activeEnsemble),
            api.getSchedules(state.activeEnsemble),
          ]);
          dispatch({ type: 'REFRESH_ENSEMBLE_DATA', players, messages, history, schedules });
        }
      } catch {
        // Silently skip failed polls
      }
    }, 3000);

    return () => clearInterval(interval);
  }, [state.phase, state.activeEnsemble, api]);

  // ── Render ──

  // Splash phase: full-screen splash only
  if (state.phase === 'splash' || state.phase === 'connecting') {
    return React.createElement(Splash, {
      status: state.splashStatus,
      ensemble: state.activeEnsemble || 'all',
      version: packageVersion,
      checks: state.splashChecks,
      connected: state.splashConnected,
      summary: state.splashSummary,
    });
  }

  // Divider — thin horizontal rule
  const dividerWidth = Math.max(20, (process.stdout.columns || 80) - 4);
  const dividerLine = '\u2500'.repeat(dividerWidth);

  // ── Recruit wizard callbacks ──
  const handleRecruitAnswer = useCallback((answer: any) => {
    dispatch({ type: 'RECRUIT_NEXT_STEP', answer });
  }, []);

  const handleRecruitBack = useCallback(() => {
    dispatch({ type: 'RECRUIT_PREV_STEP' });
  }, []);

  const handleRecruitConfirm = useCallback(async () => {
    if (!state.recruitState) return;

    const ensemble = state.activeEnsemble;
    if (!ensemble) {
      dispatch({ type: 'RECRUIT_DONE', error: 'No active ensemble. Start one with: claude-tempo up <name>' });
      return;
    }

    dispatch({ type: 'RECRUIT_SUBMIT' });

    const a = state.recruitState.answers;

    try {
      // Build recruit command for the conductor
      const parts = [`/recruit ${a.name}`];
      if (a.playerType) parts.push(`--type ${a.playerType}`);
      if (a.agent !== 'claude') parts.push(`--agent ${a.agent}`);
      if (a.workDir) parts.push(`--dir ${a.workDir}`);
      if (a.host !== 'localhost') parts.push(`--host ${a.host}`);
      if (a.initialMessage) parts.push(`-- ${a.initialMessage}`);

      await api.sendCommand(ensemble, parts.join(' '), 'tui');
      dispatch({ type: 'RECRUIT_DONE' });
      dispatch({
        type: 'COMMIT_STATIC',
        item: {
          id: nextStaticId(),
          type: 'info',
          content: `\u2714 Recruit requested: ${a.name} (${a.agent}${a.playerType ? ', type: ' + a.playerType : ''})`,
          timestamp: Date.now(),
        },
      });
    } catch (err) {
      dispatch({ type: 'RECRUIT_DONE', error: String(err) });
    }
  }, [state.recruitState, state.activeEnsemble, api]);

  const handleRecruitCancel = useCallback(() => {
    dispatch({ type: 'EXIT_RECRUIT' });
    dispatch({
      type: 'COMMIT_STATIC',
      item: { id: nextStaticId(), type: 'info', content: 'Recruit cancelled.', timestamp: Date.now() },
    });
  }, []);

  const handleRecruitDone = useCallback(() => {
    dispatch({ type: 'EXIT_RECRUIT' });
  }, []);

  // Live content area — route by phase
  function renderLiveContent() {
    if (state.phase === 'error') {
      return React.createElement(ErrorView, {
        version: packageVersion,
        checks: [
          { label: 'Daemon running', passed: true },
          { label: `Cannot reach Temporal`, passed: false, detail: state.error },
        ],
        errorDetail: state.error,
        onQuit: () => exit(),
      });
    }

    if (state.phase === 'recruit' && state.recruitState) {
      return React.createElement(RecruitWizard, {
        state: state.recruitState,
        onAnswer: handleRecruitAnswer,
        onBack: handleRecruitBack,
        onConfirm: handleRecruitConfirm,
        onCancel: handleRecruitCancel,
        onDone: handleRecruitDone,
      });
    }

    if (state.phase === 'chat' && state.chatTarget) {
      // Build chat messages from relay messages filtered to this conversation
      const chatMessages: ChatMessage[] = state.messages
        .filter(m => m.from === state.chatTarget || m.to === state.chatTarget)
        .map(m => ({
          direction: m.to === state.chatTarget ? 'sent' as const : 'received' as const,
          from: m.from,
          text: m.text,
          timestamp: m.timestamp,
        }));
      const received = chatMessages.filter(m => m.direction === 'received').length;
      const sent = chatMessages.filter(m => m.direction === 'sent').length;
      const targetPlayer = state.players.find(p => p.playerId === state.chatTarget);

      return React.createElement(ChatView, {
        targetPlayer: state.chatTarget,
        targetPart: targetPlayer?.part,
        targetBranch: targetPlayer?.gitBranch,
        targetStatus: targetPlayer?.status,
        receivedCount: received,
        sentCount: sent,
        messages: chatMessages,
      });
    }

    // Main view — show ensemble state
    if (state.activeEnsemble) {
      return React.createElement(MainView, {
        ensemble: state.activeEnsemble,
        players: state.players,
        messages: state.messages,
        schedules: state.schedules.map(s => ({ name: s.name, spec: s.type, target: s.target })),
      });
    }

    // No active ensemble — show ensemble list or help
    if (state.ensembles.length > 0) {
      return React.createElement(Box, { flexDirection: 'column', paddingX: 1 },
        React.createElement(Text, { bold: true, color: THEME.text }, 'Ensembles:'),
        ...state.ensembles.map(ens =>
          React.createElement(Text, { key: ens.name, color: THEME.textMuted },
            `  ${ens.name} (${ens.playerCount} player${ens.playerCount !== 1 ? 's' : ''})${ens.hasConductor ? ' \u2605' : ''}`,
          ),
        ),
      );
    }

    return React.createElement(Box, { paddingX: 1 },
      React.createElement(Text, { color: THEME.dim }, 'Type /help to get started.'),
    );
  }

  return React.createElement(Box, { flexDirection: 'column', height: '100%' },
    // Title bar
    React.createElement(TitleBar, { context: contextString }),
    // Top divider
    React.createElement(Box, { key: 'divider-top', paddingX: 1 },
      React.createElement(Text, { color: THEME.border }, dividerLine),
    ),
    // Static scroll-up history
    // Ink's <Static> takes a render function child via `children` prop.
    React.createElement(Static, {
      items: state.staticItems,
      children: (item: StaticItem) =>
        React.createElement(Box, { key: item.id, paddingX: 1 },
          React.createElement(Text, { color: staticItemColor(item) }, item.content),
        ),
    } as any),
    // Live content area
    React.createElement(Box, { flexGrow: 1 },
      renderLiveContent(),
    ),
    // Bottom divider
    React.createElement(Box, { key: 'divider-bottom', paddingX: 1 },
      React.createElement(Text, { color: THEME.border }, dividerLine),
    ),
    // Prompt area
    React.createElement(PromptArea, {
      hints: promptHints,
      value: state.inputValue,
      onChange: (value: string) => dispatch({ type: 'SET_INPUT', value }),
      onSubmit: handleSubmit,
      disabled: state.phase === 'error' || state.phase === 'recruit',
    }),
  );
}
