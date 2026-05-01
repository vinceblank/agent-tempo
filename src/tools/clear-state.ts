/**
 * `clear_state` — remove one of the calling player's saved-state slots
 * (#334 PR-1, ADR 0011).
 *
 * Owner-only by structure: there is no `playerId` arg — the tool always
 * clears via the calling player's own session-workflow handle.
 *
 * Idempotent: clearing an already-empty slot returns `cleared: false`.
 * Surfaces a UX-friendly "was already empty" message rather than treating
 * the no-op as an error.
 */
import { z } from 'zod';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { WorkflowHandle } from '@temporalio/client';
import { clearPlayerStateUpdate } from '../workflows/signals';
import { defineTool, ok, fail, formatError } from './helpers';
import {
  PLAYER_STATE_KEY_REGEX,
  PLAYER_STATE_KEY_MAX,
  PLAYER_STATE_DEFAULT_KEY,
} from '../utils/validation';

export function registerClearStateTool(
  server: McpServer,
  handle: WorkflowHandle,
) {
  defineTool(
    server,
    'clear_state',
    `Clear one of your saved-state slots. Owner-only — you can only clear your own state. Idempotent (clearing an empty slot is a no-op). Returns whether the slot was non-empty before the clear.`,
    {
      key: z.string().regex(PLAYER_STATE_KEY_REGEX).max(PLAYER_STATE_KEY_MAX).optional().describe(
        `Slot name (default "${PLAYER_STATE_DEFAULT_KEY}").`,
      ),
    },
    async (args) => {
      const { key } = args as { key?: string };
      const slotKey = key ?? PLAYER_STATE_DEFAULT_KEY;

      try {
        const result = await handle.executeUpdate(clearPlayerStateUpdate, {
          args: [{ key: slotKey }],
        });
        return ok(
          result.cleared
            ? `Cleared slot **"${slotKey}"**.`
            : `Slot **"${slotKey}"** was already empty.`,
        );
      } catch (err) {
        return fail(`Failed to clear state: ${formatError(err)}`);
      }
    },
  );
}
