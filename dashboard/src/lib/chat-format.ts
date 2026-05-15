/**
 * Player-id literals used across the chat surface. The TUI has
 * historically tested these as string literals; we name them once
 * here so a future rename doesn't have to chase down every comparison.
 *
 * `MAESTRO_PLAYER_ID` — the dashboard / TUI's own session.
 * `LEGACY_CONDUCTOR_NAME` — pre-#358 rows where the conductor was
 *   addressed by the literal `'conductor'` string instead of its
 *   actual playerId. Old chat history may carry these.
 */
export const MAESTRO_PLAYER_ID = 'maestro';
export const LEGACY_CONDUCTOR_NAME = 'conductor';

/**
 * Chat-row projection — ports the TUI's `buildFormattedMessages`
 * contract from `src/tui/components/ConversationStream.tsx` so the
 * dashboard render matches behaviorally for issues #357 / #358 / #360.
 *
 * - **#357 broadcast collapse**: consecutive messages sharing the same
 *   non-null `broadcastId` and `direction` fold into one row carrying
 *   a `broadcastBadge`. The fold runs BEFORE per-message render so
 *   viewport math doesn't over-count.
 * - **#360 directed prefix**: `maestro-out` rows whose recipient is
 *   neither the conductor nor the legacy `'conductor'` literal nor
 *   `'maestro'` carry a `recipientLabel` for the `→ @<to>` prefix.
 *   Suppressed when a `broadcastBadge` is set (mutually exclusive).
 * - **#358 conductor identity**: derived from the `players` array
 *   passed in by the caller — single source of truth.
 *
 * The dashboard has NO local-echo path in PR-5 (safe writes land in
 * PR-7), so this module is simpler than the TUI's equivalent.
 */
import type { EnsembleChatMessage } from 'agent-tempo/types';

export interface FormattedChatRow {
  /** Original first message of the (possibly folded) group. */
  source: EnsembleChatMessage;
  /** Direction (out = maestro-sent / conductor-sent; in = received). */
  direction: 'in' | 'out';
  /**
   * #360: when set, render `→ @<recipientLabel>` before the body.
   * Mutually exclusive with `broadcastBadge`.
   */
  recipientLabel?: string;
  /**
   * #357: when set, the row represents a folded broadcast group. The
   * badge enumerates recipients; the badge text supersedes the
   * directed prefix.
   */
  broadcastBadge?: { count: number; recipients: string[] };
}

/**
 * Fold consecutive `EnsembleChatMessage`s sharing the same non-null
 * `broadcastId` and `direction` into one group. Pure function — no
 * sorting, no role filtering.
 *
 * Fold key is `broadcastId + direction` only. Role is excluded so a
 * future local-echo entry (where role may be unset) can fold with its
 * server-projected `maestro-out` counterparts. Same rule the TUI
 * adopted in PR #357 after the test failure caught it.
 */
export function foldByBroadcastId(
  sorted: EnsembleChatMessage[],
): EnsembleChatMessage[][] {
  const groups: EnsembleChatMessage[][] = [];
  for (const m of sorted) {
    const last = groups[groups.length - 1];
    const direction = directionOf(m);
    if (
      m.broadcastId &&
      last &&
      last[0].broadcastId === m.broadcastId &&
      directionOf(last[0]) === direction
    ) {
      last.push(m);
    } else {
      groups.push([m]);
    }
  }
  return groups;
}

/**
 * Map `EnsembleChatMessage` → render-direction. Mirrors the TUI's
 * derivation: `maestro-out` and `conductor-out` are outbound; the rest
 * are inbound from the dashboard's perspective.
 */
function directionOf(m: EnsembleChatMessage): 'in' | 'out' {
  return m.role === 'maestro-out' ? 'out' : 'in';
}

/**
 * Project a chat slice into renderable rows. Returns one row per
 * `EnsembleChatMessage` UNLESS a contiguous slice shares a
 * `broadcastId` (#357), in which case those collapse to one badged row.
 *
 * `conductorPlayerId` is the active conductor's playerId (derived from
 * `players.find(p => p.isConductor)?.playerId`). Used to suppress
 * the directed prefix on conductor-bound rows.
 */
export function buildFormattedRows(
  messages: EnsembleChatMessage[],
  conductorPlayerId?: string,
): FormattedChatRow[] {
  const groups = foldByBroadcastId(messages);

  return groups.map((group) => {
    const m = group[0];
    const direction = directionOf(m);

    let broadcastBadge: { count: number; recipients: string[] } | undefined;
    if (m.broadcastId) {
      broadcastBadge = {
        count: group.length,
        recipients: group.map((g) => g.to),
      };
    }

    let recipientLabel: string | undefined;
    if (
      !broadcastBadge &&
      m.role === 'maestro-out' &&
      m.to &&
      m.to !== MAESTRO_PLAYER_ID &&
      m.to !== LEGACY_CONDUCTOR_NAME &&
      m.to !== conductorPlayerId
    ) {
      recipientLabel = m.to;
    }

    return { source: m, direction, recipientLabel, broadcastBadge };
  });
}

/** Maximum number of recipient names rendered inline in a broadcast badge. */
export const BROADCAST_BADGE_NAME_CAP = 3;

/**
 * Render the broadcast-badge inline text. Format:
 *   `📡 broadcast → 3 players (alice, bob, carol)`
 *   `📡 broadcast → 8 players (alice, bob, carol +5 more)`
 * Mirrors the TUI's `broadcastBadgeText` helper from PR #357.
 */
export function broadcastBadgeText(badge: { count: number; recipients: string[] }): string {
  const head = `📡 broadcast → ${badge.count} player${badge.count === 1 ? '' : 's'}`;
  const named = badge.recipients.slice(0, BROADCAST_BADGE_NAME_CAP);
  const remainder = Math.max(0, badge.count - named.length);
  if (named.length === 0) return head;
  const list = remainder > 0 ? `${named.join(', ')} +${remainder} more` : named.join(', ');
  return `${head} (${list})`;
}
