/**
 * claude-code adapter — interactive class.
 *
 * Owns the V2 attachment lifecycle for Claude Code CLI sessions: claims the
 * attachment, drives the base-class heartbeat + phase-watcher loops, and runs
 * the delivery poll against a runId-pinned handle. PR-H (#132) removed the
 * `CLAUDE_TEMPO_LIFECYCLE_V2=0` escape hatch that previously gated V1 vs V2.
 *
 * Delivery itself (per design §5.3): push via MCP notification, ack via
 * `markDelivered`. No `processingStart`/`End` pairs — those are for SDK
 * adapters (`CopilotSdkAttachment`).
 *
 * **This file runs in the Node.js adapter process, NOT the Temporal workflow
 * sandbox.** `setTimeout` / `setInterval` are appropriate here; the pre-bundled
 * workflow code lives in `src/workflows/`.
 *
 * Design reference: docs/design/session-lifecycle-rebuild-v2.md §5 (interactive),
 * §§3.2, 4.3 (base lifecycle), §9.4 (WorkflowNotFound).
 */
import type { Client, WorkflowHandle } from '@temporalio/client';
import { BaseAttachment, type BaseAttachmentOptions } from '../base';
import type { AdapterDescriptor } from '../../types';
import { Message } from '../../types';
import { ENV } from '../../config';

const log = (...args: unknown[]) => console.error('[claude-tempo:poller]', ...args);

/**
 * Descriptor for the claude-code adapter. Kept colocated with the class so
 * `adapter.ts` has no import dependency on `index.ts` (breaks the circular
 * module-graph cycle flagged in QA review of PR-B). `index.ts` re-exports
 * this constant alongside the class.
 *
 * Design reference: docs/design/session-lifecycle-rebuild-v2.md §4.2–4.3.
 */
export const claudeCodeDescriptor: AdapterDescriptor = {
  adapterId: 'claude-code',
  adapterClass: 'interactive',
  blocksOnLLMTurn: false,
  // Interactive class — 60s cadence per design §4.3. The base class drives the
  // heartbeat loop at this interval when the V2 lifecycle path is active.
  heartbeatMs: 60_000,
};

const POLL_BASE_MS = 2000;
const POLL_BACKOFF_FACTOR = 1.5;
const POLL_MAX_MS = 30000;

/**
 * Poll a session workflow for pending messages and deliver them via `onMessages`.
 *
 * Verbatim lift from the old `src/channel.ts`. Module-private; callers go through
 * {@link InteractiveAttachment.start}. Used by both the V2 path (on a runId-pinned
 * handle) and the legacy compat path (on the unpinned handle from server.ts).
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
 *
 * V2 attachment lifecycle: the adapter calls `claimAttachment` via
 * `startV2Lifecycle()`, pins the runId, and runs the delivery poll on the
 * pinned handle. Base class drives heartbeat + phase watcher in parallel.
 * On lease revocation, `WorkflowNotFound`, or phase `gone`, the adapter
 * stops cleanly without attempting to re-claim.
 *
 * PR-H (#132): the legacy unpinned-poll fallback (gated on
 * `CLAUDE_TEMPO_LIFECYCLE_V2=0`) has been removed. V2 is the only path.
 */
export class InteractiveAttachment extends BaseAttachment {
  readonly descriptor: AdapterDescriptor = claudeCodeDescriptor;

  constructor(options: BaseAttachmentOptions = {}) {
    super(options);
  }

  /**
   * Start polling for pending messages and delivering each batch via `onMessages`.
   * Returns a `stop()` function the caller invokes on shutdown.
   *
   * The `handle` argument is forwarded for its `workflowId` only — V2 mode
   * claims its own runId-pinned handle via the base class for all subsequent
   * queries/signals.
   */
  start(
    handle: WorkflowHandle,
    onMessages: (messages: Message[]) => Promise<void> | void,
  ): () => void {
    return this.startV2(handle.workflowId, onMessages);
  }

  /**
   * V2 path: claim the attachment, pin the handle, then run the same
   * poll/deliver/markDelivered loop against the pinned handle. The base class
   * simultaneously drives heartbeats and the `attachmentInfo` watcher.
   *
   * Returns a stop function that tears down the delivery poll AND the base
   * class lifecycle. Safe to call multiple times.
   *
   * **Error handling:** a `claimAttachment` rejection (`AttachmentConflict`,
   * `WorkflowGone`) propagates up — the caller in `server.ts` treats it like
   * any other startup failure. Runtime errors on the pinned handle
   * (`WorkflowNotFound`, lease revocation) are caught by the base class
   * heartbeat + watcher loops, which fire the `onTerminal` hook; this method
   * subscribes to that hook to tear down the poll cleanly.
   */
  private startV2(
    workflowId: string,
    onMessages: (messages: Message[]) => Promise<void> | void,
  ): () => void {
    let stopPoller: (() => void) | null = null;
    let stopped = false;

    const stop = () => {
      if (stopped) return;
      stopped = true;
      if (stopPoller) { stopPoller(); stopPoller = null; }
      // Fire-and-forget — V2 graceful exit signals adapterExited to the workflow.
      void this.stopV2Lifecycle('user-stop', /* graceful */ true);
    };

    // Terminal events from the base class: WorkflowNotFound, phase `gone`, or
    // lease revoked. Tear down the delivery poll without calling stopV2Lifecycle
    // again (base class already fired it via `stopped` flag).
    this.onTerminal((reason) => {
      log(`terminal (${reason}) — stopping delivery poll`);
      stopped = true;
      if (stopPoller) { stopPoller(); stopPoller = null; }
    });

    // PR-D: when spawned by `restart` or `migrate`, the workflow has
    // pre-claimed an attachment and passed its id through env. Forward to
    // `startV2Lifecycle` so the update takes the §9.2 renewal path and the
    // adapter takes over the existing lease atomically. Absent on first-recruit
    // spawn (fresh-claim path).
    const expectedAttachmentId = process.env[ENV.ATTACHMENT_ID] || undefined;

    // Kick off claim + heartbeat + watcher. If this throws (conflict/gone),
    // the caller's startup bails — we haven't started the poll yet.
    this.startV2Lifecycle(workflowId, expectedAttachmentId)
      .then((pinned) => {
        if (stopped) return; // caller bailed between await and here
        stopPoller = startMessagePoller(pinned, onMessages);
      })
      .catch((err) => {
        log(`startV2Lifecycle failed: ${(err as Error)?.message ?? err}`);
        // Surface via stop — caller's shutdown path sees the error in logs
        // and proceeds with graceful shutdown. We don't re-throw here because
        // start() is synchronous by contract.
        stopped = true;
      });

    return stop;
  }
}
