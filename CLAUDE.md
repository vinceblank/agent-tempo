# CLAUDE.md

## What is this?

claude-tempo is an MCP server that enables multiple Claude Code sessions to coordinate via Temporal.

## Tech Stack

- **Runtime**: Node.js 18+ with TypeScript
- **MCP**: `@modelcontextprotocol/sdk` (stdio transport)
- **Temporal**: `@temporalio/client`, `@temporalio/worker`, `@temporalio/workflow`, `@temporalio/activity`
- **No other dependencies** — no database, no custom broker

## Project Structure

```
src/
├── server.ts          # MCP server entry point
├── copilot-bridge.ts  # Copilot SDK bridge for Copilot CLI players
├── worker.ts          # Temporal worker setup
├── workflows/
│   ├── session.ts     # claude-session workflow
│   └── signals.ts     # Signal/query type definitions
├── activities/
│   ├── outbox.ts      # Outbox delivery activities (cue, report, stop, recruit)
│   └── schedule-fire.ts # Schedule fire activity
├── ensemble/
│   ├── schema.ts      # Blueprint type definitions
│   ├── loader.ts      # Load and validate YAML blueprints
│   ├── saver.ts       # Save live ensemble state to YAML
│   └── agent-types.ts # Agent type discovery, resolution, and blueprint resolution
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
│   └── helpers.ts     # Zod/MCP tool registration wrapper
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
- **Outbox**: Outbound requests (cue, report, stop, recruit) go through the session's own workflow outbox instead of directly signaling other workflows. The workflow's dispatch loop processes entries via activities, decoupling tools from cross-workflow signaling.
- **Per-host task queues**: Each host runs a `claude-tempo-{hostname}` activity worker for local-only operations (e.g., `spawnProcess`). This enables cross-machine recruiting — the `recruit` tool accepts an optional `host` parameter to route the spawn to a remote machine's task queue.
- **Player types**: Reusable agent definitions in Claude Code's standard subagent format (`.md` files with YAML frontmatter). Ensemble blueprints can reference types by name via a `type` field on players. Three-tier lookup: project `.claude/agents/` → user `~/.claude/agents/` → shipped `examples/agents/`. Players know their type via workflow metadata and the `who_am_i` tool.
- **Agent type discovery**: The `agent_types` MCP tool and `claude-tempo agent-types` CLI command let conductors discover available player types. Shipped examples (tempo-conductor, tempo-composer, tempo-soloist, tempo-tuner, tempo-critic, tempo-roadie, tempo-improv) work out of the box. Ensemble blueprints: tempo-big-band (full lifecycle), tempo-dev-team (feature work), tempo-review-squad (parallel review), tempo-jam-session (exploration).

## Dashboard

The ensemble dashboard (Maestro) lives in a separate repository: [vinceblank/maestro](https://github.com/vinceblank/maestro)

It provides a web UI for managing ensembles, communicating with conductors, and monitoring player activity.

## Commit Convention

Use conventional commits: `type(scope): message`

Examples:
- `feat(tools): add ensemble discovery tool`
- `fix(workflow): handle signal delivery edge case`
- `docs: update getting started guide`
