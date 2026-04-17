/**
 * TUI entry point — runs preflight checks, dynamically loads ink (ESM), and renders the app.
 * Called from the CLI command via: const { run } = await import('../tui/index.js');
 */
import React from 'react';
import { Client } from '@temporalio/client';
import { createTemporalConnection } from '../connection';
import { Config, getConfig } from '../config';
import { createTempoClient } from '../client';
import { loadInk } from './ink-loader';
import { InkProvider } from './ink-context';
import { App } from './App';
import { isTerminalLargeEnough, MIN_COLUMNS, MIN_ROWS } from './utils/platform';
import { enterFullscreen, exitFullscreen, registerFullscreenCleanup } from './utils/fullscreen';
import { isDaemonRunning, startDaemon } from '../cli/daemon';

export interface TuiOpts {
  config: Config;
  /** If provided, start in single-ensemble view. If omitted, start in home (multi-ensemble) view. */
  ensemble?: string;
}

export async function run(opts: TuiOpts): Promise<void> {
  // Check terminal size
  if (!isTerminalLargeEnough()) {
    console.error(
      `Terminal too small (minimum ${MIN_COLUMNS}x${MIN_ROWS}). ` +
      `Current: ${process.stdout.columns || '?'}x${process.stdout.rows || '?'}`,
    );
    process.exit(1);
  }

  // ── Preflight: Ensure daemon is running ──
  if (!isDaemonRunning()) {
    try {
      console.error('Starting worker daemon...');
      await startDaemon(opts.config);
    } catch (err: any) {
      console.error(`Warning: could not start daemon: ${err.message || err}`);
      // Continue anyway — Temporal connection will fail gracefully in the splash
    }
  }

  // Load ink dynamically (ESM)
  const ink = await loadInk();

  // ── Connect to Temporal (with timeout, graceful failure) ──
  let connection;
  try {
    connection = await Promise.race([
      createTemporalConnection(opts.config),
      new Promise<never>((_, reject) =>
        setTimeout(() => reject(new Error(`timeout connecting to ${opts.config.temporalAddress}`)), 5000),
      ),
    ]);
  } catch (err) {
    // Don't crash — let the TUI show the ErrorView with diagnostics
    console.error(`Warning: ${err instanceof Error ? err.message : err}`);
    console.error('The TUI will show connection troubleshooting.');
  }

  // Enter fullscreen (alternate screen buffer)
  const isFullscreen = enterFullscreen();
  if (isFullscreen) {
    registerFullscreenCleanup();
  }

  try {
    let api;
    if (connection) {
      const client = new Client({ connection, namespace: opts.config.temporalNamespace });
      api = createTempoClient(client);
    } else {
      // Create a dummy client that returns empty/false for everything
      // The splash will transition to ErrorView
      api = createDummyClient();
    }

    // Render the TUI
    const app = ink.render(
      React.createElement(InkProvider, { ink, children: React.createElement(App, { api, ensemble: opts.ensemble, defaultAgent: opts.config.defaultAgent }) }),
    );

    await app.waitUntilExit();
  } finally {
    if (isFullscreen) {
      exitFullscreen();
    }
    if (connection) {
      await connection.close();
    }
  }
}

/** Dummy TempoClient for when Temporal connection fails — returns empty data. */
function createDummyClient(): ReturnType<typeof createTempoClient> {
  const fail = () => Promise.reject(new Error('Not connected to Temporal'));
  return {
    discoverEnsembles: async () => [],
    getPlayers: async () => [],
    getMessages: async () => [],
    getConductorHistory: async () => [],
    getPlayerMessages: async () => [],
    getPlayerMetadata: async () => null,
    sendCommand: fail,
    sendMessage: fail,
    terminatePlayer: fail,
    // PR-D verbs — all fail in offline dummy mode.
    restart: fail,
    detach: fail,
    destroy: fail,
    migrate: fail,
    attachmentInfo: fail,
    disbandEnsemble: fail,
    isConnected: async () => false,
    hasGlobalMaestro: async () => false,
    getSchedules: async () => [],
    cancelSchedule: fail,
    getEnsembleChat: async () => ({ messages: [], total: 0, hasMore: false, hasConductor: false }),
    getGates: async () => [],
    getStages: async () => [],
    getWorktrees: async () => [],
    ensureMaestroSession: fail,
    sendAsMaestro: fail,
    getMaestroMessages: async () => ({ received: [], sent: [] }),
    // Issue #172: degrade silently — no Temporal = no banner.
    getPendingStartupContext: async () => null,
  };
}
