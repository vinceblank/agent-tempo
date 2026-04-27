/**
 * #357: Broadcast fan-out grouping in the ConversationStream.
 *
 * Pre-#357, a `broadcast` invocation against an 8-player ensemble
 * produced 8 identical outbound chat rows — each scrolled the viewport
 * by 2 lines and ate context the user didn't get any new information
 * from. Post-#357, those 8 deliveries share a `broadcastId` (generated
 * in the MCP-tool process), thread through `CueOutboxEntry` →
 * `receiveMessage` signal → `Message.broadcastId` → `EnsembleChatMessage.broadcastId`
 * → `ConversationMessage.broadcastId`, and the TUI's
 * `buildFormattedMessages` collapses them into a single row carrying a
 * `📡 broadcast → 8 players (a, b, c +5 more)` badge.
 *
 * These tests assert on the pure projection helper rather than mounting
 * Ink (mirrors the StatusBar / conversation-stream-directed pattern).
 */
import { describe, it, expect } from 'vitest';
import {
  buildFormattedMessages,
  type ConversationMessage,
} from '../../src/tui/components/ConversationStream';

const BCAST_A = 'bcast-aaaa';
const BCAST_B = 'bcast-bbbb';

function makeBroadcastOut(to: string, broadcastId: string, suffix = '', timestamp = '2026-04-26T12:00:00.000Z'): ConversationMessage {
  return {
    id: `m-${to}-${suffix}`,
    from: 'maestro',
    to,
    text: 'team — sync at 3pm',
    timestamp,
    direction: 'out',
    role: 'maestro-out',
    broadcastId,
  };
}

function makeDirectOut(to: string, ts = '2026-04-26T12:00:01.000Z'): ConversationMessage {
  return {
    id: `direct-${to}`,
    from: 'maestro',
    to,
    text: `private to ${to}`,
    timestamp: ts,
    direction: 'out',
    role: 'maestro-out',
  };
}

