/**
 * StatusBar — persistent one-line status summary.
 * Renders as a SINGLE Text element (1 Yoga node). Nested Text = ink-virtual-text (0 nodes).
 */
import React from 'react';
import { useInk } from '../ink-context';
import { THEME } from '../utils/theme';
import type { MaestroPlayerInfo } from '../../types';

export interface StatusBarProps {
  ensemble: string | null;
  players: MaestroPlayerInfo[];
  /** True after the first player poll completes. False = still loading. */
  playersLoaded: boolean;
  scheduleCount: number;
  connected: boolean;
  conductorName?: string;
}

export function StatusBar({ ensemble, players, playersLoaded, scheduleCount, connected, conductorName }: StatusBarProps) {
  const { Text } = useInk();

  const healthColor = connected ? THEME.success : THEME.error;
  const healthDot = connected ? '\u25CF' : '\u25CB';
  const healthLabel = connected ? 'Connected' : 'Disconnected';

  const ensembleLabel = ensemble || 'no ensemble';

  const children: React.ReactNode[] = [
    '  ',
    React.createElement(Text, { key: 'ens', color: ensemble ? THEME.accent : THEME.dim }, ensembleLabel),
    React.createElement(Text, { key: 's1', color: THEME.dim }, ' \u00B7 '),
  ];

  if (ensemble && !playersLoaded) {
    // Still loading — don't show incorrect counts
    children.push(React.createElement(Text, { key: 'pl', color: THEME.dim }, 'Loading...'));
  } else {
    // Player breakdown by status
    const active = players.filter(p => p.status === 'active').length;
    const stale = players.filter(p => p.status === 'stale').length;
    const pending = players.filter(p => p.status === 'pending').length;
    const blocked = players.filter(p => p.status === 'blocked').length;

    const parts: string[] = [];
    if (active > 0) parts.push(`${active} active`);
    if (stale > 0) parts.push(`${stale} stale`);
    if (blocked > 0) parts.push(`${blocked} blocked`);
    if (pending > 0) parts.push(`${pending} pending`);
    const breakdown = parts.length > 0 ? ` (${parts.join(', ')})` : '';
    const playerLabel = `${players.length} player${players.length !== 1 ? 's' : ''}${breakdown}`;

    children.push(React.createElement(Text, { key: 'pl', color: THEME.dim }, playerLabel));

    if (scheduleCount > 0) {
      children.push(
        React.createElement(Text, { key: 's2', color: THEME.dim }, ' \u00B7 '),
        React.createElement(Text, { key: 'sc', color: THEME.dim }, `${scheduleCount} schedule${scheduleCount !== 1 ? 's' : ''}`),
      );
    }

    if (ensemble && !conductorName) {
      children.push(
        React.createElement(Text, { key: 's3', color: THEME.dim }, ' \u00B7 '),
        React.createElement(Text, { key: 'nc', color: THEME.warning }, '\u26A0 No conductor'),
      );
    }
  }

  children.push(
    React.createElement(Text, { key: 's4', color: THEME.dim }, ' \u00B7 '),
    React.createElement(Text, { key: 'hd', color: healthColor }, healthDot),
    React.createElement(Text, { key: 'hl', color: THEME.dim }, ` ${healthLabel}`),
  );

  // Single Text element — all children are ink-virtual-text (0 Yoga nodes)
  return React.createElement(Text, null, ...children);
}
