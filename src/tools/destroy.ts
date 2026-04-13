/**
 * `destroy` — terminal end of a session workflow.
 *
 * QA B2: enqueues a `DestroyOutboxEntry` on the caller's workflow outbox
 * rather than executing `destroyUpdate` directly from tool code. The session
 * workflow's dispatch loop runs the `deliverDestroy` activity on the target,
 * which calls `destroyUpdate` + (optionally) posts a system message on the
 * ensemble conductor via `receiveMessageSignal` (typed constant, no literals).
 *
 * For graceful shutdown without destroying the workflow, use `detach` instead.
 */
import { z } from 'zod';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { Client, WorkflowHandle } from '@temporalio/client';
import { Config } from '../config';
import type { OutboxEntryInput } from '../types';
import { submitOutboxUpdate } from '../workflows/signals';
import { defineTool, ok, fail, formatError } from './helpers';
import { PLAYER_NAME_MAX, validatePlayerName } from '../utils/validation';

export function registerDestroyTool(
  server: McpServer,
  _client: Client,
  _config: Config,
  getPlayerId: () => string,
  handle: WorkflowHandle,
) {
  defineTool(
    server,
    'destroy',
    'Terminally destroy a session workflow — phase → gone, abandons any in-flight outbox entries, COMPLETEs the workflow. Cannot be undone. For graceful reap use `detach` instead; for a clean revive use `restart`.',
    {
      playerId: z.string().max(PLAYER_NAME_MAX).describe('The player name to destroy'),
      reason: z.string().max(500).optional().describe('Optional reason recorded in the workflow\'s audit event'),
    },
    async (args) => {
      const { playerId, reason } = args as { playerId: string; reason?: string };

      const nameError = validatePlayerName(playerId);
      if (nameError) return fail(nameError);

      if (playerId === getPlayerId()) {
        return fail('Cannot destroy your own session.');
      }

      try {
        const entry: OutboxEntryInput = {
          type: 'destroy',
          targetPlayerId: playerId,
          ...(reason !== undefined ? { reason } : {}),
          notifyConductor: true,
        };
        const entryId = await handle.executeUpdate(submitOutboxUpdate, { args: [entry] });
        return ok(`Destroy queued for **${playerId}**${reason ? ` (reason: ${reason})` : ''}. (outbox: ${entryId})`);
      } catch (err) {
        return fail(`Failed to destroy: ${formatError(err)}`);
      }
    },
  );
}
