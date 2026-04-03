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
    'Terminate a player session by name. Sends a graceful shutdown signal so the session can clean up.',
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

        // Send graceful shutdown signal — this triggers the workflow's exit path,
        // the MCP server's shutdown handler, and closes the Claude Code session.
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
