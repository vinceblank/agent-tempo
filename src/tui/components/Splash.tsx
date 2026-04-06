/**
 * Full-screen splash screen with ASCII art metronome animation.
 * Shown during startup while connecting to Temporal/Maestro.
 *
 * Layout (top to bottom, all centered):
 * 1. Animated metronome (ping-pong: left→center→right→center)
 * 2. Block-letter title (or simple text if terminal < 70 cols)
 * 3. Status line (yellow, dim)
 * 4. Ensemble name (dim)
 * 5. Version number (dim)
 */
import React, { useState, useEffect } from 'react';
import { useInk } from '../ink-context';
import { metronomeArt, titleArt, titleArtFits, supportsUnicode, getTerminalSize } from '../utils/platform';

export interface SplashProps {
  status: string;
  ensemble: string;
  version: string;
}

/** Terracotta color for pendulum/pivot characters. */
const TERRACOTTA = '#E07A5F';

/** Pendulum and pivot characters to color as terracotta. */
const PENDULUM_CHARS = /[o╱╲│|/\\]/;

/**
 * Ping-pong frame sequence: 0→1→2→1→0→1→2→...
 * With 3 frames, the sequence is [0, 1, 2, 1] repeating.
 */
const PING_PONG_SEQUENCE = [0, 1, 2, 1];

/**
 * Classify each character in a metronome line as either pendulum/pivot
 * (terracotta) or body (cyan). Lines 0-5 are the pendulum area;
 * lines 6+ are the body (all cyan).
 */
function isBodyLine(lineIndex: number): boolean {
  return lineIndex >= 6;
}

export function Splash({ status, ensemble, version }: SplashProps) {
  const { Box, Text } = useInk();
  const [tick, setTick] = useState(0);
  const unicode = supportsUnicode();
  const frames = metronomeArt(unicode);
  const { columns } = getTerminalSize();
  const showBlockTitle = titleArtFits(columns);

  useEffect(() => {
    const timer = setInterval(() => {
      setTick((t) => (t + 1) % PING_PONG_SEQUENCE.length);
    }, 300);
    return () => clearInterval(timer);
  }, []);

  const frameIndex = PING_PONG_SEQUENCE[tick];
  const currentFrame = frames[frameIndex];

  // ── Metronome art ──
  const metronomeLines = currentFrame.map((line, lineIdx) => {
    if (isBodyLine(lineIdx)) {
      // Body lines: all cyan
      return React.createElement(Text, { key: lineIdx, color: 'cyan' }, line);
    }
    // Pendulum area: color pendulum/pivot chars as terracotta, rest as cyan
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
            color: bufIsPendulum ? TERRACOTTA : 'cyan',
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
          color: bufIsPendulum ? TERRACOTTA : 'cyan',
        }, buf),
      );
    }

    return React.createElement(Box, { key: lineIdx }, ...segments);
  });

  // ── Title ──
  const titleElement = showBlockTitle
    ? React.createElement(Box, { flexDirection: 'column', alignItems: 'center', marginTop: 1 },
        ...titleArt(unicode).map((line, i) =>
          React.createElement(Text, { key: i, bold: true, color: 'cyan' }, line),
        ),
      )
    : React.createElement(Box, { marginTop: 1 },
        React.createElement(Text, { bold: true, color: 'cyan' },
          unicode ? '\u266A claude-tempo' : '# claude-tempo',
        ),
      );

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
    // Title
    titleElement,
    // Status
    React.createElement(Box, { marginTop: 1 },
      React.createElement(Text, { color: 'yellow', dimColor: true }, status),
    ),
    // Ensemble
    React.createElement(Box, { marginTop: 0 },
      React.createElement(Text, { dimColor: true }, `ensemble: ${ensemble}`),
    ),
    // Version
    React.createElement(Box, { marginTop: 1 },
      React.createElement(Text, { dimColor: true }, `v${version}`),
    ),
  );
}
