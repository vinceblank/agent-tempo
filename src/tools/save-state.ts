/**
 * `save_state` — write a curated artifact to one of the calling player's
 * saveable-state slots (#334 PR-1, ADR 0011).
 *
 * Owner-only by structure: there is no `playerId` arg — the tool always
 * writes through the calling player's own session-workflow handle, so
 * the workflow doesn't need an authorisation layer. The `savedBy` field
 * captures the calling player's id as the audit identity.
 *
 * The tool docstring nudges the LLM toward a markdown structure
 * (Current task / Findings / Next steps / Open questions) but the schema
 * itself is opaque — no enforced typing.
 */
import { z } from 'zod';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { WorkflowHandle } from '@temporalio/client';
import { savePlayerStateUpdate } from '../workflows/signals';
import { defineTool, ok, fail, formatError } from './helpers';
import {
  PLAYER_STATE_KEY_REGEX,
  PLAYER_STATE_KEY_MAX,
  PLAYER_STATE_CONTENT_MAX,
  PLAYER_STATE_SLOTS_MAX,
  PLAYER_STATE_DEFAULT_KEY,
} from '../utils/validation';

export function registerSaveStateTool(
  server: McpServer,
  handle: WorkflowHandle,
  getPlayerId: () => string,
) {
  defineTool(
    server,
    'save_state',
    `Save curated state for yourself into a named slot — a peer can later read it via \`fetch_state\`, and a future restart can seed itself from this artifact instead of replaying the transcript.

Recommended structure (markdown, not enforced):

  ## Current task
  ...
  ## Findings
  ...
  ## Next steps
  ...
  ## Open questions
  ...

Limits: ${PLAYER_STATE_CONTENT_MAX} bytes per slot, max ${PLAYER_STATE_SLOTS_MAX} slots per player. Slot key defaults to "${PLAYER_STATE_DEFAULT_KEY}". When all ${PLAYER_STATE_SLOTS_MAX} slots are full, saving a new key fails with \`PlayerStateSlotsFull\` — call \`clear_state\` to free a slot.`,
    {
      content: z.string().min(1).max(PLAYER_STATE_CONTENT_MAX).describe(
        `The state content — markdown encouraged, opaque to the system. Max ${PLAYER_STATE_CONTENT_MAX} bytes (UTF-8).`,
      ),
      key: z.string().regex(PLAYER_STATE_KEY_REGEX).max(PLAYER_STATE_KEY_MAX).optional().describe(
        `Slot name (default "${PLAYER_STATE_DEFAULT_KEY}"). Alphanumeric + underscore + hyphen, max ${PLAYER_STATE_KEY_MAX} chars.`,
      ),
    },
    async (args) => {
      const { content, key } = args as { content: string; key?: string };
      const slotKey = key ?? PLAYER_STATE_DEFAULT_KEY;
      const savedBy = getPlayerId();

      try {
        const result = await handle.executeUpdate(savePlayerStateUpdate, {
          args: [{ key: slotKey, content, savedBy }],
        });
        return ok(`Saved to slot **"${slotKey}"** at ${result.savedAt}.`);
      } catch (err) {
        // The workflow validator surfaces structured ApplicationFailure errors
        // (`PlayerStateSlotsFull`, `PlayerStateContentTooLarge`,
        // `PlayerStateInvalidKey`). The `formatError` message preserves the
        // workflow-supplied text so the LLM sees the existing-keys list and
        // can pick which slot to clear.
        return fail(`Failed to save state: ${formatError(err)}`);
      }
    },
  );
}
