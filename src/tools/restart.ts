/**
 * `restart` — reap the current attachment, claim a fresh one, spawn a new adapter.
 *
 * QA B3: enqueues a `RestartOutboxEntry` on the caller's workflow outbox
 * rather than running the multi-step §8.2 algorithm inline from tool code.
 * The session workflow's dispatch loop runs the `deliverRestart` activity on
 * the target, which owns the full algorithm:
 *
 *   graceful `requestDetach` → re-query phase → optional `forceDetach`
 *   → `claimAttachment` → optional `receiveMessage` context replay
 *   → `enqueueSpawn` on the target's outbox
 *
 * Durability bonus: mid-algorithm failures surface as ApplicationFailures and
 * retry per the activity's policy. Design §8.2.
 */
import { z } from 'zod';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { Client, WorkflowHandle } from '@temporalio/client';
import { Config } from '../config';
import type { OutboxEntryInput } from '../types';
import { submitOutboxUpdate } from '../workflows/signals';
import { defineTool, ok, fail, formatError } from './helpers';
import { PLAYER_NAME_MAX, RESTART_CONTEXT_MESSAGES_MAX, validatePlayerName } from '../utils/validation';

const DEFAULT_CONTEXT_MESSAGES = 10;

export function registerRestartTool(
  server: McpServer,
  _client: Client,
  _config: Config,
  getPlayerId: () => string,
  handle: WorkflowHandle,
) {
  defineTool(
    server,
    'restart',
    'Restart a session — reap the current attachment (gracefully, or with force=true), claim a fresh attachment, spawn a new adapter, and optionally replay recent context. Replaces `encore`, `recruit --force`, and `stop`-then-`recruit`.',
    {
      playerId: z.string().max(PLAYER_NAME_MAX).describe('The player name to restart'),
      host: z.string().optional().describe('Target host (defaults to session\'s preferredHost or last-known hostname)'),
      fresh: z.boolean().optional().describe('Skip context replay — spawn a clean slate (default false)'),
      force: z.boolean().optional().describe('Steal a live attachment via forceDetach (default false; graceful detach is tried first regardless)'),
      contextMessages: z.number().min(0).max(RESTART_CONTEXT_MESSAGES_MAX).optional().describe(`Number of recent messages to include in context (default ${DEFAULT_CONTEXT_MESSAGES}, max ${RESTART_CONTEXT_MESSAGES_MAX})`),
    },
    async (args) => {
      const input = args as {
        playerId: string;
        host?: string;
        fresh?: boolean;
        force?: boolean;
        contextMessages?: number;
      };

      const nameError = validatePlayerName(input.playerId);
      if (nameError) return fail(nameError);

      try {
        const entry: OutboxEntryInput = {
          type: 'restart',
          targetPlayerId: input.playerId,
          invokerPlayerId: getPlayerId(),
          ...(input.host !== undefined ? { host: input.host } : {}),
          ...(input.fresh !== undefined ? { fresh: input.fresh } : {}),
          ...(input.force !== undefined ? { force: input.force } : {}),
          ...(input.contextMessages !== undefined ? { contextMessages: input.contextMessages } : {}),
        };
        const entryId = await handle.executeUpdate(submitOutboxUpdate, { args: [entry] });
        return ok(
          `Restart queued for **${input.playerId}**${input.host ? ` on ${input.host}` : ''}` +
          `${input.fresh ? ' (fresh)' : ''}${input.force ? ' (force)' : ''}. (outbox: ${entryId})`,
        );
      } catch (err) {
        return fail(`Failed to restart: ${formatError(err)}`);
      }
    },
  );
}
