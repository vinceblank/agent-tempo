import { Client } from '@temporalio/client';
import { SessionMetadata } from '../types';

export interface FireScheduleInput {
  ensemble: string;
  scheduleName: string;
  message: string;
  target: string;
  createdBy: string;
}

export interface FireScheduleResult {
  success: boolean;
  error?: string;
}

/** Activity interface — used by proxyActivities in the scheduler workflow. */
export interface ScheduleActivities {
  fireSchedule(input: FireScheduleInput): Promise<FireScheduleResult>;
}

/**
 * Create the schedule-fire activity bound to a Temporal client.
 * The returned object is registered with the worker as activities.
 */
export function createScheduleActivities(client: Client): ScheduleActivities {
  return {
    async fireSchedule(input: FireScheduleInput): Promise<FireScheduleResult> {
      const { ensemble, scheduleName, message, target, createdBy } = input;

      try {
        // Resolve target player by querying running session workflows
        const handle = await resolveSession(client, ensemble, target);
        if (!handle) {
          return { success: false, error: `No active session found for "${target}"` };
        }

        // Send cue signal with from set to the original creator's name
        const text = `[scheduled: ${scheduleName}] ${message}`;
        await handle.signal('receiveMessage', {
          from: createdBy,
          text,
          isScheduled: true,
          scheduleName,
        });

        return { success: true };
      } catch (err) {
        const errorMsg = err instanceof Error ? err.message : String(err);
        return { success: false, error: errorMsg };
      }
    },
  };
}

/**
 * Resolve a session by player name — mirrors src/tools/resolve.ts logic.
 * We duplicate here because activities run in Node.js and need their own copy.
 */
async function resolveSession(
  client: Client,
  ensemble: string,
  playerName: string,
) {
  const query = `WorkflowType = "claudeSessionWorkflow" AND ExecutionStatus = "Running"`;
  for await (const wf of client.workflow.list({ query })) {
    try {
      const handle = client.workflow.getHandle(wf.workflowId);
      const metadata: SessionMetadata = await handle.query('getMetadata');
      if (metadata.ensemble === ensemble && metadata.playerId === playerName) {
        return handle;
      }
    } catch {
      // Workflow may have just completed — skip
    }
  }
  return null;
}
