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
import { Picker } from './components/Picker';
import type { PickerItem } from './components/Picker';
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

  // ── Refs for values read by useInput/useCallback (avoids stale closures + excess re-renders) ──
  const lastSeenMsgRef = React.useRef<string | undefined>(state.lastSeenMessageId);
  const lastSeenMaestroRef = React.useRef<string | undefined>(undefined);
  const stateRef = React.useRef(state);
  stateRef.current = state; // Always current on every render

  // ── Refs for poll dedup (skip dispatches when data hasn't changed) ──
  const lastPollRef = React.useRef({ playerCount: 0, lastMsgId: '', historyLen: 0, scheduleCount: 0, maestroMsgCount: 0 });
  const handleHistoryUpdate = useCallback((entries: string[]) => {
    saveHistory(entries);
  }, []);

  // ── Global keybindings (uses stateRef to avoid recreating on every poll) ──
  useInput(useCallback((input: string, key: any) => {
    const s = stateRef.current;
    if (key.ctrl && input === 'c') {
      exit();
      return;
    }

    // Esc on splash exits the TUI
    if (key.escape && (s.phase === 'splash' || s.phase === 'connecting')) {
      exit();
      return;
    }

    // Scrollback navigation (Page Up/Down, Home/End)
    if (key.pageUp) { dispatch({ type: 'SCROLL_UP', lines: 10 }); return; }
    if (key.pageDown) { dispatch({ type: 'SCROLL_DOWN', lines: 10 }); return; }
    if (key.home || (key.ctrl && input === 'a')) { dispatch({ type: 'SCROLL_HOME' }); return; }
    if (key.end || (key.ctrl && input === 'e')) { dispatch({ type: 'SCROLL_END' }); return; }

    // Picker overlay navigation
    if (s.pickerVisible) {
      if (key.escape) { dispatch({ type: 'HIDE_PICKER' }); return; }
      if (key.upArrow) { dispatch({ type: 'PICKER_UP' }); return; }
      if (key.downArrow) { dispatch({ type: 'PICKER_DOWN' }); return; }
      if (key.return) {
        if (s.pickerType === 'players') {
          const player = s.players[s.pickerIndex];
          if (player) {
            dispatch({ type: 'HIDE_PICKER' });
            dispatch({ type: 'ENTER_CHAT', target: player.playerId });
            dispatch({
              type: 'COMMIT_STATIC',
              item: { id: nextStaticId(), type: 'info', content: `Entering chat with ${player.playerId}.`, timestamp: Date.now() },
            });
          }
        } else if (s.pickerType === 'ensembles') {
          const ens = s.ensembles[s.pickerIndex];
          if (ens) {
            dispatch({ type: 'HIDE_PICKER' });
            dispatch({ type: 'NAVIGATE_ENSEMBLE', ensemble: ens.name });
            dispatch({
              type: 'COMMIT_STATIC',
              item: { id: nextStaticId(), type: 'info', content: `Switched to ensemble: ${ens.name}`, timestamp: Date.now() },
            });
          }
        }
        return;
      }
      return;
    }

    // Stop confirmation mode
    if (s.confirmingStop) {
      if (input === 'y' || input === 'Y') {
        const target = s.confirmingStop;
        dispatch({ type: 'CANCEL_STOP' });
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
    if (s.confirmingLineup) {
      if (input === 'y' || input === 'Y') {
        const { path: lineupPath } = s.confirmingLineup;
        const activeEns = s.activeEnsemble;
        dispatch({ type: 'CANCEL_LINEUP' });
        if (!activeEns) {
          dispatch({
            type: 'COMMIT_STATIC',
            item: { id: nextStaticId(), type: 'error', content: 'No active ensemble.', timestamp: Date.now() },
          });
        } else {
          (async () => {
            try {
              await api.sendCommand(activeEns, `/load_lineup ${lineupPath}`, 'maestro');
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
  }, [exit, api])); // Stable deps only — reads stateRef.current for everything else

  // ── Context string for title bar ──
  const contextString = useMemo(() => {
    if (state.phase === 'splash') return 'Starting up...';
    if (state.phase === 'error') return 'Error';
    if (state.chatTarget) {
      const isConductor = state.chatTarget === state.conductorName;
      const player = state.players.find(p => p.playerId === state.chatTarget);
      const status = player?.status || 'unknown';
      const icon = isConductor ? '\u2605' : '\u2022';
      return `${icon} ${state.chatTarget} \u00b7 ${status}${state.activeEnsemble ? ` \u00b7 ${state.activeEnsemble}` : ''}`;
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
      const isConductor = state.chatTarget === state.conductorName;
      return isConductor
        ? 'Type a message for the conductor. /players to switch, /dashboard for overview'
        : `Chatting with ${state.chatTarget}. /back to return to conductor`;
    }
    return '/cue /recruit /stop /broadcast /help /quit';
  }, [state.phase, state.chatTarget, state.confirmingStop]);

  // ── Completion data for prompt ──
  const commandNamesList = useMemo(() => getCommandNames(), []);
  const playerNamesList = useMemo(
    () => state.players.map(p => p.playerId),
    [state.players],
  );

  // ── Picker items ──
  const pickerItems = useMemo((): PickerItem[] => {
    if (!state.pickerVisible) return [];

    if (state.pickerType === 'players') {
      return state.players.map(p => ({
        id: p.playerId,
        label: p.playerId,
        detail: `${p.playerType || p.agentType || ''} [${p.status || '?'}]`,
        meta: p.part || undefined,
        icon: p.isConductor ? '\u2605' : p.status === 'active' ? '\u25CF' : p.status === 'stale' ? '\u25CB' : '\u25D4',
        color: p.status === 'active' ? THEME.success : p.status === 'stale' ? THEME.warning : THEME.dim,
        current: p.playerId === state.chatTarget,
      }));
    }

    if (state.pickerType === 'ensembles') {
      return state.ensembles.map(ens => ({
        id: ens.name,
        label: ens.name,
        detail: `${ens.playerCount} player${ens.playerCount !== 1 ? 's' : ''}`,
        meta: ens.hasConductor ? '\u2605 conductor' : undefined,
        current: ens.name === state.activeEnsemble,
      }));
    }

    return [];
  }, [state.pickerVisible, state.pickerType, state.players, state.ensembles, state.chatTarget, state.activeEnsemble]);

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
    const s = stateRef.current;

    dispatch({ type: 'SET_INPUT', value: '' });
    if (s.paletteVisible) dispatch({ type: 'HIDE_PALETTE' });

    const parsed = parseCommand(trimmed);

    if (parsed) {
      // Slash command
      if (parsed.name === 'quit' || parsed.name === 'exit') {
        exit();
        return;
      }
      if (parsed.name === 'dashboard' || parsed.name === 'status') {
        // Show dashboard view (exit chat mode temporarily)
        dispatch({ type: 'EXIT_CHAT' });
        dispatch({ type: 'SET_PHASE', phase: 'main' });
        return;
      }
      if (parsed.name === 'back') {
        // Return to conductor chat (or exit to main if no conductor)
        if (s.chatTarget && s.chatTarget !== s.conductorName && s.conductorName) {
          dispatch({ type: 'ENTER_CHAT', target: s.conductorName });
        } else if (s.chatTarget) {
          dispatch({ type: 'EXIT_CHAT' });
        } else if (s.activeEnsemble) {
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
        const ctx = { activeEnsemble: s.activeEnsemble };
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
    } else if (s.chatTarget) {
      // Bare text in chat mode → send to target
      if (!s.activeEnsemble) {
        dispatch({
          type: 'COMMIT_STATIC',
          item: { id: nextStaticId(), type: 'error', content: 'No active ensemble. Use /ensemble <name> first.', timestamp: Date.now() },
        });
        return;
      }
      const isConductorTarget = s.chatTarget === s.conductorName;
      try {
        if (isConductorTarget) {
          await api.sendCommand(s.activeEnsemble!, trimmed, 'maestro');
        } else {
          await api.sendMessage(s.activeEnsemble!, s.chatTarget!, trimmed, 'maestro');
        }
        dispatch({ type: 'APPEND_SENT_MESSAGE', to: s.chatTarget!, text: trimmed });
        dispatch({
          type: 'COMMIT_STATIC',
          item: {
            id: nextStaticId(),
            type: 'message',
            content: `\u2714 ${isConductorTarget ? '\u2605' : ''} ${s.chatTarget}: ${trimmed}`,
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
  }, [api, exit]); // Reads stateRef.current for chatTarget/activeEnsemble

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
          if (conductorName) dispatch({ type: 'SET_CONDUCTOR', name: conductorName });
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
              if (conductorName) dispatch({ type: 'SET_CONDUCTOR', name: conductorName });
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

      // Step 4: Ensure maestro session for two-way messaging
      if (state.activeEnsemble || ensembleName !== 'no ensembles') {
        const ens = state.activeEnsemble || ensembleName;
        try {
          await api.ensureMaestroSession(ens);
          addCheck('Maestro session ready', true);
        } catch {
          // Non-fatal — messaging will fall back to Maestro relay
        }
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
          // Fetch relay messages + maestro direct messages in parallel
          const [players, messages, history, schedules, maestroMsgs] = await Promise.all([
            api.getPlayers(state.activeEnsemble),
            api.getMessages(state.activeEnsemble, 50),
            api.getConductorHistory(state.activeEnsemble),
            api.getSchedules(state.activeEnsemble),
            api.getMaestroMessages(state.activeEnsemble),
          ]);

          // Detect new relay messages and commit them to Static
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

          // Detect new maestro direct messages
          if (maestroMsgs.received.length > 0 && lastSeenMaestroRef.current) {
            const lastIdx = maestroMsgs.received.findIndex(m => m.id === lastSeenMaestroRef.current);
            const newDirect = lastIdx >= 0 ? maestroMsgs.received.slice(lastIdx + 1) : [];
            for (const m of newDirect) {
              const time = new Date(m.timestamp);
              const hh = String(time.getHours()).padStart(2, '0');
              const mm = String(time.getMinutes()).padStart(2, '0');
              const text = m.text.length > 60 ? m.text.slice(0, 57) + '...' : m.text;
              dispatch({
                type: 'COMMIT_STATIC',
                item: {
                  id: `dm-${m.id}`,
                  type: 'message',
                  content: `[${hh}:${mm}] ${m.from} \u2192 you: ${text.replace(/\n/g, ' ')}`,
                  timestamp: Date.now(),
                },
              });
            }
          }
          if (maestroMsgs.received.length > 0) {
            lastSeenMaestroRef.current = maestroMsgs.received[maestroMsgs.received.length - 1].id;
          }

          // Skip dispatch if data hasn't changed (avoids unnecessary re-renders)
          const lastMsg = messages.length > 0 ? messages[messages.length - 1].id : '';
          const pollKey = {
            playerCount: players.length,
            lastMsgId: lastMsg,
            historyLen: history.length,
            scheduleCount: schedules.length,
            maestroMsgCount: maestroMsgs.received.length,
          };
          const prev = lastPollRef.current;
          const changed = pollKey.playerCount !== prev.playerCount
            || pollKey.lastMsgId !== prev.lastMsgId
            || pollKey.historyLen !== prev.historyLen
            || pollKey.scheduleCount !== prev.scheduleCount
            || pollKey.maestroMsgCount !== prev.maestroMsgCount;

          if (changed) {
            dispatch({ type: 'REFRESH_ENSEMBLE_DATA', players, messages, history, schedules });
            lastPollRef.current = pollKey;
          }

          // Update ref so next poll uses the latest ID
          if (messages.length > 0) {
            lastSeenMsgRef.current = lastMsg;
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
    // Default to conductor chat if available, otherwise main view
    const conductor = state.conductorName;
    if (conductor) {
      dispatch({ type: 'ENTER_CHAT', target: conductor });
    } else {
      dispatch({ type: 'SET_PHASE', phase: 'main' });
    }
  }, [state.activeEnsemble, state.players.length, state.conductorName]);

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

      await api.sendCommand(activeEns, parts.join(' '), 'maestro');
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

      await api.sendCommand(activeEns, parts.join(' '), 'maestro');
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

  // ── Memoize chat messages (must be before early return — Rules of Hooks) ──
  const memoizedChatData = useMemo(() => {
    if (!state.chatTarget) return null;
    const isConductorChat = state.chatTarget === state.conductorName;

    let chatMessages: ChatMessage[];
    if (isConductorChat) {
      const fromHistory: ChatMessage[] = state.conductorHistory.map(entry => {
        if (entry.type === 'command') {
          const cmd = entry.data as { text: string; source: string; timestamp: string };
          return { direction: 'sent' as const, from: cmd.source || 'maestro', text: cmd.text, timestamp: entry.timestamp || cmd.timestamp };
        } else {
          const report = entry.data as { playerId: string; text: string; type: string; timestamp: string };
          return { direction: 'received' as const, from: report.playerId, text: `[${report.type}] ${report.text}`, timestamp: entry.timestamp || report.timestamp };
        }
      });
      const fromSent: ChatMessage[] = state.sentMessages
        .filter(m => m.to === state.chatTarget)
        .map(m => ({ direction: 'sent' as const, from: 'maestro', text: m.text, timestamp: m.timestamp }));
      const seen = new Set<string>();
      chatMessages = [...fromHistory, ...fromSent]
        .sort((a, b) => a.timestamp.localeCompare(b.timestamp))
        .filter(m => { const k = `${m.direction}:${m.timestamp}:${m.text.slice(0, 50)}`; if (seen.has(k)) return false; seen.add(k); return true; });
    } else {
      const fromRelay: ChatMessage[] = state.messages
        .filter(m => m.from === state.chatTarget || m.to === state.chatTarget)
        .map(m => ({ direction: m.to === state.chatTarget ? 'sent' as const : 'received' as const, from: m.from, text: m.text, timestamp: m.timestamp }));
      const fromSent: ChatMessage[] = state.sentMessages
        .filter(m => m.to === state.chatTarget)
        .map(m => ({ direction: 'sent' as const, from: 'maestro', text: m.text, timestamp: m.timestamp }));
      const seen = new Set<string>();
      chatMessages = [...fromRelay, ...fromSent]
        .sort((a, b) => a.timestamp.localeCompare(b.timestamp))
        .filter(m => { const k = `${m.direction}:${m.timestamp}:${m.text.slice(0, 50)}`; if (seen.has(k)) return false; seen.add(k); return true; });
    }

    return {
      messages: chatMessages,
      received: chatMessages.filter(m => m.direction === 'received').length,
      sent: chatMessages.filter(m => m.direction === 'sent').length,
      isConductor: isConductorChat,
    };
  }, [state.chatTarget, state.conductorName, state.conductorHistory, state.messages, state.sentMessages]);

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

    if (state.chatTarget && memoizedChatData) {
      const targetPlayer = state.players.find(p => p.playerId === state.chatTarget);

      return React.createElement(ChatView, {
        targetPlayer: state.chatTarget,
        targetPart: targetPlayer?.part,
        targetBranch: targetPlayer?.gitBranch,
        targetStatus: targetPlayer?.status,
        isConductor: memoizedChatData.isConductor,
        receivedCount: memoizedChatData.received,
        sentCount: memoizedChatData.sent,
        messages: memoizedChatData.messages,
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
    // Picker overlay
    state.pickerVisible
      ? React.createElement(Picker, {
          title: state.pickerType === 'players' ? 'Select Player' : 'Select Ensemble',
          items: pickerItems,
          selectedIndex: state.pickerIndex,
          hint: '\u2191\u2193 navigate, Enter select, Esc dismiss',
        })
      : null,
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
