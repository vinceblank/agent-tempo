# Conductor State Handoff

> **Audience:** Incoming conductor resuming orchestration of the claude-tempo v0.25 session-lifecycle rebuild.
> **Last updated:** 2026-04-13 by tempo-docs (PR-F scope corrected from sequencing memo §2)
> **Status:** PR-A, PR-B, PR-C, PR-G merged. PR-D/E/F remaining. Beta release pending PR-F.

---

## Project Context

**claude-tempo** is an MCP server enabling multi-session Claude Code coordination via Temporal. Current work is a 7-PR session-lifecycle rebuild (v0.25) that introduces a 7-phase attachment state machine, an adapter pattern, and a durable lease lifecycle for player sessions.

See [CLAUDE.md](../../CLAUDE.md) for full project context and [docs/WIRE-PROTOCOL.md](../WIRE-PROTOCOL.md) for the stable signal/query/update surface.

---

## v0.25 Ladder — Current State

### Completed (merged to `main`)

| PR | Label | What it did |
|----|-------|-------------|
| PR-A | Signal + update surface | New signals (`heartbeat`, `requestDetach`, `adapterExited`), updates (`claimAttachment`, `forceDetach`, `enqueueSpawn`, `setPreferredHost`, `processingStart`, `processingEnd`, `destroy`), queries (`inFlightMessages`, `isDestroyed`, `attachmentInfo`, `orphanSummary`). Feature flag `CLAUDE_TEMPO_LIFECYCLE_V2` introduced (default ON, commit `7c481a6`). |
| PR-B | Adapter lift-and-shift | `src/channel.ts` and `src/copilot-bridge.ts` promoted to `src/adapters/` tree (`InteractiveAttachment`, `CopilotSdkAttachment`). No behavior change — mechanical move. |
| PR-C | Session lifecycle rewire | 7-phase machine (`booting → attached → processing → awaiting → draining → detached → gone`) wired into `session.ts`. Adapter lease lifecycle scaffolded in `src/adapters/base.ts`. |
| PR-G | Test scaffold | Conformance suite, workflow test scaffold, wire-protocol test suite stubs created for end-to-end validation. |

### Remaining

