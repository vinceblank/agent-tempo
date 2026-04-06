import { z } from 'zod';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { Client, WorkflowHandle } from '@temporalio/client';
import { Config } from '../config';
import { resolveSession } from './resolve';
import { submitOutboxUpdate } from '../workflows/signals';
import type { OutboxEntryInput } from '../types';
import { defineTool, ok, fail, formatError } from './helpers';
import { PLAYER_NAME_MAX, MESSAGE_MAX, validatePlayerName } from '../utils/validation';

export function registerCueTool(
  server: McpServer,
  client: Client,
  config: Config,
  getPlayerId: () => string,
  handle: WorkflowHandle,
) {
  defineTool(
    server,
    'cue',
    'Send a message to another Claude Code session by player name. Delivered instantly via Temporal signal.',
    {
      playerId: z.string().max(PLAYER_NAME_MAX).describe('The player name of the target session'),
      message: z.string().max(MESSAGE_MAX).describe('The message to send'),
    },
    async (args) => {
      const { playerId, message } = args as { playerId: string; message: string };

      const nameError = validatePlayerName(playerId);
      if (nameError) return fail(nameError);

      try {
        const resolved = await resolveSession(client, config.ensemble, playerId);
        if (!resolved) {
          return fail(`No active session found with name "${playerId}".`);
        }

        const entry = {
          type: 'cue',
          targetPlayerId: playerId,
          message,
        } as OutboxEntryInput;
        const entryId = await handle.executeUpdate(submitOutboxUpdate, { args: [entry] });

        return ok(`Message sent to ${playerId}. (outbox: ${entryId})`);
      } catch (err) {
        return fail(`Failed to send message to ${playerId}: ${formatError(err)}`);
      }
    },
  );
}
