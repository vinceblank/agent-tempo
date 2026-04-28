/**
 * ChatMessage — single row in the dashboard's chat log. Mirrors the TUI's
 * `ConversationStream` row contract from beta.3:
 *
 * - **Outbound** (direction === 'out'): right-aligned bubble with
 *   `var(--bg-chat-out)` background, ♩ glyph, and either a broadcast
 *   badge (#357) or a `→ @<recipient>` prefix (#360).
 * - **Inbound** (direction === 'in'): left-aligned with sender header,
 *   timestamp, and dim text body.
 *
 * Stable testids:
 *   - `data-testid="chat-message-${msgId}"` on the row
 *   - `data-testid="broadcast-badge-${broadcastId}"` when the row is a
 *     folded broadcast group
 */
import type { FormattedChatRow } from '../../lib/chat-format';
import { broadcastBadgeText } from '../../lib/chat-format';
import { formatHHMM } from '../../lib/time-format';

interface ChatMessageProps {
  row: FormattedChatRow;
}

export function ChatMessage({ row }: ChatMessageProps) {
  const { source: msg, direction, recipientLabel, broadcastBadge } = row;
  const isOut = direction === 'out';
  const thirdParty = msg.role === 'conductor-out' || msg.role === 'conductor-in';

  return (
    <article
      data-testid={`chat-message-${msg.id}`}
      data-direction={direction}
      data-role={msg.role}
      style={{
        display: 'flex',
        flexDirection: 'column',
        gap: 2,
        padding: '6px 0',
        opacity: thirdParty ? 0.78 : 1,
      }}
    >
      {/* Sender / route header — only for inbound rows */}
      {!isOut && (
        <header
          style={{
            display: 'flex',
            alignItems: 'baseline',
            gap: 8,
            fontSize: 'var(--density-fs-sm)',
          }}
        >
          <span
            style={{
              color: thirdParty ? 'var(--dim)' : 'var(--accent)',
              fontWeight: 500,
            }}
          >
            {thirdParty ? `${msg.from} → ${msg.to}` : msg.from}
          </span>
          <span className="dim mono">{formatHHMM(msg.timestamp)}</span>
        </header>
      )}

      {/* Outbound first-line prefix (badge wins over recipient label) */}
      <div
        style={{
          display: 'flex',
          flexWrap: 'wrap',
          alignItems: 'baseline',
          gap: 6,
          padding: isOut ? '6px 10px' : '0',
          background: isOut ? 'var(--bg-chat-out)' : 'transparent',
          borderRadius: isOut ? 8 : 0,
          alignSelf: isOut ? 'flex-end' : 'stretch',
          maxWidth: isOut ? '85%' : '100%',
        }}
      >
        {isOut && (
          <span
            aria-hidden="true"
            data-testid-exempt="decorative-glyph"
            style={{ color: 'var(--accent)', fontWeight: 600 }}
          >
            ♩
          </span>
        )}
        {broadcastBadge && (
          <span
            data-testid={`broadcast-badge-${msg.broadcastId}`}
            data-broadcast-count={broadcastBadge.count}
            style={{
              color: 'var(--accent)',
              fontFamily: 'var(--ff-ui)',
              fontSize: 'var(--density-fs-sm)',
            }}
          >
            {broadcastBadgeText(broadcastBadge)}
          </span>
        )}
        {!broadcastBadge && recipientLabel && (
          <span
            data-testid={`chat-message-${msg.id}-recipient`}
            className="dim"
            style={{ fontSize: 'var(--density-fs-sm)' }}
          >
            → @{recipientLabel}
          </span>
        )}
        <span
          data-testid={`chat-message-${msg.id}-body`}
          style={{
            color: thirdParty ? 'var(--text-2)' : 'var(--text)',
            whiteSpace: 'pre-wrap',
            overflowWrap: 'anywhere',
          }}
        >
          {msg.text}
        </span>
      </div>
    </article>
  );
}
