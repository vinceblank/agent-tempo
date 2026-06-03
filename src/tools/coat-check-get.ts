/**
 * `coat_check_get` — redeem a coat-check ticket and pull the stashed content
 * (#318, ADR 0008). Returns the entry's summary, content body, and audit
 * fields, or `null` when the ticket is missing / expired / evicted (no
 * error-class proliferation for the common "ticket already gone" case).
 *
 * Audit identity (`fetchedBy`) is set by the tool layer from `getPlayerId()`
 * — there is NO `fetchedBy` arg on the MCP schema. The workflow handler
 * bumps `lastFetchedAt` / `lastFetchedBy` / `fetchCount` on the entry so
 * the putter can later see whether anyone has redeemed.
 *
 * Implemented as a workflow Update (not Query) because the fetch-audit
 * counters mutate state — Queries cannot mutate.
 */
import { z } from 'zod';
import { Client } from '@temporalio/client';
import { Config, maestroWorkflowId } from '../config';
import { coatCheckGetUpdate } from '../workflows/maestro-signals';
import { ok, fail, formatError, type TempoToolDescriptor } from './descriptor';
import { COAT_CHECK_TICKET_MAX, COAT_CHECK_TICKET_REGEX } from '../utils/validation';

export function buildCoatCheckGetTool(
  client: Client,
  config: Config,
  getPlayerId: () => string,
): TempoToolDescriptor {
  return {
    name: 'coat_check_get',
    description: `Redeem a coat-check ticket (#318) and pull the stashed content. Returns the entry's summary, content body, and audit info — or "not found" when the ticket is missing / expired / evicted (no error, just empty).

Successful redemptions bump the entry's fetch-audit counters (\`lastFetchedAt\` / \`lastFetchedBy\` / \`fetchCount\`) so the putter can later see whether anyone has redeemed. \`coat_check_list\` won't bump these — only an actual redemption counts.`,
    params: {
      ticket: z.string().regex(COAT_CHECK_TICKET_REGEX).max(COAT_CHECK_TICKET_MAX).describe(
        `The ticket id returned by an earlier \`coat_check_put\` (≤${COAT_CHECK_TICKET_MAX} chars).`,
      ),
    },
    handler: async (args) => {
      const { ticket } = args as { ticket: string };
      const fetchedBy = getPlayerId();
      try {
        const handle = client.workflow.getHandle(maestroWorkflowId(config.ensemble));
        const entry = await handle.executeUpdate(coatCheckGetUpdate, {
          args: [{ ticket, fetchedBy }],
        });
        if (!entry) {
          return ok(`Ticket **${ticket}** is not found (missing, expired, or evicted).`);
        }
        const lines: string[] = [
          `**Ticket ${ticket}** — stashed by ${entry.putBy} at ${entry.putAt}, expires ${entry.expiresAt}`,
          `Summary: ${entry.summary}`,
        ];
        if (entry.contentType) lines.push(`Content-Type: ${entry.contentType}`);
        lines.push(`Size: ${entry.size} bytes`);
        lines.push(`Fetches: ${entry.fetchCount}${entry.lastFetchedBy ? ` (last by ${entry.lastFetchedBy} at ${entry.lastFetchedAt})` : ''}`);
        lines.push('');
        lines.push('---');
        lines.push(entry.content);
        return ok(lines.join('\n'));
      } catch (err) {
        return fail(`Failed to redeem ticket: ${formatError(err)}`);
      }
    },
  };
}
