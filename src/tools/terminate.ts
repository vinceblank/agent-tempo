import { z } from 'zod';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { Client } from '@temporalio/client';
import { Config } from '../config';
import { resolveSession } from './resolve';
import { defineTool } from './helpers';

export function registerTerminateTool(
  server: McpServer,
  client: Client,
  config: Config,
  getPlayerId: () => string,
) {
  defineTool(
    server,
    'terminate',
    'Terminate a player session by name. Sends a termination message and waits for delivery before completing the workflow.',
    {
      playerId: z.string().describe('The player name of the session to terminate'),
    },
    async (args) => {
      const { playerId } = args as { playerId: string };

      if (playerId === getPlayerId()) {
        return {
          content: [{ type: 'text' as const, text: 'Cannot terminate your own session.' }],
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

        // Send termination message + set status to 'terminated'.
        // The workflow adds a termination message, waits up to 1 minute for
        // delivery, then completes gracefully.
        await handle.signal('receiveMessage', {
          from: getPlayerId(),
          text: `Your session is being terminated by ${getPlayerId()}. Please save any work and report final status.`,
        });
        await handle.signal('updateMetadata', {
          status: 'terminated',
        });

        return {
          content: [{ type: 'text' as const, text: `Termination signal sent to **${playerId}**. The session will complete after delivering the termination message (up to 1 minute).` }],
        };
      } catch (err) {
        return {
          content: [{ type: 'text' as const, text: `Failed to terminate: ${err}` }],
          isError: true,
        };
      }
    },
  );
}
