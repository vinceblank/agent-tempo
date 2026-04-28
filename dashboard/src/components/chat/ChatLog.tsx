/**
 * ChatLog — scrollable list of chat messages for the active ensemble.
 * PR-C2 of #389: rebuilt to render `<FeedMessage>` (PR-A2) via an
 * adapter that maps `FormattedChatRow` → `FeedMessageData`.
 *
 * Auto-scrolls to bottom on new messages. Logs `chat.rendered` after
 * each render pass so the conductor's autonomous validator can watch
 * for SSE-driven re-render churn via `mcp__claude-in-chrome__read_console_messages`.
 *
 * Compressed-stream UX (#3 risk): when the daemon emits
 * `chat.compressed`, the SSE projection in `lib/sse.ts` empties the
 * messages array and sets `hasMore: true`. We surface that as a banner
 * explaining the gap (the `getEnsembleChat` re-fetch lands in PR-7).
 *
 * Adapter notes:
 *   - Rows with `from === MAESTRO_PLAYER_ID` map to `kind: 'out'`
 *     (right-aligned bubble; FeedMessage shows MaestroMark on outbound
 *     per audit C2).
 *   - Rows with `to === MAESTRO_PLAYER_ID` map to `kind: 'in'`
 *     (left-aligned with PlayerAvatar + `← maestro` arrow).
 *   - Rows where neither end is the maestro — conductor↔player
 *     side-chatter, player↔player routes — map to `kind: 'route'`
 *     and pick up `.msg.route` styling (italic body, indented rail).
 *     The conductor is just another player from the dashboard's POV
 *     (#446).
 *   - Broadcast badge (`row.broadcastBadge`) and directed-recipient
 *     prefix (`row.recipientLabel`) prepend into FeedMessage's `body`
 *     slot as inline shim spans, preserving the legacy
 *     `broadcast-badge-${id}` and `chat-message-${id}-recipient`
 *     testids that #357 / #360 contract tests rely on.
 *   - Sender's player type / phase / conductor flag come from a
 *     `playersByName` lookup the caller passes in. When unknown, the
 *     FeedMessage renders without a phase dot or hue-tint and the
 *     PlayerAvatar falls back to the deterministic glyph palette.
 */
import { useEffect, useMemo, useRef, type ReactNode } from 'react';
import type { EnsembleChatMessage } from 'claude-tempo/types';
import type { PlayerSummaryV1 } from 'claude-tempo/http/event-types';
import { logEvent } from '../../lib/log';
import {
  buildFormattedRows,
  broadcastBadgeText,
  MAESTRO_PLAYER_ID,
  type FormattedChatRow,
} from '../../lib/chat-format';
import { formatHHMM } from '../../lib/time-format';
import { FeedMessage, type FeedMessageData, type FeedMessageKind } from './FeedMessage';

interface ChatLogProps {
  ensemble: string;
  messages: EnsembleChatMessage[];
  conductorPlayerId?: string;
  /** Sender lookup. Drives type-hue + phase-dot + conductor star on
   * inbound rows. The Workspace passes its `players` array as this
   * map; absent senders gracefully degrade to default colouring. */
  players?: PlayerSummaryV1[];
  /** True when chat.compressed dropped the local window; shows a banner. */
  hasCompressedGap?: boolean;
}

export function ChatLog({
  ensemble,
  messages,
  conductorPlayerId,
  players,
  hasCompressedGap = false,
}: ChatLogProps) {
  const scrollRef = useRef<HTMLDivElement | null>(null);
  // Index players by playerId so the adapter can look up type/phase
  // without a linear scan per row.
  const playerIndex = useMemo(() => {
    const m = new Map<string, PlayerSummaryV1>();
    for (const p of players ?? []) m.set(p.playerId, p);
    return m;
  }, [players]);

  const rows = useMemo(
    () => buildFormattedRows(messages, conductorPlayerId),
    [messages, conductorPlayerId],
  );
  const feedItems = useMemo(
    () => rows.map((row) => rowToFeedMessage(row, playerIndex)),
    [rows, playerIndex],
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
      scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ensemble, messages.length, hasCompressedGap]);

  if (messages.length === 0 && !hasCompressedGap) {
    return (
      <div
        data-testid={`chat-log-${ensemble}`}
        data-empty="true"
        className="dim chat-log"
        style={{
          // Match the .panel.chat content box: empty state should still
          // sit inside the chat panel cleanly. The .chat-log class gives
          // the right padding/density.
          background: 'var(--bg-1)',
          border: '1px dashed var(--rule)',
          borderRadius: 8,
          minHeight: 0,
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
      className="chat-log"
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
      {feedItems.map((m) => (
        <FeedMessage key={m.id} m={m} />
      ))}
    </div>
  );
}

/**
 * Map a single `FormattedChatRow` to `FeedMessageData`. Public so the
 * #357 / #360 contract tests can render against `<FeedMessage>` via
 * the same adapter the live ChatLog uses.
 *
 * **Variant rule (#446)**: maestro on either end → primary (`out` if
 * sending, `in` if receiving). Otherwise → `route` (overheard
 * side-chatter; dimmed + italic per `.msg.route` in `components.css`).
 * The conductor is just another player from the dashboard's POV — its
 * chat with other players is overheard, not primary. The previous
 * role-based classifier was direction-asymmetric: outbound conductor
 * messages were dimmed but inbound `conductor-in` rows fell through
 * to primary.
 */
export function rowToFeedMessage(
  row: FormattedChatRow,
  playerIndex: Map<string, PlayerSummaryV1>,
): FeedMessageData {
  const m = row.source;
  const sender = m.from ? playerIndex.get(m.from) : undefined;
  let kind: FeedMessageKind;
  if (m.from === MAESTRO_PLAYER_ID) kind = 'out';
  else if (m.to === MAESTRO_PLAYER_ID) kind = 'in';
  else kind = 'route';

  return {
    id: m.id,
    kind,
    from: m.from,
    to: m.to,
    time: formatHHMM(m.timestamp),
    body: renderBody(row),
    fromType: sender?.playerType,
    fromIsConductor: sender?.isConductor,
    fromPhase: sender?.phase,
  };
}

/** Body content with optional broadcast badge + recipient prefix shims.
 * Both shim spans carry their legacy testids (`broadcast-badge-${id}` and
 * `chat-message-${id}-recipient`) so the #357 / #360 contract tests
 * remain green without rewriting their assertions. */
function renderBody(row: FormattedChatRow): ReactNode {
  const m = row.source;
  return (
    <>
      {row.broadcastBadge && (
        <span
          data-testid={`broadcast-badge-${m.broadcastId}`}
          data-broadcast-count={row.broadcastBadge.count}
          className="dim"
          style={{ marginRight: 6 }}
        >
          {broadcastBadgeText(row.broadcastBadge)}
        </span>
      )}
      {row.recipientLabel && !row.broadcastBadge && (
        <span
          data-testid={`chat-message-${m.id}-recipient`}
          className="dim"
          style={{ marginRight: 6 }}
        >
          → @{row.recipientLabel}
        </span>
      )}
      <span style={{ whiteSpace: 'pre-wrap', overflowWrap: 'anywhere' }}>
        {m.text}
      </span>
    </>
  );
}
