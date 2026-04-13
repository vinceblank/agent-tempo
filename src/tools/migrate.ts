/**
 * `migrate` — sugar for `restart --host=<h>` per design §9.6.
 *
 * Identical semantics to `restart` with the `host` argument required. Separate
 * verb for UX clarity: "migrate to host X" vs "restart this session". Both
 * names route through the same `RestartOutboxEntry` outbox path so the §8.2
 * algorithm is implemented once in `deliverRestart` (QA B3).
 *
 * PR-F wires the `confirmStealFromHost` guard (design §16.5 Option B) via the
 * shared `enforceYesStealGuard` helper from `restart.ts`. When the caller passes
 * `force: true` AND the target's current attachment is on a different host,
 * `confirmStealFromHost` must name that hostname exactly.
 */
import { z } from 'zod';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { Client, WorkflowHandle } from '@temporalio/client';
import { Config } from '../config';
import type { OutboxEntryInput } from '../types';
import { submitOutboxUpdate } from '../workflows/signals';
import { defineTool, ok, fail, formatError } from './helpers';
import { enforceYesStealGuard } from './restart';
import { PLAYER_NAME_MAX, RESTART_CONTEXT_MESSAGES_MAX, validatePlayerName } from '../utils/validation';

export function registerMigrateTool(
  server: McpServer,
  client: Client,
  config: Config,
  getPlayerId: () => string,
  handle: WorkflowHandle,
) {
  defineTool(
    server,
    'migrate',
    'Migrate a session to a different host — sugar for `restart` with a required `host`. Reaps the current attachment, claims fresh on the target host, spawns a new adapter. Cross-host routing (per-host task queues) is honored automatically. When `force=true` AND the target is currently on a different host, `confirmStealFromHost` must match that hostname (design §16.5).',
    {
      playerId: z.string().max(PLAYER_NAME_MAX).describe('The player name to migrate'),
      host: z.string().min(1).describe('Target hostname — required'),
      fresh: z.boolean().optional().describe('Skip context replay (default false)'),
      force: z.boolean().optional().describe('Steal a live attachment via forceDetach (default false)'),
      contextMessages: z.number().min(0).max(RESTART_CONTEXT_MESSAGES_MAX).optional().describe('Number of recent messages to include in context (default 10)'),
      confirmStealFromHost: z.string().optional().describe('Required when `force=true` and the target\'s current attachment is on a different host (design §16.5 Option B).'),
    },
    async (args) => {
      const input = args as {
        playerId: string;
        host: string;
        fresh?: boolean;
        force?: boolean;
        contextMessages?: number;
        confirmStealFromHost?: string;
      };

      const nameError = validatePlayerName(input.playerId);
      if (nameError) return fail(nameError);

      if (!input.host || !input.host.trim()) {
        return fail('`host` is required for migrate. Use `restart` (without host) to restart on the session\'s current host.');
      }

      // Shared cross-host guard with `restart` — same rules, same copy-paste
      // error messages (§16.5).
      const guardError = await enforceYesStealGuard(client, config.ensemble, input.playerId, input);
      if (guardError) return fail(guardError);

      try {
        const entry: OutboxEntryInput = {
          type: 'restart',
          targetPlayerId: input.playerId,
          invokerPlayerId: getPlayerId(),
          host: input.host,
          ...(input.fresh !== undefined ? { fresh: input.fresh } : {}),
          ...(input.force !== undefined ? { force: input.force } : {}),
          ...(input.contextMessages !== undefined ? { contextMessages: input.contextMessages } : {}),
        };
        const entryId = await handle.executeUpdate(submitOutboxUpdate, { args: [entry] });
        return ok(`Migrate queued for **${input.playerId}** → ${input.host}. (outbox: ${entryId})`);
      } catch (err) {
        return fail(`Failed to migrate: ${formatError(err)}`);
      }
    },
  );
}
