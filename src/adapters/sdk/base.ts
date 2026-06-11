/**
 * SDK-class adapter base.
 *
 * Class hierarchy per design §4.1: `SdkAttachment extends BaseAttachment`. Concrete
 * SDK adapters (copilot, future `headless-claude`) extend this.
 *
 * PR-C commit 3 fills in the shared SDK lifecycle on top of the V2 attachment
 * machinery landed in commit 2's `BaseAttachment`:
 *
 *   - **Processing-signal pairing.** `deliver()` wraps each SDK turn in
 *     `processingStart` (update) → `invokeSdk()` (concrete) → `processingEnd`
 *     (update) → `markDelivered` (signal). Updates are synchronous (§7.1) — a
 *     dropped `processingStart` is observable, not silent.
 *   - **Split-brain cancellation.** When the base-class phase watcher fires
 *     `onLeaseRevoked`, `SdkAttachment` calls the concrete `onSuperseded()`
 *     hook. The concrete adapter (Copilot, headless-claude, …) aborts the
 *     in-flight `sendAndWait` via its SDK-specific mechanism and exits.
 *     Residual ghost-reply window is documented in §9.3.
 *
 * **This file runs in the Node.js adapter process, NOT the Temporal workflow
 * sandbox.** Node.js timers are appropriate here; workflow-bundle code lives
 * elsewhere (in `src/workflows/`).
 *
 * Design reference: docs/design/session-lifecycle-rebuild-v2.md §§4.1, 4.4, 6.1,
 * 6.2, 7.1, 9.3.
 */
import type { WorkflowHandle } from '@temporalio/client';
import { BaseAttachment, type BaseAttachmentOptions } from '../base';
import { processingStartUpdate, processingEndUpdate, markDeliveredSignal } from '../../workflows/signals';
import { IdleBackoff } from './idle-backoff';
import type { Message, DetachReason } from '../../types';

const log = (...args: unknown[]) => console.error('[agent-tempo:sdk-adapter]', ...args);

/** Per-message result from `SdkAttachment.deliver()`. */
export interface SdkDeliverResult {
  /** Whatever `invokeSdk()` returned — up to the concrete adapter to define. */
  sdkResult: unknown;
  /** Time spent inside `invokeSdk()` in milliseconds. */
  elapsedMs: number;
}

/**
 * Abstract base for SDK-class adapters.
 *
 * Owns processing-signal pairing and split-brain cancellation wiring. Concrete
 * subclasses (`CopilotSdkAttachment`, future `HeadlessClaudeAttachment`) provide:
 *
 *   - `invokeSdk(prompt, timeoutMs)` — the actual blocking SDK call.
 *   - `onSuperseded()` — abort the in-flight SDK call on lease revocation.
 *
 * Subclasses set up the V2 lifecycle by calling `startV2Lifecycle(workflowId)`
 * on `BaseAttachment` (inherited from commit 2) to claim the attachment + start
 * heartbeat + phase watcher. Then they drive a poll loop that calls
 * `this.deliver(msg)` per message; `deliver()` handles the processing-signal
 * pairing and the final `markDelivered` ack.
 */
export abstract class SdkAttachment extends BaseAttachment {
  /** Subclass hook — cancel the in-flight SDK invocation (AbortController / session.cancel / disconnect). */
  protected abstract onSuperseded(): void;

  /**
   * Whether we are currently inside an `invokeSdk` call. Read by `onSuperseded`
   * implementations to decide whether cancellation actually has an effect.
   */
  protected sdkInFlight = false;

  /**
   * #749 (T0.2) — shared idle-backoff delay computer for the subclass message
   * poll loops. Contract: `next(messages.length > 0)` per tick — active
   * conversations stay at the 2s base; idle stretches to the 30s cap (~16×
   * fewer billable `pendingMessages` queries on an idle player); any
   * delivered message snaps back to base. Subclasses should `reset()` at
   * poll-loop (re)start so a reconnect doesn't inherit a stale slow cadence.
   * Heartbeat/phase-watcher cadences (BaseAttachment) are deliberately NOT
   * driven by this — lease math depends on them (#249).
   */
  protected readonly pollBackoff = new IdleBackoff();

  constructor(options: BaseAttachmentOptions = {}) {
    super(options);
    // Wire the V2 lease-revoked signal (fired by BaseAttachment's phase watcher
    // when `attachmentInfo.currentAttachment.attachmentId` diverges from our
    // token) into the concrete subclass's cancel hook. BaseAttachment has
    // already stopped the heartbeat + watcher at this point — our job is to
    // abort the blocking SDK turn before it produces a ghost reply (§9.3).
    this.onLeaseRevoked((reason) => {
      log(`lease revoked (${reason}) — firing onSuperseded`);
      try {
        this.onSuperseded();
      } catch (err) {
        log('onSuperseded threw:', (err as Error)?.message ?? err);
      }
    });
  }

