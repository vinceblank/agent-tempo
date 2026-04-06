/**
 * TUI entry point — dynamically loads ink (ESM) and renders the app.
 * Called from the CLI command via: const { run } = await import('../tui/index.js');
 */
import React from 'react';
import { Client } from '@temporalio/client';
import { createTemporalConnection } from '../connection';
import { Config } from '../config';
import { createTempoClient } from './client';
import { loadInk } from './ink-loader';
import { InkProvider } from './ink-context';
import { App } from './App';
import { isTerminalLargeEnough, MIN_COLUMNS, MIN_ROWS } from './utils/platform';
import { enterFullscreen, exitFullscreen, registerFullscreenCleanup } from './utils/fullscreen';

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

  // Load ink dynamically (ESM)
  const ink = await loadInk();

  // Connect to Temporal
  let connection;
  try {
    connection = await createTemporalConnection(opts.config);
  } catch (err) {
    console.error(`Cannot connect to Temporal at ${opts.config.temporalAddress}`);
    console.error(`  Run: temporal server start-dev`);
    process.exit(1);
  }

  // Enter fullscreen (alternate screen buffer)
  const isFullscreen = enterFullscreen();
  if (isFullscreen) {
    registerFullscreenCleanup();
  }

  try {
    const client = new Client({ connection, namespace: opts.config.temporalNamespace });
    const api = createTempoClient(client);

    // Render the TUI
    const app = ink.render(
      React.createElement(InkProvider, { ink, children: React.createElement(App, { api, ensemble: opts.ensemble }) }),
    );

    await app.waitUntilExit();
  } finally {
    if (isFullscreen) {
      exitFullscreen();
    }
    // Cleanup
    await connection.close();
  }
}
