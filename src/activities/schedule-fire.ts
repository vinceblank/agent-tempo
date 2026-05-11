import { Client } from '@temporalio/client';
import { Cron } from 'croner';
import { conductorWorkflowId } from '../config';
import { SessionMetadata } from '../types';
import { resolveSession } from './resolve';
import {
  iterateWithDeadline,
  isVisibilityTimeout,
  VISIBILITY_DEADLINES_MS,
} from '../utils/visibility-deadline';

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
  /**
   * #336/#529 — when `target === 'all'`, true if the visibility iterator
   * hit its deadline before enumerating every running session. The
   * caller (schedule workflow / TUI surface) renders a "partial
   * delivery — scan timed out" notice rather than implying every
   * player received the message.
   */
  timedOut?: boolean;
  /** #336/#529 — entries actually scanned before deadline or completion. */
  scanned?: number;
}

export interface ComputeNextCronInput {
  cronExpression: string;
  timezone?: string;
}

/** Activity interface — used by proxyActivities in the scheduler workflow. */
export interface ScheduleActivities {
  fireSchedule(input: FireScheduleInput): Promise<FireScheduleResult>;
  computeNextCronFire(input: ComputeNextCronInput): Promise<string | null>;
}

/**
 * Create the schedule-fire activity bound to a Temporal client.
 * The returned object is registered with the worker as activities.
 */
export function createScheduleActivities(client: Client): ScheduleActivities {
  return {
    async computeNextCronFire(input: ComputeNextCronInput): Promise<string | null> {
      const job = new Cron(input.cronExpression, { timezone: input.timezone || 'UTC' });
      const next = job.nextRun();
      return next ? next.toISOString() : null;
    },

    async fireSchedule(input: FireScheduleInput): Promise<FireScheduleResult> {
      const { ensemble, scheduleName, message, target, createdBy } = input;

      try {
        const text = `[scheduled: ${scheduleName}] ${message}`;

        // Handle target "all" — deliver to every active player except the conductor
        if (target === 'all') {
          const query = `WorkflowType = "claudeSessionWorkflow" AND ExecutionStatus = "Running"`;
          const failures: string[] = [];
          let delivered = 0;
          let scanned = 0;
          let timedOut = false;

          // #336/#529 — bound the visibility iterator. `target='all'` is
          // a structured-outcome site: a partial scan would silently
          // violate the "deliver to every player" semantic, so we carry
          // `timedOut` into the result.
          try {
            for await (const wf of iterateWithDeadline(
              client.workflow.list({ query }),
              VISIBILITY_DEADLINES_MS.fireScheduleAll,
              'fireScheduleAll',
            )) {
              scanned++;
              try {
                const handle = client.workflow.getHandle(wf.workflowId);
                const metadata: SessionMetadata = await handle.query('getMetadata');
                if (metadata.ensemble !== ensemble) continue;
                if (metadata.isConductor) continue; // skip conductor

                await handle.signal('receiveMessage', {
                  from: createdBy,
                  text,
                  isScheduled: true,
                  scheduleName,
                  responseRequested: false,
                });
                delivered++;
              } catch (err) {
                const msg = err instanceof Error ? err.message : String(err);
                failures.push(`${wf.workflowId}: ${msg}`);
              }
            }
          } catch (err) {
            if (isVisibilityTimeout(err)) {
              timedOut = true;
              // Mark the partial-delivery failure mode so the caller's
              // notification surface can describe it accurately.
              failures.push(`scan deadline (${err.deadlineMs}ms) exceeded after ${err.partialCount} entries`);
            } else {
              throw err;
            }
          }

          if (delivered === 0 && failures.length === 0) {
            await notifyFailure(
              client, ensemble, createdBy, scheduleName, target,
              'No active players found in the ensemble.',
            );
            return { success: false, error: 'No active players found', scanned, timedOut };
          }

          return {
            success: !timedOut && failures.length === 0,
            error: failures.length > 0
              ? (timedOut
                ? `Delivered to ${delivered} players, scan timed out before completion: ${failures.join('; ')}`
                : `Delivered to ${delivered} players, ${failures.length} failed: ${failures.join('; ')}`)
              : undefined,
            scanned,
            ...(timedOut ? { timedOut: true } : {}),
          };
        }

        // Resolve single target player by querying running session workflows
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
        await handle.signal('receiveMessage', {
          from: createdBy,
          text,
          isScheduled: true,
          scheduleName,
          responseRequested: false,
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
        responseRequested: false,
      });
      return;
    } catch {
      // creator signal failed, fall through to conductor
    }
  }

  // Fallback: notify the conductor
  try {
    const conductorId = conductorWorkflowId(ensemble);
    const conductorHandle = client.workflow.getHandle(conductorId);
    await conductorHandle.signal('receiveMessage', {
      from: 'scheduler',
      text: failureText,
      isScheduled: true,
      responseRequested: false,
      scheduleName,
    });
  } catch {
    // Nobody available to notify — logged by the workflow
  }
}
