import { z } from 'zod';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { WorkflowHandle } from '@temporalio/client';
import { defineTool, ok, fail, formatError } from './helpers';
import { STAGE_NAME_MAX, STAGE_PLAYERS_MAX, PLAYER_NAME_REGEX } from '../utils/validation';

export function registerStageTool(
  server: McpServer,
  handle: WorkflowHandle,
  getPlayerId: () => string,
) {
  defineTool(
    server,
    'stage',
    'Create a pipeline stage tracking N players. When all players report, a completion message is auto-injected. Conductor only.',
    {
      name: z.string().max(STAGE_NAME_MAX).describe('Unique stage name (e.g. "code-review", "testing")'),
      players: z.array(z.string().regex(PLAYER_NAME_REGEX)).min(1).max(STAGE_PLAYERS_MAX).describe('Player names to track in this stage'),
      failurePolicy: z.enum(['halt', 'continue']).optional().describe('What to do when a player reports a blocker. "halt" (default) fails the stage immediately; "continue" waits for all players.'),
    },
    async (args) => {
      const { name, players, failurePolicy } = args as {
        name: string;
        players: string[];
        failurePolicy?: 'halt' | 'continue';
      };

      try {
        await handle.signal('setStage', {
          name,
          players,
          failurePolicy,
          createdBy: getPlayerId(),
        });

        const playerList = players.map((p) => `  - ${p}`).join('\n');
        return ok(`Stage **${name}** created tracking ${players.length} player(s) [policy: ${failurePolicy || 'halt'}]:\n${playerList}`);
      } catch (err) {
        return fail(`Failed to create stage: ${formatError(err)}`);
      }
    },
  );
}
