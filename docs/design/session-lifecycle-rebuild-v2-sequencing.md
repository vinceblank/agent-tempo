# Implementation Sequencing — Session Lifecycle Rebuild v2

> Companion memo to `session-lifecycle-rebuild-v2.md`.
> **Design doc-of-record:** `88b0d3f` on `design/session-rebuild-v2`.
> **Scope:** ordering the full-rebuild PRs after the MVP ships as `v0.24.1`.
> **Audience:** `tempo-conductor` (for PR assignment) and `tempo-eng` (for execution).
> **Not a re-opening of design.** If a PR in this ladder reveals a design gap, cue me; don't paper over.

---

## 0. Preconditions (assumed at time of kickoff)

- **`v0.24.1` has shipped** from `fix/mvp-99-102` (PR #111). It delivers:
  - `processingStart` / `processingEnd` as **updates** with `messageId` idempotency key
  - An internal `processing` flag tracked in workflow memory (NOT yet a full phase enum value)
  - `destroy` update verb — sets an internal `terminated` flag, then `handle.terminate()`. Semantically "abandon and complete."
  - RunId pinning at `client.workflow.start` and `getHandle` sites
  - Adapter-side `WorkflowNotFound` exit spec (stop heartbeat, shutdown, exit)
- **Users are not blocked on #99 or #102 once MVP lands.** The full rebuild is architectural cleanup and the foundation for multi-host, not fire-fighting.
- **Backward compat is not a concern.** Users of `v0.24.x` are expected to stop all sessions, `npm i -g @vinceblank/claude-tempo@beta`, restart ensembles. Per design §15.
- **Temporal topology stays as-is:** default namespace, shared `claude-tempo` task queue (workflows + delivery activities), per-host `claude-tempo-{hostname}` task queues (spawn activities).
- **Daemon model is retained** — the rebuild leaves the detached-background-process model alone; only its responsibilities grow (reconcile-on-boot).

---

## 1. Ground rules

1. Every PR must leave `main` green — no half-merged state, no "wait for the next PR to fix CI."
2. Every PR has a crisp **acceptance gate** (a test or observation that proves it landed correctly). Listed per-PR below.
3. Wire-protocol changes land in `docs/WIRE-PROTOCOL.md` in the **same commit** as the code change. A CI diff check (shipped in PR-G) enforces this starting mid-ladder.
4. `patched('v0.25-attachment-lifecycle')` marker goes on the new state-machine code path the **first** time it's added (PR-A); rolling deploy across the worker fleet must be safe.
5. Prefer feature flags on the adapter side (`CLAUDE_TEMPO_LIFECYCLE_V2=1`) over long-lived branches when a PR needs to land incrementally; never use `_legacyCompat` markers on outbox entries (per design §15).
6. Regression tests for #99 and #102 stay passing from the MVP forward — no window where they flake.
7. **No mid-ladder `npm publish`.** Only the tagged beta boundaries publish. All PRs between betas land on `main` and ship in the next beta.

---

## 2. PR ladder (recommended order)

Seven PRs. **PR-A → PR-D are strictly serial** (each depends on the prior). **PR-E and PR-G can interleave** with the later serial PRs. **PR-F is best landed as a follow-up beta** (`beta.2`).

### PR-A — Workflow state machine + wire protocol

**Title:** `feat(workflow): 7-phase session lifecycle + attachment + lease model (v0.25 rebuild step 1/7)`

**What lands:**
- `src/types.ts` — new types: `Attachment`, `AttachmentToken`, `AttachmentPhase`, `AttachmentInfo`, `AdapterClass`, `AdapterDescriptor`, `DetachReason`, `AdapterDirective`. Remove old `SessionStatus` enum values.
- `src/workflows/signals.ts` — new updates (`claimAttachment`, `forceDetach`, `destroy`, `processingStart`, `processingEnd`, `enqueueSpawn`, `setPreferredHost`), new signals (`heartbeat`, `requestDetach`, `adapterExited`), new queries (`attachmentInfo`, `orphanSummary`). Remove `checkAndSetStatusUpdate`.
- `src/workflows/session.ts` — full rewrite of main loop + handlers per design §§2.2–2.6, §7, §8, §9.2, §9.5. Includes CAN lease-extension (§2.3), processingDeadline fire path (§9.5.b), drainingDeadline fire path (§9.5.c), destroy handler (§8.5), unknown-messageId history event (§7.2).
- `docs/WIRE-PROTOCOL.md` — rewrite from §11.1.
- Three new search attributes: `ClaudeTempoAttachedHost`, `ClaudeTempoAttachmentState`, `ClaudeTempoAttachmentId`. Register in Temporal namespace (operator task; document).
- **Temporary compat shim:** the MVP adapters (`src/channel.ts`, `src/copilot-bridge.ts`) keep working against PR-A by mapping their existing signals (`markDelivered`, `updateMetadata({ status })`) through a thin in-workflow adapter layer. This shim is removed by PR-C.

**Depends on:** MVP v0.24.1 shipped.

**Blast radius:** 4 files changed (~1500 LOC added, ~400 removed). Touches the most critical file in the repo (`session.ts`). **Migration PR: Yes** (Temporal search-attribute registration; worker rebuild required).

**Acceptance gate:**
- `npm run build` green.
- Existing test suite green with shim in place.
- New unit tests for the phase machine (`tests/workflows/session.spec.ts`): seven phases reachable, invariants §2.2, CAN lease-extension covered.
- `docs/WIRE-PROTOCOL.md` diff matches design §11.
- Manual: start a session, cue it, destroy it. Verify `ClaudeTempoAttachmentState` search attribute tracks phases.

**Risk:** medium-high. This is the keystone PR; anything downstream breaks if this is wrong. Mitigated by (a) keeping the MVP adapters working via shim, and (b) extensive unit tests.

**Feature-flagged?** No — the phase machine is always on. The shim keeps the old adapter surface functional.

---

### PR-B — Adapter directory + registry scaffolding (lift-and-shift)

**Title:** `refactor(adapters): extract claude-code + copilot into src/adapters/ with registry (step 2/7)`

**What lands:**
- `src/adapters/base.ts` — `BaseAttachment` abstract class skeleton, `AdapterRegistry` class, `AttachmentContext` interface impl. **This PR does not yet use the new attachment wire protocol.** `BaseAttachment.attach()` calls the shim from PR-A.
- `src/adapters/index.ts` — barrel + registry bootstrap.
- `src/adapters/README.md` — how to add a new adapter.
- `src/adapters/claude-code/adapter.ts` — `InteractiveAttachment extends BaseAttachment`. Moved verbatim from `src/channel.ts`; wrapped in a class; no behavior change.
- `src/adapters/claude-code/index.ts` — descriptor registration.
- `src/adapters/copilot/adapter.ts` — `CopilotSdkAttachment extends SdkAttachment extends BaseAttachment`. Moved verbatim from `src/copilot-bridge.ts`.
- `src/adapters/copilot/index.ts` — descriptor registration.
- `src/adapters/sdk/base.ts` — `SdkAttachment` abstract class, mostly a pass-through in this PR.
- `src/channel.ts` — DELETED (content moved).
- `src/copilot-bridge.ts` — DELETED (content moved).
- `src/server.ts` — adapter-class dispatch via `AdapterRegistry.get(metadata.adapterId ?? fallback)`; `handle.result()` exit watcher **stays** (removed in PR-C).
- `src/tools/agent-types.ts` — reads from registry.
- `src/tools/recruit.ts` — resolves `adapterId`/`adapterClass` from registry once at recruit, stores in metadata.

**Depends on:** PR-A landed.

**Blast radius:** 12 files changed (9 new, 2 removed, ~3 modified). **Migration PR: No** (pure refactor; no wire or state changes).

**Acceptance gate:**
- `npm run build` green.
- Full existing test suite green (refactor is behavior-preserving).
- `npm run lint` clean on the new directory.
- Smoke test: recruit one Claude Code session, one Copilot session, cue both, stop both.
- `SessionMetadata.adapterId` populated for freshly-recruited sessions (query an ensemble and spot-check).

**Risk:** low. Lift-and-shift refactors are mechanical. Main hazard is mis-routing imports.

**Feature-flagged?** No — the refactor is unconditional. The new structure stands in for the old files.

---

### PR-C — Adapter lifecycle wiring (claim / lease / heartbeat)

**Title:** `feat(adapters): wire claim/lease/heartbeat, remove MVP compat shim (step 3/7)`

**What lands:**
- `src/adapters/base.ts` — `BaseAttachment` full implementation: heartbeat loop with exp. backoff, lease-revoked poller, `onPhaseChange` / `onLeaseRevoked` listeners, `WorkflowNotFound` handler (normative §9.4), `claimAttachment` + runId pinning on every operation.
- `src/adapters/sdk/base.ts` — full `SdkAttachment` behavior: wraps `deliver()` in `processingStart` / `processingEnd` with `AttachmentMismatch` handling; SDK recreation budget; `onSuperseded` cancellation hook (§9.3).
- `src/adapters/claude-code/adapter.ts` — `InteractiveAttachment` uses the new context; no processing signals (class is `'interactive'`, `blocksOnLLMTurn=false`); `descriptor` set.
- `src/adapters/copilot/adapter.ts` — `CopilotSdkAttachment` uses `invokeSdk` + `onSuperseded` pattern; `session.cancel()` is the cancellation mechanism per §9.3.
- `src/server.ts` — remove `handle.result()` exit-on-complete watcher (§5.2); subprocess lifecycle now tied to `attachmentInfo.phase`.
- `src/workflows/session.ts` — **remove the call sites of** the MVP compat shim from PR-A. Old signal/update shapes (`updateMetadata({ status })`) are no longer invoked from the runtime path; only the new wire protocol remains. **The shim definition itself stays quarantined** as dead code behind a clearly-labeled comment block until the beta.3 cleanup PR deletes it (see §7 rollback and §5 beta.3 scope). This preserves the PR-C revert-path through beta.1 and beta.2.
- `src/types.ts` — `SessionMetadata.status` field removed.

**Depends on:** PR-A and PR-B landed.

**Blast radius:** ~6 files changed, significant LOC churn in adapter files (~800 LOC added, ~300 removed). **Migration PR: Yes** (removing the shim; any session started before PR-C that hasn't been stopped cannot continue against PR-C workers — they'll see `AttachmentMismatch` and exit cleanly per §9.4).

**Acceptance gate:**
- `npm run build` green.
- `tests/regression/issue-99.spec.ts` green — 6-minute stub `invokeSdk` with pending message; verify phase `attached → processing → attached`; **no** `stale`/`detached` intermediate.
- `tests/regression/issue-102.spec.ts` green — verify destroy path does not race a fresh run; verify `WorkflowNotFound` adapter exit.
- `tests/adapters/conformance.spec.ts` — cases 1–9 for both `claude-code` and `copilot` descriptors (stubbed if the suite isn't shipped yet — shipped in PR-G).
- Manual: start a long-running Copilot session with a 10-min prompt; observe phase `processing` in search attributes; confirm no stale fires.
- Manual: `kill -9` the adapter; verify workflow phase transitions to `detached` within 90s (lease timeout); verify no workflow completion.

**Risk:** HIGH — see §4 (Riskiest PR).

**Feature-flagged?** Optional: `CLAUDE_TEMPO_LIFECYCLE_V2=1` could gate the shim removal for one night of canary testing before full rollout. Recommend: ship the flag, default to on in beta.1, remove the flag entirely in beta.3 or GA.

---

### PR-D — New verbs: restart, detach, destroy, restore, migrate, attachment-info

**Title:** `feat(tools): restart/detach/destroy/restore/migrate verbs; remove stop/encore (step 4/7)`

**What lands:**
- `src/tools/restart.ts` — §8.2 algorithm.
- `src/tools/detach.ts` — graceful reap (`requestDetach` + wait on `detached`).
- `src/tools/destroy.ts` — §8.5 semantics (update + CLI `--yes` interactive prompt).
- `src/tools/restore.ts` — §10.3 wrapper (queries daemon for orphan list).
- `src/tools/migrate.ts` — `restart --host=<h>` alias.
- `src/tools/attachment-info.ts` — diagnostic query wrapper.
- `src/tools/stop.ts` — DELETED. Replaced by CLI shim that prints "Use `detach` or `destroy`" and exits 1.
- `src/tools/encore.ts` — DELETED. Replaced by CLI shim that prints "Use `restart`" and exits 1.
- `src/server.ts` — register new tools via `defineTool()`.
- `src/cli/commands.ts` — CLI surface for all of the above. Uses shared `TempoClient`.
- `src/client/interface.ts` + `src/client/index.ts` — add `restart`, `detach`, `destroy`, `restore`, `migrate`, `attachmentInfo` methods.
- `src/tui/*` — update command palette and slash-command registry to use new verbs. Remove `/encore`, `/stop` stubs-with-hints added.

**Depends on:** PR-A, PR-B, PR-C landed.

**Blast radius:** ~14 files changed (6 new, 2 removed, rest modified). **Migration PR: No** (additive; the removed verbs leave hint-shims).

**Acceptance gate:**
- `npm run build` green.
- Unit tests per tool: `restart` idempotency (§8.6), `destroy` already-gone, `detach` already-detached, `attachmentInfo` pre-attach.
- TUI smoke test: `/restart`, `/detach`, `/destroy` interactive prompts work; `/stop` / `/encore` print hints.
- Manual: full lifecycle — recruit → cue → detach → restart → destroy; observe phase transitions end-to-end.

**Risk:** medium. Lots of small surfaces; each is independently simple. Hazard is missing a corner (e.g., `restart --fresh` skipping context replay).

**Feature-flagged?** No — new verbs are additive; removed verbs print hints.

---

### PR-E — Daemon reconcile-on-boot + restore policy

**Title:** `feat(daemon): reconcile-on-boot, restore policy, cleanup loop (step 5/7)`

**What lands:**
- `src/daemon.ts` — `reconcileOnBoot()` per §10.1, `cleanupLoop()` per §13.4 regression row 1 (compact detached > 7d, destroy > 30d), `restorePolicy` config read.
- `~/.claude-tempo/config.json` schema — `restorePolicy`, `autoRestoreMaxAgeHours`, `autoRestoreEnsembles`, `cleanupPolicy`.
- `src/config.ts` — read and validate the new fields.
- `src/cli/commands.ts` — `daemon install`/`uninstall` commands (OS integration per §10.5; macOS launchd, Linux systemd, Windows Task Scheduler).
- Platform-specific install files: `packaging/systemd/claude-tempo.service`, `packaging/launchd/com.claude.tempo.plist`, `packaging/windows/install-task.ps1`.

**Depends on:** PR-A, PR-C landed (PR-B and PR-D nice-to-have but not strictly required — the daemon can call workflow updates directly via TempoClient).

**Blast radius:** ~8 files changed (3 modified, 5 new). **Migration PR: No** (daemon is boot-triggered; no workflow state changes).

**Acceptance gate:**
- `tests/rebuild/reboot.spec.ts` green — start workflow, kill daemon + adapter, restart daemon, assert `reconcileOnBoot` finds orphan, assert `restorePolicy=auto` restores it.
- Unit tests for `cleanupLoop` retention math.
- Manual: 3 hosts scenario — start on A, stop A's daemon, host A offline; host B runs `claude-tempo restore --from-host=A`; observe successful restart on B.
- OS-integration smoke tests (if the team has macOS + Linux + Windows dev boxes): `claude-tempo daemon install` creates a persistent service.

**Risk:** medium. OS integration has per-platform surface; pure daemon logic is straightforward.

**Feature-flagged?** `restorePolicy: "never"` is an effective off-switch.

---

### PR-F — Multi-host coordination + cross-host restart

**Title:** `feat(multi-host): cross-host restart, --yes-steal=<host>, preferred-host (step 6/7)`

**What lands:**
- `src/tools/restart.ts` — add `host` param routing to `claude-tempo-{host}` task queue for the spawn activity.
- `src/tools/restart.ts` — add `--yes-steal=<hostname>` flag enforcement per §16.5 decision.
- `src/workflows/session.ts` — `setPreferredHost` update handler (trivial; field on state).
- `src/daemon.ts` — `reconcileOnBoot` filters by preferred-host if set; cross-host restore flows.
- `src/cli/commands.ts` — `migrate` command wiring; confirmation prompts for cross-host.
- Integration test infrastructure: `tests/multi-host/` with a docker-compose harness spinning up two daemon containers against a shared Temporal dev server.

**Depends on:** PR-A, PR-C, PR-D, PR-E landed. **This is the multi-host capstone.**

**Blast radius:** ~6 files changed (4 modified, 2 new — the test harness). **Migration PR: No.**

**Acceptance gate:**
- New integration test: `tests/multi-host/cross-host-restart.spec.ts` — 2-daemon scenario; restart a session from host A to host B; verify spawn runs on B's task queue; verify session chat continuity.
- `--yes-steal` rejection paths tested (missing flag → error; wrong hostname → error).
- Manual 2-machine smoke test (physical or cloud VMs).

**Risk:** medium-high. Multi-host is the hardest-to-test surface. Mitigated by the docker-compose harness and the very defensive `--yes-steal` UX.

**Feature-flagged?** Not needed — users who don't pass `host` never exercise cross-host paths.

---

### PR-G — Tests, conformance suite, wire-protocol CI diff

**Title:** `test(adapters,wire): conformance suite + issue regressions + wire-protocol CI check (step 7/7)`

**What lands:**
- `tests/adapters/conformance.spec.ts` — the §4.5 suite, parameterized over registered adapter descriptors. Nine cases.
- `tests/regression/issue-99.spec.ts` — if not already landed in PR-C, lands here.
- `tests/regression/issue-102.spec.ts` — if not already landed in PR-C, lands here.
- `tests/rebuild/reboot.spec.ts` — if not already landed in PR-E, lands here.
- `scripts/check-wire-protocol.ts` — §17.9 CI check; scans `dist/` for handler names, diffs against `docs/WIRE-PROTOCOL.md`; fails CI on drift.
- `.github/workflows/ci.yml` — add the wire-protocol check step.
- `docs/adapters.md` — extract design §4 into its own doc for adapter authors.
- `CLAUDE.md` — update key-concepts section to reflect new verbs, phases, adapter registry.
- `docs/UPGRADING.md` — short expansion of design §15.

**Depends on:** PR-A (for the wire-protocol check) and PR-C (for the conformance suite). Can land in parallel with PR-D / PR-E / PR-F as tests are progressively enabled.

**Blast radius:** ~8 files changed (5 new, 2 CI / docs, 1 `CLAUDE.md` edit). **Migration PR: No.**

**Acceptance gate:**
- All new test files green in CI.
- Wire-protocol check detects a deliberately-introduced drift (reviewer adds a signal, doesn't doc it, CI fails; reviewer docs it, CI passes).
- `docs/adapters.md` + updated `CLAUDE.md` approved by `tempo-liner`.

**Risk:** low. Tests + docs; no production code surface.

**Feature-flagged?** No.

---

## 3. Blast radius summary

| PR | Files Δ | LOC Δ (approx) | Migration? | Serial or parallel |
|---|---|---|---|---|
| PR-A | 4 | +1500 / −400 | Yes (search attrs + workers) | Serial (blocks all) |
| PR-B | 12 | +900 / −700 | No | Serial (blocks PR-C+) |
| PR-C | 6 | +800 / −300 | Yes (shim removal) | Serial (blocks PR-D+) |
| PR-D | 14 | +1200 / −400 | No | Serial (blocks PR-F) |
| PR-E | 8 | +600 / −50 | No | Parallel-eligible after PR-C |
| PR-F | 6 | +500 / −50 | No | Needs PR-E first |
| PR-G | 8 | +1100 / −20 | No | Parallel-eligible after PR-A |

Total: ~6600 LOC added, ~1900 removed across 58 files. Spread across 7 PRs, nothing insane.

---

## 4. Riskiest PR

**PR-C** is the riskiest. Reasoning:

1. **It's the first PR where the new wire protocol fully replaces the old.** PR-A ships the wire protocol behind a shim; PR-B refactors adapters structurally without touching the wire. PR-C is where the rubber meets the road — workflow and adapter must both speak the new language simultaneously.
2. **It removes the shim.** The point of no return; rolling back post-PR-C means rolling back PR-A + PR-B + PR-C together. (Individually they're recoverable.)
3. **Split-brain cancellation is new code.** `onSuperseded` + `AbortController` for the headless path and `session.cancel()` for Copilot are both novel integration points. The bounded ghost-reply window documented in §9.3 is a **new failure mode** introduced by this PR, even if it's a strictly better failure than today's silent hang.
4. **Lease-revoked polling interval tuning.** The 5-heartbeat-interval poll default is a guess; if adapter processes are killed before the poll catches them, there's a brief window of ambiguity. Observability needed (not blocker; see §7 Rollback).

**Mitigations:**
- Ship PR-C **behind `CLAUDE_TEMPO_LIFECYCLE_V2=1` for the first 48h** after merge. Default to on, but let operators flip it off if a storm of `AttachmentMismatch` errors surfaces. Remove the flag in beta.3.
- Lean heavily on the conformance suite — PR-C's acceptance gate requires suite cases 1–9 green.
- Issue-99 and Issue-102 regression tests serve as the hard stop: if either flakes, PR-C does not merge.
- Keep the `v0.24.1` patch available on npm with a clear rollback path in release notes.

---

## 5. Beta tag sequencing

The conductor asked for 1–2 spots where an intermediate beta tag de-risks shipping one giant `beta.1`. My recommendation is **three betas, none of them giant:**

### `v0.25.0-beta.1` — Single-host lifecycle rebuild

Contents: **PR-A + PR-B + PR-C + PR-D + PR-G** (partial — the pieces of PR-G that cover these PRs).

Delivers:
- 7-phase state machine
- Adapter directory + registry
- Full lifecycle wiring (claim, heartbeat, lease, processing tracking, WorkflowNotFound spec, split-brain cancellation)
- New verbs: `restart`, `detach`, `destroy`, `restore` (single-host only), `attachment-info`
- Conformance suite passes for `claude-code` and `copilot` adapters
- Issue-99 and Issue-102 regression tests green

Explicitly **not** in beta.1:
- Multi-host coordination
- Daemon `reconcileOnBoot`
- `migrate` tool
- Cross-host `--yes-steal`

Rationale: beta.1 is the architectural cleanup users can adopt on single-machine setups without any multi-host exposure. Large blast radius but every piece is coherent — shipping fewer pieces would leave an awkward intermediate (PR-C without PR-D would be a workflow with no user-facing verbs to drive it).

**Beta.1 target length:** 1500–2000 LOC net changes.

### `v0.25.0-beta.2` — Daemon + multi-host

Contents: **PR-E + PR-F + PR-G (remaining test parts)**.

Delivers:
- Daemon reconcile-on-boot + restore policy
- OS integration (install/uninstall)
- Cross-host restart with `--yes-steal=<host>` safety
- `migrate` tool
- Cleanup loop
- `tests/multi-host/` integration harness

Rationale: these land together because they share conceptual surface (multi-host coordination) and integration testing (2-machine scenarios). Shipping them separately means either a beta with a daemon that doesn't do the new thing yet, or multi-host restart without the daemon to recover orphans — both are half-features.

**Beta.2 target length:** 1100 LOC net changes.

### `v0.25.0-beta.3` — Flag removal + polish + GA prep

Contents:
- Remove `CLAUDE_TEMPO_LIFECYCLE_V2` feature flag and all conditional branches.
- **`git rm` the PR-A compat shim definition** (quarantined as dead code in PR-C per §7 rollback plan).
- Docs polish and any tightenings from beta.1 / beta.2 user reports.

Rationale: GA-ready. No new features; stability and cleanup only. Retiring the shim and the flag in the same beta means rollback infrastructure disappears atomically — there's no interim state where the shim still exists but can't be re-engaged by flag flip.

**Beta.3 target length:** <500 LOC.

### `v0.25.0` — GA

Promotion of beta.3 after a ~2-week soak.

---

## 6. Parallelizable work

After **PR-A lands**, the following can run in parallel streams:

- **Stream 1 (critical path):** PR-B → PR-C → PR-D (serial within the stream; blocks beta.1).
- **Stream 2 (tests):** PR-G test-harness pieces — `conformance.spec.ts` skeleton, wire-protocol CI check, regression test scaffolding. Ship incrementally; enable assertions as each critical-path PR lands.
- **Stream 3 (docs):** `docs/adapters.md` draft + `CLAUDE.md` update + `docs/UPGRADING.md`. Owned by `tempo-liner`; can run the entire beta.1 window.

After **PR-C lands**, additionally:

- **Stream 4 (daemon / multi-host):** PR-E and PR-F can start design-in-code in parallel with PR-D landing. Won't merge until beta.2 window.

Practical team allocation (2 engineers):
- Engineer 1 owns the critical path: PR-B, PR-C, PR-D (sequential).
- Engineer 2 owns tests + daemon: PR-G scaffolding, PR-E, PR-F.

One engineer can do the whole ladder if time is abundant — just slower.

---

## 7. Rollback and recovery

**Per-PR rollback:**
- **PR-A:** revert the PR + re-publish workers. Sessions in flight on new workers see old SDKs calling the new wire surface → `ApplicationFailure(UnknownHandler)`. Mitigated by keeping v0.24.1 workers available until beta.1 soak passes.
- **PR-B:** straight revert; no runtime impact (structural refactor).
- **PR-C:** revert PR-C + keep PR-A + PR-B. The compat shim from PR-A re-engages; MVP adapters resume working. **Critical: PR-A's shim definition must stay under version control until beta.3 ships.** Don't `git rm` it in PR-C; PR-C only removes the call sites and quarantines the definition behind a clearly-labeled dead-code comment. Deletion happens in beta.3's cleanup PR (see §5) — tied to the same release that removes the `CLAUDE_TEMPO_LIFECYCLE_V2` flag, so rollback infrastructure disappears atomically. This gives the rebuild two intermediate revert-checkpoints (end of beta.1, end of beta.2) before the safety net is retired at GA prep.
- **PR-D:** revert tool additions; users lose the new verbs but lifecycle still works via direct MCP queries. Tolerable.
- **PR-E:** revert; orphan sessions require manual `restart`. Tolerable.
- **PR-F:** revert; cross-host restart goes away; single-host restart still works. Tolerable.
- **PR-G:** revert tests only; no runtime impact.

**Emergency flag:** `CLAUDE_TEMPO_LIFECYCLE_V2=0` (after PR-C ships with the flag) forces adapters into legacy shim mode. Users can set this and keep using the rebuild's workflow with old adapter behavior — buys 48h of triage time.

**Temporal-side rollback hazard:** new search attributes (`ClaudeTempoAttachedHost`, `ClaudeTempoAttachmentState`, `ClaudeTempoAttachmentId`) must be registered **before** PR-A workers start. If the team rolls back the Temporal namespace config (removes the attributes), PR-A workers will fail `upsertSearchAttributes` calls and break. Recommend: register in a separate ops PR ~3 days before PR-A opens for review, keep registered across all rollback scenarios.

### 7.1 Upgrade guidance for automation users

PR-D **deletes** `src/tools/stop.ts` and `src/tools/encore.ts` from the MCP tool surface. They are replaced with CLI hint-shims that print a one-line message and **exit with code 1** — they do not fall back to the old behavior and do not consume the arguments in a compatible way. Operators or automation that shell out to `claude-tempo stop <player>` or `claude-tempo encore <player>` will see:

```
$ claude-tempo stop alice
stop: this verb is gone in v0.25. Use `claude-tempo detach alice` (graceful) or `claude-tempo destroy alice` (abandon). See docs/UPGRADING.md.
$ echo $?
1
```

Implications:

- **MCP clients** calling `stop` or `encore` as tool names will get "tool not found" errors from the server. Update scripts to use `detach` / `destroy` / `restart` per design §8.
- **Shell automation** treating `claude-tempo stop` as idempotent (e.g., pre-job cleanup in a CI runner) will start failing the whole job on the non-zero exit. Either update the command, or wrap with `|| true` **only** if the stop was cosmetic.
- **TUI users** see the same hint inside the palette; no automation impact.
- **`docs/UPGRADING.md`** (landed in PR-G) is the authoritative migration reference; keep it in sync with this block if the verb semantics drift during implementation.

This is called out here (and not only in the design doc §15) because automation surface is often where rebuilds silently break — a green build is not sufficient signal. The hint-shims turn silent failures into loud ones, on purpose.

---

## 8. Gate handoff format (for each PR assignment)

When handing a PR to `tempo-eng`, include:

1. **Scope** — the bullet list from §2 above.
2. **Acceptance gate** — the exact checklist from §2.
3. **Blast radius** — file count + LOC estimate.
4. **Dependency** — which PRs must have merged first.
5. **Design section references** — which §§ of `session-lifecycle-rebuild-v2.md` (@88b0d3f) apply.
6. **Beta it belongs to** — beta.1 / beta.2 / beta.3.
7. **Risk flag** — low / medium / medium-high / high. Default low unless otherwise noted.

Example for PR-C (the riskiest):

```
Title: feat(adapters): wire claim/lease/heartbeat, remove MVP compat shim (step 3/7)
Beta: v0.25.0-beta.1
Risk: HIGH (see sequencing memo §4)
Depends on: PR-A, PR-B merged to main
Scope: design §3.2, §4.3, §5, §6, §9.3, §9.4 in @88b0d3f
Gate:
  - npm run build green
  - tests/regression/issue-99.spec.ts green (6-min stub invokeSdk, no stale fires)
  - tests/regression/issue-102.spec.ts green (destroy path, WorkflowNotFound adapter exit)
  - tests/adapters/conformance.spec.ts cases 1-9 green for both descriptors
  - Manual: kill -9 adapter; workflow → detached within 90s; no completion
Blast radius: ~6 files, ~800 LOC added, ~300 removed
Flag: CLAUDE_TEMPO_LIFECYCLE_V2=1 default on; remove in beta.3
```

---

## 9. Out of scope (for this memo)

- Test-harness design details (docker-compose specifics for PR-F).
- GA release criteria beyond "beta.3 soak 2 weeks."
- Metrics/telemetry wiring (design §17.10 explicitly out of scope).
- HTTP gateway (#67), JSON-RPC headless mode (#18) — both untouched by this sequencing.
- Agent-type additions beyond claude-code and copilot (the HeadlessClaude worked example in design §4.6 is illustrative only).
- Cross-ensemble design changes (Maestro, scheduler, conductor-only surfaces).

---

## 10. Decisions locked

The four pre-kickoff open questions were answered by `tempo-conductor` in the cue dated **2026-04-12T15:25:19Z** (lock confirmation for memo HEAD `6f0dedd`). Recorded here so the implementing engineer has a single source of truth:

1. **Search-attribute registration.** Owner: `tempo-devops` drafts `tctl` commands + runbook; user executes. Timing: the ops PR (runbook + registration script) lands **~3 days ahead of PR-A opening for review**. Conductor to cue `tempo-devops` separately.
2. **Feature flag naming.** Locked as `CLAUDE_TEMPO_LIFECYCLE_V2=1`. Chosen to match the patched marker naming (`v0.25-attachment-lifecycle`) and because it captures the full rebuild scope better than the narrower `ATTACHMENT_V2`. Memo text is already consistent with this.
3. **Beta soak window.** Locked as **1 week for beta.1, 1 week for beta.2, 2 weeks for beta.3 → GA**. Two-week soak only on the GA gate; tight feedback loop on the intermediate betas justified by small user base. Total timeline: **~4 weeks** from PR-A kickoff to GA assuming no respins. Section §5 target lengths and order are unchanged; only the soak windows are locked.
4. **PR-G split.** Stream 2 (tests) is **co-owned**: `tempo-lead` writes test files (throughput precedent from the Phase-1 TUI tests); `tempo-qa` designs the conformance suite + gates + reviews. **Docs Stream 3** (`docs/adapters.md`, `CLAUDE.md`, `docs/UPGRADING.md`) is owned by `tempo-docs` in parallel. `tempo-eng` stays on the critical-path Stream 1.

> If any of these decisions need to reopen during the ladder, cue the architect — don't quietly deviate.

---

**End of sequencing memo.**
