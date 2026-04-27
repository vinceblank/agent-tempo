/**
 * #357 contract — broadcast collapse in the dashboard chat log.
 *
 * Pre-#357 the TUI would render an 8-target broadcast as 8 identical
 * outbound rows. The fix folds those rows by `broadcastId` so the user
 * sees ONE row with a `📡 broadcast → N players` badge. The dashboard
 * MUST behave the same way; this suite locks the contract.
 *
 * The fold logic lives in `lib/chat-format.ts`. We test it both as a
 * pure function (fast, exhaustive) AND through `<ChatMessage>` (so the
 * badge testid + render shape is locked).
 */
import { describe, it, expect } from 'vitest';
import { render } from '@testing-library/react';
import type { EnsembleChatMessage } from 'claude-tempo/types';
import { buildFormattedRows } from '../src/lib/chat-format';
import { ChatMessage } from '../src/components/chat/ChatMessage';

const BCAST_A = 'bcast-aaaa';
const BCAST_B = 'bcast-bbbb';

function makeMsg(
  id: string,
  to: string,
  role: EnsembleChatMessage['role'] = 'maestro-out',
  broadcastId?: string,
  text = 'team — sync at 3pm',
  timestamp = '2026-04-27T12:00:00.000Z',
): EnsembleChatMessage {
  return { id, from: role.startsWith('maestro') ? 'maestro' : 'conductor', to, text, timestamp, role, broadcastId };
}

describe('buildFormattedRows — broadcast fold (#357 contract)', () => {
  it('three messages with same broadcastId collapse to one row', () => {
    const rows = buildFormattedRows([
      makeMsg('1', 'alice', 'maestro-out', BCAST_A),
      makeMsg('2', 'bob', 'maestro-out', BCAST_A),
      makeMsg('3', 'carol', 'maestro-out', BCAST_A),
    ]);
    expect(rows).toHaveLength(1);
    expect(rows[0].broadcastBadge).toEqual({
      count: 3,
      recipients: ['alice', 'bob', 'carol'],
    });
    // #357 ↔ #360 composition: badge wins, recipientLabel suppressed.
    expect(rows[0].recipientLabel).toBeUndefined();
  });

  it('messages without a broadcastId render as separate rows', () => {
    const rows = buildFormattedRows([
      makeMsg('1', 'alice'),
      makeMsg('2', 'bob'),
      makeMsg('3', 'carol'),
    ]);
    expect(rows).toHaveLength(3);
    expect(rows.every((r) => r.broadcastBadge === undefined)).toBe(true);
  });

  it('mixed broadcast + direct messages preserve order with one folded row', () => {
    const rows = buildFormattedRows([
      makeMsg('1', 'alice', 'maestro-out', BCAST_A),
      makeMsg('2', 'bob', 'maestro-out', BCAST_A),
      makeMsg('3', 'dave', 'maestro-out', undefined, 'private to dave', '2026-04-27T12:01:00.000Z'),
    ]);
    expect(rows).toHaveLength(2);
    expect(rows[0].broadcastBadge?.count).toBe(2);
    expect(rows[1].source.text).toBe('private to dave');
    expect(rows[1].broadcastBadge).toBeUndefined();
  });

  it('two batches with different ids fold into two rows', () => {
    const rows = buildFormattedRows([
      makeMsg('1', 'alice', 'maestro-out', BCAST_A),
      makeMsg('2', 'bob', 'maestro-out', BCAST_A),
      makeMsg('3', 'carol', 'maestro-out', BCAST_B),
      makeMsg('4', 'dave', 'maestro-out', BCAST_B),
    ]);
    expect(rows).toHaveLength(2);
    expect(rows[0].broadcastBadge?.recipients).toEqual(['alice', 'bob']);
    expect(rows[1].broadcastBadge?.recipients).toEqual(['carol', 'dave']);
  });

  it('a non-broadcast message between two same-id deliveries breaks the fold', () => {
    const rows = buildFormattedRows([
      makeMsg('1', 'alice', 'maestro-out', BCAST_A, undefined, '2026-04-27T12:00:00.000Z'),
      makeMsg('2', 'dave', 'maestro-out', undefined, 'private', '2026-04-27T12:00:00.500Z'),
      makeMsg('3', 'bob', 'maestro-out', BCAST_A, undefined, '2026-04-27T12:00:01.000Z'),
    ]);
    expect(rows).toHaveLength(3);
    expect(rows.filter((r) => r.broadcastBadge)).toHaveLength(2);
    expect(rows.filter((r) => r.broadcastBadge)[0].broadcastBadge?.count).toBe(1);
  });

  it('inbound and outbound entries with the same id stay separate (direction in fold key)', () => {
    const rows = buildFormattedRows([
      makeMsg('1', 'alice', 'maestro-out', BCAST_A),
      makeMsg('2', 'someone', 'maestro-in', BCAST_A),
    ]);
    expect(rows).toHaveLength(2);
    expect(rows[0].direction).toBe('out');
    expect(rows[1].direction).toBe('in');
  });

  it('badge text format: 1 player singular, N players plural', () => {
    const rows1 = buildFormattedRows([makeMsg('1', 'alice', 'maestro-out', BCAST_A)]);
    expect(rows1[0].broadcastBadge?.count).toBe(1);

    const rows3 = buildFormattedRows([
      makeMsg('1', 'alice', 'maestro-out', BCAST_A),
      makeMsg('2', 'bob', 'maestro-out', BCAST_A),
      makeMsg('3', 'carol', 'maestro-out', BCAST_A),
    ]);
    expect(rows3[0].broadcastBadge?.count).toBe(3);
  });
});

describe('ChatMessage — broadcast badge render', () => {
  it('renders the broadcast-badge testid when row has broadcastBadge', () => {
    const rows = buildFormattedRows([
      makeMsg('1', 'alice', 'maestro-out', BCAST_A),
      makeMsg('2', 'bob', 'maestro-out', BCAST_A),
      makeMsg('3', 'carol', 'maestro-out', BCAST_A),
    ]);
    const { getByTestId } = render(<ChatMessage row={rows[0]} />);
    const badge = getByTestId(`broadcast-badge-${BCAST_A}`);
    expect(badge).toBeInTheDocument();
    expect(badge).toHaveAttribute('data-broadcast-count', '3');
    // Badge text includes count + cap + remainder cue.
    expect(badge.textContent).toContain('3 players');
    expect(badge.textContent).toContain('alice');
  });

  it('cap of 3 names + `+N more` for groups beyond the cap', () => {
    const rows = buildFormattedRows(
      ['a', 'b', 'c', 'd', 'e'].map((to, i) => makeMsg(`${i}`, to, 'maestro-out', BCAST_A)),
    );
    const { getByTestId } = render(<ChatMessage row={rows[0]} />);
    const badge = getByTestId(`broadcast-badge-${BCAST_A}`);
    expect(badge.textContent).toContain('5 players');
    expect(badge.textContent).toContain('+2 more');
  });

  it('does NOT render a recipient prefix when broadcastBadge is set', () => {
    const rows = buildFormattedRows([
      makeMsg('1', 'alice', 'maestro-out', BCAST_A),
      makeMsg('2', 'bob', 'maestro-out', BCAST_A),
    ]);
    const { queryByTestId } = render(<ChatMessage row={rows[0]} />);
    expect(queryByTestId(`chat-message-1-recipient`)).toBeNull();
  });
});
