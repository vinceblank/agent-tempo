import { z } from 'zod';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { Client } from '@temporalio/client';
import { Config } from '../config';
import { resolveSession } from './resolve';
import { defineTool } from './helpers';

export function registerStopTool(
  server: McpServer,
  client: Client,
  config: Config,
  getPlayerId: () => string,
) {
  defineTool(
    server,
    'stop',
    'Stop a player session by name. Sends a termination message and waits for delivery.',
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
        const handle = await resolveSession(client, config.ensemble, playerId);
        if (!handle) {
          return {
            content: [{ type: 'text' as const, text: `No active session found with name "${playerId}".` }],
            isError: true,
          };
        }

        await handle.signal('updateMetadata', { status: 'terminated', terminatedBy: getPlayerId() });

        return {
          content: [{ type: 'text' as const, text: `Terminated **${playerId}** via status update. The workflow will exit gracefully.` }],
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
