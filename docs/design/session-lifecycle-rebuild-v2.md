# Session Lifecycle & Multi-Host Architecture — Rebuild v2

> **Editor's note (2026-04-18, v0.26-beta):** This design is now fully realized in code.
> The legacy `ClaudeTempoStatus` / `SessionStatus` shim that the rebuild ladder left in
> place for migration compatibility was removed in the **#174–#178 shim-removal epic**
> (PRs #175, #176, #177, #178). Attachment phase (`ClaudeTempoAttachmentState`) is the
> single source of lifecycle truth. The sections below describe the target state; where
> they reference the legacy shim, read them as "historical context" for the v0.25
> transition window. See [`docs/ops/v0.26-migration.md`](../ops/v0.26-migration.md) for
> the operator upgrade path.

> **Status**: Design proposal (v2, revision of Rebuild B after panel review)
> **Author**: tempo-architect-2
> **Branch**: `design/session-rebuild-v2`
> **Target release**: **v0.25.0-beta.1** (npm `beta` tag)
> **Date**: 2026-04-12
> **Supersedes**: `docs/design/session-lifecycle-rebuild-b.md`
>
> This revision folds the panel review's correctness fixes and Temporal-rigor items into Rebuild B's winning thesis, and adopts Rebuild A's table-based presentation for the wire protocol, open questions, and changeset. Backward compatibility is **not** a concern (v0.25.0-beta.1 is a clean cut) so the document speaks plainly about renames and breaks instead of carrying a compat matrix.
>
> This document is **design only**. No code. Audience: the implementing engineer, plus the conductor for final review.

---

## 0. Thesis (TL;DR)

Today's state model collapses three independent lifetimes into one shared lifetime:

1. **The workflow** — durable record of "this player exists."
2. **The attachment** — an adapter process bound to the workflow.
3. **The agent run** — the Claude/Copilot conversation.

Kill one and the others collapse. Ctrl-C on a terminal `COMPLETE`s the workflow; a bridge hiccup synthesizes a fresh workflow; a 3-minute tool call declares the session stale. #99 and #102 and the failed fixes #100/#101 all ride this collapse.

**The rebuild separates the three into independent lifecycles, coordinated by explicit, transactional messages:**

- The **workflow** lives across crashes, reboots, disconnects, and adapter swaps. It ends only on explicit `destroy`.
- An **attachment** is a leased claim held by exactly one adapter at a time, kept alive by heartbeat. Attachments detach cleanly (or time out) without ending the workflow.
- The **agent run** is whatever an adapter knows how to drive — a Claude Code terminal, a Copilot SDK session, a future headless Claude SDK. It plugs into the workflow through a locked-down `SessionAdapter` interface.

Once separated, the bugs evaporate:

- **#99** disappears because "I'm processing message X" is a workflow-acked update keyed by `messageId`, not an inference from delivery timing.
- **#102** disappears because graceful detach leaves the workflow `RUNNING`; there is no completed-workflow race to resurrect, and every adapter operation runs against a pinned `runId` so silent substitution is impossible.

**What v2 changes versus v1 (Rebuild B):**

- Correctness: `processingStart`/`processingEnd` are **updates** (acked, synchronous), not signals; both carry a required `messageId` idempotency key; the workflow tracks an in-flight set and only gates the phase on set transitions (empty → non-empty, non-empty → empty).
- Correctness: `claimAttachment` pseudocode is corrected (no fictional update-context arguments); the discriminator comes from `expectedAttachmentId` on the input.
- Correctness: `destroy` drain-vs-abandon is decided (**abandon**; documented residual behavior).
- Correctness: `--force` split-brain has a named resolution (**adapter cancels outstanding `sendAndWait` on lease-revocation detection**; bounded ghost-reply window documented).
- Correctness: `requestDetach` + `forceDetach` during `draining` has an explicit deadline (`drainingDeadline`, default 5 s).
- Correctness: The adapter's `WorkflowNotFound` handler is **spec'd to exit cleanly** — no synthesis, no re-create.
- Temporal rigor: `workflow.now()` everywhere a time is read inside workflow code; lease extension at `continueAsNew` boundary; `enqueueSpawn` activity failure auto-rolls-back the attachment; agent class is captured once at recruit and never re-resolved.
- Presentation: consolidated single wire-protocol table; dedicated Open Questions section with Option A / B / Recommendation; per-file changeset appendix; glossary up front; canonical error-message spec.
- Scope: a new **Adapter extensibility contract** section with a worked example for the headless Claude SDK — proof that the interface holds up beyond Claude Code and Copilot.
- Scope: a **Tactical MVP** section documenting `fix/mvp-99-102`'s scope boundary.

The 3-layer thesis and the 7-phase lifecycle are unchanged. Those are the spine.

---

## 0.5. Glossary

Introduced before use. Terms here are the canonical names; other spellings are aliases only in user-facing docs.

| Term | Definition |
|------|------------|
| **workflow** | The long-lived Temporal workflow representing one player in one ensemble. Durable across host restarts. Ends **only** on `destroy`. |
| **attachment** | A leased claim on the workflow, held by exactly one adapter at a time. Identified by `attachmentId` (UUID). Includes hostname, adapter class, claimedAt, lastHeartbeatAt, expiresAt, and a pinned `runId`. |
| **adapter** | The code (and its hosting process) that drives one attachment — spawns and talks to an agent, delivers messages, proves liveness via heartbeat. Either `InteractiveAttachment` (Claude Code) or an `SdkAttachment` subclass (Copilot; future headless Claude). |
| **claim** | The act of obtaining a fresh attachment via the `claimAttachment` update. Transactional: fails with `AttachmentConflict` if another unexpired lease exists. |
| **lease** | The time window during which an attachment is valid. Default 90 s. Extended by each heartbeat. Expired leases are eligible for re-claim without `--force`. |
| **heartbeat** | A periodic `heartbeat` signal from adapter to workflow (default every 30 s) that resets `lastHeartbeatAt` and `expiresAt`. |
| **processing** | The phase a workflow is in while at least one `messageId` is "in flight" (the adapter has signalled processing-start but not processing-end). Suppresses stale/detach detection because the adapter has explicitly said "I'm busy on behalf of your message." |
| **awaiting** | A phase refinement of `attached`: attachment held, inbox caught up, no in-flight messages. Used for dashboards; internally equivalent to `attached`. |
| **detached** | The phase a workflow enters when no adapter holds a valid attachment. The workflow is still `RUNNING`; messages queue. The key new state that eliminates the #102 resurrection path. |
| **draining** | Transitional phase: the current attachment has asked to detach; the workflow is flushing outbox + waiting for `adapterExited` (bounded by `drainingDeadline`, default 5 s). |
| **booting** | Initial phase: workflow exists, no adapter has claimed yet. |
| **gone** | Terminal phase: the workflow has been `destroy`ed and has COMPLETED. |
| **destroy** | The new, single verb that COMPLETEs the workflow. Replaces `stop`'s old "terminate" semantics. |
| **restart** | The new, unified verb that reaps any current attachment (gracefully, or by force with `--force`), claims a new attachment, and spawns a fresh adapter process. Replaces `encore`, `recruit --force`, and "stop then recruit." |
| **adapter class** | A static property of an adapter implementation: either `'interactive'` (push-based delivery, heartbeat-only liveness) or `'sdk'` (pull-based delivery, blocking `sendAndWait`-style, requires `processingStart`/`processingEnd`). Captured once at recruit, stored in `SessionMetadata`, never re-resolved. |
| **descriptor** | A static, per-adapter record declaring its class, blocks-on-LLM-turn flag, heartbeat cadence, delivery mode, and supported recruit options. Lives in each adapter's `index.ts` and is loaded by the adapter registry. |
| **conformance suite** | A shared test suite any new adapter must pass before being accepted: spawn, attach, heartbeat, receive message, detach, re-attach, crash-recover. |
| **agent run** | One adapter's session with its agent SDK — a Copilot session ID, a Claude Code conversation, a headless Claude session. Owned by the adapter; the workflow knows its ID only for resume. |

---

## Table of Contents

1. [Current-state catalogue](#1-current-state-catalogue)
2. [Target session lifecycle](#2-target-session-lifecycle)
3. [`SessionAdapter` interface + shared base](#3-sessionadapter-interface--shared-base)
4. [Adapter extensibility contract](#4-adapter-extensibility-contract)
5. [Class 1 adapter — Interactive (Claude Code)](#5-class-1-adapter--interactive-claude-code)
6. [Class 2 adapter — SDK-based (Copilot + headless Claude)](#6-class-2-adapter--sdk-based-copilot--headless-claude)
7. [Processing tracking via updates](#7-processing-tracking-via-updates)
8. [Restart, detach, destroy](#8-restart-detach-destroy)
9. [Multi-host coordination](#9-multi-host-coordination)
10. [Daemon as restore agent](#10-daemon-as-restore-agent)
11. [Consolidated wire protocol](#11-consolidated-wire-protocol)
12. [Error-message specification](#12-error-message-specification)
13. [Bug mapping](#13-bug-mapping)
14. [Tactical MVP scope (`fix/mvp-99-102`)](#14-tactical-mvp-scope-fixmvp-99-102)
15. [Upgrade notes](#15-upgrade-notes)
16. [Open questions](#16-open-questions)
17. [Best-practices audit](#17-best-practices-audit)

Appendices: [A. Changeset by phase](#appendix-a--changeset-by-phase) · [B. Illustrative timings](#appendix-b--illustrative-timings) · [C. Out of scope](#appendix-c--out-of-scope)

---

## 1. Current-state catalogue

An abbreviated catalogue of every state surface that today represents "what is this session doing right now." Full catalogue is in Rebuild B §1; this table is trimmed to the surfaces that drive the rebuild.

| # | State surface | Location | Writer(s) | Bugs |
|---|---|---|---|---|
| 1 | Temporal workflow status | Temporal server | SDK (COMPLETE / TERMINATE / RUNNING) | #102 |
| 2 | `ClaudeTempoStatus` search attribute | Temporal Visibility | `claudeSessionWorkflow` | #99 (`stale` fires on delivery timing), #102 (`encore` requires `stale`) |
| 3 | `lastActivityTime` / `lastOutboundTime` / undelivered-age counters | Workflow memory | signal/update handlers | #99 (undelivered-age is the direct trigger) |
| 4 | Copilot bridge `processing` flag | Bridge process memory | `poll()` | #99 (invisible to workflow while blocking) |
| 5 | Copilot SDK session state | Copilot API server + bridge memory | `createSession` / `resumeSession` | #102 (SDK recreation spawns a fresh MCP child that calls `USE_EXISTING` on a completed workflow) |
| 6 | MCP subprocess lifecycle | OS process table | `handle.result()` watcher in `server.ts` | #102 (subprocess exit on COMPLETE drives the bridge recovery path) |
| 7 | **Implicit "I'm working on a tool call" state** | *Nowhere* | — | #99 (missing surface) |
| 8 | `ClaudeTempoHostname` (effectively static) | Temporal Visibility | recruit time only | Blocks multi-host migration |

Everything else — hold/release, pause/resume, conductor surfaces, Maestro, scheduler — is orthogonal and preserved untouched.

**Observations carried into the rebuild:**

- Surfaces 1, 2, and 6 are all encoding "is this session alive and where" in ways that drift. The rebuild has **one** canonical answer (the workflow's attachment state) and derives the rest.
- Surface 4 is bridge-process-local and invisible to the workflow. That invisibility is #99. The rebuild promotes it to a first-class workflow update (§7).
- Surface 6 (`handle.result()` → `process.exit`) is the direct cause of #102 cycling. The rebuild replaces it with phase-change watching and an explicit spec: no adapter ever re-creates a workflow (§9.4).
- Surface 7 is the architectural miss. The rebuild names it and makes it transactional.

---

## 2. Target session lifecycle

### 2.1 Three layers

| Layer | Durable? | Scope | Ends when |
|---|---|---|---|
| **Workflow** | Yes (Temporal) | One per player per ensemble | Explicit `destroy` |
| **Attachment** | Leased (heartbeat) | One per workflow at a time | Clean `detach`, heartbeat timeout, or superseded by a new claim |
| **Adapter process** | No | One per attachment | Adapter subprocess exits; workflow is unaffected |

A fourth lifetime — the **agent run** (Copilot session ID, Claude Code conversation) — is adapter-internal and not part of the workflow's state machine except as a `sessionId` field the adapter may ask the workflow to remember for resume.

### 2.2 Seven workflow phases

```
                                      ┌──────────────┐
                              ┌──────▶│   gone       │◀── destroy (terminal)
                              │       └──────────────┘
                              │
┌────────┐  spawn  ┌────────┐ │claim   ┌──────────┐  processingStart
│booting │────────▶│attached│─┼───────▶│processing│──────────────┐
└────────┘         └────┬───┘          └─────┬────┘              │
     ▲                  │                    │                   │
     │                  │                    │processingEnd      │
     │                  ▼ detach/timeout     ▼                   │
     │             ┌──────────┐         ┌──────────┐             │
     │             │ draining │────────▶│ awaiting │◀────────────┘
     │             └────┬─────┘         └────┬─────┘
     │                  │                    │ detach/timeout
     │                  ▼                    │
     │             ┌──────────┐              │
     │◀── attach ──│ detached │◀─────────────┘
                   └──────────┘
                       │
                       └── destroy ──▶ gone
```

Phase semantics and invariants:

| Phase | Meaning | Entered by | Invariants |
|---|---|---|---|
| `booting` | Workflow exists, no adapter has claimed it yet | Workflow start (`recruit` or `restore`) | `currentAttachment == null`; outbox drains deferred until first claim |
| `attached` | An adapter holds a valid attachment and is idle-ready | `claimAttachment` update succeeds | `currentAttachment != null`; `workflow.now() < currentAttachment.expiresAt`; `inFlightMessages.size === 0` |
| `processing` | Attached AND `inFlightMessages.size > 0` | `processingStart` update takes `inFlightMessages` from 0 → 1 | Same as `attached` plus `processingSince != null`; stale/heartbeat-timeout detection still runs (heartbeat is independent of processing) |
| `awaiting` | Attached, idle, no undelivered work | `processingEnd` update takes `inFlightMessages` back to 0 AND outbox is empty | Presentation refinement of `attached`; internally identical |
| `draining` | Attachment has asked to detach; flushing outbox + awaiting `adapterExited` | `requestDetach` signal | No new delivery; outbox drains; transitions to `detached` when drained OR `drainingDeadline` elapses (whichever first) |
| `detached` | Workflow `RUNNING`, no attachment | Draining complete, heartbeat timeout, `adapterExited`, or `forceDetach` update | `currentAttachment == null`; outbox dispatch paused except for `stop`/`destroy` bypass |
| `gone` | Terminal | `destroy` update | Workflow COMPLETES; all history frozen for audit |

**Hard invariants across all phases:**

1. **At most one attachment at any time.** Enforced by `claimAttachment`'s transactional lease check.
2. **The workflow never COMPLETES except via `destroy`.** No code path — graceful detach, bridge crash, reboot, tool timeout — ends the workflow implicitly.
3. **Delivery is marked only after the adapter acks consumption** via `reportDelivered`. The "ack before send" shortcut PR #100 proposed is rejected (see §13.1).
4. **`processing` suppresses stale-by-undelivered detection; it does not suppress `destroy` or heartbeat timeout.** A runaway tool call is bounded by `processingDeadline` (default 15 min).
5. **Heartbeat is independent of message traffic.** Separate timer. Silence for ≥ 3 missed heartbeats → `detached` with reason `heartbeat-timeout`.
6. **Hold/pause are orthogonal overlays on any phase.** `outboxLocked` and `paused` survive untouched; pause vs detached interaction table is in §9.7.
7. **All workflow-internal time comparisons use `workflow.now()`** (not `Date.now()`). All timestamps written into state come from either `workflow.now()` or a signal/update payload.

### 2.3 `continueAsNew` and the lease

At `continueAsNew` the workflow carries forward:

- `currentAttachment` (the entire lease object)
- `inFlightMessages` (the Set of currently-processing message IDs)
- `preferredHost`
- Existing state: `outbox`, `messages`, `sentMessages`, `outboxLocked`, `heldMessage`, `paused`

**Lease-expiry hazard at `continueAsNew`.** Nothing in the Temporal SDK guarantees the CAN transition is instant; on a loaded Temporal server it can take hundreds of milliseconds. If the new execution starts with a stale `currentAttachment.expiresAt`, the main loop's first check might classify a healthy attachment as expired.

**Mitigation (explicit in the implementation):** right before calling `continueAsNew`, extend the lease by one heartbeat interval:

```
// pseudocode, near the continueAsNew call-site
if (currentAttachment) {
  currentAttachment.lastHeartbeatAt = nowIso();                      // uses workflow.now()
  currentAttachment.expiresAt = new Date(workflow.now().getTime() + HEARTBEAT_INTERVAL_MS).toISOString();
}
```

One heartbeat interval (30 s) is enough to cross any realistic CAN transition. If the adapter heartbeats at all in the new execution (which it will, ~30 s after the last one), the lease is renewed normally; if the adapter has genuinely gone away, the new execution's heartbeat-timeout check fires at the normal cadence.

### 2.4 Transition authority

| Transition | Triggered by |
|---|---|
| `booting → attached` | `claimAttachment` update |
| `attached → processing` | `processingStart` update (takes in-flight set from 0 → 1) |
| `processing → attached` / `awaiting` | `processingEnd` update (takes in-flight set back to 0) OR `processingDeadline` main-loop timer |
| `attached` / `awaiting` / `processing` → `draining` | `requestDetach` signal (adapter, conductor, or operator) |
| `draining → detached` | `adapterExited` signal OR `drainingDeadline` main-loop timer |
| `attached` / `awaiting` / `processing` → `detached` (forced) | Heartbeat timeout OR `forceDetach` update (with reason) |
| `detached → attached` | `claimAttachment` update |
| Any (non-`gone`) → `gone` | `destroy` update |
| Any → `booting` | **Not allowed.** Restart replays the above transitions. |

### 2.5 Destroy semantics — decision

**Decision: `destroy` abandons in-flight outbox entries and COMPLETEs the workflow immediately.**

Rationale:

- Drain-before-destroy requires bounded wait semantics. If a target peer is itself `gone`, drain blocks forever; needing a timeout means abandonment is still possible. Better to make the semantics uniform and predictable.
- `destroy` is an **explicit operator action**. The user is saying "this is over." Delivery guarantees on outbox entries are best-effort.
- A graceful-drain path already exists: `detach` → drain → `destroy`. Operators that care use it.

Workflow-side `destroy` handler (§11 wire protocol, §8.5 detail):

1. Set phase = `gone`.
2. Revoke `currentAttachment` (if any); `adapterExited` from this point on is a no-op.
3. Emit a history event listing abandoned outbox entry IDs (for audit via Temporal UI).
4. Return from the main loop normally — the workflow COMPLETES.

**Residual risk documented:** outbox delivery activities launched just before `destroy` may still land signals on peers for a few hundred milliseconds. Peer workflows that receive a signal for a destroyed sender already discard "from unknown player" messages or accept the orphan signal silently; no peer code needs to change. Activities that find the source workflow `gone` on retry short-circuit via `WorkflowNotFoundError` (§9.4) and mark the entry `failed` with `error: "source-destroyed"`.

### 2.6 Hazards addressed

| Hazard | Where in this design |
|---|---|
| Stale triggered during long LLM turn (#99) | §2.2 `processing` phase + §7 `processingStart`/`processingEnd` updates with `messageId` idempotency |
| Completed-workflow resurrection (#102) | §2.2 `detached` phase (workflow stays RUNNING) + §9.4 `WorkflowNotFound` spec (adapter MUST exit, never synthesize) + §9.2 runId pinning on `claimAttachment` |
| Stuck-in-`draining` | §2.2 `drainingDeadline` (default 5 s) + §8.3 `forceDetach` with `expectedAttachmentId` |
| Lease expiry across `continueAsNew` | §2.3 extend lease by one heartbeat interval at CAN boundary |
| Runaway LLM tool call | §2.2 `processingDeadline` (default 15 min) forces `processing → attached` and re-enables stale detection |
| Concurrent `claimAttachment` from two hosts | §9.2 transactional check + `AttachmentConflict` ApplicationFailure |
| `destroy` + outstanding outbox | §2.5 abandon + audit event |

---

## 3. `SessionAdapter` interface + shared base

### 3.1 Interface

```typescript
/**
 * A SessionAdapter binds one ensemble player's agent process to its
 * Temporal workflow via one attachment. Implementations plug in
 * per-agent-type behavior; common behavior (attach, heartbeat,
 * processing, detach) lives in the shared BaseAttachment abstract
 * class.
 *
 * Every adapter class is one of:
 *   - 'interactive' — push-based delivery via MCP notifications; does
 *     not block on an LLM turn; does not call processingStart/End.
 *   - 'sdk' — pull-based delivery via a blocking sendAndWait-style
 *     API; MUST wrap each delivery in processingStart/processingEnd
 *     updates to suppress stale-by-undelivered detection.
 *
 * Future classes may be added (see §4 Adapter extensibility contract).
 */
export interface SessionAdapter {
  /** Stable identifier for logs + diagnostics. Allocated by BaseAttachment on attach. */
  readonly attachmentId: string;

  /** Which adapter class is this. Captured at recruit; never changes. */
  readonly adapterClass: AdapterClass;

  /** Static descriptor for this adapter implementation. See §4.2. */
  readonly descriptor: AdapterDescriptor;

  /** Called once after the workflow accepts the attachment claim. Must not block. */
  onAttached(ctx: AttachmentContext): Promise<void>;

  /**
   * Deliver one pending message to the agent. Resolves when delivery
   * is "accepted": MCP notification sent (interactive) or sendAndWait
   * initiated (sdk). The adapter must call ctx.reportDelivered(msg.id)
   * once the agent has consumed the message (which for sdk adapters
   * typically means sendAndWait has returned successfully).
   */
  deliver(msg: Message, ctx: AttachmentContext): Promise<void>;

  /** Is the underlying agent process still alive? Sync; must not block. */
  isAgentAlive(): boolean;

  /**
   * Called when the workflow transitions to `draining`. Stop accepting
   * new deliveries, allow in-flight ones to complete within the drain
   * deadline, then return. Must NOT kill the agent process — shutdown()
   * owns that.
   */
  drain(reason: DetachReason, deadlineMs: number): Promise<void>;

  /**
   * The adapter is exiting. Tear down the agent process (terminal
   * close, SDK session teardown, etc.) and cleanly return.
   */
  shutdown(reason: DetachReason): Promise<void>;

  /**
   * Optional hook for workflow-initiated directives that don't fit
   * the phase model (e.g. operator broadcasts in the future).
   * Default impl: no-op.
   */
  onDirective?(directive: AdapterDirective, ctx: AttachmentContext): Promise<void>;
}

export interface AttachmentContext {
  readonly workflowId: string;
  readonly runId: string;                 // pinned — see §9.2
  readonly attachmentId: string;
  readonly hostname: string;

  /** Tell the workflow a message has been consumed. Idempotent; safe to retry. */
  reportDelivered(ids: string[]): Promise<void>;

  /**
   * Tell the workflow delivery of messageId has started. Must be
   * matched with signalProcessingEnd on the same messageId. Both are
   * updates (acked, validated); see §7.
   * Required for sdk adapters; interactive adapters skip both.
   */
  signalProcessingStart(messageId: string): Promise<{ inFlightCount: number }>;
  signalProcessingEnd(messageId: string): Promise<{ inFlightCount: number }>;

  /** Fire-and-forget heartbeat (signal). Called by BaseAttachment on its 30 s timer. */
  signalHeartbeat(): Promise<void>;

  /** Graceful-exit signal emitted just before the adapter process exits. */
  signalAdapterExited(reason: DetachReason): Promise<void>;

  /** Observe phase changes observed by the adapter's own poll of attachmentInfo. */
  onPhaseChange(listener: (phase: AttachmentPhase) => void): () => void;

  /** Observe that the lease has been revoked. See §9.3 split-brain handling. */
  onLeaseRevoked(listener: (reason: DetachReason) => void): () => void;
}

export type AdapterClass = 'interactive' | 'sdk';

export type DetachReason =
  | 'user-stop'
  | 'restart'
  | 'heartbeat-timeout'
  | 'superseded'
  | 'agent-exited'
  | 'spawn-failed'
  | 'destroy';

export type AttachmentPhase =
  | 'booting' | 'attached' | 'processing' | 'awaiting'
  | 'draining' | 'detached' | 'gone';

export type AdapterDirective = 'detach-now' | 'drain-now';
```

### 3.2 Shared base class

`BaseAttachment` is an abstract class every adapter extends. It owns:

1. **Claim lifecycle.** Calls `claimAttachment` update on the workflow with the pinned `runId`, writes the returned `AttachmentToken` to the context.
2. **Heartbeat loop.** One timer ticking at `descriptor.heartbeatMs` (default 30 s), calling `signalHeartbeat` until drain begins. Survives transient Temporal errors with exponential backoff (2 s → 30 s cap, reset on success). On sustained failure (configurable max 3 consecutive failures) the adapter transitions to local `detached` state and shuts itself down.
3. **Processing-signal pairing (sdk only).** Wraps each `deliver(msg, ctx)` in `signalProcessingStart(msg.id)` … `signalProcessingEnd(msg.id)` with a `finally`. If the `signalProcessingStart` update throws `AttachmentMismatch` (because the lease was revoked mid-flight), the adapter cancels the underlying `sendAndWait` (§9.3) and exits.
4. **Delivery ack tracking.** Batches `reportDelivered` calls.
5. **Drain orchestration.** Translates the workflow's `requestDetach` signal into `drain(reason, deadline)` → `shutdown(reason)` → `signalAdapterExited(reason)`.
6. **Lease-revoked listener.** Polls `attachmentInfo` query at a relaxed cadence (once per 5 heartbeat intervals, or on update errors) to detect `expectedAttachmentId` mismatch and fire `onLeaseRevoked` listeners.
7. **`WorkflowNotFound` handling.** See §9.4. On `WorkflowNotFoundError` from any workflow operation, the adapter **must exit cleanly** — no retry, no re-create.

Everything else — how to spawn the agent subprocess, how to deliver a message, whether delivery blocks — is in the concrete class.

### 3.3 Why the split matters

The asymmetry between interactive (push, non-blocking) and sdk (pull, blocking) delivery is the root cause of #99. Making it explicit in the type system (`adapterClass`, `descriptor.blocksOnLLMTurn`) and in the base class (different delivery contract) prevents ever applying the wrong assumption.

- Interactive: heartbeat alone proves liveness; `processing` is never entered.
- SDK: heartbeat + `processingStart`/`processingEnd` prove both liveness and "intent to deliver." Without the processing signals, we reimplement #99.

---

## 4. Adapter extensibility contract

> **Why this section exists.** The 3-layer thesis is only valuable if future adapters can be added without touching the core. The panel flagged that the Copilot / Claude Code split shouldn't leak into workflow, server, or tool code. This section nails the contract so a future author — and the obvious next one is the headless Claude SDK — can plug in a new adapter by adding one directory, without editing the workflow, outbox, or MCP tool surface.

### 4.1 Code organization mandate

Every adapter lives in its own directory:

```
src/adapters/
├── base.ts                       # BaseAttachment abstract class; AdapterRegistry
├── index.ts                      # barrel export + registry bootstrap
├── README.md                     # how to add a new adapter
├── claude-code/
│   ├── adapter.ts                # InteractiveAttachment extends BaseAttachment
│   ├── index.ts                  # registers descriptor with AdapterRegistry
│   └── README.md                 # adapter-specific notes (MCP notifier, Ctrl+C handling)
├── copilot/
│   ├── adapter.ts                # CopilotSdkAttachment extends SdkAttachment extends BaseAttachment
│   ├── index.ts                  # registers descriptor
│   └── README.md
└── headless-claude/              # future — the worked example in §4.6
    └── ...
```

**Refactor mandate at implementation time:** the existing `src/channel.ts` and `src/copilot-bridge.ts` modules move into `src/adapters/claude-code/adapter.ts` and `src/adapters/copilot/adapter.ts` respectively. `src/server.ts` becomes adapter-neutral — it resolves the adapter class from workflow metadata, dispatches to the registry, and owns no per-class code.

### 4.2 Locked-down interface + descriptor

The `SessionAdapter` interface in §3.1 is **the contract**. Adapters MUST NOT add public methods that `server.ts` or the CLI call directly. All server/workflow communication goes through `AttachmentContext`.

Each adapter module registers a `AdapterDescriptor`:

```typescript
export interface AdapterDescriptor {
  /** Stable identifier used in wire protocol, search attributes, and config. */
  readonly adapterId: string;           // e.g., 'claude-code', 'copilot', 'headless-claude'

  /** Which class (§3.1). */
  readonly adapterClass: AdapterClass;

  /** Does delivery block on an LLM turn? If true, processingStart/End is mandatory. */
  readonly blocksOnLLMTurn: boolean;

  /** Heartbeat interval in ms (default 30000). Lower for latency-sensitive or test adapters. */
  readonly heartbeatMs: number;

  /** Delivery model: 'push' (MCP notification) or 'pull' (sendAndWait). */
  readonly delivery: 'push' | 'pull';

  /** Environment variables the adapter reads, passed through from recruit. */
  readonly recruitEnvPassthrough: readonly string[];    // e.g., ['ANTHROPIC_API_KEY']

  /** CLI flags the adapter appends to its agent spawn command. */
  readonly recruitFlagMappers: readonly RecruitFlagMapper[];

  /** Factory: given spawn context, return a new instance. */
  readonly factory: (spawnContext: SpawnContext) => SessionAdapter;
}
```

The registry is a simple map:

```typescript
// src/adapters/base.ts
export class AdapterRegistry {
  private readonly byId = new Map<string, AdapterDescriptor>();
  register(desc: AdapterDescriptor): void { this.byId.set(desc.adapterId, desc); }
  get(adapterId: string): AdapterDescriptor { /* throw if missing */ }
  all(): readonly AdapterDescriptor[] { return [...this.byId.values()]; }
}

// src/adapters/index.ts (bootstrap)
import { AdapterRegistry } from './base';
import { claudeCodeDescriptor } from './claude-code';
import { copilotDescriptor } from './copilot';
export const registry = new AdapterRegistry();
registry.register(claudeCodeDescriptor);
registry.register(copilotDescriptor);
```

Adding a new adapter is **one line** in the bootstrap plus one new directory. No dispatcher, workflow, or core tool changes.

### 4.3 Lifecycle guarantees the base class owns

Every adapter extending `BaseAttachment` inherits, and must not override:

1. **Heartbeat deadline.** `BaseAttachment` sends `heartbeat` every `descriptor.heartbeatMs`. The workflow expires the lease at `lastHeartbeatAt + 3 × heartbeatMs` (§9.1). Adapters may not change the lease math.
2. **Idempotent attach on retry.** If `claimAttachment` fails transiently (network hiccup), `BaseAttachment` retries with the same `expectedAttachmentId = null` until the first success, then retries with the returned `attachmentId` if the next network call fails (renewal, idempotent per §9.2).
3. **RunId pinning.** `BaseAttachment` stores the `runId` returned by `claimAttachment` in the context and uses `client.workflow.getHandle(workflowId, runId)` for every subsequent operation. Adapters never resolve by ID alone.
4. **`WorkflowNotFound` handling.** `BaseAttachment` catches `WorkflowNotFoundError` from any operation, calls `shutdown('agent-exited')`, and exits the adapter process. Adapters must not override this.
5. **Graceful-detach contract.** On `requestDetach` signal, `BaseAttachment` runs `drain(reason, deadlineMs)` then `shutdown(reason)` then `signalAdapterExited(reason)`. Adapters that need custom drain logic override `drain()` only.

### 4.4 When `processingStart`/`End` is required

| `descriptor.blocksOnLLMTurn` | `descriptor.delivery` | `processingStart`/`End` required? |
|---|---|---|
| `true` | `'pull'` | **Yes** — the base class wraps every `deliver()` automatically. |
| `false` | `'push'` | No — delivery is instantaneous; base class skips the wrap. |
| `true` | `'push'` | Yes — rare; the base class still wraps. |
| `false` | `'pull'` | Invalid — the conformance suite rejects this descriptor. |

The base class reads `descriptor.blocksOnLLMTurn` once at construction and decides for the lifetime of the attachment.

### 4.5 Conformance test suite

Every adapter must pass `tests/adapters/conformance.spec.ts`, a shared suite that exercises:

1. **Spawn.** Adapter's spawn routine returns a handle whose child process reports `isAgentAlive() === true` within 5 s.
2. **Attach.** Adapter calls `claimAttachment`, workflow phase transitions to `attached`.
3. **Heartbeat.** Over 2 heartbeat intervals, `lastHeartbeatAt` advances; lease is not expired.
4. **Receive message (push or pull).** Workflow signals `receiveMessage`; adapter delivers; `reportDelivered` is called; for sdk adapters `processingStart` and `processingEnd` are paired with the correct `messageId`.
5. **Detach graceful.** Workflow signals `requestDetach`; adapter runs `drain` → `shutdown` → `signalAdapterExited` within the drain deadline.
6. **Detach forced.** Workflow executes `forceDetach` update; adapter's `onLeaseRevoked` listener fires; adapter exits.
7. **Re-attach.** After detach, a fresh adapter instance claims the attachment successfully and resumes delivery.
8. **Crash recovery.** Adapter process is SIGKILL'd mid-delivery; after heartbeat timeout, workflow is in `detached`; a fresh adapter can claim.
9. **`WorkflowNotFound`.** Destroy the workflow out-of-band; adapter's operations throw `WorkflowNotFoundError`; adapter exits cleanly without creating a new workflow.

The suite is parameterized over adapter descriptors. New adapter? Add a parameter entry; run `npm test`. No workflow changes; no server changes.

### 4.6 Worked example: headless Claude SDK adapter

The user has told us this is the next concrete adapter. Walking through what an implementer would do proves the interface holds up without being Claude-Code/Copilot-specific.

#### 4.6.1 Author's checklist

1. **Create** `src/adapters/headless-claude/` with `adapter.ts`, `index.ts`, `README.md`.
2. **Implement** `HeadlessClaudeAttachment extends SdkAttachment extends BaseAttachment`. The SDK class is chosen because `claude-agent-sdk`'s `query()` method blocks on the LLM turn (pull-based, blocks on LLM).
3. **Declare** the descriptor (see §4.6.3).
4. **Register** in `src/adapters/index.ts`: one-line `registry.register(headlessClaudeDescriptor)`.
5. **Declare** recruit options — the API-key env var and a `--model` CLI flag pass-through.
6. **Run** `npm test tests/adapters/conformance.spec.ts` — green before landing.
7. **Ship.** No changes to `src/workflows/session.ts`, `src/server.ts`, or any tool in `src/tools/`.

#### 4.6.2 Implementation sketch (not code)

```typescript
// src/adapters/headless-claude/adapter.ts
import { query } from '@anthropic-ai/claude-agent-sdk';
import { SdkAttachment, AttachmentContext, Message, DetachReason } from '../base';

export class HeadlessClaudeAttachment extends SdkAttachment {
  private abortController?: AbortController;

  protected async createAgentSession(config: AgentSessionConfig): Promise<AgentSession> {
    // Ephemeral — each 'session' is a single query() invocation.
    return { sessionId: config.sessionId ?? workflow.uuid4(), serverState: null };
  }

  protected async resumeAgentSession(sessionId: string, config: AgentSessionConfig): Promise<AgentSession> {
    // The SDK's --resume flag for the CLI also works against sessionId.
    return { sessionId, serverState: null };
  }

  protected isSdkSessionAlive(): boolean {
    return !this.abortController?.signal.aborted;
  }

  protected formatPrompt(msg: Message): string {
    return msg.text;
  }

  protected async invokeSdk(prompt: string, timeoutMs: number): Promise<string> {
    this.abortController = new AbortController();
    const iter = query({
      prompt,
      options: {
        model: this.config.model ?? 'claude-sonnet-4-5',
        // The SDK's AbortSignal — this is what §9.3 split-brain resolution leans on.
        signal: this.abortController.signal,
      },
    });
    let text = '';
    for await (const chunk of iter) text += chunk.content ?? '';
    this.abortController = undefined;
    return text;
  }

  /** Called by BaseAttachment on onLeaseRevoked. §9.3. */
  protected onSuperseded(): void {
    this.abortController?.abort();
  }

  isAgentAlive() { return this.isSdkSessionAlive(); }

  async shutdown(reason: DetachReason) {
    this.abortController?.abort();
  }
}
```

```typescript
// src/adapters/headless-claude/index.ts
import { AdapterDescriptor } from '../base';
import { HeadlessClaudeAttachment } from './adapter';

export const headlessClaudeDescriptor: AdapterDescriptor = {
  adapterId: 'headless-claude',
  adapterClass: 'sdk',
  blocksOnLLMTurn: true,
  heartbeatMs: 30_000,
  delivery: 'pull',
  recruitEnvPassthrough: ['ANTHROPIC_API_KEY'],
  recruitFlagMappers: [
    { name: 'model', cli: (v) => ['--model', v] },
  ],
  factory: (ctx) => new HeadlessClaudeAttachment(ctx),
};
```

#### 4.6.3 What stays untouched

- `src/workflows/session.ts` — the workflow doesn't know the new adapter exists.
- `src/server.ts` — reads `metadata.adapterClass === 'sdk'` and dispatches to the registry; the registry finds the new descriptor by `adapterId`.
- `src/tools/recruit.ts` — accepts `agent: 'headless-claude'` as a valid value because the registry now knows about it. No tool change.
- All wire-protocol surfaces, all outbox types, all MCP tool schemas.

This confirms the interface is extensibility-ready.

### 4.7 Agent-type metadata is an open set

Today's `AgentType = 'claude' | 'copilot'` type becomes `string` at the type level, bounded at runtime by the registry's `adapterId` keys. The registry validates at recruit time. `mcp__claude-tempo__recruit` accepts any registered `agent` value; unregistered values error with the canonical message from §12.

Tooling affected: `src/tools/recruit.ts` (open-set validation), `src/tools/agent-types.ts` (lists descriptors from the registry instead of hardcoded values).

---

## 5. Class 1 adapter — Interactive (Claude Code)

**Stack:** Claude Code CLI → MCP server subprocess (`src/server.ts`) → Temporal workflow.

The user has a terminal. Messages push to the agent via MCP notifications (`notifications/claude/channel`). The agent processes inline and makes outbound MCP tool calls (`cue`, `report`, …) which `src/server.ts` translates to outbox updates.

### 5.1 What `src/channel.ts` becomes

`startMessagePoller()` today queries `pendingMessages` on a timer, calls `onMessages()` (the MCP notifier), then signals `markDelivered`. That's the *delivery implementation* for the interactive class.

In the rebuild it becomes `InteractiveAttachment.deliver()`, inside `src/adapters/claude-code/adapter.ts`:

```typescript
export class InteractiveAttachment extends BaseAttachment implements SessionAdapter {
  readonly descriptor = claudeCodeDescriptor;

  constructor(ctx: SpawnContext) { super(ctx); }

  async deliver(msg: Message, ctx: AttachmentContext): Promise<void> {
    await this.mcpServer.server.notification({
      method: 'notifications/claude/channel',
      params: { content: msg.text, meta: { from_player: msg.from, sent_at: msg.timestamp } },
    });
    // MCP write is synchronous-enough (stdio); no processingStart/End pairs.
    await ctx.reportDelivered([msg.id]);
  }

  isAgentAlive() { return this.mcpServer.isConnected; }
  async drain() { /* no-op — MCP is push, nothing is in flight */ }
  async shutdown() { await this.mcpServer.server.close(); }
}
```

The poll loop moves *up* into `BaseAttachment`. It's now "pull pending messages + call `deliver()`" and is identical across adapter classes — the only thing that differs is what `deliver()` does.

### 5.2 MCP subprocess lifecycle change

Today `src/server.ts` does `handle.result().then(() => process.exit(0))`. That coupling is the direct vector for #102 (workflow complete → subprocess dies → bridge recovery → synthesize new workflow). In the rebuild:

1. **Remove `handle.result()` exit-on-complete.** Was the right short-circuit when workflows completed on stop; once the workflow stays `detached`, it's wrong.
2. **Replace with `attachmentInfo` phase watcher.** The `BaseAttachment` already polls `attachmentInfo` for `onPhaseChange` / `onLeaseRevoked` (§3.2 item 6). The MCP subprocess's exit is tied to phase `detached` or `gone`, not to `handle.result()`.
3. **`WorkflowNotFound` spec.** If the phase watcher ever throws `WorkflowNotFoundError`, the adapter shuts down cleanly. It must **never** re-create the workflow. See §9.4 for the full spec.

The net: closing a Claude Code terminal → Claude Code dies → MCP subprocess stdio closes → base heartbeat loop sees signal failures and transitions local state to `detached` → workflow's heartbeat timeout fires in ≤ 90 s → workflow phase = `detached`. The workflow is **still running**; the user can `claude-tempo restart <name>` later and pick up where they left off.

### 5.3 Processing signals: mostly unused

Interactive adapters may *optionally* emit `processingStart`/`processingEnd` for dashboard "busy" indicators, but it's not required. MCP delivery is fast enough that no stale-detection logic depends on them (`descriptor.blocksOnLLMTurn === false`).

---

## 6. Class 2 adapter — SDK-based (Copilot + headless Claude)

**Stack:** Bridge process (or in-process SDK in future) → SDK library (Copilot, headless Claude, …) → SDK's own MCP subprocess (optional) → Temporal workflow.

The bridge owns process lifecycle. No user terminal. Delivery is via a `sendAndWait(prompt, timeout)`-style API that blocks for the duration of an agent turn (up to 5 min for Copilot on complex prompts).

### 6.1 Shared `SdkAttachment` abstract subclass

Every sdk-class adapter extends `SdkAttachment`, which extends `BaseAttachment`. `SdkAttachment` owns:

- **Processing-signal pairing** (§3.2 item 3). `deliver()` is wrapped in `signalProcessingStart(msg.id)` → body → `signalProcessingEnd(msg.id)` inside a `finally`.
- **SDK session recreation budget.** `sdkMaxRecreations` (default 2) limits blind retry loops.
- **Split-brain cancellation** (§9.3). On `onLeaseRevoked`, `SdkAttachment` calls the concrete class's `onSuperseded()` hook, which cancels the in-flight `sendAndWait` via an SDK-specific mechanism (AbortController / `session.cancel()` / …).

```typescript
export abstract class SdkAttachment extends BaseAttachment implements SessionAdapter {
  readonly adapterClass = 'sdk' as const;

  protected abstract createAgentSession(config: AgentSessionConfig): Promise<AgentSession>;
  protected abstract resumeAgentSession(sessionId: string, config: AgentSessionConfig): Promise<AgentSession>;
  protected abstract isSdkSessionAlive(): boolean;
  protected abstract formatPrompt(msg: Message): string;
  protected abstract invokeSdk(prompt: string, timeoutMs: number): Promise<string>;
  /** Hook called on lease revocation detection — cancel any in-flight sendAndWait. */
  protected abstract onSuperseded(): void;

  private sdkRecreations = 0;

  async deliver(msg: Message, ctx: AttachmentContext): Promise<void> {
    // Announce we're starting work on this messageId. If the lease is gone,
    // the update throws AttachmentMismatch — BaseAttachment's onLeaseRevoked
    // listener has already fired; we abort here.
    await ctx.signalProcessingStart(msg.id);
    try {
      const prompt = this.formatPrompt(msg);
      await this.invokeSdk(prompt, this.config.sendTimeoutMs);
      await ctx.reportDelivered([msg.id]);
    } catch (err) {
      if (isAttachmentMismatch(err)) {
        // Lease was revoked mid-flight. onLeaseRevoked listener is handling it;
        // do not mark delivered, do not retry.
        return;
      }
      if (this.shouldTriggerRecreate(err)) {
        await this.tryRecreate(ctx);
        throw err; // outer loop will retry delivery on next poll
      }
      throw err;
    } finally {
      // Best-effort. If this fails because the attachment is gone, that's fine —
      // the workflow isn't checking anymore.
      try { await ctx.signalProcessingEnd(msg.id); } catch { /* swallow */ }
    }
  }
}
```

### 6.2 The #99 fix, precisely

1. `SdkAttachment.deliver()` calls `signalProcessingStart(msg.id)` — **an update**, not a signal. Synchronously acked. The workflow transitions from `attached` → `processing` on the first messageId to enter the in-flight set.
2. In `processing`, stale-by-undelivered detection is disabled.
3. Heartbeat continues on its own timer, independent of `invokeSdk`. The workflow's heartbeat-timeout check runs in parallel.
4. `invokeSdk` blocks up to `sendTimeoutMs` (default 5 min). `processingDeadline` (15 min) is the hard ceiling; exceeding it forces `processing → attached` and re-enables stale detection.
5. On successful return, `signalProcessingEnd(msg.id)` — **an update** — removes the messageId from the in-flight set. When the set empties, phase transitions back to `attached` (or `awaiting`).
6. `reportDelivered` is called only after the SDK turn completes. At-least-once delivery is preserved — if `invokeSdk` fails, the message is not marked delivered.

Result: the 3-min stale trigger during a 5-min tool call **cannot fire**. The workflow sees both "adapter is alive" (heartbeat) and "adapter is busy on behalf of messageId X" (processing), and waits.

### 6.3 RunId pinning, restated

`BaseAttachment` pins the `runId` obtained from `claimAttachment`. Every `client.workflow.getHandle(workflowId, runId)` uses the pinned runId. If Temporal ever creates a fresh run under the same workflowId (pre-rebuild #102 mechanism — now impossible because the workflow doesn't COMPLETE except via `destroy`, but belt-and-suspenders), operations against the pinned runId fail with `WorkflowNotFoundError` and the adapter exits cleanly (§9.4).

### 6.4 SDK session vs Temporal workflow

The Copilot SDK session (`session.sessionId`) is an independent construct with server-side state. Resume it across Temporal workflow restarts when possible (same sessionId → preserves conversation). `SessionMetadata.sessionId` carries it; `createAgentSession` / `resumeAgentSession` dispatch on its presence.

### 6.5 Bridge mode and inner MCP child

The Copilot SDK spawns its own MCP subprocess. Under the rebuild it runs with `CLAUDE_TEMPO_BRIDGE_MODE=1`, which disables the subprocess's own `InteractiveAttachment` — the outer bridge's `SdkAttachment` is the real attachment. The inner MCP subprocess still processes outbound tool calls (`cue`, `report`, …) and exits on workflow phase `detached` or `gone` (same §5.2 watcher); the outer `SdkAttachment` never tries to claim from the inner subprocess.

---

## 7. Processing tracking via updates

The single most-impactful correctness change versus Rebuild B. This section spells out the mechanism.

### 7.1 Why signals are wrong

In B, `processingStart`/`processingEnd` were signals. Signals are fire-and-forget — if the network drops between adapter and Temporal, the signal is silently lost. A dropped `processingStart` means the workflow never enters `processing`; stale detection fires mid-LLM-turn → **#99 recurs**.

Updates are **synchronous** — the SDK doesn't resolve until the workflow-side handler has acked the update (or rejected it with an `ApplicationFailure`). Loss in transit is manifest: the adapter's `signalProcessingStart(msg.id)` call throws, and `BaseAttachment` retries on the next heartbeat interval.

### 7.2 In-flight set + idempotency

The workflow tracks an in-flight set keyed by `messageId`:

```typescript
// Workflow state carried across continueAsNew
interface SessionState {
  currentAttachment: Attachment | null;
  inFlightMessages: Set<string>;       // messageIds currently processing
  processingSince: string | null;      // ISO of first messageId entering inFlight
  /* ... existing state: outbox, messages, sentMessages, outboxLocked, paused, heldMessage */
}
```

`processingStart` update handler:

```typescript
setHandler(processingStartUpdate, ({ expectedAttachmentId, messageId }) => {
  if (!currentAttachment || currentAttachment.attachmentId !== expectedAttachmentId) {
    throw ApplicationFailure.nonRetryable(
      `Attachment ${expectedAttachmentId} does not match current ${currentAttachment?.attachmentId ?? 'none'}`,
      'AttachmentMismatch'
    );
  }
  // §16.7 decision: log-and-accept unknown messageIds. Emit a history event
  // so operators have an audit trail of adapter bookkeeping bugs without
  // breaking delivery. Accept continues so at-least-once holds even when
  // the adapter got confused.
  if (!messages.some(m => m.id === messageId)) {
    emitHistoryEvent('unknownMessageId', {
      surface: 'processingStart',
      messageId,
      attachmentId: currentAttachment.attachmentId,
      at: nowIso(),
    });
  }
  const wasEmpty = inFlightMessages.size === 0;
  inFlightMessages.add(messageId);           // Set.add is idempotent; dedup on retry
  if (wasEmpty) {
    setPhase('processing');
    processingSince = nowIso();              // uses workflow.now()
    upsertSearchAttributes({ ClaudeTempoAttachmentState: ['processing'] });
  }
  return { inFlightCount: inFlightMessages.size };
});
```

`processingEnd` update handler:

```typescript
setHandler(processingEndUpdate, ({ expectedAttachmentId, messageId }) => {
  if (!currentAttachment || currentAttachment.attachmentId !== expectedAttachmentId) {
    throw ApplicationFailure.nonRetryable(
      `Attachment ${expectedAttachmentId} does not match current ${currentAttachment?.attachmentId ?? 'none'}`,
      'AttachmentMismatch'
    );
  }
  // §16.7 decision: log-and-accept unknown messageIds here too. A
  // processingEnd for a messageId never in the inbox (or already removed
  // by processingDeadline timeout) is almost always an adapter bookkeeping
  // desync — emit history event, still let Set.delete be a no-op.
  if (!messages.some(m => m.id === messageId) && !inFlightMessages.has(messageId)) {
    emitHistoryEvent('unknownMessageId', {
      surface: 'processingEnd',
      messageId,
      attachmentId: currentAttachment.attachmentId,
      at: nowIso(),
    });
  }
  inFlightMessages.delete(messageId);        // Set.delete is idempotent; no-op on already-removed
  if (inFlightMessages.size === 0) {
    processingSince = null;
    // Phase goes back to attached; main-loop decides if we refine to 'awaiting'
    setPhase('attached');
    upsertSearchAttributes({ ClaudeTempoAttachmentState: ['attached'] });
  }
  return { inFlightCount: inFlightMessages.size };
});
```

**At-least-once delivery safety.** Updates retry at the Temporal client layer. If a retry arrives after the original already succeeded:
- `processingStart` retry: `Set.add(messageId)` is a no-op; returns the current `inFlightCount`.
- `processingEnd` retry: `Set.delete(messageId)` returns `false` on already-removed, but the handler doesn't care; phase transition is idempotent (already `attached`).

**Paired mismatch safety.** If the adapter's bookkeeping desyncs (e.g., crashes between `processingStart` and `invokeSdk`), the workflow-side in-flight set still contains the orphan `messageId`. `processingDeadline` (default 15 min measured from `processingSince`) forces exit from `processing` and clears the set. The orphan is logged to workflow history for audit.

### 7.3 `continueAsNew` considerations

`inFlightMessages` is carried across `continueAsNew` as a plain array (converted back to `Set` in the new execution). `processingSince` is carried as-is. The CAN-boundary lease extension (§2.3) applies to `currentAttachment.expiresAt`; the in-flight set is unaffected.

### 7.4 Interaction with hold/pause

- `outboxLocked` (hold): the main loop doesn't dispatch outbox entries while locked, but `processingStart`/`End` updates are unaffected (they're on the attachment, not the outbox).
- `paused`: same — pause doesn't gate the attachment, only outbox dispatch.

### 7.5 Timer discipline

The `processingDeadline` timer is implemented as a main-loop `workflow.condition(...)` race, not a setTimeout. The deadline is computed from `processingSince + PROCESSING_DEADLINE_MS` using `workflow.now()`. When the race wins, the handler clears `inFlightMessages`, sets phase back to `attached`, and emits a `processingTimeout` history event with the abandoned messageIds.

---

## 8. Restart, detach, destroy

> **Design principle:** restart always works. For any session in any non-`gone` phase, `restart` leaves the user with a healthy attached session — possibly on a different host.

### 8.1 Three verbs

| Verb | What it does | Output phase | Replaces |
|---|---|---|---|
| `detach` | Graceful reap of the current attachment without ending the workflow | `detached` | (old, implicit) `stop` behavior |
| `restart` | Reap current attachment (gracefully, or `--force`), claim a fresh one, spawn a new adapter | `attached` | `encore`, `recruit --force`, `stop`-then-`recruit` |
| `destroy` | Terminal end of the workflow (abandon in-flight outbox, COMPLETE) | `gone` | (old) `stop --force` |

`recruit` stays as its own verb for first-time spawn (new workflow ID, explicit workDir / agent / initial message).

### 8.2 `restart` algorithm

```typescript
async function restart({
  ensemble, name, host?, fresh?, force?, contextMessages?,
}) {
  // 1. Find the workflow. No workflow → recruit, not restart.
  const handle = await resolveSession(client, ensemble, name);
  if (!handle) throw new NotFound(`No workflow for "${name}". Use recruit.`);
  const info = await handle.query('attachmentInfo');
  if (info.phase === 'gone') throw new NotFound(`"${name}" was destroyed. Use recruit.`);

  // 2. Reap the current attachment (if any).
  if (info.phase !== 'detached') {
    // Try graceful detach first.
    if (info.phase === 'attached' || info.phase === 'awaiting' || info.phase === 'processing') {
      await handle.signal('requestDetach', { reason: 'restart', deadlineMs: 5_000 });
    }
    // Query again; if still not detached and we have force, force it.
    const info2 = await handle.query('attachmentInfo');
    if (info2.phase !== 'detached') {
      if (!force) {
        throw new Conflict(
          `"${name}" has a live attachment on ${info2.currentAttachment?.hostname}. ` +
          `Use --force to steal.`
        );
      }
      await handle.executeUpdate('forceDetach', {
        args: [{ reason: 'restart', expectedAttachmentId: info2.currentAttachment?.attachmentId, gracePeriodMs: 0 }],
      });
    }
  }

  // 3. Claim a new attachment atomically — get a pinned runId back.
  const targetHost = host ?? info.preferredHost ?? config.hostname;
  const { attachmentId, runId } = await handle.executeUpdate('claimAttachment', {
    args: [{ host: targetHost, adapterClass: info.metadata.adapterClass, leaseMs: 90_000 }],
  });

  // 4. Optionally inject context replay.
  if (!fresh) {
    const context = await buildContextMessage(handle, contextMessages ?? 10);
    await handle.signal('receiveMessage', { from: 'system', text: context, responseRequested: false });
  }

  // 5. Enqueue the spawn on the target host. enqueueSpawn is an update
  //    that queues a spawn outbox entry; the outbox dispatch loop fires
  //    the spawnProcess activity on the per-host task queue. If the
  //    activity fails (start-to-close timeout / non-retryable), the
  //    workflow-side handler automatically forceDetaches the just-created
  //    attachment so `restart` doesn't succeed in the API and silently
  //    hang (§8.4).
  await handle.executeUpdate('enqueueSpawn', {
    args: [{
      host: targetHost, attachmentId, runId,
      resume: !fresh, sessionId: info.metadata.sessionId,
      adapterId: info.metadata.adapterId,
    }],
  });

  return { attachmentId, host: targetHost };
}
```

### 8.3 `requestDetach` and `forceDetach` during `draining` — deadline behavior

Panel finding #6: if `requestDetach` is followed by an immediate `forceDetach` while the workflow is in `draining`, what happens to the outstanding outbox entries?

**Spec:**

| Situation | `requestDetach` | `forceDetach` |
|---|---|---|
| Phase `attached`/`awaiting`/`processing` | Transitions to `draining`. Main loop starts `drainingDeadline` countdown (default 5 s). Continues to dispatch outbox entries during draining; new `receiveMessage` signals queue (not delivered). | Bypass `draining`; cancel lease immediately; phase → `detached`. Outbox entries in `processing` state stay `processing` — the dispatch activity will complete or retry per Temporal's activity retry policy; entries in `pending` stay pending and are dispatched only when a new attachment claims. |
| Phase `draining` | Idempotent no-op; `drainingDeadline` is *not* reset. | Cancel remaining drain work; phase → `detached` immediately. Entries mid-activity are allowed to complete (Temporal owns the retry; the workflow no longer gates dispatch). |
| Phase `detached` | Rejected with `AlreadyDetached` ApplicationFailure. | Idempotent; returns `true`. |
| Phase `gone` | Rejected with `WorkflowGone`. | Rejected with `WorkflowGone`. |

Key detail: `forceDetach` has an optional `gracePeriodMs` param. `0` means immediate; `>0` means "wait up to this long for `drainingDeadline` — whichever elapses first wins." `restart` defaults to `gracePeriodMs: 0` because `requestDetach` already had its chance.

**Outbox entries mid-activity when `forceDetach` fires.** The outbox dispatch activity is a standard Temporal activity with `start-to-close` retries configured per-proxy. When `forceDetach` revokes the lease, the dispatch activity is **not** interrupted (Temporal activities don't cancel mid-flight unless you pass heartbeats + `CancellationScope`). The activity completes; its workflow-side completion handler sees `currentAttachment` is a fresh (or missing) one, and logs the delivery outcome against the abandoned attachmentId (for audit). The outbox entry transitions to `delivered` or `failed` per the activity's result.

### 8.4 `enqueueSpawn` activity failure rollback

Panel finding #15. If the `spawnProcess` activity fails (host unreachable, binary missing, process crash during bootstrap), `restart` must not leave the workflow in `attached` without a live adapter.

Handling lives **in the workflow**, not the tool. The outbox dispatch loop's spawnProcess-activity result handler:

```typescript
// in the workflow's outbox dispatch (pseudocode)
const result = await activities.spawnProcess(...);
if (!result.success) {
  // The just-created attachment has no adapter to own it. Roll it back.
  if (currentAttachment?.attachmentId === entry.attachmentId) {
    await executeLocal(forceDetachUpdate, {
      reason: 'spawn-failed',
      expectedAttachmentId: entry.attachmentId,
      gracePeriodMs: 0,
    });
    // Emit a history event so the operator sees the rollback.
    upsertSearchAttributes({ ClaudeTempoAttachmentState: ['detached'] });
  }
}
```

User experience: `restart` returns successfully from the MCP tool (the claim + enqueue succeeded); the client resolves on the API call. The adapter never comes up; within ~30 s the `attachmentInfo` query shows `detached` with `reason: 'spawn-failed'`. The TUI reflects this; the user can retry `restart` or investigate.

An alternative would be for the tool to `await` the spawn activity result, but that makes `restart` a long-running request that can hang on the user for minutes. Keeping the tool fast + surfacing the spawn failure via state is consistent with the rest of the system's async model.

### 8.5 `destroy` — full handler

```typescript
// Update handler — executed from CLI/MCP/operator
setHandler(destroyUpdate, ({ reason, terminatedBy }) => {
  if (phase === 'gone') return;   // idempotent
  // 1. Revoke attachment if any. Emit adapter-visible directive.
  if (currentAttachment) {
    emitAdapterDirective(currentAttachment, 'detach-now', 'destroy');
    currentAttachment = null;
  }
  // 2. Emit audit event with abandoned outbox entries.
  const abandonedIds = outbox.filter(e => e.status === 'pending' || e.status === 'processing').map(e => e.id);
  emitHistoryEvent('destroyed', { reason, terminatedBy, abandonedIds, at: nowIso() });
  // 3. Set phase; return from main loop; workflow COMPLETES.
  setPhase('gone');
  upsertSearchAttributes({ ClaudeTempoAttachmentState: ['gone'] });
  destroyRequested = true;   // main loop observes this via condition()
});

// main loop
await condition(() => destroyRequested || /* other exits */);
if (destroyRequested) return;     // workflow COMPLETES
```

`destroyRequested` is the only path that lets the main loop return normally. All other exits either `continueAsNew` or stay in the loop.

### 8.6 Idempotency of all three verbs

| Verb | Idempotent? | How |
|---|---|---|
| `detach` | Yes | Repeating against `detached` returns `true` with `reason: 'already-detached'`. Repeating against `draining` is a no-op (doesn't reset deadline). |
| `restart` | Same `--force` level, same target host, racing callers: one wins `claimAttachment`; loser retries the `attachmentInfo` query and if it sees the winner's attachment already present, returns success. Different `--force` levels or target hosts: loser surfaces `AttachmentConflict` with the winner's host. |
| `destroy` | Yes | `phase === 'gone'` check returns early. |

---

## 9. Multi-host coordination

### 9.1 Attachment as a lease

```typescript
interface Attachment {
  attachmentId: string;          // UUID; new per claim
  hostname: string;              // machine currently holding
  adapterId: string;             // which descriptor (§4.2)
  adapterClass: AdapterClass;
  claimedAt: string;             // ISO, uses workflow.now()
  lastHeartbeatAt: string;       // ISO; moves on each heartbeat signal
  expiresAt: string;             // = lastHeartbeatAt + leaseMs (default 90_000)
  agentRunId?: string;           // Copilot session, Claude Code session UUID, etc.
  runId: string;                 // Temporal runId at time of claim — returned as pinned
}
```

Search attributes derived from the attachment (written on every phase transition):

- `ClaudeTempoAttachedHost` (keyword) — current host or `""` when `detached`.
- `ClaudeTempoAttachmentState` (keyword) — one of the seven phases.
- `ClaudeTempoAttachmentId` (keyword) — the current UUID (for debug; `""` when detached).

`ClaudeTempoHostname` is redefined as **preferred host** (last known; set by `setPreferredHost` update).

### 9.2 `claimAttachment` — corrected pseudocode

Panel finding #3: B's pseudocode passed `{ source }` as an update-context arg, which doesn't exist. Updates receive only their input. The discriminator must come from the input itself (`expectedAttachmentId`).

```typescript
setHandler(claimAttachmentUpdate, ({
  host, adapterClass, adapterId, leaseMs, expectedAttachmentId,
}) => {
  if (phase === 'gone') {
    throw ApplicationFailure.nonRetryable(
      `Cannot attach to ${workflowInfo().workflowId}: workflow is terminated`,
      'WorkflowGone'
    );
  }
  const now = workflow.now();

  // Renewal path: caller presents expectedAttachmentId that matches current
  // attachment (and lease isn't expired). Refresh the lease in place.
  if (currentAttachment
      && currentAttachment.attachmentId === expectedAttachmentId
      && new Date(currentAttachment.expiresAt).getTime() > now.getTime()) {
    currentAttachment.lastHeartbeatAt = now.toISOString();
    currentAttachment.expiresAt = new Date(now.getTime() + leaseMs).toISOString();
    return attachmentTokenFrom(currentAttachment);
  }

  // Conflict path: active lease held by someone else (expectedAttachmentId
  // either absent or doesn't match).
  if (currentAttachment
      && new Date(currentAttachment.expiresAt).getTime() > now.getTime()) {
    throw ApplicationFailure.nonRetryable(
      `Attached on ${currentAttachment.hostname} until ${currentAttachment.expiresAt}`,
      'AttachmentConflict'
    );
  }

  // Free or expired — claim fresh.
  const newAttachmentId = workflow.uuid4();
  currentAttachment = {
    attachmentId: newAttachmentId,
    hostname: host,
    adapterId,
    adapterClass,
    claimedAt: now.toISOString(),
    lastHeartbeatAt: now.toISOString(),
    expiresAt: new Date(now.getTime() + leaseMs).toISOString(),
    runId: workflow.workflowInfo().runId,
  };
  setPhase('attached');
  inFlightMessages.clear();   // fresh start; previous adapter's in-flight set is abandoned
  upsertSearchAttributes({
    ClaudeTempoAttachedHost: [host],
    ClaudeTempoAttachmentState: ['attached'],
    ClaudeTempoAttachmentId: [newAttachmentId],
  });
  return attachmentTokenFrom(currentAttachment);
});

function attachmentTokenFrom(a: Attachment): AttachmentToken {
  return {
    attachmentId: a.attachmentId,
    runId: a.runId,
    expiresAt: a.expiresAt,
    leaseMs: LEASE_MS,
  };
}
```

Key differences from B:
- `expectedAttachmentId` is on the input, not read from `{ source }`.
- `workflow.now()` not `Date.now()`.
- `workflow.uuid4()` for determinism.
- Pinned `runId` returned as part of the token — the adapter uses this for every subsequent handle.

### 9.3 Split-brain `--force` — decision

Panel finding #5: if host-A's sdk adapter is mid-`sendAndWait` when host-B force-steals the lease, host-A may deliver a ghost reply before it learns.

**Decision: option (a) — adapter cancels outstanding `sendAndWait` on lease-revocation detection. Residual ghost-reply window documented.**

Mechanism:

1. `BaseAttachment` polls `attachmentInfo` on a relaxed cadence (once per 5 heartbeat intervals, default 2.5 min) **and** on every workflow operation error. A result where `currentAttachment.attachmentId !== ourAttachmentId` fires `onLeaseRevoked`.
2. `SdkAttachment.onLeaseRevoked` calls the concrete class's `onSuperseded()` hook, which cancels the SDK-level in-flight call via AbortController / `session.cancel()` / adapter-specific mechanism.
3. The concrete `deliver()` continues to `try/catch` the SDK error; on `AbortError`, it exits cleanly. On `AttachmentMismatch` from the subsequent `processingEnd`/`reportDelivered` call, it exits cleanly.
4. `BaseAttachment` calls `shutdown('superseded')` on the adapter, and the adapter process exits.

**Ghost-reply window (residual, documented).** If the SDK doesn't support cancellation, or if the cancellation races the reply ("reply in flight on the network when cancel fires"), the following can happen:

- SDK returns a reply AFTER the lease has been revoked.
- The adapter calls `processingEnd(attachmentId, messageId)` — the update throws `AttachmentMismatch` (attachmentId doesn't match current).
- The adapter **does not** call `reportDelivered`. The workflow never sees the reply.
- The net user-visible impact: one LLM turn's cost is spent producing output that doesn't land. The message that was in flight re-enters the outbox (still undelivered) and the new host's adapter processes it on next poll.

Surfaced in the adapter README: "if your SDK does not support cancellation, up to one turn's worth of output may be discarded during a `--force` lease steal. This is bounded and at-most-once; no duplicate delivery or missed messages."

### 9.4 `WorkflowNotFound` adapter spec

Panel finding #7. The MCP subprocess's phase watcher polls at 10 s intervals. Between a workflow `gone` transition and the next poll, there's up to 10 s where the adapter doesn't know. If an operation during that window throws `WorkflowNotFoundError`, the adapter's handler must not synthesize a new workflow (that's exactly the #102 mechanism pre-rebuild).

**Spec (normative):**

> Any `WorkflowNotFoundError` or `WorkflowExecutionAlreadyCompletedError` returned from any adapter → workflow operation (query, signal, update) **must cause the adapter to:**
>
> 1. Stop its heartbeat loop.
> 2. Stop its delivery poll.
> 3. Call `shutdown('agent-exited')` on the concrete adapter (tearing down the agent subprocess).
> 4. Exit its own process with code 0 if the shutdown was clean, 1 otherwise.
>
> The adapter **must not:**
>
> - Call `client.workflow.start(...)` with any conflict/reuse policy.
> - Re-resolve the handle by workflowId alone (without runId pinning).
> - Retry the operation.
> - Delegate recovery to any outer retry loop.

This is enforced in `BaseAttachment`. Concrete adapters inherit the behavior and cannot override it.

### 9.5 Heartbeat timeout in the main loop

```typescript
// Main loop (pseudocode)
while (!destroyRequested) {
  const now0 = workflow.now().getTime();
  const deadlines = [
    currentAttachment
      ? new Date(currentAttachment.expiresAt).getTime()
      : Number.MAX_SAFE_INTEGER,
    (phase === 'processing' && processingSince)
      ? new Date(processingSince).getTime() + PROCESSING_DEADLINE_MS
      : Number.MAX_SAFE_INTEGER,
    (phase === 'draining' && drainingSince)
      ? new Date(drainingSince).getTime() + DRAINING_DEADLINE_MS
      : Number.MAX_SAFE_INTEGER,
  ];
  const nextDeadline = Math.min(...deadlines);
  const wait = Math.max(0, nextDeadline - now0);

  await Promise.race([
    condition(() => destroyRequested || /* other wake conditions */),
    workflow.sleep(wait),
  ]);

  const now = workflow.now();

  // (a) Lease expiry — transitions any phase (except gone) to detached.
  if (currentAttachment && new Date(currentAttachment.expiresAt).getTime() <= now.getTime()) {
    const reaped = currentAttachment;
    currentAttachment = null;
    inFlightMessages.clear();
    processingSince = null;
    setPhase('detached');
    upsertSearchAttributes({
      ClaudeTempoAttachedHost: [''],
      ClaudeTempoAttachmentState: ['detached'],
      ClaudeTempoAttachmentId: [''],
    });
    emitHistoryEvent('lease-expired', { attachmentId: reaped.attachmentId, at: now.toISOString() });
    continue;
  }

  // (b) processingDeadline fire — force exit from 'processing' so stale
  //     detection can re-engage. Clear the in-flight set (orphan messageIds
  //     logged for audit); phase goes back to 'attached'.
  if (phase === 'processing'
      && processingSince
      && new Date(processingSince).getTime() + PROCESSING_DEADLINE_MS <= now.getTime()) {
    const abandoned = Array.from(inFlightMessages);
    inFlightMessages.clear();
    processingSince = null;
    setPhase('attached');
    upsertSearchAttributes({ ClaudeTempoAttachmentState: ['attached'] });
    emitHistoryEvent('processingTimeout', {
      attachmentId: currentAttachment?.attachmentId,
      deadlineMs: PROCESSING_DEADLINE_MS,
      abandonedMessageIds: abandoned,
      at: now.toISOString(),
    });
    workflow.log.warn(
      `processingDeadline exceeded for attachment ${currentAttachment?.attachmentId}; ` +
      `abandoned ${abandoned.length} in-flight messageId(s): ${abandoned.join(', ')}`
    );
    continue;
  }

  // (c) drainingDeadline fire — draining exhausted its grace window; force
  //     the phase to 'detached' even though adapterExited never arrived.
  if (phase === 'draining'
      && drainingSince
      && new Date(drainingSince).getTime() + DRAINING_DEADLINE_MS <= now.getTime()) {
    const stuck = currentAttachment;
    currentAttachment = null;
    inFlightMessages.clear();
    processingSince = null;
    drainingSince = null;
    setPhase('detached');
    upsertSearchAttributes({
      ClaudeTempoAttachedHost: [''],
      ClaudeTempoAttachmentState: ['detached'],
      ClaudeTempoAttachmentId: [''],
    });
    emitHistoryEvent('drainingTimedOut', {
      attachmentId: stuck?.attachmentId,
      deadlineMs: DRAINING_DEADLINE_MS,
      at: now.toISOString(),
    });
    continue;
  }
}
```

Uses `workflow.now()` throughout. `emitHistoryEvent` and `workflow.log.warn` are deterministic because they're write-only sinks (Temporal history is replay-safe).

### 9.6 Cross-host `restart` and `migrate`

- **Planned migration.** User on host-B: `claude-tempo restart <name> --host=host-B`. §8.2 flow with `targetHost=host-B`. Spawn activity routes to `claude-tempo-host-B` task queue.
- **Recovery migration.** Host-A is gone. Lease expires after 90 s. User on host-B: `claude-tempo restore --from-host=host-A <name>` or `claude-tempo restart <name> --host=host-B`. Same flow.
- **`migrate` tool.** Sugar for `restart --host=<h>`. Separate verb for UX clarity.

### 9.7 Pause × attachment phase interaction

| Phase | `paused=true`? | Outbox dispatch? | `processingStart`/`End`? |
|---|---|---|---|
| `attached` / `awaiting` | false | yes | yes |
| `attached` / `awaiting` | true | no (except `stop`/`destroy` bypass) | yes |
| `processing` | false | yes | yes |
| `processing` | true | no | yes |
| `draining` | either | drains existing only | yes (allows current in-flight to complete) |
| `detached` | either | no | rejected with `AttachmentMismatch` |
| `gone` | either | no | rejected with `WorkflowGone` |

Pause is orthogonal to the attachment lifecycle — it gates dispatch, not attach/detach/heartbeat.

---

## 10. Daemon as restore agent

### 10.1 Reconcile-on-boot

When the daemon starts on host-X:

```typescript
async function reconcileOnBoot(config: Config) {
  const candidates = await client.workflow.list({
    query: `
      WorkflowType = "claudeSessionWorkflow"
      AND ExecutionStatus = "Running"
      AND (
        (ClaudeTempoAttachedHost = "${hostname}" AND ClaudeTempoAttachmentState IN ("attached","processing","awaiting","draining"))
        OR (ClaudeTempoAttachmentState = "detached" AND ClaudeTempoHostname = "${hostname}")
      )
    `,
  });

  const orphans: OrphanCandidate[] = [];
  for await (const wf of candidates) {
    const info = await getHandle(wf.workflowId).query('attachmentInfo');
    // Skip if adapter is alive (PID file match — daemon might have just restarted under a live adapter).
    if (info.currentAttachment && isAdapterProcessAlive(info.currentAttachment.hostname, wf.workflowId)) continue;
    orphans.push({ workflowId: wf.workflowId, info });
  }
  return orphans;
}
```

### 10.2 Restore policies

`~/.claude-tempo/config.json` gains:

```jsonc
{
  "restorePolicy": "prompt",         // "auto" | "prompt" | "never"
  "autoRestoreMaxAgeHours": 24,      // for "auto"
  "autoRestoreEnsembles": ["my-*"]   // glob allowlist
}
```

- **`auto`**: daemon calls `restart` on each orphan in the allowlist within age window. Logs every action.
- **`prompt`**: daemon records orphans; CLI `claude-tempo restore` interactively confirms each.
- **`never`**: nothing happens automatically.

### 10.3 CLI `restore` command

```
claude-tempo restore                    # interactive picker
claude-tempo restore <name>             # specific orphan
claude-tempo restore --all              # all orphans, respects allowlist
claude-tempo restore --from-host=<h>    # orphans whose preferred-host is <h>
claude-tempo restore --dry-run          # list only
```

Thin wrapper over the `restart` MCP tool / TempoClient.

### 10.4 Agent class captured at recruit (panel finding #16)

At recruit time, the tool resolves `adapterId` and `adapterClass` via the `AdapterRegistry` **once** and stores both in `SessionMetadata`. The workflow never re-resolves. Every `claimAttachment`, every spawn activity, every restore operation reads `metadata.adapterId` / `metadata.adapterClass`.

```typescript
// src/tools/recruit.ts
const descriptor = registry.get(args.agent ?? 'claude-code');
await client.workflow.start(claudeSessionWorkflow, {
  args: [{
    metadata: {
      ...,
      adapterId: descriptor.adapterId,
      adapterClass: descriptor.adapterClass,
    },
    ...
  }],
});
```

Consequence: if the user renames an adapter in a future release (e.g., `copilot` → `github-copilot`), existing workflows keep their old `adapterId` and continue to dispatch to whatever the registry still registers under that name. A breaking rename requires either (a) a registry alias, or (b) one-time migration of workflow metadata via CLI script.

### 10.5 OS integration (best-effort)

| OS | Integration | What ships |
|---|---|---|
| Linux | `systemd --user` unit | `claude-tempo.service` |
| macOS | `launchd` agent | `com.claude.tempo.plist` |
| Windows | NSSM wrapper or Task Scheduler | `claude-tempo daemon install-service` |

CLI:

```
claude-tempo daemon install
claude-tempo daemon uninstall
claude-tempo daemon status --service
```

### 10.6 Failure modes

- **Daemon starts, Temporal unreachable.** Retry every 30 s; never give up; log every failure.
- **Daemon starts with workflow claiming a dead host.** Normal path: lease expires in 90 s; next reconcile offers restore.
- **User starts session on host-B while host-A's daemon auto-restores same workflow.** `claimAttachment` is atomic; one side wins. The daemon checks `attachmentInfo` before claiming and backs off silently on `AttachmentConflict` (respects user intent).

---

## 11. Consolidated wire protocol

> Single table per panel finding #8. Columns: Name · Type · Caller · Input · Output · Purpose · Idempotent.

### 11.1 Session workflow surface (new and modified for v0.25.0-beta.1)

| Name | Type | Caller | Input | Output | Purpose | Idempotent |
|---|---|---|---|---|---|---|
| `claimAttachment` | Update | Adapter (via `BaseAttachment`) | `{ host, adapterId, adapterClass, leaseMs, expectedAttachmentId? }` | `AttachmentToken { attachmentId, runId, expiresAt, leaseMs }` or `ApplicationFailure(AttachmentConflict | WorkflowGone)` | Transactionally claim/renew the attachment. | Yes (same `expectedAttachmentId` → renewal returns same token) |
| `forceDetach` | Update | Operator tool (`restart --force`), workflow itself (on spawn-failed rollback) | `{ reason: DetachReason, expectedAttachmentId?, gracePeriodMs }` | `{ reaped: boolean, previousAttachmentId?: string }` | Revoke current attachment. Option to allow drain grace window. | Yes (already-detached returns `reaped: true`) |
| `destroy` | Update | Operator tool (`destroy`) | `{ reason: string, terminatedBy: string }` | `void` or `ApplicationFailure(WorkflowGone)` | Terminal — COMPLETE the workflow. | Yes (already-`gone` returns silently) |
| `processingStart` | **Update** | Sdk adapter (inside `deliver`) | `{ expectedAttachmentId, messageId }` | `{ inFlightCount }` or `ApplicationFailure(AttachmentMismatch | WorkflowGone)` | Enter `processing` phase (if in-flight set was empty). Tracks messageId in in-flight set; idempotent via Set semantics. | Yes (duplicate add is no-op) |
| `processingEnd` | **Update** | Sdk adapter (inside `deliver`, in `finally`) | `{ expectedAttachmentId, messageId }` | `{ inFlightCount }` or `ApplicationFailure(AttachmentMismatch | WorkflowGone)` | Remove messageId from in-flight set. If empty, exit `processing` phase. | Yes (duplicate delete is no-op) |
| `enqueueSpawn` | Update | `restart` tool | `{ host, attachmentId, runId, resume, sessionId?, adapterId }` | `{ spawnEntryId: string }` | Queue a spawn outbox entry carrying the claim token. | No (creates a new entry; caller can compute the entry ID deterministically via `workflow.uuid4()` to dedup if desired) |
| `setPreferredHost` | Update | Operator / adapter | `{ host: string }` | `void` | Update daemon auto-restore target host. | Yes |
| `heartbeat` | Signal | Adapter (`BaseAttachment`) | `{ attachmentId, at: string /* ISO */ }` | — | Liveness proof; resets `lastHeartbeatAt` and `expiresAt` if attachmentId matches. | Yes (each signal is last-write-wins) |
| `requestDetach` | Signal | Adapter / conductor / operator | `{ reason: DetachReason, deadlineMs }` | — | Ask current adapter to detach. Workflow → `draining`. | Yes (already-draining ignores; doesn't reset deadline) |
| `adapterExited` | Signal | Adapter (final call before exit) | `{ attachmentId, reason: DetachReason }` | — | Confirm adapter teardown complete. Workflow `draining → detached`. | Yes (extra signal on `detached` ignored) |
| `attachmentInfo` | Query | Anyone (adapter polls; tools read) | — | `{ phase, currentAttachment?: Attachment, preferredHost?: string, inFlightCount, processingSince?: string }` | Current attachment state + phase. | N/A (read-only) |
| `orphanSummary` | Query | Daemon, CLI `restore` | — | `{ detachedSince?: string, reason?: DetachReason, preferredHost?: string, lastAdapter?: { hostname, adapterId } }` | Restoration metadata for orphan UX. | N/A (read-only) |

### 11.2 Search attributes (new)

| Name | Type | Written by | Purpose |
|---|---|---|---|
| `ClaudeTempoAttachedHost` | Keyword | Workflow on phase transition | Current attachment host; `""` when `detached`. |
| `ClaudeTempoAttachmentState` | Keyword | Workflow on phase transition | One of the seven phases. |
| `ClaudeTempoAttachmentId` | Keyword | Workflow on phase transition | Current `attachmentId`; `""` when `detached`. |

### 11.3 MCP tool / CLI surface (new and renamed)

| Tool | Status | Replaces | Purpose |
|---|---|---|---|
| `restart` | **New** | `encore`, `recruit --force`, "stop + recruit" | Reap + re-claim + spawn. |
| `detach` | **New** | Old `stop` (graceful behavior) | Graceful reap without `destroy`. |
| `destroy` | **New** | Old `stop --force` | Terminate workflow permanently. |
| `restore` | **New** | — | Daemon-side orphan recovery. |
| `migrate` | **New** (sugar) | — | `restart --host=<h>` alias. |
| `attachmentInfo` | **New** (diagnostic wrapper) | — | CLI/MCP access to query. |
| `stop` | **Removed** | — | v0.24's `stop` behavior gone. CLI prints a one-line migration hint: "Use `detach` or `destroy`." |
| `encore` | **Removed** | — | CLI prints a one-line hint: "Use `restart`." |

### 11.4 What does NOT change

- Outbox entry types (`cue`, `report`, `recruit`, `release`) — untouched.
- Hold/release (`releaseHeld`, `outboxLocked` query, `heldMessage`) — untouched.
- Pause/resume (`setPaused`, `paused` query, `maestroSetPaused`) — untouched.
- Conductor surfaces (quality gates, worktrees, stages, commands, reports) — untouched.
- Maestro workflows — untouched.
- Scheduler workflow — untouched.
- `receiveMessage`, `recordSentMessage`, `markDelivered`, `setPart`, `setName`, `updateMetadata`, `submitOutbox`, existing queries — unchanged in shape (some interact with new state but their inputs/outputs are identical).
- `checkAndSetStatus` — **removed**. Its only caller (`performEncore`) goes away; attachment lifecycle updates (`claimAttachment`, `forceDetach`, `destroy`) replace it.

### 11.5 Documentation mandate

Every new surface in §11.1 and §11.2 lands in `docs/WIRE-PROTOCOL.md` in the **same commit** that adds it to code. The `checkAndSetStatus` removal lands in the same commit. CI wire-protocol-diff check (see §17.5) enforces.

---

## 12. Error-message specification

Canonical text for every error surface. Engineers implementing adapters and tools match these exactly — operators see them and know what to do.

### 12.1 `ApplicationFailure` names (workflow-thrown)

| Name | Thrown by | Canonical message template | Caller handling |
|---|---|---|---|
| `AttachmentConflict` | `claimAttachment` | `Attachment held by ${hostname} until ${expiresAt} (attachmentId=${attachmentId})` | `restart` surfaces the hostname; user decides `--force` or abort. |
| `AttachmentMismatch` | `processingStart`, `processingEnd`, `forceDetach` (when `expectedAttachmentId` doesn't match) | `Expected attachmentId ${expected}, got ${actual}` | Adapter fires `onLeaseRevoked` and exits; see §9.3. |
| `WorkflowGone` | `claimAttachment`, `processingStart`, `processingEnd`, `forceDetach`, `destroy` (when `phase === 'gone'`) | `Workflow ${workflowId} is destroyed` | Adapter exits cleanly per §9.4; operator tool surfaces the message and suggests `recruit`. |
| `AlreadyDetached` | `detach` tool (applied to already-`detached`) | `Player "${name}" is already detached` | CLI: info-level output (`ok(...)` with note); no error. |
| `WorkflowNotFound` (SDK-native) | Any operation against a pinned runId that doesn't exist | Temporal SDK default | **Two surfaces, two behaviors.** **(1) Adapter surface — heartbeat, `claimAttachment` renewal, `processingStart`/`End`, `forceDetach`, `adapterExited`, phase-watcher: terminal. See §9.4: adapter surface does not retry.** Stop heartbeat, stop delivery, shutdown, exit. No re-resolve by workflowId alone, no `workflow.start`, no reuse/conflict policy. **(2) Operator tool surface — `detach`, `destroy`, `attachmentInfo`, `restore`, TUI wrappers: one-shot retry without runId pin is allowed as a *user-convenience hedge only*** for the operator-holding-a-stale-handle case (user ran `claude-tempo detach foo` after the workflow continued-as-new'd between list and act). If the un-pinned retry also returns `WorkflowNotFound`, surface `Error: no workflow "${name}". It may have been destroyed; run \`recruit\` to create a fresh one.` and exit with code 2. This convenience hedge **does not apply** to attachment, heartbeat, or processing updates — those are surface (1). |
| `DrainingTimedOut` | Main loop on `drainingDeadline` | `Attachment ${attachmentId} failed to drain within ${deadlineMs}ms` | Workflow emits history event; phase → `detached` regardless; no caller-visible error (async). |
| `ProcessingTimedOut` | Main loop on `processingDeadline` | `In-flight messages ${messageIds.join(',')} exceeded processingDeadline ${deadlineMs}ms` | Workflow emits history event; phase → `attached`; stale detection re-enabled. |
| `SpawnFailed` | Outbox dispatch on spawn activity failure | `Spawn activity for attachmentId=${attachmentId} failed: ${reason}` | Workflow auto-forceDetaches (§8.4); user sees the message in `attachmentInfo` / TUI. |

### 12.2 CLI user-facing text

| Situation | Output |
|---|---|
| `claude-tempo restart foo` on nonexistent player | `Error: no workflow for "foo". Use \`recruit\` to create one.` (exit 2) |
| `claude-tempo restart foo` on `gone` | `Error: "foo" was destroyed. Use \`recruit\` to create a fresh one.` (exit 2) |
| `claude-tempo restart foo` without `--force`, live attachment | `Error: "foo" attached on host-A until 2026-04-12T13:47:00Z. Use \`--force\` to steal.` (exit 3) |
| `claude-tempo detach foo` already detached | `"foo" is already detached. Nothing to do.` (exit 0) |
| `claude-tempo destroy foo` without `--yes` | Interactive prompt: `Permanently destroy "foo"? This abandons in-flight messages and COMPLETES the Temporal workflow. [y/N]` |
| `claude-tempo recruit --agent=unknown` | `Error: unknown adapter "unknown". Registered: claude-code, copilot. Run \`claude-tempo agent-types\` for details.` (exit 2) |
| Adapter's `WorkflowNotFound` exit | Stderr log line: `[adapter ${attachmentId}] workflow ${workflowId} not found; exiting cleanly (per §9.4 spec)` |

### 12.3 Error message invariants

- All errors include the `workflowId` or `playerName` — operators must be able to copy-paste the identifier.
- All time-bearing errors include an ISO timestamp — log analysis needs machine-readable timestamps.
- No error message contains "unknown error." Every branch has a canonical name from §12.1.
- Adapter errors **never** include stack traces in user-facing output; only in logs.

---

## 13. Bug mapping

### 13.1 #99 — false stale on `sendAndWait`

**Mechanism today:**

1. Copilot bridge calls `session.sendAndWait(prompt, 300_000)` — blocks up to 5 min.
2. Bridge's `processing` flag prevents further polling.
3. Workflow sees undelivered messages; 3-min undelivered-age counter fires.
4. Workflow transitions `active → stale`. `encore` cycle follows.

**Why PR #100 failed:** Moving `markDelivered` ahead of `sendAndWait`:

1. Breaks at-least-once delivery (a failed `sendAndWait` leaves the message marked delivered).
2. Doesn't unblock the poller from picking up messages arriving during `sendAndWait`.
3. Still fails if no messages arrive for 3 min while one sits mid-`sendAndWait`.

**Rebuild elimination:**

- Sdk `deliver()` wraps each call in `processingStart(messageId)` → … → `processingEnd(messageId)` as **updates** (synchronously acked, idempotent via messageId).
- Workflow phase `processing` suppresses undelivered-age detection.
- Heartbeat proves liveness independently.
- `reportDelivered` fires only on successful completion — at-least-once preserved.
- `processingDeadline` (15 min) backstops.

### 13.2 #102 — terminated session resurrection

**Mechanism today** (diag `scripts/diag-issue-102.ts` verdict B):

1. Graceful `stop` sets `status=terminated`; workflow COMPLETES.
2. Bridge's outer poller continues; errors → `recreateSession`.
3. `recreateSession` spawns fresh Copilot SDK session → fresh MCP subprocess.
4. Fresh MCP subprocess calls `client.workflow.start(..., USE_EXISTING)`.
5. Prior workflow is COMPLETED, so `USE_EXISTING` doesn't apply; `WorkflowIdReusePolicy` default `ALLOW_DUPLICATE` starts fresh RUNNING workflow with **new runId**.
6. Bridge's un-pinned `getHandle(workflowId)` silently tracks new runId.
7. Conductor sees "alive again"; encore/cue succeed; context is gone; loop.

**Why PR #101 failed:** Premised on `USE_EXISTING` returning a dead handle for a COMPLETED workflow; diag verdict B disproves. `TERMINATE_EXISTING` in a race is more dangerous than `USE_EXISTING`.

**Rebuild elimination:**

- Graceful detach → `attached → draining → detached`. Workflow stays `RUNNING`.
- The outer poller **is** `BaseAttachment`, which explicitly handles `requestDetach` → `drain` → `shutdown` with no recovery path that re-creates a workflow.
- MCP subprocess watches phase via `attachmentInfo`; on `detached` or `gone` it exits. No `handle.result()` coupling to workflow completion.
- RunId pinned on every operation. Any silent substitution manifests as `WorkflowNotFound` and the adapter exits per §9.4 spec.
- `destroy` is the **only** COMPLETE path; invoked only by explicit operator action; adapter never invokes it from recovery.

### 13.3 Other issues in scope

| Issue | Status today | Rebuild result |
|---|---|---|
| #93 Resume should restart orphaned player sessions | Open | Natural result of daemon `reconcileOnBoot` + `restore` (§10). |
| #32 `context_reset` tool | On-hold | `restart --fresh` is exactly this — skip context replay. |
| #18 Headless JSON-RPC session mode | On-hold | Orthogonal; adapter extensibility contract (§4) makes it plug-in. |
| #67 HTTP gateway | On-hold | Orthogonal. |

### 13.4 Potential regressions and mitigations

| Regression | Mitigation |
|---|---|
| Workflows accumulate forever without `destroy` | Daemon `cleanupPolicy` (default: compact workflows `detached > 7 days`; explicit `destroy` at `> 30 days`, disable-able). |
| `processing` masks genuinely dead adapters | Heartbeat runs independently; heartbeat-timeout (90 s) still fires during `processing`; `processingDeadline` (15 min) forces exit. |
| `--force` lease steal is a footgun | CLI interactive confirm: "Steal attachment from ${host}? [y/N]"; MCP tool requires explicit `force: true`. |
| Adapter classes diverge as new SDKs ship | `BaseAttachment` covers ~80 % of behavior; conformance suite (§4.5) catches drift. |

---

## 14. Tactical MVP scope (`fix/mvp-99-102`)

> **Status at time of writing:** `fix/mvp-99-102` branch is in flight (tempo-eng implementation). Target merge window: before v0.25.0-beta.1.

The MVP's purpose is to close #99 and #102 **using this design's mechanisms** but without the full 7-phase lifecycle rebuild or the adapter refactor. It's a carve-out borrowed from Rebuild A's minimum-viable-cut concept, implemented with v2's correct semantics.

### 14.1 What the MVP lands

| Mechanism | MVP? | Full rebuild? |
|---|---|---|
| `processingStart`/`processingEnd` as **updates** (§7) | Yes | Yes |
| `messageId` idempotency key on both | Yes | Yes |
| In-flight Set tracking | Yes | Yes |
| `processing` phase in the workflow | Yes, as an internal flag (not a new search-attribute value) | Yes, as full phase enum |
| RunId pinning on claim | Yes (on every `client.workflow.start` / `getHandle`) | Yes |
| `destroy` update (internal `terminated` flag, pre-COMPLETE) | Yes — closes #102 at the MCP subprocess level | Yes, plus full phase machine |
| Adapter's `WorkflowNotFound` MUST exit cleanly spec | Yes | Yes |
| 7-phase state machine (`booting`/`attached`/`processing`/`awaiting`/`draining`/`detached`/`gone`) | **No** — MVP keeps legacy `pending`/`active`/`stale`/`terminated` status plus an internal `processing` flag | Yes |
| Adapter directory refactor (`src/adapters/<name>/`) | **No** — `src/channel.ts` and `src/copilot-bridge.ts` stay where they are | Yes |
| Adapter descriptor + registry | **No** | Yes |
| `claimAttachment` / `forceDetach` / lease model | **No** — MVP keeps "last writer wins" | Yes |
| Multi-host coordination | **No** | Yes |
| Daemon `reconcileOnBoot` | **No** | Yes |
| `detached` phase + `restart` verb | **No** — MVP leaves today's `encore` alone; `stop --force` still maps to `handle.terminate()` after setting `terminated` flag first | Yes |

### 14.2 Scope boundary

The MVP is a **bug fix**, not an architectural change. It does the smallest amount of work to make #99 and #102 no longer reproduce, using the same mechanisms the full rebuild uses so there's no throwaway work. When the full rebuild lands in v0.25.0-beta.1:

- MVP's `processingStart`/`processingEnd` updates are kept as-is; their implementation simply expands from "toggle an internal flag" to "transition the phase enum + update search attribute."
- MVP's `messageId` in-flight set is kept as-is.
- MVP's runId pinning is kept as-is.
- MVP's `destroy` update is kept; its semantics expand to "transition to `gone` phase, revoke attachment, COMPLETE" instead of "set `terminated` flag, then `handle.terminate`."
- MVP's `WorkflowNotFound` spec is kept.
- Everything else (adapter directory, lease model, 7-phase state machine, multi-host, daemon) is **additive** on top of the MVP and doesn't rework what shipped.

### 14.3 Reference

MVP branch: `fix/mvp-99-102`.
MVP PR (expected): "fix(workflow,bridge): close #99 + #102 via processing updates + destroy verb (MVP of v0.25 rebuild)."
MVP does not ship under the `v0.25.0-beta.1` tag; it ships in a patch release (e.g., `v0.24.1`) so users get the fix ahead of the full rebuild.

### 14.4 What MVP does **not** fix

- Cross-host recruit still uses static `ClaudeTempoHostname`.
- Orphaned sessions after host crash still require manual `encore`.
- Closing a Claude Code terminal still leaves the session in `stale` (not `detached`); MVP does not introduce the `detached` phase.
- `encore` still requires the legacy `stale` status and has the precondition races described in Rebuild B §1 surface #2.

These are addressed only by the full rebuild.

---

## 15. Upgrade notes

Backward compatibility is not a concern at v0.25.0-beta.1. The upgrade path is one paragraph.

> **Upgrading from v0.24.x to v0.25.0-beta.1 / v0.25.0.** Stop every running session (`claude-tempo stop-all` if available, otherwise stop each ensemble), stop the daemon (`claude-tempo daemon stop`), `npm i -g @vinceblank/claude-tempo@beta` (or upgrade the local dependency), restart the daemon, restart each ensemble. Existing workflows that were running under v0.24.x will be **terminated** during the upgrade — the new workflow bundle's phase enum and state shape are incompatible with the old one, and there is no compat shim. Data loss scope: any messages still in-flight at stop time are lost; outbox entries that had been delivered are already persisted at the receiving player. Lineups (YAML) and schedules survive the upgrade; re-`load_lineup` to spin the ensemble back up.

For the implementing engineer:

- No compat reads/writes against `ClaudeTempoStatus` legacy values. The new enum is the only enum.
- No `checkAndSetStatus` backwards path.
- No `_legacyCompat` markers on outbox entries.
- `docs/UPGRADING.md` is a short file that expands this paragraph with the operator checklist; `docs/WIRE-PROTOCOL.md` is rewritten (not edited incrementally).

---

## 16. Open questions

Real design decisions I didn't want to resolve unilaterally.

### 16.1 Should `processingDeadline` be per-message or per-session?

**Option A — per-session.** One 15-min timer starting at `processingSince`; clears when the in-flight set empties.

**Option B — per-message.** Each messageId gets its own 15-min deadline; set entries carry `{ startedAt }`; timer fires per-entry.

**Recommendation: A.** Simpler state. A genuinely-pathological multi-message session is rare; the per-session timer catches it. Per-message adds complexity for edge-case fidelity we don't need yet.

### 16.2 Heartbeat cadence — configurable, per-descriptor, or global?

**Option A — global 30 s default, single config key.**

**Option B — per-adapter-descriptor.** Each descriptor declares its own `heartbeatMs`; the workflow accepts different cadences per attachment.

**Option C — per-attachment.** `claimAttachment` accepts `leaseMs`; heartbeat derives as `leaseMs / 3`.

**Recommendation: B (per-descriptor) + C (per-attachment override).** Interactive adapters don't need 30 s — MCP is fast; 60 s is fine. Sdk adapters should pin at 30 s for tighter failure detection during long turns. Per-attachment override lets tests use lower values (2 s heartbeat, 6 s lease).

### 16.3 Attachment token storage (adapter-side)

**Option A — memory only.** Adapter crashes mid-claim: lease expires in 90 s. Simple; slightly slow recovery.

**Option B — persist to PID file.** `logs/{playerName}.pid` carries `{ pid, attachmentId, runId, workflowId }`. Costs an fs write per attach; recoverable.

**Option C — re-fetch from workflow.** Adapter asks `attachmentInfo` before claiming; if already attached with matching hostname, reuse. Requires unique `hostname` per adapter process (UUID suffix), which is a small change.

**Recommendation: C primary, B as belt-and-suspenders.** C is clean and uses an existing query. B helps when Temporal is temporarily unreachable.

### 16.4 Should closing a Claude Code terminal `detach` or `destroy`?

**Option A — detach (default preserve).** User can `restart` later; data loss is worse than clutter.

**Option B — destroy (default cleanup).** Less state to clean up; aligns with "terminal closed = done."

**Recommendation: A.** Daemon compaction (§13.4 regression row 1) cleans up stale detached workflows automatically. Preserving by default respects user intent (they didn't run `destroy`).

### 16.5 Cross-host `--force` — require `--yes-steal`?

**Option A — `--force` alone is enough.** Same escalation today's `stop --force` uses.

**Option B — `--force --yes-steal=hostname`.** Must name the host being stolen from; prevents accidental remote stealing.

**Recommendation: B.** Affecting another machine deserves a higher bar. MCP tool: `{ force: true, confirmStealFromHost: 'host-A' }`.

### 16.6 Should `restart` auto-create a fresh workflow for a destroyed name?

**Option A — fail with an explicit "use recruit" message.** (Current §8.2.)

**Option B — prompt in CLI, fail in MCP.** Symmetric with destroy's interactive prompt.

**Option C — auto-create silently.** Most ergonomic; risks accidentally re-creating workflows the user thought were gone.

**Recommendation: A.** The explicit verb split prevents accidents. Users who want reuse can run `recruit` directly.

### 16.7 Should `processingStart`/`End` validators reject unknown messageIds?

An update with `messageId` not in the workflow's inbox means the adapter is confused. Options:

**A.** Accept silently (dedup-set semantics handle it).
**B.** Reject with `UnknownMessageId` application failure.
**C.** Log-and-accept (accept but emit a history event for audit).

**Recommendation: C.** Gives operators visibility into adapter bugs without breaking delivery. Set semantics still prevent correctness issues.

### 16.8 Contested claim storm — rate limit?

If N adapters race on the same workflow simultaneously (e.g., after a daemon restart across multiple hosts all targeting the same orphan), `claimAttachment` serializes them per Temporal's update ordering guarantees. No rate-limit needed for v1. Revisit if telemetry shows storms.

**Recommendation:** document the current behavior; don't add rate limiting now.

### 16.9 Heartbeat lease math — `3 × heartbeatMs`?

- 2× → detects ~60 s; but one skipped heartbeat due to transient network noise triggers a false detach.
- **3× (default) → detects ~90 s**; tolerant to one network blip.
- 5× → detects ~150 s; very tolerant; slow to detect real crashes.

**Recommendation: 3×.** Tune via config if real-world data says otherwise.

---

## 17. Best-practices audit

Cross-checked against Temporal's official docs, the MCP spec, and the project's own `CLAUDE.md` + `docs/WIRE-PROTOCOL.md`.

### 17.1 Determinism

- All workflow-internal time reads use `workflow.now()`. No `Date.now()` inside workflow code. Verified against all new handlers in §7, §9.
- All UUIDs generated inside the workflow use `workflow.uuid4()`. The attachmentId on §9.2 is generated server-side via this.
- Timestamps entering state come from either `workflow.now()` or a signal/update payload. No computation that depends on local clocks.
- The `inFlightMessages` Set is deterministic under replay because `Set.add`/`Set.delete` are order-preserving by insertion and the workflow only mutates it in signal/update handlers.

### 17.2 `WorkflowIdConflictPolicy` and `WorkflowIdReusePolicy`

- Rebuild never COMPLETEs workflows except via `destroy`. The #102 path (completed workflow + `USE_EXISTING` + `ALLOW_DUPLICATE` spawns fresh run) cannot trigger.
- New spawns post-rebuild are triggered by `enqueueSpawn` → outbox → `spawnProcess` activity; they do not call `client.workflow.start` — they spawn adapter processes that call `claimAttachment`. Attach is the lifecycle trigger; start is not.
- For belt-and-suspenders, `spawnProcess`'s adapter-level start logic (if any) explicitly sets `WorkflowIdConflictPolicy.USE_EXISTING` + `WorkflowIdReusePolicy.RejectDuplicate`. A `gone` workflow rejected loudly is strictly better than silently resurrected.

### 17.3 `continueAsNew` rigor

- New state carried forward: `currentAttachment`, `inFlightMessages` (as array), `processingSince`, `preferredHost`. Existing state (outbox, messages, sentMessages, outboxLocked, heldMessage, paused) carried unchanged.
- Lease extension at CAN boundary (§2.3) prevents false expiry during sub-second transitions.
- `patched('v0.25-attachment-lifecycle')` marker on the new state-machine code path. No old/new co-existence requirement, but `patched` makes the rolling deploy across the worker fleet safe.
- `allHandlersFinished()` pattern preserved for hand-off; the new updates are fast (in-memory state mutations) so no meaningful wait time is added.
- **Task-queue inheritance.** CAN continuations inherit the parent's task queue (the shared `claude-tempo` queue for session workflows); the new execution lands on the same worker fleet. No per-CAN queue routing is needed, and there is no cross-queue migration hazard at CAN boundaries. The only rolling-deploy concern is worker-binary drift, which the `patched(...)` marker above addresses.

### 17.4 Signals vs updates vs queries

Applied per Temporal's guidance:

| Surface | Kind | Rationale |
|---|---|---|
| `claimAttachment` | Update | Returns `AttachmentToken`; transactional precondition (`expectedAttachmentId` match). |
| `processingStart`/`End` | Update | **Synchronous ack required** — dropped signals under network partition reproduce #99. Validates `expectedAttachmentId`. |
| `forceDetach` | Update | Returns `reaped: boolean`; callers act on the result. |
| `destroy` | Update | Returns on success; callers wait for confirmation. |
| `enqueueSpawn` | Update | Returns `spawnEntryId`; callers need confirmation the spawn was queued. |
| `setPreferredHost` | Update | Fast; returning void is fine, but update lets us reject invalid hosts synchronously. |
| `heartbeat` | Signal | Fire-and-forget; dropping one is acceptable (next one resets the lease). |
| `requestDetach` | Signal | Fire-and-forget; workflow may already be draining. |
| `adapterExited` | Signal | Fire-and-forget; workflow may already be detached. |
| `attachmentInfo`, `orphanSummary` | Query | Read-only; no side effects. |

### 17.5 Validators

Every new update has a validator that rejects invalid input synchronously:

- `claimAttachment`: `host` is a valid hostname string; `leaseMs > 0 && leaseMs <= 3600_000`; `adapterClass` ∈ known set; `adapterId` is a registered descriptor ID.
- `processingStart`/`End`: `expectedAttachmentId` matches `/^[0-9a-f-]{36}$/`; `messageId` non-empty.
- `forceDetach`: `reason` ∈ `DetachReason`; `gracePeriodMs >= 0`.
- `destroy`: `reason` non-empty; `terminatedBy` non-empty.
- `enqueueSpawn`: `attachmentId` UUID format; `runId` non-empty; `host` valid hostname; `adapterId` registered.
- `setPreferredHost`: `host` valid hostname.

Validators run synchronously inside the workflow and reject before any state change.

### 17.6 Activity retries and idempotency

| Activity | Retryable? | Idempotency |
|---|---|---|
| `spawnProcess` (enhanced with `attachmentId`) | Non-retryable on fatal; retryable on transient | Adapter checks `claimAttachment` on boot; if its `attachmentId` isn't current, exits cleanly. Second spawn with same `attachmentId` becomes a no-op at the workflow level. |
| `deliverCue` / `deliverReport` (outbox delivery) | Retryable with cap (existing behavior) | Unchanged; idempotent via `entryId`. |
| `terminateSession` (legacy) | **Removed** | — |
| `performEncore` (legacy) | **Removed** | — |

### 17.7 MCP protocol compliance

From https://modelcontextprotocol.io/specification/2025-06-18/basic/transports:

- stdio transport: no built-in reconnect. Rebuild respects this: the adapter's phase watcher observes `detached` or `gone` and exits cleanly; no reconnection logic attempts to hold the pipe alive.
- Notifications (server → client) are supported; `notifications/claude/channel` continues as interactive delivery.
- No stdout writes from server code; workflow and adapter logs go to stderr (workflow stays silent; Temporal's own logging handles workflow events).
- MCP subprocess exits on parent disconnect naturally (stdin close) AND on `attachmentInfo.phase ∈ {detached, gone}`.

### 17.8 Search attribute hygiene

- All new attributes (`ClaudeTempoAttachedHost`, `ClaudeTempoAttachmentState`, `ClaudeTempoAttachmentId`) are `Keyword` type. Low cardinality; safe for visibility indexing.
- Writes are eventually consistent (Temporal's guarantee). Readers that need real-time truth use the `attachmentInfo` query — documented in the query's description.
- The workflow never reads its own search attributes (that would be non-deterministic).

### 17.9 Wire protocol stability + CI diff

Every addition and every rename in §11 lands in `docs/WIRE-PROTOCOL.md` in the same commit. CI check lives at `test/wire-protocol.test.ts` (shipped in PR-G).

Uses a ts-morph AST walker to scan `src/workflows/*.ts` for `defineSignal` / `defineQuery` / `defineUpdate` string literals and diffs the extracted names against `docs/WIRE-PROTOCOL.md`; fails CI if any name in code is absent from docs, or vice versa. Non-breaking additions require `wire-protocol:additive` commit tag; renames/removals require `wire-protocol:breaking`. (Source-scan chosen over `dist/` scan: no build step required, and surfaces declared-but-unwired handlers that dead-code elimination would otherwise hide.)

### 17.10 Known hazards acknowledged

- **Clock skew across hosts.** Lease expiry uses `workflow.now()`; adapter-supplied timestamps in `heartbeat` are informational. The workflow sets `expiresAt = workflow.now() + leaseMs` on receipt, not adapter-reported.
- **Attach storms during multi-host daemon boot.** Serialized per Temporal's update ordering; loser sees `AttachmentConflict` and backs off.
- **Workflow bundle drift across deploys.** `patched('v0.25-attachment-lifecycle')` markers; rolling deploy safe.
- **Ghost replies after `--force` steal.** Bounded at-most-once; documented in §9.3 and each sdk adapter's README.
- **Adapter-level retry loops that don't respect `WorkflowNotFound`.** Conformance suite test #9 catches this.

---

## Appendix A — Changeset by phase

Per-file changes grouped by rollout phase. Phases are implementation order, not release gates (everything ships together in v0.25.0-beta.1).

### Implementation-time notes (for the implementing engineer)

- **Temporal retention vs. `RejectDuplicate` (§17.2, QA follow-up).** `WorkflowIdReusePolicy.RejectDuplicate` only rejects when the prior execution with the same `workflowId` is still within Temporal's retention window (default ~30 days on the dev server; namespace-configurable on self-hosted / Cloud). Once the prior execution falls out of retention, a fresh `workflow.start` with `RejectDuplicate` succeeds silently. The rebuild does not depend on `RejectDuplicate` for correctness — adapters never call `workflow.start` post-rebuild — but the belt-and-suspenders language in §17.2 should be read with this caveat. Document in `docs/WIRE-PROTOCOL.md`'s reuse-policy note during Phase 1.
- **Workflow history pressure from `emitHistoryEvent`.** New event types (`lease-expired`, `processingTimeout`, `drainingTimedOut`, `unknownMessageId`, `destroyed`) add a handful of events per long-lived session. Well within Temporal's per-workflow history size budget, but confirm after a 1-week soak in staging.
- **`messages` array scan cost in §7.2 unknown-messageId check.** `messages.some(m => m.id === messageId)` is O(n). If inbox grows large (>10k entries) before `continueAsNew` trims it, switch to a `Set<string>` index maintained alongside `messages[]`. Not a concern at expected traffic.

### Phase 1 — Workflow state machine + wire protocol

| File | Change |
|---|---|
| `src/types.ts` | Add `Attachment`, `AttachmentToken`, `AttachmentPhase`, `AttachmentInfo`, `AdapterClass`, `AdapterDescriptor`, `DetachReason`, `AdapterDirective`. Remove old `SessionStatus` values. |
| `src/workflows/signals.ts` | Add all new signals/queries/updates from §11.1. Remove `checkAndSetStatusUpdate` + deprecated signals (`setNameSignal` stays; `updateMetadataSignal` shrinks — no more `status` field). |
| `src/workflows/session.ts` | Rewrite state machine: seven-phase enum, `currentAttachment`, `inFlightMessages` set, `processingSince`, `preferredHost`. New handlers: §11.1. Lease extension at CAN boundary. Remove stale/blocked legacy detection. Keep hold/pause/outbox/receiveMessage/markDelivered/setPart handlers. |
| `docs/WIRE-PROTOCOL.md` | Rewrite — list every surface in §11.1. |

### Phase 2 — Adapter refactor

| File | Change |
|---|---|
| `src/adapters/base.ts` | **New.** `BaseAttachment`, `AdapterRegistry`, `AttachmentContext` impl, heartbeat loop, lease-revoked poller, `WorkflowNotFound` handler. |
| `src/adapters/index.ts` | **New.** Barrel + registry bootstrap. |
| `src/adapters/README.md` | **New.** How to add an adapter. |
| `src/adapters/claude-code/adapter.ts` | **New.** Moved from `src/channel.ts`; `InteractiveAttachment` class. |
| `src/adapters/claude-code/index.ts` | **New.** Descriptor registration. |
| `src/adapters/copilot/adapter.ts` | **New.** Moved from `src/copilot-bridge.ts`; `CopilotSdkAttachment extends SdkAttachment`. |
| `src/adapters/copilot/index.ts` | **New.** Descriptor registration. |
| `src/adapters/sdk/base.ts` | **New.** `SdkAttachment` abstract class. |
| `src/channel.ts` | **Remove** (content moved). |
| `src/copilot-bridge.ts` | **Remove** (content moved). |

### Phase 3 — Server + tools

| File | Change |
|---|---|
| `src/server.ts` | Adapter-class dispatch via `AdapterRegistry`. Remove `handle.result()` watcher. Phase watcher owned by `BaseAttachment`. |
| `src/tools/recruit.ts` | Resolve `adapterId`/`adapterClass` from registry once; store in metadata. Open-set validation. |
| `src/tools/restart.ts` | **New.** §8.2 algorithm. |
| `src/tools/detach.ts` | **New.** Graceful reap. |
| `src/tools/destroy.ts` | **New.** §8.5 semantics. |
| `src/tools/restore.ts` | **New.** §10.3 daemon restore wrapper. |
| `src/tools/migrate.ts` | **New.** `restart --host=<h>` alias. |
| `src/tools/attachment-info.ts` | **New.** Diagnostic query wrapper. |
| `src/tools/stop.ts` | **Remove** — print migration hint. |
| `src/tools/encore.ts` | **Remove** — print migration hint. |
| `src/tools/agent-types.ts` | Read from `AdapterRegistry` instead of hardcoded list. |

### Phase 4 — Daemon

| File | Change |
|---|---|
| `src/daemon.ts` | Add `reconcileOnBoot`, `cleanupLoop`, `restorePolicy` config read. |
| `src/cli/commands.ts` | Add `restart`/`detach`/`destroy`/`restore`/`migrate` CLI commands. Remove `stop`/`encore`. Add `daemon install`/`uninstall`. |

### Phase 5 — Tests and docs

| File | Change |
|---|---|
| `tests/adapters/conformance.spec.ts` | **New.** §4.5 conformance suite; parameterized over adapter descriptors. |
| `tests/regression/issue-99.spec.ts` | **New.** 6-min stub `invokeSdk` with pending message; verify phase `attached → processing → attached`; verify no `stale`/`detached` intermediate. |
| `tests/regression/issue-102.spec.ts` | Repurposed `scripts/diag-issue-102.ts` — verify destroy path never races fresh run; verify `WorkflowNotFound` adapter exit. |
| `tests/rebuild/reboot.spec.ts` | **New.** Start workflow, kill daemon + adapter, restart daemon, assert reconcile finds orphan, assert `restorePolicy=auto` restores. |
| `scripts/check-wire-protocol.ts` | **New.** §17.9 CI check. |
| `docs/WIRE-PROTOCOL.md` | Rewritten (see Phase 1). |
| `docs/UPGRADING.md` | **New.** Short expansion of §15. |
| `docs/adapters.md` | **New.** §4 extracted to its own doc for adapter authors. |
| `CLAUDE.md` | Updated key-concepts section to reflect new verbs, phases, adapter registry. |

---

## Appendix B — Illustrative timings

Defaults. All configurable via `~/.claude-tempo/config.json`.

- Heartbeat interval: **30 s** (per-descriptor override possible; sdk default 30 s, interactive default 60 s).
- Attachment lease (`leaseMs`): **90 s** (3 × heartbeat).
- `drainingDeadline`: **5 s**.
- `processingDeadline`: **15 min**.
- Daemon reconcile-on-boot retry: **30 s** between failed attempts.
- Daemon restore auto-policy max age: **24 h**.
- `attachmentInfo` phase-watch poll (adapter-side): **every 5 heartbeat intervals** (default 2.5 min for sdk) OR on any workflow-op error.
- Cleanup policy: compact `detached` > 7 d; `destroy` `detached` > 30 d (disable-able).

---

## Appendix C — Out of scope

This document deliberately does **not** propose:

- Changes to conductor-only surfaces (quality gates, worktrees, stages, commands, reports).
- Changes to Maestro workflows (per-ensemble or global).
- Changes to the scheduler workflow.
- An HTTP gateway (#67 stays on-hold).
- Automatic leader election across hosts (lease + explicit `--force` is the mechanism).
- Multi-leader / active-active attachment (single lease is a hard invariant).
- Shipping new adapter implementations beyond the Copilot and Claude Code rewrites; the headless Claude SDK worked example in §4.6 is illustrative, not a deliverable.
- Telemetry / metrics wiring beyond naming proposed counters (operators can add Prometheus later; out of scope here).
- SQL-level Temporal visibility queries (we use the built-in visibility API only).

---

**End of Proposal v2.**
