import { z } from 'zod';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { Client } from '@temporalio/client';
import * as os from 'os';
import { Config } from '../config';
import { SessionMetadata } from '../types';
import { scanEnsembleSessions } from '../activities/resolve';
import { defineTool, ok, fail, formatError } from './helpers';

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

      let sessions;
      try {
        sessions = await scanEnsembleSessions(client, config.ensemble);
      } catch (err) {
        return fail(`Error listing workflows: ${formatError(err)}`);
      }

      // Apply scope filters
      let ownGitRoot: string | undefined;
      if (scope === 'repo') {
        try {
          const ownHandle = client.workflow.getHandle(ownWorkflowId);
          const ownMeta: SessionMetadata = await ownHandle.query('getMetadata');
          ownGitRoot = ownMeta.gitRoot;
        } catch {
          // Can't determine own git root — skip repo filtering
        }
      }

      const players = sessions
        .filter((s) => {
          if (scope === 'machine' && s.hostname !== os.hostname()) return false;
          if (scope === 'repo' && ownGitRoot && s.gitRoot !== ownGitRoot) return false;
          return true;
        })
        .map((s) => ({
          ...s,
          isYou: s.playerId === getPlayerId(),
        }));

      if (players.length === 0) {
        return ok('No active sessions found.');
      }

      const lines = players.map((p) => {
        const tags = [
          p.isYou ? '(you)' : '',
          p.isConductor ? '(conductor)' : '',
          p.agentType === 'copilot' ? '[copilot]' : '',
          p.status === 'stale' ? '(stale)' : '',
          p.status === 'pending' ? '(pending)' : '',
          p.status === 'blocked' ? '(blocked)' : '',
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

      return ok(lines.join('\n\n'));
    },
  );
}
