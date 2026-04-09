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
├── daemon.ts          # Daemon entry point — runs Temporal workers as a detached background process
├── cli/
│   ├── commands.ts    # CLI command implementations (up, start, conduct, status, stop, upgrade, …)
│   ├── config-command.ts # config subcommand (interactive + set/show)
│   ├── daemon.ts      # Daemon management utilities (start, stop, status, logs, isDaemonRunning)
│   ├── mcp.ts         # MCP server registration helpers (init, global vs project)
│   ├── output.ts      # Shared CLI output formatting helpers
│   └── preflight.ts   # Environment preflight checks
├── copilot-bridge.ts  # Copilot SDK bridge for Copilot CLI players
├── worker.ts          # Temporal worker setup (used by daemon only)
├── connection.ts      # Temporal connection factory (shared by server + CLI)
├── spawn.ts           # Cross-platform process spawning helpers
├── workflows/
│   ├── index.ts       # Workflow exports (re-exports for worker bundle)
│   ├── session.ts     # claude-session workflow
│   ├── scheduler.ts   # durable scheduler workflow (one per ensemble)
│   ├── maestro.ts     # Maestro workflows — per-ensemble hub (one per ensemble) and global hub (one instance spanning all ensembles)
│   ├── maestro-signals.ts # Maestro signal/query/update type definitions
│   ├── scheduler-signals.ts # Scheduler signal/query type definitions
│   └── signals.ts     # Session signal/query type definitions
├── activities/
│   ├── outbox.ts      # Outbox delivery activities (cue, report, stop, recruit, encore)
│   ├── maestro.ts     # Maestro activities (refreshEnsembleState, relayCommandToConductor, fetchConductorHistory, fetchEnsembleChat)
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
├── tui/
│   ├── index.ts       # TUI entry point — connects to Temporal and renders the Ink app
│   ├── App.tsx        # Root TUI component — chat-focused shell with slash commands
│   ├── store.ts       # TUI state reducer (phase, players, messages, schedules, static history)
│   ├── client.ts      # TempoClient interface and implementation — wraps Temporal queries via Maestro
│   ├── commands.ts    # Slash command parser and registry (/player, /broadcast, /status, etc.)
│   ├── ink-loader.ts  # Dynamic ESM loader for Ink (avoids CJS/ESM conflicts)
│   ├── ink-context.tsx # React context for injected Ink primitives
│   ├── components/
│   │   ├── Splash.tsx         # Splash/connecting screen component
│   │   ├── TitleBar.tsx       # Pinned title bar showing ensemble/player context
│   │   ├── PromptArea.tsx     # Pinned input area with ❯ prompt, inline hints, and divider
│   │   ├── MainView.tsx       # Main ensemble view (players, messages, schedules)
│   │   ├── ChatView.tsx       # Per-player chat view (entered via /cue <player>)
│   │   ├── ErrorView.tsx      # Connection failure screen with troubleshooting checks (zero Yoga nodes)
│   │   ├── StatusBar.tsx      # Persistent status bar (player counts, schedule count, connection health)
│   │   ├── CommandPalette.tsx    # Autocomplete dropdown for slash commands and parameters
│   │   ├── Picker.tsx            # Full-screen interactive picker (players, ensembles)
│   │   ├── PlayerDetailView.tsx  # Player metadata + scrollable message history (zero Yoga nodes)
│   │   ├── StatusOverlay.tsx     # Dismissible overlay showing ensemble player cards (/status)
│   │   ├── ConversationStream.tsx    # Live message area merging server conversation + optimistic echo
│   │   ├── CreateEnsembleWizard.tsx  # Step-by-step wizard for creating new ensembles (name → workDir → lineup → confirm)
│   │   ├── ScheduleWizard.tsx        # Step-by-step wizard for /schedule create
│   │   └── RecruitWizard.tsx         # Step-by-step wizard for /recruit
│   └── utils/
│       ├── format.ts          # Display formatting helpers
│       ├── platform.ts        # Terminal size detection helpers
│       ├── theme.ts           # THEME constants (colors, borders, icons)
│       ├── fullscreen.ts      # Fullscreen/alternate-screen helpers
│       └── history.ts         # Persistent command history (~/.claude-tempo/tui-history.json)
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

# Start the daemon (runs Temporal workers in background)
claude-tempo daemon start

# Run in development
npx ts-node src/server.ts

# Build (compiles TS and pre-bundles workflow code)
npm run build

