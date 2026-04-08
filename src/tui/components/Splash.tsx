/**
 * TODO: This component is currently orphaned — not imported by App.tsx.
 * Remove or re-integrate if a splash screen phase is reintroduced.
 *
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
  /** Called when user presses Enter. Receives selected ensemble name (or undefined if none). */
  onContinue?: (selectedEnsemble?: string) => void;
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
  const [selectedIdx, setSelectedIdx] = useState(0);
  const brailleFrames = useMemo(() => metronomeBrailleFrames(), []);

  const ensembleCount = ensembles?.length ?? 0;
  const hasMultiple = ensembleCount > 1;

  // Handle keys: ↑↓ to select ensemble, Enter to continue
  const inputRef = React.useRef({ connected, onContinue, ensembles, selectedIdx, hasMultiple });
  inputRef.current = { connected, onContinue, ensembles, selectedIdx, hasMultiple };

  useInput(React.useCallback((_input: string, key: any) => {
    const r = inputRef.current;
    if (!r.connected || !r.onContinue) return;

    if (key.return) {
      const selected = r.ensembles?.[r.selectedIdx]?.name;
      r.onContinue(selected);
      return;
    }

    if (r.hasMultiple) {
      if (key.upArrow) { setSelectedIdx(i => Math.max(0, i - 1)); return; }
      if (key.downArrow) { setSelectedIdx(i => Math.min((r.ensembles?.length ?? 1) - 1, i + 1)); return; }
    }
  }, []));

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
    // Window around selectedIdx for large lists
    let startIdx = 0;
    if (ensembles.length > MAX_ENSEMBLES_SHOWN) {
      startIdx = Math.max(0, Math.min(selectedIdx - Math.floor(MAX_ENSEMBLES_SHOWN / 2), ensembles.length - MAX_ENSEMBLES_SHOWN));
    }
    const visible = ensembles.slice(startIdx, startIdx + MAX_ENSEMBLES_SHOWN);

    if (startIdx > 0) {
      ensembleElements.push(
        React.createElement(Text, { key: 'scroll-up', color: THEME.dim }, `  \u2191 ${startIdx} more`),
      );
    }

    for (let i = 0; i < visible.length; i++) {
      const ens = visible[i];
      const actualIdx = startIdx + i;
      const isSelected = actualIdx === selectedIdx;
      const icon = ens.hasConductor ? '\u2605' : '\u2022';
      const indicator = hasMultiple ? (isSelected ? '\u25B8 ' : '  ') : '  ';
      ensembleElements.push(
        React.createElement(Text, {
          key: ens.name,
          color: isSelected ? THEME.accent : THEME.textMuted,
          bold: isSelected,
        },
          `  ${indicator}${icon} ${ens.name} (${ens.playerCount} player${ens.playerCount !== 1 ? 's' : ''})`,
        ),
      );
    }

    if (startIdx + MAX_ENSEMBLES_SHOWN < ensembles.length) {
      ensembleElements.push(
        React.createElement(Text, { key: 'scroll-down', color: THEME.dim },
          `  \u2193 ${ensembles.length - startIdx - MAX_ENSEMBLES_SHOWN} more`,
        ),
      );
    }
  } else if (connected) {
    ensembleElements.push(
      React.createElement(Text, { key: 'none', color: THEME.dim },
        '  No ensembles running yet. Press Enter to get started.',
      ),
    );
  }

  return React.createElement(Box, {
    flexDirection: 'column',
    alignItems: 'center',
    justifyContent: 'center',
    flexGrow: 1,
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
        ? React.createElement(Text, { bold: true, color: THEME.accent },
            hasMultiple ? '\u2191\u2193 to select, Enter to connect' : 'Press Enter to continue')
        : React.createElement(Text, { color: THEME.muted }, 'Press Ctrl+C to cancel'),
    ),
  );
}
