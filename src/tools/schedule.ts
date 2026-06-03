import { z } from 'zod';
import { Cron } from 'croner';
import { Client, WorkflowIdConflictPolicy } from '@temporalio/client';
import { Config, schedulerWorkflowId } from '../config';
import { parseDuration } from '../utils/duration';
import { resolveSession } from './resolve';
import { ok, fail, formatError, type TempoToolDescriptor } from './descriptor';
import { SCHEDULE_NAME_MAX, SCHEDULE_MESSAGE_MAX, PLAYER_NAME_MAX, CRON_EXPRESSION_MAX } from '../utils/validation';

const log = (...args: unknown[]) => console.error('[agent-tempo:schedule]', ...args);

export function buildScheduleTool(
  client: Client,
  config: Config,
  getPlayerId: () => string,
): TempoToolDescriptor {
  return {
    name: 'schedule',
    description: 'Schedule a message to be sent to a player at a specific time, after a delay, on a recurring interval, or via cron expression.',
    params: {
      name: z.string().max(SCHEDULE_NAME_MAX).describe('Unique name for this schedule'),
      message: z.string().max(SCHEDULE_MESSAGE_MAX).describe('The message to deliver'),
      target: z.string().max(PLAYER_NAME_MAX).describe('Player name to deliver to ("self" = this session)'),
      at: z.string().optional().describe('ISO datetime for one-shot delivery (e.g. "2026-04-03T20:00:00Z")'),
      delay: z.string().optional().describe('Duration until first delivery (e.g. "10m", "2h", "1d")'),
      every: z.string().optional().describe('Recurring interval (e.g. "5m", "1h")'),
      cron: z.string().max(CRON_EXPRESSION_MAX).optional().describe('Cron expression for recurring delivery (e.g. "0 9 * * 1-5" = weekdays at 9am). Mutually exclusive with at/delay/every.'),
      timezone: z.string().optional().describe('IANA timezone for cron evaluation (e.g. "America/New_York"). Defaults to UTC. Only used with cron.'),
      until: z.string().optional().describe('ISO datetime — stop recurring after this time'),
      count: z.number().optional().describe('Max number of deliveries for recurring schedules'),
    },
    handler: async (args) => {
      const { name, message, at, delay, every, cron, timezone, until, count } = args as {
        name: string;
        message: string;
        target: string;
        at?: string;
        delay?: string;
        every?: string;
        cron?: string;
        timezone?: string;
        until?: string;
        count?: number;
      };
      let target = (args as any).target as string;

      // Resolve "self" to the current player name
      if (target === 'self') {
        target = getPlayerId();
      }

      // Validate target player exists (warn, don't block)
      let targetWarning: string | undefined;
      if (target !== 'all' && target !== 'conductor') {
        try {
          const targetHandle = await resolveSession(client, config.ensemble, target);
          if (!targetHandle) {
            targetWarning = `Warning: player "${target}" is not currently active. The schedule will be created but may fail to deliver until the player joins.`;
          }
        } catch {
          // Resolution failed — don't block schedule creation
        }
      }

      // Validate exactly one timing option
      const timingCount = [at, delay, every, cron].filter(Boolean).length;
      if (timingCount !== 1) {
        return fail('Provide exactly one timing option: `at`, `delay`, `every`, or `cron`.');
      }

      // timezone only valid with cron
      if (timezone && !cron) {
        return fail('`timezone` can only be used with `cron`.');
      }

      const now = Date.now();
      let nextFireAt: number;
      let interval: number | undefined;

      if (at) {
        const ts = Date.parse(at);
        if (isNaN(ts)) {
          return fail(`Invalid ISO datetime for "at": ${at}`);
        }
        nextFireAt = ts;
      } else if (delay) {
        const ms = parseDuration(delay);
        if (ms === null) {
          return fail(`Invalid duration for "delay": ${delay}. Use e.g. "30s", "10m", "2h", "1d".`);
        }
        nextFireAt = now + ms;
      } else if (every) {
        // every (recurring interval)
        const ms = parseDuration(every);
        if (ms === null || ms < 10_000) {
          return fail(`Invalid or too-short interval for "every": ${every}. Minimum is 10s.`);
        }
        nextFireAt = now + ms;
        interval = ms;
      } else {
        // cron (recurring via cron expression)
        try {
          const job = new Cron(cron!, { timezone: timezone || 'UTC' });
          const next = job.nextRun();
          if (!next) {
            return fail(`Cron expression "${cron}" has no upcoming fire time.`);
          }
          nextFireAt = next.getTime();
        } catch (err) {
          return fail(`Invalid cron expression "${cron}": ${formatError(err)}`);
        }
      }

      // Parse optional until
      let untilMs: number | undefined;
      if (until) {
        const ts = Date.parse(until);
        if (isNaN(ts)) {
          return fail(`Invalid ISO datetime for "until": ${until}`);
        }
        untilMs = ts;
      }

      const type = cron ? 'cron' : every ? 'interval' : 'once';
      const scheduleEntry = {
        name,
        message,
        target,
        type,
        nextFireAt: new Date(nextFireAt).toISOString(),
        interval,
        cronExpression: cron,
        timezone: cron ? (timezone || 'UTC') : undefined,
        until: untilMs ? new Date(untilMs).toISOString() : undefined,
        remainingCount: count,
        firedCount: 0,
        createdBy: getPlayerId(),
      };

      try {
        const wfId = schedulerWorkflowId(config.ensemble);

        // Try to signal the existing scheduler workflow
        try {
          const handle = client.workflow.getHandle(wfId);
          await handle.describe(); // throws if not running
          await handle.signal('addSchedule', scheduleEntry);
        } catch {
          // Scheduler not running — start it with this schedule as seed
          await client.workflow.start('agentSchedulerWorkflow', {
            workflowId: wfId,
            taskQueue: config.taskQueue,
            args: [{ ensemble: config.ensemble, entries: [scheduleEntry] }],
            workflowIdConflictPolicy: WorkflowIdConflictPolicy.USE_EXISTING,
            searchAttributes: {
              AgentTempoEnsemble: [config.ensemble],
            },
          });
          log(`Started scheduler workflow ${wfId}`);
        }

        const fireDate = new Date(nextFireAt).toISOString();
        const recur = cron
          ? ` (cron: ${cron}, tz: ${timezone || 'UTC'})`
          : interval
            ? ` (repeating every ${every})`
            : ' (one-shot)';
        const msg = `Schedule **${name}** created. Next fire: ${fireDate}${recur}. Target: ${target}.`;
        return ok(targetWarning ? `${msg}\n\n⚠ ${targetWarning}` : msg);
      } catch (err) {
        return fail(`Failed to create schedule: ${formatError(err)}`);
      }
    },
  };
}
