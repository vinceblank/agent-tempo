/**
 * TitleBar — pinned top bar for the TUI shell.
 * Left: "claude-tempo" in terracotta bold.
 * Right: context string in dim (changes per screen).
 */
import React from 'react';
import { useInk } from '../ink-context';
import { THEME } from '../utils/theme';

export interface TitleBarProps {
  /** Context text displayed on the right side (e.g., "acme-app · 5 players · Connected"). */
  context: string;
}

export function TitleBar({ context }: TitleBarProps) {
  const { Box, Text } = useInk();

  return React.createElement(Box, {
    paddingX: 1,
    justifyContent: 'space-between',
  },
    React.createElement(Text, { bold: true, color: THEME.accent }, 'claude-tempo'),
    React.createElement(Text, { color: THEME.dim }, context),
  );
}
