/**
 * Picker — generic interactive list overlay.
 * Renders as a SINGLE Text element (1 Yoga node) with newlines for rows.
 */
import React from 'react';
import { useInk } from '../ink-context';
import { THEME } from '../utils/theme';

const MAX_VISIBLE = 10;

export interface PickerItem {
  id: string;
  label: string;
  detail: string;
  meta?: string;
  color?: string;
  icon?: string;
  current?: boolean;
  /** Group header — items with the same group are rendered under a shared header. */
  group?: string;
}

export interface PickerProps {
  title: string;
  items: PickerItem[];
  selectedIndex: number;
  hint?: string;
}

export function Picker({ title, items, selectedIndex, hint }: PickerProps) {
  const { Text } = useInk();

  if (items.length === 0) {
    return React.createElement(Text, null,
      React.createElement(Text, { bold: true, color: THEME.accent }, `  ${title}`),
      '\n',
      React.createElement(Text, { color: THEME.dim }, '  (none)'),
    );
  }

  // Window around selected index
  let startIdx = 0;
  if (items.length > MAX_VISIBLE) {
    startIdx = Math.max(0, Math.min(selectedIndex - Math.floor(MAX_VISIBLE / 2), items.length - MAX_VISIBLE));
  }
  const visible = items.slice(startIdx, startIdx + MAX_VISIBLE);

  const hasAbove = startIdx > 0;
  const hasBelow = startIdx + MAX_VISIBLE < items.length;

  const children: React.ReactNode[] = [];

  // Title
  children.push(React.createElement(Text, { key: 'title', bold: true, color: THEME.accent }, `  ${title}`));
  children.push('\n');

  // Scroll-up
  if (hasAbove) {
    children.push(React.createElement(Text, { key: 'above', color: THEME.dim }, `  \u2191 ${startIdx} more above`));
    children.push('\n');
  }

  // Items (with optional group headers)
  let lastGroup: string | undefined;
  for (let i = 0; i < visible.length; i++) {
    const item = visible[i];
    const actualIdx = startIdx + i;
    const isSelected = actualIdx === selectedIndex;
    const indicator = isSelected ? '\u25B8 ' : '  ';
    const currentMark = item.current ? ' \u25C0' : '';
    const labelColor = isSelected ? THEME.accent : (item.color || THEME.text);
    const icon = item.icon ? `${item.icon} ` : '';

    // Group header
    if (item.group && item.group !== lastGroup) {
      if (i > 0 || lastGroup !== undefined) children.push('\n');
      children.push('\n');
      children.push(React.createElement(Text, { key: `grp-${item.group}`, color: THEME.dim }, `  \u2500\u2500 ${item.group} \u2500\u2500`));
      lastGroup = item.group;
    }

    if (i > 0 || lastGroup !== undefined) children.push('\n');
    children.push(
      React.createElement(React.Fragment, { key: item.id },
        React.createElement(Text, { color: isSelected ? THEME.accent : THEME.dim }, indicator),
        React.createElement(Text, { color: labelColor, bold: isSelected }, `${icon}${item.label}`),
        React.createElement(Text, { color: THEME.dim }, `  ${item.detail}`),
        item.meta ? React.createElement(Text, { color: THEME.muted }, `  ${item.meta}`) : null,
        currentMark ? React.createElement(Text, { color: THEME.warning }, currentMark) : null,
      ),
    );
  }

  // Scroll-down
  if (hasBelow) {
    children.push('\n');
    children.push(React.createElement(Text, { key: 'below', color: THEME.dim }, `  \u2193 ${items.length - startIdx - MAX_VISIBLE} more below`));
  }

  // Hint
  if (hint) {
    children.push('\n');
    children.push(React.createElement(Text, { key: 'hint', color: THEME.dim }, `  ${hint}`));
  }

  return React.createElement(Text, null, ...children);
}
