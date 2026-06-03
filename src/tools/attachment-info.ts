/**
 * `attachment_info` — diagnostic query for the V2 attachment lifecycle (design §§2.2, 2.4).
 *
 * Thin wrapper over the `attachmentInfoQuery` primitive (PR-A). Read-only; does not
 * mutate state. Used by operators + the TUI to inspect a session's phase, current
 * attachment holder, preferred host, and in-flight count.
 */
import { z } from 'zod';
import { Client } from '@temporalio/client';
import { Config } from '../config';
import type { AttachmentInfo } from '../types';
import { resolveSession } from './resolve';
import { attachmentInfoQuery } from '../workflows/signals';
import { ok, fail, formatError, type TempoToolDescriptor } from './descriptor';
import { PLAYER_NAME_MAX, validatePlayerName } from '../utils/validation';

export function buildAttachmentInfoTool(
  client: Client,
  config: Config,
): TempoToolDescriptor {
  return {
    name: 'attachment_info',
    description: 'Query the V2 attachment lifecycle state of a session — phase (booting/attached/processing/awaiting/draining/detached/gone), current attachment holder (host + adapter + lease expiry), preferred host, and in-flight message count. Read-only diagnostic.',
    params: {
      playerId: z.string().max(PLAYER_NAME_MAX).describe('The player name to inspect'),
    },
    handler: async (args) => {
      const { playerId } = args as { playerId: string };

      const nameError = validatePlayerName(playerId);
      if (nameError) return fail(nameError);

      try {
        const resolved = await resolveSession(client, config.ensemble, playerId);
        if (!resolved) return fail(`No session found with name "${playerId}".`);

        const info = await resolved.query(attachmentInfoQuery) as AttachmentInfo;

        const lines: string[] = [
          `**${playerId}** — phase: \`${info.phase}\``,
          `in-flight messages: ${info.inFlightCount}`,
        ];
        if (info.currentAttachment) {
          const a = info.currentAttachment;
          lines.push(
            `attached on: **${a.hostname}** (adapter: ${a.adapterId}/${a.adapterClass}, attachmentId: \`${a.attachmentId.slice(0, 8)}…\`)`,
          );
          lines.push(`lease expires: ${a.expiresAt}`);
        }
        if (info.preferredHost) lines.push(`preferred host: ${info.preferredHost}`);
        if (info.processingSince) lines.push(`processing since: ${info.processingSince}`);

        return ok(lines.join('\n'));
      } catch (err) {
        return fail(`Failed to query attachment info: ${formatError(err)}`);
      }
    },
  };
}
