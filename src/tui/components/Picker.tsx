/**
 * Picker — generic interactive list overlay.
 * Used by /players and /ensembles for interactive selection.
 * ↑↓ to navigate, Enter to select, Esc to dismiss.
 */
import React from 'react';
import { useInk } from '../ink-context';
import { THEME } from '../utils/theme';

const MAX_VISIBLE = 10;

export interface PickerItem {
  id: string;
  /** Main label (player name, ensemble name). */
  label: string;
  /** Secondary text (type, player count). */
  detail: string;
  /** Optional right-aligned text (status, conductor). */
  meta?: string;
  /** Color for the label. */
  color?: string;
  /** Status icon prefix. */
  icon?: string;
  /** Whether this item is the "current" one (e.g., active chat target). */
  current?: boolean;
}

export interface PickerProps {
  /** Title shown at top. */
  title: string;
  /** Items to display. */
  items: PickerItem[];
  /** Currently highlighted index. */
  selectedIndex: number;
  /** Hint text at the bottom. */
  hint?: string;
}

export function Picker({ title, items, selectedIndex, hint }: PickerProps) {
  const { Box, Text } = useInk();

  if (items.length === 0) {
    return React.createElement(Box, { flexDirection: 'column', paddingX: 1 },
      React.createElement(Text, { bold: true, color: THEME.accent }, `  ${title}`),
      React.createElement(Text, { color: THEME.dim }, '  (none)'),
    );
  }

  // Window around selected index
  let startIdx = 0;
  if (items.length > MAX_VISIBLE) {
    startIdx = Math.max(0, Math.min(selectedIndex - Math.floor(MAX_VISIBLE / 2), items.length - MAX_VISIBLE));
  }
  const visible = items.slice(startIdx, startIdx + MAX_VISIBLE);

  const rows = visible.map((item, i) => {
    const actualIdx = startIdx + i;
    const isSelected = actualIdx === selectedIndex;
    const indicator = isSelected ? '\u25B8 ' : '  ';
    const currentMark = item.current ? ' \u25C0' : '';
    const labelColor = isSelected ? THEME.accent : (item.color || THEME.text);
    const icon = item.icon ? `${item.icon} ` : '';

    return React.createElement(Box, { key: item.id },
      React.createElement(Text, { color: isSelected ? THEME.accent : THEME.dim }, indicator),
      React.createElement(Text, { color: labelColor, bold: isSelected }, `${icon}${item.label}`),
      React.createElement(Text, { color: THEME.dim }, `  ${item.detail}`),
      item.meta
        ? React.createElement(Text, { color: THEME.muted }, `  ${item.meta}`)
        : null,
      currentMark
        ? React.createElement(Text, { color: THEME.warning }, currentMark)
        : null,
    );
  });

  const hasAbove = startIdx > 0;
  const hasBelow = startIdx + MAX_VISIBLE < items.length;

  return React.createElement(Box, { flexDirection: 'column', paddingX: 1 },
    React.createElement(Text, { bold: true, color: THEME.accent }, `  ${title}`),
    React.createElement(Box, { height: 1 }),
    hasAbove
      ? React.createElement(Text, { color: THEME.dim }, `  \u2191 ${startIdx} more above`)
      : null,
    ...rows,
    hasBelow
      ? React.createElement(Text, { color: THEME.dim }, `  \u2193 ${items.length - startIdx - MAX_VISIBLE} more below`)
      : null,
    hint
      ? React.createElement(Box, { marginTop: 1 },
          React.createElement(Text, { color: THEME.dim }, `  ${hint}`),
        )
      : null,
  );
}
