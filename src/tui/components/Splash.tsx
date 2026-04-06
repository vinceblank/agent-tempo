/**
 * Splash screen — minimal welcome screen with animated metronome.
 *
 * Shows: logo, title, one-line connection status, compact ensemble list,
 * and "Press Enter to continue" prompt.
 */
import React, { useState, useEffect, useMemo } from 'react';
import { useInk } from '../ink-context';
import { metronomeBrailleFrames } from '../utils/platform';
import type { BrailleLine } from '../utils/platform';
import { THEME } from '../utils/theme';

// ── Animation constants ──
const SPINNER_FRAMES = ['\u280B', '\u2819', '\u2839', '\u2838', '\u283C', '\u2834', '\u2826', '\u2827', '\u2807', '\u280F'];
const PING_PONG = [0, 1, 2, 1];
const MAX_ENSEMBLES_SHOWN = 5;

export interface EnsembleInfo {
  name: string;
  playerCount: number;
  hasConductor: boolean;
}

export interface SplashProps {
  status: string;
  ensemble: string;
  version: string;
  /** Whether the connection is complete. */
  connected?: boolean;
  /** Available ensembles (shown when connected). */
  ensembles?: EnsembleInfo[];
  /** Called when user presses Enter to continue from splash. */
  onContinue?: () => void;
  // Legacy props (kept for backward compat but ignored)
  checks?: any[];
  summary?: any;
}

/** Render a braille line as colored React Text elements. */
function renderBrailleLine(segments: BrailleLine, Box: any, Text: any, key: string): React.ReactNode {
  return React.createElement(Box, { key },
    ...segments.map((seg, i) =>
      React.createElement(Text, {
        key: i,
        color: seg.color || undefined,
      }, seg.char),
    ),
  );
}

export function Splash({ status, version, connected, ensembles, onContinue }: SplashProps) {
  const { Box, Text, useInput } = useInk();
  const [metronomeTick, setMetronomeTick] = useState(0);
  const [spinnerTick, setSpinnerTick] = useState(0);
  const brailleFrames = useMemo(() => metronomeBrailleFrames(), []);

  // Handle Enter to continue
  useInput(React.useCallback((_input: string, key: any) => {
    if (connected && onContinue && key.return) {
      onContinue();
    }
  }, [connected, onContinue]));

  // Metronome animation — runs continuously until unmount
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

  // ── Metronome rendering ──
  const frameIndex = PING_PONG[metronomeTick];
  const metronomeLines = brailleFrames[frameIndex].map((line, i) =>
    renderBrailleLine(line, Box, Text, `metro-${i}`),
  );

  // ── One-line connection status ──
  const statusElement = connected
    ? React.createElement(Text, { color: THEME.success }, '\u2713 Connected')
    : React.createElement(Text, { color: THEME.warning }, `${SPINNER_FRAMES[spinnerTick]} ${status}`);

  // ── Compact ensemble list (max 5) ──
  const ensembleElements: React.ReactNode[] = [];
  if (connected && ensembles && ensembles.length > 0) {
    const shown = ensembles.slice(0, MAX_ENSEMBLES_SHOWN);
    for (const ens of shown) {
      const icon = ens.hasConductor ? '\u2605' : '\u2022';
      ensembleElements.push(
        React.createElement(Text, { key: ens.name, color: THEME.textMuted },
          `  ${icon} ${ens.name} (${ens.playerCount} player${ens.playerCount !== 1 ? 's' : ''})`,
        ),
      );
    }
    if (ensembles.length > MAX_ENSEMBLES_SHOWN) {
      ensembleElements.push(
        React.createElement(Text, { key: 'more', color: THEME.dim },
          `  \u2026 and ${ensembles.length - MAX_ENSEMBLES_SHOWN} more`,
        ),
      );
    }
  } else if (connected) {
    ensembleElements.push(
      React.createElement(Text, { key: 'none', color: THEME.dim },
        '  No ensembles running',
      ),
    );
  }

  return React.createElement(Box, {
    flexDirection: 'column',
    alignItems: 'center',
    justifyContent: 'center',
    height: '100%',
  },
    // Metronome logo
    React.createElement(Box, { flexDirection: 'column', alignItems: 'center' },
      ...metronomeLines,
    ),
    // Title + tagline + version
    React.createElement(Box, { flexDirection: 'column', alignItems: 'center', marginTop: 1 },
      React.createElement(Text, { bold: true, color: THEME.accent }, 'claude-tempo'),
      React.createElement(Text, { color: THEME.dim }, 'Multi-session orchestration via Temporal'),
      React.createElement(Text, { color: THEME.muted }, `v${version}`),
    ),
    // One-line connection status
    React.createElement(Box, { marginTop: 2 }, statusElement),
    // Ensemble list (only when connected)
    ensembleElements.length > 0
      ? React.createElement(Box, { flexDirection: 'column', marginTop: 1 }, ...ensembleElements)
      : null,
    // Press Enter to continue (connected) / Ctrl+C to cancel (connecting)
    React.createElement(Box, { marginTop: 2 },
      connected
        ? React.createElement(Text, { bold: true, color: THEME.accent }, 'Press Enter to continue')
        : React.createElement(Text, { color: THEME.muted }, 'Press Ctrl+C to cancel'),
    ),
  );
}
