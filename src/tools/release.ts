import { z } from 'zod';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { Client, WorkflowHandle } from '@temporalio/client';
import { Config } from '../config';
import { scanEnsembleSessions } from '../activities/resolve';
import { submitOutboxUpdate, outboxLockedQuery } from '../workflows/signals';
import type { OutboxEntryInput } from '../types';
import { defineTool, ok, fail, formatError } from './helpers';
import { PLAYER_NAME_MAX, validatePlayerName } from '../utils/validation';

export function registerReleaseTool(
  server: McpServer,
  client: Client,
  config: Config,
  getPlayerId: () => string,
  handle: WorkflowHandle,
) {
  defineTool(
    server,
    'release',
    'Release held player sessions — unlocks their outboxes and delivers deferred task messages. Without a player name, releases all held sessions.',
    {
      player: z.string().max(PLAYER_NAME_MAX).optional()
        .describe('Name of a specific held player to release. Omit to release all held players.'),
    },
    async (args) => {
      const { player } = args as {
        player?: string;
      };

      if (player) {
        const nameError = validatePlayerName(player);
        if (nameError) return fail(nameError);
      }

      try {
        if (player) {
          // Release a specific player
          const sessions = await scanEnsembleSessions(client, config.ensemble);
          const target = sessions.find((s) => s.playerId === player);
          if (!target) {
            return fail(`No session found with name "${player}".`);
          }

          // Check if the session's outbox is actually locked
          const targetHandle = client.workflow.getHandle(target.workflowId);
          let isLocked = false;
          try {
            isLocked = await targetHandle.query(outboxLockedQuery);
          } catch {
            // Query may fail for old workflows without the handler — not held
          }
          if (!isLocked) {
            return fail(`Session "${player}" is not held (outbox not locked). Only held sessions can be released.`);
          }

          const entry = {
            type: 'release',
            targetPlayerId: player,
          } as OutboxEntryInput;
          const entryId = await handle.executeUpdate(submitOutboxUpdate, { args: [entry] });

          return ok(`Release request submitted for **${player}**. Task assignment will be delivered shortly. (outbox: ${entryId})`);
        } else {
          // Release all held players — scan ensemble and check outboxLocked on each
          const sessions = await scanEnsembleSessions(client, config.ensemble);
          const heldSessions: Array<{ playerId: string; workflowId: string }> = [];

          for (const session of sessions) {
            // Skip self and conductors (conductor outbox is never locked)
            if (session.playerId === getPlayerId()) continue;
            try {
              const sessionHandle = client.workflow.getHandle(session.workflowId);
              const isLocked = await sessionHandle.query(outboxLockedQuery);
              if (isLocked) {
                heldSessions.push(session);
              }
            } catch {
              // Skip sessions where query fails (old workflows, terminated, etc.)
            }
          }

          if (heldSessions.length === 0) {
            return ok('No held sessions found. Nothing to release.');
          }

          const released: string[] = [];
          const errors: string[] = [];

          for (const session of heldSessions) {
            try {
              const entry = {
                type: 'release',
                targetPlayerId: session.playerId,
              } as OutboxEntryInput;
              await handle.executeUpdate(submitOutboxUpdate, { args: [entry] });
              released.push(session.playerId);
            } catch (err) {
              errors.push(`${session.playerId}: ${formatError(err)}`);
            }
          }

          const lines: string[] = [];
          if (released.length > 0) {
            lines.push(`Released ${released.length} player(s): ${released.join(', ')}`);
          }
          if (errors.length > 0) {
            lines.push(`Errors:\n${errors.map((e) => `  - ${e}`).join('\n')}`);
          }

          return ok(lines.join('\n'));
        }
      } catch (err) {
        return fail(`Failed to release: ${formatError(err)}`);
      }
    },
  );
}
