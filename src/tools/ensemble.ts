import { z } from 'zod';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { Client } from '@temporalio/client';
import * as os from 'os';
import { Config } from '../config';
import { SessionMetadata } from '../types';
import { defineTool } from './helpers';

export function registerEnsembleTool(
  server: McpServer,
  client: Client,
  config: Config,
  getPlayerId: () => string,
  ownWorkflowId: string,
) {
  defineTool(
    server,
    'ensemble',
    `Discover active Claude Code sessions in the "${config.ensemble}" ensemble. Returns player IDs, descriptions, and metadata.`,
    {
      scope: z.string().optional().describe('Filter scope: "machine" (same hostname), "repo" (same git root), "all" (default). All scopes are within the current ensemble.'),
    },
    async (args) => {
      const scope = (args.scope ?? 'all') as 'machine' | 'repo' | 'all';
      let query = `WorkflowType = "claudeSessionWorkflow" AND ExecutionStatus = "Running" AND ClaudeTempoEnsemble = "${config.ensemble}"`;

      if (scope === 'machine') {
        query += ` AND ClaudeTempoHostname = "${os.hostname()}"`;
      }

      const players: Array<{
        playerId: string;
        part: string;
        hostname: string;
        workDir: string;
        gitRoot?: string;
        gitBranch?: string;
        isConductor: boolean;
        agentType: string;
        isYou: boolean;
      }> = [];

      try {
        for await (const workflow of client.workflow.list({ query })) {
          try {
            const handle = client.workflow.getHandle(workflow.workflowId);
            const metadata: SessionMetadata = await handle.query('getMetadata');
            const part: string = await handle.query('getPart');

            if (scope === 'repo') {
              const ownHandle = client.workflow.getHandle(ownWorkflowId);
              const ownMeta: SessionMetadata = await ownHandle.query('getMetadata');
              if (metadata.gitRoot !== ownMeta.gitRoot) continue;
            }

            players.push({
              playerId: metadata.playerId,
              part,
              hostname: metadata.hostname,
              workDir: metadata.workDir,
              gitRoot: metadata.gitRoot,
              gitBranch: metadata.gitBranch,
              isConductor: metadata.isConductor,
              agentType: metadata.agentType || 'claude',
              isYou: metadata.playerId === getPlayerId(),
            });
          } catch {
            // Workflow may have just completed — skip it
          }
        }
      } catch (err) {
        return {
          content: [{ type: 'text' as const, text: `Error listing workflows: ${err}` }],
          isError: true,
        };
      }

      if (players.length === 0) {
        return {
          content: [{ type: 'text' as const, text: 'No active sessions found.' }],
        };
      }

      const lines = players.map((p) => {
        const tags = [
          p.isYou ? '(you)' : '',
          p.isConductor ? '(conductor)' : '',
          p.agentType === 'copilot' ? '[copilot]' : '',
        ].filter(Boolean).join(' ');

        return [
          `**${p.playerId}** ${tags}`.trim(),
          `  Part: ${p.part}`,
          `  Dir: ${p.workDir}`,
          p.gitBranch ? `  Branch: ${p.gitBranch}` : '',
          `  Host: ${p.hostname}`,
        ].filter(Boolean).join('\n');
      });

      return {
        content: [{ type: 'text' as const, text: lines.join('\n\n') }],
      };
    },
  );
}
