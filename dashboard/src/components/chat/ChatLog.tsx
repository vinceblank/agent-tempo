/**
 * ChatLog — scrollable list of chat messages for the active ensemble.
 *
 * Auto-scrolls to bottom on new messages so the user always sees the
 * latest conversation. Logs `chat.rendered` after each render pass so
 * the conductor's autonomous validator can watch for SSE-driven
 * re-render churn via `mcp__claude-in-chrome__read_console_messages`.
 *
 * Compressed-stream UX (#3 risk): when the daemon emits
 * `chat.compressed`, the SSE projection in `lib/sse.ts` empties the
 * messages array and sets `hasMore: true`. We surface that as a
 * banner explaining the gap and offering a placeholder reload (the
 * actual `getEnsembleChat` re-fetch wires up in PR-7).
 */
import { useEffect, useMemo, useRef } from 'react';
import type { EnsembleChatMessage } from 'claude-tempo/types';
import { logEvent } from '../../lib/log';
import { buildFormattedRows } from '../../lib/chat-format';
import { ChatMessage } from './ChatMessage';

interface ChatLogProps {
  ensemble: string;
  messages: EnsembleChatMessage[];
  conductorPlayerId?: string;
  /** True when chat.compressed dropped the local window; surfaces the banner. */
  hasCompressedGap?: boolean;
}

export function ChatLog({
  ensemble,
  messages,
  conductorPlayerId,
  hasCompressedGap = false,
}: ChatLogProps) {
  const scrollRef = useRef<HTMLDivElement | null>(null);
  // Memoize the projection — it walks the full chat slice (capped at
  // 200 by the SSE projection) and folds broadcast groups, so re-running
  // on every Workspace render burned cycles unnecessarily. SSE events
  // produce a new `messages` reference each tick, which is the only
  // case we need to re-derive on.
  const rows = useMemo(
    () => buildFormattedRows(messages, conductorPlayerId),
    [messages, conductorPlayerId],
  );

  useEffect(() => {
    const broadcasts = rows.filter((r) => r.broadcastBadge).length;
    logEvent('chat.rendered', {
      ensemble,
      count: rows.length,
      messages: messages.length,
      broadcasts,
    });
    if (scrollRef.current) {
      // Snap to bottom — chronological order means latest is the last row.
      scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
    }
    // `messages.length` is the relevant trigger because SSE feeds the
    // chat append-only — no in-place edits in PR-5. The same-length
    // sentinel keeps the conductor's `[claude-tempo:dashboard] chat.rendered`
    // log clean (one line per real append) instead of one line per
    // identity-only re-render.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ensemble, messages.length, hasCompressedGap]);

  if (messages.length === 0 && !hasCompressedGap) {
    return (
      <div
        data-testid={`chat-log-${ensemble}`}
        data-empty="true"
        className="dim"
        style={{
          padding: 'var(--density-pad)',
          background: 'var(--bg-1)',
          border: '1px dashed var(--rule)',
          borderRadius: 8,
        }}
      >
        No messages yet. The conductor's first dispatch will land here.
      </div>
    );
  }

  return (
    <div
      ref={scrollRef}
      data-testid={`chat-log-${ensemble}`}
      style={{
        flex: 1,
        minHeight: 0,
        overflowY: 'auto',
        padding: 'var(--density-pad)',
        display: 'flex',
        flexDirection: 'column',
        gap: 4,
      }}
    >
      {hasCompressedGap && (
        <div
          data-testid={`chat-log-${ensemble}-compressed-gap`}
          role="status"
          style={{
            padding: '8px 12px',
            background: 'var(--bg-2)',
            border: '1px solid var(--rule)',
            borderRadius: 6,
            color: 'var(--dim)',
            fontSize: 'var(--density-fs-sm)',
            marginBottom: 6,
          }}
        >
          …earlier messages were dropped to keep up with chat volume.
          Reload to fetch them (full reload UX lands in PR-7 of #340).
        </div>
      )}
      {rows.map((row) => (
        <ChatMessage key={row.source.id} row={row} />
      ))}
    </div>
  );
}
