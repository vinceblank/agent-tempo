/**
 * ChatView — header for a conversation with a specific player.
 * Messages are rendered via <Static> in App.tsx, not here.
 * This component only shows context (player name, part, branch, counts).
 */
import React from 'react';
import { useInk } from '../ink-context';
import { THEME } from '../utils/theme';

export interface ChatMessage {
  direction: 'received' | 'sent';
  from: string;
  text: string;
  timestamp: string;
}

export interface ChatViewProps {
  targetPlayer: string;
  targetPart?: string;
  targetBranch?: string;
  targetStatus?: string;
  isConductor?: boolean;
  receivedCount: number;
  sentCount: number;
  messages: ChatMessage[];
}

export function ChatView({
  targetPlayer,
  targetPart,
  targetBranch,
  isConductor,
  receivedCount,
  sentCount,
}: ChatViewProps) {
  const { Text } = useInk();

  const icon = isConductor ? '\u2605 ' : '';
  const label = isConductor ? 'Conductor' : 'Conversation with';

  const children: React.ReactNode[] = [];

  children.push(
    React.createElement(Text, { key: 'h1', bold: true, color: THEME.accent },
      `  ${icon}${label} ${targetPlayer}`,
    ),
  );
  if (targetPart) {
    children.push('\n');
    children.push(React.createElement(Text, { key: 'h2', color: THEME.dim }, `  Part: ${targetPart}`));
  }
  children.push('\n');
  children.push(
    React.createElement(Text, { key: 'h3', color: THEME.dim },
      `  ${targetBranch ? `Branch: ${targetBranch} \u00B7 ` : ''}${receivedCount} received, ${sentCount} sent`,
    ),
  );
  children.push('\n');
  children.push(
    React.createElement(Text, { key: 'h4', color: THEME.border }, '  ' + '\u2500'.repeat(55)),
  );
  children.push('\n');
  children.push(
    React.createElement(Text, { key: 'h5', color: THEME.dim }, '  Messages appear above \u2191 (scroll up in terminal)'),
  );

  return React.createElement(Text, null, ...children);
}
