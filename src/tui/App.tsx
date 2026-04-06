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
import { TitleBar } from './components/TitleBar';
import { PromptArea } from './components/PromptArea';
import { parseCommand, isValidCommand, formatHelpSummary, COMMANDS } from './commands';
import { THEME } from './utils/theme';
import type { TuiApi } from './core-api';

// eslint-disable-next-line @typescript-eslint/no-var-requires
const packageVersion: string = require('../../package.json').version;

interface AppProps {
  api: TuiApi;
  /** If provided, start directly in ensemble view. */
  ensemble?: string;
}

let staticIdCounter = 0;
function nextStaticId(): string {
  return `static-${++staticIdCounter}`;
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
    if (state.chatTarget) {
      return 'Type a message to send, or /back to exit chat mode';
    }
    return '/cue /recruit /stop /broadcast /help /quit';
  }, [state.chatTarget]);

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
        await cmd.handler(parsed.args, dispatch, api);
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
      try {
        await api.sendMessage(state.activeEnsemble!, state.chatTarget, trimmed, 'tui');
        dispatch({
          type: 'COMMIT_STATIC',
          item: {
            id: nextStaticId(),
            type: 'message',
            content: `\u2192 ${state.chatTarget}: ${trimmed}`,
            timestamp: Date.now(),
          },
        });
      } catch (err) {
        dispatch({
          type: 'COMMIT_STATIC',
          item: {
            id: nextStaticId(),
            type: 'error',
            content: `Failed to send: ${err}`,
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
      const MIN_SPLASH_MS = 2000;

      dispatch({ type: 'SET_SPLASH_STATUS', status: 'Connecting to Temporal...' });

      const connected = await api.isConnected();
      if (cancelled) return;

      if (!connected) {
        dispatch({ type: 'SET_PHASE', phase: 'error', error: 'Cannot connect to Temporal. Run `claude-tempo up` first.' });
        return;
      }

      dispatch({ type: 'SET_SPLASH_STATUS', status: 'Loading ensembles...' });

      // Load initial data
      if (state.activeEnsemble) {
        try {
          const [players, messages, history] = await Promise.all([
            api.getPlayers(state.activeEnsemble),
            api.getMessages(state.activeEnsemble, 50),
            api.getConductorHistory(state.activeEnsemble),
          ]);
          if (cancelled) return;
          dispatch({ type: 'REFRESH_ENSEMBLE_DATA', players, messages, history });
        } catch {
          // Non-fatal — will retry in poll loop
        }
      } else {
        try {
          const ensembles = await api.discoverEnsembles();
          if (cancelled) return;
          dispatch({ type: 'REFRESH_ENSEMBLES', ensembles });
        } catch {
          // Non-fatal
        }
      }

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
            content: `Connected to Temporal \u2022 v${packageVersion}`,
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
          const [players, messages, history] = await Promise.all([
            api.getPlayers(state.activeEnsemble),
            api.getMessages(state.activeEnsemble, 50),
            api.getConductorHistory(state.activeEnsemble),
          ]);
          dispatch({ type: 'REFRESH_ENSEMBLE_DATA', players, messages, history });
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
    });
  }

  // Divider helper
  const Divider = () => React.createElement(Box, { paddingX: 1 },
    React.createElement(Text, { color: THEME.border }, '\u2500'.repeat(Math.max(20, (process.stdout.columns || 80) - 4))),
  );

  // Live content area
  function renderLiveContent() {
    if (state.phase === 'error') {
      return React.createElement(Box, { flexDirection: 'column', padding: 1 },
        React.createElement(Text, { color: THEME.error, bold: true }, 'Error'),
        React.createElement(Text, { color: THEME.error }, state.error || 'Unknown error'),
      );
    }

    // Main view: show player summary if in ensemble, or ensemble list
    if (state.activeEnsemble && state.players.length > 0) {
      return React.createElement(Box, { flexDirection: 'column', paddingX: 1 },
        React.createElement(Text, { bold: true, color: THEME.text }, 'Players:'),
        ...state.players.map(p =>
          React.createElement(Text, {
            key: p.playerId,
            color: p.isConductor ? THEME.warning : p.status === 'active' ? THEME.success : THEME.dim,
          },
            `  ${p.isConductor ? '\u2605' : '\u2022'} ${p.playerId} [${p.status || '?'}]${p.part ? ' \u2014 ' + p.part : ''}`,
          ),
        ),
      );
    }

    if (!state.activeEnsemble && state.ensembles.length > 0) {
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

  // Color for static item text
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

  return React.createElement(Box, { flexDirection: 'column', height: '100%' },
    // Title bar
    React.createElement(TitleBar, { context: contextString }),
    // Top divider
    React.createElement(Divider, null),
    // Static scroll-up history
    React.createElement(Static, { items: state.staticItems },
      ...state.staticItems.map((item: StaticItem) =>
        React.createElement(Box, { key: item.id, paddingX: 1 },
          React.createElement(Text, { color: staticItemColor(item) }, item.content),
        ),
      ),
    ),
    // Live content area
    React.createElement(Box, { flexGrow: 1 },
      renderLiveContent(),
    ),
    // Bottom divider
    React.createElement(Divider, null),
    // Prompt area
    React.createElement(PromptArea, {
      hints: promptHints,
      value: state.inputValue,
      onChange: (value: string) => dispatch({ type: 'SET_INPUT', value }),
      onSubmit: handleSubmit,
      disabled: state.phase === 'error',
    }),
  );
}
