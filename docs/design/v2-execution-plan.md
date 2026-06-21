# v2.0 Execution Plan — Sequenced for Sign-off

> **Status**: SEQUENCING — the "what + order," for @vinceblank sign-off before decomposition.
> **Author**: tempo-architect · 2026-06-20 · sequences the ratified plan in
> [`v2-scoping.md`](./v2-scoping.md) (A2 clean-cutover, 8 operator decisions ratified 2026-06-12).
> **Scope**: ordering, parallelization, gates, phasing — NOT implementation.

---

## 0. The one prerequisite that gates the whole line

**1.7.0-stable must ship on 1.x main FIRST**, carrying the already-merged `upgrade-to-2`
verb (#785) + the closed P0 mission-control gaps (#742). It is the "last 1.x" every
operator cutover-hops through. **Main does not become the 2.0-beta line until 1.7.0 is out.**
→ *Confirm 1.7.0 status before authorizing any P-series start.* This is sequencing gate #1.

---

## 1. Dependency order across the P-series

```
                 #785 upgrade-to-2 verb (SHIPPED, 1.x) ─── writes upgrade-snapshot-v1.json
                                                                    │
   ┌──────────────────────────── 2.0-beta line ──────────────────────────────┐
   │                                                                          │
   │   #786 P1  cutover-guard + protocol stamp + `up --from-upgrade`   ◄── KEYSTONE
   │      (guard makes every breaking step below SAFE: a 2.0 worker            │
   │       refuses to boot against an un-stamped 1.x run)                      │
   │              │ hard prereq                                                │
   │              ▼                                                            │
   │   #787 P2  workflow clean-slate (delete 17 patched() markers +           │
   │            legacy branches in session/maestro/scheduler)                 │
   │              │ tightly coupled (shared signals.ts/session.ts)            │
   │              ▼                                                            │
   │   #788 P3  WIRE-PROTOCOL v2 regen (prune the now-dangling 9 wire         │
   │            items + drift-detector SECTION_TO_KIND + capture #786 adds)   │
   │                                                                          │
   │   ── independent surfaces (parallel to the wire core) ──                 │
   │   #789 P4  TUI deletion            (gated on P0-parity #742/#790, NOT     │
   │                                     on the wire core)                    │
   │   #791 P5b command-center UX       (mission-control surface)             │
   │   #793 P7  tool-family merges      (MCP tools surface, descriptor layer) │
   │   #794 P8  shim deletions ─┐                                             │
   │   #792 P6  env unification ┘ coordinated pair (rebrand/legacy territory) │
   │   #795 P9  SA auto-registration   (additive ease-of-use)                 │
   │                                                                          │
   │   #796 P10 upgrade round-trip E2E  ◄── TERMINAL GA GATE (scaffold early, │
   │                                        passes only when the cut is done) │
   └──────────────────────────────────────────────────────────────────────────┘
```

**Hard prerequisites (must precede):**
- **#786 → #787 and #788.** The boot guard + protocol stamp are what make deleting the
  patched() markers and pruning the wire safe. Without the guard, a 2.0 worker handed a 1.x
  history non-determinism-faults; with it, it refuses to boot, loud, with the migration command.
  Delete-the-markers (#787) and break-the-wire (#788) cannot land before the guard exists.
- **#787 → #788 (micro-order).** Remove the workflow branches/handlers (#787) before pruning
  the signal/query *definitions* they reference (#788) — otherwise the workflow won't compile
  against deleted signals. #788's doc-regeneration comes last so the v2 WIRE-PROTOCOL captures
  the net surface (removals from #787 + the additions #786 made: `AgentTempoProtocol`,
  `protocolVersion` on `claimAttachment`).
- **P0 mission-control parity (#742, likely tracked as P5a/#790) → #789.** The TUI cannot be
  deleted until command-center reaches parity on the 9 P0 gaps. This is 1.x-side work that
  starts now; confirm it's *closed* before #789 runs.

**Independent (no hard prereq, different surfaces):** #789, #791, #793, #794, #795 — each
touches a distinct surface (TUI / Pi-board / MCP-tools / shims+env / SA-preflight) and none
touches the workflow-determinism surface, so none blocks or is blocked by the #786→#787→#788
core. **#796** depends on everything (it validates the finished cut).

**Soft/rework-minimizing order:** run **#794 (delete shims) and #789 (delete TUI) before
#792 (env rename)** — don't rename env vars in code you're about to delete.

---

## 2. Parallelization map

| Stream | Items | Surface | Concurrency |
|---|---|---|---|
| **A — Wire/workflow core** | #786 → #787 → #788 | `session.ts`, `maestro.ts`, `scheduler.ts`, `signals.ts`, `WIRE-PROTOCOL.md` | **Strictly sequential, single coordinated owner.** They collide on the same files; do NOT split #787/#788 across players. |
| **B — Operator surface** | #789 (TUI delete) + #791 (cc UX) | `src/tui/`, `cli.ts:755`, Pi mission-control | Parallel to A. Internally: P0-parity (#742) gates #789. |
| **C — Cleanup/rename** | #794 (shims) → #792 (env) | scattered legacy + `config.ts` + env refs | Parallel to A and B. Internally sequential (delete before rename). |
| **D — Tools** | #793 (tool merges, aliased) | `src/tools/`, descriptor layer | Parallel to A/B/C. |
| **E — Ease-of-use** | #795 (SA auto-reg) | `sa-preflight.ts`, CLI shell-out | Parallel; additive, low-risk. |
| **F — Validation** | #796 (E2E round-trip) | CI harness | Scaffold in parallel from day 1; *passes* only after A + the cut are complete. |

**Answer to "does #788 gate #787 or vice versa":** neither hard-gates the other, but they are
two facets of one v2-workflow-surface change on shared files — coordinate them as a sequential
pair (#787 then #788), single owner, never parallel. Both hard-gated on #786.

Up to **5 streams (A–F) run concurrently** once #786's guard lands. That maps cleanly onto the
idle 8-player ensemble.

---

## 3. Breaking-change gates + risk points

The irreversible / wire-breaking steps, in the order that minimizes rework:

1. **#786 guard lands first** — *before* any break. Adds the stamp + boot guard + `protocolVersion`
   on `claimAttachment`. Makes every subsequent break fail-loud-not-silent. **Reversible** (it's
   additive); land it early and de-risk everything after.
2. **#787 marker deletion** — once the patched() markers are gone, **a 2.0 worker can no longer
   replay a 1.x history. IRREVERSIBLE for replay.** Safe only because #786's guard refuses such runs.
3. **#788 wire-v2 removal** — once the 9 signals/queries are pruned, **1.x adapters/pumps can't
   talk to 2.0 workflows. IRREVERSIBLE wire break.** Safe because #786's `protocolVersion` rejects
   v1 adapters and the cutover leaves no 1.x runs alive.
4. **The operator cutover itself** (`upgrade-to-2` → destroy) — **IRREVERSIBLE for the operator's
   running ensembles.** Mitigated by the snapshot (continuity) + the load-bearing invariant
   *snapshot strictly precedes destroy* (already enforced in #785).

**Rework-minimizers:** deletions (#789 TUI, #794 shims) before the rename (#792 env); tool-merge
**aliases ship in beta.1, alias drop deferred to GA** (one muscle-memory break, not two);
#788's doc-regen last so it captures the net surface in one authoritative pass.

---

## 4. Cutover model — what the cut actually looks like operationally

The round-trip, end to end:

1. **(1.x, shipped)** Operator on 1.7.0-stable runs **`agent-tempo upgrade-to-2`** (#785):
   preflight (refuse if any daemon < 1.7.x floor) → **pause** maestro+scheduler → **drain**
   outboxes (≤60s; `--force-drain` records stragglers) → **snapshot** continuity (schedules,
   #334 state slots, `sessionId`, non-default `model`, undelivered cues) to
   `~/.agent-tempo/upgrade-snapshot-v1.json` → **destroy** all workflows (they COMPLETE) → done.
   **Snapshot strictly precedes destroy** — a crash leaves everything intact OR a durable
   snapshot + partial teardown, never destruction without capture.
2. **Operator installs 2.0.**
3. **(2.0, #786)** Operator runs **`agent-tempo up --from-upgrade`**: reads the snapshot →
   recreates fresh **protocol-2** workflows (stamped `AgentTempoProtocol=2`) → continuity restored
   (lineups, state slots, schedules).
4. **Boot guard (#786):** if the 2.0 daemon ever sees an un-stamped Running workflow → **refuses
   to start workers**, prints the migration command. No silent replay fault, ever.
5. **Cross-host (#786 `protocolVersion`):** 2.0 workflows reject v1 adapters with an actionable
   error; upgrade **all hosts' daemons before any ensemble comes back up** (recruit host-preflight
   can enforce the version floor on the advertised `hostProfile.version`).

**#796** automates exactly this round-trip in CI (up on 1.7 → upgrade-to-2 → verify ensemble
continuity on 2.0) as the GA gate.

The snapshot schema (`snapshot-v1.ts`, shipped with #785) is the versioned cross-release bridge;
#786's `up --from-upgrade` is its only 2.0-side reader.

---

## 5. Phasing — beta.1 vs beta.2+ vs GA

**Prerequisite (1.x main, now):** 1.7.0-stable shipped with #785 + P0 gaps (#742) closed.

**beta.1 — the irreversible core + subtractive (all breaking changes while the window is open):**
- #786 cutover guard + stamp + `up --from-upgrade`
- #787 workflow clean-slate · #788 wire-v2 regen
- #789 TUI deletion · #792 env unification · #794 shim deletions
- #793 tool-family merges **shipped aliased** (muscle-memory migration)

**beta.2+ — internal churn + enhancement (betas absorb risk, invisible to users):**
- **B2 attachment-core extraction** (§C.2 — contingent on T1.1 PR-2/3 settled; never beta.1)
- **P1 mission-control gaps** (gates/stages/worktree/lineup/search views) + #791 deeper cc UX
- #795 SA auto-registration (additive ease-of-use — *could pull forward to beta.1 if capacity*)

**GA gate:**
- #796 1.7→2.0 upgrade round-trip passes in CI
- tool-merge **alias drop** · docs surgery complete · web-dashboard review item (§E.3 stays)

---

## 6. Recommended FIRST WAVE + decisions for @vinceblank

**First wave — 3 concurrent streams (start immediately once 1.7.0 confirmed):**
1. **#786 (Stream A keystone) — START FIRST.** Critical path; unblocks #787/#788; additive +
   reversible, so it de-risks the whole release. Highest-leverage single item.
2. **#789 TUI deletion (Stream B)** — fully independent of the wire core, large + mechanical,
   parallelizable. *Gate:* confirm P0 parity (#742) is closed first.
3. **#796 E2E scaffold (Stream F)** — build the harness now (it can't pass yet) so the GA gate
   isn't a last-minute scramble and cutover gaps surface early.

Hold #787/#788 until #786's guard lands (hard prereq). Hold #792 env-rename until #789/#794
deletions settle. **Wave 2:** #787→#788, #794, #793, #795 fan out across the freed players.

**A short scoping spike worth doing before #787:** verify the researcher's marker census (11
replay-only no-ops + 6 conditional) and map each of #788's 9 wire-removal items to the #787
branch/handler it depends on — a half-day de-risk of the A-stream micro-order. The census exists;
this is a verification pass, not a from-scratch dig.

**Open decisions @vinceblank should rule on up front (surfaced now, not mid-stream):**

| # | Decision | Why it needs ruling now |
|---|---|---|
| D1 | **Is 1.7.0-stable shipped (with #785) and are #742 P0 gaps closed?** | The entire 2.0 line + #789 TUI deletion gate on these. Fact-check, not a design call — but it blocks wave 1. |
| D2 | **Confirm §E.8 bare-command default** (bootstrap + status + hints) still holds as #789 removes the TUI launch path | Ratified 2026-06-12 but carries standing objection rights "until beta.1 ships it." Re-confirm, don't re-decide. |
| D3 | **#795 SA auto-reg boundary** — strictly local dev-server/docker-compose, NOT auto-mutating Cloud/shared namespaces? | I recommend local-only (auto-mutating a shared Cloud namespace is risky). Needs an explicit boundary ruling. |
| D4 | **#793 alias-drop firm at GA?** | It's a *second* muscle-memory break after the aliased beta. Confirm GA timing so players plan one migration, not two. |
| D5 | **#795/#791 phase placement** — beta.2 (my default) or pull into beta.1? | Keeps beta.1 focused on the irreversible core; @vinceblank may want the onboarding win (#795) in the first beta. |
| D6 | **Tracker gap: P5a / #790** — is that the P0 mission-control gap-closure issue (#742)? | The P-list jumps #789(P4) → #791(P5b); confirm what P5a is so #789's gate is tracked. |

**No new design decisions beyond these** — the §E table already ratified the 8 strategic calls
(migration protocol A2, 1.7.0-first, dashboard stays, alias window, env-in-beta.1, B2-in-beta.2,
B4(a) parked, bare-command default). This wave is execution sequencing on top of those.
