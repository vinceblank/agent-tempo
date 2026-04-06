import { z } from 'zod';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { WorkflowHandle } from '@temporalio/client';
import { defineTool, ok, fail, formatError } from './helpers';
import { STAGE_NAME_MAX } from '../utils/validation';

export function registerCancelStageTool(
  server: McpServer,
  handle: WorkflowHandle,
) {
  defineTool(
    server,
    'cancel_stage',
    'Cancel an active pipeline stage. Players are no longer tracked. Conductor only.',
    {
      name: z.string().max(STAGE_NAME_MAX).describe('Name of the stage to cancel'),
    },
    async (args) => {
      const { name } = args as { name: string };

      try {
        await handle.signal('cancelStage', name);

        return ok(`Stage **${name}** cancelled.`);
      } catch (err) {
        return fail(`Failed to cancel stage: ${formatError(err)}`);
      }
    },
  );
}
