# Orchestration: Quality Gates, Pipeline Stages, and Worktrees

These features are conductor-only tools for tracking and coordinating parallel work.

## Turn Mechanics and Yielding

The cue delivery model is pull-based. Understanding it prevents the most common conductor anti-pattern — busy-waiting for replies with `sleep`+`listen` loops.

| Rule | Why |
|---|---|
| **Yield after dispatch** — after cueing and expecting a reply, end your turn | Inbound cues wake you at the next turn boundary automatically; staying awake gains nothing |
| **`listen` is a one-shot inbox drain** — not a blocking wait | It reads whatever is already queued; a `sleep`+`listen` loop burns tokens without advancing work |
| **Don't reply to ack/FYI cues** — respond only to questions or action requests | Replying to an ack starts a ping-pong that wastes turns on both sides |
| **Cues queue, they don't interrupt** — bursts arrive together at the next boundary | Process the batch in one turn; don't start a separate turn per cue |

The `stage` tool is the structured alternative to polling: define a stage with a set of players, cue them, and you're notified automatically when all have reported — no loop required.

## Quality Gates

Conductors can define named checklists of criteria to verify task completion. Three conductor-only tools are available: `quality_gate` (create or replace a gate), `evaluate_gate` (mark criteria as passed or failed), and `gates` (list all gates with optional filters).

### Examples

Tell your conductor things like:

- *"Set a quality gate 'pr-ready' with criteria: tests pass, no lint errors, code reviewed"*
- *"Mark criteria 0 and 1 on 'pr-ready' as passed"*
- *"Show me all open quality gates"*
- *"Check whether 'deploy-staging' has passed"*

### How It Works

- Gate status is derived from criteria: all passed → `passed`; any failed → `failed`; otherwise `open`
- Gates survive `continueAsNew` for the conductor workflow's lifetime

## Pipeline Stages

Conductors can track fan-out/fan-in of parallel work using stages. Define a stage with a set of players, cue them to work, and the conductor is automatically notified when all players have reported — without polling.

Three conductor-only tools: `stage` (create a stage), `stages` (list all stages), `cancel_stage` (cancel an active stage).

### Examples

Tell your conductor things like:

- *"Create a stage called 'review' with players: critic-1, critic-2, critic-3"*
- *"Show me the status of all pipeline stages"*
- *"Cancel the 'deploy' stage"*

### How It Works

- When a tracked player sends a `report`, their status updates automatically (`waiting` → `reported` or `blocked`)
- When all players have reported, the conductor is notified that the stage is complete
- Two failure policies: `halt` (default — fail the stage on first blocker) and `continue` (keep the stage active until all players report)
- Stages survive `continueAsNew` for the conductor workflow's lifetime

## Git Worktrees

The `worktree` tool lets the conductor provision isolated git worktrees for players — each player gets their own checkout on a separate branch, preventing conflicts when multiple players work on the same repo.

Three conductor-only actions: `create` (provision a worktree and notify the player), `remove` (clean up after the task), `list` (show all active worktrees).

### Examples

Tell your conductor things like:

- *"Create a worktree for soloist-1 on branch feat/api"*
- *"List all active worktrees"*
- *"Remove the worktree for soloist-1"*

### How It Works

- Worktree assignments are stored in the conductor workflow (`WorktreeEntry` records: player, path, branch, gitRoot, createdAt, createdBy)
- When a worktree is created, the player is notified with the path and branch
- Worktrees survive `continueAsNew` for the conductor workflow's lifetime

### Stop long-running processes before `remove`

**Before the conductor calls `worktree remove`, the player must stop any
long-running process started inside the worktree** — dev servers (`npm run
dev`), file watchers, test runners in `--watch` mode, and the like.

On Windows this is **mandatory**: a running process memory-maps native `.node`
modules from the worktree's `node_modules` (e.g. a framework's native runtime),
and Windows holds the file lock until that process exits. `git worktree remove`
deletes the worktree's git metadata first, then fails to delete the locked
directory — leaving a half-removed orphan. As of the #594 fix, `remove` detects
this and returns a failure (conductor state is left intact so you can retry),
rather than silently reporting success. A later `create` for the same player
then recovers the orphan automatically — but the cleanest path is to stop the
process first so `remove` succeeds outright.

On macOS and Linux the lock semantics are laxer, but stopping watchers first is
still good hygiene — it avoids a watcher firing on a half-deleted tree.

### When to use worktrees

**Use worktrees when:**

- **Multiple players commit to different branches of the same repo at the same time.** This is the canonical case — without worktrees, `git add` in one player's session can pick up uncommitted edits from another player's working directory. Each worktree has its own index and HEAD, so there is no cross-contamination.
- **A player needs an experimental branch without dirtying the shared working tree.** If the operator's own checkout is on `main` and a player needs to rebase or bisect on a scratch branch, a worktree keeps the operator's `git status` clean.
- **Parallel CI-style pipelines.** When several soloists each produce a PR (e.g., refactoring three independent modules), worktrees let each player commit, push, and run local checks in isolation.

**Skip worktrees when:**

- **Players work in separate repos** — already isolated by filesystem, no benefit.
- **Players work on the same branch sequentially** — no concurrent commit conflict; a shared checkout is fine.
- **The task is short-lived (under ~5 minutes)** — worktree setup and teardown takes 3–10 seconds plus disk I/O; the overhead may exceed the work itself.
- **Work is read-only** — grepping, reading, analyzing source. No commits means no conflict risk.

**Costs to be aware of:**

- **Disk space** — one full checkout per worktree (same as cloning the repo again).
- **Setup latency** — `create` runs `git worktree add` plus optional `npm install`; budget 5–30 seconds depending on dependency count.
- **Mental bookkeeping** — the conductor must track which path/branch belongs to which player and call `remove` at task end to avoid orphaned checkouts.

**Worked example:**

> Three soloists are refactoring `auth/`, `payments/`, and `notifications/` in parallel, each producing a separate PR. All three would otherwise operate on `main` from the same `~/repos/myapp` checkout. Without worktrees, soloist-B's `git add -A` could pick up soloist-A's unstaged edits across module boundaries. Provisioning worktrees gives each player an isolated path (`~/repos/myapp-wt-payments-soloist-2`, etc.) and a dedicated branch (`ensemble/payments-soloist-2`), so commits, diffs, and `git status` are fully independent.

## Related

- [tools.md](tools.md) — full tool list including `worktree`, `quality_gate`, `evaluate_gate`, `gates`, `stage`, `stages`, `cancel_stage`
- [ensembles.md](ensembles.md) — player types and lineups for orchestrated teams
