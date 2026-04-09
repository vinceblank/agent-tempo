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

function formatDateTime(ts: string): string {
  try {
    const d = new Date(ts);
    const month = String(d.getMonth() + 1).padStart(2, '0');
    const day = String(d.getDate()).padStart(2, '0');
    return `${month}-${day} ${formatTime(ts)}`;
  } catch {
    return '??';
  }
}

function formatInterval(ms: number): string {
  if (ms < 60000) return `${Math.round(ms / 1000)}s`;
  if (ms < 3600000) return `${Math.round(ms / 60000)}m`;
  return `${(ms / 3600000).toFixed(1)}h`;
}

const typeIcons: Record<string, string> = {
  once: '\u23F1',     // stopwatch
  interval: '\u21BB', // clockwise arrows
  cron: '\u23F0',     // alarm clock
};

const typeLabels: Record<string, string> = {
  once: 'one-shot',
  interval: 'recurring',
  cron: 'cron',
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
      const label = typeLabels[s.type] || s.type;

      children.push('\n\n');
      // Name + type
      children.push(React.createElement(React.Fragment, { key: `s-${i}` },
        React.createElement(Text, { color: THEME.text }, `  ${icon} `),
        React.createElement(Text, { bold: true, color: THEME.text }, s.name),
        React.createElement(Text, { color: THEME.dim }, `  [${label}]`),
      ));

      // Target + message
      const msgPreview = s.message.length > 60 ? s.message.slice(0, 57) + '\u2026' : s.message;
      children.push('\n');
      children.push(React.createElement(Text, { key: `st-${i}`, color: THEME.dim },
        `    \u2192 ${s.target}: `));
      children.push(React.createElement(Text, { key: `sm-${i}`, color: THEME.textMuted || THEME.dim },
        msgPreview));

      // Timing details
      const timingParts: string[] = [];
      if (s.type === 'interval' && s.interval) {
        timingParts.push(`every ${formatInterval(s.interval)}`);
      }
      if (s.cronExpression) {
        timingParts.push(`cron: ${s.cronExpression}`);
        if (s.timezone) timingParts.push(`tz: ${s.timezone}`);
      }
      if (s.nextFireAt) {
        timingParts.push(`next: ${formatDateTime(s.nextFireAt)}`);
      }
      if (s.firedCount > 0) {
        timingParts.push(`fired ${s.firedCount}x`);
      }
      if (s.remainingCount !== undefined) {
        timingParts.push(`${s.remainingCount} remaining`);
      }
      if (s.until) {
        timingParts.push(`until ${formatDateTime(s.until)}`);
      }
      if (timingParts.length > 0) {
        children.push('\n');
        children.push(React.createElement(Text, { key: `sd-${i}`, color: THEME.dim },
          `    ${timingParts.join('  \u00B7  ')}`));
      }
    }
  }

  children.push('\n\n');
  children.push(React.createElement(Text, { key: 'hint', color: THEME.dim },
    '  /schedule create \u2014 new  \u00B7  /schedule delete <name> \u2014 remove'));
  children.push('\n');
  children.push(React.createElement(Text, { key: 'hint2', color: THEME.dim }, '  Esc to dismiss'));

  return React.createElement(Text, null, ...children);
}
