import { z } from 'zod';
import { WorkflowHandle } from '@temporalio/client';
import { ok, fail, formatError, type TempoToolDescriptor } from './descriptor';
import { STAGE_NAME_MAX } from '../utils/validation';

export function buildCancelStageTool(
  handle: WorkflowHandle,
): TempoToolDescriptor {
  return {
    name: 'cancel_stage',
    description: 'Cancel an active pipeline stage. Players are no longer tracked. Conductor only.',
    params: {
      name: z.string().max(STAGE_NAME_MAX).describe('Name of the stage to cancel'),
    },
    handler: async (args) => {
      const { name } = args as { name: string };

      try {
        await handle.signal('cancelStage', name);

        return ok(`Stage **${name}** cancelled.`);
      } catch (err) {
        return fail(`Failed to cancel stage: ${formatError(err)}`);
      }
    },
  };
}
