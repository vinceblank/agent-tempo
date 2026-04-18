import { WorkflowHandle } from '@temporalio/client';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { SessionMetadata, AttachmentInfo } from '../types';
import { defineTool, ok } from './helpers';

export function registerWhoAmITool(
  server: McpServer,
  handle: WorkflowHandle,
  getPlayerId: () => string,
) {
  defineTool(server, 'who_am_i', 'Get your identity, role, and session details', {}, async () => {
    const metadata: SessionMetadata = await handle.query('getMetadata');
    const part: string = await handle.query('getPart');

    // Attachment phase is authoritative post-#175/#176 (replaced legacy status).
    let phase: string | undefined;
    try {
      const info: AttachmentInfo = await handle.query('attachmentInfo');
      phase = info.phase;
    } catch {
      // Older workflows pre-dating the attachment lifecycle may not support this query.
      phase = undefined;
    }

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
      `**Phase:** ${phase ?? 'unknown'}`,
    ].filter(Boolean);

    return ok(lines.join('\n'));
  });
}
