/**
 * Full-screen splash screen with ASCII art metronome animation.
 * Shown during startup while connecting to Temporal/Maestro.
 *
 * Two sub-phases:
 * 1. Connecting — animated metronome, spinner + status, progressive checklist
 * 2. Connected — completed checklist, summary box, ready prompt
 *
 * After connected, the parent commits this block to <Static> and transitions.
 */
import React, { useState, useEffect, useMemo } from 'react';
import { useInk } from '../ink-context';
import { metronomePixelFrames } from '../utils/platform';
import type { HalfBlockCell } from '../utils/platform';
import { THEME } from '../utils/theme';

// ── Braille spinner frames ──
const SPINNER_FRAMES = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏'];

// ── Ping-pong sequence for 3 metronome frames ──
const PING_PONG = [0, 1, 2, 1];

export interface EnsembleInfo {
  name: string;
  playerCount: number;
  hasConductor: boolean;
}

export interface SplashProps {
  status: string;
  ensemble: string;
  version: string;
  /** Checklist items to display progressively. */
  checks?: SplashCheck[];
  /** Whether the connection is complete. */
  connected?: boolean;
  /** Summary info shown after connection. */
  summary?: {
    ensemble: string;
    playerCount: number;
    conductor?: string;
    scheduleCount?: number;
    uptime?: string;
  };
  /** Available ensembles (shown when connected). */
  ensembles?: EnsembleInfo[];
  /** Called when user presses Enter to continue from splash. */
  onContinue?: () => void;
}

export interface SplashCheck {
  label: string;
  done: boolean;
  error?: boolean;
}

/** Render a single row of half-block cells as React elements. */
function renderHalfBlockRow(cells: HalfBlockCell[], Box: any, Text: any, key: string): React.ReactNode {
  // Group consecutive cells with same fg+bg to reduce element count
  const elements: React.ReactNode[] = [];
  let buf = '';
  let bufFg: string | undefined;
  let bufBg: string | undefined;

  function flush() {
    if (!buf) return;
    const props: any = { key: elements.length };
    if (bufFg) props.color = bufFg;
    if (bufBg) props.backgroundColor = bufBg;
    elements.push(React.createElement(Text, props, buf));
    buf = '';
  }

  for (const cell of cells) {
    if (cell.fg === bufFg && cell.bg === bufBg) {
      buf += cell.char;
    } else {
      flush();
      buf = cell.char;
      bufFg = cell.fg;
      bufBg = cell.bg;
    }
  }
  flush();

  return React.createElement(Box, { key }, ...elements);
}

