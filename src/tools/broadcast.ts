import { z } from 'zod';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { Client, WorkflowHandle } from '@temporalio/client';
import { Config } from '../config';
import { SessionMetadata } from '../types';
import { submitOutboxUpdate } from '../workflows/signals';
import type { OutboxEntryInput } from '../types';
import { defineTool, ok, fail, formatError } from './helpers';
import { MESSAGE_MAX, shouldIncludeInBroadcast } from '../utils/validation';

export function registerBroadcastTool(
  server: McpServer,
  client: Client,
  config: Config,
  getPlayerId: () => string,
  handle: WorkflowHandle,
) {
  defineTool(
    server,
    'broadcast',
    'Send a message to all active players in the ensemble. Optionally filter by player type.',
    {
      message: z.string().max(MESSAGE_MAX).describe('The message to broadcast'),
      type: z.string().optional().describe('Only send to players of this type (e.g., "tempo-soloist")'),
      includeStale: z.boolean().optional().describe('Include stale sessions (default: false)'),
    },
    async (args) => {
      const { message, type: playerType, includeStale: rawIncludeStale } = args as {
        message: string;
        type?: string;
        includeStale?: boolean;
      };
      const includeStale = rawIncludeStale === true;

      try {
        const query = `WorkflowType = "claudeSessionWorkflow" AND ExecutionStatus = "Running"`;
        const targets: Array<{ playerId: string; playerType?: string }> = [];

        for await (const workflow of client.workflow.list({ query })) {
          try {
            const wfHandle = client.workflow.getHandle(workflow.workflowId);
            const metadata: SessionMetadata = await wfHandle.query('getMetadata');

            // Filter by ensemble
            if (metadata.ensemble !== config.ensemble) continue;

            // Exclude sender
            if (metadata.playerId === getPlayerId()) continue;

            // Filter by status
            if (!shouldIncludeInBroadcast(metadata.status, includeStale)) continue;

            // Filter by player type if specified
            if (playerType && metadata.playerType !== playerType) continue;

            targets.push({
              playerId: metadata.playerId,
              playerType: metadata.playerType,
            });
          } catch {
            // Workflow may have just completed — skip it
          }
        }

        if (targets.length === 0) {
          return ok('No active players matched the broadcast filter.');
        }

        // Fan out cue outbox entries for each target
        const entryIds: string[] = [];
        for (const target of targets) {
          const entry = {
            type: 'cue',
            targetPlayerId: target.playerId,
            message,
          } as OutboxEntryInput;
          const entryId = await handle.executeUpdate(submitOutboxUpdate, { args: [entry] });
          entryIds.push(entryId);
        }

        const names = targets.map((t) => t.playerId);
        return ok(`Broadcast sent to ${targets.length} player${targets.length === 1 ? '' : 's'}: ${names.join(', ')}`);
      } catch (err) {
        return fail(`Failed to broadcast: ${formatError(err)}`);
      }
    },
  );
}
