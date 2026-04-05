import { z } from 'zod';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { WorkflowHandle } from '@temporalio/client';
import { Message, SentMessage } from '../types';
import { defineTool } from './helpers';

interface TimelineEntry {
  direction: 'received' | 'sent';
  from?: string;
  to?: string;
  text: string;
  timestamp: string;
  delivered?: boolean;
}

export function registerRecallTool(
  server: McpServer,
  handle: WorkflowHandle,
  getPlayerId: () => string,
) {
  defineTool(
    server,
    'recall',
    'Read your own message history. Shows received messages by default; use includeSent to also see outgoing messages.',
    {
      limit: z.number().min(1).max(100).optional().describe('Max messages to return (default 20, max 100)'),
      since: z.string().optional().describe('Only show messages after this ISO timestamp'),
      from: z.string().optional().describe('Filter received messages by sender name'),
      includeSent: z.boolean().optional().describe('Include sent messages in the timeline (default: false)'),
    },
    async (args) => {
      const { since, from: fromFilter, includeSent } = args as {
        limit?: number;
        since?: string;
        from?: string;
        includeSent?: boolean;
      };
      const limit = ((args as any).limit as number | undefined) ?? 20;

      // Validate since
      let sinceTs: number | undefined;
      if (since) {
        sinceTs = Date.parse(since);
        if (isNaN(sinceTs)) {
          return {
            content: [{ type: 'text' as const, text: `Invalid ISO timestamp for "since": ${since}` }],
            isError: true,
          };
        }
      }

      try {
        // Query received messages
        const received: Message[] = await handle.query('allMessages');
        const timeline: TimelineEntry[] = received.map((m) => ({
          direction: 'received' as const,
          from: m.from,
          text: m.text,
          timestamp: m.timestamp,
          delivered: m.delivered,
        }));

        // Optionally include sent messages
        if (includeSent) {
          const sent: SentMessage[] = await handle.query('allSentMessages');
          for (const s of sent) {
            timeline.push({
              direction: 'sent',
              to: s.to,
              text: s.text,
              timestamp: s.timestamp,
            });
          }
        }

        // Apply filters
        let filtered = timeline;

        if (sinceTs !== undefined) {
          filtered = filtered.filter((e) => Date.parse(e.timestamp) >= sinceTs!);
        }

        if (fromFilter) {
          filtered = filtered.filter((e) => e.direction === 'received' ? e.from === fromFilter : true);
        }

        // Sort by timestamp descending (newest first)
        filtered.sort((a, b) => Date.parse(b.timestamp) - Date.parse(a.timestamp));

        // Apply limit
        filtered = filtered.slice(0, limit);

        if (filtered.length === 0) {
          return {
            content: [{ type: 'text' as const, text: 'No messages found matching the filter.' }],
          };
        }

        // Format output
        const lines = filtered.map((e) => {
          const dir = e.direction === 'sent' ? `→ ${e.to}` : `← ${e.from}`;
          const status = e.direction === 'received' ? (e.delivered ? '' : ' (undelivered)') : '';
          const ts = e.timestamp;
          // Truncate long messages in the summary
          const preview = e.text.length > 200 ? e.text.slice(0, 200) + '...' : e.text;
          return `[${ts}] ${dir}${status}\n  ${preview}`;
        });

        return {
          content: [{
            type: 'text' as const,
            text: `${filtered.length} message${filtered.length === 1 ? '' : 's'}:\n\n${lines.join('\n\n')}`,
          }],
        };
      } catch (err) {
        return {
          content: [{ type: 'text' as const, text: `Failed to recall messages: ${err}` }],
          isError: true,
        };
      }
    },
  );
}
