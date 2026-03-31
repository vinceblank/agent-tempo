import { z } from 'zod';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { Client } from '@temporalio/client';
import { Config } from '../config';
import { resolveSession } from './resolve';
import { defineTool } from './helpers';

export function registerCueTool(
  server: McpServer,
  client: Client,
  config: Config,
  getPlayerId: () => string,
) {
  defineTool(
    server,
    'cue',
    'Send a message to another Claude Code session by player name. Delivered instantly via Temporal signal.',
    {
      playerId: z.string().describe('The player name of the target session'),
      message: z.string().describe('The message to send'),
    },
    async (args) => {
      const { playerId, message } = args as { playerId: string; message: string };
      try {
        const handle = await resolveSession(client, config.ensemble, playerId);
        if (!handle) {
          return {
            content: [{ type: 'text' as const, text: `No active session found with name "${playerId}".` }],
            isError: true,
          };
        }
        await handle.signal('receiveMessage', {
          from: getPlayerId(),
          text: message,
        });

        // Record outbound message on sender's own workflow
        try {
          const senderHandle = await resolveSession(client, config.ensemble, getPlayerId());
          if (senderHandle) {
            await senderHandle.signal('recordSentMessage', { to: playerId, text: message });
          }
        } catch {
          // Don't block the cue if recording fails
        }

        return {
          content: [{ type: 'text' as const, text: `Message sent to ${playerId}.` }],
        };
      } catch (err) {
        return {
          content: [{ type: 'text' as const, text: `Failed to send message to ${playerId}: ${err}` }],
          isError: true,
        };
      }
    },
  );
}
