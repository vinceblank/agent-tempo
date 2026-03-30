import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { WorkflowHandle } from '@temporalio/client';
import { Message } from '../types';
import { defineTool } from './helpers';

export function registerListenTool(
  server: McpServer,
  handle: WorkflowHandle,
) {
  defineTool(
    server,
    'listen',
    'Check for pending messages from other sessions. Use this if you want to manually check for new messages.',
    {},
    async () => {
      try {
        const messages: Message[] = await handle.query('pendingMessages');

        if (messages.length === 0) {
          return {
            content: [{ type: 'text' as const, text: 'No pending messages.' }],
          };
        }

        // Mark messages as delivered
        const ids = messages.map((m) => m.id);
        await handle.signal('markDelivered', ids);

        const lines = messages.map(
          (m) => `**${m.from}** (${m.timestamp}):\n${m.text}`,
        );
        return {
          content: [{ type: 'text' as const, text: lines.join('\n\n') }],
        };
      } catch (err) {
        return {
          content: [{ type: 'text' as const, text: `Failed to check messages: ${err}` }],
          isError: true,
        };
      }
    },
  );
}
