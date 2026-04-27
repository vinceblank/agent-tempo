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
  /** Message role from ensemble chat feed. */
  role?: 'maestro-out' | 'maestro-in' | 'conductor-out' | 'conductor-in';
  /** True for conductor↔player traffic (rendered dimmed). */
  thirdParty?: boolean;
  /**
   * #357: Mirrors `EnsembleChatMessage.broadcastId`. When set, consecutive
   * messages sharing the same id collapse into a single rendered row with
   * a `📡 broadcast → N players` badge. `undefined` for direct cues.
   */
  broadcastId?: string;
}

export interface SentMessage {
  to: string;
  text: string;
  timestamp: string;
  /** #357: Mirrors `Message.broadcastId` on the sender side. */
  broadcastId?: string;
}

export interface ConversationStreamProps {
  conversation: ConversationMessage[];
  sentMessages: SentMessage[];
  contentHeight: number;
  /** Ref to store overflow data for parent to commit to Static scrollback. */
  overflowRef: React.MutableRefObject<{
    formatted: Array<{ sender: string; time: string; body: string; direction: 'in' | 'out'; thirdParty?: boolean; routeLabel?: string }>;
    startIdx: number;
  } | null>;
  /**
   * #360: playerId of the conductor in the active ensemble (derived from
   * `state.players.find(p => p.isConductor)`). Used to suppress the
   * `→ @<to>` recipient prefix on outbound messages addressed to the
   * conductor — those route through the implicit "send to conductor"
   * path and the prefix would be visually noisy. `undefined` when no
   * conductor is in the ensemble.
   */
  conductorPlayerId?: string;
}

