/**
 * `coat_check_list` — list coat-check entry headers (#318, ADR 0008) for
 * the calling player's ensemble. Read-only — does NOT bump fetch-audit
 * counters (only an actual `coat_check_get` redemption counts).
 *
 * Returns headers (no `content` body) sorted newest-first. Optional
 * `putBy` / `prefix` / `unfetchedOnly` filters narrow the result.
 */
import { z } from 'zod';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { Client } from '@temporalio/client';
import { Config, maestroWorkflowId } from '../config';
import { coatCheckListQuery } from '../workflows/maestro-signals';
import { defineTool, ok, fail, formatError } from './helpers';
import {
  COAT_CHECK_SLOTS_MAX,
  COAT_CHECK_SUMMARY_MAX,
  PLAYER_NAME_MAX,
} from '../utils/validation';

export function registerCoatCheckListTool(
  server: McpServer,
  client: Client,
  config: Config,
) {
  defineTool(
    server,
    'coat_check_list',
    `List coat-check entries (#318) for this ensemble. Read-only — does NOT bump fetch-audit counters; only \`coat_check_get\` does. Sorted newest-first. Pass \`unfetchedOnly: true\` to surface entries nobody has redeemed yet — useful for an owner cleaning up stale stashes.`,
    {
      putBy: z.string().max(PLAYER_NAME_MAX).optional().describe(
        'Optional filter — only entries stashed by this player.',
      ),
      prefix: z.string().max(COAT_CHECK_SUMMARY_MAX).optional().describe(
        'Optional summary-prefix filter — narrows the listing to entries whose summary starts with this string.',
      ),
      unfetchedOnly: z.boolean().optional().describe(
        'When true, only return entries with fetchCount=0 (never redeemed). Default false.',
      ),
    },
    async (args) => {
      const { putBy, prefix, unfetchedOnly } = args as {
        putBy?: string;
        prefix?: string;
        unfetchedOnly?: boolean;
      };
      try {
        const handle = client.workflow.getHandle(maestroWorkflowId(config.ensemble));
        const filter = {
          ...(putBy !== undefined ? { putBy } : {}),
          ...(prefix !== undefined ? { prefix } : {}),
          ...(unfetchedOnly !== undefined ? { unfetchedOnly } : {}),
        };
        const headers = await handle.query(coatCheckListQuery, filter);

        if (headers.length === 0) {
          const filters: string[] = [];
          if (putBy) filters.push(`putBy="${putBy}"`);
          if (prefix) filters.push(`prefix="${prefix}"`);
          if (unfetchedOnly) filters.push('unfetchedOnly=true');
          const suffix = filters.length > 0 ? ` (filter: ${filters.join(', ')})` : '';
          return ok(`No coat-check entries in this ensemble${suffix}.`);
        }

        const lines: string[] = [];
        lines.push(`${headers.length}/${COAT_CHECK_SLOTS_MAX} coat-check ${headers.length === 1 ? 'entry' : 'entries'}:`);
        lines.push('');
        for (const h of headers) {
          const fetchTag = h.fetchCount === 0
            ? ' (unfetched)'
            : ` (fetched ${h.fetchCount}× by ${h.lastFetchedBy ?? '(unknown)'} at ${h.lastFetchedAt ?? '(unknown)'})`;
          const typeTag = h.contentType ? ` [${h.contentType}]` : '';
          lines.push(`- **${h.ticket}** ${typeTag}— ${h.summary}`);
          lines.push(`    putBy=${h.putBy} · putAt=${h.putAt} · expires=${h.expiresAt} · ${h.size} bytes${fetchTag}`);
        }
        return ok(lines.join('\n'));
      } catch (err) {
        return fail(`Failed to list coat-check entries: ${formatError(err)}`);
      }
    },
  );
}
