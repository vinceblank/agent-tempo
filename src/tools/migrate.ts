/**
 * `migrate` — sugar for `restart --host=<h>` per design §9.6.
 *
 * Identical semantics to `restart` with the `host` argument required. Separate
 * verb for UX clarity: "migrate to host X" vs "restart this session". Both
 * names route through the same `RestartOutboxEntry` outbox path so the §8.2
 * algorithm is implemented once in `deliverRestart` (QA B3).
 *
 * Multi-host routing (host → task-queue selection, `--yes-steal` flag per §16.5
 * Option B) lands in PR-F. This PR-D implementation passes `host` through to
 * the existing `enqueueSpawn` flow; the per-host task queue is selected inside
 * the session workflow's outbox dispatch (unchanged).
 */
import { z } from 'zod';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { Client, WorkflowHandle } from '@temporalio/client';
import { Config } from '../config';
import type { OutboxEntryInput } from '../types';
import { submitOutboxUpdate } from '../workflows/signals';
import { defineTool, ok, fail, formatError } from './helpers';
import { PLAYER_NAME_MAX, RESTART_CONTEXT_MESSAGES_MAX, validatePlayerName } from '../utils/validation';

export function registerMigrateTool(
  server: McpServer,
  _client: Client,
  _config: Config,
  getPlayerId: () => string,
  handle: WorkflowHandle,
) {
  defineTool(
    server,
    'migrate',
    'Migrate a session to a different host — sugar for `restart` with a required `host`. Reaps the current attachment, claims fresh on the target host, spawns a new adapter. Cross-host routing (per-host task queues) is honored automatically.',
    {
      playerId: z.string().max(PLAYER_NAME_MAX).describe('The player name to migrate'),
      host: z.string().min(1).describe('Target hostname — required'),
      fresh: z.boolean().optional().describe('Skip context replay (default false)'),
      force: z.boolean().optional().describe('Steal a live attachment via forceDetach (default false)'),
      contextMessages: z.number().min(0).max(RESTART_CONTEXT_MESSAGES_MAX).optional().describe('Number of recent messages to include in context (default 10)'),
    },
    async (args) => {
      const input = args as {
        playerId: string;
        host: string;
        fresh?: boolean;
        force?: boolean;
        contextMessages?: number;
      };

      const nameError = validatePlayerName(input.playerId);
      if (nameError) return fail(nameError);

      if (!input.host || !input.host.trim()) {
        return fail('`host` is required for migrate. Use `restart` (without host) to restart on the session\'s current host.');
      }

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
