/**
 * `coat_check_evict` — remove a coat-check entry (#318, ADR 0008) before
 * its TTL expires. Owner-or-conductor only: the workflow validator rejects
 * mismatched `evictedBy` with `CoatCheckEvictPermissionDenied`. Returns
 * `evicted: false` when the ticket was already missing / expired before
 * the call landed.
 *
 * Audit identity (`evictedBy`) is set by the tool layer from
 * `getPlayerId()` — there is NO `evictedBy` arg on the MCP schema.
 */
import { z } from 'zod';
import { Client } from '@temporalio/client';
import { Config, maestroWorkflowId } from '../config';
import { coatCheckEvictUpdate } from '../workflows/maestro-signals';
import { ok, fail, formatError, type TempoToolDescriptor } from './descriptor';
import { COAT_CHECK_TICKET_MAX, COAT_CHECK_TICKET_REGEX } from '../utils/validation';

export function buildCoatCheckEvictTool(
  client: Client,
  config: Config,
  getPlayerId: () => string,
): TempoToolDescriptor {
  return {
    name: 'coat_check_evict',
    description: `Evict a coat-check entry (#318) before its TTL expires. Owner-or-conductor only — non-owners (and non-conductors) get a permission error.

Use to free a slot when this ensemble is at the 20-entry cap and you want to make room. \`evicted: false\` means the ticket was already gone (TTL-expired or evicted by someone else).`,
    params: {
      ticket: z.string().regex(COAT_CHECK_TICKET_REGEX).max(COAT_CHECK_TICKET_MAX).describe(
        `The ticket id returned by an earlier \`coat_check_put\` (≤${COAT_CHECK_TICKET_MAX} chars).`,
      ),
    },
    handler: async (args) => {
      const { ticket } = args as { ticket: string };
      const evictedBy = getPlayerId();
      try {
        const handle = client.workflow.getHandle(maestroWorkflowId(config.ensemble));
        const result = await handle.executeUpdate(coatCheckEvictUpdate, {
          args: [{ ticket, evictedBy }],
        });
        if (!result.evicted) {
          return ok(`Ticket **${ticket}** was already gone (no-op).`);
        }
        return ok(`Evicted ticket **${ticket}**.`);
      } catch (err) {
        // Surfaces `CoatCheckEvictPermissionDenied` ApplicationFailure with
        // owner/conductor diagnostic from the workflow validator.
        return fail(`Failed to evict ticket: ${formatError(err)}`);
      }
    },
  };
}
