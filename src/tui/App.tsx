/**
 * Root TUI application component.
 * Routes between splash screen and main dashboard based on state phase.
 */
import React, { useReducer, useEffect, useCallback } from 'react';
import { useInk } from './ink-context';
import { tuiReducer, initialState } from './store';
import { Splash } from './components/Splash';
import type { TuiApi } from './core-api';

interface AppProps {
  api: TuiApi;
  ensemble: string;
}

export function App({ api, ensemble }: AppProps) {
  const { Box, Text, useApp, useInput } = useInk();
  const [state, dispatch] = useReducer(tuiReducer, initialState(ensemble));
  const { exit } = useApp();

  // Keyboard: q/Ctrl-C to exit
  useInput(useCallback((input: string, key: any) => {
    if (input === 'q' || (key.ctrl && input === 'c')) {
      exit();
    }
  }, [exit]));

  // Startup sequence: splash -> connecting -> connected
  useEffect(() => {
    let cancelled = false;

    async function connect() {
      dispatch({ type: 'SET_SPLASH_STATUS', status: 'Connecting to Temporal...' });

      // Check Maestro connection
      const connected = await api.isConnected();
      if (cancelled) return;

      if (!connected) {
        dispatch({ type: 'SET_PHASE', phase: 'error', error: 'Maestro workflow not found. Run `claude-tempo up` first.' });
        return;
      }

      dispatch({ type: 'SET_SPLASH_STATUS', status: 'Loading ensemble state...' });

      // Initial data load
      const [players, messages, history] = await Promise.all([
        api.getPlayers(ensemble),
        api.getMessages(ensemble, 50),
        api.getConductorHistory(ensemble),
      ]);
      if (cancelled) return;

      dispatch({ type: 'REFRESH_ALL', players, messages, history });
      dispatch({ type: 'SET_PHASE', phase: 'connected' });
    }

    connect().catch((err) => {
      if (!cancelled) {
        dispatch({ type: 'SET_PHASE', phase: 'error', error: String(err) });
      }
    });

    return () => { cancelled = true; };
  }, [api]);

  // Polling loop when connected
  useEffect(() => {
    if (state.phase !== 'connected') return;

    const interval = setInterval(async () => {
      try {
        const [players, messages, history] = await Promise.all([
          api.getPlayers(ensemble),
          api.getMessages(ensemble, 50),
          api.getConductorHistory(ensemble),
        ]);
        dispatch({ type: 'REFRESH_ALL', players, messages, history });
      } catch {
        // Silently skip failed polls — next cycle will retry
      }
    }, 3000);

    return () => clearInterval(interval);
  }, [state.phase, api]);

  // ── Render by phase ──

  if (state.phase === 'splash' || state.phase === 'connecting') {
    return React.createElement(Splash, {
      status: state.splashStatus,
      ensemble: state.activeEnsemble || ensemble,
    });
  }

  if (state.phase === 'error') {
    return React.createElement(Box, { flexDirection: 'column', padding: 1 },
      React.createElement(Text, { color: 'red', bold: true }, 'Error'),
      React.createElement(Text, { color: 'red' }, state.error || 'Unknown error'),
      React.createElement(Text, { dimColor: true, wrap: 'wrap' }, '\nPress q to exit.'),
    );
  }

  // Connected — main dashboard
  return React.createElement(Box, { flexDirection: 'column', height: '100%' },
    // Top bar
    React.createElement(Box, { borderStyle: 'single', paddingX: 1 },
      React.createElement(Text, { bold: true, color: 'cyan' }, `claude-tempo`),
      React.createElement(Text, null, ` | `),
      React.createElement(Text, { color: 'green' }, ensemble),
      React.createElement(Text, null, ` | `),
      React.createElement(Text, { dimColor: true }, `${state.players.length} players`),
      React.createElement(Text, null, ` | `),
      React.createElement(Text, { dimColor: true }, `q: quit`),
    ),
    // Body panels
    React.createElement(Box, { flexGrow: 1, flexDirection: 'row' },
      // Left: ensemble panel
      React.createElement(Box, { flexDirection: 'column', width: '40%', borderStyle: 'single', paddingX: 1 },
        React.createElement(Text, { bold: true, underline: true }, 'Ensemble'),
        ...state.players.map((p: typeof state.players[number]) =>
          React.createElement(Box, { key: p.playerId, marginTop: 0 },
            React.createElement(Text, {
              color: p.isConductor ? 'yellow' : p.status === 'active' ? 'green' : p.status === 'stale' ? 'gray' : 'white',
            }, `${p.isConductor ? '\u2605' : '\u2022'} ${p.playerId}`),
            React.createElement(Text, { dimColor: true }, ` [${p.status || 'unknown'}]`),
          ),
        ),
        state.players.length === 0
          ? React.createElement(Text, { dimColor: true }, 'No players')
          : null,
      ),
      // Right: message timeline
      React.createElement(Box, { flexDirection: 'column', flexGrow: 1, borderStyle: 'single', paddingX: 1 },
        React.createElement(Text, { bold: true, underline: true }, 'Messages'),
        ...state.messages.slice(-10).map((m: typeof state.messages[number], i: number) =>
          React.createElement(Text, { key: i, dimColor: true },
            `${m.from} -> ${m.to}: ${m.text.length > 60 ? m.text.slice(0, 57) + '...' : m.text}`,
          ),
        ),
        state.messages.length === 0
          ? React.createElement(Text, { dimColor: true }, 'No messages yet')
          : null,
      ),
    ),
  );
}
