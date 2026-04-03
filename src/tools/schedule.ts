import { z } from 'zod';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { Client, WorkflowIdConflictPolicy } from '@temporalio/client';
import { Config, schedulerWorkflowId } from '../config';
import { defineTool } from './helpers';

const log = (...args: unknown[]) => console.error('[claude-tempo:schedule]', ...args);

/** Parse a duration string like "30s", "10m", "2h", "1d" into milliseconds. */
function parseDuration(dur: string): number | null {
  const match = dur.match(/^(\d+(?:\.\d+)?)\s*(s|m|h|d)$/i);
  if (!match) return null;
  const value = parseFloat(match[1]);
  switch (match[2].toLowerCase()) {
    case 's': return value * 1000;
    case 'm': return value * 60_000;
    case 'h': return value * 3_600_000;
    case 'd': return value * 86_400_000;
    default: return null;
  }
}

export function registerScheduleTool(
  server: McpServer,
  client: Client,
  config: Config,
  getPlayerId: () => string,
) {
  defineTool(
    server,
    'schedule',
    'Schedule a message to be sent to a player at a specific time, after a delay, or on a recurring interval.',
    {
      name: z.string().describe('Unique name for this schedule'),
      message: z.string().describe('The message to deliver'),
      target: z.string().describe('Player name to deliver to ("self" = this session)'),
      at: z.string().optional().describe('ISO datetime for one-shot delivery (e.g. "2026-04-03T20:00:00Z")'),
      delay: z.string().optional().describe('Duration until first delivery (e.g. "10m", "2h", "1d")'),
      every: z.string().optional().describe('Recurring interval (e.g. "5m", "1h")'),
      until: z.string().optional().describe('ISO datetime — stop recurring after this time'),
      count: z.number().optional().describe('Max number of deliveries for recurring schedules'),
    },
    async (args) => {
      const { name, message, at, delay, every, until, count } = args as {
        name: string;
        message: string;
        target: string;
        at?: string;
        delay?: string;
        every?: string;
        until?: string;
        count?: number;
      };
      let target = (args as any).target as string;

      // Resolve "self" to the current player name
      if (target === 'self') {
        target = getPlayerId();
      }

      // Validate exactly one timing option
      const timingCount = [at, delay, every].filter(Boolean).length;
      if (timingCount !== 1) {
        return {
          content: [{
            type: 'text' as const,
            text: 'Provide exactly one timing option: `at`, `delay`, or `every`.',
          }],
          isError: true,
        };
      }

      const now = Date.now();
      let nextFireAt: number;
      let interval: number | undefined;

      if (at) {
        const ts = Date.parse(at);
        if (isNaN(ts)) {
          return {
            content: [{ type: 'text' as const, text: `Invalid ISO datetime for "at": ${at}` }],
            isError: true,
          };
        }
        nextFireAt = ts;
      } else if (delay) {
        const ms = parseDuration(delay);
        if (ms === null) {
          return {
            content: [{ type: 'text' as const, text: `Invalid duration for "delay": ${delay}. Use e.g. "30s", "10m", "2h", "1d".` }],
            isError: true,
          };
        }
        nextFireAt = now + ms;
      } else {
        // every (recurring)
        const ms = parseDuration(every!);
        if (ms === null) {
          return {
            content: [{ type: 'text' as const, text: `Invalid duration for "every": ${every}. Use e.g. "30s", "10m", "2h", "1d".` }],
            isError: true,
          };
        }
        nextFireAt = now + ms;
        interval = ms;
      }

      // Parse optional until
      let untilMs: number | undefined;
      if (until) {
        const ts = Date.parse(until);
        if (isNaN(ts)) {
          return {
            content: [{ type: 'text' as const, text: `Invalid ISO datetime for "until": ${until}` }],
            isError: true,
          };
        }
        untilMs = ts;
      }

      const type = every ? 'interval' : 'once';
      const scheduleEntry = {
        name,
        message,
        target,
        type,
        nextFireAt: new Date(nextFireAt).toISOString(),
        interval,
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
          await client.workflow.start('claudeSchedulerWorkflow', {
            workflowId: wfId,
            taskQueue: config.taskQueue,
            args: [{ ensemble: config.ensemble, entries: [scheduleEntry] }],
            workflowIdConflictPolicy: WorkflowIdConflictPolicy.USE_EXISTING,
            searchAttributes: {
              ClaudeTempoEnsemble: [config.ensemble],
            },
          });
          log(`Started scheduler workflow ${wfId}`);
        }

        const fireDate = new Date(nextFireAt).toISOString();
        const recur = interval ? ` (repeating every ${every})` : ' (one-shot)';
        return {
          content: [{
            type: 'text' as const,
            text: `Schedule **${name}** created. Next fire: ${fireDate}${recur}. Target: ${target}.`,
          }],
        };
      } catch (err) {
        return {
          content: [{ type: 'text' as const, text: `Failed to create schedule: ${err}` }],
          isError: true,
        };
      }
    },
  );
}
