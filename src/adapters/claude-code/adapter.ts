/**
 * claude-code adapter — interactive class.
 *
 * Content lifted verbatim from `src/channel.ts` into a class wrapper as part of
 * PR-B (v0.25 rebuild step 2/7). Zero behavior change: the same poll/notify/
 * markDelivered loop runs as before, and the PR-A compat shim in
 * `src/workflows/session.ts` translates `markDelivered` + `updateMetadata({ status })`
 * onto the attachment phase machine.
 *
 * PR-C rewrites this adapter to use the v0.25 attachment wire protocol directly —
 * `claimAttachment`, `heartbeat`, per-message `deliver()`. Until then, the poller
 * below is the delivery implementation.
 *
 * Design reference: docs/design/session-lifecycle-rebuild-v2.md §5 (Class 1 —
 * Interactive) and §4.3 (base-class lifecycle guarantees, added in PR-C).
 */
import type { WorkflowHandle } from '@temporalio/client';
import { BaseAttachment } from '../base';
import type { AdapterDescriptor } from '../../types';
import { Message } from '../../types';
import { claudeCodeDescriptor } from './index';

const log = (...args: unknown[]) => console.error('[claude-tempo:poller]', ...args);

const POLL_BASE_MS = 2000;
const POLL_BACKOFF_FACTOR = 1.5;
const POLL_MAX_MS = 30000;

/**
 * Poll a session workflow for pending messages and deliver them via `onMessages`.
 *
 * Verbatim lift from the old `src/channel.ts`. Module-private; callers go through
 * {@link InteractiveAttachment.start}.
 */
function startMessagePoller(
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

/**
 * Interactive adapter for the Claude Code CLI.
 *
 * Delivery model is push-based: messages are fetched via the `pendingMessages`
 * query, notified to the MCP server via `notifications/claude/channel`, then
 * `markDelivered` is signaled to the workflow. Delivery does not block on an
 * LLM turn (`blocksOnLLMTurn: false`).
 */
export class InteractiveAttachment extends BaseAttachment {
  readonly descriptor: AdapterDescriptor = claudeCodeDescriptor;

  /**
   * Start polling `handle` for pending messages and delivering each batch via
   * `onMessages`. Returns a `stop()` function the caller invokes on shutdown.
   *
   * The polling loop is the legacy implementation — identical to the pre-PR-B
   * `startMessagePoller` from `src/channel.ts`. PR-C replaces the body of this
   * method with a `claimAttachment` + heartbeat + per-message `deliver()` loop.
   */
  start(
    handle: WorkflowHandle,
    onMessages: (messages: Message[]) => Promise<void> | void,
  ): () => void {
    return startMessagePoller(handle, onMessages);
  }
}
