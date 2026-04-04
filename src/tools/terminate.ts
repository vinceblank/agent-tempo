import { z } from 'zod';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { Client } from '@temporalio/client';
import { Config } from '../config';
import { shutdownSignal } from '../workflows/signals';
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
        // Send termination message, then shutdown signal.
        // The message gives the session time to see why it's being terminated.
        await handle.signal('receiveMessage', {
          from: getPlayerId(),
          text: `Your session is being terminated by ${getPlayerId()}. Please save any work and report final status.`,
        });
        // Brief delay to let the poller deliver the message before shutdown
        await new Promise(r => setTimeout(r, 2000));
        await handle.signal(shutdownSignal);

        return {
          content: [{ type: 'text' as const, text: `Shutdown signal sent to **${playerId}**. The workflow and MCP server will exit. The Claude Code terminal may remain open and will need to be closed manually.` }],
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
