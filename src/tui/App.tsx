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
import type { StaticItem, RecruitAnswers, ScheduleAnswers, CreateEnsembleAnswers } from './store';
import type { PromptAreaHandle } from './components/PromptArea';

/** Ink Key interface — mirrors the key object passed to useInput callbacks. */
interface Key {
  upArrow: boolean;
  downArrow: boolean;
  leftArrow: boolean;
  rightArrow: boolean;
  return: boolean;
  escape: boolean;
  ctrl: boolean;
  shift: boolean;
  tab: boolean;
  backspace: boolean;
  delete: boolean;
  meta: boolean;
  pageDown: boolean;
  pageUp: boolean;
}

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
import { CreateEnsembleWizard } from './components/CreateEnsembleWizard';
import { CommandPalette } from './components/CommandPalette';
import { StatusOverlay } from './components/StatusOverlay';
import { ConversationStream } from './components/ConversationStream';
import { PlayerDetailView } from './components/PlayerDetailView';
import { Picker } from './components/Picker';
import type { PickerItem } from './components/Picker';
import { parseCommand, isValidCommand, formatHelpSummary, COMMANDS, getCommandNames, PLAYER_PARAM_COMMANDS, SUBCOMMAND_MAP } from './commands';
import { THEME } from './utils/theme';
import { wordWrap } from './utils/format';
import { loadHistory, saveHistory } from './utils/history';
import type { TempoClient } from './client';

// eslint-disable-next-line @typescript-eslint/no-var-requires
const packageVersion: string = require('../../package.json').version;

