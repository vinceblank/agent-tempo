# Orchestration: Quality Gates, Pipeline Stages, and Worktrees

These features are conductor-only tools for tracking and coordinating parallel work.

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

## Related

- [tools.md](tools.md) — full tool list including `worktree`, `quality_gate`, `evaluate_gate`, `gates`, `stage`, `stages`, `cancel_stage`
- [ensembles.md](ensembles.md) — player types and lineups for orchestrated teams
