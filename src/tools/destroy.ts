/**
 * `destroy` — terminal end of a session workflow.
 *
 * Thin wrapper over the `destroyUpdate` primitive (PR-A, design §8.5). Sets
 * phase to `gone`, revokes the current attachment, abandons any in-flight
 * outbox entries (per §2.5), and COMPLETEs the workflow. Cannot be undone.
 *
 * For graceful shutdown without destroying the workflow, use `detach` instead.
 */
import { z } from 'zod';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { Client } from '@temporalio/client';
import { Config, conductorWorkflowId } from '../config';
import { resolveSession } from './resolve';
import { destroyUpdate } from '../workflows/signals';
import { defineTool, ok, fail, formatError } from './helpers';
import { PLAYER_NAME_MAX, validatePlayerName } from '../utils/validation';

export function registerDestroyTool(
  server: McpServer,
  client: Client,
  config: Config,
  getPlayerId: () => string,
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
        const resolved = await resolveSession(client, config.ensemble, playerId);
        if (!resolved) return fail(`No session found with name "${playerId}".`);

        const terminatedBy = getPlayerId();
        await resolved.executeUpdate(destroyUpdate, {
          args: [{
            reason: reason ?? 'destroyed via destroy tool',
            terminatedBy,
          }],
        });

        // Best-effort conductor notification — mirrors terminateSession activity.
        try {
          const condId = conductorWorkflowId(config.ensemble);
          const condHandle = client.workflow.getHandle(condId);
          await condHandle.signal('receiveMessage', {
            from: 'system',
            text: `Session "${playerId}" was destroyed by ${terminatedBy}${reason ? ` (reason: ${reason})` : ''}.`,
            responseRequested: false,
          });
        } catch {
          // Conductor may not exist — non-fatal.
        }

        return ok(`**${playerId}** destroyed${reason ? ` (reason: ${reason})` : ''}.`);
      } catch (err) {
        return fail(`Failed to destroy: ${formatError(err)}`);
      }
    },
  );
}
