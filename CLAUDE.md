# CLAUDE.md

## What is this?

claude-tempo is an MCP server that enables multiple Claude Code sessions to coordinate via Temporal.

## Tech Stack

- **Runtime**: Node.js 18+ with TypeScript
- **MCP**: `@modelcontextprotocol/sdk` (stdio transport)
- **Temporal**: `@temporalio/client`, `@temporalio/worker`, `@temporalio/workflow`, `@temporalio/activity`
- **croner** — cron expression parsing and next-fire computation (used by `schedule` tool)
- **yaml**, **zod** — lineup parsing and schema validation

## Project Structure

```
src/
├── server.ts          # MCP server entry point
├── cli.ts             # CLI entry point (claude-tempo command)
├── cli/
│   ├── commands.ts    # CLI command implementations (up, start, conduct, status, stop, …)
│   ├── config-command.ts # config subcommand (interactive + set/show)
│   ├── mcp.ts         # MCP server registration helpers (init, global vs project)
│   ├── output.ts      # Shared CLI output formatting helpers
│   └── preflight.ts   # Environment preflight checks
├── copilot-bridge.ts  # Copilot SDK bridge for Copilot CLI players
├── worker.ts          # Temporal worker setup
├── connection.ts      # Temporal connection factory (shared by server + CLI)
├── spawn.ts           # Cross-platform process spawning helpers
├── workflows/
│   ├── index.ts       # Workflow exports (re-exports for worker bundle)
│   ├── session.ts     # claude-session workflow
│   ├── scheduler.ts   # durable scheduler workflow (one per ensemble)
│   ├── maestro.ts     # Maestro ensemble hub workflow (one per ensemble)
│   ├── maestro-signals.ts # Maestro signal/query/update type definitions
│   ├── scheduler-signals.ts # Scheduler signal/query type definitions
│   └── signals.ts     # Session signal/query type definitions
├── activities/
│   ├── outbox.ts      # Outbox delivery activities (cue, report, stop, recruit, encore)
│   ├── maestro.ts     # Maestro activities (refreshEnsembleState, relayCommandToConductor, fetchConductorHistory)
│   ├── resolve.ts     # Session resolver shared by outbox + schedule-fire activities
│   └── schedule-fire.ts # Schedule fire activity
├── ensemble/
│   ├── schema.ts      # Lineup type definitions
│   ├── loader.ts      # Load and validate YAML lineups
│   ├── saver.ts       # Save live ensemble state to YAML
│   └── agent-types.ts # Agent type discovery, resolution, and lineup resolution
├── tools/
│   ├── ensemble.ts    # Discover active sessions
│   ├── cue.ts         # Send message to peer (via outbox)
│   ├── set-name.ts    # Set session name
│   ├── set-part.ts    # Update own summary
│   ├── who-am-i.ts    # Query own identity, role, and session details
│   ├── agent-types.ts # Discover available player types (agent definitions)
│   ├── resolve.ts     # Search-attribute session lookup
│   ├── listen.ts      # Manual message check
│   ├── recruit.ts     # Spawn new session (via outbox), supports `type` param
│   ├── report.ts      # Report to conductor (via outbox)
│   ├── stop.ts        # Stop a session (via outbox)
│   ├── broadcast.ts   # Send message to all active players (via outbox fan-out)
│   ├── encore.ts      # Revive a stale session (via outbox)
│   ├── recall.ts      # Read own message history (received + sent)
│   ├── load-lineup.ts # Load an ensemble lineup, recruit players
│   ├── save-lineup.ts # Save current ensemble state as a lineup
│   ├── schedule.ts    # Create one-shot or recurring schedules
│   ├── unschedule.ts  # Cancel a named schedule
│   ├── schedules.ts   # List active schedules
│   ├── quality-gate.ts # Define quality gates for tasks (conductor only)
│   ├── evaluate-gate.ts # Mark gate criteria as passed/failed (conductor only)
│   ├── gates.ts       # List quality gates and their status (conductor only)
│   ├── worktree.ts    # Manage git worktrees for player isolation (conductor only)
│   ├── stage.ts       # Define a stage — fan-out/fan-in tracking for parallel tasks (conductor only)
│   ├── stages.ts      # List stages and their status (conductor only)
│   ├── cancel-stage.ts # Cancel an active stage (conductor only)
│   └── helpers.ts     # Zod/MCP tool registration wrapper
├── utils/
│   ├── validation.ts  # Shared validation constants (name/message/path limits, encore defaults) and helpers
│   ├── worktree.ts    # Git worktree create/remove helpers (cross-platform)
│   ├── safe-path.ts   # Path safety utilities
│   └── duration.ts    # Duration parsing helpers
├── types.ts           # Shared type definitions
├── channel.ts         # Claude channel notification helper
├── git-info.ts        # Git repository detection helper
└── config.ts          # Env var handling
```

