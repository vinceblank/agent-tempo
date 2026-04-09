/**
 * ErrorView — connection failure screen with troubleshooting.
 *
 * Performance: Single <Text> root with nested virtual-text children.
 * Zero Yoga <Box> nodes — follows the pattern from StatusOverlay/ConversationStream.
 */
import React, { useCallback } from 'react';
import { useInk } from '../ink-context';
import { metronomeBrailleFrames } from '../utils/platform';
import { THEME } from '../utils/theme';

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
  /** Called when user presses 'r' to retry. */
  onRetry?: () => void;
  /** Called when user presses 'q' to quit. */
  onQuit?: () => void;
}

export function ErrorView({
  version,
  checks,
  retrying,
  retryIn,
  retryAttempt,
  retryMax,
  onRetry,
  onQuit,
}: ErrorViewProps) {
  const { Text, useInput } = useInk();

  // Wire up keybindings
  useInput(useCallback((input: string) => {
    if (input === 'r' && onRetry) onRetry();
    if (input === 'q' && onQuit) onQuit();
  }, [onRetry, onQuit]));

  const children: React.ReactNode[] = [];

  // Static metronome — always center frame (index 1), rendered dim
  const brailleFrames = metronomeBrailleFrames();
  const staticFrame = brailleFrames[1];
  for (let i = 0; i < staticFrame.length; i++) {
    if (i > 0) children.push('\n');
    children.push(React.createElement(React.Fragment, { key: `m-${i}` },
      ...staticFrame[i].map((seg, j) =>
        React.createElement(Text, { key: j, color: THEME.dim }, seg.char),
      ),
    ));
  }

  // Title
  children.push('\n\n');
  children.push(React.createElement(Text, { key: 'title', bold: true, color: THEME.accent }, '  claude-tempo'));
  children.push('\n');
  children.push(React.createElement(Text, { key: 'sub', color: THEME.dim }, '  Multi-session orchestration via Temporal'));
  children.push('\n');
  children.push(React.createElement(Text, { key: 'ver', color: THEME.muted }, `  v${version}`));

  // Error header
  children.push('\n\n');
  children.push(React.createElement(Text, { key: 'err', bold: true, color: THEME.error }, '  \u26A0 Connection Failed'));

  // Checklist
  children.push('\n');
  for (let i = 0; i < checks.length; i++) {
    const check = checks[i];
    children.push('\n');
    children.push(React.createElement(Text, { key: `c-${i}`, color: check.passed ? THEME.success : THEME.error },
      `  ${check.passed ? '\u2713' : '\u2717'} ${check.label}`,
    ));
    if (check.detail && !check.passed) {
      children.push('\n');
      children.push(React.createElement(Text, { key: `cd-${i}`, color: THEME.dim }, `    ${check.detail}`));
    }
  }

  // Troubleshooting box (text-based border)
  const boxWidth = 56;
  const hLine = '\u2500'.repeat(boxWidth);
  children.push('\n\n');
  children.push(React.createElement(Text, { key: 'bt', color: THEME.dim }, `  \u250C${hLine}\u2510`));
  children.push('\n');
  children.push(React.createElement(Text, { key: 'bh', bold: true, color: THEME.warning }, '  \u2502  Troubleshooting'));
  children.push(React.createElement(Text, { key: 'bh2', color: THEME.dim }, ' '.repeat(boxWidth - 17) + '\u2502'));
  children.push('\n');
  children.push(React.createElement(Text, { key: 'bs', color: THEME.dim }, `  \u2502${' '.repeat(boxWidth)}\u2502`));

  const steps = [
    { label: '1. Start the Temporal dev server:', cmd: '   $ temporal server start-dev' },
    { label: '2. Or specify a custom address:', cmd: '   $ TEMPORAL_ADDRESS=host:7233 claude-tempo' },
    { label: '3. Check if Temporal is running:', cmd: '   $ temporal operator cluster health' },
  ];
  for (let i = 0; i < steps.length; i++) {
    const s = steps[i];
    const pad1 = ' '.repeat(Math.max(0, boxWidth - s.label.length - 2));
    const pad2 = ' '.repeat(Math.max(0, boxWidth - s.cmd.length - 2));
    children.push('\n');
    children.push(React.createElement(Text, { key: `s${i}a`, color: THEME.text }, `  \u2502  ${s.label}`));
    children.push(React.createElement(Text, { key: `s${i}ap`, color: THEME.dim }, `${pad1}\u2502`));
    children.push('\n');
    children.push(React.createElement(Text, { key: `s${i}b`, color: THEME.accent }, `  \u2502  ${s.cmd}`));
    children.push(React.createElement(Text, { key: `s${i}bp`, color: THEME.dim }, `${pad2}\u2502`));
  }

  children.push('\n');
  children.push(React.createElement(Text, { key: 'be', color: THEME.dim }, `  \u2502${' '.repeat(boxWidth)}\u2502`));
  const docsUrl = 'Docs: https://github.com/vinceblank/claude-tempo#setup';
  const docsPad = ' '.repeat(Math.max(0, boxWidth - docsUrl.length - 2));
  children.push('\n');
  children.push(React.createElement(Text, { key: 'bd', color: THEME.dim }, `  \u2502  ${docsUrl}${docsPad}\u2502`));
  children.push('\n');
  children.push(React.createElement(Text, { key: 'bb', color: THEME.dim }, `  \u2514${hLine}\u2518`));

  // Retry progress
  if (retrying) {
    children.push('\n\n');
    children.push(React.createElement(Text, { key: 'retry', color: THEME.dim },
      `  Retrying in ${retryIn ?? '?'}s... (attempt ${retryAttempt ?? '?'}/${retryMax ?? 5})`,
    ));
  }

  // Keybindings
  children.push('\n\n');
  children.push(React.createElement(Text, { key: 'keys', color: THEME.dim }, '  [r] retry now    [q] quit    [?] help'));

  return React.createElement(Text, null, ...children);
}
