import { z } from 'zod';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { WorkflowHandle } from '@temporalio/client';
import { defineTool } from './helpers';
import { GATE_TASK_MAX, GATE_NOTES_MAX } from '../utils/validation';

export function registerEvaluateGateTool(
  server: McpServer,
  handle: WorkflowHandle,
  getPlayerId: () => string,
) {
  defineTool(
    server,
    'evaluate_gate',
    'Mark one or more criteria on a quality gate as passed or failed. Conductor only.',
    {
      task: z.string().max(GATE_TASK_MAX).describe('The task name of the gate to evaluate'),
      evaluations: z.array(z.object({
        index: z.number().int().min(0).describe('Zero-based index of the criterion'),
        status: z.enum(['passed', 'failed']).describe('Whether this criterion passed or failed'),
        notes: z.string().max(GATE_NOTES_MAX).optional().describe('Optional notes explaining the evaluation'),
      })).min(1).describe('List of criterion evaluations'),
    },
    async (args) => {
      const { task, evaluations } = args as {
        task: string;
        evaluations: Array<{ index: number; status: 'passed' | 'failed'; notes?: string }>;
      };
      try {
        await handle.signal('evaluateGateCriteria', {
          task,
          evaluations,
          evaluatedBy: getPlayerId(),
        });

        const summary = evaluations
          .map((ev) => `  ${ev.index}: ${ev.status === 'passed' ? '\u2705' : '\u274c'} ${ev.status}${ev.notes ? ` — ${ev.notes}` : ''}`)
          .join('\n');
        return {
          content: [{
            type: 'text' as const,
            text: `Evaluated ${evaluations.length} criteria on gate **${task}**:\n${summary}`,
          }],
        };
      } catch (err) {
        return {
          content: [{ type: 'text' as const, text: `Failed to evaluate gate: ${err}` }],
          isError: true,
        };
      }
    },
  );
}
