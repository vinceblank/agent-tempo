import { z } from 'zod';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { WorkflowHandle } from '@temporalio/client';
import { defineTool } from './helpers';
import { GATE_TASK_MAX, GATE_CRITERIA_MAX, GATE_CRITERION_TEXT_MAX } from '../utils/validation';

export function registerQualityGateTool(
  server: McpServer,
  handle: WorkflowHandle,
  getPlayerId: () => string,
) {
  defineTool(
    server,
    'quality_gate',
    'Define or replace a quality gate for a task. Each gate has a list of criteria that must pass before the task is considered complete. Conductor only.',
    {
      task: z.string().max(GATE_TASK_MAX).describe('Unique task name for this gate (e.g. "pr-review", "deploy-staging")'),
      criteria: z.array(z.string().max(GATE_CRITERION_TEXT_MAX)).min(1).max(GATE_CRITERIA_MAX).describe('List of criteria that must be evaluated (e.g. ["Tests pass", "No lint errors", "Code reviewed"])'),
    },
    async (args) => {
      const { task, criteria } = args as { task: string; criteria: string[] };
      try {
        await handle.signal('setQualityGate', {
          task,
          criteria,
          createdBy: getPlayerId(),
        });

        const lines = criteria.map((c, i) => `  ${i}. [ ] ${c}`);
        return {
          content: [{
            type: 'text' as const,
            text: `Quality gate **${task}** set with ${criteria.length} criteria:\n${lines.join('\n')}`,
          }],
        };
      } catch (err) {
        return {
          content: [{ type: 'text' as const, text: `Failed to set quality gate: ${err}` }],
          isError: true,
        };
      }
    },
  );
}
