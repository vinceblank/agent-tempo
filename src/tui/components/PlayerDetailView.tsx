/**
 * PlayerDetailView — shows player metadata + scrollable message history.
 * Single <Text> pattern, zero Yoga nodes — all content pre-formatted as strings.
 */
import React from 'react';
import { useInk } from '../ink-context';
import { THEME } from '../utils/theme';
import type { MaestroPlayerInfo, Message, SentMessage } from '../../types';

const MAX_VISIBLE = 20;

export interface PlayerDetailViewProps {
  playerId: string;
  ensemble: string;
  player: MaestroPlayerInfo | null;
  metadata: any;
  messages: Array<Message | (SentMessage & { direction: 'sent' })>;
  scrollOffset: number;
}

function isSent(m: Message | (SentMessage & { direction: 'sent' })): m is SentMessage & { direction: 'sent' } {
  return 'direction' in m && m.direction === 'sent';
}

function formatTime(ts: string): string {
  try {
    const d = new Date(ts);
    return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
  } catch {
    return '??:??';
  }
}

export function PlayerDetailView({
  playerId,
  player,
  metadata,
  messages,
  scrollOffset,
}: PlayerDetailViewProps) {
  const { Text } = useInk();

  const children: React.ReactNode[] = [];

  // Header — player identity
  const icon = player?.isConductor ? '\u2605 ' : '  ';
  children.push(React.createElement(Text, { key: 'name', bold: true, color: THEME.accent }, `${icon}${playerId}`));

  // Metadata line 1: Type · Status · Host
  const type = player?.playerType || player?.agentType || '(default)';
  const status = player?.status || 'unknown';
  const statusDot = status === 'active' ? '\u25CF' : status === 'stale' ? '\u25CB' : '\u25A0';
  const host = player?.hostname || metadata?.hostname || '?';
  children.push('\n');
  children.push(React.createElement(Text, { key: 'meta1', color: THEME.dim }, `  Type: ${type} \u00B7 Status: ${statusDot} ${status} \u00B7 Host: ${host}`));

  // Metadata line 2: Branch · Dir
  const branch = player?.gitBranch || metadata?.gitBranch || '';
  const dir = metadata?.workDir || player?.workDir || '';
  if (branch || dir) {
    children.push('\n');
    const parts: string[] = [];
    if (branch) parts.push(`Branch: ${branch}`);
    if (dir) parts.push(`Dir: ${dir}`);
    children.push(React.createElement(Text, { key: 'meta2', color: THEME.dim }, `  ${parts.join(' \u00B7 ')}`));
  }

  // Part
  if (player?.part) {
    children.push('\n');
    children.push(React.createElement(Text, { key: 'part', color: THEME.textMuted }, `  Part: ${player.part}`));
  }

  // Divider
  children.push('\n\n');
  children.push(React.createElement(Text, { key: 'div', color: THEME.border }, '  ' + '\u2500'.repeat(55)));

  // Messages header
  const total = messages.length;
  const windowStart = Math.min(scrollOffset, Math.max(0, total - MAX_VISIBLE));
  const visible = messages.slice(windowStart, windowStart + MAX_VISIBLE);
  const earlierCount = windowStart;

  children.push('\n');
  if (total === 0) {
    children.push(React.createElement(Text, { key: 'nomsg', color: THEME.dim }, '  No messages yet.'));
  } else {
    children.push(React.createElement(Text, { key: 'mhdr', color: THEME.dim },
      `  Messages (${total} total \u00B7 showing ${visible.length})`));

    if (earlierCount > 0) {
      children.push('\n');
      children.push(React.createElement(Text, { key: 'earlier', color: THEME.dim }, `  \u2191 ${earlierCount} earlier messages`));
    }

    for (let i = 0; i < visible.length; i++) {
      const m = visible[i];
      const time = formatTime(m.timestamp);
      children.push('\n');
      if (isSent(m)) {
        const preview = m.text.length > 80 ? m.text.slice(0, 77).replace(/\n/g, ' ') + '...' : m.text.replace(/\n/g, ' ');
        children.push(React.createElement(React.Fragment, { key: `m-${i}` },
          React.createElement(Text, { color: THEME.dim }, `  ${time}  `),
          React.createElement(Text, { color: THEME.accent, bold: true }, '\u276F '),
          React.createElement(Text, { color: THEME.text }, preview),
        ));
      } else {
        const msg = m as Message;
        const preview = msg.text.length > 80 ? msg.text.slice(0, 77).replace(/\n/g, ' ') + '...' : msg.text.replace(/\n/g, ' ');
        children.push(React.createElement(React.Fragment, { key: `m-${i}` },
          React.createElement(Text, { color: THEME.dim }, `  ${time}  \u2190 `),
          React.createElement(Text, { color: THEME.accent }, `${msg.from}: `),
          React.createElement(Text, { color: THEME.text }, preview),
        ));
      }
    }
  }

  // Footer hint
  children.push('\n\n');
  children.push(React.createElement(Text, { key: 'hint', color: THEME.dim }, '  \u2191\u2193 scroll \u00B7 Esc back \u00B7 /cue to chat'));

  return React.createElement(Text, null, ...children);
}
