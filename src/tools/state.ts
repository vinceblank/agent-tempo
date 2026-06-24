/**
 * `state` — canonical multi-action player saveable-state tool (#793 merge).
 *
 * Merges the three legacy tools (`save_state` / `fetch_state` / `clear_state`)
 * into ONE canonical tool with a flat `{ action, ...optional fields }` shape
 * (see docs/design/793-tool-family-merge-brief.md §2). The canonical name is
 * **net-new**, so `action` is REQUIRED.
 *
 * Legacy tools stay registered as forwarding aliases
 * ({@link buildStateAliasTools}); both paths reuse the legacy handler bodies, so
 * behaviour (owner-only write, self-or-peer read, idempotent clear) is identical.
 */
import { z } from 'zod';
import { Client, WorkflowHandle } from '@temporalio/client';
import { Config } from '../config';
import { fail, type TempoToolDescriptor } from './descriptor';
import { firstMissing } from './action-guard';
import {
  PLAYER_STATE_KEY_REGEX,
  PLAYER_STATE_KEY_MAX,
  PLAYER_STATE_CONTENT_MAX,
  PLAYER_NAME_MAX,
} from '../utils/validation';
import { buildSaveStateTool } from './save-state';
import { buildFetchStateTool } from './fetch-state';
import { buildClearStateTool } from './clear-state';

/**
 * Canonical `state` tool. Dispatches on `action`; per-action required fields are
 * runtime-guarded.
 */
export function buildStateTool(
  client: Client,
  config: Config,
  handle: WorkflowHandle,
  getPlayerId: () => string,
): TempoToolDescriptor {
  const save = buildSaveStateTool(handle, getPlayerId);
  const fetch = buildFetchStateTool(client, config, handle, getPlayerId);
  const clear = buildClearStateTool(handle);

  return {
    name: 'state',
    description:
      'Curated per-player state slots that survive restart (you choose what context persists). ' +
      'action="save" writes your own slot (content[, key]); ' +
      'action="fetch" reads a slot for yourself or a peer (key/playerId, defaults to your own "main"); ' +
      'action="clear" empties one of your slots. save/clear are owner-only.',
    params: {
      action: z.enum(['save', 'fetch', 'clear']).describe('Which state operation to perform'),
      // save:
      content: z.string().min(1).max(PLAYER_STATE_CONTENT_MAX).optional().describe('save: the state body to store (≤32 KiB)'),
      // save / fetch / clear:
      key: z.string().regex(PLAYER_STATE_KEY_REGEX).max(PLAYER_STATE_KEY_MAX).optional().describe('Slot key (defaults to "main")'),
      // fetch:
      playerId: z.string().max(PLAYER_NAME_MAX).optional().describe('fetch: peer to read from (defaults to yourself)'),
    },
    handler: async (args) => {
      const action = args.action as 'save' | 'fetch' | 'clear';
      switch (action) {
        case 'save': {
          const m = firstMissing(args, ['content']);
          if (m) return fail(`state action="save" requires "${m}".`);
          return save.handler(args);
        }
        case 'fetch':
          return fetch.handler(args);
        case 'clear':
          return clear.handler(args);
        default:
          return fail(`Unknown state action: ${String(action)}. Expected save | fetch | clear.`);
      }
    },
  };
}

/**
 * Legacy forwarding aliases — `save_state` / `fetch_state` / `clear_state`.
 * Each keeps its exact original schema + handler; description gains a
 * deprecation note. Explicit object literals (see §6 drift note).
 */
export function buildStateAliasTools(
  client: Client,
  config: Config,
  handle: WorkflowHandle,
  getPlayerId: () => string,
): TempoToolDescriptor[] {
  const save = buildSaveStateTool(handle, getPlayerId);
  const fetch = buildFetchStateTool(client, config, handle, getPlayerId);
  const clear = buildClearStateTool(handle);

  return [
    {
      name: 'save_state',
      description: 'DEPRECATED — use `state` with action="save". ' + save.description,
      params: save.params,
      handler: save.handler,
    },
    {
      name: 'fetch_state',
      description: 'DEPRECATED — use `state` with action="fetch". ' + fetch.description,
      params: fetch.params,
      handler: fetch.handler,
    },
    {
      name: 'clear_state',
      description: 'DEPRECATED — use `state` with action="clear". ' + clear.description,
      params: clear.params,
      handler: clear.handler,
    },
  ];
}
