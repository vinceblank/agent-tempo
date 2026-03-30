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
    'Terminate a player session by name. Use this to clean up orphaned sessions.',
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
        // Warn the session before terminating
        try {
          await handle.signal('receiveMessage', {
            from: getPlayerId(),
            text: `Your session is being terminated by player ${getPlayerId()}. Please save your work and close this terminal.`,
          });
        } catch {
          // May fail if workflow is in a bad state — proceed with termination
        }

        await handle.terminate(`Terminated by player ${getPlayerId()}`);
        return {
          content: [{ type: 'text' as const, text: `Session **${playerId}** terminated. If the Claude Code terminal is still open, the user will need to close it manually.` }],
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
