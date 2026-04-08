/**
 * Splash screen — landing/home screen with animated metronome, connection
 * status, and ensemble picker.
 *
 * Uses a single Text element with nested virtual-text nodes to minimize
 * Yoga layout nodes (target: <10 total).
 */
import React, { useState, useEffect, useMemo } from 'react';
import { useInk } from '../ink-context';
import { metronomeBrailleFrames } from '../utils/platform';
import { THEME } from '../utils/theme';

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
  ensemble?: string;
  version: string;
  connected?: boolean;
  ensembles?: EnsembleInfo[];
  onContinue?: (selectedEnsemble?: string) => void;
}

export function Splash({ status, version, connected, ensembles, onContinue }: SplashProps) {
  const { Text, useInput } = useInk();
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

  // Metronome animation — cleanup stops timer on unmount/transition
  useEffect(() => {
    const timer = setInterval(() => {
      setMetronomeTick((t) => (t + 1) % PING_PONG.length);
    }, 300);
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

  // ── Metronome frame (needed for line count) ──
  const frameIndex = PING_PONG[metronomeTick];
  const frame = brailleFrames[frameIndex];

  // ── Centering calculations ──
  const cols = process.stdout.columns || 80;
  const rows = process.stdout.rows || 24;
  const contentWidth = 45; // approximate max content width
  const hPad = ' '.repeat(Math.max(0, Math.floor((cols - contentWidth) / 2)));

  // Count actual content lines for accurate vertical centering
  const metroLines = frame.length; // ~10 lines
  const titleLines = 5; // 2 blank + title + tagline + version
  const statusLines = 3; // 2 blank + status line
  const ensembleLines = connected
    ? (ensembles && ensembles.length > 0
        ? 1 + Math.min(ensembles.length, MAX_ENSEMBLES_SHOWN) // gap + items
        : 5) // no ensembles hints
    : 0;
  const promptLines = 3; // 2 blank + prompt
  const contentHeight = metroLines + titleLines + statusLines + ensembleLines + promptLines;
  const vPad = Math.max(0, Math.floor((rows - contentHeight - 3) / 2));

  // ── Build single Text element with all content as nested virtual-text ──
  const children: React.ReactNode[] = [];

  // Vertical centering
  for (let i = 0; i < vPad; i++) children.push('\n');

  // Metronome logo (braille characters as nested Text — 0 Yoga nodes)
  for (let li = 0; li < frame.length; li++) {
    if (li > 0) children.push('\n');
    children.push(hPad);
    for (let si = 0; si < frame[li].length; si++) {
      const seg = frame[li][si];
      children.push(
        React.createElement(Text, { key: `m-${li}-${si}`, color: seg.color || undefined }, seg.char),
      );
    }
  }

  // Title + tagline + version
  children.push('\n\n');
  children.push(React.createElement(Text, { key: 'title', bold: true, color: THEME.accent }, `${hPad}claude-tempo`));
  children.push('\n');
  children.push(React.createElement(Text, { key: 'tagline', color: THEME.dim }, `${hPad}Multi-session orchestration via Temporal`));
  children.push('\n');
  children.push(React.createElement(Text, { key: 'version', color: THEME.muted }, `${hPad}v${version}`));

  // Connection status
  children.push('\n\n');
  if (connected) {
    children.push(React.createElement(Text, { key: 'status', color: THEME.success }, `${hPad}\u2713 Connected`));
  } else {
    children.push(React.createElement(Text, { key: 'status', color: THEME.warning }, `${hPad}${SPINNER_FRAMES[spinnerTick]} ${status}`));
  }

  // Ensemble list (when connected)
  if (connected && ensembles && ensembles.length > 0) {
    children.push('\n');

    let startIdx = 0;
    if (ensembles.length > MAX_ENSEMBLES_SHOWN) {
      startIdx = Math.max(0, Math.min(selectedIdx - Math.floor(MAX_ENSEMBLES_SHOWN / 2), ensembles.length - MAX_ENSEMBLES_SHOWN));
    }
    const visible = ensembles.slice(startIdx, startIdx + MAX_ENSEMBLES_SHOWN);

    if (startIdx > 0) {
      children.push('\n');
      children.push(React.createElement(Text, { key: 'sup', color: THEME.dim }, `${hPad}  \u2191 ${startIdx} more`));
    }

    for (let i = 0; i < visible.length; i++) {
      const ens = visible[i];
      const actualIdx = startIdx + i;
      const isSelected = actualIdx === selectedIdx;
      const icon = ens.hasConductor ? '\u2605' : '\u2022';
      const indicator = hasMultiple ? (isSelected ? '\u25B8 ' : '  ') : '  ';
      children.push('\n');
      children.push(
        React.createElement(Text, {
          key: `ens-${ens.name}`,
          color: isSelected ? THEME.accent : THEME.textMuted,
          bold: isSelected,
        }, `${hPad}  ${indicator}${icon} ${ens.name} (${ens.playerCount} player${ens.playerCount !== 1 ? 's' : ''})`),
      );
    }

    if (startIdx + MAX_ENSEMBLES_SHOWN < ensembles.length) {
      children.push('\n');
      children.push(React.createElement(Text, { key: 'sdn', color: THEME.dim },
        `${hPad}  \u2193 ${ensembles.length - startIdx - MAX_ENSEMBLES_SHOWN} more`));
    }
  } else if (connected) {
    // No ensembles — getting started hints
    children.push('\n\n');
    children.push(React.createElement(Text, { key: 'none', color: THEME.dim }, `${hPad}No ensembles running.`));
    children.push('\n\n');
    children.push(React.createElement(Text, { key: 'h1', color: THEME.text }, `${hPad}Create an ensemble:`));
    children.push('\n');
    children.push(React.createElement(Text, { key: 'h2', color: THEME.accent }, `${hPad}  claude-tempo up <name>`));
    children.push('\n\n');
    children.push(React.createElement(Text, { key: 'h3', color: THEME.text }, `${hPad}Or load a lineup:`));
    children.push('\n');
    children.push(React.createElement(Text, { key: 'h4', color: THEME.accent }, `${hPad}  claude-tempo up --lineup <file.yml>`));
  }

  // Bottom prompt
  children.push('\n\n');
  if (connected) {
    children.push(React.createElement(Text, { key: 'prompt', bold: true, color: THEME.accent },
      ensembleCount === 0
        ? `${hPad}Press Ctrl+C to exit`
        : hasMultiple
          ? `${hPad}\u2191\u2193 to select, Enter to connect`
          : `${hPad}Press Enter to continue`,
    ));
  } else {
    children.push(React.createElement(Text, { key: 'prompt', color: THEME.muted }, `${hPad}Press Ctrl+C to cancel`));
  }

  // Single Text element wrapping everything (1 Yoga node)
  return React.createElement(Text, null, ...children);
}