interface AppProps {
  api: TempoClient;
  /** If provided, start directly in ensemble view. */
  ensemble?: string;
  /** Default agent type from config (defaults to 'claude'). */
  defaultAgent?: 'claude' | 'copilot';
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

export function App({ api, ensemble, defaultAgent }: AppProps) {
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
  const lastChatRef = React.useRef({ total: 0, lastTs: '' });
  // Track which messages have been committed to Static (overflow from live area)
  const overflowCommittedRef = React.useRef(new Set<string>());
  // Overflow data computed during render, committed to Static via useEffect
  const overflowRef = React.useRef<{ formatted: Array<{ sender: string; time: string; body: string; direction: 'in' | 'out'; thirdParty?: boolean; routeLabel?: string }>; startIdx: number } | null>(null);
  // Callback for picker selection — set before showing picker, called on Enter
  const pickerCallbackRef = React.useRef<((id: string) => void) | null>(null);
  // Picker items ref — synced from pickerItems memo so useInput reads sorted items
  const pickerItemsRef = React.useRef<PickerItem[]>([]);

  // Reset stale refs when switching ensembles + add separator
  const prevEnsembleRef = React.useRef(state.activeEnsemble);
  useEffect(() => {
    lastSeenMsgRef.current = undefined;
    lastSeenMaestroRef.current = undefined;
    lastPollRef.current = { playerCount: 0, lastMsgId: '', historyLen: 0, scheduleCount: 0, maestroMsgCount: 0 };
    overflowCommittedRef.current.clear();
    // Add separator when switching between ensembles (not on initial load)
    if (state.activeEnsemble && prevEnsembleRef.current !== state.activeEnsemble && prevEnsembleRef.current !== undefined) {
      dispatch({
        type: 'COMMIT_STATIC',
        item: {
          id: nextStaticId(),
          type: 'info',
          content: `\u2500\u2500 Switched to ensemble: ${state.activeEnsemble} \u2500\u2500`,
          timestamp: Date.now(),
        },
      });
    }
    prevEnsembleRef.current = state.activeEnsemble;
  }, [state.activeEnsemble]);
  // Commit overflow messages to Static scrollback after render (not during render)
  useEffect(() => {
    const data = overflowRef.current;
    if (!data) return;
    const { formatted, startIdx } = data;
    const overflow = formatted.slice(0, startIdx);
    for (const msg of overflow) {
      const key = `${msg.direction}:${msg.time}:${msg.body.slice(0, 60)}`;
      if (!overflowCommittedRef.current.has(key)) {
        overflowCommittedRef.current.add(key);
        // Blank separator
        dispatch({ type: 'COMMIT_STATIC', item: { id: nextStaticId(), type: 'info', content: '', timestamp: Date.now() } });
        // Cap third-party messages to 4 lines; direct messages uncapped
        const lines = msg.body.split('\n');
        const lineCap = msg.thirdParty ? 4 : lines.length;
        let body = lines.slice(0, lineCap).join('\n');
        if (lines.length > lineCap) {
          body += `\n\u2026 (${lines.length - lineCap} more lines)`;
        }
        // Commit entire body as a single message item — static renderer word-wraps correctly
        dispatch({ type: 'COMMIT_STATIC', item: {
          id: nextStaticId(), type: 'message', content: body, timestamp: Date.now(),
          msgDirection: msg.direction, msgSender: msg.sender, msgTime: msg.time,
          msgThirdParty: msg.thirdParty, msgRouteLabel: msg.routeLabel,
        }});
      }
    }
  });

  const handleHistoryUpdate = useCallback((entries: string[]) => {
    saveHistory(entries);
  }, []);

  // ── Global keybindings (uses stateRef to avoid recreating on every poll) ──
  useInput(useCallback((input: string, key: Key) => {
    const s = stateRef.current;
    if (key.ctrl && input === 'c') {
      exit();
      return;
    }

    // Scrollback navigation (Page Up/Down, Home/End)
    // Scroll keys removed — terminal native scrollback via <Static> handles this

    // Status overlay — Escape dismisses, ↑↓ scrolls
    if (s.statusOverlay) {
      if (key.escape) { dispatch({ type: 'HIDE_STATUS' }); return; }
      if (key.upArrow) { dispatch({ type: 'STATUS_SCROLL_UP' }); return; }
      if (key.downArrow) { dispatch({ type: 'STATUS_SCROLL_DOWN' }); return; }
      return;
    }

    // Interactive overlay — Escape dismisses, ↑↓ selects, action keys per type
    if (s.overlay) {
      if (key.escape) { dispatch({ type: 'HIDE_OVERLAY' }); return; }
      if (key.upArrow) { dispatch({ type: 'OVERLAY_SELECT', direction: 'up' }); return; }
      if (key.downArrow) { dispatch({ type: 'OVERLAY_SELECT', direction: 'down' }); return; }
      // Schedule overlay action keys
      if (s.overlay.type === 'schedules') {
        if (input === 'n' || input === 'N') {
          dispatch({ type: 'HIDE_OVERLAY' });
          dispatch({ type: 'ENTER_SCHEDULE_WIZARD' });
          return;
        }
      }
      return; // Swallow all other input while overlay is active
    }

    // Player detail view — Escape goes back, ↑↓ scrolls messages
    if (s.view === 'player') {
      if (key.escape) {
        dispatch({ type: 'NAVIGATE_ENSEMBLE', ensemble: s.activeEnsemble! });
        // Reset chat cache so next poll immediately re-dispatches conversation
        lastChatRef.current = { total: 0, lastTs: '' };
        return;
      }
      if (key.upArrow) { dispatch({ type: 'PLAYER_SCROLL_UP' }); return; }
      if (key.downArrow) { dispatch({ type: 'PLAYER_SCROLL_DOWN' }); return; }
      return;
    }

    // Picker overlay navigation
    if (s.pickerVisible) {
      if (key.escape) { dispatch({ type: 'HIDE_PICKER' }); return; }
      if (key.upArrow) { dispatch({ type: 'PICKER_UP' }); return; }
      if (key.downArrow) { dispatch({ type: 'PICKER_DOWN' }); return; }
      if (key.return) {
        const cb = pickerCallbackRef.current;
        if (s.pickerType === 'players') {
          const item = pickerItemsRef.current[s.pickerIndex];
          if (item) {
            dispatch({ type: 'HIDE_PICKER' });
            if (cb) {
              cb(item.id);
              pickerCallbackRef.current = null;
            } else if (s.pickerIntent === 'navigate') {
              // Navigate to player detail view
              dispatch({ type: 'NAVIGATE_PLAYER', playerId: item.id });
            } else {
              // Default: navigate to player detail view
              dispatch({ type: 'NAVIGATE_PLAYER', playerId: item.id });
            }
          }
        } else if (s.pickerType === 'ensembles') {
          const ensItem = pickerItemsRef.current[s.pickerIndex];
          if (ensItem) {
            dispatch({ type: 'HIDE_PICKER' });
            if (ensItem.id === '__create__') {
              // Launch the create-ensemble wizard
              dispatch({ type: 'ENTER_CREATE_ENSEMBLE' });
            } else if (cb) {
              cb(ensItem.id);
              pickerCallbackRef.current = null;
            } else {
              dispatch({ type: 'NAVIGATE_ENSEMBLE', ensemble: ensItem.id });
              dispatch({
                type: 'COMMIT_STATIC',
                item: { id: nextStaticId(), type: 'info', content: `Switched to ensemble: ${ensItem.id}`, timestamp: Date.now() },
              });
            }
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
    const count = state.ensembles?.length ?? 0;
    return count > 0 ? `${count} ensemble${count !== 1 ? 's' : ''} \u00b7 Connected` : 'Discovering ensembles...';
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
      return 'Type a message, or @player to message directly. /players to list.';
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
      // Apply status filter if set (e.g. 'stale' for encore)
      const filtered = state.pickerStatusFilter
        ? state.players.filter(p => p.status === state.pickerStatusFilter)
        : state.players;
      // Sort by type for grouping, conductor first
      const sorted = [...filtered].sort((a, b) => {
        if (a.isConductor !== b.isConductor) return a.isConductor ? -1 : 1;
        const typeA = a.playerType || a.agentType || '';
        const typeB = b.playerType || b.agentType || '';
        return typeA.localeCompare(typeB) || a.playerId.localeCompare(b.playerId);
      });
      return sorted.map(p => ({
        id: p.playerId,
        label: p.playerId,
        detail: `[${p.status || '?'}]`,
        meta: p.part || undefined,
        icon: p.isConductor ? '\u2605' : p.status === 'active' ? '\u25CF' : p.status === 'stale' ? '\u25CB' : '\u25D4',
        color: p.status === 'active' ? THEME.success : p.status === 'stale' ? THEME.warning : THEME.dim,
        current: p.playerId === state.chatTarget,
        group: p.playerType || p.agentType || 'unknown',
      }));
    }

    if (state.pickerType === 'ensembles') {
      const items: PickerItem[] = (state.ensembles ?? []).map(ens => ({
        id: ens.name,
        label: ens.name,
        detail: `${ens.playerCount} player${ens.playerCount !== 1 ? 's' : ''}`,
        meta: ens.hasConductor ? '\u2605 conductor' : undefined,
        current: ens.name === state.activeEnsemble,
      }));
      // Add "Create new ensemble" option at the bottom
      items.push({
        id: '__create__',
        label: '+ Create new ensemble',
        detail: 'launch wizard',
        icon: '\u2795',
        color: THEME.accent,
      });
      return items;
    }

    return [];
  }, [state.pickerVisible, state.pickerType, state.pickerStatusFilter, state.players, state.ensembles, state.chatTarget, state.activeEnsemble]);
  pickerItemsRef.current = pickerItems;

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
    const trimmed = value.trimStart();
    if ((trimmed.startsWith('/') || trimmed.startsWith('@')) && !trimmed.includes(' ')) {
      setPaletteFilter(trimmed.toLowerCase());
    } else {
      setPaletteFilter(prev => prev === '' ? prev : '');
    }
  }, []);

  // Player commands and subcommand map imported from commands.ts

  const paletteIsPlayerMode = paletteFilter.startsWith('@');

  const filteredPaletteCommands = useMemo(() => {
    if (!state.paletteVisible) return [];
    if (paletteIsPlayerMode) {
      const partial = paletteFilter.slice(1); // strip @
      return playerNamesList
        .filter(n => {
          const lower = n.toLowerCase();
          return !partial || lower.startsWith(partial) || lower.split('-').some(seg => seg.startsWith(partial));
        })
        .map(n => ({ name: n, usage: `@${n}`, description: '' }));
    }
    const cmdFilter = paletteFilter.startsWith('/') ? paletteFilter.slice(1) : paletteFilter;
    if (!cmdFilter) return allPaletteCommands;
    return allPaletteCommands.filter(c => c.name.startsWith(cmdFilter));
  }, [state.paletteVisible, paletteFilter, paletteIsPlayerMode, allPaletteCommands, playerNamesList]);

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
      const prefix = paletteIsPlayerMode ? '@' : '/';
      const value = `${prefix}${selected.name} `;
      promptRef.current?.setValue(value);
      inputValueRef.current = value;
      dispatch({ type: 'HIDE_PALETTE' });
    }
  }, [filteredPaletteCommands, clampedPaletteIndex, paletteIsPlayerMode]);

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
      if (parsed.name === 'quit') {
        exit();
        return;
      }
      if (parsed.name === 'back') {
        // Return to maestro view (exit any player chat)
        if (s.chatTarget) {
          dispatch({ type: 'EXIT_CHAT' });
          dispatch({
            type: 'COMMIT_STATIC',
            item: { id: nextStaticId(), type: 'info', content: `\u2500\u2500 returned to maestro view \u2500\u2500`, timestamp: Date.now() },
          });
        } else if (s.activeEnsemble) {
          dispatch({ type: 'NAVIGATE_HOME' });
          dispatch({
            type: 'COMMIT_STATIC',
            item: { id: nextStaticId(), type: 'info', content: `\u2500\u2500 returned to home view \u2500\u2500`, timestamp: Date.now() },
          });
        }
        return;
      }
      if (parsed.name === 'help') {
        if (parsed.args.length > 0) {
          const cmdName = parsed.args[0].replace(/^\//, '');
          const cmd = COMMANDS[cmdName];
          if (cmd) {
            dispatch({ type: 'SHOW_COMMAND_OVERLAY', title: `Help \u00B7 /${cmdName}`, content: `\n  ${cmd.description}\n\n  Usage: ${cmd.usage}` });
          } else {
            dispatch({ type: 'SHOW_COMMAND_OVERLAY', title: 'Help', content: `\n  Unknown command: "${cmdName}"` });
          }
        } else {
          dispatch({ type: 'SHOW_COMMAND_OVERLAY', title: 'Help', content: formatHelpSummary() });
        }
        return;
      }

      // Commands that open player picker when no args provided
      const PICKER_COMMANDS: Record<string, (playerId: string) => void> = {
        stop: (id) => {
          dispatch({ type: 'COMMIT_STATIC', item: { id: nextStaticId(), type: 'info', content: `Stopping ${id}...`, timestamp: Date.now() } });
          const cmd = COMMANDS['stop'];
          if (cmd?.handler) cmd.handler([id], dispatch, api, { activeEnsemble: stateRef.current.activeEnsemble, defaultAgent });
        },
        encore: (id) => {
          const cmd = COMMANDS['encore'];
          if (cmd?.handler) cmd.handler([id], dispatch, api, { activeEnsemble: stateRef.current.activeEnsemble, defaultAgent });
        },
        players: (id) => {
          dispatch({ type: 'NAVIGATE_PLAYER', playerId: id });
        },
        player: (id) => {
          dispatch({ type: 'NAVIGATE_PLAYER', playerId: id });
        },
      };

      if (PICKER_COMMANDS[parsed.name] && parsed.args.length === 0) {
        pickerCallbackRef.current = PICKER_COMMANDS[parsed.name];
        // Encore picker shows only stale players
        const statusFilter = parsed.name === 'encore' ? 'stale' : undefined;
        dispatch({ type: 'SHOW_PICKER', pickerType: 'players', statusFilter });
        return;
      }

      // Alias: /player → /players
      if (parsed.name === 'player') {
        parsed.name = 'players';
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
        const ctx = { activeEnsemble: s.activeEnsemble, defaultAgent };
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
      // Bare text → route via @player or to conductor
      const atMatch = trimmed.match(/^@(\S+)\s+(.+)$/s);
      try {
        if (atMatch) {
          // @player message → send directly to that player
          const [, targetPlayer, message] = atMatch;
          dispatch({ type: 'APPEND_SENT_MESSAGE', to: targetPlayer, text: message });
          api.sendAsMaestro(s.activeEnsemble!, targetPlayer, message).catch(err => dispatch({
            type: 'COMMIT_STATIC',
            item: { id: nextStaticId(), type: 'error', content: `\u2717 Failed to deliver to @${targetPlayer}: ${err}`, timestamp: Date.now() },
          }));
        } else if (s.conductorName || s.hasConductor) {
          // No @prefix → send to conductor
          const conductorTarget = s.conductorName || 'conductor';
          dispatch({ type: 'APPEND_SENT_MESSAGE', to: conductorTarget, text: trimmed });
          api.sendCommand(s.activeEnsemble!, trimmed, 'maestro').catch(err => dispatch({
            type: 'COMMIT_STATIC',
            item: { id: nextStaticId(), type: 'error', content: `\u2717 Failed to deliver: ${err}`, timestamp: Date.now() },
          }));
        } else {
          // No conductor — show error
          dispatch({
            type: 'COMMIT_STATIC',
            item: { id: nextStaticId(), type: 'error', content: 'No conductor. Use @player to message directly, or /recruit a conductor.', timestamp: Date.now() },
          });
        }
      } catch (err) {
        dispatch({
          type: 'COMMIT_STATIC',
          item: { id: nextStaticId(), type: 'error', content: `\u2717 Error: ${err}`, timestamp: Date.now() },
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
          try { await api.ensureMaestroSession(ens); } catch (err) { console.error('[tui] Failed to create maestro session:', err); }
        }
      } catch (err) {
        if (!cancelled) {
          dispatch({ type: 'SET_PHASE', phase: 'error', error: String(err) });
        }
      }
    })();
    return () => { cancelled = true; };
  }, [api]);

  // ── Ensure maestro session exists when ensemble changes ──
  useEffect(() => {
    if (!state.activeEnsemble) return;
    api.ensureMaestroSession(state.activeEnsemble).catch(err =>
      console.error('[tui] maestro session:', err)
    );
  }, [state.activeEnsemble, api]);

  // ── Polling loop ──
  useEffect(() => {
    if (state.phase !== 'splash' && state.phase !== 'main' && state.phase !== 'chat') return;

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
          // Single source: maestro workflow for players, schedules, and ensemble chat
          const ens = s.activeEnsemble!;
          const [players, schedules, chatResult] = await Promise.all([
            api.getPlayers(ens),
            api.getSchedules(ens),
            api.getEnsembleChat(ens, 0, 50),
          ]);

          // Map ensemble chat to conversation format for ConversationStream
          const conversation = chatResult.messages.map(m => ({
            id: m.id,
            from: m.from,
            to: m.to,
            text: m.text,
            timestamp: m.timestamp,
            direction: (m.role === 'maestro-out' ? 'out' : 'in') as 'in' | 'out',
            role: m.role,
            thirdParty: m.role === 'conductor-out' || m.role === 'conductor-in',
          }));

          dispatch({ type: 'REFRESH_ENSEMBLE_DATA', players, messages: [], history: [], schedules });

          // Skip redundant conversation dispatches when data hasn't changed
          const lastChatMsg = chatResult.messages[chatResult.messages.length - 1];
          const newLastTs = lastChatMsg?.timestamp ?? '';
          if (chatResult.total !== lastChatRef.current.total || newLastTs !== lastChatRef.current.lastTs) {
            dispatch({ type: 'SET_CONVERSATION', conversation });
            dispatch({ type: 'SET_ENSEMBLE_CHAT', chat: chatResult });
            lastChatRef.current = { total: chatResult.total, lastTs: newLastTs };
          }

          // Track conductor
          const currentS = stateRef.current;
          if (!currentS.conductorName) {
            const conductor = players.find(p => p.isConductor);
            if (conductor) {
              dispatch({ type: 'SET_CONDUCTOR', name: conductor.playerId });
            }
          }

          // Fetch player-specific data when viewing a player
          if (currentS.view === 'player' && currentS.activePlayer) {
            try {
              const [playerMeta, playerMsgs] = await Promise.all([
                api.getPlayerMetadata(ens, currentS.activePlayer),
                api.getPlayerMessages(ens, currentS.activePlayer),
              ]);
              dispatch({ type: 'REFRESH_PLAYER_DATA', metadata: playerMeta, messages: playerMsgs });
            } catch {
              // Best-effort — player may have been terminated
            }
          }
        }
      } catch (err) {
        console.error('[tui:poll] error:', err);
      }
    }, 2000);

    return () => clearInterval(interval);
  }, [state.phase, state.activeEnsemble, api]);

  // ── Recruit wizard callbacks (must be before early return — Rules of Hooks) ──
  const handleRecruitAnswer = useCallback((answer: Partial<RecruitAnswers>) => {
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
  const handleScheduleAnswer = useCallback((answer: Partial<ScheduleAnswers>) => {
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

  // ── Create ensemble wizard callbacks ──
  const handleCreateEnsAnswer = useCallback((answer: Partial<CreateEnsembleAnswers>) => {
    dispatch({ type: 'CREATE_ENSEMBLE_NEXT_STEP', answer });
  }, []);
  const handleCreateEnsBack = useCallback(() => {
    dispatch({ type: 'CREATE_ENSEMBLE_PREV_STEP' });
  }, []);
  const handleCreateEnsConfirm = useCallback(async () => {
    const wizState = stateRef.current.createEnsembleState;
    if (!wizState) return;
    dispatch({ type: 'CREATE_ENSEMBLE_SUBMIT' });
    const { name, workDir, lineup } = wizState.answers;
    try {
      const { execFile } = require('child_process') as typeof import('child_process');
      const args = lineup
        ? ['up', name, '--lineup', lineup]
        : ['up', name];
      await new Promise<void>((resolve, reject) => {
        execFile('claude-tempo', args, { cwd: workDir, timeout: 60000 }, (err: Error | null, _stdout: string, stderr: string) => {
          if (err) reject(new Error(stderr?.trim() || err.message || 'Unknown error'));
          else resolve();
        });
      });
      dispatch({
        type: 'COMMIT_STATIC',
        item: { id: nextStaticId(), type: 'info', content: `\u2714 Ensemble "${name}" created.`, timestamp: Date.now() },
      });
      dispatch({ type: 'CREATE_ENSEMBLE_DONE', ensemble: name });
    } catch (err) {
      dispatch({ type: 'CREATE_ENSEMBLE_DONE', error: err instanceof Error ? err.message : String(err) });
    }
  }, []);
  const handleCreateEnsCancel = useCallback(() => {
    dispatch({ type: 'EXIT_CREATE_ENSEMBLE' });
  }, []);
  const handleCreateEnsDone = useCallback(() => {
    dispatch({ type: 'EXIT_CREATE_ENSEMBLE' });
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

  // Splash → create ensemble handler: launch the create-ensemble wizard
  const handleSplashCreate = useCallback(() => {
    dispatch({ type: 'ENTER_CREATE_ENSEMBLE' });
  }, []);

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
    // Terminal size warning (non-blocking)
    const termCols = process.stdout.columns || 80;
    if (termCols < 60 || termRows < 15) {
      return React.createElement(Text, { color: THEME.warning },
        `\n  \u26A0 Terminal too small (${termCols}\u00D7${termRows}). Resize to at least 60\u00D715 for best experience.`);
    }

    // Splash screen — shown on startup when no ensemble is specified
    if (state.phase === 'splash') {
      return React.createElement(Splash, {
        status: state.splashStatus,
        version: packageVersion,
        connected: state.splashConnected,
        ensembles: (state.ensembles ?? undefined) as EnsembleInfo[] | undefined,
        onContinue: handleSplashContinue,
        onCreateEnsemble: handleSplashCreate,
      });
    }

    if (state.phase === 'error') {
      return React.createElement(ErrorView, {
        version: packageVersion,
        checks: [
          { label: `Cannot reach Temporal`, passed: false, detail: state.error },
        ],
        errorDetail: state.error,
        onQuit: () => { process.exitCode = 1; exit(); },
      });
    }

    // Picker takes over full content area
    if (state.pickerVisible) {
      const pickerTitle = state.pickerType === 'ensembles'
        ? 'Select Ensemble'
        : state.pickerStatusFilter === 'stale'
          ? 'Select Stale Player to Encore'
          : 'Select Player';
      return React.createElement(Picker, {
        title: pickerTitle,
        items: pickerItems,
        selectedIndex: state.pickerIndex,
        hint: '\u2191\u2193 navigate, Enter select, Esc dismiss',
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

    if (state.phase === 'create-ensemble' && state.createEnsembleState) {
      return React.createElement(CreateEnsembleWizard, {
        state: state.createEnsembleState,
        onAnswer: handleCreateEnsAnswer,
        onBack: handleCreateEnsBack,
        onConfirm: handleCreateEnsConfirm,
        onCancel: handleCreateEnsCancel,
        onDone: handleCreateEnsDone,
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

    // Status overlay — card layout with scrolling
    if (state.statusOverlay && state.activeEnsemble) {
      return React.createElement(StatusOverlay, {
        players: state.players,
        ensemble: state.activeEnsemble,
        scrollOffset: state.statusScrollOffset,
        contentHeight,
      });
    }

    // Unified overlay — all overlay types rendered here
    if (state.overlay) {
      const ov = state.overlay;
      const children: React.ReactNode[] = [];
      children.push(React.createElement(Text, { key: 'ov-title', bold: true, color: THEME.accent }, `  ${ov.title}`));
      if (ov.items.length === 0) {
        children.push('\n\n');
        children.push(React.createElement(Text, { key: 'ov-empty', color: THEME.dim }, '  No items.'));
      } else {
        for (let i = 0; i < ov.items.length; i++) {
          const item = ov.items[i];
          const selected = i === ov.selectedIndex;
          const prefix = selected ? ' \u276F ' : '   ';
          children.push('\n\n');
          children.push(React.createElement(Text, { key: `ov-${i}`, color: selected ? THEME.text : THEME.dim, bold: selected },
            `${prefix}${item.label}`));
          if (item.sublabel) {
            children.push('\n');
            children.push(React.createElement(Text, { key: `ovs-${i}`, color: THEME.dim }, `    ${item.sublabel}`));
          }
        }
      }
      // Pad to fill contentHeight
      const usedLines = 1 + ov.items.reduce((n, item) => n + 2 + (item.sublabel ? 1 : 0), 0) + 2;
      const padLines = Math.max(0, contentHeight - usedLines);
      if (padLines > 0) children.push('\n'.repeat(padLines));
      children.push('\n');
      children.push(React.createElement(Text, { key: 'ov-hint', color: THEME.dim }, `  ${ov.hint}`));
      return React.createElement(Text, null, ...children);
    }

    // Player detail view — shows player metadata + message history
    if (state.view === 'player' && state.activePlayer && state.activeEnsemble) {
      const player = state.players.find(p => p.playerId === state.activePlayer) || null;
      return React.createElement(PlayerDetailView, {
        playerId: state.activePlayer,
        ensemble: state.activeEnsemble,
        player,
        metadata: state.playerMetadata,
        messages: state.playerMessages,
        scrollOffset: state.playerScrollOffset,
      });
    }

    // Main view — conversation stream (like Claude Code)
    if (state.activeEnsemble) {
      // Show loading state until first poll completes
      if (state.conversation === null) {
        return React.createElement(Text, { color: THEME.dim }, '\n  \u27F3 Loading messages...');
      }
      return React.createElement(ConversationStream, {
        conversation: state.conversation,
        sentMessages: state.sentMessages,
        contentHeight,
        overflowRef,
      });
    }

    // No active ensemble — show ensemble list, loading state, or help
    // Still loading ensembles
    if (state.ensembles === null) {
      if (ensemble) {
        return React.createElement(Text, { color: THEME.dim }, `\n  \u27F3 Connecting to ${ensemble}...`);
      }
      return React.createElement(Text, { color: THEME.dim }, '\n  \u27F3 Discovering ensembles...');
    }
    if (state.ensembles.length > 0) {
      const ensLines: React.ReactNode[] = [
        React.createElement(Text, { key: 'eh', bold: true, color: THEME.text }, `${state.ensembles.length} ensemble${state.ensembles.length !== 1 ? 's' : ''} running:`),
      ];
      for (const ens of state.ensembles) {
        ensLines.push('\n');
        ensLines.push(
          React.createElement(Text, { key: ens.name, color: THEME.textMuted },
            `  ${ens.name} (${ens.playerCount} player${ens.playerCount !== 1 ? 's' : ''})${ens.hasConductor ? ' \u2605' : ''}`,
          ),
        );
      }
      ensLines.push('\n\n');
      ensLines.push(
        React.createElement(Text, { key: 'hint', color: THEME.dim }, '  Type /ensemble <name> to connect, or /ensemble to browse'),
      );
      return React.createElement(Text, null, ...ensLines);
    }

    // No ensembles running (single Text, 1 Yoga node)
    return React.createElement(Text, null,
      '\n',
      React.createElement(Text, { bold: true, color: THEME.accent }, '  Getting Started'), '\n',
      '\n',
      React.createElement(Text, { color: THEME.text }, '  No ensembles are running.'), '\n',
      '\n',
      React.createElement(Text, { color: THEME.text }, '  Create an ensemble:'), '\n',
      React.createElement(Text, { color: THEME.accent }, '    /ensemble → + Create new ensemble'), '\n',
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

  // Layout: header (2 lines) + content (variable) + footer (dynamic)
  // Content height is calculated to guarantee footer is always visible.
  // When command palette is visible, footer grows to accommodate palette items.
  const paletteLines = (state.paletteVisible && filteredPaletteCommands.length > 0)
    ? Math.min(filteredPaletteCommands.length, 6) + (filteredPaletteCommands.length > 6 ? 2 : 0) // items + scroll indicators
    : 0;
  const FOOTER_LINES = 4 + paletteLines; // StatusBar + divider + PromptArea + bottom divider + palette
  const contentHeight = Math.max(3, termRows - 1 - FOOTER_LINES);

  // Splash phase — full screen, no chrome (title/status/prompt hidden)
  if (state.phase === 'splash') {
    return React.createElement(Box, { flexDirection: 'column', height: termRows - 1, overflow: 'hidden' },
      renderLiveContent(),
    );
  }

  // Root layout: <Static> items above, then live area constrained to terminal height
  return React.createElement(React.Fragment, null,
    // Static items — rendered once to stdout, become native terminal scrollback
    React.createElement(Static, { items: state.staticItems, children: (item: StaticItem) => {
      // Rich rendering for messages — header + indented body (matches live ConversationStream)
      if (item.type === 'message' && item.msgDirection) {
        const cols = process.stdout.columns || 80;
        const bodyWidth = Math.max(20, cols - 4);
        const wrapped = wordWrap(item.content, bodyWidth);
        if (item.msgDirection === 'out') {
          // Outbound: ♩ first line, then indented continuation (matches live)
          const firstLine = wrapped[0] || '';
          const pad = ' '.repeat(Math.max(0, cols - 2 - 3 - firstLine.length));
          const contLines = wrapped.slice(1).map(l => `   ${l}`.padEnd(cols - 2)).join('\n');
          const children: React.ReactNode[] = [
            React.createElement(Text, { backgroundColor: THEME.inputBg, color: THEME.accent, bold: true }, ' \u2669 '),
            React.createElement(Text, { backgroundColor: THEME.inputBg, color: THEME.text }, firstLine),
            React.createElement(Text, { backgroundColor: THEME.inputBg, color: THEME.dim }, pad),
          ];
          if (contLines) {
            children.push('\n');
            children.push(React.createElement(Text, { backgroundColor: THEME.inputBg, color: THEME.text }, contLines));
          }
          return React.createElement(Text, { key: item.id }, ...children);
        } else {
          // Inbound: header + 3-space indent body
          const isThirdParty = item.msgThirdParty;
          const headerLabel = item.msgRouteLabel || item.msgSender || '';
          const headerPrefix = isThirdParty ? '   ' : ' \u2190 ';
          const headerColor = isThirdParty ? THEME.dim : THEME.accent;
          const bodyColor = isThirdParty ? THEME.textMuted : THEME.text;
          const bodyLines = wrapped.map(l => `   ${l}`).join('\n');
          return React.createElement(Text, { key: item.id },
            React.createElement(Text, { color: THEME.dim }, headerPrefix),
            React.createElement(Text, { color: headerColor }, headerLabel),
            React.createElement(Text, { color: THEME.dim }, `  ${item.msgTime || ''}`),
            '\n',
            React.createElement(Text, { color: bodyColor }, bodyLines),
          );
        }
      }
      // Fallback for non-message items
      return React.createElement(Text, { key: item.id, color: staticItemColor(item) }, `  ${item.content}`);
    }}),
    // Live area — height constrained to termRows-1
    React.createElement(Box, { flexDirection: 'column', height: termRows - 1, overflow: 'hidden' },
      // Content area — full height above footer
      React.createElement(Box, { flexDirection: 'column', height: contentHeight, overflow: 'hidden' },
        // Live content area
        renderLiveContent(),
    ),
    // ── Footer (fixed height, always visible) ──
    // Status bar (1 Text node)
    React.createElement(StatusBar, {
      ensemble: state.activeEnsemble,
      players: state.players,
      playersLoaded: state.playersLoaded,
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
      disabled: state.phase === 'error' || state.phase === 'recruit' || state.phase === 'schedule-create' || !!state.confirmingStop || !!state.confirmingDisband || !!state.confirmingLineup || state.pickerVisible || state.statusOverlay || !!state.overlay,
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
    // Bottom divider (1 Text node)
    React.createElement(Text, { color: THEME.border }, ` ${dividerLine} `),
    // Command palette (1 Text node when visible)
    state.paletteVisible && filteredPaletteCommands.length > 0
      ? React.createElement(CommandPalette, {
          commands: filteredPaletteCommands,
          selectedIndex: clampedPaletteIndex,
          prefix: paletteIsPlayerMode ? '@' : '/',
        })
      : null,
    ), // closes live area Box
  ); // closes Fragment
}
