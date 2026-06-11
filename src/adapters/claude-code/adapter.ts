/**
 * claude-code adapter — interactive class.
 *
 * Owns the V2 attachment lifecycle for Claude Code CLI sessions: claims the
 * attachment, drives the base-class heartbeat + phase-watcher loops, and runs
 * the delivery poll against a runId-pinned handle. PR-H (#132) removed the
 * `AGENT_TEMPO_LIFECYCLE_V2=0` escape hatch that previously gated V1 vs V2.
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
import {
  SDK_POLL_BASE_MS as POLL_BASE_MS,
  SDK_POLL_BACKOFF_FACTOR as POLL_BACKOFF_FACTOR,
  SDK_POLL_MAX_MS as POLL_MAX_MS,
} from '../sdk/idle-backoff';
import { isTerminalWorkflowError } from '../terminal-error';
import { withActionSource } from '../../utils/action-counters';
import type { AdapterDescriptor, DetachReason } from '../../types';
import { Message } from '../../types';
import { ENV } from '../../config';

const log = (...args: unknown[]) => console.error('[agent-tempo:poller]', ...args);

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

// #749: one family of backoff curves across the codebase — this poller's
// error backoff shares the SDK idle-backoff constants (values unchanged:
// 2s base, 1.5× growth, 30s cap; imported at the top of the file). Static
// defaults only; the AGENT_TEMPO_SDK_POLL_* env overrides apply to SDK
// adapters, not here.

/**
 * Poll a session workflow for pending messages and deliver them via `onMessages`.
 *
 * Module-private; callers go through {@link InteractiveAttachment.start}. Runs
 * on the V2 runId-pinned handle so `markDelivered` signals reach the correct
 * execution.
 *
 * **Terminal-error handling (#249 Bug 4):** pre-#249 this loop's catch-all
 * swallowed every error including `WorkflowNotFoundError` from a CAN-closed
 * pinned runId, so the poller spun forever against a dead run while the
 * successor accepted messages no one was draining. Post-fix: classify via
 * the shared {@link isTerminalWorkflowError}, stop cleanly when seen, and
 * rely on the base class's heartbeat/watcher `handleRunEndError` path to
 * run the CAN rebind — which then calls `onReconnected` on
 * {@link InteractiveAttachment} to start a fresh poller on the successor.
 *
 * This fix depends on Bugs 1+2 (tick orphan resistance) — if the heartbeat
 * loop is dead, `onReconnected` never fires and the poller stays stopped
 * without a replacement. See the Bug 4 commit message for the revert-together
 * dependency.
 */
function startMessagePoller(
  handle: WorkflowHandle,
  onMessages: (messages: Message[]) => Promise<void> | void,
): () => void {
  let stopped = false;
  let timeout: ReturnType<typeof setTimeout> | null = null;
  let currentInterval = POLL_BASE_MS;
  let consecutiveErrors = 0;

  const cleanupTimer = () => {
    if (timeout) {
      clearTimeout(timeout);
      timeout = null;
    }
  };

  // #753 — meter each poll tick's Temporal calls (pendingMessages query +
  // markDelivered signal) under 'sdk-poller'.
  const poll = () => withActionSource('sdk-poller', async () => {
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
      // #249 Bug 4: surface terminal-class errors instead of swallowing. The
      // pinned-runId handle throws `WorkflowNotFoundError` /
      // `WorkflowExecutionAlreadyCompleted` when its run has CAN'd or been
      // destroyed. Keep polling against the closed run is pointless and masks
      // the lifecycle event from logs. Stop the poller here; the base class's
      // heartbeat/watcher tick will trigger CAN rebind or terminal, and
      // `onReconnected` restarts a fresh poller on the live run.
      if (isTerminalWorkflowError(err)) {
        log(
          `poll hit terminal workflow error — stopping (onReconnected will restart on successor if recoverable):`,
          (err as Error)?.message ?? err,
        );
        stopped = true;
        cleanupTimer();
        return;
      }
      consecutiveErrors++;
      // Apply exponential backoff on errors
      currentInterval = Math.min(currentInterval * POLL_BACKOFF_FACTOR, POLL_MAX_MS);
      log(`Poll error (attempt ${consecutiveErrors}, next in ${Math.round(currentInterval)}ms):`, err);
    }

    if (!stopped) {
      timeout = setTimeout(poll, currentInterval);
    }
  });

  // Start the first poll
  timeout = setTimeout(poll, POLL_BASE_MS);

  return () => {
    stopped = true;
    cleanupTimer();
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
 * CAN rebind (#226): when the session workflow continues-as-new, the pinned
 * runId starts returning `WorkflowExecutionAlreadyCompleted`. The base class
 * reads the closed run's history, extracts the successor runId from the
 * `WorkflowExecutionContinuedAsNewEvent`, rebinds `pinnedHandle` in place (no
 * re-claim — the workflow's §2.3 CAN-boundary lease extension keeps the lease
 * alive across the transition), and calls {@link onReconnected} so we restart
 * the poller on the live run. Transparent to upstream.
 *
 * PR-H (#132): the legacy unpinned-poll fallback (gated on
 * `AGENT_TEMPO_LIFECYCLE_V2=0`) has been removed. V2 is the only path.
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
   * #201 / #226: reconnect opt-in. The interactive adapter is stateless wrt
   * in-flight messages (no processing-signal pairing; `markDelivered` is
   * idempotent), so every recoverable reason is safe to replay on a fresh or
   * re-bound lease:
   *
   *   - `heartbeat-timeout` (#201): the workflow reaped our lease (e.g. laptop
   *     slept). Re-claim and resume — full budget-bounded reconnect loop.
   *   - `superseded` (#201): another adapter currently holds our slot. The
   *     reconnect loop's pre-check will re-query and bail cleanly if that's
   *     still true; we enter the loop in case the competitor releases during
   *     our backoff.
   *   - `continued-as-new` (#226): the session workflow's CAN transition closed
   *     our pinned runId while the workflow id kept running on a successor. The
   *     base class transparently rebinds to the successor runId (no re-claim —
   *     the lease is carried across CAN per §2.3) and our poller resumes.
   *
   * Unrecoverable reasons (`destroy`, `gone`, anything else) fall through to
   * the default `false`, firing terminal directly.
   */
  protected shouldReconnect(reason: DetachReason): boolean {
    return (
      reason === 'heartbeat-timeout' ||
      reason === 'superseded' ||
      reason === 'continued-as-new'
    );
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