## Development

```bash
# Install dependencies
npm install

# Start Temporal dev server (separate terminal)
temporal server start-dev

# Run in development
npx ts-node src/server.ts

# Build (compiles TS and pre-bundles workflow code)
npm run build

# Test
npm test
```

> **Important**: Always run `npm run build` after changing workflow code (`src/workflows/`).
> The build pre-bundles workflows into `workflow-bundle.js` so all workers use identical code.

> **Dual workers**: Each session runs two Temporal workers — a shared `claude-tempo` queue
> (workflows + delivery activities) and a per-host `claude-tempo-{hostname}` queue (spawn activities only).
> Both are created via `createWorkers()` in `src/worker.ts`.

## Key Concepts

- **Player**: A Claude Code session registered as a Temporal workflow
- **Conductor**: A special player that acts as orchestration hub, connected to external interfaces (one per ensemble)
- **Ensemble**: The set of all active players, namespaced by `CLAUDE_TEMPO_ENSEMBLE`
- **Cue**: A message sent to a player by name via Temporal signal
- **Part**: A player's description of what it's working on
- **Recruit**: Spawning a new Claude Code session as a player. The workflow is pre-created with the initial message before the process spawns, ensuring reliable delivery.
- **set_name**: Players start with a random hex ID; `set_name` updates the `ClaudeTempoPlayerId` search attribute to a human-readable name
- **Session status**: Each session has a status (`pending` → `active` → `stale`) tracked via `ClaudeTempoStatus` search attribute. Pre-created workflows start as `pending`, transition to `active` when the process connects, and become `stale` if messages go undelivered for 3+ minutes.
- **Outbox**: Outbound requests (cue, report, stop, recruit, encore) go through the session's own workflow outbox instead of directly signaling other workflows. The workflow's dispatch loop processes entries via activities, decoupling tools from cross-workflow signaling.
- **Encore**: Revives a `stale` player session by restarting the Claude process and reconnecting to the existing Temporal workflow, with recent message context restored. Cannot encore `active`, `pending`, or `terminated` sessions — use `cue`, wait, or `recruit` respectively.
- **Broadcast**: Fan-out variant of `cue` — sends a message to all active players in the ensemble in a single call. Optionally filtered by player type. Skips the sender, pending sessions, and (by default) stale sessions.
- **Recall**: Queries a session's own message history from the Temporal workflow. Shows received messages by default; pass `includeSent: true` to also see sent messages. Supports `limit`, `since`, and `from` filters.
- **Per-host task queues**: Each host runs a `claude-tempo-{hostname}` activity worker for local-only operations (e.g., `spawnProcess`). This enables cross-machine recruiting — the `recruit` tool accepts an optional `host` parameter to route the spawn to a remote machine's task queue.
- **Player types**: Reusable agent definitions in Claude Code's standard subagent format (`.md` files with YAML frontmatter). Ensemble lineups can reference types by name via a `type` field on players. Three-tier lookup: project `.claude/agents/` → user `~/.claude/agents/` → shipped `examples/agents/`. Players know their type via workflow metadata and the `who_am_i` tool. Agent type frontmatter may include an `allowedTools` array to restrict which MCP/CLI tools the spawned session can use (e.g., `allowedTools: [Read, Glob, Grep]`). When present, the type's `allowedTools` overrides any lineup-level setting and is passed to the Claude Code session via `--allowedTools`.
- **Agent type discovery**: The `agent_types` MCP tool and `claude-tempo agent-types` CLI command let conductors discover available player types. Shipped examples (tempo-conductor, tempo-composer, tempo-soloist, tempo-tuner, tempo-critic, tempo-roadie, tempo-improv, tempo-liner) work out of the box. Ensemble lineups: tempo-big-band (full lifecycle), tempo-dev-team (feature work), tempo-review-squad (parallel review), tempo-jam-session (exploration).
- **Schedule**: A one-shot or recurring message delivery configured via the `schedule` tool. Backed by a durable `claudeSchedulerWorkflow` — survives restarts. Supports delay (`delay`), fixed time (`at`), recurring interval (`every`), and cron expressions (`cron`) with optional IANA timezone (`timezone`). Cron schedules use `croner` for expression parsing and next-fire computation. Managed via `schedule`, `unschedule`, and `schedules` tools.
- **Lineup**: A YAML file defining an ensemble configuration — which players to recruit, their types, working directories, and optional startup messages. Load via `load_lineup` to bootstrap a full ensemble in one step; save via `save_lineup` to snapshot a running ensemble's state for later reuse.
- **Quality Gate**: A named checklist of criteria a conductor tracks to verify a task is complete. Created via `quality_gate` (conductor only), evaluated via `evaluate_gate`, and listed via `gates`. Each criterion has a `pending` → `passed` | `failed` status; the gate's aggregate status is derived automatically (all passed → `passed`, any failed → `failed`, else `open`). Gates are stored in the conductor workflow and survive `continueAsNew`.
- **Worktree**: A git worktree provisioned by the conductor for a player, giving them an isolated checkout on a separate branch. Managed via the `worktree` tool (conductor only): `create` provisions the worktree and notifies the player, `remove` cleans up after the task, `list` shows all active worktrees. Worktree assignments are stored in the conductor workflow (`WorktreeEntry` records: player, path, branch, gitRoot, createdAt, createdBy).
- **Stage**: A fan-out/fan-in tracking primitive for the conductor. Created via `stage` (conductor only), listing via `stages`, cancelled via `cancel_stage`. Each stage tracks a set of players; when a tracked player sends a `report`, their stage status updates automatically (`waiting` → `reported` or `blocked`). When all players have reported, the conductor is notified that the stage is complete. If `failurePolicy` is `'halt'` (default), a blocker from any player fails the entire stage. Stages are stored in the conductor workflow and survive `continueAsNew`.
- **Maestro**: A durable `claudeMaestroWorkflow` (one per ensemble, ID: `claude-maestro-{ensemble}`) that acts as an ensemble state aggregator for external integrations. It periodically polls all session metadata to maintain a player snapshot and ring-buffer event log, and accepts commands via the `maestroSendCommand` update for relay to the conductor. The Maestro dashboard ([vinceblank/maestro](https://github.com/vinceblank/maestro)) connects to this workflow to display live ensemble state. Implemented in `src/workflows/maestro.ts` with activities in `src/activities/maestro.ts`.
- **Wire protocol**: All Temporal signal, query, update, and workflow names are documented in [`docs/WIRE-PROTOCOL.md`](docs/WIRE-PROTOCOL.md). These names are stable as of v0.10 — renaming or removing any is a breaking change requiring a major version bump.

## Dashboard

The ensemble dashboard (Maestro) lives in a separate repository: [vinceblank/maestro](https://github.com/vinceblank/maestro)

It provides a web UI for managing ensembles, communicating with conductors, and monitoring player activity.

## Commit Convention

Use conventional commits: `type(scope): message`

Examples:
- `feat(tools): add ensemble discovery tool`
- `fix(workflow): handle signal delivery edge case`
- `docs: update getting started guide`

## Release Process

**Correct order — never deviate:**

1. Merge the feature PR into `main` (squash merge)
2. Bump `version` in `package.json` and add a `## [x.y.z]` entry in `CHANGELOG.md` on `main`
3. Commit: `chore: bump version to vX.Y.Z`
4. Tag the bump commit: `git tag vX.Y.Z && git push origin vX.Y.Z`

The release workflow triggers on `v*` tag pushes and publishes to npm. **Never tag before the version bump commit exists on main, and never tag a commit that doesn't match the version in `package.json`.** Tagging prematurely (e.g., before a feature PR merges) publishes the old version to npm and forces a patch bump to recover.
