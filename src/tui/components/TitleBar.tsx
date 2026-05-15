/**
 * TitleBar — pinned top bar for the TUI shell.
 * Renders as a SINGLE Text element (1 Yoga node). Nested Text = ink-virtual-text (0 nodes).
 */
import React from 'react';
import { useInk } from '../ink-context';
import { THEME } from '../utils/theme';

export interface TitleBarProps {
  /** Context text displayed on the right side. */
  context: string;
}

export function TitleBar({ context }: TitleBarProps) {
  const { Text } = useInk();
  const cols = process.stdout.columns || 80;
  const left = 'agent-tempo';
  // Pad between left and right to push context to the right edge
  const padding = Math.max(1, cols - left.length - context.length - 4); // -4 for paddingX

  return React.createElement(Text, null,
    '  ',
    React.createElement(Text, { bold: true, color: THEME.accent }, left),
    ' '.repeat(padding),
    React.createElement(Text, { color: THEME.dim }, context),
  );
}
