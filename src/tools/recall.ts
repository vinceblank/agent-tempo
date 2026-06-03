import { z } from 'zod';
import { WorkflowHandle } from '@temporalio/client';
import { Message, SentMessage } from '../types';
import { ok, fail, formatError, type TempoToolDescriptor } from './descriptor';
import { buildTimeline, formatRecall } from '../utils/recall-format';

export function buildRecallTool(
  handle: WorkflowHandle,
  getPlayerId: () => string,
): TempoToolDescriptor {
  return {
    name: 'recall',
    description: 'Read your own message history. Shows received messages by default; use includeSent to also see outgoing messages. `offset` pages the timeline; `previewLength` truncates bodies (unset = full text).',
    params: {
      limit: z.number().min(1).max(100).optional().describe('Max messages to return (default 20, max 100)'),
      offset: z.number().int().min(0).optional().describe('Skip N messages for paging (default 0)'),
      previewLength: z.number().int().min(1).optional().describe('Truncate each body to N chars + "…"; omit for full text'),
      since: z.string().optional().describe('Only show messages at or after this ISO timestamp'),
      from: z.string().optional().describe('Filter received messages by sender name'),
      includeSent: z.boolean().optional().describe('Include sent messages in the timeline (default: false)'),
    },
    handler: async (args) => {
      const { limit, offset, previewLength, since, from: fromFilter, includeSent } = args as {
        limit?: number;
        offset?: number;
        previewLength?: number;
        since?: string;
        from?: string;
        includeSent?: boolean;
      };

      // Validate `since` up-front so the formatter never sees a garbage date.
      if (since && Number.isNaN(Date.parse(since))) {
        return fail(`Invalid ISO timestamp for "since": ${since}`);
      }

      try {
        const received: Message[] = await handle.query('allMessages');
        const sent: SentMessage[] = includeSent ? await handle.query('allSentMessages') : [];
        const timeline = buildTimeline(received, sent, Boolean(includeSent));
        const rendered = formatRecall(timeline, { limit, offset, previewLength, since, from: fromFilter });
        return ok(rendered.text);
      } catch (err) {
        return fail(`Failed to recall messages: ${formatError(err)}`);
      }
    },
  };
}
