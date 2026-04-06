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
import { StatusBar } from './components/StatusBar';
import { ScheduleWizard } from './components/ScheduleWizard';
import { CommandPalette } from './components/CommandPalette';
import { parseCommand, isValidCommand, formatHelpSummary, COMMANDS, getCommandNames } from './commands';
import { THEME } from './utils/theme';
import { loadHistory, saveHistory } from './utils/history';
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
  const { Box, Text, useApp, useInput } = useInk();
  const [state, dispatch] = useReducer(tuiReducer, initialState(ensemble));
  const { exit } = useApp();

  // ── Persistent command history ──
  const [cmdHistory] = React.useState(() => loadHistory());

  // ── Ref for last seen message ID (avoids stale closure in polling effect) ──
  const lastSeenMsgRef = React.useRef<string | undefined>(state.lastSeenMessageId);
  const handleHistoryUpdate = useCallback((entries: string[]) => {
    saveHistory(entries);
  }, []);

  // ── Global keybindings ──
  useInput(useCallback((input: string, key: any) => {
    if (key.ctrl && input === 'c') {
      exit();
      return;
    }

    // Scrollback navigation (Page Up/Down, Home/End)
    if (key.pageUp) { dispatch({ type: 'SCROLL_UP', lines: 10 }); return; }
    if (key.pageDown) { dispatch({ type: 'SCROLL_DOWN', lines: 10 }); return; }
    if (key.home || (key.ctrl && input === 'a')) { dispatch({ type: 'SCROLL_HOME' }); return; }
    if (key.end || (key.ctrl && input === 'e')) { dispatch({ type: 'SCROLL_END' }); return; }

    // Stop confirmation mode
    if (state.confirmingStop) {
      if (input === 'y' || input === 'Y') {
        const target = state.confirmingStop;
        dispatch({ type: 'CANCEL_STOP' });
        // Execute the stop
        (async () => {
          try {
            const ensembles = await api.discoverEnsembles();
            for (const ens of ensembles) {
              try {
                await api.terminatePlayer(ens.name, target);
                dispatch({
                  type: 'COMMIT_STATIC',
                  item: { id: nextStaticId(), type: 'info', content: `\u2714 Stopped player: ${target}`, timestamp: Date.now() },
                });
                return;
              } catch {
                // Try next ensemble
              }
            }
            dispatch({
              type: 'COMMIT_STATIC',
              item: { id: nextStaticId(), type: 'error', content: `\u2717 Player "${target}" not found in any ensemble.`, timestamp: Date.now() },
            });
          } catch (err) {
            dispatch({
              type: 'COMMIT_STATIC',
              item: { id: nextStaticId(), type: 'error', content: `\u2717 Failed to stop ${target}: ${err}`, timestamp: Date.now() },
            });
          }
        })();
      } else if (input === 'n' || input === 'N' || key.escape) {
        dispatch({ type: 'CANCEL_STOP' });
        dispatch({
          type: 'COMMIT_STATIC',
          item: { id: nextStaticId(), type: 'info', content: 'Stop cancelled.', timestamp: Date.now() },
        });
      }
      return;
    }

    // Lineup confirmation mode
    if (state.confirmingLineup) {
      if (input === 'y' || input === 'Y') {
        const { path: lineupPath } = state.confirmingLineup;
        const activeEns = state.activeEnsemble;
        dispatch({ type: 'CANCEL_LINEUP' });
        if (!activeEns) {
          dispatch({
            type: 'COMMIT_STATIC',
            item: { id: nextStaticId(), type: 'error', content: 'No active ensemble.', timestamp: Date.now() },
          });
        } else {
          (async () => {
            try {
              await api.sendCommand(activeEns, `/load_lineup ${lineupPath}`, 'tui');
              dispatch({
                type: 'COMMIT_STATIC',
                item: { id: nextStaticId(), type: 'info', content: `\u2714 Lineup load requested: ${lineupPath}`, timestamp: Date.now() },
              });
            } catch (err) {
              dispatch({
                type: 'COMMIT_STATIC',
                item: { id: nextStaticId(), type: 'error', content: `\u2717 Failed to load lineup: ${err}`, timestamp: Date.now() },
              });
            }
          })();
        }
      } else if (input === 'n' || input === 'N' || key.escape) {
        dispatch({ type: 'CANCEL_LINEUP' });
        dispatch({
          type: 'COMMIT_STATIC',
          item: { id: nextStaticId(), type: 'info', content: 'Lineup load cancelled.', timestamp: Date.now() },
        });
      }
      return;
    }
  }, [exit, state.confirmingStop, state.confirmingLineup, state.activeEnsemble, api]));

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
    if (state.confirmingStop) {
      return `Stop ${state.confirmingStop}? This will terminate their session. [y/N]`;
    }
    if (state.confirmingLineup) {
      return `${state.confirmingLineup.summary} [y/N]`;
    }
    if (state.phase === 'recruit') {
      return 'Follow the prompts above. Esc to cancel.';
    }
    if (state.chatTarget) {
      return 'Type a message to send, or /back to exit chat mode';
    }
    return '/cue /recruit /stop /broadcast /help /quit';
  }, [state.phase, state.chatTarget, state.confirmingStop]);

  // ── Completion data for prompt ──
  const commandNamesList = useMemo(() => getCommandNames(), []);
  const playerNamesList = useMemo(
    () => state.players.map(p => p.playerId),
    [state.players],
  );

  // ── Command palette ──
  const allPaletteCommands = useMemo(() =>
    getCommandNames().map(name => ({
      name,
      usage: COMMANDS[name].usage,
      description: COMMANDS[name].description,
    })),
  []);

  const filteredPaletteCommands = useMemo(() => {
    if (!state.paletteVisible) return [];
    const filter = state.inputValue.trimStart().slice(1).toLowerCase(); // strip leading /
    if (!filter) return allPaletteCommands;
    return allPaletteCommands.filter(c => c.name.startsWith(filter));
  }, [state.paletteVisible, state.inputValue, allPaletteCommands]);

  // Clamp palette index
  const clampedPaletteIndex = Math.min(state.paletteIndex, Math.max(0, filteredPaletteCommands.length - 1));

  const handlePaletteToggle = useCallback((visible: boolean) => {
    dispatch(visible ? { type: 'SHOW_PALETTE' } : { type: 'HIDE_PALETTE' });
  }, []);

  const handlePaletteUp = useCallback(() => {
    dispatch({ type: 'PALETTE_UP' });
  }, []);

  const handlePaletteDown = useCallback(() => {
    if (state.paletteIndex < filteredPaletteCommands.length - 1) {
      dispatch({ type: 'PALETTE_DOWN' });
    }
  }, [state.paletteIndex, filteredPaletteCommands.length]);

  const handlePaletteSelect = useCallback(() => {
    if (filteredPaletteCommands.length > 0) {
      const selected = filteredPaletteCommands[clampedPaletteIndex];
      dispatch({ type: 'SET_INPUT', value: `/${selected.name} ` });
      dispatch({ type: 'HIDE_PALETTE' });
    }
  }, [filteredPaletteCommands, clampedPaletteIndex]);

  // ── Command submission handler ──
  const handleSubmit = useCallback(async (input: string) => {
    const trimmed = input.trim();
    if (!trimmed) return;

    dispatch({ type: 'SET_INPUT', value: '' });
    if (state.paletteVisible) dispatch({ type: 'HIDE_PALETTE' });

    const parsed = parseCommand(trimmed);

    if (parsed) {
      // Slash command
      if (parsed.name === 'quit' || parsed.name === 'exit') {
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

      // Splash stays visible — user must press Enter to continue.
      // The SET_SPLASH_CONNECTED dispatch above marks it as ready.
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

          // Detect new messages and commit them to Static
          if (messages.length > 0 && lastSeenMsgRef.current) {
            const lastIdx = messages.findIndex(m => m.id === lastSeenMsgRef.current);
            const newMessages = lastIdx >= 0 ? messages.slice(lastIdx + 1) : [];
            for (const m of newMessages) {
              const time = new Date(m.timestamp);
              const hh = String(time.getHours()).padStart(2, '0');
              const mm = String(time.getMinutes()).padStart(2, '0');
              const text = m.text.length > 60 ? m.text.slice(0, 57) + '...' : m.text;
              dispatch({
                type: 'COMMIT_STATIC',
                item: {
                  id: `msg-${m.id}`,
                  type: 'message',
                  content: `[${hh}:${mm}] ${m.from} \u2192 ${m.to}: ${text.replace(/\n/g, ' ')}`,
                  timestamp: Date.now(),
                },
              });
            }
          }

          dispatch({ type: 'REFRESH_ENSEMBLE_DATA', players, messages, history, schedules });

          // Update ref so next poll uses the latest ID
          if (messages.length > 0) {
            lastSeenMsgRef.current = messages[messages.length - 1].id;
          }
        }
      } catch {
        // Silently skip failed polls
      }
    }, 3000);

    return () => clearInterval(interval);
  }, [state.phase, state.activeEnsemble, api]);

  // ── Splash continue callback (must be before early return — Rules of Hooks) ──
  const handleSplashContinue = useCallback(() => {
    dispatch({
      type: 'COMMIT_STATIC',
      item: {
        id: nextStaticId(),
        type: 'splash-done',
        content: `Connected to Temporal \u2022 ${state.activeEnsemble || 'all'} \u2022 ${state.players.length} players \u2022 v${packageVersion}`,
        timestamp: Date.now(),
      },
    });
    dispatch({ type: 'SET_PHASE', phase: 'main' });
  }, [state.activeEnsemble, state.players.length]);

  // ── Recruit wizard callbacks (must be before early return — Rules of Hooks) ──
  const handleRecruitAnswer = useCallback((answer: any) => {
    dispatch({ type: 'RECRUIT_NEXT_STEP', answer });
  }, []);

  const handleRecruitBack = useCallback(() => {
    dispatch({ type: 'RECRUIT_PREV_STEP' });
  }, []);

  const handleRecruitConfirm = useCallback(async () => {
    if (!state.recruitState) return;

    const activeEns = state.activeEnsemble;
    if (!activeEns) {
      dispatch({ type: 'RECRUIT_DONE', error: 'No active ensemble. Start one with: claude-tempo up <name>' });
      return;
    }

    dispatch({ type: 'RECRUIT_SUBMIT' });

    const a = state.recruitState.answers;

    try {
      const parts = [`/recruit ${a.name}`];
      if (a.playerType) parts.push(`--type ${a.playerType}`);
      if (a.agent !== 'claude') parts.push(`--agent ${a.agent}`);
      if (a.workDir) parts.push(`--dir ${a.workDir}`);
      if (a.host !== 'localhost') parts.push(`--host ${a.host}`);
      if (a.initialMessage) parts.push(`-- ${a.initialMessage}`);

      await api.sendCommand(activeEns, parts.join(' '), 'tui');
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

  // ── Schedule wizard callbacks ──
  const handleScheduleAnswer = useCallback((answer: any) => {
    dispatch({ type: 'SCHEDULE_NEXT_STEP', answer });
  }, []);

  const handleScheduleBack = useCallback(() => {
    dispatch({ type: 'SCHEDULE_PREV_STEP' });
  }, []);

  const handleScheduleConfirm = useCallback(async () => {
    if (!state.scheduleWizard) return;

    const activeEns = state.activeEnsemble;
    if (!activeEns) {
      dispatch({ type: 'SCHEDULE_DONE', error: 'No active ensemble.' });
      return;
    }

    dispatch({ type: 'SCHEDULE_SUBMIT' });

    const a = state.scheduleWizard.answers;
    try {
      const parts = [`/schedule ${a.name} --to ${a.target}`];
      if (a.schedType === 'delay') parts.push(`--delay ${a.timing}`);
      else if (a.schedType === 'at') parts.push(`--at ${a.timing}`);
      else if (a.schedType === 'every') parts.push(`--every ${a.timing}`);
      else if (a.schedType === 'cron') {
        parts.push(`--cron "${a.timing}"`);
        if (a.timezone) parts.push(`--timezone ${a.timezone}`);
      }
      parts.push(a.message);

      await api.sendCommand(activeEns, parts.join(' '), 'tui');
      dispatch({ type: 'SCHEDULE_DONE' });
      dispatch({
        type: 'COMMIT_STATIC',
        item: { id: nextStaticId(), type: 'info', content: `\u2714 Schedule "${a.name}" creation requested.`, timestamp: Date.now() },
      });
    } catch (err) {
      dispatch({ type: 'SCHEDULE_DONE', error: String(err) });
    }
  }, [state.scheduleWizard, state.activeEnsemble, api]);

  const handleScheduleCancel = useCallback(() => {
    dispatch({ type: 'EXIT_SCHEDULE_WIZARD' });
    dispatch({
      type: 'COMMIT_STATIC',
      item: { id: nextStaticId(), type: 'info', content: 'Schedule creation cancelled.', timestamp: Date.now() },
    });
  }, []);

  const handleScheduleDone = useCallback(() => {
    dispatch({ type: 'EXIT_SCHEDULE_WIZARD' });
  }, []);

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
      ensembles: state.ensembles.map(e => ({ name: e.name, playerCount: e.playerCount, hasConductor: e.hasConductor })),
      onContinue: handleSplashContinue,
    });
  }

  // Divider — thin horizontal rule
  const dividerWidth = Math.max(20, (process.stdout.columns || 80) - 4);
  const dividerLine = '\u2500'.repeat(dividerWidth);

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

    if (state.phase === 'schedule-create' && state.scheduleWizard) {
      return React.createElement(ScheduleWizard, {
        state: state.scheduleWizard,
        onAnswer: handleScheduleAnswer,
        onBack: handleScheduleBack,
        onConfirm: handleScheduleConfirm,
        onCancel: handleScheduleCancel,
        onDone: handleScheduleDone,
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
    // Scrollback history viewport
    (() => {
      const items = state.staticItems;
      const viewportHeight = Math.max(5, (process.stdout.rows || 24) - 10); // Reserve space for title/status/prompt
      const endIdx = items.length - state.scrollOffset;
      const startIdx = Math.max(0, endIdx - viewportHeight);
      const visibleItems = items.slice(startIdx, endIdx);

      const elements: React.ReactNode[] = [];

      // Scroll-up indicator
      if (startIdx > 0) {
        elements.push(
          React.createElement(Box, { key: 'scroll-up-indicator', paddingX: 1 },
            React.createElement(Text, { color: THEME.dim }, `\u2191 ${startIdx} more message${startIdx !== 1 ? 's' : ''} above`),
          ),
        );
      }

      // Visible items
      for (const item of visibleItems) {
        elements.push(
          React.createElement(Box, { key: item.id, paddingX: 1 },
            React.createElement(Text, { color: staticItemColor(item) }, item.content),
          ),
        );
      }

      // New messages below indicator
      if (state.hasNewBelow && state.scrollOffset > 0) {
        elements.push(
          React.createElement(Box, { key: 'scroll-down-indicator', paddingX: 1 },
            React.createElement(Text, { color: THEME.warning }, '\u2193 new messages below \u2193'),
          ),
        );
      } else if (state.scrollOffset > 0) {
        elements.push(
          React.createElement(Box, { key: 'scrolled-indicator', paddingX: 1 },
            React.createElement(Text, { color: THEME.dim }, `\u2500\u2500\u2500 scrolled (${state.scrollOffset} below) \u2500\u2500\u2500`),
          ),
        );
      }

      return React.createElement(Box, { flexDirection: 'column', flexGrow: 1 }, ...elements);
    })(),
    // Live content area
    React.createElement(Box, { flexGrow: 1 },
      renderLiveContent(),
    ),
    // Status bar
    React.createElement(StatusBar, {
      ensemble: state.activeEnsemble,
      players: state.players,
      scheduleCount: state.schedules.length,
      connected: true,
    }),
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
      disabled: state.phase === 'error' || state.phase === 'recruit' || state.phase === 'schedule-create' || !!state.confirmingStop || !!state.confirmingLineup,
      commandNames: commandNamesList,
      playerNames: playerNamesList,
      initialHistory: cmdHistory,
      onHistoryUpdate: handleHistoryUpdate,
      paletteVisible: state.paletteVisible,
      onPaletteToggle: handlePaletteToggle,
      onPaletteUp: handlePaletteUp,
      onPaletteDown: handlePaletteDown,
      onPaletteSelect: handlePaletteSelect,
    }),
    // Command palette (below prompt — drops down like Claude Code)
    state.paletteVisible && filteredPaletteCommands.length >= 0
      ? React.createElement(CommandPalette, {
          commands: filteredPaletteCommands,
          selectedIndex: clampedPaletteIndex,
        })
      : null,
  );
}
