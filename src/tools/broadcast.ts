import { z } from 'zod';
import { randomUUID } from 'crypto';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { Client, WorkflowHandle } from '@temporalio/client';
import { Config } from '../config';
import { SessionMetadata } from '../types';
import { submitOutboxUpdate } from '../workflows/signals';
import type { OutboxEntryInput } from '../types';
import { defineTool, ok, fail, formatError } from './helpers';
import { MESSAGE_MAX, shouldIncludeInBroadcast } from '../utils/validation';
import { getAttachmentPhase } from '../utils/search-attributes';

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
      includeStale: z.boolean().optional().describe('Include disconnected sessions (draining/detached phases; default: false). Argument name kept for backward compatibility.'),
    },
    async (args) => {
      const { message, type: playerType, includeStale: rawIncludeStale } = args as {
        message: string;
        type?: string;
        includeStale?: boolean;
      };
      const includeDisconnected = rawIncludeStale === true;

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

            // Filter by attachment phase (post-#176). Phase lives on the
            // `ClaudeTempoAttachmentState` search attribute.
            const phase = getAttachmentPhase(workflow);
            if (!shouldIncludeInBroadcast(phase, includeDisconnected)) continue;

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

        // #357: stamp every fan-out cue with the same `broadcastId` so the
        // TUI can fold the N deliveries into one chat row. Generated ONCE
        // here in the MCP-tool process — not inside the workflow — so
        // workflow determinism is preserved (the workflow only sees the id
        // as an opaque string on `OutboxEntryInput`).
        const broadcastId = randomUUID();

        // Fan out cue outbox entries for each target.
        const entryIds: string[] = [];
        for (const target of targets) {
          const entry = {
            type: 'cue',
            targetPlayerId: target.playerId,
            message,
            broadcastId,
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
