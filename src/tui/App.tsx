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
import React, { useReducer, useEffect, useCallback, useMemo, useState } from 'react';
import { useInk } from './ink-context';
import { tuiReducer, initialState } from './store';
import type { StaticItem } from './store';
import type { PromptAreaHandle } from './components/PromptArea';

/**
 * Track terminal rows so the root Box height stays < stdout.rows.
 * Prevents Ink's fullscreen bypass (clearTerminal + full rewrite).
 */
function useTerminalRows(): number {
  const [rows, setRows] = useState(process.stdout.rows || 24);
  useEffect(() => {
    const onResize = () => setRows(process.stdout.rows || 24);
    process.stdout.on('resize', onResize);
    return () => { process.stdout.off('resize', onResize); };
  }, []);
  return rows;
}
import { Splash } from './components/Splash';
import type { EnsembleInfo } from './components/Splash';
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
  const termRows = useTerminalRows();

  // ── Persistent command history ──
  const [cmdHistory] = React.useState(() => loadHistory());

  // ── Prompt ref (uncontrolled — input lives in PromptArea, not parent state) ──
  const promptRef = React.useRef<PromptAreaHandle>(null);
  // Input value ref for palette filtering (no dispatch per keystroke)
  const inputValueRef = React.useRef('');

  // ── Refs for values read by useInput/useCallback (avoids stale closures + excess re-renders) ──
  const lastSeenMsgRef = React.useRef<string | undefined>(state.lastSeenMessageId);
  const lastSeenMaestroRef = React.useRef<string | undefined>(undefined);
  const stateRef = React.useRef(state);
  stateRef.current = state; // Always current on every render

  // ── Refs for poll dedup (skip dispatches when data hasn't changed) ──
  const lastPollRef = React.useRef({ playerCount: 0, lastMsgId: '', historyLen: 0, scheduleCount: 0, maestroMsgCount: 0 });

  // Reset stale refs when switching ensembles
  useEffect(() => {
    lastSeenMsgRef.current = undefined;
    lastSeenMaestroRef.current = undefined;
    lastPollRef.current = { playerCount: 0, lastMsgId: '', historyLen: 0, scheduleCount: 0, maestroMsgCount: 0 };
  }, [state.activeEnsemble]);
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

    // Scrollback navigation (Page Up/Down, Home/End)
    // Scroll keys removed — terminal native scrollback via <Static> handles this

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

    // Disband confirmation mode
    if (s.confirmingDisband) {
      if (input === 'y' || input === 'Y') {
        const ensemble = s.confirmingDisband;
        dispatch({ type: 'CANCEL_DISBAND' });
        (async () => {
          try {
            const { terminated } = await api.disbandEnsemble(ensemble);
            dispatch({
              type: 'COMMIT_STATIC',
              item: { id: nextStaticId(), type: 'info', content: `\u2714 Disbanded ensemble "${ensemble}" — terminated ${terminated} workflow${terminated !== 1 ? 's' : ''}.`, timestamp: Date.now() },
            });
            // Navigate back to home view
            dispatch({ type: 'NAVIGATE_HOME' });
          } catch (err) {
            dispatch({
              type: 'COMMIT_STATIC',
              item: { id: nextStaticId(), type: 'error', content: `\u2717 Failed to disband "${ensemble}": ${err}`, timestamp: Date.now() },
            });
          }
        })();
      } else if (input === 'n' || input === 'N' || key.escape) {
        dispatch({ type: 'CANCEL_DISBAND' });
        dispatch({
          type: 'COMMIT_STATIC',
          item: { id: nextStaticId(), type: 'info', content: 'Disband cancelled.', timestamp: Date.now() },
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
      const conductorInfo = state.conductorName ? '' : ' \u00b7 No conductor';
      return `${state.activeEnsemble} \u00b7 ${count} player${count !== 1 ? 's' : ''}${conductorInfo} \u00b7 Connected`;
    }
    const count = state.ensembles.length;
    return `${count} ensemble${count !== 1 ? 's' : ''} \u00b7 Connected`;
  }, [state.phase, state.chatTarget, state.activeEnsemble, state.players, state.ensembles]);

  // ── Hint text for prompt area ──
  const promptHints = useMemo(() => {
    if (state.confirmingStop) {
      return `Stop ${state.confirmingStop}? This will terminate their session. [y/N]`;
    }
    if (state.confirmingDisband) {
      return `Disband ensemble "${state.confirmingDisband}"? All sessions will be terminated. [y/N]`;
    }
    if (state.confirmingLineup) {
      return `${state.confirmingLineup.summary} [y/N]`;
    }
    if (state.phase === 'recruit') {
      return 'Follow the prompts above. Esc to cancel.';
    }
    if (state.chatTarget) {
      return `Chatting with ${state.chatTarget}. /back to return.`;
    }
    if (state.activeEnsemble) {
      return 'Type a message. /players to list. /chat <player> for direct chat.';
    }
    return '/help /quit';
  }, [state.phase, state.chatTarget, state.confirmingStop, state.confirmingDisband, state.activeEnsemble, state.conductorName]);

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

  // Palette filter state — updated via onInputChange ref callback (no dispatch per keystroke)
  const [paletteFilter, setPaletteFilter] = useState('');
  const handleInputChange = useCallback((value: string) => {
    inputValueRef.current = value;
    // Only update palette filter state when it actually changes — avoids unnecessary re-renders
    const trimmed = value.trimStart();
    if (trimmed.startsWith('/') && !trimmed.includes(' ')) {
      setPaletteFilter(trimmed.slice(1).toLowerCase());
    } else {
      // Functional update: return same ref if already empty → React skips re-render
      setPaletteFilter(prev => prev === '' ? prev : '');
    }
  }, []);

  const filteredPaletteCommands = useMemo(() => {
    if (!state.paletteVisible) return [];
    if (!paletteFilter) return allPaletteCommands;
    return allPaletteCommands.filter(c => c.name.startsWith(paletteFilter));
  }, [state.paletteVisible, paletteFilter, allPaletteCommands]);

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
      promptRef.current?.setValue(`/${selected.name} `);
      inputValueRef.current = `/${selected.name} `;
      dispatch({ type: 'HIDE_PALETTE' });
    }
  }, [filteredPaletteCommands, clampedPaletteIndex]);

  // ── Command submission handler ──
  const handleSubmit = useCallback(async (input: string) => {
    const trimmed = input.trim();
    if (!trimmed) return;
    const s = stateRef.current;

    // PromptArea clears itself on Enter (uncontrolled). Just clear our ref + palette.
    inputValueRef.current = '';
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
      if (parsed.name === 'back' || parsed.name === 'home' || parsed.name === 'maestro') {
        // Return to maestro view (exit any player chat)
        if (s.chatTarget) {
          dispatch({ type: 'EXIT_CHAT' });
          dispatch({
            type: 'COMMIT_STATIC',
            item: { id: nextStaticId(), type: 'info', content: `\u2500\u2500 returned to maestro view \u2500\u2500`, timestamp: Date.now() },
          });
        } else if (!s.activeEnsemble) {
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
    } else if (s.activeEnsemble) {
      // Bare text → send in current context
      // Chat mode: send directly to chatTarget
      // Maestro view (no chatTarget): send as maestro command to conductor
      const target = s.chatTarget;
      try {
        if (target) {
          // Player chat — send directly
          const isConductorTarget = target === s.conductorName;
          if (isConductorTarget) {
            await api.sendCommand(s.activeEnsemble!, trimmed, 'maestro');
          } else {
            await api.sendMessage(s.activeEnsemble!, target, trimmed, 'maestro');
          }
          dispatch({ type: 'APPEND_SENT_MESSAGE', to: target, text: trimmed });
          dispatch({
            type: 'COMMIT_STATIC',
            item: {
              id: nextStaticId(),
              type: 'message',
              content: `you \u2192 ${target}: ${trimmed}`,
              timestamp: Date.now(),
            },
          });
        } else {
          // Maestro view — send to conductor as maestro
          await api.sendCommand(s.activeEnsemble!, trimmed, 'maestro');
          dispatch({
            type: 'COMMIT_STATIC',
            item: {
              id: nextStaticId(),
              type: 'message',
              content: `maestro: ${trimmed}`,
              timestamp: Date.now(),
            },
          });
        }
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

  // ── Lightweight startup: check connectivity + ensure maestro session ──
  // Phase starts at 'main' — polling handles all data discovery.
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        // Check Temporal connectivity
        const connected = await api.isConnected();
        if (cancelled) return;
        if (!connected) {
          dispatch({ type: 'SET_PHASE', phase: 'error', error: 'Cannot connect to Temporal. Run `claude-tempo up` first.' });
          return;
        }

        // Mark splash as connected (updates splash UI)
        dispatch({ type: 'SET_SPLASH_CONNECTED' });

        // Ensure maestro session (best effort)
        const ens = stateRef.current.activeEnsemble;
        if (ens) {
          try { await api.ensureMaestroSession(ens); } catch { /* non-fatal */ }
        }
      } catch (err) {
        if (!cancelled) {
          dispatch({ type: 'SET_PHASE', phase: 'error', error: String(err) });
        }
      }
    })();
    return () => { cancelled = true; };
  }, [api]);

  // ── Polling loop ──
  useEffect(() => {
    if (state.phase !== 'splash' && state.phase !== 'main' && state.phase !== 'chat' && state.phase !== 'connected') return;

    const interval = setInterval(async () => {
      try {
        const s = stateRef.current;
        if (!s.activeEnsemble) {
          const ensembles = await api.discoverEnsembles();
          dispatch({ type: 'REFRESH_ENSEMBLES', ensembles });

          // Auto-connect only when exactly 1 ensemble AND not in splash mode
          // Splash handles ensemble selection via Enter key
          if (ensembles.length === 1 && !s.activeEnsemble && s.phase !== 'splash') {
            const autoEns = ensembles[0].name;
            dispatch({ type: 'NAVIGATE_ENSEMBLE', ensemble: autoEns });
            dispatch({
              type: 'COMMIT_STATIC',
              item: { id: `auto-${Date.now()}`, type: 'info', content: `\u2714 Connected to ensemble: ${autoEns}`, timestamp: Date.now() },
            });
            // Discover conductor but don't auto-enter chat — let user navigate
            try {
              const players = await api.getPlayers(autoEns);
              const conductor = players.find(p => p.isConductor);
              if (conductor) {
                dispatch({ type: 'SET_CONDUCTOR', name: conductor.playerId });
              }
            } catch { /* best effort */ }
          }
        } else {
          // Fetch relay messages + maestro direct messages in parallel
          const ens = s.activeEnsemble!;
          const inConductorChat = s.chatTarget === s.conductorName;
          const [players, messages, history, schedules, maestroMsgs] = await Promise.all([
            api.getPlayers(ens),
            api.getMessages(ens, 50),
            inConductorChat ? api.getConductorHistory(ens) : Promise.resolve([]),
            api.getSchedules(ens),
            api.getMaestroMessages(ens),
          ]);

          // Commit new relay messages to Static (full text, not truncated)
          if (messages.length > 0) {
            const prevId = lastSeenMsgRef.current;
            const newMsgs = prevId
              ? (() => { const idx = messages.findIndex(m => m.id === prevId); return idx >= 0 ? messages.slice(idx + 1) : messages; })()
              : messages; // First poll — hydrate all
            for (const m of newMsgs) {
              const time = new Date(m.timestamp);
              const hh = String(time.getHours()).padStart(2, '0');
              const mm = String(time.getMinutes()).padStart(2, '0');
              dispatch({
                type: 'COMMIT_STATIC',
                item: {
                  id: `msg-${m.id}`,
                  type: 'message',
                  content: `${m.from} \u2192 ${m.to}  ${hh}:${mm}`,
                  timestamp: Date.now(),
                },
              });
              // Full message body
              for (const line of m.text.split('\n')) {
                dispatch({
                  type: 'COMMIT_STATIC',
                  item: {
                    id: nextStaticId(),
                    type: 'command-output',
                    content: line,
                    timestamp: Date.now(),
                  },
                });
              }
            }
          }

          // Commit new maestro direct messages
          if (maestroMsgs.received.length > 0) {
            const prevDmId = lastSeenMaestroRef.current;
            const newDirect = prevDmId
              ? (() => { const idx = maestroMsgs.received.findIndex(m => m.id === prevDmId); return idx >= 0 ? maestroMsgs.received.slice(idx + 1) : []; })()
              : maestroMsgs.received; // First poll — hydrate all
            for (const m of newDirect) {
              const time = new Date(m.timestamp);
              const hh = String(time.getHours()).padStart(2, '0');
              const mm = String(time.getMinutes()).padStart(2, '0');
              dispatch({
                type: 'COMMIT_STATIC',
                item: {
                  id: `dm-${m.id}`,
                  type: 'message',
                  content: `${m.from} \u2192 you  ${hh}:${mm}`,
                  timestamp: Date.now(),
                },
              });
              for (const line of m.text.split('\n')) {
                dispatch({
                  type: 'COMMIT_STATIC',
                  item: {
                    id: nextStaticId(),
                    type: 'command-output',
                    content: line,
                    timestamp: Date.now(),
                  },
                });
              }
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

            // Auto-detect conductor: track name but don't auto-enter chat
            const currentS = stateRef.current;
            if (!currentS.conductorName) {
              const conductor = players.find(p => p.isConductor);
              if (conductor) {
                dispatch({ type: 'SET_CONDUCTOR', name: conductor.playerId });
              }
            }
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
      if (a.playerType) parts.push(`--type "${a.playerType}"`);
      if (a.agent !== 'claude') parts.push(`--agent ${a.agent}`);
      if (a.workDir) parts.push(`--dir "${a.workDir}"`);
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

  // Note: relay messages are committed to staticItems directly in the poll loop.
  // Conductor history messages are committed when entering conductor chat mode.

  // ── Render ──

  // Divider — thin horizontal rule
  const dividerWidth = Math.max(20, (process.stdout.columns || 80) - 4);
  const dividerLine = '\u2500'.repeat(dividerWidth);

  // Splash → main transition handler
  const handleSplashContinue = useCallback((selectedEnsemble?: string) => {
    if (selectedEnsemble) {
      dispatch({ type: 'NAVIGATE_ENSEMBLE', ensemble: selectedEnsemble });
      dispatch({
        type: 'COMMIT_STATIC',
        item: { id: nextStaticId(), type: 'info', content: `\u2714 Connected to ensemble: ${selectedEnsemble}`, timestamp: Date.now() },
      });
    }
    dispatch({ type: 'SET_PHASE', phase: 'main' });
  }, []);

  function renderLiveContent() {
    // Splash screen — shown on startup when no ensemble is specified
    if (state.phase === 'splash') {
      return React.createElement(Splash, {
        status: state.splashStatus,
        version: packageVersion,
        connected: state.splashConnected,
        ensembles: state.ensembles as EnsembleInfo[],
        onContinue: handleSplashContinue,
      });
    }

    if (state.phase === 'error') {
      return React.createElement(ErrorView, {
        version: packageVersion,
        checks: [
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

    // Main view — conversation stream (like Claude Code)
    if (state.activeEnsemble) {
      // Build merged conversation from relay messages + sent messages + conductor history
      const allConvoMsgs: Array<{ id: string; from: string; to: string; text: string; timestamp: string; direction: 'in' | 'out' }> = [];

      // Relay messages
      for (const m of state.messages) {
        allConvoMsgs.push({ id: m.id, from: m.from, to: m.to, text: m.text, timestamp: m.timestamp, direction: 'in' });
      }

      // Conductor history
      for (const entry of state.conductorHistory) {
        if (entry.type === 'command') {
          const cmd = entry.data as { text: string; source: string; timestamp: string };
          allConvoMsgs.push({ id: `ch-${entry.timestamp}`, from: cmd.source || 'maestro', to: 'conductor', text: cmd.text, timestamp: entry.timestamp || cmd.timestamp, direction: 'out' });
        } else {
          const report = entry.data as { playerId: string; text: string; type: string; timestamp: string };
          allConvoMsgs.push({ id: `cr-${entry.timestamp}`, from: report.playerId, to: 'maestro', text: `[${report.type}] ${report.text}`, timestamp: entry.timestamp || report.timestamp, direction: 'in' });
        }
      }

      // Sent messages (local echo)
      for (const m of state.sentMessages) {
        allConvoMsgs.push({ id: `sent-${m.timestamp}`, from: 'you', to: m.to, text: m.text, timestamp: m.timestamp, direction: 'out' });
      }

      // Deduplicate + sort
      const seen = new Set<string>();
      const sorted = allConvoMsgs
        .filter(m => { const k = `${m.direction}:${m.timestamp}:${m.text.slice(0, 40)}`; if (seen.has(k)) return false; seen.add(k); return true; })
        .sort((a, b) => a.timestamp.localeCompare(b.timestamp));

      // Format messages as lines, take the tail that fits the viewport
      const formatted: Array<{ sender: string; time: string; body: string; direction: 'in' | 'out' }> = [];
      for (const m of sorted) {
        let time = '';
        try { const d = new Date(m.timestamp); time = `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`; } catch { time = '??:??'; }
        formatted.push({ sender: m.direction === 'out' ? `you \u2192 ${m.to}` : m.from, time, body: m.text, direction: m.direction });
      }

      // Each message takes ~2 lines (sender+time, body truncated). Reserve 2 lines for header.
      const maxVisible = Math.max(3, Math.floor((contentHeight - 2) / 2));
      const visibleMsgs = formatted.slice(-maxVisible);

      const convoChildren: React.ReactNode[] = [];

      // Header — ensemble name + player count
      const playerCount = state.players.length;
      const conductorInfo = state.conductorName ? ` \u2605 ${state.conductorName}` : '';
      convoChildren.push(
        React.createElement(Text, { key: 'ch', color: THEME.dim },
          `  ${state.activeEnsemble} \u00B7 ${playerCount} player${playerCount !== 1 ? 's' : ''}${conductorInfo}`),
      );
      if (state.staticItems.length > 0) {
        convoChildren.push('\n');
        convoChildren.push(
          React.createElement(Text, { key: 'si', color: THEME.dim },
            `  \u2191 ${state.staticItems.length} messages above (scroll up)`),
        );
      }
      convoChildren.push('\n');
      convoChildren.push(React.createElement(Text, { key: 'csep', color: THEME.border }, '  ' + '\u2500'.repeat(50)));

      // Messages
      if (visibleMsgs.length === 0) {
        convoChildren.push('\n');
        convoChildren.push(React.createElement(Text, { key: 'empty', color: THEME.dim }, '  No messages yet. Type to send.'));
      } else {
        for (let i = 0; i < visibleMsgs.length; i++) {
          const msg = visibleMsgs[i];
          const senderColor = msg.direction === 'out' ? THEME.dim : THEME.accent;
          const bodyColor = msg.direction === 'out' ? THEME.textMuted : THEME.text;
          convoChildren.push('\n');
          convoChildren.push(
            React.createElement(React.Fragment, { key: `ms-${i}` },
              React.createElement(Text, { color: senderColor }, `  ${msg.sender}`),
              React.createElement(Text, { color: THEME.dim }, `  ${msg.time}`),
            ),
          );
          // Body — first 2 lines only for compact display
          const bodyLines = msg.body.split('\n').slice(0, 2);
          for (const line of bodyLines) {
            convoChildren.push('\n');
            convoChildren.push(React.createElement(Text, { key: `mb-${i}-${line.slice(0, 10)}`, color: bodyColor }, `  ${line.slice(0, 80)}`));
          }
          if (msg.body.split('\n').length > 2) {
            convoChildren.push('\n');
            convoChildren.push(React.createElement(Text, { key: `mt-${i}`, color: THEME.dim }, `  \u2026 (${msg.body.split('\n').length - 2} more lines)`));
          }
        }
      }

      return React.createElement(Text, null, ...convoChildren);
    }

    // No active ensemble — show ensemble list, connecting state, or help
    // If we have an initial ensemble but no data yet, show connecting message
    if (!state.activeEnsemble && state.ensembles.length === 0 && ensemble) {
      return React.createElement(Text, { color: THEME.dim }, `  Connecting to ${ensemble}...`);
    }
    if (state.ensembles.length > 0) {
      const ensLines: React.ReactNode[] = [
        React.createElement(Text, { key: 'eh', bold: true, color: THEME.text }, `${state.ensembles.length} ensembles running:`),
      ];
      for (const ens of state.ensembles) {
        ensLines.push('\n');
        ensLines.push(
          React.createElement(Text, { key: ens.name, color: THEME.textMuted },
            `  ${ens.name} (${ens.playerCount} player${ens.playerCount !== 1 ? 's' : ''})${ens.hasConductor ? ' \u2605' : ''}`,
          ),
        );
      }
      ensLines.push('\n');
      ensLines.push('\n');
      ensLines.push(
        React.createElement(Text, { key: 'hint', color: THEME.dim }, '  Type /ensemble <name> to connect'),
      );
      return React.createElement(Text, null, ...ensLines);
    }

    // Onboarding view — no ensembles running (single Text, 1 Yoga node)
    return React.createElement(Text, null,
      '\n',
      React.createElement(Text, { bold: true, color: THEME.accent }, '  Getting Started'), '\n',
      '\n',
      React.createElement(Text, { color: THEME.text }, '  No ensembles are running.'), '\n',
      '\n',
      React.createElement(Text, { color: THEME.text }, '  Create an ensemble:'), '\n',
      React.createElement(Text, { color: THEME.accent }, '    /up <name>'), '\n',
      '\n',
      React.createElement(Text, { color: THEME.text }, '  Or load a lineup:'), '\n',
      React.createElement(Text, { color: THEME.accent }, '    /lineup load <file.yml>'), '\n',
      '\n',
      React.createElement(Text, { color: THEME.dim }, '  The TUI will auto-detect ensembles as they start.'), '\n',
      React.createElement(Text, { color: THEME.dim }, '  Type /help for all available commands.'),
    );
  }

  // ── Static items — rendered once to stdout, become native terminal scrollback ──
  const { Static } = useInk();

  // Layout: header (2 lines) + content (variable) + footer (4 lines)
  // Content height is calculated to guarantee footer is always visible.
  const HEADER_LINES = 2; // TitleBar + top divider
  const FOOTER_LINES = 4; // StatusBar + bottom divider + PromptArea (hints + input)
  const contentHeight = Math.max(3, termRows - 1 - HEADER_LINES - FOOTER_LINES);

  // Splash phase — full screen, no chrome (title/status/prompt hidden)
  if (state.phase === 'splash') {
    return React.createElement(Box, { flexDirection: 'column', height: termRows - 1, overflow: 'hidden' },
      renderLiveContent(),
    );
  }

  // Root layout: <Static> items above, then live area constrained to terminal height
  return React.createElement(React.Fragment, null,
    // Static items — rendered once to stdout, become native terminal scrollback
    React.createElement(Static, { items: state.staticItems, children: (item: StaticItem) =>
      React.createElement(Text, { key: item.id, color: staticItemColor(item) }, `  ${item.content}`),
    }),
    // Live area — height constrained to termRows-1
    React.createElement(Box, { flexDirection: 'column', height: termRows - 1, overflow: 'hidden' },
      // Title bar (1 Text node)
      React.createElement(TitleBar, { context: contextString }),
      // Top divider (1 Text node, no Box wrapper)
      React.createElement(Text, { color: THEME.border }, ` ${dividerLine} `),
      // Content area — explicit height guarantees footer is visible
      React.createElement(Box, { flexDirection: 'column', height: contentHeight, overflow: 'hidden' },
        // Live content area
        renderLiveContent(),
      // Picker overlay (1 Text node when visible)
      state.pickerVisible
        ? React.createElement(Picker, {
            title: state.pickerType === 'players' ? 'Select Player' : 'Select Ensemble',
            items: pickerItems,
            selectedIndex: state.pickerIndex,
            hint: '\u2191\u2193 navigate, Enter select, Esc dismiss',
          })
        : null,
    ),
    // ── Footer (fixed height, always visible) ──
    // Status bar (1 Text node)
    React.createElement(StatusBar, {
      ensemble: state.activeEnsemble,
      players: state.players,
      scheduleCount: state.schedules.length,
      connected: true,
      conductorName: state.conductorName,
    }),
    // Bottom divider (1 Text node, no Box wrapper)
    React.createElement(Text, { color: THEME.border }, ` ${dividerLine} `),
    // Prompt area (1 Box + 2-3 Text nodes — uncontrolled, no parent dispatch per keystroke)
    React.createElement(PromptArea, {
      hints: promptHints,
      onSubmit: handleSubmit,
      disabled: state.phase === 'error' || state.phase === 'recruit' || state.phase === 'schedule-create' || !!state.confirmingStop || !!state.confirmingDisband || !!state.confirmingLineup,
      commandNames: commandNamesList,
      playerNames: playerNamesList,
      initialHistory: cmdHistory,
      onHistoryUpdate: handleHistoryUpdate,
      onInputChange: handleInputChange,
      paletteVisible: state.paletteVisible,
      onPaletteToggle: handlePaletteToggle,
      onPaletteUp: handlePaletteUp,
      onPaletteDown: handlePaletteDown,
      onPaletteSelect: handlePaletteSelect,
      inputRef: promptRef,
    }),
    // Command palette (1 Text node when visible)
    state.paletteVisible && filteredPaletteCommands.length > 0
      ? React.createElement(CommandPalette, {
          commands: filteredPaletteCommands,
          selectedIndex: clampedPaletteIndex,
        })
      : null,
    ), // closes live area Box
  ); // closes Fragment
}
