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
import { hostname as osHostname } from 'os';
import { useInk } from './ink-context';
import { tuiReducer, initialState } from './store';
import type { StaticItem, RecruitAnswers, ScheduleAnswers, CreateEnsembleAnswers, TuiState } from './store';
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
import { HomeView } from './components/HomeView';
import { NewEnsembleModal } from './components/NewEnsembleModal';
import { LoadLineupModal } from './components/LoadLineupModal';
import { RestoreConfirmModal } from './components/RestoreConfirmModal';
import { DestroyConfirmModal } from './components/DestroyConfirmModal';
import type { HomeViewInitial } from './components/HomeView';
import { CommandPalette } from './components/CommandPalette';
import { StatusOverlay } from './components/StatusOverlay';
import { ConversationStream } from './components/ConversationStream';
import { PlayerDetailView } from './components/PlayerDetailView';
import { Picker } from './components/Picker';
import type { PickerItem } from './components/Picker';
import { parseCommand, isValidCommand, formatHelpSummary, COMMANDS, getCommandNames, PLAYER_PARAM_COMMANDS, SUBCOMMAND_MAP, classifyPaletteInput, filterPlayerNames, commitNotification } from './commands';
import { removedSlashCommandHelp } from './removed-commands';
import { THEME } from './utils/theme';
import { phaseToLabel, phaseToColor, phaseToIconName, filterRealPlayers } from './utils/format';
import { statusIcons as phaseStatusIcons, supportsUnicode as phaseSupportsUnicode } from './utils/platform';
import { wordWrap } from './utils/format';
import { loadHistory, saveHistory } from './utils/history';
import type { TempoClient } from '../client';
import { handleSseEvent } from './sse-handler';

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
      // Gates/stages — Enter shows detail for selected item
      if ((s.overlay.type === 'gates' || s.overlay.type === 'stages') && key.return) {
        const selected = s.overlay.items[s.overlay.selectedIndex];
        if (selected) {
          const detail = selected.sublabel
            ? `\n  ${selected.label}\n\n  ${selected.sublabel.split('  ').join('\n  ')}`
            : `\n  ${selected.label}\n\n  No details available.`;
          dispatch({ type: 'SHOW_COMMAND_OVERLAY', title: selected.label.slice(0, 40), content: detail });
        }
        return;
      }
      return; // Swallow all other input while overlay is active
    }

    // Player detail view — Escape goes back, ↑↓ scrolls messages
    if (s.view === 'player') {
      if (key.escape) {
        dispatch({ type: 'NAVIGATE_ENSEMBLE', ensemble: s.activeEnsemble! });
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

    // Destroy confirmation mode (PR-H: was `/stop`; now `/destroy` and routed
    // through TempoClient.destroy() — the V2 outbox path — instead of the
    // legacy raw-Temporal `terminatePlayer` shim.
    if (s.confirmingStop) {
      if (input === 'y' || input === 'Y') {
        const target = s.confirmingStop;
        const reason = s.confirmingStopReason;
        dispatch({ type: 'CANCEL_STOP' });
        (async () => {
          try {
            const ensembles = await api.discoverEnsembles();
            for (const ens of ensembles) {
              try {
                await api.destroy(ens.name, target, reason);
                // #306: command-result summary as a bottom-pinned notification
                // so the user actually sees the confirmation when chat is busy.
                commitNotification(
                  dispatch,
                  'info',
                  `\u2716 Destroyed ${target}${reason ? ` (${reason})` : ''}.`,
                );
                return;
              } catch {
                // Try next ensemble
              }
            }
            commitNotification(dispatch, 'error', `\u2717 Player "${target}" not found in any ensemble.`);
          } catch (err) {
            commitNotification(dispatch, 'error', `\u2717 Failed to destroy ${target}: ${err}`);
          }
        })();
      } else if (input === 'n' || input === 'N' || key.escape) {
        dispatch({ type: 'CANCEL_STOP' });
        dispatch({
          type: 'COMMIT_STATIC',
          item: { id: nextStaticId(), type: 'info', content: 'Destroy cancelled.', timestamp: Date.now() },
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
            commitNotification(dispatch, 'error', `\u2717 Failed to disband "${ensemble}": ${err}`);
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
          commitNotification(dispatch, 'error', 'No active ensemble.');
        } else {
          (async () => {
            try {
              await api.sendCommand(activeEns, `/load_lineup ${lineupPath}`, 'maestro');
              dispatch({
                type: 'COMMIT_STATIC',
                item: { id: nextStaticId(), type: 'info', content: `\u2714 Lineup load requested: ${lineupPath}`, timestamp: Date.now() },
              });
            } catch (err) {
              commitNotification(dispatch, 'error', `\u2717 Failed to load lineup: ${err}`);
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

    // #306: Esc dismisses the oldest live notification when no other
    // Esc-consumer is active (overlays, pickers, confirmations all return
    // early above). Filter-expired-first is handled in the reducer so this
    // always acts on what the user is actually looking at. No-op when the
    // stack is empty, so other Esc fallthroughs — like clearing a typed
    // command — aren't disturbed.
    if (key.escape && s.notifications.some(n => n.expiresAt > Date.now())) {
      dispatch({ type: 'DISMISS_OLDEST_NOTIFICATION' });
      return;
    }
  }, [exit, api])); // Stable deps only — reads stateRef.current for everything else

  // ── Derived: conductor player id ──
  // #358: single source of truth — derive the active conductor's playerId from
  // the `players` array rather than caching it in a separate state field that
  // only the snapshot path updated. Incremental SSE events (`player.added`,
  // `player.removed`) update `players` directly, so the badge stays accurate
  // between snapshots. `undefined` when no conductor is in the ensemble.
  const conductorPlayerId = useMemo(
    () => state.players.find(p => p.isConductor)?.playerId,
    [state.players],
  );

  // ── Context string for title bar ──
  const contextString = useMemo(() => {
    if (state.phase === 'splash') return 'Starting up...';
    if (state.phase === 'error') return 'Error';
    if (state.chatTarget) {
      const isConductor = state.chatTarget === conductorPlayerId;
      const player = state.players.find(p => p.playerId === state.chatTarget);
      const status = phaseToLabel(player?.phase);
      const icon = isConductor ? '\u2605' : '\u2022';
      return `${icon} ${state.chatTarget} \u00b7 ${status}${state.activeEnsemble ? ` \u00b7 ${state.activeEnsemble}` : ''}`;
    }
    if (state.activeEnsemble) {
      // Headline count excludes the maestro session (TUI's own dashboard
      // attachment). The full list with the maestro is still available in
      // `/players` and the status overlay.
      const count = filterRealPlayers(state.players).length;
      const conductorInfo = conductorPlayerId ? '' : ' \u00b7 No conductor';
      return `${state.activeEnsemble} \u00b7 ${count} player${count !== 1 ? 's' : ''}${conductorInfo} \u00b7 Connected`;
    }
    const count = state.ensembles?.length ?? 0;
    return count > 0 ? `${count} ensemble${count !== 1 ? 's' : ''} \u00b7 Connected` : 'Discovering ensembles...';
  }, [state.phase, state.chatTarget, state.activeEnsemble, state.players, state.ensembles, conductorPlayerId]);

  // ── Hint text for prompt area ──
  const promptHints = useMemo(() => {
    if (state.confirmingStop) {
      return `Destroy ${state.confirmingStop}? This will terminally end their session workflow. [y/N]`;
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
  }, [state.phase, state.chatTarget, state.confirmingStop, state.confirmingDisband, state.activeEnsemble]);

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
      // Apply status filter if set.
      const filtered = state.pickerStatusFilter
        ? state.players.filter(p => p.phase === state.pickerStatusFilter)
        : state.players;
      // Sort by type for grouping, conductor first
      const sorted = [...filtered].sort((a, b) => {
        if (a.isConductor !== b.isConductor) return a.isConductor ? -1 : 1;
        const typeA = a.playerType || a.agentType || '';
        const typeB = b.playerType || b.agentType || '';
        return typeA.localeCompare(typeB) || a.playerId.localeCompare(b.playerId);
      });
      // Resolve icons once for the whole map (not per-item) per
      // docs/tui-performance.md — `statusIcons()` allocates a small object.
      const icons = phaseStatusIcons(phaseSupportsUnicode());
      return sorted.map(p => ({
        id: p.playerId,
        label: p.playerId,
        detail: `[${phaseToLabel(p.phase)}]`,
        meta: p.part || undefined,
        icon: p.isConductor ? '\u2605' : icons[phaseToIconName(p.phase)],
        color: phaseToColor(p.phase),
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

  // Palette filter state — updated via onInputChange ref callback (no dispatch per keystroke).
  // Stores the full PaletteContext (mode + partial + replacePrefix) so the palette can
  // show player names for `/restart <partial>`-style player-arg inputs, not just bare
  // `/cmd` and `@name` inputs.
  const [paletteCtx, setPaletteCtx] = useState<ReturnType<typeof classifyPaletteInput>>(null);
  const handleInputChange = useCallback((value: string) => {
    inputValueRef.current = value;
    const next = classifyPaletteInput(value);
    // Reference-equal no-op avoidance: only dispatch when mode/partial actually changed.
    setPaletteCtx(prev => {
      if (prev === next) return prev;
      if (prev && next && prev.mode === next.mode && prev.partial === next.partial && prev.replacePrefix === next.replacePrefix) {
        return prev;
      }
      return next;
    });
  }, []);

  // Player commands and subcommand map imported from commands.ts

  const filteredPaletteCommands = useMemo(() => {
    if (!state.paletteVisible || !paletteCtx) return [];
    if (paletteCtx.mode === 'player' || paletteCtx.mode === 'player-arg') {
      return filterPlayerNames(playerNamesList, paletteCtx.partial)
        .map(n => ({ name: n, usage: `${paletteCtx.replacePrefix}${n}`, description: '' }));
    }
    // command mode
    if (!paletteCtx.partial) return allPaletteCommands;
    return allPaletteCommands.filter(c => c.name.startsWith(paletteCtx.partial));
  }, [state.paletteVisible, paletteCtx, allPaletteCommands, playerNamesList]);

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
    if (filteredPaletteCommands.length > 0 && paletteCtx) {
      const selected = filteredPaletteCommands[clampedPaletteIndex];
      // replacePrefix already carries the right leading characters:
      //   command mode    → '/'         → `${/}recruit `
      //   player mode     → '@'         → `${@}conductor `
      //   player-arg mode → '/restart ' → `${/restart }conductor `
      const value = `${paletteCtx.replacePrefix}${selected.name} `;
      promptRef.current?.setValue(value);
      inputValueRef.current = value;
      dispatch({ type: 'HIDE_PALETTE' });
    }
  }, [filteredPaletteCommands, clampedPaletteIndex, paletteCtx]);

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
        players: (id) => {
          dispatch({ type: 'NAVIGATE_PLAYER', playerId: id });
        },
        player: (id) => {
          dispatch({ type: 'NAVIGATE_PLAYER', playerId: id });
        },
      };

      if (PICKER_COMMANDS[parsed.name] && parsed.args.length === 0) {
        pickerCallbackRef.current = PICKER_COMMANDS[parsed.name];
        dispatch({ type: 'SHOW_PICKER', pickerType: 'players' });
        return;
      }

      // Alias: /player → /players
      if (parsed.name === 'player') {
        parsed.name = 'players';
      }

      if (!isValidCommand(parsed.name)) {
        const migrationHint = removedSlashCommandHelp(parsed.name);
        commitNotification(
          dispatch,
          'error',
          migrationHint ?? `Unknown command: /${parsed.name}. Type /help for available commands.`,
        );
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
        commitNotification(dispatch, 'error', `Error running /${parsed.name}: ${err}`);
      }
    } else if (s.activeEnsemble) {
      // Bare text → route via @player or to conductor
      const atMatch = trimmed.match(/^@(\S+)\s+(.+)$/s);
      try {
        if (atMatch) {
          // @player message → send directly to that player
          const [, targetPlayer, message] = atMatch;
          dispatch({ type: 'APPEND_SENT_MESSAGE', to: targetPlayer, text: `@${targetPlayer} ${message}` });
          api.sendAsMaestro(s.activeEnsemble!, targetPlayer, message).catch(err =>
            commitNotification(dispatch, 'error', `\u2717 Failed to deliver to @${targetPlayer}: ${err}`),
          );
        } else {
          // No @prefix → send to conductor.
          // #358: derive from `players` (single source of truth) instead of
          // a separate cached field. `hasConductor` is the snapshot-derived
          // flag; we fall back to the legacy `'conductor'` literal when no
          // playerId is yet known so a freshly-loaded ensemble with the
          // hasConductor flag still routes correctly.
          const conductorPid = s.players.find(p => p.isConductor)?.playerId;
          if (!conductorPid && !s.hasConductor) {
            // No conductor — show error
            commitNotification(dispatch, 'error', 'No conductor. Use @player to message directly, or /recruit a conductor.');
            return;
          }
          const conductorTarget = conductorPid || 'conductor';
          dispatch({ type: 'APPEND_SENT_MESSAGE', to: conductorTarget, text: trimmed });
          api.sendCommand(s.activeEnsemble!, trimmed, 'maestro').catch(err =>
            commitNotification(dispatch, 'error', `\u2717 Failed to deliver: ${err}`),
          );
        }
      } catch (err) {
        commitNotification(dispatch, 'error', `\u2717 Error: ${err}`);
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

  // ── #94/#95 PR-4a: data acquisition is split across three effects ──
  //
  // Previously a single 2 s `setInterval` fanned out 5 RPCs/tick (players,
  // schedules, chat, paused, held) and conditionally drilled into a
  // selected player. After PR-3 the per-ensemble surface is exposed via
  // SSE, so we:
  //   1. Keep a 2 s poll for the home view's ensemble list (no per-
  //      ensemble surface there; SSE wouldn't help).
  //   2. Subscribe to the daemon's SSE event stream for the active
  //      ensemble so player/chat/flags/schedule updates land in
  //      sub-second latency rather than waiting for a poll tick.
  //   3. Keep a 2 s poll for the player drill-in view — per
  //      docs/SSE-PROTOCOL.md §11 the per-player + per-message
  //      endpoints are intentionally Temporal-direct.
  // PR-4b will replace the rendering primitives (chat scrollback +
  // player list); this PR deliberately leaves layout untouched so a
  // streaming regression is bisectable independent of scroll changes.

  // Effect 1: home-view ensembles list polling.
  useEffect(() => {
    if (state.phase !== 'splash' && state.phase !== 'main' && state.phase !== 'chat') return;
    if (state.activeEnsemble) return;

    let cancelled = false;
    const tick = async (): Promise<void> => {
      try {
        const ensembles = await api.discoverEnsembles();
        if (cancelled) return;
        // Intentionally no auto-select: HomeView is an explicit picker
        // (Online / Paused / Offline, arrow keys + Enter). Auto-selecting
        // on the poller was bouncing users back into a just-shut-down
        // ensemble after `/shutdown`, `/back`, or `/disband`.
        dispatch({ type: 'REFRESH_ENSEMBLES', ensembles });
      } catch (err) {
        console.error('[tui:home-poll] error:', err);
      }
    };
    void tick();
    const interval = setInterval(tick, 2000);
    return () => {
      cancelled = true;
      clearInterval(interval);
    };
  }, [state.phase, state.activeEnsemble, api]);

  // Effect 2: active-ensemble SSE subscription.
  useEffect(() => {
    if (state.phase !== 'splash' && state.phase !== 'main' && state.phase !== 'chat') return;
    if (!state.activeEnsemble) return;

    const ensemble = state.activeEnsemble;
    const controller = new AbortController();

    void (async () => {
      try {
        for await (const event of api.subscribe(ensemble, { signal: controller.signal })) {
          await handleSseEvent(event, dispatch, ensemble, api);
        }
      } catch (err) {
        // AbortError on teardown is expected — only log unexpected failures.
        if (controller.signal.aborted) return;
        console.error('[tui:subscribe] error:', err);
      }
    })();

    return () => controller.abort();
  }, [state.phase, state.activeEnsemble, api]);

  // Effect 3: player drill-in polling (per spec §11 — Temporal-direct).
  useEffect(() => {
    if (state.view !== 'player') return;
    if (!state.activeEnsemble || !state.activePlayer) return;

    const ensemble = state.activeEnsemble;
    const playerId = state.activePlayer;
    let cancelled = false;
    const tick = async (): Promise<void> => {
      try {
        const [metadata, messages] = await Promise.all([
          api.getPlayerMetadata(ensemble, playerId),
          api.getPlayerMessages(ensemble, playerId),
        ]);
        if (cancelled) return;
        dispatch({ type: 'REFRESH_PLAYER_DATA', metadata, messages });
      } catch {
        // Best-effort — player may have been terminated mid-poll.
      }
    };
    void tick();
    const interval = setInterval(tick, 2000);
    return () => {
      cancelled = true;
      clearInterval(interval);
    };
  }, [state.view, state.activeEnsemble, state.activePlayer, api]);

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
      // #306: Direct TempoClient path — submit the recruit entry on the
      // TUI's own maestro session instead of round-tripping through the
      // conductor's Claude Code session. Works when no conductor is present
      // (the wizard's original use-case) and eliminates the 2-5s LLM hop.
      await api.recruit(activeEns, {
        name: a.name,
        workDir: a.workDir,
        agent: a.agent,
        ...(a.playerType ? { playerType: a.playerType } : {}),
        ...(a.host && a.host !== 'localhost' ? { host: a.host } : {}),
        ...(a.initialMessage ? { initialMessage: a.initialMessage } : {}),
      });
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
      await api.createEnsemble({ ensemble: name, workDir, ...(lineup ? { lineup } : {}) });
      dispatch({
        type: 'COMMIT_STATIC',
        item: { id: nextStaticId(), type: 'info', content: `\u2714 Ensemble "${name}" created.`, timestamp: Date.now() },
      });
      dispatch({ type: 'CREATE_ENSEMBLE_DONE', ensemble: name });
    } catch (err) {
      dispatch({ type: 'CREATE_ENSEMBLE_DONE', error: err instanceof Error ? err.message : String(err) });
    }
  }, [api]);
  const handleCreateEnsCancel = useCallback(() => {
    dispatch({ type: 'EXIT_CREATE_ENSEMBLE' });
  }, []);
  const handleCreateEnsDone = useCallback(() => {
    dispatch({ type: 'EXIT_CREATE_ENSEMBLE' });
  }, []);

  // ── Home view ─────────────────────────────────────────────────────────
  const [cwdGitRoot] = useState<string | null>(() => {
    const { getGitInfo } = require('../git-info') as typeof import('../git-info');
    return getGitInfo(process.cwd()).gitRoot ?? null;
  });

  const bootstrapInitial = useMemo<HomeViewInitial>(() => ({
    ensembles: state.ensembles ?? [],
    cwdGitRoot,
    badges: { orphanCount: 0 },
  }), [state.ensembles, cwdGitRoot]);

  const handleHomeEnter = useCallback((name: string) => {
    dispatch({ type: 'NAVIGATE_ENSEMBLE', ensemble: name });
  }, []);

  const handleHomeQuit = useCallback(() => {
    exit();
  }, [exit]);

  const handleHomeOpenNew = useCallback(() => {
    // #306: Use the full CreateEnsembleWizard (same as Splash's `+ Create new
    // ensemble` row) so the user gets the multi-step name → dir → lineup
    // flow instead of the bare single-prompt NewEnsembleModal.
    dispatch({ type: 'ENTER_CREATE_ENSEMBLE' });
  }, []);

  const handleHomeOpenLineup = useCallback(() => {
    dispatch({ type: 'OPEN_HOME_MODAL', modal: { type: 'lineup' } });
  }, []);

  const handleHomeOpenRestore = useCallback((ensembleName: string) => {
    const match = state.ensembles?.find((e) => e.name === ensembleName);
    dispatch({
      type: 'OPEN_HOME_MODAL',
      modal: {
        type: 'restore',
        ensemble: ensembleName,
        playerCount: Math.max(0, (match?.playerCount ?? 1) - (match?.hasConductor ? 1 : 0)),
        conductor: match?.hasConductor ? 'conductor' : undefined,
      },
    });
  }, [state.ensembles]);

  const handleHomeModalClose = useCallback(() => {
    dispatch({ type: 'CLOSE_HOME_MODAL' });
  }, []);

  const handleHomeNewSubmit = useCallback(async (name: string) => {
    dispatch({ type: 'SET_HOME_MODAL_STATUS', submitting: true });
    try {
      await api.createEnsemble({ ensemble: name });
      dispatch({ type: 'CLOSE_HOME_MODAL' });
      dispatch({ type: 'NAVIGATE_ENSEMBLE', ensemble: name });
    } catch (err) {
      dispatch({
        type: 'SET_HOME_MODAL_STATUS',
        submitting: false,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }, [api]);

  const handleHomeLineupSubmit = useCallback(async (args: { ensemble: string; lineupPath: string }) => {
    dispatch({ type: 'SET_HOME_MODAL_STATUS', submitting: true });
    try {
      await api.createEnsemble({ ensemble: args.ensemble, lineup: args.lineupPath });
      dispatch({ type: 'CLOSE_HOME_MODAL' });
      dispatch({ type: 'NAVIGATE_ENSEMBLE', ensemble: args.ensemble });
    } catch (err) {
      dispatch({
        type: 'SET_HOME_MODAL_STATUS',
        submitting: false,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }, [api]);

  // /destroy <ensemble> typed-name confirmation handlers (#291)
  const handleEnsembleDestroyInput = useCallback((next: string) => {
    dispatch({ type: 'ENSEMBLE_DESTROY_INPUT', input: next });
  }, []);

  const handleEnsembleDestroyCancel = useCallback(() => {
    dispatch({ type: 'CANCEL_ENSEMBLE_DESTROY' });
    dispatch({
      type: 'COMMIT_STATIC',
      item: { id: nextStaticId(), type: 'info', content: 'Destroy cancelled.', timestamp: Date.now() },
    });
  }, []);

  const handleEnsembleDestroySubmit = useCallback(async () => {
    const pending = stateRef.current.confirmingEnsembleDestroy;
    if (!pending) return;
    if (pending.input !== pending.ensemble) {
      dispatch({ type: 'ENSEMBLE_DESTROY_MISMATCH' });
      return;
    }
    dispatch({ type: 'ENSEMBLE_DESTROY_SUBMIT_BUSY' });
    const target = pending.ensemble;
    try {
      const summary = await api.destroy(target);
      dispatch({ type: 'CANCEL_ENSEMBLE_DESTROY' });
      if (summary && 'details' in summary) {
        // #306: aggregate ensemble-destroy summary surfaces as a bottom-pinned
        // notification so it's still visible after we navigate the user home.
        commitNotification(
          dispatch,
          summary.failed > 0 ? 'error' : 'info',
          `\u2714 Destroyed "${target}" \u2014 ${summary.destroyed} destroyed, ${summary.terminated} terminated, ${summary.failed} failed.`,
        );
      }
      dispatch({ type: 'NAVIGATE_HOME' });
    } catch (err) {
      dispatch({ type: 'CANCEL_ENSEMBLE_DESTROY' });
      commitNotification(
        dispatch,
        'error',
        `\u2717 Destroy failed for "${target}": ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }, [api]);

  const handleHomeRestoreConfirm = useCallback(async () => {
    const modal = stateRef.current.homeModal;
    if (!modal || modal.type !== 'restore') return;
    const target = modal.ensemble;
    dispatch({ type: 'SET_HOME_MODAL_STATUS', submitting: true });
    try {
      const summary = await api.restore(target);
      dispatch({ type: 'CLOSE_HOME_MODAL' });
      if (summary.failed > 0) {
        commitNotification(
          dispatch,
          'error',
          `Restore partial: ${summary.reattached} queued, ${summary.failed} failed, ${summary.skipped} skipped.`,
        );
      }
      // Mirror the `/restore` slash two-op: ensure a conductor terminal is
      // live so the home-view restore path never strands the user on a
      // reattached-but-conductor-less ensemble.
      const { ensureConductorSpawned } = await import('../client/ensure-conductor-spawned');
      const conductorOutcome = await ensureConductorSpawned(target, api);
      if (!conductorOutcome.spawned && conductorOutcome.reason === 'spawnFailed') {
        commitNotification(dispatch, 'error', `Conductor spawn failed for "${target}": ${conductorOutcome.error}`);
      }
      dispatch({ type: 'NAVIGATE_ENSEMBLE', ensemble: target });
    } catch (err) {
      dispatch({
        type: 'SET_HOME_MODAL_STATUS',
        submitting: false,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }, [api]);

  // ── Memoize chat messages (must be before early return — Rules of Hooks) ──
  const memoizedChatData = useMemo(() => {
    if (!state.chatTarget) return null;
    const isConductorChat = state.chatTarget === conductorPlayerId;

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
  }, [state.chatTarget, conductorPlayerId, state.conductorHistory, state.messages, state.sentMessages]);

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

    // Home-view modals (#290). Render in place of HomeView so the modal
    // owns keyboard focus — HomeView's own useInput short-circuits when a
    // modal is up (matches the wizard pattern).
    if (state.homeModal?.type === 'new') {
      return React.createElement(NewEnsembleModal, {
        onSubmit: handleHomeNewSubmit,
        onCancel: handleHomeModalClose,
        submitting: state.homeModalSubmitting,
        error: state.homeModalError,
      });
    }
    if (state.homeModal?.type === 'lineup') {
      return React.createElement(LoadLineupModal, {
        onSubmit: handleHomeLineupSubmit,
        onCancel: handleHomeModalClose,
        submitting: state.homeModalSubmitting,
        error: state.homeModalError,
      });
    }
    if (state.homeModal?.type === 'restore') {
      return React.createElement(RestoreConfirmModal, {
        ensemble: state.homeModal.ensemble,
        playerCount: state.homeModal.playerCount,
        conductorName: state.homeModal.conductor,
        onConfirm: handleHomeRestoreConfirm,
        onCancel: handleHomeModalClose,
        submitting: state.homeModalSubmitting,
        error: state.homeModalError,
      });
    }

    // /destroy <ensemble> typed-name confirmation modal (#291)
    if (state.confirmingEnsembleDestroy) {
      return React.createElement(DestroyConfirmModal, {
        ensemble: state.confirmingEnsembleDestroy.ensemble,
        input: state.confirmingEnsembleDestroy.input,
        error: state.confirmingEnsembleDestroy.error,
        submitting: state.confirmingEnsembleDestroy.submitting,
        onInput: handleEnsembleDestroyInput,
        onSubmit: handleEnsembleDestroySubmit,
        onCancel: handleEnsembleDestroyCancel,
      });
    }

    // Home view (#290) — renders when on the 'home' navigation and the
    // app is past the splash connection check. The view pre-renders from
    // the current `ensembles` snapshot and refreshes itself on a timer.
    if (state.phase === 'main' && state.view === 'home' && state.splashConnected) {
      return React.createElement(HomeView, {
        initial: bootstrapInitial,
        client: api,
        onEnterEnsemble: handleHomeEnter,
        onCreateEnsemble: handleHomeOpenNew,
        onLoadLineup: handleHomeOpenLineup,
        onRestoreEnsemble: handleHomeOpenRestore,
        onQuit: handleHomeQuit,
      });
    }

    if (state.chatTarget && memoizedChatData) {
      const targetPlayer = state.players.find(p => p.playerId === state.chatTarget);

      return React.createElement(ChatView, {
        targetPlayer: state.chatTarget,
        targetPart: targetPlayer?.part,
        targetBranch: targetPlayer?.gitBranch,
        targetStatus: targetPlayer?.phase,
        targetHost: targetPlayer?.hostname,
        localHost: osHostname(),
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
        localHost: osHostname(),
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
        conductorPlayerId,
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

  // ── Notification expiry tick (#306) ──
  // A single interval keeps the notifications stack fresh — when any
  // notification exists, bump the tick counter every 500ms so the render
  // pass re-evaluates `expiresAt > Date.now()` and drops expired entries
  // from view. Auto-stops (cleared to 0) when the stack empties, avoiding
  // a background timer when there's nothing to watch. Cheap — one integer
  // diff per tick, and only while notifications are live.
  useEffect(() => {
    if (state.notifications.length === 0) return undefined;
    const id = setInterval(() => {
      dispatch({ type: 'NOTIFICATION_TICK' });
    }, 500);
    return () => clearInterval(id);
  }, [state.notifications.length]);

  // ── Static items — rendered once to stdout, become native terminal scrollback ──
  const { Static } = useInk();

  // Layout: header (2 lines) + content (variable) + footer (dynamic)
  // Content height is calculated to guarantee footer is always visible.
  // When command palette is visible, footer grows to accommodate palette items.
  const paletteLines = (state.paletteVisible && filteredPaletteCommands.length > 0)
    ? Math.min(filteredPaletteCommands.length, 6) + (filteredPaletteCommands.length > 6 ? 2 : 0) // items + scroll indicators
    : 0;
  // #306: Notifications stack lives below the palette. Each live notification
  // takes one line; when the stack is empty, this contributes zero to the
  // footer so the main content area gets the full terminal height back.
  const now = Date.now();
  const notificationLines = state.notifications.filter(n => n.expiresAt > now).length;
  // Pinned confirmation lines — persist exactly as long as the state does,
  // no TTL. Each active confirmation state contributes one line above the
  // notifications stack. Keeps the y/N prompt anchored below the input so
  // it can't scroll away under new messages.
  const confirmationLines = countPinnedConfirmationLines(state);
  // #306 follow-up: Pinned paused/held tip — 1 row when an ensemble is
  // paused or held (or both), 0 otherwise. Same accounting pattern as
  // confirmationLines so the live content area reclaims the row when the
  // tip auto-clears on state change.
  const tipLines = countPinnedTipLines(state);
  // #306: Hide the chat prompt on the home view. Home is a wizard/picker
  // (arrow keys + Enter), not a chat target — there is no ensemble to talk
  // to, and a visible input box double-fires Enter (HomeView's own useInput
  // selects the row, PromptArea's useInput submits the empty buffer). The
  // Splash phase already follows this pattern; home now mirrors it. When
  // hidden we drop 2 lines from FOOTER_LINES (PromptArea row + the second
  // divider) so the live content area reclaims that space.
  const hidePrompt = isHomeView(state);
  const promptFooterLines = hidePrompt ? 0 : 2; // PromptArea + bottom divider
  const FOOTER_LINES = 2 + promptFooterLines + paletteLines + confirmationLines + tipLines + notificationLines; // StatusBar + divider + (PromptArea + bottom divider when shown) + palette + pinned confirmations + paused/held tip + notifications
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
      ensemblePaused: state.ensemblePaused,
      ensembleHeld: state.ensembleHeld,
    }),
    // Bottom divider (1 Text node, no Box wrapper)
    React.createElement(Text, { color: THEME.border }, ` ${dividerLine} `),
    // Prompt area + bottom divider — hidden on the home view (#306).
    // Home is a picker, not a chat target; the input would either eat keys
    // or double-fire Enter against HomeView's own useInput. Mirrors the
    // Splash phase, which renders no prompt at all.
    hidePrompt
      ? null
      : React.createElement(PromptArea, {
          hints: promptHints,
          onSubmit: handleSubmit,
          disabled: (state.phase !== 'main' && state.phase !== 'chat') || !!state.confirmingStop || !!state.confirmingDisband || !!state.confirmingEnsembleDestroy || !!state.confirmingLineup || state.pickerVisible || state.statusOverlay || !!state.overlay,
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
    // Bottom divider (1 Text node) — also hidden when the prompt is hidden
    // so the footer accounting in FOOTER_LINES stays consistent.
    hidePrompt
      ? null
      : React.createElement(Text, { color: THEME.border }, ` ${dividerLine} `),
    // Command palette (1 Text node when visible)
    state.paletteVisible && filteredPaletteCommands.length > 0
      ? React.createElement(CommandPalette, {
          commands: filteredPaletteCommands,
          selectedIndex: clampedPaletteIndex,
          // Display prefix mirrors what the user's input would become on select.
          prefix: paletteCtx?.replacePrefix ?? '/',
        })
      : null,
    // Pinned confirmation prompts — sit directly below the prompt area,
    // above the notifications stack. Unlike notifications, these have no
    // TTL and persist exactly as long as the corresponding `confirming*`
    // state field is set. Keeps the y/N (or typed-name) prompt visible
    // even when new chat messages are flooding the scroll-up history.
    renderPinnedConfirmations(state, Box, Text),
    // #306 follow-up: paused/held informational tip. Dim color so it
    // sits behind the warning-yellow confirmations and red-error
    // notifications visually. Auto-clears on state change.
    renderPinnedTip(state, Box, Text),
    // #306: Bottom-pinned notifications — errors/warnings stay visible below
    // the prompt until they TTL out (8s for errors, 5s otherwise) or the user
    // hits Esc. Filters by `expiresAt` every render; the notificationTick
    // counter forces periodic re-renders while entries are live.
    renderNotifications(state.notifications, Box, Text),
    ), // closes live area Box
  ); // closes Fragment
}

/**
 * #306: Render the bottom-pinned notification stack. Kept as a free function
 * (not a component) so the caller composes Ink primitives directly — the
 * App's render tree is already heavy with createElement calls, and a
 * dedicated component for 10 lines of JSX would add a layout boundary for
 * no gain.
 */
function renderNotifications(
  notifications: TuiState['notifications'],
  Box: React.ComponentType<any>,
  Text: React.ComponentType<any>,
): React.ReactNode {
  const now = Date.now();
  const live = notifications.filter(n => n.expiresAt > now);
  if (live.length === 0) return null;
  return React.createElement(
    Box,
    { flexDirection: 'column', paddingLeft: 1, paddingRight: 1 },
    ...live.map(n => {
      const icon = n.kind === 'error' ? '✗'
        : n.kind === 'warn' ? '⚠'
        : 'ⓘ';
      const color = n.kind === 'error' ? THEME.error
        : n.kind === 'warn' ? THEME.warning
        : THEME.accent;
      return React.createElement(
        Text,
        { key: `notif-${n.id}`, color },
        `${icon}  ${stripLeadingIcon(n.content)}`,
      );
    }),
  );
}

/**
 * #306: Strip a leading kind-icon (`✗ `, `⚠ `, `ⓘ `) from notification
 * content. Defensive: many call sites historically prepended the icon into
 * the message string, and the renderer also prepends a kind-based icon —
 * without this normalization the user sees the icon twice (e.g.
 * `✗ ✗ Cannot destroy the conductor …`). Exported for unit testing.
 */
export function stripLeadingIcon(content: string): string {
  return content.replace(/^[✗⚠ⓘ]\s+/u, '');
}

/**
 * #306: True when the TUI is on the home picker view — `phase === 'main'`
 * AND `view === 'home'`. The chat input has no target on this view (the
 * ensemble has not been entered yet), and HomeView owns Enter to navigate
 * its own row list. Render guard for PromptArea + the second divider so
 * the input cannot double-fire alongside HomeView's own `useInput`.
 *
 * Pure function, exported so tests can pin the guard's logic without
 * standing up an Ink render. Mirrors the splash-phase bypass pattern.
 */
export function isHomeView(state: Pick<TuiState, 'phase' | 'view'>): boolean {
  return state.phase === 'main' && state.view === 'home';
}

/**
 * #306: Build the pinned-confirmation line(s) for the current state. Returns
 * an array (possibly empty) of `{ key, text }` entries — one per active
 * `confirming*` state field. Rendered above the notifications stack by
 * `renderPinnedConfirmations` and sized by `countPinnedConfirmationLines`
 * so `FOOTER_LINES` reserves terminal rows correctly.
 *
 * Pure function, exported for unit testing — no Ink imports, no dispatch.
 * The render helper below is the only caller that wraps these in Text nodes.
 */
export function pinnedConfirmationLines(
  state: Pick<TuiState, 'confirmingStop' | 'confirmingStopReason' | 'confirmingDisband' | 'confirmingEnsembleDestroy' | 'confirmingLineup'>,
): Array<{ key: string; text: string }> {
  const out: Array<{ key: string; text: string }> = [];
  if (state.confirmingStop) {
    const reason = state.confirmingStopReason ? ` Reason: ${state.confirmingStopReason}.` : '';
    out.push({
      key: 'confirm-stop',
      text: `⚠  Destroy ${state.confirmingStop}? Press y to confirm, n to cancel.${reason}`,
    });
  }
  if (state.confirmingDisband) {
    out.push({
      key: 'confirm-disband',
      text: `⚠  Disband ensemble "${state.confirmingDisband}"? All sessions will be terminated. Press y to confirm, n to cancel.`,
    });
  }
  if (state.confirmingEnsembleDestroy) {
    // Typed-name gate — the detailed input UX lives in the full-screen
    // modal; this pinned reminder mirrors the modal's question so the
    // bottom of the screen still answers "what am I being asked?" at a
    // glance. Shown even while the modal is up for layout consistency
    // with the other confirmation states.
    out.push({
      key: 'confirm-ensemble-destroy',
      text: `⚠  Destroy ensemble "${state.confirmingEnsembleDestroy.ensemble}"? Type the ensemble name to confirm, Esc to cancel.`,
    });
  }
  if (state.confirmingLineup) {
    out.push({
      key: 'confirm-lineup',
      text: `⚠  ${state.confirmingLineup.summary}? Press y to confirm, n to cancel.`,
    });
  }
  return out;
}

/**
 * #306: Count of pinned confirmation lines — one per active `confirming*`
 * state field. Consumed by the `FOOTER_LINES` reservation so the live
 * content area shrinks when a confirmation is active, keeping the pinned
 * prompt on-screen.
 */
export function countPinnedConfirmationLines(
  state: Pick<TuiState, 'confirmingStop' | 'confirmingStopReason' | 'confirmingDisband' | 'confirmingEnsembleDestroy' | 'confirmingLineup'>,
): number {
  return pinnedConfirmationLines(state).length;
}

/**
 * #306 follow-up: Build the pinned tip line for the current paused/held
 * state. Returns `null` when neither flag is set — no tip should render.
 *
 * The tip appears below the input prompt in a dim color (informational,
 * not an error or warning) and tells the user which slash commands they
 * need to fully resume the ensemble. `/load_lineup` flips both flags;
 * `/play` clears only paused; `/go` clears only held — without this
 * tip users would unpause an ensemble and stare at frozen players.
 *
 * Pure function, exported for unit testing — no Ink imports.
 */
export function pinnedTipLine(
  state: Pick<TuiState, 'ensemblePaused' | 'ensembleHeld' | 'activeEnsemble'>,
): { key: string; text: string } | null {
  // Hide tips on the home view — there's no ensemble context to act on,
  // and the prompt itself is hidden there too (see `hidePrompt` in App).
  if (!state.activeEnsemble) return null;
  if (state.ensemblePaused && state.ensembleHeld) {
    return {
      key: 'tip-paused-held',
      text: 'Tip: Type /play to unpause + /go to release held players.',
    };
  }
  if (state.ensemblePaused) {
    return { key: 'tip-paused', text: 'Tip: Type /play to resume.' };
  }
  if (state.ensembleHeld) {
    return { key: 'tip-held', text: 'Tip: Type /go to release held players.' };
  }
  return null;
}

/**
 * Count of pinned tip lines (0 or 1). Mirrors
 * {@link countPinnedConfirmationLines} so `FOOTER_LINES` can reserve a
 * row for the tip without re-evaluating the state shape twice.
 */
export function countPinnedTipLines(
  state: Pick<TuiState, 'ensemblePaused' | 'ensembleHeld' | 'activeEnsemble'>,
): number {
  return pinnedTipLine(state) ? 1 : 0;
}

/**
 * #306: Render the pinned confirmation prompts as Ink Text nodes. Kept
 * free-function (mirroring `renderNotifications`) because the App's root
 * render tree is already `createElement`-heavy and a dedicated component
 * would add a layout boundary for zero gain. Uses THEME.warning so the
 * user's eye is drawn away from the chat scroll-up area.
 */
function renderPinnedConfirmations(
  state: TuiState,
  Box: React.ComponentType<any>,
  Text: React.ComponentType<any>,
): React.ReactNode {
  const lines = pinnedConfirmationLines(state);
  if (lines.length === 0) return null;
  return React.createElement(
    Box,
    { flexDirection: 'column', paddingLeft: 1, paddingRight: 1 },
    ...lines.map(line =>
      React.createElement(
        Text,
        { key: line.key, color: THEME.warning, bold: true },
        line.text,
      ),
    ),
  );
}

/**
 * #306 follow-up: Render the pinned paused/held tip below the input. Dim
 * (THEME.dim) so it reads as informational and doesn't compete visually
 * with the yellow confirmation prompts above or red notifications below.
 * Auto-clears when the state changes — no user dismissal needed.
 */
function renderPinnedTip(
  state: TuiState,
  Box: React.ComponentType<any>,
  Text: React.ComponentType<any>,
): React.ReactNode {
  const tip = pinnedTipLine(state);
  if (!tip) return null;
  return React.createElement(
    Box,
    { flexDirection: 'column', paddingLeft: 1, paddingRight: 1 },
    React.createElement(
      Text,
      { key: tip.key, color: THEME.dim },
      tip.text,
    ),
  );
}
