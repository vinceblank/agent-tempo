# Eng fix-brief — #704 batch replay-break (beta.2)

**Author:** tempo-researcher · **For:** @tempo-eng · **Status:** ready to implement (after #793 frees up)
**Reference:** `docs/research/beta2-reliability-triage.md` (the scoping pass behind this)

## Why these three ship together

The architect approved ONE replay-breaking workflow-shape change for beta.2's
**batch window**. The safety basis (architect's correction): it is **not** "no
replays exist" — a beta.2 worker *can* replay a beta.1-recorded `agentSession`
history (the protocol stamp is major-version-only). Safety rides on a
**documented beta.1→beta.2 drain-and-recreate** during the upgrade. Because that
drain happens once anyway, we fold every determinism-affecting change into the
same window so we pay the drain cost exactly once:

1. **#704 booting-watchdog + orphan guard** — the anchor (new behavior).
2. **Main-loop wake-discipline cleanup** — the GOLD simplification (deletes
   `patched()` markers + finishes the `wakeEpoch` discipline in one motion).
3. **Stage-reconcile dedup (#782)** — opportunistic; its extraction was
   explicitly deferred to "2.0 P2 where marker deletion merges the sites for
   free."

The **#886 observability alarm** (TMPRL1100 counter/alert — the #801 slice)
lands **with or before** this batch as the diagnostic net.

> **Determinism rule for this PR:** because this is a deliberate replay-break
> behind the drain contract, **do NOT add `patched()` gates** for the new
> behavior, and DO delete the existing ones called out in Item 2. The drain
> guarantees no in-flight beta.1 history replays on a beta.2 worker. Land all
> three in a single PR (or a tight stack merged together) so the break is atomic.

All line numbers below are against `src/workflows/session.ts` at origin/v2
(`22ad5929`); re-anchor by symbol if they drift.

---

## Item 1 — #704: booting attach-timeout + late-orphan guard (ANCHOR)

### Root cause (two independent gaps, both confirmed in code)

**Gap A — booting has no deadline.** `nextDeadlineMs()` (`session.ts:394-410`)
pushes deadline candidates for `currentAttachment` (lease expiry),
`processingSince`, and `draining` — but **nothing for `booting`**. With no
attachment yet, `candidates` is empty → returns `+Infinity`. The main loop
(`session.ts:1698-1706`) then only wakes on the 5-min fallback and never fails
the recruit. A session whose adapter never calls `claimAttachment` sits in
`booting` forever (the observed ~45min / ~9h hangs).

**Gap B — a destroyed pending session orphans its process, which re-registers.**
Single-player `destroy` (`destroy.ts:70-78`) enqueues a `destroy` outbox entry →
`destroyUpdate` flips the workflow to `gone` and it COMPLETEs. Crucially, the
OS-level killer `hardTerminateAttachment` (`activities/hard-terminate.ts`) finds
its target by **command-line search** (`claude.exe … -n <playerName> …` +
ensemble sentinel) — *not* by a recorded pid. So "persist the spawn pid" is **not
actually required** to kill the orphan. The real reason destroy can't kill it is
**timing**: at destroy time (T+45m) the slow orphan hasn't launched `claude.exe`
yet, so a command-line search finds nothing. When it finally launches (T+100m) it
bootstraps a **brand-new** `agentSessionWorkflow` run under the same derived id
(the prior run closed, so the default id-reuse policy allows a fresh run) → a new
`booting` session colliding with whoever took over the worktree.

### Fix

#### 1a — Booting attach-timeout (the high-value half)

- Add a state var `bootingSince: string | null`, set to `workflowNow()` at
  workflow init **whenever the session starts in `booting`** (i.e. no
  `input.attachmentId` handoff). Clear it (`= null`) in the `claimAttachment`
  fresh-claim branch (`session.ts:921`, right where `setPhase('attached')` runs).
- Add a `BOOTING_DEADLINE_MS` constant — **default 180_000** (architect ruling
  OQ-3: 120s is the floor; 180s clears a cold Claude Code launch + dev-channels
  dialog + cross-host recruit handshake). Keep it **env-overridable** (for tests
  and tuning), mirroring existing `*_DEADLINE_MS` knobs.
- In `nextDeadlineMs()` add:
  ```ts
  if (phase === 'booting' && bootingSince) {
    candidates.push(new Date(bootingSince).getTime() + BOOTING_DEADLINE_MS);
  }
  ```
- In the main loop's deadline-expiry section (alongside the lease-expiry reap at
  `session.ts:1711-1722`), add a booting-timeout branch: if still `booting` and
  `bootingSince + BOOTING_DEADLINE_MS <= now`:
  - `lastDetachReason = 'boot-timeout'` — **add `'boot-timeout'` to the
    `DetachReason` closed union** (`types.ts:106-116`: currently `user-stop |
    restart | heartbeat-timeout | superseded | agent-exited | spawn-failed |
    destroy | force | reconnect-exhausted | continued-as-new`).
  - flip to terminal **`gone`** (architect ruling OQ-1 — NOT a new `failed` enum;
    that would be an SA/wire-drift change across every phase renderer).
  - **write the typed close-reason MEMO** `AgentTempoCloseReason: 'boot-timeout'`
    on this terminal completion — this is the SAME memo OQ-2's bootstrap guard
    reads (one mechanism serves both the audit reason and the orphan tombstone).
  - **notify the recruiter**: `input.metadata.recruitedBy` is available
    (`session.ts:640` already uses it as the initial-message `from`). Post a
    system message to the recruiter (and/or conductor) — e.g. "recruit of
    **<name>** never attached within 180s — failed; the spawned process (if any)
    was swept." Reuse the existing conductor-notify pattern.
  - best-effort fire `hardTerminateAttachment` (it's a no-op if nothing launched;
    if the orphan *did* come up between spawn and timeout, the command-line
    search reaps it) before COMPLETE.

#### 1b — Late-orphan re-registration guard (ARCHITECT-RESOLVED, OQ-2)

The orphan must refuse to re-register when it finally launches. The kill path
can't help (timing). The bootstrap self-guard is approved — **but it is NOT
"cheap, no new infra."** The architect verified the machinery: `destroyUpdate`
returns void, and a post-completion `describe()` exposes only `status.name` — so
it **cannot** distinguish a destroy/boot-timeout close from any other close.
Status alone is not a sufficient discriminator. The resolved mechanism is three
parts:

1. **Persist a typed close-reason MEMO** on BOTH the `destroy` path and the
   boot-timeout path: `AgentTempoCloseReason: 'destroyed' | 'boot-timeout'`. A
   memo survives workflow completion and is readable via `describe()` (a search
   attribute would also work, but a memo is the lighter choice and needs no SA
   registration). This is the same memo Item 1a writes on boot-timeout.
2. **Bootstrap precondition** at the recruited process's workflow-start site
   (`server.ts:145` — `client.workflow.start('agentSessionWorkflow', { …,
   workflowIdConflictPolicy: WorkflowIdConflictPolicy.USE_EXISTING })`). BEFORE
   that start: `describe()` the derived id and **self-exit (`process.exit(0)`,
   log "recruit was cancelled — exiting") iff (NO running run) AND (the last
   closed run's `AgentTempoCloseReason` ∈ {`destroyed`, `boot-timeout`}) within a
   short TTL.** The **running-run × close-reason PAIR is the discriminator** —
   neither half alone is safe.
3. **Legit restart/migrate stay safe by construction.** Those flows create the
   new run **tool-side first**, so the late process's `start` with `USE_EXISTING`
   finds a RUNNING run and simply attaches to it — it never reaches the tombstone
   branch (which requires *no* running run). This is exactly why the pair
   discriminator is required and why a status-only check would false-positive.

**Deferred:** the `WorkflowIdReusePolicy` alternative (reject-duplicate while a
tombstone is recent) — heavier and overlaps the restart/migrate re-create flow;
not needed given the memo + precondition pair.

**Complementary (optional, not required to close #704):** extend the existing
parent-death-watchdog (`utils/parent-death-watchdog.ts`, #604) so a recruited
child that loses its spawner self-exits — helps the mis-route/slow-launch class
(#20) but does not, alone, stop re-registration after a clean destroy.

**Ship:** 1a + the 3-part memo/precondition guard above. Together they give a loud
failure AND no re-registering orphan, which fully closes the observed incident.

---

## Item 2 — Main-loop wake-discipline cleanup (GOLD)

### What
Finish the deferred cleanup described in the load-bearing comment at
`session.ts:1684-1697`. Today the loop caps every wait at 5 min
(`Math.min(deadlineMs, 5 * 60 * 1000)`, `session.ts:1705`) purely so that
handlers which mutate `nextDeadlineMs()` inputs **without** bumping `wakeEpoch`
still get re-evaluated within 5 min. The clean fix (the comment spells it out):
bump `wakeEpoch` in every such handler, then drop the 5-min cap.

### How
- Add `wakeEpoch++` to each handler that changes a deadline input without already
  bumping it:
  - `claimAttachmentUpdate` — renewal branch (sets `expiresAt`, `session.ts:880-887`)
    **and** fresh-claim branch (`session.ts:921`). *(The fresh claim also sets
    `bootingSince=null` per Item 1a — same handler, one bump covers both.)*
  - `processingStartUpdate` (`session.ts:662`) — sets `processingSince`.
  - `processingEndUpdate` (`session.ts:698`) — clears `processingSince`.
  - `destroyUpdate` async hard-terminate-then-flip path (verify it bumps; add if not).
  - *(Audit the others that already bump — `forceDetach`/`requestDetach`/lease
    paths at `:852,:1051,:1151,:1176` already do; don't double-add.)*
- Replace the wait at `session.ts:1705`:
  ```ts
  deadlineMs === Number.POSITIVE_INFINITY ? '5 minutes' : Math.min(deadlineMs, 5 * 60 * 1000)
  ```
  with just `deadlineMs` (and keep the `Infinity → no timer` branch, since a
  truly idle session with no deadline should sleep until a signal/`wakeEpoch`
  bump, not spin every 5 min).
- Delete the now-obsolete explanatory comment block (`:1658-1697`) and the
  smoking-gun caveat — replace with a one-line "every deadline-mutating handler
  bumps wakeEpoch; the loop waits exactly nextDeadlineMs()".

### Why it's safe now
This was explicitly deferred because it needed `patched()` markers for live 1.x
histories. Under the drain-and-recreate contract there are no in-flight beta.1
histories to replay — so we make the `wakeEpoch` change **unconditionally**, no
`patched()`. That's the "determinism-baseline simplification" the architect
flagged as the GOLD item.

### Regression guard
Keep/extend `test/session-phase-processing.test.ts:54` ("attached → processing →
awaiting via processingStart/End") — it's the canary that fails if a
deadline-mutating handler forgets its `wakeEpoch` bump.

---

## Item 3 — Stage-reconcile dedup (#782, opportunistic)

### What
`session.ts:1314-1317` flags that the stage transition+message logic in the
`report` handler (`:1318` onward) is **faithfully copied** into the `setStage`
handler's reconcile block, with extraction deferred to "2.0 P2 where v0.27's
marker deletion merges the sites for free."

### How
Extract the per-stage "advance a waiting player on report" logic into one pure
helper (e.g. `reconcileStageOnReport(stages, report, now)`), call it from both
sites. Since Item 2 already touches determinism-baseline assumptions in this same
PR, folding the extraction in here is free — no separate replay-break needed.

### Caution
This is the lowest-priority of the three. If it risks bloating the PR or the diff
review, **split it into a trailing commit** that can be dropped without affecting
Items 1–2. It must be a behavior-preserving refactor — add a test asserting both
call sites produce identical stage-state transitions before/after.

---

## Open questions — RESOLVED (architect, 2026-06-24)

- **OQ-1 — terminal phase for boot-timeout. ✅ RESOLVED:** reuse terminal `gone` +
  `lastDetachReason='boot-timeout'` (add `'boot-timeout'` to the `DetachReason`
  closed union). NOT a new `failed` enum — that would be an SA/wire-drift change
  across every phase renderer. The boot-timeout completion writes the same
  `AgentTempoCloseReason` memo OQ-2's guard reads. Folded into Item 1a.
- **OQ-2 — orphan-guard mechanism. ✅ RESOLVED:** bootstrap self-guard, but with
  the full 3-part machinery (typed close-reason memo + `describe()` precondition
  at `server.ts:145` + running-run × close-reason pair discriminator). The
  "cheap, no new infra" framing was struck — status-only can't discriminate a
  destroy close. `WorkflowIdReusePolicy` alt deferred. Folded into Item 1b.
- **OQ-3 — `BOOTING_DEADLINE_MS` value. ✅ RESOLVED:** 120s is the floor; default
  **180s**, env-overridable. Hard requirement: the handoff path (restart/migrate
  carrying `attachmentId`) must NOT arm the watchdog. Folded into Item 1a + the
  test plan.

## ⚠ Dependency / risk flag (OQ-3 follow-on — NOT a blocker for this brief)

If a recruited spawn can **block on the interactive trust / dev-channels dialog**,
then **no** attach deadline is safe — a genuinely-launching session that's parked
on the dialog would read as a boot-timeout and get swept. This ties to the known
recruit-dialog issue (`/clear` fires no session hook; dev-channels bypass — see
the recruit-message-loss class). **Action:** confirm recruited sessions bypass the
dialog (non-interactive / pre-accepted) before the 180s default goes live. Tracked
as a **separate concern** — it does not block authoring/merging this spec, but eng
should verify it during implementation (and we may need the watchdog gated behind
"dialog-bypass confirmed" for interactive `claude-code` specifically).

## Test plan
- **Unit (vitest, `tests/`):** `nextDeadlineMs()` returns a finite booting
  deadline when `bootingSince` set + `phase==='booting'`, and `+Infinity` once
  attached; `bootingSince` cleared on fresh claim.
- **Workflow integration (mocha, `test/`, TestWorkflowEnvironment):**
  - booting session with no `claimAttachment` → flips to terminal phase at
    `BOOTING_DEADLINE_MS`, posts recruiter notification, COMPLETEs.
  - a session that DOES claim before the deadline never trips the watchdog
    (incl. the **warm-hold** path — verify a held-for-release session still
    attaches normally and isn't swept).
  - restart/migrate handoff (carries `attachmentId`) does **not** arm the
    watchdog.
  - Item 2 canary: `session-phase-processing.test.ts:54` stays green with the
    5-min cap removed.
- **Orphan guard (the OQ-2 discriminator matrix):**
  - destroy-while-booting → terminal close writes `AgentTempoCloseReason:
    'destroyed'`; a late bootstrap of the same derived id sees NO running run +
    tombstone memo within TTL → self-exits, no new run created.
  - boot-timeout → `AgentTempoCloseReason: 'boot-timeout'` → same self-exit.
  - **restart/migrate must NOT self-exit:** with the new run created tool-side
    first, the late `start(USE_EXISTING)` finds a RUNNING run → attaches. Assert
    the running-run half of the pair short-circuits the tombstone branch.
  - TTL-expired tombstone (old closed run, legit re-recruit of same name) → does
    NOT self-exit.
- **Drift:** `DetachReason` gains `'boot-timeout'` — no wire-protocol signal/query
  rename, so `docs/WIRE-PROTOCOL.md` needs no change; reuse-`gone` adds no phase
  value. The `AgentTempoCloseReason` memo is new — note it in concepts/docs if
  any consumer reads it beyond the bootstrap guard (currently none).

## Sequencing
1. #886 alarm (separate, lands first/with — diagnostic net).
2. This batch PR: Item 1a → Item 2 → Item 1b → Item 3 (Item 3 as a droppable
   trailing commit). Single atomic merge.
3. Update the beta.1→beta.2 upgrade notes to state the drain-and-recreate is the
   determinism boundary these changes ride on.
