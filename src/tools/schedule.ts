import { z } from 'zod';
import { Cron } from 'croner';
import { Client, WorkflowIdConflictPolicy } from '@temporalio/client';
import { Config, schedulerWorkflowId } from '../config';
import { WORKFLOW_TASK_TIMEOUT } from '../constants';
import { parseDuration } from '../utils/duration';
import { resolveSession } from './resolve';
import { ok, fail, formatError, type TempoToolDescriptor } from './descriptor';
import { firstMissing } from './action-guard';
import { buildUnscheduleTool } from './unschedule';
import { buildSchedulesTool } from './schedules';
import { SCHEDULE_NAME_MAX, SCHEDULE_MESSAGE_MAX, PLAYER_NAME_MAX, CRON_EXPRESSION_MAX } from '../utils/validation';

const log = (...args: unknown[]) => console.error('[agent-tempo:schedule]', ...args);

/**
 * Internal create-only descriptor (the legacy bare-`schedule` behaviour). Its
 * `.handler` is reused verbatim by the canonical {@link buildScheduleTool}
 * dispatch under `action="create"`. Not exported — the canonical tool is the
 * public surface.
 */
function buildScheduleCreateTool(
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
            workflowTaskTimeout: WORKFLOW_TASK_TIMEOUT, // PR-A 2026-07-13 incident — see constants.ts
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

/**
 * Canonical `schedule` tool (#793 merge) — **reused** name, so `action` defaults
 * to `'create'` for backward-compat (existing callers omit `action` → the legacy
 * bare-`schedule` create behaviour). Actions: `create | cancel | list`.
 *
 * The rich one-of timing validation lives in the create handler (reused
 * verbatim); `cancel` reuses `unschedule`, `list` reuses `schedules`. The legacy
 * `unschedule` / `schedules` names stay registered as forwarding aliases
 * ({@link buildScheduleAliasTools}); there is no alias for `create` — the bare
 * `schedule` IS create.
 */
export function buildScheduleTool(
  client: Client,
  config: Config,
  getPlayerId: () => string,
): TempoToolDescriptor {
  const create = buildScheduleCreateTool(client, config, getPlayerId);
  const cancel = buildUnscheduleTool(client, config);
  const list = buildSchedulesTool(client, config);

  return {
    name: 'schedule',
    description:
      'Schedule messages to players (one-shot, delay, recurring, or cron). ' +
      'action="create" (default) schedules a message (name+message+target + one timing of at/delay/every/cron); ' +
      'action="cancel" removes a named schedule; ' +
      'action="list" shows all active schedules.',
    params: {
      action: z.enum(['create', 'cancel', 'list']).optional().describe('Which schedule operation to perform (defaults to "create" when omitted)'),
      // create:
      name: z.string().max(SCHEDULE_NAME_MAX).optional().describe('create/cancel: unique name for this schedule'),
      message: z.string().max(SCHEDULE_MESSAGE_MAX).optional().describe('create: the message to deliver'),
      target: z.string().max(PLAYER_NAME_MAX).optional().describe('create: player to deliver to ("self" = this session)'),
      at: z.string().optional().describe('create: ISO datetime for one-shot delivery'),
      delay: z.string().optional().describe('create: duration until first delivery (e.g. "10m", "2h", "1d")'),
      every: z.string().optional().describe('create: recurring interval (e.g. "5m", "1h")'),
      cron: z.string().max(CRON_EXPRESSION_MAX).optional().describe('create: cron expression. Mutually exclusive with at/delay/every.'),
      timezone: z.string().optional().describe('create: IANA timezone for cron evaluation (default UTC). Only with cron.'),
      until: z.string().optional().describe('create: ISO datetime — stop recurring after this time'),
      count: z.number().optional().describe('create: max number of deliveries for recurring schedules'),
    },
    handler: async (args) => {
      const action = (args.action as 'create' | 'cancel' | 'list' | undefined) ?? 'create';
      switch (action) {
        case 'create': {
          const m = firstMissing(args, ['name', 'message', 'target']);
          if (m) return fail(`schedule action="create" requires "${m}".`);
          return create.handler(args);
        }
        case 'cancel': {
          const m = firstMissing(args, ['name']);
          if (m) return fail(`schedule action="cancel" requires "${m}".`);
          return cancel.handler(args);
        }
        case 'list':
          return list.handler(args);
        default:
          return fail(`Unknown schedule action: ${String(action)}. Expected create | cancel | list.`);
      }
    },
  };
}

/**
 * Legacy forwarding aliases — `unschedule` → cancel, `schedules` → list. Each
 * keeps its exact original schema + handler; description gains a deprecation
 * note. No alias for `create` — the bare `schedule` IS create. Explicit object
 * literals (see #793 brief §6 drift note).
 */
export function buildScheduleAliasTools(
  client: Client,
  config: Config,
): TempoToolDescriptor[] {
  const cancel = buildUnscheduleTool(client, config);
  const list = buildSchedulesTool(client, config);

  return [
    {
      name: 'unschedule',
      description: 'DEPRECATED — use `schedule` with action="cancel". ' + cancel.description,
      params: cancel.params,
      handler: cancel.handler,
    },
    {
      name: 'schedules',
      description: 'DEPRECATED — use `schedule` with action="list". ' + list.description,
      params: list.params,
      handler: list.handler,
    },
  ];
}
