/**
 * `migrate` — sugar for `restart --host=<h>` per design §9.6.
 *
 * Identical semantics to `restart` with the `host` argument required. Separate
 * verb for UX clarity: "migrate to host X" vs "restart this session". Both
 * names are supported so operators can write whichever phrasing matches intent.
 *
 * Multi-host routing (host → task-queue selection, `--yes-steal` flag per §16.5
 * Option B) lands in PR-F. This PR-D implementation passes `host` through to
 * the existing `enqueueSpawn` flow; the per-host task queue is selected inside
 * the session workflow's outbox dispatch (unchanged).
 */
import { z } from 'zod';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { Client } from '@temporalio/client';
import { Config } from '../config';
import { performRestart, RestartArgs } from './restart';
import { defineTool, ok, fail, formatError } from './helpers';
import { PLAYER_NAME_MAX, validatePlayerName } from '../utils/validation';

export function registerMigrateTool(
  server: McpServer,
  client: Client,
  config: Config,
  getPlayerId: () => string,
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
      contextMessages: z.number().min(0).max(50).optional().describe('Number of recent messages to include in context (default 10)'),
    },
    async (args) => {
      const input = args as RestartArgs & { host: string };

      const nameError = validatePlayerName(input.playerId);
      if (nameError) return fail(nameError);

      if (!input.host || !input.host.trim()) {
        return fail('`host` is required for migrate. Use `restart` (without host) to restart on the session\'s current host.');
      }

      try {
        const result = await performRestart(client, config, getPlayerId(), input);
        return ok(
          `**${result.playerId}** migrating to ${result.host}` +
          ` (phase was: ${result.phaseBefore}${result.contextReplayed ? '; context replayed' : '; fresh'}).` +
          ` attachmentId: \`${result.attachmentId.slice(0, 8)}…\`, spawnEntryId: \`${result.spawnEntryId.slice(0, 8)}…\`.`,
        );
      } catch (err) {
        return fail(`Failed to migrate: ${formatError(err)}`);
      }
    },
  );
}
