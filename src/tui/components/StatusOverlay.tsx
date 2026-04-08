/**
 * StatusOverlay — dismissible overlay showing ensemble player cards.
 *
 * Performance: Single <Text> root with nested virtual-text children.
 * Zero Yoga <Box> nodes.
 */
import React from 'react';
import { useInk } from '../ink-context';
import { THEME } from '../utils/theme';
import type { MaestroPlayerInfo } from '../../types';

export interface StatusOverlayProps {
  players: MaestroPlayerInfo[];
  ensemble: string;
  scrollOffset: number;
  contentHeight: number;
}

const iconMap: Record<string, string> = { active: '\u25CF', blocked: '\u25CB', stale: '\u25CC', pending: '\u23F3' };
const colorMap: Record<string, string> = { active: THEME.success, blocked: THEME.text, stale: THEME.dim, pending: THEME.warning };

export function StatusOverlay({ players, ensemble, scrollOffset, contentHeight }: StatusOverlayProps) {
  const { Text } = useInk();
  const cols = process.stdout.columns || 80;
  const indent = 4;
  const maxWidth = Math.max(20, cols - indent);

  const wrap = (text: string): string => {
    if (text.length <= maxWidth) return text;
    const prefix = ' '.repeat(indent);
    const chunks: string[] = [];
    let rem = text;
    while (rem.length > maxWidth) {
      let brk = rem.lastIndexOf(' ', maxWidth);
      if (brk <= 0) brk = maxWidth;
      chunks.push(rem.slice(0, brk));
      rem = rem.slice(brk).trimStart();
    }
    if (rem) chunks.push(rem);
    return chunks.join('\n' + prefix);
  };

  const maxVisible = Math.max(2, Math.floor((contentHeight - 3) / 4));
  const clampedOffset = Math.min(scrollOffset, Math.max(0, players.length - maxVisible));
  const visiblePlayers = players.slice(clampedOffset, clampedOffset + maxVisible);

  const children: React.ReactNode[] = [];
  children.push(React.createElement(Text, { key: 'h', bold: true, color: THEME.accent },
    `  Ensemble: ${ensemble} (${players.length} player${players.length !== 1 ? 's' : ''})`));

  if (clampedOffset > 0) {
    children.push('\n');
    children.push(React.createElement(Text, { key: 'sup', color: THEME.dim }, `  \u2191 ${clampedOffset} more above`));
  }

  for (const p of visiblePlayers) {
    const icon = iconMap[p.status || 'unknown'] || '?';
    const iconColor = colorMap[p.status || 'unknown'] || THEME.text;
    const conductor = p.isConductor ? ' \u2605' : '';
    children.push('\n\n');
    children.push(React.createElement(React.Fragment, { key: `${p.playerId}-1` },
      React.createElement(Text, { color: iconColor }, `  ${icon} `),
      React.createElement(Text, { bold: true, color: THEME.text }, p.playerId),
      conductor ? React.createElement(Text, { color: THEME.warning }, conductor) : null,
    ));
    const details = [p.status || 'unknown'];
    if (p.gitBranch) details.push(p.gitBranch);
    if (p.playerType || p.agentType) details.push(p.playerType || p.agentType || '');
    children.push('\n');
    children.push(React.createElement(Text, { key: `${p.playerId}-2`, color: THEME.dim }, `    ${wrap(details.join(' \u00B7 '))}`));
    if (p.part) {
      children.push('\n');
      children.push(React.createElement(Text, { key: `${p.playerId}-3`, color: THEME.textMuted }, `    ${wrap(p.part)}`));
    }
  }

  if (clampedOffset + maxVisible < players.length) {
    children.push('\n\n');
    children.push(React.createElement(Text, { key: 'sdn', color: THEME.dim }, `  \u2193 ${players.length - clampedOffset - maxVisible} more below`));
  }

  children.push('\n\n');
  children.push(React.createElement(Text, { key: 'hint', color: THEME.dim }, '  \u2191\u2193 scroll, Esc to dismiss'));
  return React.createElement(Text, null, ...children);
}
