import { z } from 'zod';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { Client } from '@temporalio/client';
import { Config, schedulerWorkflowId } from '../config';
import { defineTool } from './helpers';

export function registerUnscheduleTool(
  server: McpServer,
  client: Client,
  config: Config,
) {
  defineTool(
    server,
    'unschedule',
    'Remove a named schedule. The schedule stops firing immediately.',
    {
      name: z.string().describe('Name of the schedule to remove'),
    },
    async (args) => {
      const { name } = args as { name: string };
      try {
        const wfId = schedulerWorkflowId(config.ensemble);
        const handle = client.workflow.getHandle(wfId);
        await handle.signal('removeSchedule', name);
        return {
          content: [{
            type: 'text' as const,
            text: `Schedule **${name}** removed.`,
          }],
        };
      } catch (err) {
        return {
          content: [{ type: 'text' as const, text: `Failed to remove schedule: ${err}` }],
          isError: true,
        };
      }
    },
  );
}
