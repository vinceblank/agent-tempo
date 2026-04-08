/**
 * ConversationStream — live message area showing ensemble conversation.
 *
 * Merges server conversation with local echo (optimistic sent messages),
 * formats messages, and renders the most recent that fit in the viewport.
 *
 * Performance: Single <Text> root with nested virtual-text children.
 * Zero Yoga <Box> nodes.
 */
import React from 'react';
import { useInk } from '../ink-context';
import { THEME } from '../utils/theme';

export interface ConversationMessage {
  id: string;
  from: string;
  to: string;
  text: string;
  timestamp: string;
  direction: 'in' | 'out';
}

export interface SentMessage {
  to: string;
  text: string;
  timestamp: string;
}

export interface ConversationStreamProps {
  conversation: ConversationMessage[];
  sentMessages: SentMessage[];
  contentHeight: number;
  /** Ref to store overflow data for parent to commit to Static scrollback. */
  overflowRef: React.MutableRefObject<{
    formatted: Array<{ sender: string; time: string; body: string; direction: 'in' | 'out' }>;
    startIdx: number;
  } | null>;
}

interface FormattedMsg {
  sender: string;
  time: string;
  body: string;
  direction: 'in' | 'out';
}

function formatTime(timestamp: string): string {
  try {
    const d = new Date(timestamp);
    return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
  } catch {
    return '??:??';
  }
}

function estimateLines(msg: FormattedMsg, termCols: number): number {
  const lines = msg.body.split('\n');
  const visLines = Math.min(lines.length, 4);
  let total = 0;
  for (let i = 0; i < visLines; i++) {
    const prefixLen = i === 0
      ? (msg.direction === 'out' ? 4 : 5 + msg.sender.length + 2 + 2 + msg.time.length)
      : (msg.direction === 'out' ? 4 : 4 + msg.sender.length + 2);
    total += Math.max(1, Math.ceil((prefixLen + lines[i].length) / termCols));
  }
  if (lines.length > 4) total += 1; // "… (N more lines)"
  total += 1; // blank separator
  return total;
}

export function ConversationStream({ conversation, sentMessages, contentHeight, overflowRef }: ConversationStreamProps) {
  const { Text } = useInk();
  const termCols = process.stdout.columns || 80;

  // Merge server conversation with local echo (optimistic sent not yet on server)
  const allConvoMsgs: ConversationMessage[] = [...conversation];
  for (const m of sentMessages) {
    const ts = new Date(m.timestamp).getTime();
    const alreadyOnServer = conversation.some(c =>
      c.direction === 'out' &&
      Math.abs(new Date(c.timestamp).getTime() - ts) < 30000 &&
      c.text.slice(0, 60) === m.text.slice(0, 60)
    );
    if (!alreadyOnServer) {
      allConvoMsgs.push({ id: `local-${m.timestamp}`, from: 'you', to: m.to, text: m.text, timestamp: m.timestamp, direction: 'out' });
    }
  }
  const sorted = allConvoMsgs.sort((a, b) => new Date(a.timestamp).getTime() - new Date(b.timestamp).getTime());

  // Format messages
  const formatted: FormattedMsg[] = sorted.map(m => ({
    sender: m.from,
    time: formatTime(m.timestamp),
    body: m.text,
    direction: m.direction,
  }));

  // Work backwards from newest — include as many as fit in viewport
  let usedLines = 0;
  let startIdx = formatted.length;
  for (let i = formatted.length - 1; i >= 0; i--) {
    const needed = estimateLines(formatted[i], termCols);
    if (usedLines + needed > contentHeight) break;
    usedLines += needed;
    startIdx = i;
  }

  // Store overflow data for parent to commit to Static scrollback
  overflowRef.current = { formatted, startIdx };

  const visibleMsgs = formatted.slice(startIdx);
  const children: React.ReactNode[] = [];

  if (visibleMsgs.length === 0) {
    children.push('\n');
    children.push(React.createElement(Text, { key: 'empty', color: THEME.dim }, '  No messages yet. Type to send.'));
  } else {
    for (let i = 0; i < visibleMsgs.length; i++) {
      const msg = visibleMsgs[i];
      children.push(i === 0 ? '\n' : '\n\n');
      if (msg.direction === 'out') {
        // Outbound — Claude Code user input style: ❯ message
        const firstLine = msg.body.split('\n')[0];
        children.push(
          React.createElement(React.Fragment, { key: `ms-${i}` },
            React.createElement(Text, { color: THEME.accent, bold: true }, '  \u276F '),
            React.createElement(Text, { color: THEME.text }, firstLine),
            React.createElement(Text, { color: THEME.dim }, `  ${msg.time}`),
          ),
        );
        const rest = msg.body.split('\n').slice(1, 4);
        for (const line of rest) {
          children.push('\n');
          children.push(React.createElement(Text, { key: `mb-${i}-${line.slice(0, 8)}`, color: THEME.text }, `    ${line}`));
        }
        if (msg.body.split('\n').length > 4) {
          children.push('\n');
          children.push(React.createElement(Text, { key: `mt-${i}`, color: THEME.dim }, `    \u2026 (${msg.body.split('\n').length - 4} more lines)`));
        }
      } else {
        // Inbound — Claude Code channel style: ← player: message  HH:MM
        const lines = msg.body.split('\n');
        const firstLine = lines[0];
        children.push(
          React.createElement(React.Fragment, { key: `ms-${i}` },
            React.createElement(Text, { color: THEME.dim }, '  \u2190 '),
            React.createElement(Text, { color: THEME.accent }, `${msg.sender}: `),
            React.createElement(Text, { color: THEME.text }, firstLine),
            React.createElement(Text, { color: THEME.dim }, `  ${msg.time}`),
          ),
        );
        const rest = lines.slice(1, 4);
        const indent = '    ' + ' '.repeat(msg.sender.length + 2);
        for (const line of rest) {
          children.push('\n');
          children.push(React.createElement(Text, { key: `mb-${i}-${line.slice(0, 8)}`, color: THEME.text }, `${indent}${line}`));
        }
        if (lines.length > 4) {
          children.push('\n');
          children.push(React.createElement(Text, { key: `mt-${i}`, color: THEME.dim }, `${indent}\u2026 (${lines.length - 4} more lines)`));
        }
      }
    }
  }

  return React.createElement(Text, null, ...children);
}
