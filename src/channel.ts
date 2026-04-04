import { WorkflowHandle } from '@temporalio/client';
import { Message } from './types';

const log = (...args: unknown[]) => console.error('[claude-tempo:poller]', ...args);

const POLL_INTERVAL_MS = 2000;

export function startMessagePoller(
  handle: WorkflowHandle,
  onMessages: (messages: Message[]) => Promise<void> | void,
): () => void {
  let stopped = false;

  const poll = async () => {
    if (stopped) return;
    try {
      const messages: Message[] = await handle.query('pendingMessages');
      if (messages.length > 0) {
        const ids = messages.map((m) => m.id);
        // Deliver messages first — only mark delivered after successful notification.
        // If onMessages throws, messages stay undelivered and retry on next poll cycle.
        await onMessages(messages);
        await handle.signal('markDelivered', ids);
      }
    } catch (err) {
      // Workflow may be continuing-as-new or shutting down
      log('Poll error (may be transient):', err);
    }
  };

  const interval = setInterval(poll, POLL_INTERVAL_MS);

  return () => {
    stopped = true;
    clearInterval(interval);
  };
}
