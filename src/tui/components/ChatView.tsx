/**
 * ChatView — header for a conversation with a specific player.
 * Messages are rendered via <Static> in App.tsx, not here.
 * This component only shows context (player name, part, branch, counts).
 *
 * PR-F cross-host indicator (design §16, brief §8 answer 3 — Option 3):
 *   - Local session (targetHost === localHost) → omit host entirely (no noise).
 *   - Remote session → prepend `{host} · ` to the existing status line in
 *     `THEME.accent` (amber).
 * Zero new Yoga nodes: the host prefix goes into the same `<Text>` children
 * tree as an additional string + nested accent-colored `<Text>` (which is a
 * virtual text node, not a Box).
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
  /** The session's home hostname (PR-A metadata). Compare vs `localHost` to decide cross-host rendering. */
  targetHost?: string;
  /** The local TUI process's hostname. */
  localHost?: string;
  isConductor?: boolean;
  receivedCount: number;
  sentCount: number;
  messages: ChatMessage[];
}

export function ChatView({
  targetPlayer,
  targetPart,
  targetBranch,
  targetHost,
  localHost,
  isConductor,
  receivedCount,
  sentCount,
}: ChatViewProps) {
  const { Text } = useInk();

  const icon = isConductor ? '\u2605 ' : '';
  const label = isConductor ? 'Conductor' : 'Conversation with';

  // §8 answer 3 — remote host only; local omits entirely.
  const showRemoteHost = Boolean(targetHost && localHost && targetHost !== localHost);

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

  // Status line — prepend amber {host} · for remote sessions only.
  // Zero new Yoga nodes: composed inline as nested <Text> within h3.
  const h3Children: React.ReactNode[] = [];
  h3Children.push('  ');
  if (showRemoteHost) {
    h3Children.push(
      React.createElement(Text, { key: 'host', color: THEME.accent }, targetHost!),
    );
    h3Children.push(' \u00B7 ');
  }
  if (targetBranch) {
    h3Children.push(`Branch: ${targetBranch} \u00B7 `);
  }
  h3Children.push(`${receivedCount} received, ${sentCount} sent`);
  children.push(
    React.createElement(Text, { key: 'h3', color: THEME.dim }, ...h3Children),
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