export interface FormattedMsg {
  sender: string;
  time: string;
  body: string;
  direction: 'in' | 'out';
  role?: string;
  thirdParty?: boolean;
  /** For conductor traffic: show routing (from → to). */
  routeLabel?: string;
  /**
   * #360: For directed `maestro-out` messages where the recipient is
   * NOT the conductor — prepend `→ @<recipientLabel>` to the rendered
   * body so the user can see who they actually messaged. Empty for
   * inbound, conductor-bound, or third-party messages.
   *
   * Mutually exclusive with `broadcastBadge` — when a row represents a
   * folded broadcast group, the badge enumerates recipients and the
   * single-recipient prefix would duplicate that information.
   */
  recipientLabel?: string;
  /**
   * #357: When set, this `FormattedMsg` represents a folded group of
   * consecutive messages sharing the same `broadcastId`. The renderer
   * surfaces a `📡 broadcast → <count> players` segment in front of
   * the body in place of the `→ @<to>` recipient prefix. The first
   * `recipients.length` names are listed (cap = 3 + "+N more").
   */
  broadcastBadge?: { count: number; recipients: string[] };
  /**
   * Pre-rendered first-line prefix string (broadcast badge or directed
   * `→ @<to> `). Computed once in `buildFormattedMessages` so the line
   * estimator and the renderer share the exact same value without each
   * having to call `broadcastBadgeText` independently.
   */
  firstLinePrefix?: string;
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
const MAX_DISPLAY_LINES_THIRD_PARTY = 4; // Cap visible body lines for third-party (conductor) traffic

/** Direct messages (maestro-in/out) show in full; third-party traffic is capped. */
function maxLines(msg: FormattedMsg): number {
  return msg.thirdParty ? MAX_DISPLAY_LINES_THIRD_PARTY : Infinity;
}

/** Maximum recipient names listed inline in the broadcast badge text. */
const BROADCAST_BADGE_NAME_CAP = 3;

/**
 * Render the broadcast-badge inline text (#357). Format:
 *   `📡 broadcast → 3 players (alice, bob, carol) `
 *   `📡 broadcast → 8 players (alice, bob, carol +5 more) `
 * Trailing space is intentional — the body text follows on the same line.
 */
function broadcastBadgeText(badge: { count: number; recipients: string[] }): string {
  const head = `\u{1F4E1} broadcast → ${badge.count} player${badge.count === 1 ? '' : 's'}`;
  const named = badge.recipients.slice(0, BROADCAST_BADGE_NAME_CAP);
  const remainder = Math.max(0, badge.count - named.length);
  if (named.length === 0) return `${head} `;
  const list = remainder > 0 ? `${named.join(', ')} +${remainder} more` : named.join(', ');
  return `${head} (${list}) `;
}

/**
 * Build the inline first-line prefix string added to outbound messages:
 * either the broadcast badge (#357) — which dominates when present —
 * or the directed-recipient prefix (#360). Empty string when neither
 * applies. Used by both `buildFormattedMessages` (precomputes once on
 * `FormattedMsg.firstLinePrefix`) and as a fallback in `estimateLines`.
 */
function makeFirstLinePrefix(msg: { broadcastBadge?: { count: number; recipients: string[] }; recipientLabel?: string }): string {
  if (msg.broadcastBadge) return broadcastBadgeText(msg.broadcastBadge);
  // `→ @<label> ` — arrow + space + @ + label + trailing space.
  if (msg.recipientLabel) return `→ @${msg.recipientLabel} `;
  return '';
}

function estimateLines(msg: FormattedMsg, termCols: number): number {
  const bodyWidth = Math.max(20, termCols - 4);
  const originalLines = msg.body.split('\n');
  const cap = maxLines(msg);
  // When a first-line prefix (broadcast badge / `→ @<to>`) is shown,
  // wrap the FIRST source line at a narrower width. Continuation source
  // lines (and continuation wraps) use the full bodyWidth.
  const prefixLen = msg.firstLinePrefix?.length ?? 0;
  const firstLineWidth = Math.max(20, bodyWidth - prefixLen);

  // Wrap ALL lines, then cap — matches rendering logic exactly
  let wrappedCount = 0;
  for (let li = 0; li < originalLines.length; li++) {
    const w = li === 0 ? firstLineWidth : bodyWidth;
    wrappedCount += wordWrap(originalLines[li], w).length;
  }

  let total = msg.direction === 'out' ? 0 : 1; // header line for inbound
  total += Math.min(wrappedCount, cap);          // body (capped by WRAPPED count)
  if (wrappedCount > cap) total += 1;            // overflow indicator "… (N more lines)"
  total += 1;                                     // separator (\n or \n\n)
  return total;
}

/**
 * #357: Fold consecutive `ConversationMessage`s sharing the same
 * non-null `broadcastId` into a single group. Runs BEFORE per-message
 * line estimation so `usedLines` doesn't over-count an unfolded
 * fan-out and shrink the viewport.
 *
 * Fold key is `broadcastId + direction` only \u2014 role is excluded so
 * local-echo entries (`from: 'you'`, undefined role) fold with their
 * server-projected counterparts (`role: 'maestro-out'`) sharing the
 * same id while the broadcast is in flight. Direction split keeps the
 * inbound/outbound perspective intact.
 */
function foldByBroadcastId(sorted: ConversationMessage[]): Array<ConversationMessage[]> {
  const groups: Array<ConversationMessage[]> = [];
  for (const m of sorted) {
    const last = groups[groups.length - 1];
    if (
      m.broadcastId &&
      last &&
      last[0].broadcastId === m.broadcastId &&
      last[0].direction === m.direction
    ) {
      last.push(m);
    } else {
      groups.push([m]);
    }
  }
  return groups;
}

/**
 * Pure projection: merge server conversation with local-echo sent
 * messages, sort by timestamp, fold broadcast fan-out groups, and
 * format each entry into the render-ready `FormattedMsg` shape.
 * Exported so tests can assert on `recipientLabel` / `broadcastBadge`
 * / `routeLabel` derivation without mounting Ink.
 *
 * `conductorPlayerId` is the active ensemble's conductor id. Used to
 * suppress the `recipientLabel` on conductor-bound `maestro-out` rows
 * so the `\u2192 @<conductor>` prefix doesn't dominate every message.
 */
export function buildFormattedMessages(
  conversation: ConversationMessage[],
  sentMessages: SentMessage[],
  conductorPlayerId?: string,
): FormattedMsg[] {
  // Merge server conversation with local echo (optimistic sent not yet on server)
  const allConvoMsgs: ConversationMessage[] = [...conversation];
  for (const m of sentMessages) {
    const ts = new Date(m.timestamp).getTime();
    // Strip @player prefix from sent text for comparison (server doesn't have it)
    const sentBody = m.text.replace(/^@\S+\s+/, '');
    const alreadyOnServer = conversation.some(c =>
      c.direction === 'out' &&
      Math.abs(new Date(c.timestamp).getTime() - ts) < 30000 &&
      c.text.slice(0, 60) === sentBody.slice(0, 60)
    );
    if (!alreadyOnServer) {
      allConvoMsgs.push({
        id: `local-${m.timestamp}`,
        from: 'you',
        to: m.to,
        text: m.text,
        timestamp: m.timestamp,
        direction: 'out',
        // Forward broadcastId from the local-echo SentMessage so a
        // freshly-sent broadcast still folds before the server projection
        // catches up. (#357)
        ...(m.broadcastId !== undefined ? { broadcastId: m.broadcastId } : {}),
      });
    }
  }
  const sorted = allConvoMsgs.sort((a, b) => new Date(a.timestamp).getTime() - new Date(b.timestamp).getTime());

  // #357: fold consecutive same-broadcastId entries into groups, then
  // project each group as one FormattedMsg. The badge enumerates
  // recipients; the first message's body/timestamp/sender stand in for
  // the group's display fields.
  const groups = foldByBroadcastId(sorted);

  return groups.map(group => {
    const m = group[0];
    const role = m.role;
    const thirdParty = m.thirdParty;
    let routeLabel: string | undefined;
    if (role === 'conductor-out') routeLabel = `${m.from} \u2192 ${m.to}`;
    else if (role === 'conductor-in') routeLabel = `${m.from} \u2192 ${m.to}`;

    // #357: badge wins over recipientLabel \u2014 when the row represents a
    // folded broadcast, recipients are already enumerated inside the
    // badge text and the single-recipient prefix would duplicate that.
    let broadcastBadge: { count: number; recipients: string[] } | undefined;
    if (m.broadcastId) {
      broadcastBadge = {
        count: group.length,
        recipients: group.map(g => g.to),
      };
    }

    // #360: only set recipientLabel for `maestro-out` messages where
    // the recipient is neither the active conductor (whose role is the
    // implicit default for bare-text input) nor the legacy `'conductor'`
    // literal. `to` of `'maestro'` is also excluded \u2014 outbound to maestro
    // is meaningless (the maestro is the user's own session). Suppressed
    // when `broadcastBadge` is set (#357 \u2194 #360 composition).
    let recipientLabel: string | undefined;
    if (
      !broadcastBadge &&
      role === 'maestro-out' &&
      m.to && m.to !== 'maestro' && m.to !== 'conductor' && m.to !== conductorPlayerId
    ) {
      recipientLabel = m.to;
    }
    // Pre-render the inline first-line prefix once so `estimateLines`
    // and the renderer don't each call `broadcastBadgeText` separately.
    const firstLinePrefix = makeFirstLinePrefix({ broadcastBadge, recipientLabel });
    return {
      sender: m.from,
      time: formatTime(m.timestamp),
      body: m.text,
      direction: m.direction,
      role,
      thirdParty,
      routeLabel,
      recipientLabel,
      broadcastBadge,
      ...(firstLinePrefix ? { firstLinePrefix } : {}),
    };
  });
}

export function ConversationStream({ conversation, sentMessages, contentHeight, overflowRef, conductorPlayerId }: ConversationStreamProps) {
  const { Text } = useInk();
  const termCols = process.stdout.columns || 80;
  const bodyWidth = Math.max(20, termCols - 4);

  const formatted: FormattedMsg[] = buildFormattedMessages(conversation, sentMessages, conductorPlayerId);

  // Work backwards from newest — include as many as fit in viewport
  let usedLines = 0;
  let startIdx = formatted.length;
  for (let i = formatted.length - 1; i >= 0; i--) {
    const needed = estimateLines(formatted[i], termCols);
    if (usedLines + needed > contentHeight - 1) break;
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

      // Word-wrap body. #360: when a recipientLabel prefix is rendered
      // inline on the first line, wrap the FIRST source line at a
      // narrower width to leave room. Continuation source lines (and
      // their wraps) use the full bodyWidth.
      const prefixLen = msg.firstLinePrefix?.length ?? 0;
      const firstLineWidth = Math.max(20, bodyWidth - prefixLen);
      const originalLines = msg.body.split('\n');
      const wrappedLines: string[] = [];
      for (let li = 0; li < originalLines.length; li++) {
        const w = li === 0 ? firstLineWidth : bodyWidth;
        wrappedLines.push(...wordWrap(originalLines[li], w));
      }
      const cap = maxLines(msg);
      const displayLines = wrappedLines.slice(0, cap);

      if (isOut) {
        // Outbound: inline — ♩ first line, then wrapped continuation lines (no timestamp).
        // The first-line prefix string is precomputed in
        // `buildFormattedMessages` (#357 broadcast badge / #360 directed
        // recipient — mutually exclusive). Color picks are local: badge
        // accent vs recipient dim.
        const prefixEl = msg.firstLinePrefix
          ? React.createElement(
              Text,
              { key: `pre-${i}`, backgroundColor: bg, color: msg.broadcastBadge ? THEME.accent : THEME.dim },
              msg.firstLinePrefix,
            )
          : null;
        for (let j = 0; j < displayLines.length; j++) {
          if (j > 0) children.push('\n');
          if (j === 0) {
            const firstText = displayLines[0];
            const pad = ' '.repeat(Math.max(0, termCols - 2 - 3 - prefixLen - firstText.length));
            children.push(React.createElement(React.Fragment, { key: `bl-${i}-0` },
              React.createElement(Text, { backgroundColor: bg, color: THEME.accent, bold: true }, ' \u2669 '),
              ...(prefixEl ? [prefixEl] : []),
              React.createElement(Text, { backgroundColor: bg, color: THEME.text }, firstText),
              React.createElement(Text, { backgroundColor: bg, color: THEME.dim }, pad),
            ));
          } else {
            const contLine = `${INDENT}${displayLines[j]}`;
            children.push(React.createElement(Text, { key: `bl-${i}-${j}`, backgroundColor: bg, color: THEME.text },
              contLine.padEnd(termCols - 2)));
          }
        }
        if (wrappedLines.length > cap) {
          const moreLine = `${INDENT}\u2026 (${wrappedLines.length - cap} more lines)`;
          children.push('\n');
          children.push(React.createElement(Text, { key: `mt-${i}`, backgroundColor: bg, color: THEME.dim },
            moreLine.padEnd(termCols - 2)));
        }
      } else {
        // Inbound: header line + body lines
        const headerLabel = msg.routeLabel || msg.sender;
        const headerColor = msg.thirdParty ? THEME.dim : THEME.accent;
        const bodyColor = msg.thirdParty ? THEME.textMuted : THEME.text;
        const headerPrefix = msg.thirdParty ? '   ' : ' \u2190 ';
        children.push(React.createElement(React.Fragment, { key: `hdr-${i}` },
          React.createElement(Text, { color: THEME.dim }, headerPrefix),
          React.createElement(Text, { color: headerColor }, headerLabel),
          React.createElement(Text, { color: THEME.dim }, `  ${msg.time}`),
        ));
        for (let j = 0; j < displayLines.length; j++) {
          children.push('\n');
          children.push(React.createElement(Text, { key: `bl-${i}-${j}`, color: bodyColor }, `${INDENT}${displayLines[j]}`));
        }
        if (wrappedLines.length > cap) {
          children.push('\n');
          children.push(React.createElement(Text, { key: `mt-${i}`, color: THEME.dim },
            `${INDENT}\u2026 (${wrappedLines.length - cap} more lines)`));
        }
      }
    }
  }

  // Explicit padding: fill remaining space so content = exactly contentHeight lines
  // usedLines = exact terminal lines for messages (from fitting loop)
  // 1 line reserved for footer margin
  const paddingLines = Math.max(0, contentHeight - usedLines - 1);
  if (paddingLines > 0) {
    children.push('\n'.repeat(paddingLines));
  }
  children.push('\n'); // exactly 1-line footer margin

  return React.createElement(Text, null, ...children);
}
