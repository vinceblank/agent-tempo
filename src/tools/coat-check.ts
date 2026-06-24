/**
 * `coat_check` — canonical multi-action coat-check tool (#793 tool-family merge).
 *
 * Merges the four legacy per-action tools (`coat_check_put` / `coat_check_get` /
 * `coat_check_list` / `coat_check_evict`) into ONE canonical tool with a flat
 * `{ action, ...per-action optional fields }` param shape (NOT a discriminated
 * union — see docs/design/793-tool-family-merge-brief.md §2). The canonical name
 * is **net-new**, so `action` is REQUIRED (no legacy caller to keep compatible).
 *
 * The legacy tools stay registered as thin forwarding aliases
 * ({@link buildCoatCheckAliasTools}) so every existing caller keeps its exact
 * original schema and behaviour — the alias-not-remove invariant (#793). Both the
 * canonical handler and the aliases reuse the legacy descriptors' handler bodies
 * verbatim, so there is a single implementation per action.
 */
import { z } from 'zod';
import { Client } from '@temporalio/client';
import { Config } from '../config';
import { fail, type TempoToolDescriptor } from './descriptor';
import { firstMissing } from './action-guard';
import {
  COAT_CHECK_SUMMARY_MAX,
  COAT_CHECK_CONTENT_MAX,
  COAT_CHECK_CONTENT_TYPE_MAX,
  COAT_CHECK_TTL_MIN_MS,
  COAT_CHECK_TTL_MAX_MS,
  COAT_CHECK_TICKET_REGEX,
  COAT_CHECK_TICKET_MAX,
  PLAYER_NAME_MAX,
} from '../utils/validation';
import { buildCoatCheckPutTool } from './coat-check-put';
import { buildCoatCheckGetTool } from './coat-check-get';
import { buildCoatCheckListTool } from './coat-check-list';
import { buildCoatCheckEvictTool } from './coat-check-evict';

/**
 * Canonical `coat_check` tool. Dispatches on `action` to the same per-action
 * logic the legacy tools used. Per-action required fields are runtime-guarded
 * (the flat union makes them optional at the zod boundary).
 */
export function buildCoatCheckTool(
  client: Client,
  config: Config,
  getPlayerId: () => string,
): TempoToolDescriptor {
  const put = buildCoatCheckPutTool(client, config, getPlayerId);
  const get = buildCoatCheckGetTool(client, config, getPlayerId);
  const list = buildCoatCheckListTool(client, config);
  const evict = buildCoatCheckEvictTool(client, config, getPlayerId);

  return {
    name: 'coat_check',
    description:
      'Ensemble-shared transient store (stash large artifacts past the cue size cap). ' +
      'action="put" stashes content (summary+content[, contentType, ttlMs]) and returns a ticket; ' +
      'action="get" redeems a ticket (bumps fetch audit); ' +
      'action="list" surveys entry headers (putBy/prefix/unfetchedOnly filters); ' +
      'action="evict" removes an entry early (owner-or-conductor).',
    params: {
      action: z.enum(['put', 'get', 'list', 'evict']).describe('Which coat-check operation to perform'),
      // put:
      summary: z.string().min(1).max(COAT_CHECK_SUMMARY_MAX).optional().describe('put: short human-readable label for the entry'),
      content: z.string().min(1).max(COAT_CHECK_CONTENT_MAX).optional().describe('put: the body to stash (≤32 KiB)'),
      contentType: z.string().max(COAT_CHECK_CONTENT_TYPE_MAX).optional().describe('put: optional MIME/content-type hint'),
      ttlMs: z.number().int().min(COAT_CHECK_TTL_MIN_MS).max(COAT_CHECK_TTL_MAX_MS).optional().describe('put: optional time-to-live in ms (default 7d)'),
      // get / evict:
      ticket: z.string().regex(COAT_CHECK_TICKET_REGEX).max(COAT_CHECK_TICKET_MAX).optional().describe('get/evict: the ticket id returned by put'),
      // list:
      putBy: z.string().max(PLAYER_NAME_MAX).optional().describe('list: filter to entries stashed by this player'),
      prefix: z.string().max(COAT_CHECK_SUMMARY_MAX).optional().describe('list: filter to entries whose summary starts with this prefix'),
      unfetchedOnly: z.boolean().optional().describe('list: only entries that have never been fetched'),
    },
    handler: async (args) => {
      const action = args.action as 'put' | 'get' | 'list' | 'evict';
      switch (action) {
        case 'put': {
          const m = firstMissing(args, ['summary', 'content']);
          if (m) return fail(`coat_check action="put" requires "${m}".`);
          return put.handler(args);
        }
        case 'get': {
          const m = firstMissing(args, ['ticket']);
          if (m) return fail(`coat_check action="get" requires "${m}".`);
          return get.handler(args);
        }
        case 'list':
          return list.handler(args);
        case 'evict': {
          const m = firstMissing(args, ['ticket']);
          if (m) return fail(`coat_check action="evict" requires "${m}".`);
          return evict.handler(args);
        }
        default:
          return fail(`Unknown coat_check action: ${String(action)}. Expected put | get | list | evict.`);
      }
    },
  };
}

/**
 * Legacy forwarding aliases — `coat_check_put` / `coat_check_get` /
 * `coat_check_list` / `coat_check_evict`. Each keeps its EXACT original param
 * schema and handler (reused verbatim from the legacy descriptor); only the
 * description gains a deprecation note pointing at the canonical tool.
 *
 * Authored as explicit object literals (not loop-generated) so the
 * surface-drift name scrape and any future static analysis see each alias name
 * adjacent to its description (docs/design/793-tool-family-merge-brief.md §6).
 */
export function buildCoatCheckAliasTools(
  client: Client,
  config: Config,
  getPlayerId: () => string,
): TempoToolDescriptor[] {
  const put = buildCoatCheckPutTool(client, config, getPlayerId);
  const get = buildCoatCheckGetTool(client, config, getPlayerId);
  const list = buildCoatCheckListTool(client, config);
  const evict = buildCoatCheckEvictTool(client, config, getPlayerId);

  return [
    {
      name: 'coat_check_put',
      description: 'DEPRECATED — use `coat_check` with action="put". ' + put.description,
      params: put.params,
      handler: put.handler,
    },
    {
      name: 'coat_check_get',
      description: 'DEPRECATED — use `coat_check` with action="get". ' + get.description,
      params: get.params,
      handler: get.handler,
    },
    {
      name: 'coat_check_list',
      description: 'DEPRECATED — use `coat_check` with action="list". ' + list.description,
      params: list.params,
      handler: list.handler,
    },
    {
      name: 'coat_check_evict',
      description: 'DEPRECATED — use `coat_check` with action="evict". ' + evict.description,
      params: evict.params,
      handler: evict.handler,
    },
  ];
}
