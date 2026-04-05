/**
 * Root TUI application component.
 * Routes between splash screen and main dashboard based on state phase.
 */
import React, { useReducer, useEffect, useCallback } from 'react';
import { useInk } from './ink-context';
import { tuiReducer, initialState, TuiState, TuiAction } from './store';
import { Splash } from './components/Splash';
import type { TuiApi } from './core-api';

interface AppProps {
  api: TuiApi;
}

export function App({ api }: AppProps) {
  const { Box, Text, useApp, useInput } = useInk();
  const [state, dispatch] = useReducer(tuiReducer, initialState(api.ensemble));
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
      const [players, events, history] = await Promise.all([
        api.getPlayers(),
        api.getEvents(50),
        api.getConductorHistory(),
      ]);
      if (cancelled) return;

      dispatch({ type: 'REFRESH_ALL', players, events, history });
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
        const [players, events, history] = await Promise.all([
          api.getPlayers(),
          api.getEvents(50),
          api.getConductorHistory(),
        ]);
        dispatch({ type: 'REFRESH_ALL', players, events, history });
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
      ensemble: state.ensemble,
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
      React.createElement(Text, { color: 'green' }, api.ensemble),
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
      // Right: activity log
      React.createElement(Box, { flexDirection: 'column', flexGrow: 1, borderStyle: 'single', paddingX: 1 },
        React.createElement(Text, { bold: true, underline: true }, 'Activity'),
        ...state.events.slice(-10).map((e: typeof state.events[number], i: number) =>
          React.createElement(Text, { key: i, dimColor: true },
            `${e.type === 'player_joined' ? '+' : e.type === 'player_left' ? '-' : '~'} ${e.playerId}` +
            (e.newValue ? ` -> ${e.newValue}` : ''),
          ),
        ),
        state.events.length === 0
          ? React.createElement(Text, { dimColor: true }, 'No events yet')
          : null,
      ),
    ),
  );
}
