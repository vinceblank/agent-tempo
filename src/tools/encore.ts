import { z } from 'zod';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { Client, WorkflowHandle } from '@temporalio/client';
import { Config } from '../config';
import { SessionMetadata } from '../types';
import { resolveSession } from './resolve';
import { submitOutboxUpdate } from '../workflows/signals';
import type { OutboxEntryInput } from '../types';
import { defineTool, ok, fail, formatError } from './helpers';
import { PLAYER_NAME_MAX, validatePlayerName } from '../utils/validation';

export function registerEncoreTool(
  server: McpServer,
  client: Client,
  config: Config,
  getPlayerId: () => string,
  handle: WorkflowHandle,
) {
  defineTool(
    server,
    'encore',
    'Revive a stale player session — restarts the Claude process and reconnects to the existing workflow with conversation context restored.',
    {
      playerId: z.string().max(PLAYER_NAME_MAX).describe('The player name of the stale session to revive'),
      host: z.string().optional().describe('Target hostname for cross-machine encore. Omit for the session\'s original host.'),
      contextMessages: z.number().min(1).max(50).optional().describe('Number of recent messages to include as context (default: 10)'),
    },
    async (args) => {
      const { playerId, host, contextMessages } = args as {
        playerId: string;
        host?: string;
        contextMessages?: number;
      };

      const nameError = validatePlayerName(playerId);
      if (nameError) return fail(nameError);

      // Cannot encore yourself
      if (playerId === getPlayerId()) {
        return fail('Cannot encore your own session.');
      }

      try {
        // Resolve the target session
        const resolved = await resolveSession(client, config.ensemble, playerId);
        if (!resolved) {
          return fail(`No session found with name "${playerId}".`);
        }

        // Check status
        const metadata: SessionMetadata = await resolved.query('getMetadata');
        const status = metadata.status || 'active';

        if (status === 'active') {
          return fail(`Session "${playerId}" is already active. Use \`cue\` to send it a message.`);
        }
        if (status === 'pending') {
          return fail(`Session "${playerId}" is pending (still starting up). Wait for it to become active or stale.`);
        }
        if (status === 'terminated') {
          return fail(`Session "${playerId}" is terminated. Use \`recruit\` to start a fresh session instead.`);
        }

        // Status is 'stale' — submit encore outbox entry
        const entry = {
          type: 'encore',
          targetPlayerId: playerId,
          targetHostname: host,
          contextMessageCount: contextMessages,
        } as OutboxEntryInput;
        const entryId = await handle.executeUpdate(submitOutboxUpdate, { args: [entry] });

        return ok(`Encore request submitted for **${playerId}**. The session will be revived with context restored. (outbox: ${entryId})`);
      } catch (err) {
        return fail(`Failed to encore: ${formatError(err)}`);
      }
    },
  );
}
