import { WorkflowHandle } from '@temporalio/client';
import { Message } from './types';

const log = (...args: unknown[]) => console.error('[claude-tempo:poller]', ...args);

const POLL_BASE_MS = 2000;
const POLL_BACKOFF_FACTOR = 1.5;
const POLL_MAX_MS = 30000;

export function startMessagePoller(
  handle: WorkflowHandle,
  onMessages: (messages: Message[]) => Promise<void> | void,
): () => void {
  let stopped = false;
  let timeout: ReturnType<typeof setTimeout> | null = null;
  let currentInterval = POLL_BASE_MS;
  let consecutiveErrors = 0;

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
      // Reset backoff on successful poll
      currentInterval = POLL_BASE_MS;
      consecutiveErrors = 0;
    } catch (err) {
      consecutiveErrors++;
      // Apply exponential backoff on errors
      currentInterval = Math.min(currentInterval * POLL_BACKOFF_FACTOR, POLL_MAX_MS);
      log(`Poll error (attempt ${consecutiveErrors}, next in ${Math.round(currentInterval)}ms):`, err);
    }

    if (!stopped) {
      timeout = setTimeout(poll, currentInterval);
    }
  };

  // Start the first poll
  timeout = setTimeout(poll, POLL_BASE_MS);

  return () => {
    stopped = true;
    if (timeout) {
      clearTimeout(timeout);
      timeout = null;
    }
  };
}
