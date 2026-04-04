import { z } from 'zod';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { Client, WorkflowHandle } from '@temporalio/client';
import { Config } from '../config';
import { resolveSession } from './resolve';
import { submitOutboxUpdate } from '../workflows/signals';
import type { OutboxEntryInput } from '../types';
import { defineTool } from './helpers';

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
    'Stop a player session by name. Signals termination and the session exits gracefully.',
    {
      playerId: z.string().describe('The player name of the session to stop'),
    },
    async (args) => {
      const { playerId } = args as { playerId: string };

      if (playerId === getPlayerId()) {
        return {
          content: [{ type: 'text' as const, text: 'Cannot stop your own session.' }],
          isError: true,
        };
      }

      try {
        const resolved = await resolveSession(client, config.ensemble, playerId);
        if (!resolved) {
          return {
            content: [{ type: 'text' as const, text: `No active session found with name "${playerId}".` }],
            isError: true,
          };
        }

        const entry = {
          type: 'stop',
          targetPlayerId: playerId,
        } as OutboxEntryInput;
        const entryId = await handle.executeUpdate(submitOutboxUpdate, { args: [entry] });

        return {
          content: [{ type: 'text' as const, text: `Stop signal sent to **${playerId}**. The session will exit gracefully. (outbox: ${entryId})` }],
        };
      } catch (err) {
        return {
          content: [{ type: 'text' as const, text: `Failed to stop: ${err}` }],
          isError: true,
        };
      }
    },
  );
}
