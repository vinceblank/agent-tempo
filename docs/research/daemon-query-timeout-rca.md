# RCA — daemon-killing workflow-query timeout (2026-07-13)

**Status:** mechanism confirmed. **Original hypothesis refuted.** Condition is **still live** on the
current daemon (pid 28676) and will recur.

## TL;DR

The daemon is **both the query client and the query server**. Its aggregate loop fires
**~20 Temporal queries/sec** (measured), and every one of them comes back to *its own* worker as a
query task that must execute on a **single workflow thread** (`workflowThreadPoolSize = 1` when
`reuseV8Context = true`, the SDK default) with a **5 s per-script wall-clock budget**
(`isolateExecutionTimeout: '5s'`, also default). Session histories **never continue-as-new**, so
replay cost grows monotonically. The two facts collide: a starved single thread replaying a
4,661-event history inside a 5 s budget → `Script execution timed out after 5000ms`.

The query handlers are **not** slow. Nothing is O(n) over unbounded state.

## Confirmed chain

1. **Self-inflicted query storm.** `action-counters`, 20-minute window, idle ensembles:

   ```
   total 24,828 actions │ aggregate: 14,774 queries │ maestro-ensemble: 6,285 │ maestro-global: 2,638
   ```

   ≈ **23,697 queries / 20 min ≈ 20 q/s, sustained, at idle.** Source: `client/core.ts` fires 4
   queries per player per poll tick (`getRunId`, `getMessagingState`, `getLeaseState`,
   `getCoarseActivity`) on a 750 ms loop. With 24 session workflows that is ~96 query tasks per tick
   before maestro/scheduler fan-out. Load is **O(players × ensembles), unconditional** — it does not
   decrease when the ensemble is idle.

2. **One thread serves all of it.** `@temporalio/worker/lib/worker-options.js:196`:

   ```js
   workflowThreadPoolSize: reuseV8Context ? 1 : 2,   // reuseV8Context defaults to true
   isolateExecutionTimeout: debugMode ? '4294967295ms' : '5s',   // line 195
   ```

   `src/worker.ts:116` sets neither. So **all 31 running workflows share one V8 context on one
   thread**. This directly answers "does one slow query starve others?" — **yes, by construction.**
   (Cache size is *not* the problem: `defaultMaxCachedWorkflows` ≈ 2,310 at a 4 GB heap.)

3. **WFT timeouts invalidate sticky → queries go legacy → full replay.** cll-devops history contains
   **24 × `WORKFLOW_TASK_TIMED_OUT`**, and the log is full of
   `Task not found when completing`. Each WFT timeout drops the workflow's sticky queue, so the
   server re-dispatches subsequent tasks *and queries* on the non-sticky path with **full history** —
   hence the log line `Failing legacy query request`. A legacy query must **replay the entire
   history** inside `runInContext`, under the 5 s budget.

4. **History grows without bound; CAN never fires.** cll-devops: **4,661 events / 886 KB after 23 h**,
   still on its first run. `session.ts:2428` gates continue-as-new on `info.continueAsNewSuggested`,
   which the server only sets at ~10,240 events / ~10 MB. So replay cost climbs all day and across
   days. History composition:

   ```
   1,466  WORKFLOW_EXECUTION_SIGNALED   ← 1,418 of these are `heartbeat` (1/min/session)
     859  WORKFLOW_TASK_SCHEDULED
     858  WORKFLOW_TASK_STARTED
     834  WORKFLOW_TASK_COMPLETED
     262  TIMER_STARTED
      24  WORKFLOW_TASK_TIMED_OUT
   ```

   **`heartbeat` signals are the #1 history driver** — every one forces a history event *and* a
   workflow task on the single thread.

5. **Fatal conversion.** The same starved event loop delays the WFT poller's gRPC request until its
   context deadline is nearly spent on arrival → server rejects
   `FailedPrecondition: Context timeout is too short` → core treats a poller `FailedPrecondition` as
   **fatal** → `Worker state FAILED` → daemon exits. No supervisor → 14.5 h freeze.

### Why 07-08 warned and 07-13 killed

