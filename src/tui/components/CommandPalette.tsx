/**
 * CommandPalette — dropdown overlay showing filtered slash commands.
 * Renders as a SINGLE Text element (1 Yoga node) with newlines for rows.
 */
import React from 'react';
import { useInk } from '../ink-context';
import { THEME } from '../utils/theme';

const MAX_VISIBLE = 6;

export interface PaletteCommand {
  name: string;
  usage: string;
  description: string;
}

export interface CommandPaletteProps {
  commands: PaletteCommand[];
  selectedIndex: number;
  /** Prefix character for display (default: "/"). Use "@" for player palette. */
  prefix?: string;
}

export function CommandPalette({ commands, selectedIndex, prefix = '/' }: CommandPaletteProps) {
  const { Text } = useInk();

  if (commands.length === 0) {
    return React.createElement(Text, { color: THEME.dim }, '    No matching commands');
  }

  // Window the visible commands around the selected index
  let startIdx = 0;
  if (commands.length > MAX_VISIBLE) {
    startIdx = Math.max(0, Math.min(selectedIndex - Math.floor(MAX_VISIBLE / 2), commands.length - MAX_VISIBLE));
  }
  const visible = commands.slice(startIdx, startIdx + MAX_VISIBLE);

  const lines: string[] = [];

  // Scroll-up indicator
  if (startIdx > 0) {
    lines.push(`    \u2191 ${startIdx} more above`);
  }

  // Visible rows (plain text — color via outer Text)
  for (let i = 0; i < visible.length; i++) {
    const cmd = visible[i];
    const actualIdx = startIdx + i;
    const isSelected = actualIdx === selectedIndex;
    const indicator = isSelected ? '\u25B8 ' : '  ';
    lines.push(`  ${indicator}/${cmd.name}  ${cmd.description}`);
  }

  // Scroll-down indicator
  const hasBelow = startIdx + MAX_VISIBLE < commands.length;
  if (hasBelow) {
    lines.push(`    \u2193 ${commands.length - startIdx - MAX_VISIBLE} more below`);
  }

  // Single Text element with newlines — all one Yoga node
  // Use nested Text for selected item highlighting
  const children: React.ReactNode[] = [];
  let lineIdx = 0;

  if (startIdx > 0) {
    children.push(React.createElement(Text, { key: 'above', color: THEME.dim }, lines[lineIdx]));
    children.push('\n');
    lineIdx++;
  }

  for (let i = 0; i < visible.length; i++) {
    const cmd = visible[i];
    const actualIdx = startIdx + i;
    const isSelected = actualIdx === selectedIndex;
    const indicator = isSelected ? '\u25B8 ' : '  ';

    if (i > 0) children.push('\n');
    children.push(
      React.createElement(React.Fragment, { key: cmd.name },
        React.createElement(Text, { color: isSelected ? THEME.accent : THEME.dim }, `  ${indicator}`),
        React.createElement(Text, { color: isSelected ? THEME.accent : THEME.success, bold: isSelected }, `${prefix}${cmd.name}`),
        React.createElement(Text, { color: THEME.muted }, `  ${cmd.description}`),
      ),
    );
  }

  if (hasBelow) {
    children.push('\n');
    children.push(React.createElement(Text, { key: 'below', color: THEME.dim }, `    \u2193 ${commands.length - startIdx - MAX_VISIBLE} more below`));
  }

  return React.createElement(Text, null, ...children);
}
