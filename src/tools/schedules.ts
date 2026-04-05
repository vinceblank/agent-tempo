import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { Client } from '@temporalio/client';
import { Config, schedulerWorkflowId } from '../config';
import { defineTool } from './helpers';

import type { ScheduleEntry } from '../types';

function formatDuration(ms: number): string {
  if (ms >= 86_400_000) return `${ms / 86_400_000}d`;
  if (ms >= 3_600_000) return `${ms / 3_600_000}h`;
  if (ms >= 60_000) return `${ms / 60_000}m`;
  return `${ms / 1000}s`;
}

export function registerSchedulesTool(
  server: McpServer,
  client: Client,
  config: Config,
) {
  defineTool(
    server,
    'schedules',
    'List all active schedules in this ensemble.',
    {},
    async () => {
      try {
        const wfId = schedulerWorkflowId(config.ensemble);
        const handle = client.workflow.getHandle(wfId);

        let schedules: ScheduleEntry[];
        try {
          schedules = await handle.query('getSchedules');
        } catch {
          return {
            content: [{
              type: 'text' as const,
              text: 'No scheduler running — no schedules exist yet.',
            }],
          };
        }

        if (schedules.length === 0) {
          return {
            content: [{
              type: 'text' as const,
              text: 'No active schedules.',
            }],
          };
        }

        const lines = schedules.map((s) => {
          const next = s.nextFireAt; // already ISO string
          const recur = s.cronExpression
            ? `cron: ${s.cronExpression} (${s.timezone || 'UTC'})`
            : s.interval ? `every ${formatDuration(s.interval)}` : 'one-shot';
          const bounds: string[] = [];
          if (s.until) bounds.push(`until ${s.until}`);
          if (s.remainingCount != null) bounds.push(`${s.firedCount}/${s.firedCount + s.remainingCount} fired`);
          const boundsStr = bounds.length ? ` (${bounds.join(', ')})` : '';
          const msgPreview = s.message.length > 60 ? s.message.slice(0, 57) + '...' : s.message;
          return `• **${s.name}** → ${s.target} | ${recur}${boundsStr} | next: ${next}\n  msg: ${msgPreview}`;
        });

        return {
          content: [{
            type: 'text' as const,
            text: lines.join('\n'),
          }],
        };
      } catch (err) {
        return {
          content: [{ type: 'text' as const, text: `Failed to query schedules: ${err}` }],
          isError: true,
        };
      }
    },
  );
}
