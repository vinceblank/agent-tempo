/**
 * ChatView — conversation with a specific player.
 * Renders as a SINGLE Text element (1 Yoga node) with newlines for rows.
 * All nested Text = ink-virtual-text (0 Yoga nodes).
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

/** Format ISO timestamp to HH:MM. */
function formatTime(ts: string): string {
  try {
    const d = new Date(ts);
    return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
  } catch {
    return '??:??';
  }
}

export function ChatView({
  targetPlayer,
  targetPart,
  targetBranch,
  targetStatus,
  isConductor,
  receivedCount,
  sentCount,
  messages,
}: ChatViewProps) {
  const { Text } = useInk();

  const icon = isConductor ? '\u2605 ' : '';
  const label = isConductor ? 'Conductor' : 'Conversation with';

  const children: React.ReactNode[] = [];

  // ── Header ──
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

  // ── Messages ──
  if (messages.length === 0) {
    children.push('\n');
    children.push(
      React.createElement(Text, { key: 'empty', color: THEME.dim }, '  No messages yet. Type to send a cue.'),
    );
  } else {
    // Limit to last 20 messages to keep React element count low (~100 vs 1000+)
    const MAX_VISIBLE = 20;
    const visibleMessages = messages.length > MAX_VISIBLE ? messages.slice(-MAX_VISIBLE) : messages;
    if (messages.length > MAX_VISIBLE) {
      children.push('\n');
      children.push(
        React.createElement(Text, { key: 'truncated', color: THEME.dim },
          `  \u2191 ${messages.length - MAX_VISIBLE} earlier messages \u00B7 /recall for full history`,
        ),
      );
    }
    for (let i = 0; i < visibleMessages.length; i++) {
      const msg = visibleMessages[i];
      const isSelf = msg.direction === 'sent';
      const senderLabel = isSelf ? 'you (self)' : msg.from;
      const senderColor = isSelf ? THEME.dim : THEME.accent;
      const bodyColor = isSelf ? THEME.textMuted : THEME.text;
      const time = formatTime(msg.timestamp);

      children.push('\n');
      // Sender + timestamp
      children.push(
        React.createElement(React.Fragment, { key: `s-${i}` },
          React.createElement(Text, { color: senderColor }, `  ${senderLabel}`),
          React.createElement(Text, { color: THEME.dim }, `  ${time}`),
        ),
      );
      // Message body
      const lines = msg.text.split('\n');
      for (let li = 0; li < lines.length; li++) {
        children.push('\n');
        children.push(React.createElement(Text, { key: `b-${i}-${li}`, color: bodyColor }, `  ${lines[li]}`));
      }
    }
  }

  // Single Text element
  return React.createElement(Text, null, ...children);
}
