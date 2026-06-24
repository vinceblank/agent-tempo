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
- Add a `BOOTING_DEADLINE_MS` constant (propose **120_000** — generous enough for
  a cold Claude Code launch + dev-channel dialog, tight enough to surface a real
  hang fast; make it overridable via env for tests, mirroring existing
  `*_DEADLINE_MS` knobs).
- In `nextDeadlineMs()` add:
  ```ts
  if (phase === 'booting' && bootingSince) {
    candidates.push(new Date(bootingSince).getTime() + BOOTING_DEADLINE_MS);
  }
  ```
- In the main loop's deadline-expiry section (alongside the lease-expiry reap at
  `session.ts:1711-1722`), add a booting-timeout branch: if still `booting` and
  `bootingSince + BOOTING_DEADLINE_MS <= now`:
  - `lastDetachReason = 'boot-timeout'`
  - flip to a terminal phase (see **OQ-1** — recommend `gone`)
  - **notify the recruiter**: `input.metadata.recruitedBy` is available
    (`session.ts:640` already uses it as the initial-message `from`). Post a
    system message to the recruiter (and/or conductor) — e.g. enqueue/deliver
    "recruit of **<name>** never attached within 120s — failed; the spawned
    process (if any) was swept." Reuse the existing conductor-notify pattern.
  - best-effort fire `hardTerminateAttachment` (it's a no-op if nothing launched;
    if the orphan *did* come up between spawn and timeout, the command-line
    search reaps it) before COMPLETE.

#### 1b — Late-orphan re-registration guard (the harder half)

The orphan must refuse to re-register when it finally launches. The kill path
can't help (timing). Options, in preference order — **needs OQ-2 micro-ruling**:

- **(Recommended) Bootstrap precondition + close-reason tombstone.** On
  `destroy`/boot-timeout COMPLETE, finish the workflow with a typed result/reason
  (e.g. `closeReason: 'destroyed'`). The recruited process's bootstrap, *before*
  `client.workflow.start('agentSessionWorkflow', …)`, does one `describe()` on
  the derived id; if the latest run closed with `destroyed`/`boot-timeout` within
  a short TTL, it logs "recruit was cancelled — exiting" and `process.exit(0)`
  instead of starting a new run. Cheap, no new infra; the only nuance is the TTL
  window vs. a legitimate fast re-recruit of the same name.
- **(Alt) `WorkflowIdReusePolicy`.** Start sessions with a reuse policy that
  rejects duplicate IDs while a tombstone run is recent. Heavier; interacts with
  the existing restart/migrate re-create flow — verify it doesn't break
  legitimate revives.
- **(Complementary) Parent-liveness self-exit.** Extend the existing
  parent-death-watchdog (`utils/parent-death-watchdog.ts`, #604) so a recruited
  child that loses its spawner (or whose spawn record was revoked) self-exits.
  Helps the mis-route/slow-launch class (#20) but doesn't by itself stop
  re-registration after a clean destroy — pair with the bootstrap check.

**Recommendation:** ship **1a + the bootstrap-precondition guard (first option)**.
That fully closes the observed incident (loud failure + no re-registering orphan)
with the least new machinery. Defer the reuse-policy hardening unless OQ-2 says
otherwise.

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

## Open questions (architect micro-rulings)

- **OQ-1 — terminal phase for boot-timeout.** `AttachmentPhase` (`types.ts:52-59`)
  is `booting|attached|processing|awaiting|draining|detached|gone` — **there is
  no `failed`**. "Flip booting→failed" therefore needs a choice:
  - **(Recommended) reuse `gone`** + `lastDetachReason='boot-timeout'`. Zero
    downstream blast radius — `gone` is already the terminal dormant phase every
    consumer (dashboard, command-center glyphs, scanners, `ensemble` tool)
    understands. The "failed" semantics ride on the detach reason + recruiter
    notification.
  - **(Alt) add a `failed` phase.** Operator-distinct, but it's an additive SA
    enum change touching the `AgentTempoAttachmentState` SA and every renderer.
    Bigger; only worth it if operators need to visually distinguish
    boot-timeout from a normal teardown.
- **OQ-2 — orphan-guard mechanism.** Bootstrap-precondition tombstone (rec) vs.
  `WorkflowIdReusePolicy` vs. both. Drives 1b's scope.
- **OQ-3 — `BOOTING_DEADLINE_MS` value.** 120s proposed. Confirm it clears the
  worst legitimate cold-launch (Claude Code dev-channels dialog, slow host,
  cross-host recruit handshake) without masking a real hang.

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
- **Orphan guard:** simulate destroy-while-booting then a late bootstrap of the
  same derived id → bootstrap self-exits, no new run created.
- **Drift:** update `docs/WIRE-PROTOCOL.md` only if OQ-1 adds a phase value;
  reuse-`gone` needs no wire change.

## Sequencing
1. #886 alarm (separate, lands first/with — diagnostic net).
2. This batch PR: Item 1a → Item 2 → Item 1b → Item 3 (Item 3 as a droppable
   trailing commit). Single atomic merge.
3. Update the beta.1→beta.2 upgrade notes to state the drain-and-recreate is the
   determinism boundary these changes ride on.
