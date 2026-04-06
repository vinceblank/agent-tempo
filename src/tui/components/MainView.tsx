/**
 * MainView — single-column ensemble dashboard.
 * Shows players, recent activity, and schedules.
 * Replaces HomeView in the chat-focused TUI redesign.
 */
import React from 'react';
import { useInk } from '../ink-context';
import { statusIcons, supportsUnicode } from '../utils/platform';
import type { MaestroPlayerInfo, MaestroRelayMessage } from '../../types';

import { THEME } from '../utils/theme';

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
}

/** Pad or truncate a string to exactly `len` chars. */
function pad(s: string, len: number): string {
  if (s.length >= len) return s.slice(0, len);
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

export function MainView({ ensemble, players, messages, schedules }: MainViewProps) {
  const { Box, Text } = useInk();
  const unicode = supportsUnicode();
  const icons = statusIcons(unicode);

  // ── Players section ──
  const playerRows = players.map((p) => {
    const icon = p.isConductor ? icons.conductor
      : p.status === 'active' ? icons.active
      : p.status === 'stale' ? icons.stale
      : p.status === 'pending' ? icons.pending
      : icons.terminated;

    const color = p.status === 'active' ? THEME.success
      : p.status === 'stale' ? THEME.warning
      : THEME.dim;

    const typeName = p.playerType || p.agentType || '';
    const part = p.part || (p.status === 'stale' ? `stale \u2014 last seen recently` : '');

    return React.createElement(Box, { key: p.playerId },
      React.createElement(Text, { color },
        `  ${icon} ${pad(p.playerId, 18)}${pad(typeName, 13)}${truncate(part, 40)}`,
      ),
    );
  });

  // ── Recent activity section ──
  const recentMessages = messages.slice(-8);
  const activityRows = recentMessages.map((m, i) => {
    const time = formatTime(m.timestamp);
    const msgText = truncate(m.text.replace(/\n/g, ' '), 50);
    const color = m.text.includes('stale') ? THEME.warning : THEME.textMuted;

    return React.createElement(Text, { key: i, color },
      `  ${time}  ${m.from} ${icons.arrow} ${m.to}: ${msgText}`,
    );
  });

  // ── Schedules section ──
  const scheduleRows = (schedules || []).map((s, i) =>
    React.createElement(Text, { key: i, color: THEME.textMuted },
      `  \u21BB ${pad(s.name, 20)}${pad(s.spec, 18)}${icons.arrow} ${s.target}`,
    ),
  );

  return React.createElement(Box, { flexDirection: 'column', height: '100%', paddingX: 1 },
    // Players header
    React.createElement(Box, { marginTop: 1 },
      React.createElement(Text, { bold: true, color: THEME.accent }, '  Players'),
    ),
    React.createElement(Box, { height: 1 }),
    ...playerRows,
    players.length === 0
      ? React.createElement(Text, { color: THEME.dim }, '  No players')
      : null,

    // Recent Activity header
    React.createElement(Box, { marginTop: 1 },
      React.createElement(Text, { bold: true, color: THEME.accent }, '  Recent Activity'),
    ),
    React.createElement(Box, { height: 1 }),
    ...activityRows,
    recentMessages.length === 0
      ? React.createElement(Text, { color: THEME.dim }, '  No activity yet')
      : null,

    // Schedules header (only if there are schedules)
    schedules && schedules.length > 0
      ? React.createElement(Box, { flexDirection: 'column', marginTop: 1 },
          React.createElement(Text, { bold: true, color: THEME.accent },
            `  Schedules (${schedules.length} active)`,
          ),
          React.createElement(Box, { height: 1 }),
          ...scheduleRows,
        )
      : null,
  );
}
