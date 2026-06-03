import { z } from 'zod';
import { WorkflowHandle } from '@temporalio/client';
import { ok, fail, formatError, type TempoToolDescriptor } from './descriptor';
import { PART_MAX } from '../utils/validation';

export function buildSetPartTool(
  handle: WorkflowHandle,
): TempoToolDescriptor {
  return {
    name: 'set_part',
    description: 'Update your description of what you are currently working on. Visible to other sessions via ensemble.',
    params: {
      part: z.string().max(PART_MAX).describe('A short description of your current work'),
    },
    handler: async (args) => {
      const { part } = args as { part: string };
      try {
        await handle.signal('setPart', part);
        return ok(`Part updated: "${part}"`);
      } catch (err) {
        return fail(`Failed to update part: ${formatError(err)}`);
      }
    },
  };
}
