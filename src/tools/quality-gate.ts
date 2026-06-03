import { z } from 'zod';
import { WorkflowHandle } from '@temporalio/client';
import { ok, fail, formatError, type TempoToolDescriptor } from './descriptor';
import { GATE_TASK_MAX, GATE_CRITERIA_MAX, GATE_CRITERION_TEXT_MAX } from '../utils/validation';

export function buildQualityGateTool(
  handle: WorkflowHandle,
  getPlayerId: () => string,
): TempoToolDescriptor {
  return {
    name: 'quality_gate',
    description: 'Define or replace a quality gate for a task. Each gate has a list of criteria that must pass before the task is considered complete. Conductor only.',
    params: {
      task: z.string().max(GATE_TASK_MAX).describe('Unique task name for this gate (e.g. "pr-review", "deploy-staging")'),
      criteria: z.array(z.string().max(GATE_CRITERION_TEXT_MAX)).min(1).max(GATE_CRITERIA_MAX).describe('List of criteria that must be evaluated (e.g. ["Tests pass", "No lint errors", "Code reviewed"])'),
    },
    handler: async (args) => {
      const { task, criteria } = args as { task: string; criteria: string[] };
      try {
        await handle.signal('setQualityGate', {
          task,
          criteria,
          createdBy: getPlayerId(),
        });

        const lines = criteria.map((c, i) => `  ${i}. [ ] ${c}`);
        return ok(`Quality gate **${task}** set with ${criteria.length} criteria:\n${lines.join('\n')}`);
      } catch (err) {
        return fail(`Failed to set quality gate: ${formatError(err)}`);
      }
    },
  };
}
