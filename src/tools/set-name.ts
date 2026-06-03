import { z } from 'zod';
import { WorkflowHandle, Client } from '@temporalio/client';
import { Config, schedulerWorkflowId } from '../config';
import { updateScheduleTargetSignal } from '../workflows/scheduler-signals';
import { resolveSession } from './resolve';
import { ok, fail, formatError, type TempoToolDescriptor } from './descriptor';
import { PLAYER_NAME_MAX, validatePlayerName } from '../utils/validation';

const log = (...args: unknown[]) => console.error('[agent-tempo:set-name]', ...args);

export function buildSetNameTool(
  client: Client,
  config: Config,
  handle: WorkflowHandle,
  getPlayerId: () => string,
  setPlayerId: (id: string) => void,
): TempoToolDescriptor {
  return {
    name: 'set_name',
    description: 'Set a human-readable name for this session. Visible to other players in the ensemble.',
    params: {
      name: z.string().max(PLAYER_NAME_MAX).describe('The name for this session (e.g., "UX", "API", "test-runner")'),
    },
    handler: async (args) => {
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
        const oldName = getPlayerId();
        await handle.signal('setName', name);
        setPlayerId(name);

        // Notify the scheduler to rewrite schedule targets from old name to new name
        try {
          const schedulerHandle = client.workflow.getHandle(schedulerWorkflowId(config.ensemble));
          await schedulerHandle.signal(updateScheduleTargetSignal, oldName, name);
        } catch {
          // Scheduler may not be running — that's fine, no schedules to update
          log(`No scheduler to notify about rename ${oldName} → ${name}`);
        }

        return ok(`Session name set to **${name}**. Run \`/rename ${name}\` to match your Claude Code session name.`);
      } catch (err) {
        return fail(`Failed to set name: ${formatError(err)}`);
      }
    },
  };
}
