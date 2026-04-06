/**
 * CommandPalette — dropdown overlay showing filtered slash commands.
 * Appears above the prompt when user types "/" as first character.
 * Arrow keys navigate, Enter/Tab selects, Esc dismisses.
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
  /** Filtered list of matching commands. */
  commands: PaletteCommand[];
  /** Currently highlighted index. */
  selectedIndex: number;
}

export function CommandPalette({ commands, selectedIndex }: CommandPaletteProps) {
  const { Box, Text } = useInk();

  if (commands.length === 0) {
    return React.createElement(Box, { paddingX: 2 },
      React.createElement(Text, { color: THEME.dim }, 'No matching commands'),
    );
  }

  // Window the visible commands around the selected index
  let startIdx = 0;
  if (commands.length > MAX_VISIBLE) {
    startIdx = Math.max(0, Math.min(selectedIndex - Math.floor(MAX_VISIBLE / 2), commands.length - MAX_VISIBLE));
  }
  const visible = commands.slice(startIdx, startIdx + MAX_VISIBLE);

  const rows = visible.map((cmd, i) => {
    const actualIdx = startIdx + i;
    const isSelected = actualIdx === selectedIndex;
    const indicator = isSelected ? '\u25B8 ' : '  '; // ▸ or space

    return React.createElement(Box, { key: cmd.name },
      React.createElement(Text, { color: isSelected ? THEME.accent : THEME.dim }, indicator),
      React.createElement(Text, {
        color: isSelected ? THEME.accent : THEME.success,
        bold: isSelected,
      }, `/${cmd.name}`),
      React.createElement(Text, { color: THEME.muted }, `  ${cmd.description}`),
    );
  });

  // Scroll indicators
  const hasAbove = startIdx > 0;
  const hasBelow = startIdx + MAX_VISIBLE < commands.length;

  return React.createElement(Box, { flexDirection: 'column', paddingX: 1 },
    hasAbove
      ? React.createElement(Text, { color: THEME.dim }, `  \u2191 ${startIdx} more above`)
      : null,
    ...rows,
    hasBelow
      ? React.createElement(Text, { color: THEME.dim }, `  \u2193 ${commands.length - startIdx - MAX_VISIBLE} more below`)
      : null,
  );
}
