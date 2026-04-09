/**
 * ConversationStream — live message area showing ensemble conversation.
 *
 * Merges server conversation with local echo (optimistic sent messages),
 * formats messages with header/body layout and word-wrap, and renders
 * the most recent that fit in the viewport.
 *
 * Performance: Single <Text> root with nested virtual-text children.
 * Zero Yoga <Box> nodes.
 */
import React from 'react';
import { useInk } from '../ink-context';
import { THEME } from '../utils/theme';
import { wordWrap } from '../utils/format';

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

const INDENT = '   '; // 3-space indent for message body (aligns with input area)
const MAX_DISPLAY_LINES = 4; // Cap visible body lines

function estimateLines(msg: FormattedMsg, termCols: number): number {
  const bodyWidth = Math.max(20, termCols - 4);
  const originalLines = msg.body.split('\n');
  const cappedLines = originalLines.slice(0, MAX_DISPLAY_LINES);

  // Inbound: header line + body lines. Outbound: inline (no separate header).
  let total = msg.direction === 'out' ? 0 : 1;
  for (const line of cappedLines) {
    total += Math.max(1, Math.ceil(line.length / bodyWidth));
  }
  if (originalLines.length > MAX_DISPLAY_LINES) total += 1;
  total += 1; // blank separator
  return total;
}

export function ConversationStream({ conversation, sentMessages, contentHeight, overflowRef }: ConversationStreamProps) {
  const { Text } = useInk();
  const termCols = process.stdout.columns || 80;
  const bodyWidth = Math.max(20, termCols - 4);

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
    children.push(React.createElement(Text, { key: 'empty', color: THEME.dim }, ' No messages yet. Type to send.'));
  } else {
    for (let i = 0; i < visibleMsgs.length; i++) {
      const msg = visibleMsgs[i];
      children.push(i === 0 ? '\n' : '\n\n');

      const isOut = msg.direction === 'out';
      const bg = isOut ? THEME.inputBg : undefined;

      // Word-wrap body
      const originalLines = msg.body.split('\n');
      const wrappedLines: string[] = [];
      for (const line of originalLines) {
        wrappedLines.push(...wordWrap(line, bodyWidth));
      }
      const displayLines = wrappedLines.slice(0, MAX_DISPLAY_LINES);

      if (isOut) {
        // Outbound: inline — ♩ first line  HH:MM, then wrapped continuation lines
        for (let j = 0; j < displayLines.length; j++) {
          if (j > 0) children.push('\n');
          if (j === 0) {
            // First line: icon + text + timestamp
            const firstText = displayLines[0];
            const pad = ' '.repeat(Math.max(0, termCols - 2 - 3 - firstText.length - 2 - msg.time.length));
            children.push(React.createElement(React.Fragment, { key: `bl-${i}-0` },
              React.createElement(Text, { backgroundColor: bg, color: THEME.accent, bold: true }, ' \u2669 '),
              React.createElement(Text, { backgroundColor: bg, color: THEME.text }, firstText),
              React.createElement(Text, { backgroundColor: bg, color: THEME.dim }, `  ${msg.time}${pad}`),
            ));
          } else {
            // Continuation: indented to align with text after ♩
            const contLine = `${INDENT}${displayLines[j]}`;
            children.push(React.createElement(Text, { key: `bl-${i}-${j}`, backgroundColor: bg, color: THEME.text },
              contLine.padEnd(termCols - 2)));
          }
        }
        if (wrappedLines.length > MAX_DISPLAY_LINES) {
          const moreLine = `${INDENT}\u2026 (${wrappedLines.length - MAX_DISPLAY_LINES} more lines)`;
          children.push('\n');
          children.push(React.createElement(Text, { key: `mt-${i}`, backgroundColor: bg, color: THEME.dim },
            moreLine.padEnd(termCols - 2)));
        }
      } else {
        // Inbound: header line + body lines
        children.push(React.createElement(React.Fragment, { key: `hdr-${i}` },
          React.createElement(Text, { color: THEME.dim }, ' \u2190 '),
          React.createElement(Text, { color: THEME.accent }, msg.sender),
          React.createElement(Text, { color: THEME.dim }, `  ${msg.time}`),
        ));
        for (let j = 0; j < displayLines.length; j++) {
          children.push('\n');
          children.push(React.createElement(Text, { key: `bl-${i}-${j}`, color: THEME.text }, `${INDENT}${displayLines[j]}`));
        }
        if (wrappedLines.length > MAX_DISPLAY_LINES) {
          children.push('\n');
          children.push(React.createElement(Text, { key: `mt-${i}`, color: THEME.dim },
            `${INDENT}\u2026 (${wrappedLines.length - MAX_DISPLAY_LINES} more lines)`));
        }
      }
    }
  }

  return React.createElement(Text, null, ...children);
}
