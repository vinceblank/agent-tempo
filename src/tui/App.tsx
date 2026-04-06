/**
 * Root TUI application component.
 * Routes between views based on state: home → ensemble → player.
 * Handles the startup sequence (splash → connected) and polling loops.
 */
import React, { useReducer, useEffect, useCallback } from 'react';
import { useInk } from './ink-context';
import { tuiReducer, initialState } from './store';
import { Splash } from './components/Splash';
import { HomeView } from './components/HomeView';
import type { TuiApi } from './core-api';

// eslint-disable-next-line @typescript-eslint/no-var-requires
const packageVersion: string = require('../../package.json').version;

interface AppProps {
  api: TuiApi;
  /** If provided, start directly in ensemble view (backwards compat). */
  ensemble?: string;
}

export function App({ api, ensemble }: AppProps) {
  const { Box, Text, useApp, useInput } = useInk();
  const [state, dispatch] = useReducer(tuiReducer, initialState(ensemble));
  const { exit } = useApp();

  // Hoisted callbacks for HomeView (must be unconditional — React hooks rules)
  const handleSelect = useCallback((name: string) => {
    dispatch({ type: 'NAVIGATE_ENSEMBLE', ensemble: name });
  }, []);
  const handleNavigate = useCallback((direction: 'up' | 'down') => {
    dispatch({ type: direction === 'up' ? 'SELECT_PREV' : 'SELECT_NEXT' });
  }, []);
  const handleQuit = useCallback(() => exit(), [exit]);

  // Global keyboard: q to quit, Ctrl-C to quit, Esc to go back
  useInput(useCallback((input: string, key: any) => {
    if (input === 'q' || (key.ctrl && input === 'c')) {
      exit();
    }
    if (key.escape && state.view !== 'home') {
      dispatch({ type: 'NAVIGATE_HOME' });
    }
  }, [exit, state.view]));

  // ── Startup sequence: splash → connected ──
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

      // Load initial data based on starting view
      if (state.activeEnsemble) {
        // Direct ensemble view — load ensemble data
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
        // Home view — discover ensembles
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
        dispatch({ type: 'SET_PHASE', phase: 'connected' });
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
    if (state.phase !== 'connected') return;

    const interval = setInterval(async () => {
      try {
        if (state.view === 'home') {
          const ensembles = await api.discoverEnsembles();
          dispatch({ type: 'REFRESH_ENSEMBLES', ensembles });
        } else if (state.view === 'ensemble' && state.activeEnsemble) {
          const [players, messages, history] = await Promise.all([
            api.getPlayers(state.activeEnsemble),
            api.getMessages(state.activeEnsemble, 50),
            api.getConductorHistory(state.activeEnsemble),
          ]);
          dispatch({ type: 'REFRESH_ENSEMBLE_DATA', players, messages, history });
        }
      } catch {
        // Silently skip failed polls — next cycle will retry
      }
    }, 3000);

    return () => clearInterval(interval);
  }, [state.phase, state.view, state.activeEnsemble, api]);

  // ── Render by phase ──

  if (state.phase === 'splash' || state.phase === 'connecting') {
    return React.createElement(Splash, {
      status: state.splashStatus,
      ensemble: state.activeEnsemble || 'all',
      version: packageVersion,
    });
  }

  if (state.phase === 'error') {
    return React.createElement(Box, { flexDirection: 'column', padding: 1 },
      React.createElement(Text, { color: 'red', bold: true }, 'Error'),
      React.createElement(Text, { color: 'red' }, state.error || 'Unknown error'),
      React.createElement(Text, { dimColor: true, wrap: 'wrap' }, '\nPress q to exit.'),
    );
  }

  // ── View routing ──

  if (state.view === 'home') {
    return React.createElement(HomeView, {
      ensembles: state.ensembles,
      selectedIndex: state.selectedEnsembleIndex,
      onSelect: handleSelect,
      onNavigate: handleNavigate,
      onQuit: handleQuit,
    });
  }

  if (state.view === 'player') {
    // Phase 2 placeholder — player detail view
    return React.createElement(Box, { flexDirection: 'column', padding: 1 },
      React.createElement(Text, { bold: true, color: 'cyan' }, `Player: ${state.activePlayer}`),
      React.createElement(Text, { dimColor: true }, `Ensemble: ${state.activeEnsemble}`),
      React.createElement(Text, { dimColor: true }, '\nPlayer detail view coming in Phase 2.'),
      React.createElement(Text, { dimColor: true }, 'Press Esc to go back.'),
    );
  }

  // Default: ensemble view (or Phase 2 placeholder for now)
  return React.createElement(Box, { flexDirection: 'column', height: '100%' },
    // Top bar
    React.createElement(Box, { borderStyle: 'single', paddingX: 1 },
      React.createElement(Text, { bold: true, color: 'cyan' }, 'claude-tempo'),
      React.createElement(Text, null, ' | '),
      React.createElement(Text, { color: 'green' }, state.activeEnsemble || ''),
      React.createElement(Text, null, ' | '),
      React.createElement(Text, { dimColor: true }, `${state.players.length} players`),
      React.createElement(Text, null, ' | '),
      React.createElement(Text, { dimColor: true }, 'Esc: back  q: quit'),
    ),
    // Body panels
    React.createElement(Box, { flexGrow: 1, flexDirection: 'row' },
      // Left: player list
      React.createElement(Box, { flexDirection: 'column', width: '40%', borderStyle: 'single', paddingX: 1 },
        React.createElement(Text, { bold: true, underline: true }, 'Players'),
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
            `${m.from} \u2192 ${m.to}: ${m.text.length > 60 ? m.text.slice(0, 57) + '...' : m.text}`,
          ),
        ),
        state.messages.length === 0
          ? React.createElement(Text, { dimColor: true }, 'No messages yet')
          : null,
      ),
    ),
  );
}
