/**
 * `detach` — graceful reap of a session's adapter without destroying the workflow.
 *
 * Thin wrapper over the `requestDetachSignal` primitive (PR-A). Transitions the
 * target's phase to `draining`; its main loop reaps to `detached` when the outbox
 * drains or `deadlineMs` elapses (whichever comes first). Workflow survives —
 * use `restart` to attach a new adapter later, or `destroy` to terminate permanently.
 *
 * Design reference: §8.1 (three verbs), §2.4 (phase transitions).
 */
import { z } from 'zod';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { Client } from '@temporalio/client';
import { Config } from '../config';
import type { AttachmentInfo } from '../types';
import { resolveSession } from './resolve';
import { attachmentInfoQuery, requestDetachSignal } from '../workflows/signals';
import { defineTool, ok, fail, formatError } from './helpers';
import { PLAYER_NAME_MAX, validatePlayerName } from '../utils/validation';

const DEFAULT_DETACH_DEADLINE_MS = 5_000;
const MAX_DETACH_DEADLINE_MS = 120_000;

export function registerDetachTool(
  server: McpServer,
  client: Client,
  config: Config,
  getPlayerId: () => string,
) {
  defineTool(
    server,
    'detach',
    'Gracefully detach a session\'s adapter. The session enters `draining` phase and reaps to `detached` after the deadline or when the adapter exits. The workflow survives — use `restart` to attach a new adapter, or `destroy` to terminate permanently.',
    {
      playerId: z.string().max(PLAYER_NAME_MAX).describe('The player name to detach'),
      deadlineMs: z.number().min(0).max(MAX_DETACH_DEADLINE_MS).optional().describe(`Max drain time in ms before force-detach (default ${DEFAULT_DETACH_DEADLINE_MS})`),
    },
    async (args) => {
      const { playerId, deadlineMs = DEFAULT_DETACH_DEADLINE_MS } = args as {
        playerId: string;
        deadlineMs?: number;
      };

      const nameError = validatePlayerName(playerId);
      if (nameError) return fail(nameError);

      if (playerId === getPlayerId()) {
        return fail('Cannot detach your own session.');
      }

      try {
        const resolved = await resolveSession(client, config.ensemble, playerId);
        if (!resolved) return fail(`No session found with name "${playerId}".`);

        const info = await resolved.query(attachmentInfoQuery) as AttachmentInfo;
        if (info.phase === 'detached') return ok(`**${playerId}** is already detached.`);
        if (info.phase === 'gone') {
          return fail(`**${playerId}** is destroyed; detach does not apply. Use \`recruit\` to start a fresh session.`);
        }

        await resolved.signal(requestDetachSignal, {
          reason: 'user-stop',
          deadlineMs,
        });

        return ok(`Detach signaled for **${playerId}** — draining up to ${deadlineMs}ms (phase: ${info.phase} → draining).`);
      } catch (err) {
        return fail(`Failed to detach: ${formatError(err)}`);
      }
    },
  );
}
