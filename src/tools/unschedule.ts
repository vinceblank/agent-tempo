import { z } from 'zod';
import { Client } from '@temporalio/client';
import { WorkflowNotFoundError } from '@temporalio/common';
import { Config, schedulerWorkflowId } from '../config';
import { ok, fail, formatError, type TempoToolDescriptor } from './descriptor';

export function buildUnscheduleTool(
  client: Client,
  config: Config,
): TempoToolDescriptor {
  return {
    name: 'unschedule',
    description: 'Remove a named schedule. The schedule stops firing immediately.',
    params: {
      name: z.string().describe('Name of the schedule to remove'),
    },
    handler: async (args) => {
      const { name } = args as { name: string };
      try {
        const wfId = schedulerWorkflowId(config.ensemble);
        const handle = client.workflow.getHandle(wfId);

        // Check if the scheduler workflow is running before signaling.
        // Only treat WorkflowNotFoundError as "no scheduler" — other errors (network, etc.)
        // should propagate so callers get an accurate error message.
        try {
          await handle.describe();
        } catch (err) {
          if (err instanceof WorkflowNotFoundError) {
            return ok('No scheduler is running — there are no schedules to remove.');
          }
          throw err;
        }

        await handle.signal('removeSchedule', name);
        return ok(`Schedule **${name}** removed.`);
      } catch (err) {
        return fail(`Failed to remove schedule: ${formatError(err)}`);
      }
    },
  };
}
