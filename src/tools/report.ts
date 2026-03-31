import { z } from 'zod';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { Client } from '@temporalio/client';
import { Config, conductorWorkflowId } from '../config';
import { resolveSession } from './resolve';
import { defineTool } from './helpers';

export function registerReportTool(
  server: McpServer,
  client: Client,
  config: Config,
  getPlayerId: () => string,
) {
  defineTool(
    server,
    'report',
    'Send an update to the conductor. Use this to report task completion, blockers, or questions. No-op if no conductor is running.',
    {
      text: z.string().describe('The report content'),
      type: z.string().optional()
        .describe('Type of report: "result" (default, task done), "blocker" (stuck), "question" (need input)'),
    },
    async (args) => {
      const text = args.text as string;
      const type = (args.type ?? 'result') as 'result' | 'blocker' | 'question';
      try {
        const conductorHandle = client.workflow.getHandle(conductorWorkflowId(config.ensemble));
        await conductorHandle.signal('playerReport', {
          playerId: getPlayerId(),
          text,
          type,
        });

        // Record outbound on sender's own workflow
        try {
          const senderHandle = await resolveSession(client, config.ensemble, getPlayerId());
          if (senderHandle) {
            await senderHandle.signal('recordSentMessage', { to: 'conductor', text: `[${type}] ${text}` });
          }
        } catch {
          // Don't block the report if recording fails
        }

        return {
          content: [{ type: 'text' as const, text: `Report sent to conductor: [${type}] ${text}` }],
        };
      } catch {
        return {
          content: [{ type: 'text' as const, text: 'No conductor running. Report not sent (this is normal for peer-only ensembles).' }],
        };
      }
    },
  );
}
