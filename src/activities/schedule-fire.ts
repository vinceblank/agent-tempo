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
          // Notify the creator (or conductor as fallback) about the failure
          await notifyFailure(
            client, ensemble, createdBy, scheduleName, target,
            `Player "${target}" not found — session may have been terminated.`,
          );
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
 * Notify the schedule creator (or conductor as fallback) that delivery failed.
 * This lets the creator's AI session decide whether to re-recruit the target.
 */
async function notifyFailure(
  client: Client,
  ensemble: string,
  createdBy: string,
  scheduleName: string,
  target: string,
  reason: string,
) {
  const failureText = `[scheduled: ${scheduleName}] Delivery to "${target}" failed — ${reason}`;

  // Try the creator first
  const creatorHandle = await resolveSession(client, ensemble, createdBy);
  if (creatorHandle) {
    try {
      await creatorHandle.signal('receiveMessage', {
        from: 'scheduler',
        text: failureText,
        isScheduled: true,
        scheduleName,
      });
      return;
    } catch {
      // creator signal failed, fall through to conductor
    }
  }

  // Fallback: notify the conductor
  try {
    const conductorId = `claude-session-${ensemble}-conductor`;
    const conductorHandle = client.workflow.getHandle(conductorId);
    await conductorHandle.signal('receiveMessage', {
      from: 'scheduler',
      text: failureText,
      isScheduled: true,
      scheduleName,
    });
  } catch {
    // Nobody available to notify — logged by the workflow
  }
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
