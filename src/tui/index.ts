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
import type { BootstrapResult } from '../cli/startup';

export interface TuiOpts {
  config: Config;
  /** If provided, start in single-ensemble view. If omitted, start in home (multi-ensemble) view. */
  ensemble?: string;
  /**
   * #289: pre-computed bootstrap result fed in from the CLI default path.
   * When present, the TUI skips its own daemon/connection probing and
   * hands the result straight to HomeView as initial props (S5 / #290).
   * Absent for the subcommand paths that don't run bootstrap.
   */
  bootstrap?: BootstrapResult;
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
      // The TUI recruit wizard only offers production agents — `mock` is a
      // dev-mode CLI-only path (ADR 0014 §7 gate 3). If the user's resolved
      // default is `mock` (e.g. they set it via env), fall back to `claude`
      // for the TUI default; the user can still recruit mock players via
      // `claude-tempo --dev recruit ... --agent mock` from the CLI.
      React.createElement(InkProvider, { ink, children: React.createElement(App, { api, ensemble: opts.ensemble, defaultAgent: opts.config.defaultAgent === 'mock' ? 'claude' : opts.config.defaultAgent }) }),
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
    listEnsembles: async () => [],
    createEnsemble: fail,
    spawnConductor: fail,
    getPlayers: async () => [],
    getMessages: async () => [],
    getConductorHistory: async () => [],
    getPlayerMessages: async () => [],
    getPlayerMetadata: async () => null,
    sendCommand: fail,
    sendMessage: fail,
    terminatePlayer: fail,
    // PR-D verbs — all fail in offline dummy mode.
    recruit: fail,
    release: fail,
    restart: fail,
    detach: fail,
    destroy: fail,
    migrate: fail,
    attachmentInfo: fail,
    recall: fail,
    listHosts: async () => [],
    disbandEnsemble: fail,
    // #287 ensemble-scope verbs — same offline fail-fast shape.
    pause: fail,
    play: fail,
    shutdown: fail,
    restore: fail,
    isConnected: async () => false,
    hasGlobalMaestro: async () => false,
    getSchedules: async () => [],
    cancelSchedule: fail,
    getEnsembleChat: async () => ({ messages: [], total: 0, hasMore: false, hasConductor: false }),
    isMaestroPaused: async () => false,
    isAnySessionHeld: async () => false,
    getGates: async () => [],
    getStages: async () => [],
    getWorktrees: async () => [],
    ensureMaestroSession: fail,
    sendAsMaestro: fail,
    getMaestroMessages: async () => ({ received: [], sent: [] }),
    // PR-3 (#94/#95): SSE subscribe stub — yields nothing and completes
    // immediately so a `for await` loop on the offline dummy doesn't hang.
    subscribe: () => ({
      [Symbol.asyncIterator]() {
        return {
          next: () => Promise.resolve({ value: undefined as never, done: true }),
        };
      },
    }),
  };
}
