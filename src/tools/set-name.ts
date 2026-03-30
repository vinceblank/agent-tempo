import { z } from 'zod';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { WorkflowHandle, Client } from '@temporalio/client';
import { Config } from '../config';
import { resolveSession } from './resolve';
import { defineTool } from './helpers';

export function registerSetNameTool(
  server: McpServer,
  client: Client,
  config: Config,
  handle: WorkflowHandle,
  getPlayerId: () => string,
  setPlayerId: (id: string) => void,
) {
  defineTool(
    server,
    'set_name',
    'Set a human-readable name for this session. Visible to other players in the ensemble.',
    {
      name: z.string().describe('The name for this session (e.g., "UX", "API", "test-runner")'),
    },
    async (args) => {
      const { name } = args as { name: string };

      // Check if the name is already taken
      const existing = await resolveSession(client, config.ensemble, name);
      if (existing && existing.workflowId !== handle.workflowId) {
        return {
          content: [{ type: 'text' as const, text: `Name **${name}** is already taken by another session. Choose a different name.` }],
          isError: true,
        };
      }

      try {
        await handle.signal('setName', name);
        setPlayerId(name);
        return {
          content: [{ type: 'text' as const, text: `Session name set to **${name}**. Run \`/rename ${name}\` to match your Claude Code session name.` }],
        };
      } catch (err) {
        return {
          content: [{ type: 'text' as const, text: `Failed to set name: ${err}` }],
          isError: true,
        };
      }
    },
  );
}
