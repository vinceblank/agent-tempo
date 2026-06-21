# 1.7.0 → 2.0 Cutover Guide

> **DRAFT — targets 2.0.0-beta.1.** Content is sourced from the ratified design
> (A2 clean-cutover, `docs/design/v2-scoping.md` §A.3) and the execution plan
> (`docs/design/v2-execution-plan.md` §4). Details that depend on `#786`
> (`up --from-upgrade`) are marked **[#786]** and will be finalized when that
> issue lands. Known beta limitations are in [§5](#5-known-beta-limitations).

---

## Overview

The 1.7.0 → 2.0 migration is a **clean cutover**, not an in-place upgrade.
You run one verb on 1.7.0, install 2.0, run one verb on 2.0, and your ensemble
comes back as fresh `protocol-2` workflows with continuity restored (lineups,
state slots, schedules, session IDs). The design deliberately avoids in-place
replay-compat: coordination state is cheap to recreate, and a clean cut clears
every legacy tolerance at once.

**This is one-way.** There is no rollback path to 1.x after cutover.
See [§4](#4-one-way-no-rollback).

---

## 1. Prerequisites

Before starting:

1. **You must be on 1.7.0 stable.** Run `agent-tempo --version` and confirm.
   Direct upgrades from 1.6.x or earlier are not supported — hop through 1.7.0
   first (`npm install -g agent-tempo@latest`).

2. ⚠ **Upgrade ALL hosts' daemons before any ensemble comes back up.**
   2.0 workflows reject v1 adapters at the `claimAttachment` boundary via a
   `protocolVersion` handshake. A mixed-version cluster (2.0 workflow + 1.x
   adapter) produces an actionable error but a broken attach — not silent data
   loss. Upgrade order: **all daemons first, then bring ensembles up.**
   Use `agent-tempo hosts` to enumerate your cluster.

3. **No active workflows need to survive.** The cutover destroys every 1.x
   workflow (they COMPLETE gracefully). Continuity is carried through the
   snapshot file, not live session state. If you have work in flight, either
   let it finish or accept that it re-starts on the 2.0 side from saved state.

---

## 2. The three-step round-trip

### Step 1 — Run `upgrade-to-2` on 1.7.0

```bash
agent-tempo upgrade-to-2
```

The verb runs a six-phase protocol:

| Phase | What happens |
|---|---|
| **Preflight** | Refuses if any connected daemon is below the 1.7.x version floor (checks `hostProfile.version` on the global maestro). Catches stale daemons before any destructive step. |
| **Pause** | Locks maestro + scheduler outboxes so no new cues enter. Sessions stay live to drain. |
| **Drain** | Polls session outboxes until empty (≤60s). Pass `--force-drain` to proceed with non-empty outboxes, recording stragglers in the snapshot for operator review. |
| **Snapshot** | Freezes session dispatch, then writes continuity to `~/.agent-tempo/upgrade-snapshot-v1.json`. **Snapshot strictly precedes destroy** — a crash here leaves everything intact; there is never destruction without a durable capture. |
| **Destroy** | Ordered teardown: peers → scheduler + maestro → conductor. Idempotent — re-running after a partial destroy is safe. |
| **Done** | Exit 0. The snapshot file is your continuity record. |

**Flags:**

| Flag | Effect |
|---|---|
| `--dry-run` | Prints the would-be snapshot + destroy list, then exits before pausing. Useful for inspection. |
| `--force-drain` | Records stragglers instead of stopping on a non-empty drain. |
| `--yes` / `-y` | Skips the typed-confirmation prompt. |

**Resumability:** if the command is interrupted after the snapshot phase, re-running
it resumes from the snapshot's phase stamp — it will not re-capture state, just
continue the destroy sequence.

---

### Step 2 — Install 2.0

```bash
npm install -g agent-tempo@next          # 2.0.0-beta.1
# or, once 2.0 is stable:
npm install -g agent-tempo@latest
```

Confirm the installed version:

```bash
agent-tempo --version
```

---

### Step 3 — Run `up --from-upgrade` on 2.0 **[#786]**

```bash
agent-tempo up --from-upgrade
```

Reads `~/.agent-tempo/upgrade-snapshot-v1.json`, recreates all sessions as
fresh `protocol-2` workflows (stamped `AgentTempoProtocol=2`), and seeds
continuity. On success the snapshot file is archived as
`upgrade-snapshot-v1.consumed.json`.

> **Beta status:** `up --from-upgrade` lands in `#786`. Until that issue ships,
> this step is not available — do not attempt the cutover until #786 is confirmed
> merged in the beta you're testing.

---

## 3. What is preserved vs. not

### Preserved (restored on the 2.0 side)

| Item | How |
|---|---|
| **Lineup recipe** (players, conductor, schedules-as-authored) | Re-read from snapshot; ensemble shape recreated |
| **#334 state slots** (`main` + named slots, up to 4 × 32 KiB per player) | Seeded into each new session via the `self-restart` delivery identity |
| **Durable schedules** (cron + one-shot) | Recreated by `up --from-upgrade`; user intent is durable |
| **`sessionId`** (per player) | Preserved; enables `--resume` across restart |
| **Non-default `model`** (ad-hoc claude-api / opencode / Pi recruit arg) | Captured per player; ad-hoc sessions recreated on the same model |

### NOT preserved (dropped at cutover)

| Item | Why |
|---|---|
| **Coat-check entries** | TTL-transient coordination artifacts — not continuity state |
| **Quality gates / stages / worktrees** | Transient coordination state; worktree continuity rides `workDir` in the lineup |
| **Live transcript / scrollback** | Sessions recreate with clean history; use `#334` state slots to seed context before cutover |

### Undelivered cues — operator review required

Cues that were in-flight when `upgrade-to-2` ran are **captured in the snapshot
for operator review, not auto-redelivered**. Replaying stale cues into fresh
sessions could cause confusing re-runs or duplicate work.

After cutover, inspect the snapshot (or the archived `.consumed.json`) for any
`undeliveredMessages` entries and manually re-send anything that matters.

---

## 4. One-way — no rollback

The A2 clean-cutover is **irreversible by design**. Once `upgrade-to-2` destroys
the 1.x workflows, re-installing 1.7.0 will start fresh (no existing sessions to
resume). The snapshot file preserves your continuity record, but there is no
automated rollback command.

**Plan accordingly:**
- Use `--dry-run` first to inspect the destroy list.
- Ensure `#334` state slots are populated for any session context you want to
  carry forward (conductors should call `save_state` before the cutover window).
- Keep the snapshot file until you've verified the 2.0 ensemble is healthy.

---

## 5. Known beta limitations

> This section is updated as beta testing surfaces issues. Check back before
> each beta release.

- **`up --from-upgrade` not yet shipped.** Step 3 depends on `#786`. Do not
  attempt a live cutover until #786 is confirmed merged in the beta you're
  testing.
- **Full E2E round-trip matrix not yet CI-certified.** The GA gate (`#796`)
  automates multi-host, force-drain, straggler, and edge-case variants — it is
  not required to pass for beta.1, only for GA. The minimal smoke test
  (single-host happy path) is the beta.1 bar.
- **Mixed-version error messages.** The `protocolVersion` rejection at
  `claimAttachment` will surface an actionable error; exact wording may be
  refined during the beta period.
- **Command-center `broadcast`, `migrate`, and `schedule create` not in beta.1.**
  The operator board supports schedule list and delete, but not create; and does
  not yet include `broadcast` or `migrate` actions. Use the CLI or web dashboard
  during the beta window:
  ```bash
  agent-tempo broadcast "message"          # CLI fallback
  agent-tempo migrate <player> --to <host> # CLI fallback
  agent-tempo schedule ...                 # CLI fallback for schedule create
  ```
  Command-center support for all three lands in beta.2.

---

## 6. Boot guard

The 2.0 daemon includes a boot preflight that scans for Running agent-tempo
workflows **without** the `AgentTempoProtocol=2` stamp. If any are found, the
daemon **refuses to start workers** and prints the migration command:

```
✗ Found N un-stamped Running workflow(s). Run `agent-tempo upgrade-to-2`
  on your 1.7.0 installation first, then re-install 2.0.
```

This guard prevents silent replay faults. If you see it, you missed step 1 —
run `upgrade-to-2` on your 1.7.0 install, then reinstall 2.0.

---

## 7. Reference

| Resource | Location |
|---|---|
| Cutover verb source | `src/upgrade/phase-engine.ts`, `src/upgrade/snapshot-v1.ts` |
| Snapshot schema (cross-release bridge) | `src/upgrade/snapshot-v1.ts` — versioned; additive optional fields do not bump the version |
| Design rationale (A2 clean-cutover) | `docs/design/v2-scoping.md` §A.3 |
| Execution plan — operational steps | `docs/design/v2-execution-plan.md` §4 |
| beta.1 safety-core checklist | `docs/design/v2-beta1-checklist.md` §1 |
| `up --from-upgrade` implementation | `#786` |
| GA round-trip CI gate | `#796` |
