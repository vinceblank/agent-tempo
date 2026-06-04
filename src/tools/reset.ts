/**
 * `reset` — clean-wipe a player's conversation context (D14). Enqueues a
 * `ResetOutboxEntry` on the caller's outbox; the dispatch loop runs
 * `deliverReset` on the target, setting a `pendingReset` flag the target's Pi
 * extension polls + acts on (Pi `newSession()` — fresh context, no replay).
 *
 * D14 ruling: reset = CLEAN-WIPE only (always `fresh: true`). For a context
 * wipe that RE-SEEDS from saved state, use `restart` with `loadFromState`
 * instead — that is a different path. Reset is an operator/conductor control op
 * and does NOT route through the MD-G tool gate.
 */
import { z } from 'zod';
import { WorkflowHandle } from '@temporalio/client';
import type { OutboxEntryInput } from '../types';
import { submitOutboxUpdate } from '../workflows/signals';
import { ok, fail, formatError, type TempoToolDescriptor } from './descriptor';
import { PLAYER_NAME_MAX, validatePlayerName } from '../utils/validation';

export function buildResetTool(
  handle: WorkflowHandle,
  getPlayerId: () => string,
): TempoToolDescriptor {
  return {
    name: 'reset',
    description:
      "Clean-wipe a player's conversation context — the target starts a FRESH " +
      "session (no transcript replay). Use this to clear a player that's stuck " +
      'or off-track. For a context wipe that RE-SEEDS from saved state, use ' +
      '`restart` with `loadFromState` instead.',
    params: {
      playerId: z.string().max(PLAYER_NAME_MAX).describe('The player whose context to clean-wipe'),
      reason: z.string().max(500).optional().describe('Optional reason — surfaced to the wiped session and recorded for audit'),
    },
    handler: async (args) => {
      const { playerId, reason } = args as { playerId: string; reason?: string };

      const nameError = validatePlayerName(playerId);
      if (nameError) return fail(nameError);

      try {
        const entry: OutboxEntryInput = {
          type: 'reset',
          targetPlayerId: playerId,
          invokerPlayerId: getPlayerId(),
          fresh: true, // D14: reset = clean-wipe only.
          ...(reason !== undefined ? { reason } : {}),
        };
        const entryId = await handle.executeUpdate(submitOutboxUpdate, { args: [entry] });
        return ok(`Reset (clean-wipe) queued for **${playerId}**. (outbox: ${entryId})`);
      } catch (err) {
        return fail(`Failed to reset: ${formatError(err)}`);
      }
    },
  };
}
