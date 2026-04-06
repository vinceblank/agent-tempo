/**
 * StatusBar — persistent one-line status summary.
 * Rendered between the live content area and the prompt divider.
 * Shows ensemble name, player breakdown, schedule count, and connection health.
 */
import React from 'react';
import { useInk } from '../ink-context';
import { THEME } from '../utils/theme';
import type { MaestroPlayerInfo } from '../../types';

export interface StatusBarProps {
  ensemble: string | null;
  players: MaestroPlayerInfo[];
  scheduleCount: number;
  connected: boolean;
}

export function StatusBar({ ensemble, players, scheduleCount, connected }: StatusBarProps) {
  const { Box, Text } = useInk();

  // Player breakdown by status
  const active = players.filter(p => p.status === 'active').length;
  const stale = players.filter(p => p.status === 'stale').length;
  const pending = players.filter(p => p.status === 'pending').length;
  const blocked = players.filter(p => p.status === 'blocked').length;

  // Build breakdown parts
  const parts: string[] = [];
  if (active > 0) parts.push(`${active} active`);
  if (stale > 0) parts.push(`${stale} stale`);
  if (blocked > 0) parts.push(`${blocked} blocked`);
  if (pending > 0) parts.push(`${pending} pending`);
  const breakdown = parts.length > 0 ? ` (${parts.join(', ')})` : '';

  // Connection indicator
  const healthColor = connected ? THEME.success : THEME.error;
  const healthLabel = connected ? 'Connected' : 'Disconnected';

  return React.createElement(Box, { paddingX: 1 },
    // Ensemble name
    ensemble
      ? React.createElement(Text, { color: THEME.accent }, ensemble)
      : React.createElement(Text, { color: THEME.dim }, 'no ensemble'),
    React.createElement(Text, { color: THEME.dim }, ' \u00B7 '),
    // Player count
    React.createElement(Text, { color: THEME.dim },
      `${players.length} player${players.length !== 1 ? 's' : ''}${breakdown}`,
    ),
    // Schedule count
    scheduleCount > 0
      ? React.createElement(React.Fragment, null,
          React.createElement(Text, { color: THEME.dim }, ' \u00B7 '),
          React.createElement(Text, { color: THEME.dim }, `${scheduleCount} schedule${scheduleCount !== 1 ? 's' : ''}`),
        )
      : null,
    // Health indicator
    React.createElement(Text, { color: THEME.dim }, ' \u00B7 '),
    React.createElement(Text, { color: healthColor }, '\u25CF'),
    React.createElement(Text, { color: THEME.dim }, ` ${healthLabel}`),
  );
}
