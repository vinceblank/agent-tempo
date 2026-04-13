/**
 * `detach` — graceful reap of a session's adapter without destroying the workflow.
 *
 * QA B1: enqueues a `DetachOutboxEntry` on the caller's workflow outbox rather
 * than firing `requestDetachSignal` directly from tool code. The session
 * workflow's dispatch loop runs the `deliverDetach` activity on the target,
 * which signals `requestDetachSignal` with the supplied `reason` + `deadlineMs`.
 *
 * Design reference: §8.1 (three verbs), §2.4 (phase transitions).
 */
import { z } from 'zod';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { Client, WorkflowHandle } from '@temporalio/client';
import { Config } from '../config';
import type { OutboxEntryInput } from '../types';
import { submitOutboxUpdate } from '../workflows/signals';
import { defineTool, ok, fail, formatError } from './helpers';
import { PLAYER_NAME_MAX, MAX_DETACH_DEADLINE_MS, validatePlayerName } from '../utils/validation';

const DEFAULT_DETACH_DEADLINE_MS = 5_000;

export function registerDetachTool(
  server: McpServer,
  _client: Client,
  _config: Config,
  getPlayerId: () => string,
  handle: WorkflowHandle,
) {
  defineTool(
    server,
    'detach',
    'Gracefully detach a session\'s adapter. The session enters `draining` phase and reaps to `detached` after the deadline or when the adapter exits. The workflow survives — use `restart` to attach a new adapter, or `destroy` to terminate permanently.',
    {
      playerId: z.string().max(PLAYER_NAME_MAX).describe('The player name to detach'),
      deadlineMs: z.number().min(0).max(MAX_DETACH_DEADLINE_MS).optional().describe(`Max drain time in ms before force-detach (default ${DEFAULT_DETACH_DEADLINE_MS}, max ${MAX_DETACH_DEADLINE_MS})`),
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
        const entry: OutboxEntryInput = {
          type: 'detach',
          targetPlayerId: playerId,
          reason: 'user-stop',
          deadlineMs,
        };
        const entryId = await handle.executeUpdate(submitOutboxUpdate, { args: [entry] });
        return ok(`Detach queued for **${playerId}** (deadline: ${deadlineMs}ms; outbox: ${entryId}).`);
      } catch (err) {
        return fail(`Failed to detach: ${formatError(err)}`);
      }
    },
  );
}
