/**
 * CommandOverlay — generic dismissible overlay for data-display commands.
 *
 * Renders a title and pre-formatted text content. Used by /gates, /stages,
 * /worktree list, /recall, and /search instead of static scrollback.
 *
 * Performance: Single <Text> root with nested virtual-text children.
 * Zero Yoga <Box> nodes.
 */
import React from 'react';
import { useInk } from '../ink-context';
import { THEME } from '../utils/theme';

export interface CommandOverlayProps {
  title: string;
  content: string;
}

export function CommandOverlay({ title, content }: CommandOverlayProps) {
  const { Text } = useInk();

  const children: React.ReactNode[] = [];

  children.push(React.createElement(Text, { key: 'h', bold: true, color: THEME.accent },
    `  ${title}`));

  children.push('\n\n');
  // Render each line of pre-formatted content as dimmed text
  const lines = content.split('\n');
  for (let i = 0; i < lines.length; i++) {
    if (i > 0) children.push('\n');
    children.push(React.createElement(Text, { key: `l-${i}`, color: THEME.text }, `  ${lines[i]}`));
  }

  children.push('\n\n');
  children.push(React.createElement(Text, { key: 'hint', color: THEME.dim }, '  Esc to dismiss'));

  return React.createElement(Text, null, ...children);
}
