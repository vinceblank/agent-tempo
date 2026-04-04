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
      // List all running session workflows, then filter by ensemble using
      // in-memory metadata queries. This avoids depending on custom search
      // attributes which are eventually consistent and may be missing/stale.
      const query = `WorkflowType = "claudeSessionWorkflow" AND ExecutionStatus = "Running"`;

      const players: Array<{
        playerId: string;
        part: string;
        hostname: string;
        workDir: string;
        gitRoot?: string;
        gitBranch?: string;
        isConductor: boolean;
        agentType: string;
        playerType?: string;
        status?: string;
        isYou: boolean;
      }> = [];

      try {
        for await (const workflow of client.workflow.list({ query })) {
          try {
            const handle = client.workflow.getHandle(workflow.workflowId);
            const metadata: SessionMetadata = await handle.query('getMetadata');

            // Filter by ensemble
            if (metadata.ensemble !== config.ensemble) continue;

            // Filter by scope
            if (scope === 'machine' && metadata.hostname !== os.hostname()) continue;
            if (scope === 'repo') {
              const ownHandle = client.workflow.getHandle(ownWorkflowId);
              const ownMeta: SessionMetadata = await ownHandle.query('getMetadata');
              if (metadata.gitRoot !== ownMeta.gitRoot) continue;
            }

            const part: string = await handle.query('getPart');

            players.push({
              playerId: metadata.playerId,
              part,
              hostname: metadata.hostname,
              workDir: metadata.workDir,
              gitRoot: metadata.gitRoot,
              gitBranch: metadata.gitBranch,
              isConductor: metadata.isConductor,
              agentType: metadata.agentType || 'claude',
              playerType: metadata.playerType,
              status: metadata.status,
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
          p.status === 'stale' ? '(stale)' : '',
          p.status === 'pending' ? '(pending)' : '',
        ].filter(Boolean).join(' ');

        const nameDisplay = p.playerType
          ? `**${p.playerId}** (${p.playerType})`
          : `**${p.playerId}**`;

        return [
          `${nameDisplay} ${tags}`.trim(),
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
