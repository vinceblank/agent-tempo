import { z } from 'zod';
import { WorkflowHandle } from '@temporalio/client';
import { submitOutboxUpdate } from '../workflows/signals';
import type { OutboxEntryInput } from '../types';
import { ok, fail, formatError, type TempoToolDescriptor } from './descriptor';
import { MESSAGE_MAX } from '../utils/validation';

export function buildReportTool(handle: WorkflowHandle): TempoToolDescriptor {
  return {
    name: 'report',
    description:
      'Send an update to the conductor. Use this to report task completion, blockers, or questions. No-op if no conductor is running.',
    params: {
      text: z.string().max(MESSAGE_MAX).describe('The report content'),
      type: z.enum(['result', 'blocker', 'question', 'update']).optional()
        .describe('Type of report: "result" (default, task done), "blocker" (stuck), "question" (need input), "update" (progress update, still working)'),
    },
    handler: async (args) => {
      const text = args.text as string;
      const type = (args.type ?? 'result') as 'result' | 'blocker' | 'question' | 'update';
      try {
        const entry = {
          type: 'report',
          text,
          reportType: type,
        } as OutboxEntryInput;
        const entryId = await handle.executeUpdate(submitOutboxUpdate, { args: [entry] });

        return ok(`Report sent to conductor: [${type}] ${text} (outbox: ${entryId})`);
      } catch (err) {
        return fail(`Failed to send report: ${formatError(err)}`);
      }
    },
  };
}
