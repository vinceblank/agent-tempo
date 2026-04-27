/**
 * #360: Directed-message recipient prefix on the ConversationStream.
 *
 * Pre-#360, an outbound maestro-out row showed only ` ♩ <body>` — the
 * user could see what they typed but not who they typed it to. This
 * was confusing in busy ensembles where you might `/recall` after
 * sending half a dozen `@<player> ...` messages and not remember which
 * went to whom.
 *
 * Post-#360, when the recipient is NOT the active conductor (the
 * implicit default for bare-text input), the row reads:
 *
 *     ♩ → @<recipient>  <body>
 *
 * The prefix is suppressed when `to` is the conductor (badge would
 * dominate every line), the legacy `'conductor'` literal, or the user's
 * own maestro session.
 *
 * These tests assert on `buildFormattedMessages` (the pure projection
 * helper) rather than mounting Ink, mirroring the StatusBar test
 * pattern.
 */
import { describe, it, expect } from 'vitest';
import {
  buildFormattedMessages,
  type ConversationMessage,
  type SentMessage,
} from '../../src/tui/components/ConversationStream';

function makeOut(to: string, role: ConversationMessage['role'] = 'maestro-out'): ConversationMessage {
  return {
    id: `m-${to}`,
    from: 'maestro',
    to,
    text: `hi ${to}`,
    timestamp: '2026-04-26T12:00:00.000Z',
    direction: 'out',
    role,
  };
}

function makeIn(from: string, to: string, role: ConversationMessage['role'] = 'maestro-in'): ConversationMessage {
  return {
    id: `m-${from}-${to}`,
    from,
    to,
    text: `hello from ${from}`,
    timestamp: '2026-04-26T12:00:00.000Z',
    direction: 'in',
    role,
  };
}

describe('buildFormattedMessages — recipient prefix (#360)', () => {
  it('maestro-out to a non-conductor player → recipientLabel set', () => {
    const result = buildFormattedMessages([makeOut('tempo-eng')], [], 'tempo-conductor');
    expect(result).toHaveLength(1);
    expect(result[0].recipientLabel).toBe('tempo-eng');
  });

  it('maestro-out to the active conductor → recipientLabel suppressed', () => {
    // The conductor is the implicit default for bare-text input.
    // Decorating every conductor-bound row with `→ @<conductor>` would
    // dominate the chat view; suppress the prefix here.
    const result = buildFormattedMessages([makeOut('tempo-conductor')], [], 'tempo-conductor');
    expect(result).toHaveLength(1);
    expect(result[0].recipientLabel).toBeUndefined();
  });

  it('maestro-out to the legacy `conductor` literal → recipientLabel suppressed', () => {
    // Pre-#358 the conductor was sometimes addressed by the literal
    // string 'conductor' rather than its actual playerId. Old chat
    // history may carry that addressee; suppress the prefix.
    const result = buildFormattedMessages([makeOut('conductor')], [], 'tempo-conductor');
    expect(result[0].recipientLabel).toBeUndefined();
  });

  it('maestro-out to `maestro` → recipientLabel suppressed (self-routing)', () => {
    // Outbound to the maestro session is a no-op routing target — the
    // maestro is the user's own session — but the field can appear in
    // legacy entries. Don't decorate it.
    const result = buildFormattedMessages([makeOut('maestro')], [], 'tempo-conductor');
    expect(result[0].recipientLabel).toBeUndefined();
  });

  it('maestro-in → no recipientLabel regardless of `to`', () => {
    // Inbound rows are always TO the maestro by construction. The
    // prefix is for outbound directed messages; never show on inbound.
    const result = buildFormattedMessages([makeIn('tempo-eng', 'maestro')], [], 'tempo-conductor');
    expect(result[0].recipientLabel).toBeUndefined();
  });

  it('conductor-out → no recipientLabel (rendered via routeLabel instead)', () => {
    // Conductor-mediated traffic uses `routeLabel` ("from → to") on
    // the inbound header line; it does not get the recipient prefix.
    const result = buildFormattedMessages([makeOut('tempo-eng', 'conductor-out')], [], 'tempo-conductor');
    expect(result[0].recipientLabel).toBeUndefined();
    expect(result[0].routeLabel).toBe('maestro → tempo-eng');
  });

  it('no conductorPlayerId in the ensemble → recipientLabel set for every directed maestro-out', () => {
    // Edge case: ensemble with no conductor (post-`/destroy conductor`,
    // pre-recruit). The bare-text routing path falls back to the legacy
    // `'conductor'` literal in that scenario, so user-typed `@<player>`
    // is the only way directed messages get sent. Surface the prefix on
    // every such entry to make routing visible.
    const result = buildFormattedMessages([makeOut('tempo-eng')], [], undefined);
    expect(result[0].recipientLabel).toBe('tempo-eng');
  });

  it('local-echo sent message → recipientLabel derived from the sent target', () => {
    // Local-echo paths inject `from: 'you', to: <m.to>, direction: 'out'`
    // synthesized via the merge step. The projection should treat the
    // synthesized row identically to a server entry and set the prefix
    // when `to` is non-conductor.
    const sent: SentMessage[] = [{ to: 'tempo-eng', text: '@tempo-eng task X', timestamp: '2026-04-26T12:00:00.000Z' }];
    const result = buildFormattedMessages([], sent, 'tempo-conductor');
    expect(result).toHaveLength(1);
    // Local echo doesn't carry a role (no maestro-out tag), so the
    // recipient prefix path is gated by role and stays off — but the
    // entry still appears with direction: 'out' so the user sees their
    // message echoed. This documents the (current) behavior; a future
    // change could project local-echo entries with `role: 'maestro-out'`
    // to enable the prefix uniformly.
    expect(result[0].direction).toBe('out');
    expect(result[0].recipientLabel).toBeUndefined();
  });
});
