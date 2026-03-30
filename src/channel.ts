import { WorkflowHandle } from '@temporalio/client';
import { Message } from './types';

const log = (...args: unknown[]) => console.error('[claude-tempo:poller]', ...args);

const POLL_INTERVAL_MS = 2000;

export function startMessagePoller(
  handle: WorkflowHandle,
  onMessages: (messages: Message[]) => void,
): () => void {
  let stopped = false;

  const poll = async () => {
    if (stopped) return;
    try {
      const messages: Message[] = await handle.query('pendingMessages');
      if (messages.length > 0) {
        const ids = messages.map((m) => m.id);
        await handle.signal('markDelivered', ids);
        onMessages(messages);
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
