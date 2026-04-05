import { z } from 'zod';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { WorkflowHandle } from '@temporalio/client';
import { submitOutboxUpdate } from '../workflows/signals';
import type { OutboxEntryInput } from '../types';
import { defineTool } from './helpers';
import { MESSAGE_MAX } from '../utils/validation';

export function registerReportTool(
  server: McpServer,
  handle: WorkflowHandle,
) {
  defineTool(
    server,
    'report',
    'Send an update to the conductor. Use this to report task completion, blockers, or questions. No-op if no conductor is running.',
    {
      text: z.string().max(MESSAGE_MAX).describe('The report content'),
      type: z.enum(['result', 'blocker', 'question']).optional()
        .describe('Type of report: "result" (default, task done), "blocker" (stuck), "question" (need input)'),
    },
    async (args) => {
      const text = args.text as string;
      const type = (args.type ?? 'result') as 'result' | 'blocker' | 'question';
      try {
        const entry = {
          type: 'report',
          text,
          reportType: type,
        } as OutboxEntryInput;
        const entryId = await handle.executeUpdate(submitOutboxUpdate, { args: [entry] });

        return {
          content: [{ type: 'text' as const, text: `Report sent to conductor: [${type}] ${text} (outbox: ${entryId})` }],
        };
      } catch (err) {
        return {
          content: [{ type: 'text' as const, text: `Failed to send report: ${err}` }],
          isError: true,
        };
      }
    },
  );
}
