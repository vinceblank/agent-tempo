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
  onCreateEnsemble?: () => void;
}

export function Splash({ status, version, connected, ensembles, onContinue, onCreateEnsemble }: SplashProps) {
  const { Text, useInput } = useInk();
  const [metronomeTick, setMetronomeTick] = useState(0);
  const [spinnerTick, setSpinnerTick] = useState(0);
  const [selectedIdx, setSelectedIdx] = useState(0);
  const brailleFrames = useMemo(() => metronomeBrailleFrames(), []);

  const ensembleCount = ensembles?.length ?? 0;
  // Total selectable items: ensembles + "create new" item (when loaded)
  const totalItems = ensembles !== undefined ? ensembleCount + 1 : (ensembleCount || 1);
  const hasNavigation = totalItems > 1;
  const isCreateSelected = ensembles !== undefined && selectedIdx === ensembleCount;

  // Handle keys: ↑↓ to select, Enter to continue/create
  const inputRef = React.useRef({ connected, onContinue, onCreateEnsemble, ensembles, selectedIdx, isCreateSelected, totalItems });
  inputRef.current = { connected, onContinue, onCreateEnsemble, ensembles, selectedIdx, isCreateSelected, totalItems };

  useInput(React.useCallback((_input: string, key: any) => {
    const r = inputRef.current;
    if (!r.connected) return;

    if (key.return) {
      if (r.isCreateSelected) {
        r.onCreateEnsemble?.();
      } else {
        const selected = r.ensembles?.[r.selectedIdx]?.name;
        r.onContinue?.(selected);
      }
      return;
    }

    if (key.upArrow) { setSelectedIdx(i => Math.max(0, i - 1)); return; }
    if (key.downArrow) { setSelectedIdx(i => Math.min(r.totalItems - 1, i + 1)); return; }
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

  /** Center a string horizontally based on its visible width. */
  const center = (text: string): string => {
    const pad = Math.max(0, Math.floor((cols - text.length) / 2));
    return ' '.repeat(pad) + text;
  };

  // Count actual content lines for accurate vertical centering
  const metroLines = frame.length; // ~10 lines
  const titleLines = 5; // 2 blank + title + tagline + version
  const statusLines = 3; // 2 blank + status line
  const ensembleLines = connected && ensembles !== undefined
    ? 1 + Math.min(ensembleCount, MAX_ENSEMBLES_SHOWN) + 1 + (ensembleCount === 0 ? 1 : 0) // gap + items + create + optional "none"
    : (connected ? 3 : 0); // loading or not connected
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
    const lineWidth = frame[li].reduce((w, seg) => w + seg.char.length, 0);
    const metroPad = ' '.repeat(Math.max(0, Math.floor((cols - lineWidth) / 2)));
    children.push(metroPad);
    for (let si = 0; si < frame[li].length; si++) {
      const seg = frame[li][si];
      children.push(
        React.createElement(Text, { key: `m-${li}-${si}`, color: seg.color || undefined }, seg.char),
      );
    }
  }

  // Title + tagline + version
  children.push('\n\n');
  children.push(React.createElement(Text, { key: 'title', bold: true, color: THEME.accent }, center('claude-tempo')));
  children.push('\n');
  children.push(React.createElement(Text, { key: 'tagline', color: THEME.dim }, center('Multi-session orchestration via Temporal')));
  children.push('\n');
  children.push(React.createElement(Text, { key: 'version', color: THEME.muted }, center(`v${version}`)));

  // Connection status
  children.push('\n\n');
  if (connected) {
    children.push(React.createElement(Text, { key: 'status', color: THEME.success }, center('\u2713 Connected')));
  } else {
    children.push(React.createElement(Text, { key: 'status', color: THEME.warning }, center(`${SPINNER_FRAMES[spinnerTick]} ${status}`)));
  }

  // Ensemble list + create option (when connected)
  if (connected && ensembles !== undefined) {
    children.push('\n');

    if (ensembles.length > 0) {
      let startIdx = 0;
      if (ensembles.length > MAX_ENSEMBLES_SHOWN) {
        startIdx = Math.max(0, Math.min(selectedIdx - Math.floor(MAX_ENSEMBLES_SHOWN / 2), ensembles.length - MAX_ENSEMBLES_SHOWN));
      }
      const visible = ensembles.slice(startIdx, startIdx + MAX_ENSEMBLES_SHOWN);

      if (startIdx > 0) {
        children.push('\n');
        children.push(React.createElement(Text, { key: 'sup', color: THEME.dim }, center(`\u2191 ${startIdx} more`)));
      }

      for (let i = 0; i < visible.length; i++) {
        const ens = visible[i];
        const actualIdx = startIdx + i;
        const isSelected = actualIdx === selectedIdx;
        const icon = ens.hasConductor ? '\u2605' : '\u2022';
        const indicator = isSelected ? '\u25B8 ' : '  ';
        children.push('\n');
        children.push(
          React.createElement(Text, {
            key: `ens-${ens.name}`,
            color: isSelected ? THEME.accent : THEME.textMuted,
            bold: isSelected,
          }, center(`${indicator}${icon} ${ens.name} (${ens.playerCount} player${ens.playerCount !== 1 ? 's' : ''})`)),
        );
      }

      if (startIdx + MAX_ENSEMBLES_SHOWN < ensembles.length) {
        children.push('\n');
        children.push(React.createElement(Text, { key: 'sdn', color: THEME.dim },
          center(`\u2193 ${ensembles.length - startIdx - MAX_ENSEMBLES_SHOWN} more`)));
      }
    } else {
      // Loaded but empty
      children.push('\n');
      children.push(React.createElement(Text, { key: 'none', color: THEME.dim }, center('No ensembles running.')));
    }

    // "+ Create new ensemble" — always selectable
    children.push('\n');
    const createIndicator = isCreateSelected ? '\u25B8 ' : '  ';
    children.push(
      React.createElement(Text, {
        key: 'create',
        color: isCreateSelected ? THEME.accent : THEME.dim,
        bold: isCreateSelected,
      }, center(`${createIndicator}+ Create new ensemble`)),
    );
  } else if (connected) {
    // Connected but ensembles not yet loaded
    children.push('\n\n');
    children.push(React.createElement(Text, { key: 'loading', color: THEME.dim }, center('\u27F3 Discovering ensembles...')));
  }

  // Bottom prompt
  children.push('\n\n');
  if (connected) {
    children.push(React.createElement(Text, { key: 'prompt', bold: true, color: THEME.accent },
      ensembles === undefined
        ? center('Press Ctrl+C to exit')
        : hasNavigation
          ? center('\u2191\u2193 to select, Enter to continue')
          : center('Press Enter to continue'),
    ));
  } else {
    children.push(React.createElement(Text, { key: 'prompt', color: THEME.muted }, center('Press Ctrl+C to cancel')));
  }

  // Single Text element wrapping everything (1 Yoga node)
  return React.createElement(Text, null, ...children);
}