export function Splash({ status, ensemble, version, checks, connected, summary, ensembles, onContinue }: SplashProps) {
  const { Box, Text, useInput } = useInk();

  // Handle Enter to continue
  useInput(React.useCallback((input: string, key: any) => {
    if (connected && onContinue && key.return) {
      onContinue();
    }
  }, [connected, onContinue]));
  const [metronomeTick, setMetronomeTick] = useState(0);
  const [spinnerTick, setSpinnerTick] = useState(0);
  const pixelFrames = useMemo(() => metronomePixelFrames(), []);

  // Metronome animation — keeps running until component unmounts
  useEffect(() => {
    const timer = setInterval(() => {
      setMetronomeTick((t) => (t + 1) % PING_PONG.length);
    }, 150);
    return () => clearInterval(timer);
  }, []);

  // Spinner animation — stops once connected
  useEffect(() => {
    if (connected) return;
    const timer = setInterval(() => {
      setSpinnerTick((t) => (t + 1) % SPINNER_FRAMES.length);
    }, 80);
    return () => clearInterval(timer);
  }, [connected]);

  const frameIndex = PING_PONG[metronomeTick];
  const currentFrame = pixelFrames[frameIndex];

  // ── Pixel art metronome rendering ──
  const metronomeLines = currentFrame.map((row, i) =>
    renderHalfBlockRow(row, Box, Text, `metro-${i}`),
  );

  // ── Checklist ──
  const checkElements = (checks || []).map((check, i) => {
    if (check.error) {
      return React.createElement(Text, { key: i, color: THEME.error },
        `  \u2717 ${check.label}`,
      );
    }
    if (check.done) {
      return React.createElement(Text, { key: i, color: THEME.success },
        `  \u2713 ${check.label}`,
      );
    }
    // In-progress: spinner
    return React.createElement(Text, { key: i, color: THEME.dim },
      `  ${SPINNER_FRAMES[spinnerTick]} ${check.label}`,
    );
  });

  // ── Connected summary box ──
  const summaryBox = connected && summary
    ? React.createElement(Box, {
        flexDirection: 'column',
        borderStyle: 'single',
        borderColor: THEME.dim,
        paddingX: 1,
        marginTop: 1,
      },
        React.createElement(Text, { color: THEME.text },
          `Ensemble: ${summary.ensemble}  \u00B7  Players: ${summary.playerCount}${summary.scheduleCount != null ? `  \u00B7  Schedules: ${summary.scheduleCount}` : ''}`,
        ),
        React.createElement(Text, { color: THEME.dim },
          `Conductor: ${summary.conductor || 'none'}${summary.uptime ? `  \u00B7  Uptime: ${summary.uptime}` : ''}`,
        ),
      )
    : null;

  return React.createElement(Box, {
    flexDirection: 'column',
    alignItems: 'center',
    justifyContent: 'center',
    height: '100%',
  },
    // Metronome
    React.createElement(Box, { flexDirection: 'column', alignItems: 'center' },
      ...metronomeLines,
    ),
    // Title + tagline + version
    React.createElement(Box, { flexDirection: 'column', alignItems: 'center', marginTop: 1 },
      React.createElement(Text, { bold: true, color: THEME.accent }, 'claude-tempo'),
      React.createElement(Text, { color: THEME.dim }, 'Multi-session orchestration via Temporal'),
      React.createElement(Text, { color: THEME.muted }, `v${version}`),
    ),
    // Status spinner (only when connecting)
    !connected
      ? React.createElement(Box, { marginTop: 2 },
          React.createElement(Text, { color: THEME.warning },
            `${SPINNER_FRAMES[spinnerTick]} ${status}`,
          ),
        )
      : null,
    // Checklist
    checkElements.length > 0
      ? React.createElement(Box, { flexDirection: 'column', marginTop: 1 },
          ...checkElements,
        )
      : null,
    // Summary box (connected state)
    summaryBox,
    // Ensemble list (connected state)
    connected && ensembles && ensembles.length > 0
      ? React.createElement(Box, { flexDirection: 'column', marginTop: 1 },
          React.createElement(Text, { color: THEME.dim },
            `  ${ensembles.length} ensemble${ensembles.length !== 1 ? 's' : ''} available:`,
          ),
          ...ensembles.map(ens =>
            React.createElement(Text, { key: ens.name, color: THEME.text },
              `    ${ens.hasConductor ? '\u2605' : '\u2022'} ${ens.name} (${ens.playerCount} player${ens.playerCount !== 1 ? 's' : ''})`,
            ),
          ),
        )
      : null,
    connected && (!ensembles || ensembles.length === 0)
      ? React.createElement(Box, { marginTop: 1 },
          React.createElement(Text, { color: THEME.dim }, '  No ensembles running. Start one with: claude-tempo up <name>'),
        )
      : null,
    // Press Enter to continue (connected state)
    connected
      ? React.createElement(Box, { marginTop: 2 },
          React.createElement(Text, { bold: true, color: THEME.accent }, '  Press Enter to continue'),
        )
      : null,
    // Bottom hint (connecting state)
    !connected
      ? React.createElement(Box, { marginTop: 2 },
          React.createElement(Text, { color: THEME.muted }, 'Press Ctrl+C to cancel'),
        )
      : null,
  );
}
