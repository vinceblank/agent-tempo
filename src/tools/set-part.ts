import { z } from 'zod';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { WorkflowHandle } from '@temporalio/client';
import { defineTool } from './helpers';
import { PART_MAX } from '../utils/validation';

export function registerSetPartTool(
  server: McpServer,
  handle: WorkflowHandle,
) {
  defineTool(
    server,
    'set_part',
    'Update your description of what you are currently working on. Visible to other sessions via ensemble.',
    {
      part: z.string().max(PART_MAX).describe('A short description of your current work'),
    },
    async (args) => {
      const { part } = args as { part: string };
      try {
        await handle.signal('setPart', part);
        return {
          content: [{ type: 'text' as const, text: `Part updated: "${part}"` }],
        };
      } catch (err) {
        return {
          content: [{ type: 'text' as const, text: `Failed to update part: ${err}` }],
          isError: true,
        };
      }
    },
  );
}