  /**
   * Deliver one message through the SDK turn. Wire-protocol surface:
   *
   *   1. `processingStart` update — synchronous (§7.1). If the update rejects
   *      with `AttachmentMismatch` or `WorkflowGone`, we propagate the error
   *      without calling `invokeSdk` — lease revocation is already in flight
   *      via the phase watcher and the ghost-turn SHOULD be skipped.
   *   2. `invokeSdk(prompt, timeoutMs)` — the concrete blocking call. Runs
   *      under `sdkInFlight = true` so `onSuperseded` can identify the target.
   *   3. `processingEnd` update — synchronous, in a `finally` so any throw
   *      from `invokeSdk` still releases the in-flight marker on the workflow.
   *      Errors here are logged and swallowed: if the workflow is gone or the
   *      attachment was revoked, the processing set is meaningless.
   *   4. `markDelivered` signal — fires only on successful `invokeSdk` return,
   *      so at-least-once delivery survives crashes mid-turn.
   *
   * @param pinned    Pinned `WorkflowHandle` returned by `startV2Lifecycle()`.
   * @param msg       Representative message for the in-flight set — its id is
   *                  used in `processingStart`/`processingEnd`.
   * @param prompt    Formatted prompt for the SDK (concrete subclass formats).
   * @param timeoutMs SDK invocation timeout.
   * @param invokeSdk Concrete SDK call. Receives formatted prompt + timeout.
   * @param ackIds    Message ids to mark delivered after the SDK turn completes.
   *                  Defaults to `[msg.id]`. Copilot's bridge joins multiple
   *                  pending messages into a single prompt and acks them all
   *                  with one `markDelivered` signal — pass the full batch.
   */
  protected async deliver(
    pinned: WorkflowHandle,
    msg: Message,
    prompt: string,
    timeoutMs: number,
    invokeSdk: (prompt: string, timeoutMs: number) => Promise<unknown>,
    ackIds?: string[],
  ): Promise<SdkDeliverResult> {
    if (!this.token) {
      throw new Error('SdkAttachment.deliver called with no attachment token — did startV2Lifecycle run?');
    }

    // (1) Announce in-flight work. Synchronous per §7.1 — if the workflow has
    // been destroyed or the lease revoked, the update throws and we bail
    // before burning an SDK turn.
    await pinned.executeUpdate(processingStartUpdate, {
      args: [{
        messageId: msg.id,
        expectedAttachmentId: this.token.attachmentId,
      }],
    });

    const t0 = Date.now();
    let sdkResult: unknown;
    this.sdkInFlight = true;
    try {
      // (2) Concrete SDK call. Blocks until the LLM turn completes or the
      // concrete adapter aborts via `onSuperseded`.
      sdkResult = await invokeSdk(prompt, timeoutMs);
    } finally {
      this.sdkInFlight = false;
      // (3) Always release the in-flight marker, even on throw. Swallow errors:
      // if the workflow is gone or the lease was revoked during the turn, the
      // in-flight set is already dead-lettered on the workflow side.
      try {
        await pinned.executeUpdate(processingEndUpdate, {
          args: [{
            messageId: msg.id,
            expectedAttachmentId: this.token.attachmentId,
          }],
        });
      } catch (err) {
        log(`processingEnd suppressed error: ${(err as Error)?.message ?? err}`);
      }
    }
    const elapsedMs = Date.now() - t0;

    // (4) Ack delivery only after the SDK turn completed cleanly. If invokeSdk
    // threw, we never reach here and messages stay pending for retry.
    // C4 (PR-C dual-QA follow-up): use the typed signal constant so the
    // ts-morph wire-protocol drift detector can see the reference — a string
    // literal would be invisible to the static scan.
    const toAck = ackIds ?? [msg.id];
    try {
      await pinned.signal(markDeliveredSignal, toAck);
    } catch (err) {
      log(`markDelivered suppressed error: ${(err as Error)?.message ?? err}`);
    }

    return { sdkResult, elapsedMs };
  }

  /**
   * Subclass-facing convenience: call this from `startV2Lifecycle` path to
   * fire `adapterExited` on clean shutdown and tear down the V2 machinery.
   * Forwards to `BaseAttachment.stopV2Lifecycle` with graceful=true.
   */
  protected async detachGracefully(reason: DetachReason = 'user-stop'): Promise<void> {
    await this.stopV2Lifecycle(reason, /* graceful */ true);
  }
}
