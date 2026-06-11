import { Client, WorkflowHandle } from '@temporalio/client';
import { Config } from '../config';
import { SessionMetadata, AttachmentInfo } from '../types';
import { ok, type TempoToolDescriptor } from './descriptor';
import { checkSuspension, formatSuspensionBanner } from '../utils/suspension';

export function buildWhoAmITool(
  client: Client,
  config: Config,
  handle: WorkflowHandle,
  getPlayerId: () => string,
): TempoToolDescriptor {
  return {
    name: 'who_am_i',
    description: 'Get your identity, role, and session details',
    params: {},
    handler: async () => {
    // #752: suspension banner pre-flight (ensemble paused + own paused/held),
    // concurrent with the identity queries. Soft-fails to "not suspended".
    const suspensionPromise = checkSuspension(client, config.ensemble, { self: handle });

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

    // #752: PAUSED/HELD banner leads the output so it can't be missed.
    const banner = formatSuspensionBanner(await suspensionPromise, config.ensemble);
    const body = lines.join('\n');
    return ok(banner ? `${banner}\n\n${body}` : body);
    },
  };
}
