import { z } from 'zod';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { Client, WorkflowHandle } from '@temporalio/client';
import { Config, conductorWorkflowId } from '../config';
import { resolveSession } from './resolve';
import { submitOutboxUpdate } from '../workflows/signals';
import type { OutboxEntryInput } from '../types';
import { defineTool, ok, fail, formatError } from './helpers';
import { validatePlayerName } from '../utils/validation';

export function registerStopTool(
  server: McpServer,
  client: Client,
  config: Config,
  getPlayerId: () => string,
  handle: WorkflowHandle,
) {
  defineTool(
    server,
    'stop',
    'Stop a player session by name. By default signals graceful termination via the outbox. Use force=true to directly terminate the Temporal workflow when normal signaling fails (e.g., orphaned workflows where the process was killed externally).',
    {
      playerId: z.string().describe('The player name of the session to stop'),
      force: z.boolean().optional().describe('Force-terminate the workflow directly via Temporal API, bypassing the outbox signal path. Use when the session is orphaned or unresponsive.'),
    },
    async (args) => {
      const { playerId, force } = args as { playerId: string; force?: boolean };

      const nameError = validatePlayerName(playerId);
      if (nameError) return fail(nameError);

      if (playerId === getPlayerId()) {
        return fail('Cannot stop your own session.');
      }

      try {
        const resolved = await resolveSession(client, config.ensemble, playerId);
        if (!resolved) {
          return fail(`No active session found with name "${playerId}".`);
        }

        if (force) {
          // Force-terminate: bypass outbox, directly terminate the Temporal workflow
          const reason = `Force terminated by ${getPlayerId()}`;
          await resolved.terminate(reason);

          // Best-effort notify conductor
          try {
            const condId = conductorWorkflowId(config.ensemble);
            const condHandle = client.workflow.getHandle(condId);
            await condHandle.signal('receiveMessage', {
              from: 'system',
              text: `Session "${playerId}" was force-terminated by ${getPlayerId()}.`,
            });
          } catch {
            // Conductor may not exist — that's fine
          }

          return ok(`**${playerId}** has been force-terminated. The Temporal workflow was terminated directly.`);
        }

        // Graceful stop via outbox signal
        const entry = {
          type: 'stop',
          targetPlayerId: playerId,
        } as OutboxEntryInput;
        const entryId = await handle.executeUpdate(submitOutboxUpdate, { args: [entry] });

        return ok(`Stop signal sent to **${playerId}**. The session will exit gracefully. (outbox: ${entryId})`);
      } catch (err) {
        return fail(`Failed to stop: ${formatError(err)}`);
      }
    },
  );
}
