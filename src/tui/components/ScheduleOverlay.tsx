/**
 * ScheduleOverlay — dismissible overlay showing active schedules.
 *
 * Performance: Single <Text> root with nested virtual-text children.
 * Zero Yoga <Box> nodes.
 */
import React from 'react';
import { useInk } from '../ink-context';
import { THEME } from '../utils/theme';
import type { ScheduleEntry } from '../../types';

export interface ScheduleOverlayProps {
  schedules: ScheduleEntry[];
  ensemble: string;
}

function formatTime(ts: string): string {
  try {
    const d = new Date(ts);
    return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
  } catch {
    return '??:??';
  }
}

const typeIcons: Record<string, string> = {
  once: '\u23F1',     // stopwatch
  interval: '\u21BB', // clockwise arrows
  cron: '\u23F0',     // alarm clock
};

export function ScheduleOverlay({ schedules, ensemble }: ScheduleOverlayProps) {
  const { Text } = useInk();

  const children: React.ReactNode[] = [];

  children.push(React.createElement(Text, { key: 'h', bold: true, color: THEME.accent },
    `  Schedules \u00B7 ${ensemble}`));

  if (schedules.length === 0) {
    children.push('\n\n');
    children.push(React.createElement(Text, { key: 'empty', color: THEME.dim }, '  No active schedules.'));
    children.push('\n\n');
    children.push(React.createElement(Text, { key: 'hint1', color: THEME.dim }, '  Use /schedule create to set one up.'));
  } else {
    children.push(React.createElement(Text, { key: 'count', color: THEME.dim },
      ` (${schedules.length})`));

    for (let i = 0; i < schedules.length; i++) {
      const s = schedules[i];
      const icon = typeIcons[s.type] || '\u21BB';
      const fired = s.firedCount > 0 ? ` (fired ${s.firedCount}x)` : '';
      const nextFire = s.nextFireAt ? formatTime(s.nextFireAt) : '?';

      children.push('\n\n');
      children.push(React.createElement(React.Fragment, { key: `s-${i}` },
        React.createElement(Text, { color: THEME.text }, `  ${icon} `),
        React.createElement(Text, { bold: true, color: THEME.text }, s.name),
      ));
      children.push('\n');
      children.push(React.createElement(Text, { key: `sd-${i}`, color: THEME.dim },
        `    ${s.type} \u2192 ${s.target}  next: ${nextFire}${fired}`));
      if (s.cronExpression) {
        children.push('\n');
        children.push(React.createElement(Text, { key: `sc-${i}`, color: THEME.dim },
          `    cron: ${s.cronExpression}`));
      }
    }
  }

  children.push('\n\n');
  children.push(React.createElement(Text, { key: 'hint', color: THEME.dim }, '  Esc to dismiss'));

  return React.createElement(Text, null, ...children);
}