# Test
npm test
```

> **Important**: Always run `npm run build` after changing workflow code (`src/workflows/`).
> The build pre-bundles workflows into `workflow-bundle.js` so all workers use identical code.

> **Daemon workers**: Temporal workers are no longer run in-process by sessions. The daemon
> (`src/daemon.ts`) runs as a detached background process and owns all worker duties. Sessions are
> pure MCP clients. The daemon is auto-started by any claude-tempo command if not already running.

## Key Concepts

- **Player**: A Claude Code session registered as a Temporal workflow
- **Conductor**: A special player that acts as orchestration hub, connected to external interfaces (one per ensemble)
- **Ensemble**: The set of all active players, namespaced by `CLAUDE_TEMPO_ENSEMBLE`
- **Cue**: A message sent to a player by name via Temporal signal
- **Part**: A player's description of what it's working on
- **Recruit**: Spawning a new Claude Code session as a player. The workflow is pre-created with the initial message before the process spawns, ensuring reliable delivery.
- **set_name**: Players start with a random hex ID; `set_name` updates the `ClaudeTempoPlayerId` search attribute to a human-readable name
- **Session status**: Each session has a status (`pending` → `active` → `stale` | `blocked`) tracked via `ClaudeTempoStatus` search attribute. Pre-created workflows start as `pending`, transition to `active` when the process connects, and become `stale` if messages go undelivered for 3+ minutes. Sessions become `blocked` when they are alive (delivering messages) but have produced no response to a `responseRequested: true` message for 5+ minutes — they may be stuck or spinning. Informational messages (broadcasts, schedule-fires, heartbeats, system notifications) set `responseRequested: false` and do not trigger blocked detection. Blocked status auto-recovers to `active` on next outbound.
- **Outbox**: Outbound requests (cue, report, stop, recruit, encore) go through the session's own workflow outbox instead of directly signaling other workflows. The workflow's dispatch loop processes entries via activities, decoupling tools from cross-workflow signaling.
- **Encore**: Revives a `stale` player session by restarting the Claude process and reconnecting to the existing Temporal workflow, with recent message context restored. Cannot encore `active`, `pending`, or `terminated` sessions — use `cue`, wait, or `recruit` respectively.
- **Broadcast**: Fan-out variant of `cue` — sends a message to all active players in the ensemble in a single call. Optionally filtered by player type. Skips the sender, pending sessions, and (by default) stale sessions.
- **Recall**: Queries a session's own message history from the Temporal workflow. Shows received messages by default; pass `includeSent: true` to also see sent messages. Supports `limit`, `since`, and `from` filters.
- **Per-host task queues**: Each host runs a `claude-tempo-{hostname}` activity worker for local-only operations (e.g., `spawnProcess`). This enables cross-machine recruiting — the `recruit` tool accepts an optional `host` parameter to route the spawn to a remote machine's task queue.
- **Player types**: Reusable agent definitions in Claude Code's standard subagent format (`.md` files with YAML frontmatter). Ensemble lineups can reference types by name via a `type` field on players. Three-tier lookup: project `.claude/agents/` → user `~/.claude/agents/` → shipped `examples/agents/`. Players know their type via workflow metadata and the `who_am_i` tool. Agent type frontmatter may include an `allowedTools` array to restrict which MCP/CLI tools the spawned session can use (e.g., `allowedTools: [Read, Glob, Grep]`). When present, the type's `allowedTools` overrides any lineup-level setting and is passed to the Claude Code session via `--allowedTools`.
- **Agent type discovery**: The `agent_types` MCP tool and `claude-tempo agent-types` CLI command let conductors discover available player types. Shipped examples (tempo-conductor, tempo-composer, tempo-soloist, tempo-tuner, tempo-critic, tempo-roadie, tempo-improv, tempo-liner) work out of the box. Ensemble lineups: tempo-big-band (full lifecycle), tempo-dev-team (feature work), tempo-review-squad (parallel review), tempo-jam-session (exploration).
- **Schedule**: A one-shot or recurring message delivery configured via the `schedule` tool. Backed by a durable `claudeSchedulerWorkflow` — survives restarts. Supports delay (`delay`), fixed time (`at`), recurring interval (`every`), and cron expressions (`cron`) with optional IANA timezone (`timezone`). Cron schedules use `croner` for expression parsing and next-fire computation. Managed via `schedule`, `unschedule`, and `schedules` tools.
- **Lineup**: A YAML file defining an ensemble configuration — which players to recruit, their types, working directories, and optional startup messages. Load via `load_lineup` to bootstrap a full ensemble in one step; `load_lineup` resolves the lineup by name using a three-tier lookup: saved lineups → shipped examples → file path. Save via `save_lineup` to snapshot a running ensemble's state for later reuse.
- **Quality Gate**: A named checklist of criteria a conductor tracks to verify a task is complete. Created via `quality_gate` (conductor only), evaluated via `evaluate_gate`, and listed via `gates`. Each criterion has a `pending` → `passed` | `failed` status; the gate's aggregate status is derived automatically (all passed → `passed`, any failed → `failed`, else `open`). Gates are stored in the conductor workflow and survive `continueAsNew`.
- **Worktree**: A git worktree provisioned by the conductor for a player, giving them an isolated checkout on a separate branch. Managed via the `worktree` tool (conductor only): `create` provisions the worktree and notifies the player, `remove` cleans up after the task, `list` shows all active worktrees. Worktree assignments are stored in the conductor workflow (`WorktreeEntry` records: player, path, branch, gitRoot, createdAt, createdBy).
- **Stage**: A fan-out/fan-in tracking primitive for the conductor. Created via `stage` (conductor only), listing via `stages`, cancelled via `cancel_stage`. Each stage tracks a set of players; when a tracked player sends a `report`, their stage status updates automatically (`waiting` → `reported` or `blocked`). When all players have reported, the conductor is notified that the stage is complete. If `failurePolicy` is `'halt'` (default), a blocker from any player fails the entire stage. Stages are stored in the conductor workflow and survive `continueAsNew`.
- **Maestro**: Two Maestro workflow variants exist. The **per-ensemble** `claudeMaestroWorkflow` (ID: `claude-maestro-{ensemble}`) monitors a single ensemble — maintains a player snapshot, ring-buffer event log (max 200 entries), an aggregated ensemble chat cache (max 500 entries, refreshed every ~10s via `fetchEnsembleChat` activity), and queues commands for relay to the conductor via `maestroSendCommand`. The ensemble chat cache merges maestro + conductor traffic and is served via the `maestroEnsembleChat` query. The **global** `claudeGlobalMaestroWorkflow` (ID: `claude-maestro-global`) spans all ensembles — aggregates players by ensemble, maintains a cross-ensemble message ring buffer (max 500 entries), and exposes on-demand player/conductor history via `maestroFetchPlayerMessages` and `maestroFetchConductorHistory` updates. The Maestro dashboard ([vinceblank/maestro](https://github.com/vinceblank/maestro)) can connect to either. Both are implemented in `src/workflows/maestro.ts` with activities in `src/activities/maestro.ts`.
- **TempoClient**: The TUI's API layer (`src/tui/client.ts`) — a TypeScript interface and implementation that wraps Temporal queries to the Maestro and conductor workflows. Provides `discoverEnsembles`, `getPlayers`, `getMessages`, `getConductorHistory`, `sendMessage`, `sendCommand`, `getEnsembleChat`, `getGates`, `getStages`, `getWorktrees`, and `terminatePlayer`. Uses Global Maestro as the primary source with graceful fallback to per-ensemble Maestro and direct workflow list queries.
- **Wire protocol**: All Temporal signal, query, update, and workflow names are documented in [`docs/WIRE-PROTOCOL.md`](docs/WIRE-PROTOCOL.md). These names are stable as of v0.10 — renaming or removing any is a breaking change requiring a major version bump.
- **Daemon**: A standalone background process (`src/daemon.ts`) that runs all Temporal workers. Auto-started by any claude-tempo command if not already running. PID stored at `~/.claude-tempo/daemon.pid`; logs at `~/.claude-tempo/daemon.log`. Sessions are now pure MCP clients — they no longer run in-process workers. Managed via `claude-tempo daemon start|stop|status|logs`.

## TUI Performance (Ink/React)

Hard-won lessons from debugging input lag in the TUI (#58). Apply these whenever touching `src/tui/`.

- **Fullscreen bypass is permanent**: When `lastOutputHeight >= stdout.rows`, Ink permanently switches to `clearTerminal + full-rewrite` on every frame — this never resets. Every component/phase must render within `height: termRows - 1` to stay in the fast `throttledLog` path (in-place line updates).
- **Animation timers poison rendering**: `setInterval`-based animations (spinners, metronomes) trigger re-renders every 80–150ms. Each re-render runs the full Yoga layout + output pipeline for all nodes. Never use animation timers in components that coexist with input areas — rapid re-renders cause input lag.
- **Yoga node count: keep under ~20**: Every `<Box>` creates a Yoga layout node; every keystroke recalculates all of them. 100+ nodes = laggy input. Prefer nested `<Text>` over `<Box><Text>` — nested Text creates `ink-virtual-text` with zero Yoga nodes. Pre-format content as strings with `\n` and render as a single `<Text>`.
- **Uncontrolled input pattern**: Input components must not dispatch to parent state on every keystroke. Use local `useState` + `useImperativeHandle` ref for parent communication. Guard all callbacks (e.g. `onPaletteToggle`) to only fire when values actually change — otherwise you get silent parent re-renders on every keypress.
- **Reducer state identity matters**: `return { ...state, field: sameValue }` creates a new object reference and triggers a re-render even when nothing changed. Always check before spreading: `if (!state.paletteVisible && state.paletteIndex === 0) return state;`
- **Stale refs between renders**: When using the ref pattern for stable `useInput` callbacks, values read from `ref.current` are only updated on React render. For values that change between renders (e.g. input value), update `ref.current.value` synchronously inside the setter — not just on render. Otherwise rapid keystrokes (e.g. holding backspace) read stale values and drop inputs.
- **Debugging approach**: When diagnosing Ink lag, create minimal test apps (`.mjs`) adding one factor at a time (fullscreen, Temporal, InkProvider, real components) to isolate the cause. If the minimal app is fast but the real app is slow, the component tree is the culprit — not the infrastructure.
- **Cap live message counts**: ChatView and similar message lists must limit visible messages (~20). Rendering hundreds of messages in the live Yoga tree creates 1000+ React elements that slow reconciliation and output generation. Show a "↑ N earlier messages" indicator when truncated. Future: adopt Ink's `<Static>` pattern (render-once, exit Yoga tree) like Claude Code does for scroll history.

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
