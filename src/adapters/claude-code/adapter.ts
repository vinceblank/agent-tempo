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
import type { AdapterDescriptor, DetachReason } from '../../types';
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
 *
 * Reconnect (#201): the adapter opts into the base class's reconnect loop
 * via {@link shouldReconnect}. On a recoverable terminal (lease reaped
 * workflow-side without a competitor, or superseded-then-released), the
 * base class runs a budget-bounded backoff + fresh-claim flow, then calls
 * {@link onReconnected} with a freshly pinned handle so the delivery poll
 * can resume. Truly terminal events (`destroy`, `reconnect-exhausted`)
 * still tear the adapter down permanently.
 *
 * PR-H (#132): the legacy unpinned-poll fallback (gated on
 * `CLAUDE_TEMPO_LIFECYCLE_V2=0`) has been removed. V2 is the only path.
 */
export class InteractiveAttachment extends BaseAttachment {
  readonly descriptor: AdapterDescriptor = claudeCodeDescriptor;

  /** Current delivery poller stopper; null when no poll is running (pre-claim, mid-reconnect, post-terminal). */
  private stopPoller: (() => void) | null = null;

  /** Retained across `onReconnected` calls so the poller can be restarted on a new pinned handle. */
  private onMessages: ((messages: Message[]) => Promise<void> | void) | null = null;

  /** True once user-initiated `stop()` has fired or the adapter reached a true terminal. */
  private localStopped = false;

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
   * V2 path: claim the attachment, pin the handle, then run the poll/deliver/
   * markDelivered loop against the pinned handle. The base class simultaneously
   * drives heartbeats and the `attachmentInfo` watcher, and (via {@link shouldReconnect})
   * may reclaim on recoverable lease loss without this method firing terminal.
   *
   * Returns a stop function that tears down the delivery poll AND the base
   * class lifecycle. Safe to call multiple times.
   *
   * **Error handling:** a `claimAttachment` rejection at startup
   * (`AttachmentConflict`, `WorkflowGone`) propagates up — the caller in
   * `server.ts` treats it like any other startup failure. Runtime lease loss
   * on the pinned handle is first routed through `shouldReconnect`; only truly
   * terminal reasons (`destroy`, `reconnect-exhausted`) reach `onTerminal`
   * and tear down the poller permanently.
   */
  private startV2(
    workflowId: string,
    onMessages: (messages: Message[]) => Promise<void> | void,
  ): () => void {
    this.onMessages = onMessages;

    const stop = () => {
      if (this.localStopped) return;
      this.localStopped = true;
      if (this.stopPoller) { this.stopPoller(); this.stopPoller = null; }
      // Fire-and-forget — V2 graceful exit signals adapterExited to the workflow.
      void this.stopV2Lifecycle('user-stop', /* graceful */ true);
    };

    // Terminal events from the base class: `destroy`, `reconnect-exhausted`, or any
    // non-reconnectable reason. By the time this fires, the reconnect loop (if
    // applicable) has already given up; tear the poller down permanently.
    this.onTerminal((reason) => {
      log(`terminal (${reason}) — stopping delivery poll permanently`);
      this.localStopped = true;
      if (this.stopPoller) { this.stopPoller(); this.stopPoller = null; }
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
        if (this.localStopped) return; // caller bailed between await and here
        this.stopPoller = startMessagePoller(pinned, onMessages);
      })
      .catch((err) => {
        log(`startV2Lifecycle failed: ${(err as Error)?.message ?? err}`);
        // Surface via stop — caller's shutdown path sees the error in logs
        // and proceeds with graceful shutdown. We don't re-throw here because
        // start() is synchronous by contract.
        this.localStopped = true;
      });

    return stop;
  }

  /**
   * #201: reconnect opt-in. The interactive adapter is stateless wrt in-flight
   * messages (no processing-signal pairing; `markDelivered` is idempotent), so
   * both recoverable reasons are safe to replay on a fresh lease:
   *
   *   - `heartbeat-timeout`: the workflow reaped our lease (e.g. laptop slept).
   *     Re-claim and resume — this is the #201 happy path.
   *   - `superseded`: another adapter currently holds our slot. The reconnect
   *     loop's pre-check will re-query and bail cleanly if that's still true;
   *     we enter the loop in case the competitor releases during our backoff.
   *
   * Unrecoverable reasons (`destroy`, `gone`, anything else) fall through to
   * the default `false`, firing terminal directly.
   */
  protected shouldReconnect(reason: DetachReason): boolean {
    return reason === 'heartbeat-timeout' || reason === 'superseded';
  }

  /**
   * Tear down the current poller immediately when entering the reconnect loop.
   * The old pinned handle may still respond to `pendingMessages` queries but
   * the workflow side will ignore our `markDelivered` signals (our `attachmentId`
   * is no longer current), so continuing to poll wastes I/O and logs noise.
   */
  protected async onReconnectStart(_reason: DetachReason): Promise<void> {
    if (this.stopPoller) {
      this.stopPoller();
      this.stopPoller = null;
    }
  }

  /**
   * Fresh pinned handle is live — restart the delivery poller. The workflow's
   * `pendingMessages` queue carries everything that landed while we were
   * detached; the first poll will drain it in one batch.
   */
  protected async onReconnected(handle: WorkflowHandle): Promise<void> {
    if (this.localStopped || !this.onMessages) return;
    // Belt-and-suspenders: if onReconnectStart was skipped somehow, don't leak.
    if (this.stopPoller) { this.stopPoller(); this.stopPoller = null; }
    this.stopPoller = startMessagePoller(handle, this.onMessages);
  }
}
