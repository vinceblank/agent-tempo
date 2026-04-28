/**
 * #360 contract — directed-message recipient prefix.
 *
 * The TUI's `→ @<player>` prefix appears on `maestro-out` rows whose
 * recipient is neither the active conductor nor the legacy
 * `'conductor'` literal nor the `'maestro'` self-route. The dashboard
 * MUST mirror that suppression rule so the chat surface reads the same
 * way across surfaces.
 */
import { describe, it, expect } from 'vitest';
import { render } from '@testing-library/react';
import type { EnsembleChatMessage } from 'claude-tempo/types';
import type { PlayerSummaryV1 } from 'claude-tempo/http/event-types';
import { buildFormattedRows, type FormattedChatRow } from '../src/lib/chat-format';
import { rowToFeedMessage } from '../src/components/chat/ChatLog';
import { FeedMessage } from '../src/components/chat/FeedMessage';

/** Render a `FormattedChatRow` through the live PR-C2 adapter +
 * FeedMessage primitive. */
function renderRow(row: FormattedChatRow) {
  const players = new Map<string, PlayerSummaryV1>();
  return render(<FeedMessage m={rowToFeedMessage(row, players)} />);
}

function makeOut(to: string, role: EnsembleChatMessage['role'] = 'maestro-out'): EnsembleChatMessage {
  return {
    id: `m-${to}`,
    from: 'maestro',
    to,
    text: `hi ${to}`,
    timestamp: '2026-04-27T12:00:00.000Z',
    role,
  };
}

describe('buildFormattedRows — recipientLabel (#360 contract)', () => {
  it('maestro-out → non-conductor recipient sets recipientLabel', () => {
    const rows = buildFormattedRows([makeOut('tempo-eng')], 'tempo-conductor');
    expect(rows[0].recipientLabel).toBe('tempo-eng');
  });

  it('maestro-out → active conductor suppresses recipientLabel', () => {
    const rows = buildFormattedRows([makeOut('tempo-conductor')], 'tempo-conductor');
    expect(rows[0].recipientLabel).toBeUndefined();
  });

  it('maestro-out → legacy "conductor" literal suppresses recipientLabel', () => {
    const rows = buildFormattedRows([makeOut('conductor')], 'tempo-conductor');
    expect(rows[0].recipientLabel).toBeUndefined();
  });

  it('maestro-out → "maestro" self-route suppresses recipientLabel', () => {
    const rows = buildFormattedRows([makeOut('maestro')], 'tempo-conductor');
    expect(rows[0].recipientLabel).toBeUndefined();
  });

  it('maestro-in (received from a player) never gets a recipientLabel', () => {
    const inbound: EnsembleChatMessage = {
      id: 'in-1',
      from: 'tempo-eng',
      to: 'maestro',
      text: 'reply',
      timestamp: '2026-04-27T12:00:00.000Z',
      role: 'maestro-in',
    };
    const rows = buildFormattedRows([inbound], 'tempo-conductor');
    expect(rows[0].recipientLabel).toBeUndefined();
  });

  it('conductor-out has a routeLabel handled by ChatMessage, not a recipientLabel', () => {
    const rows = buildFormattedRows([makeOut('tempo-eng', 'conductor-out')], 'tempo-conductor');
    expect(rows[0].recipientLabel).toBeUndefined();
  });

  it('no conductor in ensemble — every directed maestro-out gets recipientLabel', () => {
    // Ensembles between `/destroy conductor` and `/recruit conductor`
    // have no `conductorPlayerId`. The directed prefix is the only
    // routing cue the user has, so surface it on every row.
    const rows = buildFormattedRows([makeOut('tempo-eng')], undefined);
    expect(rows[0].recipientLabel).toBe('tempo-eng');
  });
});

describe('ChatLog adapter + FeedMessage — recipient prefix render', () => {
  it('renders `→ @<to>` for directed maestro-out', () => {
    const rows = buildFormattedRows([makeOut('tempo-eng')], 'tempo-conductor');
    const { getByTestId } = renderRow(rows[0]);
    const prefix = getByTestId(`chat-message-m-tempo-eng-recipient`);
    expect(prefix.textContent).toContain('→ @tempo-eng');
  });

  it('does NOT render the prefix for conductor-bound maestro-out', () => {
    const rows = buildFormattedRows([makeOut('tempo-conductor')], 'tempo-conductor');
    const { queryByTestId } = renderRow(rows[0]);
    expect(queryByTestId(`chat-message-m-tempo-conductor-recipient`)).toBeNull();
  });
});
