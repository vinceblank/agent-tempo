import { z } from 'zod';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { Client } from '@temporalio/client';
import { Config, schedulerWorkflowId } from '../config';
import { defineTool, ok, fail, formatError } from './helpers';

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

        // Check if the scheduler workflow is running before signaling
        try {
          await handle.describe();
        } catch {
          return fail('No scheduler is running — there are no schedules to remove.');
        }

        await handle.signal('removeSchedule', name);
        return ok(`Schedule **${name}** removed.`);
      } catch (err) {
        return fail(`Failed to remove schedule: ${formatError(err)}`);
      }
    },
  );
}
