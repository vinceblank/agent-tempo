/**
 * ErrorView — connection failure screen with troubleshooting.
 * Shows a static metronome, error checklist, troubleshooting box,
 * and retry countdown.
 */
import React, { useState, useEffect } from 'react';
import { useInk } from '../ink-context';
import { metronomeArt, supportsUnicode } from '../utils/platform';

// ── Theme colors ──
const ACCENT = '#E07A5F';
const SUCCESS = '#81C784';
const ERROR = '#EF5350';
const WARNING = '#F2CC8F';
const DIM = '#6B7280';
const TEXT = '#FAF3EE';

export interface ErrorCheck {
  label: string;
  passed: boolean;
  detail?: string;
}

export interface ErrorViewProps {
  version: string;
  checks: ErrorCheck[];
  /** Error detail text (e.g., "Connection refused (ECONNREFUSED)"). */
  errorDetail?: string;
  /** Whether auto-retry is active. */
  retrying?: boolean;
  /** Seconds until next retry. */
  retryIn?: number;
  /** Current retry attempt number. */
  retryAttempt?: number;
  /** Max retry attempts. */
  retryMax?: number;
}

export function ErrorView({
  version,
  checks,
  errorDetail,
  retrying,
  retryIn,
  retryAttempt,
  retryMax,
}: ErrorViewProps) {
  const { Box, Text } = useInk();
  const unicode = supportsUnicode();

  // Static metronome — always center frame (index 1)
  const frames = metronomeArt(unicode);
  const staticFrame = frames[1];
  const metronomeLines = staticFrame.map((line, i) =>
    React.createElement(Text, { key: i, color: DIM }, line),
  );

  // ── Checklist ──
  const checkElements = checks.map((check, i) =>
    React.createElement(Box, { key: i, flexDirection: 'column' },
      React.createElement(Text, { color: check.passed ? SUCCESS : ERROR },
        `  ${check.passed ? '\u2713' : '\u2717'} ${check.label}`,
      ),
      check.detail && !check.passed
        ? React.createElement(Text, { color: DIM }, `    ${check.detail}`)
        : null,
    ),
  );

  // ── Troubleshooting box ──
  const troubleshootingBox = React.createElement(Box, {
    flexDirection: 'column',
    borderStyle: 'single',
    borderColor: DIM,
    paddingX: 1,
    paddingY: 0,
    marginTop: 1,
  },
    React.createElement(Text, { bold: true, color: WARNING }, '  Troubleshooting'),
    React.createElement(Box, { height: 1 }),
    React.createElement(Text, { color: TEXT }, '  1. Start the Temporal dev server:'),
    React.createElement(Text, { color: ACCENT }, '     $ temporal server start-dev'),
    React.createElement(Box, { height: 0 }),
    React.createElement(Text, { color: TEXT }, '  2. Or specify a custom address:'),
    React.createElement(Text, { color: ACCENT }, '     $ TEMPORAL_ADDRESS=host:7233 claude-tempo'),
    React.createElement(Box, { height: 0 }),
    React.createElement(Text, { color: TEXT }, '  3. Check if Temporal is running:'),
    React.createElement(Text, { color: ACCENT }, '     $ temporal operator cluster health'),
    React.createElement(Box, { height: 1 }),
    React.createElement(Text, { color: DIM },
      '  Docs: https://github.com/vinceblank/claude-tempo#setup',
    ),
  );

  // ── Retry progress ──
  const retryElement = retrying
    ? React.createElement(Box, { marginTop: 1 },
        React.createElement(Text, { color: DIM },
          `  Retrying in ${retryIn ?? '?'}s... (attempt ${retryAttempt ?? '?'}/${retryMax ?? 5})`,
        ),
      )
    : null;

  return React.createElement(Box, {
    flexDirection: 'column',
    alignItems: 'center',
    justifyContent: 'center',
    height: '100%',
  },
    // Static metronome
    React.createElement(Box, { flexDirection: 'column', alignItems: 'center' },
      ...metronomeLines,
    ),
    // Title
    React.createElement(Box, { flexDirection: 'column', alignItems: 'center', marginTop: 1 },
      React.createElement(Text, { bold: true, color: ACCENT }, 'claude-tempo'),
      React.createElement(Text, { color: DIM }, 'Multi-session orchestration via Temporal'),
      React.createElement(Text, { color: '#374151' }, `v${version}`),
    ),
    // Error header
    React.createElement(Box, { marginTop: 2 },
      React.createElement(Text, { bold: true, color: ERROR },
        `  \u26A0 Connection Failed`,
      ),
    ),
    // Checklist
    React.createElement(Box, { flexDirection: 'column', marginTop: 1 },
      ...checkElements,
    ),
    // Troubleshooting
    React.createElement(Box, { width: 60 },
      troubleshootingBox,
    ),
    // Retry
    retryElement,
    // Keybindings
    React.createElement(Box, { marginTop: 2 },
      React.createElement(Text, { color: DIM }, '[r] retry now    [q] quit    [?] help'),
    ),
  );
}
