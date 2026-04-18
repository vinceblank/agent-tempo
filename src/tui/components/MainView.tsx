/**
 * MainView — single-column ensemble dashboard.
 * Renders as a SINGLE Text element (1 Yoga node) with newlines for rows.
 * All nested Text = ink-virtual-text (0 Yoga nodes).
 */
import React from 'react';
import { useInk } from '../ink-context';
import { statusIcons, supportsUnicode } from '../utils/platform';
import type { MaestroPlayerInfo, MaestroRelayMessage } from '../../types';
import { THEME } from '../utils/theme';
import { phaseToColor, phaseToIconName } from '../utils/format';

export interface ScheduleInfo {
  name: string;
  spec: string;
  target: string;
}

export interface MainViewProps {
  ensemble: string;
  players: MaestroPlayerInfo[];
  messages: MaestroRelayMessage[];
  schedules?: ScheduleInfo[];
  /** Total number of static items in scrollback (for indicator). */
  staticItemCount?: number;
}

/** Pad or truncate with ellipsis to exactly `len` chars. */
function pad(s: string, len: number): string {
  if (s.length > len) return s.slice(0, len - 1) + '\u2026';
  return s + ' '.repeat(len - s.length);
}

/** Format a timestamp to HH:MM. */
function formatTime(ts: string): string {
  try {
    const d = new Date(ts);
    return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
  } catch {
    return '??:??';
  }
}

/** Truncate text with ellipsis. */
function truncate(text: string, max: number): string {
  if (text.length <= max) return text;
  return text.slice(0, max - 1) + '\u2026';
}

export function MainView({ ensemble, players, messages, schedules, staticItemCount }: MainViewProps) {
  const { Text } = useInk();
  const unicode = supportsUnicode();
  const icons = statusIcons(unicode);

  const children: React.ReactNode[] = [];

  // ── Players section ──
  children.push('\n');
  children.push(React.createElement(Text, { key: 'ph', bold: true, color: THEME.accent }, '  Players'));
  children.push('\n');

  if (players.length === 0) {
    children.push(React.createElement(Text, { key: 'np', color: THEME.dim }, '  No players'));
  } else {
    for (let i = 0; i < players.length; i++) {
      const p = players[i];
      // Collapse the attachment phase via the Option-B helpers in utils/format.
      const icon = p.isConductor ? icons.conductor : icons[phaseToIconName(p.phase)];
      const color = phaseToColor(p.phase);

      const typeName = p.playerType || p.agentType || '';
      const part = p.part || '';

      if (i > 0) children.push('\n');
      children.push(
        React.createElement(Text, { key: p.playerId, color },
          `  ${icon} ${pad(p.playerId, 20)} ${pad(typeName, 22)} ${truncate(part, 35)}`,
        ),
      );
    }
  }

  // ── Separator ──
  children.push('\n');
  children.push(React.createElement(Text, { key: 'sep1', color: THEME.border }, '  ' + '\u2500'.repeat(50)));

  // ── Recent Activity section ──
  children.push('\n');
  children.push(React.createElement(Text, { key: 'ah', bold: true, color: THEME.accent }, '  Recent Activity'));
  children.push('\n');

  const recentMessages = messages.slice(-3);
  if (recentMessages.length === 0 && !staticItemCount) {
    children.push(React.createElement(Text, { key: 'na', color: THEME.dim }, '  No activity yet'));
  } else {
    // Scrollback indicator
    if (staticItemCount && staticItemCount > 0) {
      children.push(
        React.createElement(Text, { key: 'scrollback', color: THEME.dim },
          `  \u2191 ${staticItemCount} messages in scrollback (scroll up in terminal)`),
      );
      children.push('\n');
    }
    // Latest 3 messages as preview
    for (let i = 0; i < recentMessages.length; i++) {
      const m = recentMessages[i];
      const time = formatTime(m.timestamp);
      const msgText = truncate(m.text.replace(/\n/g, ' '), 60);

      if (i > 0) children.push('\n');
      children.push(
        React.createElement(Text, { key: m.id || `msg-${i}`, color: THEME.dim },
          `  ${time}  ${m.from} ${icons.arrow} ${m.to}: ${msgText}`,
        ),
      );
    }
  }

  // ── Schedules section (only if there are schedules) ──
  if (schedules && schedules.length > 0) {
    children.push('\n');
    children.push(React.createElement(Text, { key: 'sep2', color: THEME.border }, '  ' + '\u2500'.repeat(50)));
    children.push('\n');
    children.push(
      React.createElement(Text, { key: 'sh', bold: true, color: THEME.accent },
        `  Schedules (${schedules.length} active)`,
      ),
    );
    children.push('\n');

    for (let i = 0; i < schedules.length; i++) {
      const s = schedules[i];
      if (i > 0) children.push('\n');
      children.push(
        React.createElement(Text, { key: `sched-${i}`, color: THEME.textMuted },
          `  \u21BB ${pad(s.name, 20)}${pad(s.spec, 18)}${icons.arrow} ${s.target}`,
        ),
      );
    }
  }

  // Single Text element — all children are ink-virtual-text (0 Yoga nodes)
  return React.createElement(Text, null, ...children);
}
