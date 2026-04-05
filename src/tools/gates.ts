import { z } from 'zod';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { WorkflowHandle } from '@temporalio/client';
import { QualityGate } from '../types';
import { defineTool } from './helpers';
import { GATE_TASK_MAX } from '../utils/validation';

export function registerGatesTool(
  server: McpServer,
  handle: WorkflowHandle,
) {
  defineTool(
    server,
    'gates',
    'List quality gates and their status. Optionally filter by task name or status. Conductor only.',
    {
      task: z.string().max(GATE_TASK_MAX).optional().describe('Filter by specific task name'),
      status: z.enum(['open', 'passed', 'failed']).optional().describe('Filter by gate status'),
    },
    async (args) => {
      const { task, status } = args as { task?: string; status?: 'open' | 'passed' | 'failed' };
      try {
        const gates: QualityGate[] = await handle.query('qualityGates');

        let filtered = gates;
        if (task) {
          filtered = filtered.filter((g) => g.task === task);
        }
        if (status) {
          filtered = filtered.filter((g) => g.status === status);
        }

        if (filtered.length === 0) {
          return {
            content: [{ type: 'text' as const, text: 'No quality gates found matching the filter.' }],
          };
        }

        const lines = filtered.map((g) => {
          const icon = g.status === 'passed' ? '\u2705' : g.status === 'failed' ? '\u274c' : '\u23f3';
          const criteriaLines = g.criteria.map((c, i) => {
            const cIcon = c.status === 'passed' ? '\u2705' : c.status === 'failed' ? '\u274c' : '\u2b1c';
            const evaluator = c.evaluatedBy ? ` (by ${c.evaluatedBy})` : '';
            const notes = c.notes ? ` — ${c.notes}` : '';
            return `    ${i}. ${cIcon} ${c.text}${evaluator}${notes}`;
          });
          return `${icon} **${g.task}** [${g.status}] (by ${g.createdBy}, ${g.createdAt})\n${criteriaLines.join('\n')}`;
        });

        return {
          content: [{
            type: 'text' as const,
            text: `${filtered.length} quality gate${filtered.length === 1 ? '' : 's'}:\n\n${lines.join('\n\n')}`,
          }],
        };
      } catch (err) {
        return {
          content: [{ type: 'text' as const, text: `Failed to query gates: ${err}` }],
          isError: true,
        };
      }
    },
  );
}
