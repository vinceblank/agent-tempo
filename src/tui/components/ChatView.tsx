/**
 * ChatView — conversation with a specific player.
 * Entered when user runs `/cue <player>`. Shows message thread.
 * Bare text (no `/`) sends as a cue to the target player.
 */
import React from 'react';
import { useInk } from '../ink-context';
import type { Message, SentMessage } from '../../types';

// ── Theme colors ──
const ACCENT = '#E07A5F';
const DIM = '#6B7280';
const TEXT = '#FAF3EE';
const TEXT_SECONDARY = '#9CA3AF';

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
  receivedCount,
  sentCount,
  messages,
}: ChatViewProps) {
  const { Box, Text } = useInk();

  // ── Header info ──
  const header = React.createElement(Box, { flexDirection: 'column', paddingX: 1, marginBottom: 0 },
    React.createElement(Text, { bold: true, color: ACCENT },
      `  Conversation with ${targetPlayer}`,
    ),
    targetPart
      ? React.createElement(Text, { color: DIM }, `  Part: ${targetPart}`)
      : null,
    React.createElement(Text, { color: DIM },
      `  ${targetBranch ? `Branch: ${targetBranch} \u00B7 ` : ''}${receivedCount} received, ${sentCount} sent`,
    ),
    React.createElement(Text, { color: DIM },
      '  ' + '\u2500'.repeat(55),
    ),
  );

  // ── Message thread ──
  const messageElements = messages.map((msg, i) => {
    const isSelf = msg.direction === 'sent';
    const senderLabel = isSelf ? 'you (self)' : msg.from;
    const senderColor = isSelf ? DIM : ACCENT;
    const bodyColor = isSelf ? TEXT_SECONDARY : TEXT;
    const time = formatTime(msg.timestamp);

    // Wrap message body to reasonable width
    const lines = msg.text.split('\n');

    return React.createElement(Box, { key: i, flexDirection: 'column', paddingX: 1, marginTop: i > 0 ? 0 : 0 },
      // Sender + timestamp on same line
      React.createElement(Box, { justifyContent: 'space-between', width: '100%' },
        React.createElement(Text, { color: senderColor }, `  ${senderLabel}`),
        React.createElement(Text, { color: DIM }, time),
      ),
      // Message body
      ...lines.map((line, li) =>
        React.createElement(Text, { key: li, color: bodyColor }, `  ${line}`),
      ),
    );
  });

  return React.createElement(Box, { flexDirection: 'column', height: '100%' },
    header,
    // Scrollable message area
    React.createElement(Box, { flexDirection: 'column', flexGrow: 1, overflow: 'hidden' },
      ...messageElements,
      messages.length === 0
        ? React.createElement(Box, { paddingX: 1, marginTop: 1 },
            React.createElement(Text, { color: DIM }, '  No messages yet. Type to send a cue.'),
          )
        : null,
    ),
  );
}