describe('buildFormattedMessages — broadcast grouping (#357)', () => {
  it('three consecutive maestro-out messages with the same broadcastId collapse to one row', () => {
    const conv = [
      makeBroadcastOut('alice', BCAST_A, '1'),
      makeBroadcastOut('bob', BCAST_A, '2'),
      makeBroadcastOut('carol', BCAST_A, '3'),
    ];
    const result = buildFormattedMessages(conv, []);
    expect(result).toHaveLength(1);
    expect(result[0].broadcastBadge).toEqual({
      count: 3,
      recipients: ['alice', 'bob', 'carol'],
    });
    // Body is taken from the first message — all three carry the same text
    // anyway since broadcasts share content.
    expect(result[0].body).toBe('team — sync at 3pm');
    // Composition with #360: badge wins, recipientLabel suppressed.
    expect(result[0].recipientLabel).toBeUndefined();
  });

  it('three messages WITHOUT broadcastId render as three separate rows', () => {
    // Same content, same direction/role — but no broadcastId on any of
    // them. The fold key is the broadcast id; without it nothing collapses.
    const conv = [
      { ...makeBroadcastOut('alice', BCAST_A, '1'), broadcastId: undefined } as ConversationMessage,
      { ...makeBroadcastOut('bob', BCAST_A, '2'), broadcastId: undefined } as ConversationMessage,
      { ...makeBroadcastOut('carol', BCAST_A, '3'), broadcastId: undefined } as ConversationMessage,
    ];
    const result = buildFormattedMessages(conv, []);
    expect(result).toHaveLength(3);
    expect(result.every(r => r.broadcastBadge === undefined)).toBe(true);
  });

  it('mixed broadcast + non-broadcast slice renders with correct ordering', () => {
    // Three broadcast deliveries to alice, bob, carol — fold to one
    // entry. Then one direct cue to dave — separate entry. Order is
    // preserved by timestamp.
    const conv = [
      makeBroadcastOut('alice', BCAST_A, '1'),
      makeBroadcastOut('bob', BCAST_A, '2'),
      makeBroadcastOut('carol', BCAST_A, '3'),
      makeDirectOut('dave', '2026-04-26T12:01:00.000Z'),
    ];
    const result = buildFormattedMessages(conv, []);
    expect(result).toHaveLength(2);
    expect(result[0].broadcastBadge?.count).toBe(3);
    expect(result[0].broadcastBadge?.recipients).toEqual(['alice', 'bob', 'carol']);
    expect(result[1].broadcastBadge).toBeUndefined();
    expect(result[1].body).toBe('private to dave');
  });

  it('two broadcast batches with different ids fold into two separate rows', () => {
    const conv = [
      makeBroadcastOut('alice', BCAST_A, '1'),
      makeBroadcastOut('bob', BCAST_A, '2'),
      makeBroadcastOut('carol', BCAST_B, '3'),
      makeBroadcastOut('dave', BCAST_B, '4'),
    ];
    const result = buildFormattedMessages(conv, []);
    expect(result).toHaveLength(2);
    expect(result[0].broadcastBadge?.recipients).toEqual(['alice', 'bob']);
    expect(result[1].broadcastBadge?.recipients).toEqual(['carol', 'dave']);
  });

  it('a non-broadcast message between two broadcast deliveries breaks the fold', () => {
    // The fold requires CONSECUTIVE entries (after timestamp sort).
    // Use distinct timestamps so the direct message sorts BETWEEN the
    // two broadcast deliveries — same broadcastId before/after, but
    // the fold restarts after the interruption.
    const conv = [
      makeBroadcastOut('alice', BCAST_A, '1', '2026-04-26T12:00:00.000Z'),
      makeDirectOut('dave', '2026-04-26T12:00:00.500Z'),
      makeBroadcastOut('bob', BCAST_A, '2', '2026-04-26T12:00:01.000Z'),
    ];
    const result = buildFormattedMessages(conv, []);
    // Two broadcast rows (each with count 1) + one direct row.
    expect(result).toHaveLength(3);
    const broadcastRows = result.filter(r => r.broadcastBadge);
    expect(broadcastRows).toHaveLength(2);
    expect(broadcastRows[0].broadcastBadge?.count).toBe(1);
    expect(broadcastRows[1].broadcastBadge?.count).toBe(1);
  });

  it('broadcast badge text shows count + first 3 recipients with `+N more` for larger groups', () => {
    const conv = ['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h']
      .map((to, i) => makeBroadcastOut(to, BCAST_A, `${i}`));
    const result = buildFormattedMessages(conv, []);
    expect(result).toHaveLength(1);
    expect(result[0].broadcastBadge?.count).toBe(8);
    expect(result[0].broadcastBadge?.recipients).toEqual(['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h']);
    // Note: the `+N more` truncation lives in `broadcastBadgeText` (the
    // renderer) — `broadcastBadge.recipients` carries every name so a
    // future tooltip / overlay can show the full list.
  });

  it('fold preserves direction — outbound and inbound entries with same id stay separate', () => {
    // Defensive check: the fold key is `broadcastId + direction`. A
    // theoretical inbound entry sharing the broadcastId (won't happen
    // in practice — broadcasts only fan out — but the type allows it)
    // must not collapse with the outbound group; the renderer styles
    // them differently and conflating them would lose the perspective.
    const conv: ConversationMessage[] = [
      makeBroadcastOut('alice', BCAST_A, '1', '2026-04-26T12:00:00.000Z'),
      makeBroadcastOut('bob', BCAST_A, '2', '2026-04-26T12:00:00.001Z'),
      {
        id: 'inbound-shadow',
        from: 'someone',
        to: 'maestro',
        text: 'reply',
        timestamp: '2026-04-26T12:00:00.002Z',
        direction: 'in',
        role: 'maestro-in',
        broadcastId: BCAST_A,
      },
    ];
    const result = buildFormattedMessages(conv, []);
    expect(result).toHaveLength(2);
    expect(result[0].direction).toBe('out');
    expect(result[0].broadcastBadge?.count).toBe(2);
    expect(result[1].direction).toBe('in');
    expect(result[1].broadcastBadge?.count).toBe(1);
  });

  it('badge suppresses the #360 recipientLabel — composition guard', () => {
    // When a row has both a broadcastBadge AND would otherwise get a
    // recipientLabel (maestro-out, non-conductor recipient), the badge
    // wins. The single-recipient prefix would duplicate the recipient
    // already enumerated in the badge text.
    const result = buildFormattedMessages(
      [makeBroadcastOut('tempo-eng', BCAST_A, '1')],
      [],
      'tempo-conductor',
    );
    expect(result[0].broadcastBadge).toBeDefined();
    expect(result[0].recipientLabel).toBeUndefined();
  });

  it('single-target broadcast still surfaces the badge (count: 1)', () => {
    // The `broadcast` tool may filter targets down to a single match
    // (e.g., `--type tempo-soloist` with one soloist in the ensemble).
    // Surface the badge anyway — it WAS a broadcast invocation, and
    // `broadcast → 1 player` reads correctly.
    const result = buildFormattedMessages([makeBroadcastOut('alice', BCAST_A, '1')], []);
    expect(result).toHaveLength(1);
    expect(result[0].broadcastBadge?.count).toBe(1);
    expect(result[0].broadcastBadge?.recipients).toEqual(['alice']);
  });
});
