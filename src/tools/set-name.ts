import { z } from 'zod';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { WorkflowHandle, Client } from '@temporalio/client';
import { Config } from '../config';
import { resolveSession } from './resolve';
import { defineTool, ok, fail, formatError } from './helpers';
import { PLAYER_NAME_MAX, validatePlayerName } from '../utils/validation';

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
      name: z.string().max(PLAYER_NAME_MAX).describe('The name for this session (e.g., "UX", "API", "test-runner")'),
    },
    async (args) => {
      const { name } = args as { name: string };

      // Validate name to prevent search attribute query injection
      const nameError = validatePlayerName(name);
      if (nameError) {
        return fail(nameError);
      }

      // Check if the name is already taken
      const existing = await resolveSession(client, config.ensemble, name);
      if (existing && existing.workflowId !== handle.workflowId) {
        return fail(`Name **${name}** is already taken by another session. Choose a different name.`);
      }

      try {
        await handle.signal('setName', name);
        setPlayerId(name);
        return ok(`Session name set to **${name}**. Run \`/rename ${name}\` to match your Claude Code session name.`);
      } catch (err) {
        return fail(`Failed to set name: ${formatError(err)}`);
      }
    },
  );
}