| PR | Label | Scope |
|----|-------|-------|
| **PR-D** | encore retirement + SpawnOutboxEntry wiring | `performEncore` migrated to `forceDetach` + fresh `claimAttachment` pair (retiring `checkAndSetStatusUpdate`). `SpawnOutboxEntry` 5 attachment fields (`attachmentId`, `attachmentRunId`, `resumeAttachment`, `sessionId?`, `adapterId`) forwarded through workflow dispatcher → `spawnProcess` activity → `BaseAttachment.startV2Lifecycle`. Also owns `restart` verb wiring (§8.1). `migrate` verb scope TBD — ask conductor before designing. Wire-protocol removal: `checkAndSetStatusUpdate` deleted, `docs/WIRE-PROTOCOL.md` updated same commit. |
| **PR-E** | Daemon restore / reconcile-on-boot | `claude-tempo daemon` gains a reconcile-on-boot pass: queries `ClaudeTempoAttachmentState=detached` for orphaned sessions, reads `orphanSummary` query, applies `restorePolicy` decision tree (design §10.2). Sessions in `detached` with `preferredHost` matching local host auto-restored via fresh `spawnProcess` → `claimAttachment`. New CLI `restore` command (§10.3) for manual operator intervention. Depends on PR-D's `restart` verb. |
| **PR-F** | Multi-host coordination + cross-host restart | **Capstone.** Depends on PR-D + PR-E. From sequencing memo §2: `host` param routing to `claude-tempo-{host}` task queue (restart verb), `--yes-steal=<hostname>` flag per design §16.5 Option B, `setPreferredHost` update handler in `session.ts`, `reconcileOnBoot` filtered by preferred-host in `daemon.ts`, `migrate` CLI command wiring, multi-host integration tests via docker-compose harness (two daemon containers, shared Temporal dev server). ~500 LOC, ~6 files. |
| _(note)_ | Shim + flag cleanup | `CLAUDE_TEMPO_LIFECYCLE_V2` flag + compat shim removal (#132) is **post-GA in v0.25.1** per sequencing §5.2 — NOT absorbed into PR-D/E/F. |

---

## Release Plan

```
PR-D lands → squash merge to main (vinceblank)
PR-E lands → squash merge to main (vinceblank)
PR-F lands → squash merge to main (vinceblank)
  │
  └─▶ tempo-devops:
        1. Bump package.json → "0.25.0-beta.1"
        2. Flip CHANGELOG [0.25.0-beta.1] - Unreleased → dated entry
        3. Commit: "chore: bump version to v0.25.0-beta.1"
        4. Tag: git tag v0.25.0-beta.1 && git push origin v0.25.0-beta.1
        5. GH Actions publishes to npm automatically

  2-week beta soak → GA as 0.25.0
  Post-GA: v0.25.1 cleanup (issue #132)
```

**No per-PR beta bumps.** One consolidated beta tag after PR-F only.

**Never tag before the version bump commit exists on main.** See [CLAUDE.md Release Process](../../CLAUDE.md).

---

## Open Issues for Next Conductor

| Issue | Topic | Status | Action needed |
|-------|-------|--------|---------------|
| **#128** | `recall` preview cap (200-char) too small | Awaiting user decision on option | Do not implement — wait for user to pick |
| **#129** | CLAUDE.md lazy-load (cost optimization) | Approved, needs implementation | Assign to tempo-eng post-PR-F |
| **#130** | Subagent guidance added to agent type docs | Approved, needs implementation | Assign to tempo-eng or tempo-docs post-PR-F |
| **#131** | Claude API + `advisor_20260301` native-tool adapter | Filed for v0.26+ | No action this cycle |
| **#132** | v0.25.1 shim cleanup (test fixtures, shim branch, `hardTerminate` flag) | Post-GA work | Assign to tempo-eng after GA |

---

## Active Ensemble Roster

### Working roster (Phase 2 — post-retirement)

| Player | Role | Notes |
|--------|------|-------|
| `tempo-conductor` | Orchestration | You |
| `tempo-eng` | PR work | Fresh session; currently on `docs/handoff-pr-d` branch |
| `tempo-qa` | Single-pass review | Recruit fresh for each QA pass |
| `tempo-docs` | Docs at release | Handles CHANGELOG, WIRE-PROTOCOL, CLAUDE.md, README |
| `tempo-devops` | Release cycle | Handles bump + tag + npm publish |

### Retired (do not recruit)

`tempo-eng-2`, `tempo-lead`, `tempo-architect`, `tempo-architect-2`, `tempo-researcher`, `tempo-qa-2`

Architecture is frozen post-PR-C. Dual-QA retired for efficiency. Older worktrees still exist in `.ct-worktrees/` but their branches are stale.

---

## Operating Invariants

### Must-never-break rules

1. **Feature flag is ON.** `CLAUDE_TEMPO_LIFECYCLE_V2` is default-ON since PR-A (commit `7c481a6`). Do not flip off — it gates the new session-lifecycle machine.

2. **Wire protocol is stable.** Additions are fine in minor bumps. Any rename or removal is a breaking change requiring a major version bump. `docs/WIRE-PROTOCOL.md` must be updated in the **same commit** as any signal/query/update change.

3. **Workflow bundle.** `npm run build` pre-bundles `src/workflows/` into `workflow-bundle.js`. Always run after any workflow code change. Workers and sessions must use identical bundled code.

4. **Squash merge, user-only.** Only `vinceblank` merges to `main`. Conductor proposes; user executes. No direct pushes to `main` from any player (including docs fixes — use a branch + PR).

5. **Docs branch → PR → ping conductor.** All changes go through a PR. For small doc-only fixes, bundle into the next in-flight PR if timing aligns.

### Dispatch policy

- **Read-heavy work** (Grep surveys, multi-file archaeology, drift checks): dispatch to `Task`/`Explore` subagents. Players pay for the summary, not the files. See issue #130.
- **Code writing**: player writes directly — don't delegate your core deliverable.
- **1–3 targeted file lookups**: do them inline; subagent overhead not worth it.

---

## First Steps as Incoming Conductor

1. `ensemble` — see who's live and what's in flight.
2. Read [`docs/handoff/pr-d-engineer-brief.md`](pr-d-engineer-brief.md) for PR-D scope.
3. Read [`docs/handoff/qa-rubric.md`](qa-rubric.md) for QA criteria.
4. If no PR-D work in flight: cue `tempo-eng` with the PR-D scope and kick off.
5. After `tempo-eng` reports PR-D ready: recruit a fresh `tempo-qa` for single-pass review.
6. Repeat for PR-E, then PR-F.
7. After PR-F: hand off to `tempo-devops` for the beta tag (follow release plan above).
8. Docs pass: cue `tempo-docs` for a CHANGELOG + CLAUDE.md consistency check before beta tag.

---

## Cost Context

User is on a $200 Claude Max subscription with high token burn. Root causes identified:

- Large accumulated player context (expensive per-cue as context grows)
- CLAUDE.md loaded in full on every session start (issue #129 — approved fix pending)
- Too many concurrent working players (addressed by Phase 2 roster retirement above)
- Dual-QA overkill for mechanical PRs (retired)

Phase 2 (this handoff) retires old players. Phase 3 (optional, not yet approved) would retire the conductor after PR-F. All handoff docs live in `docs/handoff/` as repo-level persistent memory.

---

## Key File Locations

| File | Purpose |
|------|---------|
| `CLAUDE.md` | Full project context — structure, conventions, key concepts |
| `docs/WIRE-PROTOCOL.md` | Stable signal/query/update names and search attributes |
| `docs/handoff/conductor-state.md` | This document |
| `docs/handoff/pr-d-engineer-brief.md` | PR-D spec for tempo-eng |
| `docs/handoff/qa-rubric.md` | QA acceptance criteria for v0.25 PRs |
| `src/workflows/session.ts` | Core session workflow (v0.25 7-phase machine) |
| `src/adapters/` | Adapter implementations (InteractiveAttachment, CopilotSdkAttachment) |
| `src/workflows/signals.ts` | Session signal/query/update type definitions |
| `src/workflows/maestro-signals.ts` | Maestro signal/query type definitions |
| `src/workflows/scheduler-signals.ts` | Scheduler signal/query type definitions |

---

*This document is updated by `tempo-docs` at each major orchestration transition. If the state here diverges from what you observe in `ensemble`, the live ensemble is the ground truth.*
