# Maestro session availability — root cause + fix design

**Status**: APPROVED for implementation (architect, branch `design/maestro-receivemessage-handler`)
**Symptom**: `cue maestro` and any peer-tool that resolves the maestro player silently fails until the dashboard or TUI mounts. Operator sees "you're reporting to yourself" because the conductor falls back to `report` (a workaround surfaced by PR #512's projection re-target).
**Author**: tempo-architect
**Implementer**: tempo-eng
**Related**: PR #512 (projection re-target — keep as defensive backstop, see §6)

---

## 1 · TL;DR

The maestro is a regular `claudeSessionWorkflow` running at workflow-id `claude-session-{ensemble}-maestro` with `playerId: 'maestro'`, `hostname: 'dashboard'`. It already has every signal handler the chat surface needs (`receiveMessage`, `recordSentMessage`, `allMessages`, `allSentMessages`) — those are registered by `session.ts` like any other player.

The problem is **lifecycle**: `ensureMaestroSession()` is the only thing that creates this workflow, and it's called from exactly **3 UI sites**. The ensemble lifecycle (`commands.ts up`) and the daemon's reconcile-on-boot sequence don't create it. So:

- A fresh `agent-tempo up <ensemble>` produces an ensemble with **no maestro session**. Any `cue maestro` from the conductor before a UI opens fails at `resolveSession` and never reaches an outbox.
- A daemon restart **after** a UI opened wipes the maestro session (24-hour `workflowExecutionTimeout` is enforced, daemon shutdown also terminates it). The next UI mount recreates it; nothing else does.

**Fix**: hoist the maestro session into the ensemble's standing infrastructure. `commands.ts up` creates it (Layer 1, immediate fix). The daemon reconciles it on boot for every ensemble it knows about (Layer 2, resilience).

Both fixes are small and orthogonal — Layer 1 closes the cold-boot gap; Layer 2 closes the daemon-restart and 24h-timeout gaps.

---

## 2 · Background — two workflows, one operator identity

There are two distinct workflows per ensemble both informally called "the maestro":

| Workflow ID | Type | Role | Has `receiveMessage`? |
|---|---|---|---|
| `claude-maestro-{ensemble}` (`maestroWorkflowId`) | `claudeMaestroWorkflow` (the **hub**) | Polls ensemble state; runs the chat-fetch loop; relays commands to the conductor; tracks tempo/bpm/description. | **No** — and doesn't need it. The hub is orchestration, not a chat participant. |
| `claude-session-{ensemble}-maestro` (`sessionWorkflowId(_, 'maestro')`) | `claudeSessionWorkflow` (the **session**) | The dashboard operator's identity. Holds inbound `messages[]` and outbound `sentMessages[]` arrays. The maestro chat is a projection of these arrays. | **Yes** — registered at `session.ts:437`, synchronously at workflow start. |

The chat-fetch activity (`src/activities/maestro.ts:223`) queries the **session** for `allMessages` / `allSentMessages`:

```ts
const maestroHandle = client.workflow.getHandle(sessionWorkflowId(ensemble, 'maestro'));
// …
maestroHandle.query('allMessages')      // Message[] from the session's messages[] array
maestroHandle.query('allSentMessages')  // SentMessage[] from sentMessages[]
```

When the session exists and is running, the projection is straightforward and correct. The hub's role is upstream — it calls `fetchEnsembleChat` activity, which queries the session, caches results in `cachedChat`, and exposes them via `maestroEnsembleChatQuery`.

**Earlier hypothesis (now ruled out)**: that the hub workflow was missing handlers and `cue maestro` was hitting a no-op. The hub *is* missing `receiveMessageSignal`, but `cue` never targets the hub — it targets the session, which already has the handler.

---

## 3 · Root cause — `ensureMaestroSession` has no system-level caller

`ensureMaestroSession()` lives at `src/client/core.ts:1146-1205`. It's idempotent (`WorkflowIdConflictPolicy.USE_EXISTING`), starts both the session AND the hub, and is safe to call from anywhere. Every caller in the codebase:

| File:Line | Caller | When it fires |
|---|---|---|
| `src/tui/App.tsx:773` | TUI bootstrap | TUI mounts and resolves an `activeEnsemble` |
| `src/tui/App.tsx:787` | TUI on ensemble change | User switches ensembles inside the TUI |
| `src/http/writes.ts:149` | Daemon HTTP `sendMessage` route | Dashboard fires `POST /v1/ensembles/:ensemble/sendMessage` (operator typing in maestro chat) |

Three call sites, all UI-driven. **No system-level caller**:
- `commands.ts up` already creates the maestro **hub** but not the **session**.
- `src/reconcile/orphans.ts` runs on daemon boot for orphan handling but doesn't touch maestro.
- `claudeMaestroWorkflow` itself doesn't bootstrap its companion session.
- `claudeSessionWorkflow` doesn't self-restart on `workflowExecutionTimeout`.

So the maestro session exists if and only if a UI surface has interacted with the ensemble in the current daemon lifetime AND in the last 24 hours.

---

## 4 · Failure trace

When conductor calls `cue maestro` and no UI has run `ensureMaestroSession` yet:

```
src/tools/cue.ts:33     resolveSession(client, ensemble, 'maestro')
                        ↓
src/activities/resolve.ts:23
                        client.workflow.list({ query:
                          'WorkflowType = claudeSessionWorkflow AND ExecutionStatus = Running'
                        })
                        ↓
                        → no maestro session in the result set (it was never started)
                        ↓
src/tools/cue.ts:35     return fail(`No active session found with name "maestro".`)
                        ↓
                        outbox entry never created, signal never sent
                        ↓
                        conductor's tool result contains the failure;
                        user-side maestro chat shows nothing (silent)
```

**The "phase: booting" snapshot is a red herring.** Booting is the steady state for the maestro session — no real adapter ever calls `claimAttachment` for the dashboard "host", so the phase machine never advances. `disableStaleDetection: true` keeps the workflow alive indefinitely. Critically, `setHandler(receiveMessageSignal, ...)` runs synchronously at workflow start (before the first `await`), so a booting workflow happily accepts and processes signals. The phase is cosmetic for this code path.

---

## 5 · Fix design

### 5.1 Layer 1 — `commands.ts up` creates the session unconditionally (CRITICAL)

**Scope**: ~3-5 LoC. Closes the cold-boot gap.

`src/cli/commands.ts:40-42` already creates the maestro hub:

```ts
const wfId = maestroWorkflowId(ensemble);
// …
await client.workflow.start('claudeMaestroWorkflow', { workflowId: wfId, … });
```

Add a parallel call to ensure the session. Two implementation options for tempo-eng:

**Option A (preferred): use the existing `TempoClient`**

```ts
// after the existing claudeMaestroWorkflow start
const tempoClient = createTempoClientCore(client, config);
await tempoClient.ensureMaestroSession(ensemble);
```

Pros: idempotent (`USE_EXISTING`); also re-runs the hub-ensure inside `ensureMaestroSession`, defending against any race; one source of truth for the session shape.

Cons: pulls the TempoClient into a CLI command; one extra dependency to plumb through `commands.ts`. Trivially small.

**Option B: inline the workflow start**

Copy the `client.workflow.start('claudeSessionWorkflow', { workflowId: sessionWorkflowId(ensemble, 'maestro'), args: [{ … }] })` call from `core.ts:1165-1177` directly into `commands.ts`. Avoids the TempoClient wiring at the cost of duplicating the canonical metadata block.

**Recommendation**: Option A. The TempoClient wrapper is already in scope for other commands; reusing the canonical creation site avoids drift if the metadata schema changes.

### 5.2 Layer 2 — daemon reconcile-on-boot (RESILIENCE)

**Scope**: ~10-20 LoC. Closes the daemon-restart and 24h-execution-timeout gaps.

`src/reconcile/orphans.ts` already runs at daemon startup. Extend the boot sequence (likely in `src/daemon.ts` after the worker is up) to:

1. Discover every running ensemble via the maestro hub workflows already searchable by `WorkflowType = "claudeMaestroWorkflow" AND ExecutionStatus = "Running"`. (The hub's existence is the canonical "ensemble is alive" signal — it predates the maestro session by design.)
2. For each ensemble, call `ensureMaestroSession(ensemble)`. Idempotent — no-op when the session is already running, recreates it when missing.

Sketch:

```ts
// src/daemon.ts (or src/reconcile/maestro.ts as a sibling to orphans.ts)
async function reconcileMaestroSessions(client: TempoClient): Promise<void> {
  const maestroQuery = 'WorkflowType = "claudeMaestroWorkflow" AND ExecutionStatus = "Running"';
  for await (const wf of client.workflow.list({ query: maestroQuery })) {
    // Hub workflow id is `claude-maestro-{ensemble}` — extract the ensemble.
    const ensemble = wf.workflowId.replace(/^claude-maestro-/, '');
    if (!ensemble) continue;
    try {
      await client.ensureMaestroSession(ensemble);
    } catch (err) {
      console.error(`[agent-tempo:reconcile] ensureMaestroSession failed for ${ensemble}:`, err);
    }
  }
}
```

Call this once in the daemon boot sequence after the worker comes up. **Periodic re-runs are not needed** — Layer 1 ensures fresh ensembles get a session, and the 24h timeout is well within a typical daemon's uptime. If a daemon survives 24h, that's the only edge case where periodic reconcile would help; treat it as a follow-up if monitoring shows it occurring in production.

### 5.3 Why NOT fix at the cue tool / `resolveSession` layer

A "lazily create on first cue" path in `cue.ts` is tempting but architecturally wrong:

1. **Pushes ensemble-creation policy into a signaling tool.** `cue.ts` is a 50-line read-mostly tool today. Embedding workflow lifecycle there leaks a lifecycle concern into one tool surface, requiring the same patch in every other peer-resolution tool (`broadcast`, `recall`, `listen`, plus future tools).
2. **Hides the symptom.** A lazy fallback masks the real lifecycle gap; the next maintainer reading "cue maestro" must trace through the lazy path to understand when sessions actually exist.
3. **Race-prone.** Fast-fired `cue maestro` calls from multiple players would each try to create the session simultaneously. `USE_EXISTING` saves correctness but the temporal-rate-limiting of the start RPC makes the first cue noticeably slower.

The fix belongs at the **lifecycle owner** (the daemon and `up` command), not at every signaling tool.

### 5.4 PR sequencing

Recommend **one PR with two commits**:

| # | Commit | Files | Tests |
|---|---|---|---|
| 1 | `fix(cli): ensure maestro session in 'up' command` | MOD `src/cli/commands.ts` | NEW integration test: `agent-tempo up <ensemble>` → assert `claude-session-{ensemble}-maestro` is running → assert a `cue maestro` from a peer succeeds without a UI ever mounting. |
| 2 | `feat(daemon): reconcile maestro sessions on boot` | NEW `src/reconcile/maestro.ts` (or extend `orphans.ts`); MOD `src/daemon.ts` (call site) | NEW integration test: start daemon → start an ensemble → terminate the maestro session manually → restart daemon → assert the session reappears. |

Layer 1 is shippable on its own — Layer 2's bug surface (daemon-restart with stale session) is rare enough that we don't need to bundle them. But shipping both together makes the chat surface fully reliable.

---

## 6 · PR #512 — keep as defensive backstop

PR #512's projection re-target lives at `src/activities/maestro.ts:282-292`:

```ts
// Conductor self-reports (e.g. `tempo-conductor` calling `report`) land in the
// conductor's own `messages` array. Re-target them as inbound-to-maestro so the
// chat renders "tempo-conductor → maestro" instead of a confusing self-loop.
const isConductorSelfReport = m.from === conductorId;
newMessages.push({
  // …
  to: isConductorSelfReport ? 'maestro' : conductorId,
  role: isConductorSelfReport ? 'maestro-in' : 'conductor-in',
  // …
});
```

This is a narrow, ~10-line projection adjustment for the case where the conductor self-loops via `report`. **Keep it.** Once Layer 1 + Layer 2 land, the conductor *should* prefer `cue maestro` per vinceblank's guidance ("you should be cuing the maestro"), but:

- Legacy code paths or edge cases may still produce conductor self-reports.
- A freshly-restarted ensemble between the daemon's reconcile sweep and the operator's first cue may briefly lack the maestro session; conductor falling back to `report` keeps the user informed.
- The re-target is observably correct and free when the case doesn't trigger.

**Recommended inline comment update** (folded into Layer 1's PR or left for a docs follow-up):

```ts
// #512 / #NEW: Defensive re-target. The conductor's `cue maestro` is now the
// preferred path (see docs/design/maestro-session-availability.md for the fix
// that ensures the maestro session is available). This branch handles legacy /
// accidental conductor self-reports where m.from === conductorId. Cheap
// belt-and-suspenders.
```

`#NEW` is the issue/PR number that ships Layer 1. Tempo-eng substitutes it during implementation.

---

## 7 · File scope for tempo-eng

**Layer 1**:
- MOD `src/cli/commands.ts` — `up` command, around line 40-42 (after the existing maestro hub start). Add the `ensureMaestroSession(ensemble)` call.
- NEW test: `test/cli-up-maestro-session.test.ts` (or extend an existing `up` integration test).

**Layer 2**:
- NEW `src/reconcile/maestro.ts` — `reconcileMaestroSessions(client)` helper.
- MOD `src/daemon.ts` — call `reconcileMaestroSessions` in the boot sequence after the worker is up.
- NEW test: `test/daemon-maestro-reconcile.test.ts`.

**Optional comment update**:
- MOD `src/activities/maestro.ts:282-292` — update the PR #512 inline comment per §6.

**DO NOT TOUCH**:
- `src/workflows/maestro.ts` — the hub is fine as-is; the original "add receiveMessageSignal handler" hypothesis was wrong (the hub doesn't need it).
- `src/tools/cue.ts` and other signaling tools — lifecycle concerns don't belong here.
- `src/client/core.ts:1146-1205` (`ensureMaestroSession`) — keep the canonical creation site exactly as it is; both layers consume it as-is.

---

## 8 · Test strategy

### Integration tests

1. **`test/cli-up-maestro-session.test.ts`** (Layer 1 — Mocha):
   - Start a fresh ensemble via `agent-tempo up`.
   - Assert `claude-session-{ensemble}-maestro` is running and the session's `getMetadata` query returns `playerId: 'maestro'`, `hostname: 'dashboard'`.
   - Send a cue from a synthetic peer to "maestro" and assert the cue succeeds (returns a valid outbox id, doesn't error with `No active session found`).
   - Query `allMessages` on the maestro session and assert the cued message appears.

2. **`test/daemon-maestro-reconcile.test.ts`** (Layer 2 — Mocha):
   - Start daemon, start an ensemble (which now creates the maestro session via Layer 1).
   - Manually `terminate` the maestro session via the Temporal client.
   - Restart the daemon.
   - Assert the maestro session is running again.

### No new unit tests needed

Both fixes are 1-call wrappers around `ensureMaestroSession()`. Unit-testing the wrappers in isolation buys nothing over the integration tests above.

### Existing tests to verify still pass

- `test/ensemble-chat.test.ts` (the projection assertions) — unaffected; the projection logic doesn't change.
- Anything that exercises the dashboard `sendMessage` flow — unaffected; `ensureMaestroSession` was already idempotent.

---

## 9 · Summary

The fix is small and architecturally clean. Layer 1 makes the maestro session part of the ensemble's standing infrastructure — created the moment `up` returns, just like the maestro hub. Layer 2 ensures daemon restarts and 24h-timeout edges don't reintroduce the cold-boot gap. PR #512 stays as a defensive projection-side backstop for any future edge case where the conductor's `cue maestro` path is briefly unavailable.

After both layers land, the conductor's preferred channel for human-facing messages becomes `cue maestro` (not `report`), the dashboard chat surface is reliable end-to-end without depending on UI activation order, and the operator stops seeing "you're reporting to yourself" self-loops in the steady state.
