import { WorkflowHandle } from '@temporalio/client';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { SessionMetadata } from '../types';
import { defineTool } from './helpers';

export function registerWhoAmITool(
  server: McpServer,
  handle: WorkflowHandle,
  getPlayerId: () => string,
) {
  defineTool(server, 'who_am_i', 'Get your identity, role, and session details', {}, async () => {
    const metadata: SessionMetadata = await handle.query('getMetadata');
    const part: string = await handle.query('getPart');

    const lines = [
      `**Name:** ${metadata.playerId}`,
      metadata.playerType ? `**Type:** ${metadata.playerType}` : null,
      metadata.playerTypeDescription ? `**Description:** ${metadata.playerTypeDescription}` : null,
      `**Ensemble:** ${metadata.ensemble}`,
      `**Role:** ${metadata.isConductor ? 'Conductor' : 'Player'}`,
      metadata.recruitedBy ? `**Recruited by:** ${metadata.recruitedBy}` : null,
      `**Part:** ${part}`,
      `**Directory:** ${metadata.workDir}`,
      `**Host:** ${metadata.hostname}`,
      metadata.gitBranch ? `**Branch:** ${metadata.gitBranch}` : null,
      `**Status:** ${metadata.status || 'active'}`,
    ].filter(Boolean);

    return { content: [{ type: 'text' as const, text: lines.join('\n') }] };
  });
}