Same 5 s timeout both times. Between them, histories grew (~200 events/h/session, never reset). On
07-08 the replay fit inside 5 s with margin lost only to CPU jitter → WARN, worker survived. By
07-13, `cll-devops` had the **largest history of any session** (4,658 events vs 4,267 / 1,406 for
peers) and the replay no longer fit. **The workflow that died is the one with the most history** —
that is the tell.

## Hypothesis: REFUTED as stated

> *"Unbounded per-session workflow state grows until query serialization >5 s."*

The **growth** half is real, but it is **history growth, not state-field growth**, and the 5 s is
spent **replaying**, not **serializing**. All four polled handlers are O(1) (`session.ts:784–806`):

```ts
setHandler(getRunIdQuery,          () => workflowInfo().runId);
setHandler(getMessagingStateQuery, () => ({ received, sent, outbox: outboxStatus() }));
setHandler(getLeaseStateQuery,     () => …);                    // two scalars
setHandler(getCoarseActivityQuery, () => ({ ...coarseActivity }));
```

The O(n) handlers that *do* exist (`allMessages`, `allSentMessages`, conductor `historyQuery`) are
**not in the poll path**. Do not spend the fix on state caps or query slimming of payloads — that
targets a cause that isn't there.

Corollary: **`src/utils/query-timeout.ts` (#433) cannot help.** It is a client-side
`Promise.race` — it abandons the *caller's* wait, but the query task is still dispatched and the VM
still executes it. Confirmed by its own doc comment ("the underlying RPC stays pending").

## Live evidence that this is not over

Current daemon (started 03:02, 20 min old):

- polls: **15,191 / 17,944 / 19,643 ms** (healthy baseline was 300–540 ms)
- **prelude: 30–60 ms → 2,000–2,300 ms.** Prelude is a *visibility list* — it never touches the
  workflow VM. Its 40× degradation is the discriminator proving **process-wide starvation**, not a
  slow handler.
- tick watchdog (#433) firing continuously; `skipCount` 1,529 and climbing
- daemon rss **180 MB → 919 MB in 20 min**; 239 s of *kernel* CPU in 21 min (syscall/gRPC storm)
- no memory leak at crash time (rss was flat ~580 MB on 07-13) — **rule out OOM/GC**

The rss climb on the *current* daemon is a likely secondary leak: query RPCs that never settle
because the worker can't answer them, held alive by the #433 in-flight dedup map.

## Recommended fix directions

Ranked by impact per unit of work. (1)–(2) are the real fix; (3)–(4) are cheap guards.

1. **Cut the poll storm — this is the root cause.**
   - **Collapse 4 queries/player/tick into 1.** Precedent already in the codebase: `pendingIntake`
     (#750) merged two queries into one for exactly this reason. A single `getWireMeta` returning
     `{runId, messaging, lease, coarseActivity}` is a **4× cut for one small PR** — highest
     value-to-risk ratio on this list.
   - **Back off the 750 ms loop** when nothing changed, and/or drive snapshot state from the
     existing SSE/event-bus push path instead of polling workflows at all.

2. **Cap replay cost — force continue-as-new far earlier.** Don't wait for
   `continueAsNewSuggested` (~10,240 events). Trigger CAN on an explicit threshold
   (`historyLength > ~2,000` or `historySize > ~2 MB`). This bounds the replay that must fit in the
   5 s budget. Also reconsider routing per-minute `heartbeat` through workflow history — it is the
   dominant event source.

3. **Stop the amplification loop.** Raise `isolateExecutionTimeout` (5 s → 30 s) and the workflows'
   `workflowTaskTimeout` (default 10 s). Longer WFTs stop timing out → sticky stops being
   invalidated → queries stop falling back to full-history replay. Consider `reuseV8Context: false`
   to get 2 workflow threads (costs memory).

4. **Don't die.** A poller `FailedPrecondition` should not be fatal, and the daemon needs a
   supervisor/auto-restart. *(tempo-eng's lane — noted here only for chain completeness.)*

**Do NOT** invest in: state-slot caps, trimming `messages`/`sentMessages`, or slimming query
*payloads*. Evidence says none of those are on the critical path.
