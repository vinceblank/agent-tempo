import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { WorkflowHandle } from '@temporalio/client';
import { defineTool } from './helpers';
import type { StageEntry } from '../types';

export function registerStagesTool(
  server: McpServer,
  handle: WorkflowHandle,
) {
  defineTool(
    server,
    'stages',
    'List all pipeline stages and their status. Shows which players have reported, who is still waiting, and stage completion status. Conductor only.',
    {},
    async () => {
      try {
        const stages: StageEntry[] = await handle.query('stages');

        if (stages.length === 0) {
          return {
            content: [{ type: 'text' as const, text: 'No stages defined.' }],
          };
        }

        const lines = stages.map((s) => {
          const statusIcon = s.status === 'complete' ? '\u2714'
            : s.status === 'failed' ? '\u2718'
            : s.status === 'cancelled' ? '\u2212'
            : '\u25CB';

          const playerLines = s.players.map((p) => {
            const pIcon = p.status === 'reported' ? '\u2714'
              : p.status === 'blocked' ? '\u2718'
              : '\u25CB';
            const detail = p.reportedAt ? ` (${p.reportType})` : '';
            return `    ${pIcon} ${p.playerId}${detail}`;
          });

          return [
            `${statusIcon} **${s.name}** [${s.status}] (policy: ${s.failurePolicy})`,
            ...playerLines,
          ].join('\n');
        });

        return {
          content: [{ type: 'text' as const, text: lines.join('\n\n') }],
        };
      } catch (err) {
        return {
          content: [{ type: 'text' as const, text: `Failed to query stages: ${err}` }],
          isError: true,
        };
      }
    },
  );
}
