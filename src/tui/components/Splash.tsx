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
import { metronomeArt, supportsUnicode } from '../utils/platform';

// ── Theme colors ──
const ACCENT = '#E07A5F';
const SUCCESS = '#81C784';
const WARNING = '#F2CC8F';
const DIM = '#6B7280';
const TEXT = '#FAF3EE';

// ── Braille spinner frames ──
const SPINNER_FRAMES = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏'];

// ── Ping-pong sequence for 3 metronome frames ──
const PING_PONG = [0, 1, 2, 1];

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
}

export interface SplashCheck {
  label: string;
  done: boolean;
  error?: boolean;
}

/**
 * Classify metronome art lines: lines 0-5 are pendulum area,
 * lines 6+ are the body (base/box).
 */
function isBodyLine(lineIndex: number): boolean {
  return lineIndex >= 6;
}

/** Characters that belong to the pendulum/pivot. */
const PENDULUM_CHARS = /[o╱╲│|/\\●]/;

export function Splash({ status, ensemble, version, checks, connected, summary }: SplashProps) {
  const { Box, Text } = useInk();
  const [metronomeTick, setMetronomeTick] = useState(0);
  const [spinnerTick, setSpinnerTick] = useState(0);
  const unicode = supportsUnicode();
  const frames = useMemo(() => metronomeArt(unicode), [unicode]);

  // Metronome animation — 120ms ping-pong
  useEffect(() => {
    if (connected) return; // Stop animating once connected
    const timer = setInterval(() => {
      setMetronomeTick((t) => (t + 1) % PING_PONG.length);
    }, 120);
    return () => clearInterval(timer);
  }, [connected]);

  // Spinner animation — 80ms
  useEffect(() => {
    if (connected) return;
    const timer = setInterval(() => {
      setSpinnerTick((t) => (t + 1) % SPINNER_FRAMES.length);
    }, 80);
    return () => clearInterval(timer);
  }, [connected]);

  const frameIndex = PING_PONG[metronomeTick];
  const currentFrame = frames[frameIndex];

  // ── Metronome art with color splitting ──
  const metronomeLines = currentFrame.map((line, lineIdx) => {
    if (isBodyLine(lineIdx)) {
      return React.createElement(Text, { key: lineIdx, color: DIM }, line);
    }
    // Pendulum area: split into pendulum (accent) and space segments
    const segments: React.ReactNode[] = [];
    let buf = '';
    let bufIsPendulum = false;

    for (let i = 0; i < line.length; i++) {
      const ch = line[i];
      const isPendulum = PENDULUM_CHARS.test(ch) && ch !== ' ';
      if (i === 0) {
        bufIsPendulum = isPendulum;
        buf = ch;
      } else if (isPendulum === bufIsPendulum) {
        buf += ch;
      } else {
        segments.push(
          React.createElement(Text, {
            key: segments.length,
            color: bufIsPendulum ? ACCENT : DIM,
          }, buf),
        );
        buf = ch;
        bufIsPendulum = isPendulum;
      }
    }
    if (buf) {
      segments.push(
        React.createElement(Text, {
          key: segments.length,
          color: bufIsPendulum ? ACCENT : DIM,
        }, buf),
      );
    }

    return React.createElement(Box, { key: lineIdx }, ...segments);
  });

  // ── Checklist ──
  const checkElements = (checks || []).map((check, i) => {
    if (check.error) {
      return React.createElement(Text, { key: i, color: '#EF5350' },
        `  \u2717 ${check.label}`,
      );
    }
    if (check.done) {
      return React.createElement(Text, { key: i, color: SUCCESS },
        `  \u2713 ${check.label}`,
      );
    }
    // In-progress: spinner
    return React.createElement(Text, { key: i, color: DIM },
      `  ${SPINNER_FRAMES[spinnerTick]} ${check.label}`,
    );
  });

  // ── Connected summary box ──
  const summaryBox = connected && summary
    ? React.createElement(Box, {
        flexDirection: 'column',
        borderStyle: 'single',
        borderColor: DIM,
        paddingX: 1,
        marginTop: 1,
      },
        React.createElement(Text, { color: TEXT },
          `Ensemble: ${summary.ensemble}  \u00B7  Players: ${summary.playerCount}${summary.scheduleCount != null ? `  \u00B7  Schedules: ${summary.scheduleCount}` : ''}`,
        ),
        React.createElement(Text, { color: DIM },
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
      React.createElement(Text, { bold: true, color: ACCENT }, 'claude-tempo'),
      React.createElement(Text, { color: DIM }, 'Multi-session orchestration via Temporal'),
      React.createElement(Text, { color: '#374151' }, `v${version}`),
    ),
    // Status spinner (only when connecting)
    !connected
      ? React.createElement(Box, { marginTop: 2 },
          React.createElement(Text, { color: WARNING },
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
    // Ready message (connected state)
    connected
      ? React.createElement(Box, { marginTop: 1 },
          React.createElement(Text, { color: TEXT }, 'Ready. Type /help for commands.'),
        )
      : null,
    // Bottom hint
    !connected
      ? React.createElement(Box, { marginTop: 2 },
          React.createElement(Text, { color: '#3D4556' }, 'Press Ctrl+C to cancel'),
        )
      : null,
  );
}
