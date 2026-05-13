/**
 * `coat_check_put` — stash a large content body on per-ensemble Maestro state
 * (#318, ADR 0008). Returns a ticket id that any player in the ensemble can
 * later redeem via `coat_check_get` (or pass on a `cue`'s `attachmentTicket`
 * field so the recipient knows what to fetch).
 *
 * Audit identity (`putBy`) is set by the tool layer from `getPlayerId()` —
 * the MCP schema has NO `playerId` arg, so callers cannot spoof. Same
 * structural-permission pattern as `save_state` (#334).
 */
import { z } from 'zod';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { Client } from '@temporalio/client';
import { Config, maestroWorkflowId } from '../config';
import { coatCheckPutUpdate } from '../workflows/maestro-signals';
import { defineTool, ok, fail, formatError } from './helpers';
import {
  COAT_CHECK_CONTENT_MAX,
  COAT_CHECK_SUMMARY_MAX,
  COAT_CHECK_CONTENT_TYPE_MAX,
  COAT_CHECK_SLOTS_MAX,
  COAT_CHECK_TTL_DEFAULT_MS,
  COAT_CHECK_TTL_MIN_MS,
  COAT_CHECK_TTL_MAX_MS,
} from '../utils/validation';

export function registerCoatCheckPutTool(
  server: McpServer,
  client: Client,
  config: Config,
  getPlayerId: () => string,
) {
  defineTool(
    server,
    'coat_check_put',
    `Stash a large content body on this ensemble's coat-check (#318). Returns a ticket id any player can redeem later via \`coat_check_get\`. Pass the ticket on a \`cue\`'s \`attachmentTicket\` field so the recipient knows what to fetch.

Use this when your message body would otherwise exceed the cue's 100 KB cap — researcher reports, review-item dumps, etc. The cue body should carry a short summary; the coat-check entry holds the full artifact.

Limits: ${COAT_CHECK_CONTENT_MAX} bytes (UTF-8) per entry, max ${COAT_CHECK_SLOTS_MAX} live entries per ensemble. Saturation rejects with \`CoatCheckSlotsFull\` — wait for TTL or \`coat_check_evict\` an entry you own. TTL defaults to 7 days (configurable per put within [1h, 30d]).`,
    {
      summary: z.string().min(1).max(COAT_CHECK_SUMMARY_MAX).describe(
        `Short preamble surfaced in \`coat_check_list\` and on dashboards (≤${COAT_CHECK_SUMMARY_MAX} chars). 1-2 sentences describing what the recipient gets if they redeem.`,
      ),
      content: z.string().min(1).max(COAT_CHECK_CONTENT_MAX).describe(
        `The full content body — markdown encouraged, opaque to the system. Max ${COAT_CHECK_CONTENT_MAX} bytes (UTF-8).`,
      ),
      contentType: z.string().max(COAT_CHECK_CONTENT_TYPE_MAX).optional().describe(
        `Optional MIME-shaped hint (e.g. "text/markdown"). Free-form; ≤${COAT_CHECK_CONTENT_TYPE_MAX} chars.`,
      ),
      ttlMs: z.number().int().min(COAT_CHECK_TTL_MIN_MS).max(COAT_CHECK_TTL_MAX_MS).optional().describe(
        `Time-to-live in milliseconds. Default ${COAT_CHECK_TTL_DEFAULT_MS} (7 days). Range [${COAT_CHECK_TTL_MIN_MS}, ${COAT_CHECK_TTL_MAX_MS}] (1h to 30d).`,
      ),
    },
    async (args) => {
      const { summary, content, contentType, ttlMs } = args as {
        summary: string;
        content: string;
        contentType?: string;
        ttlMs?: number;
      };
      const putBy = getPlayerId();
      try {
        const handle = client.workflow.getHandle(maestroWorkflowId(config.ensemble));
        const result = await handle.executeUpdate(coatCheckPutUpdate, {
          args: [{
            summary,
            content,
            ...(contentType !== undefined ? { contentType } : {}),
            ...(ttlMs !== undefined ? { ttlMs } : {}),
            putBy,
          }],
        });
        return ok(
          `Stashed as ticket **${result.ticket}** (expires ${result.expiresAt}). Slots: ${result.slotsUsed}/${result.slotsTotal}.`,
        );
      } catch (err) {
        // The workflow validator surfaces structured ApplicationFailure
        // errors (`CoatCheckSlotsFull`, `CoatCheckEntryTooLarge`, …). The
        // `formatError` message preserves the workflow text so the LLM
        // sees the oldest-3 ticket list and can pick which to evict.
        return fail(`Failed to stash content: ${formatError(err)}`);
      }
    },
  );
}
