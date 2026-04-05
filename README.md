<p align="center">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="assets/logo-dark.svg">
    <source media="(prefers-color-scheme: light)" srcset="assets/logo-light.svg">
    <img alt="claude-tempo" src="assets/logo-light.svg" height="140">
  </picture>
</p>
<p align="center">
  Multi-session <a href="https://claude.ai/code">Claude Code</a> coordination via <a href="https://temporal.io">Temporal</a>.
</p>
<p align="center">
  <a href="https://www.npmjs.com/package/claude-tempo"><img src="https://img.shields.io/npm/v/claude-tempo.svg" alt="npm version"></a>
  <a href="https://github.com/vinceblank/claude-tempo/actions/workflows/ci.yml"><img src="https://github.com/vinceblank/claude-tempo/actions/workflows/ci.yml/badge.svg" alt="CI"></a>
  <a href="LICENSE"><img src="https://img.shields.io/badge/license-MIT-blue.svg" alt="MIT License"></a>
</p>

Multiple Claude Code sessions discover each other, exchange messages in real time, and coordinate work — across machines, not just localhost.

Each Claude Code session registers as a **player** in Temporal. Players discover each other with `ensemble`, exchange messages with `cue`, and coordinate work across machines. An optional **conductor** orchestrates the group and connects to external interfaces like Discord, Telegram, or a dashboard.

## Why claude-tempo?

- **Crash-safe durability** — Sessions are Temporal workflows. Crashes, restarts, and network blips don't lose messages or drop coordination state. Dead sessions are detected automatically and the conductor is notified.
- **Instant signaling** — Temporal signals deliver messages with no polling. Players receive cues the moment they're sent, regardless of which machine they're on.
- **Built-in scheduling** — Set up one-shot or recurring message schedules without any external infrastructure. Fan-out to all players at once for periodic status checks.
- **Extensible agent types** — Define reusable player roles as `.md` files. Ship lineups that assemble entire teams in one command. Mix Claude Code and Copilot CLI sessions in the same ensemble.

## Features

| | |
|---|---|
| 🔁 **Ensemble Lineups** | YAML configs that define a full team — players, instructions, schedules — and recruit them all in one command |
| ⏰ **Scheduling** | One-shot and recurring message schedules with fan-out, bounds, and failure notifications |
| 🎭 **Player Types** | Reusable agent definitions (composer, soloist, critic, etc.) with shipped examples and three-tier lookup |
| 🌐 **Cross-machine** | Any session that can reach your Temporal server can join the ensemble |

## Installation

```bash
npm install -g claude-tempo
```

### Prerequisites

- [Node.js](https://nodejs.org/) 18+
- [Temporal CLI](https://docs.temporal.io/cli) (for local dev server)
- [Claude Code](https://claude.ai/code)

## Quick start

One command handles everything:

```bash
cd your-project
claude-tempo up
```

This will:

1. Check that Temporal CLI is installed
2. Start the Temporal dev server (data persists in `~/.claude-tempo/`)
3. Register required search attributes
4. Register the claude-tempo MCP server (globally by default)
5. Launch a conductor session in a new terminal window

Then add players:

```bash
claude-tempo start          # open a player session
claude-tempo status         # see who's active
```

Or ask the conductor to `recruit` players for you from inside Claude Code.

### Manual setup

For more control, run each step individually:

```bash
# Start Temporal dev server (keep running)
claude-tempo server

# Register claude-tempo MCP server (globally by default)
cd your-project
claude-tempo init

# Verify everything is ready
claude-tempo preflight

# Start a conductor
claude-tempo conduct

# Add players
claude-tempo start
```

## Core concepts

- **Player** — A Claude Code session registered as a Temporal workflow
- **Conductor** — An optional orchestration hub connected to external interfaces (one per ensemble)
- **Ensemble** — A named group of players that can see and message each other, isolated from other ensembles
- **Cue** — A message sent to a player by name via Temporal signal

Players in one ensemble cannot see or message players in another. By default, sessions join the `default` ensemble:

```bash
claude-tempo conduct frontend     # conduct the "frontend" ensemble
claude-tempo start backend        # join the "backend" ensemble
claude-tempo conduct              # conduct the "default" ensemble
```

## MCP tools

These tools are available inside Claude Code sessions connected to claude-tempo:

| Tool | Description |
|------|-------------|
| `ensemble` | Discover active sessions. Scope: `machine`, `repo`, or `all`. |
| `cue` | Send a message to a player by name. Delivered instantly via Temporal signal. |
| `set_name` | Set a human-readable name for this session. |
| `set_part` | Describe what you're working on. Visible to others via `ensemble`. |
| `listen` | Manually check for pending messages. |
| `recruit` | Spawn a new Claude Code session in a directory. Can recruit a conductor with `conductor: true`. |
| `report` | Send updates to the conductor. No-op if no conductor exists. |
| `stop` | Stop a player session by name. |
| `schedule` | Create a one-shot or recurring schedule to cue a player. |
| `unschedule` | Cancel a named schedule. |
| `schedules` | List all active schedules. |
| `who_am_i` | Get your identity, role, player type, and session details. |
| `agent_types` | List available player types with name, description, and source. |
| `save_lineup` | Save the current ensemble as a YAML lineup (conductor only). |
| `load_lineup` | Load a lineup to recruit players and create schedules. |
| `broadcast` | Send a message to all active players. Optional `type` filter limits to a specific player type. |
| `encore` | Revive a stale player session — restarts the process and reconnects to the existing workflow with context restored. |
| `recall` | Read your own message history. Shows received messages by default; pass `includeSent: true` for the full timeline. |

## Scheduling

Players can set up schedules to send messages on timers — useful for periodic checks, reminders, and recurring coordination.

Three tools are available:
- **`schedule`** — Create a named schedule (one-shot or recurring)
- **`unschedule`** — Remove a schedule by name
- **`schedules`** — List all active schedules

### Examples

Tell your session things like:

- *"Schedule a check every hour called 'deploy-watch' — cue ops to check deployment status"*
- *"Remind me in 30 minutes to review PR #42"*
- *"Every 5 minutes for the next hour, ping frontend to check their progress"*
- *"Set up a daily standup reminder at 9am UTC for the conductor"*
- *"Cancel the deploy-watch schedule"*
- *"Show me all active schedules"*

Schedules support one-shot delays, fixed times, and recurring intervals with optional bounds (max count or end time).

### How it works

- Scheduled messages arrive with a `[scheduled: name]` prefix so recipients can distinguish them from direct cues
- The `from` field is set to the schedule creator, so replies go to the right person
- If the target player is gone when a schedule fires, the creator is notified so they can re-recruit if needed. Falls back to notifying the conductor if the creator is also unavailable
- Messages include `isScheduled` metadata for dashboard integrations
- `claude-tempo status` shows active schedules alongside sessions
- A single durable scheduler workflow per ensemble manages all schedules using Temporal timers

## Ensemble Lineups

Define reusable ensemble configurations as YAML files. A lineup specifies which players to recruit, what instructions to give them, what schedules to create, and optionally which custom agent files to use.

### Example lineup

```yaml
name: my-project
conductor:
  instructions: "Coordinate the frontend and backend teams"
players:
  - name: frontend
    workDir: /repos/my-app
    instructions: "Build the React dashboard in src/components"
  - name: backend
    workDir: /repos/my-api
    instructions: "Implement the REST endpoints in src/routes"
  - name: ops
    workDir: /repos/infra
    agent: agents/ops-agent.md
    instructions: "Monitor deployments and run health checks"
schedules:
  - name: status-check
    message: "Report your current progress and any blockers"
    target: all
    every: 30m
  - name: deploy-reminder
    message: "Check if the staging deploy succeeded"
    target: ops
    delay: 10m
```

### Three ways to use lineups

1. **From the CLI** — load a lineup when starting an ensemble:

   ```bash
   claude-tempo up --lineup my-lineup.yaml
   ```

2. **From inside a session** — use the `load_lineup` tool:

   *"Load the lineup from ~/.claude-tempo/ensembles/my-project.yaml"*

3. **Save the current state** — snapshot a running ensemble as a lineup (conductor only):

   *"Save this ensemble as a lineup called my-project"*

### Natural language examples

Tell your session things like:

- *"Load the my-project lineup"*
- *"Save this ensemble as a lineup"*
- *"Load the lineup from /repos/configs/team.yaml"*

### Fan-out schedules

Use `target: "all"` in a schedule to deliver a message to every active player (excluding the conductor). This is useful for periodic status checks or broadcast announcements:

- *"Schedule a message every 30 minutes to all players asking for a progress update"*

### Custom agents

The `agent` field on a player can be a path to a `.md` file that will be used as the session's system prompt via `--system-prompt`. This lets you create specialized agents with domain-specific instructions:

```yaml
players:
  - name: security-reviewer
    workDir: /repos/my-app
    agent: agents/security-review.md
    instructions: "Review the latest PR for security issues"
```

## Player Types

Player types are reusable agent definitions in Claude Code's standard subagent format — `.md` files with YAML frontmatter specifying name, description, and optional model. They let you define specialized roles once and reuse them across lineups.

### How player types work

Reference a type by name in a lineup's `type` field:

```yaml
players:
  - name: arch
    type: tempo-composer
  - name: eng
    type: tempo-soloist
```

When a player is recruited with a type, the agent definition is resolved and passed to the session. Players know their type via the `who_am_i` tool.

### Three-tier lookup

Player types are resolved in order (first match wins):

1. **Project** — `.claude/agents/` in the project directory
2. **User** — `~/.claude/agents/` in the user's home directory
3. **Shipped** — `examples/agents/` bundled with claude-tempo

Project and user types are resolved natively by Claude Code via `--agent <name>`. Shipped types fall back to `--system-prompt <path>`.

### Shipped player types

| Type | Description |
|------|-------------|
| `tempo-conductor` | Orchestrates the ensemble — breaks down tasks, delegates to players, tracks progress |
| `tempo-composer` | Software architect — designs system structure, defines interfaces, makes technology decisions |
| `tempo-soloist` | Senior engineer — implements features, fixes bugs, writes tests, delivers working code |
| `tempo-tuner` | QA engineer — designs test strategies, finds bugs, validates edge cases |
| `tempo-critic` | Code reviewer — evaluates changes for correctness, security, performance, maintainability |
| `tempo-roadie` | DevOps engineer — manages CI/CD, deployments, infrastructure, environment configuration |
| `tempo-improv` | Researcher and explorer — investigates unknowns, runs spikes, evaluates options |
| `tempo-liner` | Documentation specialist — owns README, CHANGELOG, CLAUDE.md, and PR descriptions |

### Shipped lineups

| Lineup | Description |
|--------|-------------|
| `tempo-big-band` | Full-lifecycle ensemble with all 8 player types — design, implement, test, review, and ship |
| `tempo-dev-team` | Feature development — conductor, composer, two soloists, and a tuner |
| `tempo-review-squad` | Three critics with different focus areas for thorough parallel code review |
| `tempo-jam-session` | Exploratory ensemble for spikes, research, and problems where the path is unclear |

### Discovery

Use the `agent_types` MCP tool inside a session or the CLI:

```bash
claude-tempo agent-types list          # show available types
claude-tempo agent-types show <name>   # print full definition
claude-tempo agent-types init          # copy shipped examples to ~/.claude/agents/
```

## Conductors

A **conductor** is an optional special player that acts as an orchestration hub. Use one when you want:

- A single session coordinating work across multiple players
- External access to the ensemble via Discord, Telegram, or any Temporal client
- A central point for players to `report` progress, blockers, and questions

Without a conductor, players work fine peer-to-peer — they discover each other via `ensemble` and communicate via `cue`.

```bash
claude-tempo conduct                # default ensemble
claude-tempo conduct my-project     # named ensemble
```

### External access

The conductor's Temporal workflow exposes a signal/query API:

```typescript
import { Client } from '@temporalio/client';

const client = new Client();
const conductor = client.workflow.getHandle('claude-session-default-conductor');

// Send a command
await conductor.signal('command', {
  text: 'recruit /repos/api and run tests',
  source: 'cli',
});

// Check history
const history = await conductor.query('history');
```

Connect external channel plugins (e.g., Discord):

```bash
CLAUDE_TEMPO_CONDUCTOR=true claude \
  --channels plugin:discord@claude-plugins-official \
  --dangerously-skip-permissions --dangerously-load-development-channels server:claude-tempo
```

## Players

### Starting players

```bash
# Terminal 1 — conductor
claude-tempo conduct my-project

# Terminal 2 — frontend
claude-tempo start my-project -n frontend

# Terminal 3 — backend
claude-tempo start my-project -n backend
```

Or let the conductor `recruit` players — this spawns new terminal windows automatically.

Inside a session, try:
- "Show me the ensemble" — discovers other sessions
- "Set your name to 'frontend'" — human-readable name
- "Cue frontend: what are you working on?" — sends a message

### Session naming

Sessions start with a random 8-character hex ID. Set a name at launch with `-n` or use `set_name` inside a session.

- Names are stored in workflow metadata and discoverable via metadata queries. Search attributes are also set for Temporal UI visibility.
- Other players use names to send messages via `cue`
- `recruit` automatically tells new sessions to set their name
- Names must be unique within an ensemble
- Names must contain only letters, numbers, hyphens, and underscores
- The name "conductor" is reserved for conductor sessions

### Session status lifecycle

Each session has a status that tracks its connection state:

| Status | Meaning |
|--------|---------|
| `pending` | Workflow created by `recruit`, but the Claude Code process hasn't connected yet |
| `active` | Session is running and responsive |
| `stale` | Messages have gone undelivered for 3+ minutes — the session is likely disconnected |

Status transitions:
- **`pending` → `active`** — when the spawned session connects and sends its `updateMetadata` signal
- **`active` → `stale`** — when undelivered messages exceed the stale threshold (3 minutes)
- Any status → **terminated** — on graceful shutdown or `stop`

`claude-tempo status` shows `(pending)` and `(stale)` indicators next to player names. The `ClaudeTempoStatus` search attribute is also set, so you can filter sessions by status in the Temporal UI (e.g., `ClaudeTempoStatus = "stale"`).

### Terminal support

`recruit` and the CLI detect your terminal automatically:

| Terminal | macOS | Linux | Windows |
|----------|-------|-------|---------|
| Ghostty | ✓ | — | — |
| iTerm2 | ✓ | — | — |
| Terminal.app | ✓ | — | — |
| gnome-terminal | — | ✓ | — |
| konsole / xterm | — | ✓ | — |
| Windows Terminal | — | — | ✓ (tabs) |
| cmd.exe / PowerShell | — | — | ✓ |

macOS terminals preserve the full shell environment (fish, zsh, bash) including node version managers (fnm, nvm).

Windows Terminal is detected automatically via the `WT_SESSION` environment variable. When running inside Windows Terminal, recruited sessions open as new tabs (with the player name as the tab title) instead of separate cmd.exe windows.

## CLI reference

```
claude-tempo <command> [options]
```

### Commands

| Command | Description |
|---------|-------------|
| `up [ensemble]` | First-time setup: start Temporal, configure MCP, launch conductor. Use `--lineup` to load a lineup. |
| `down` | Stop Temporal, terminate sessions, remove MCP config. Use `--keep-mcp` to preserve MCP config. |
| `server` | Start the Temporal dev server and register search attributes |
| `conduct [ensemble]` | Start a conductor session (one per ensemble). Use `--resume` or `--replace` if one exists. |
| `start [ensemble]` | Start a player session |
| `status [ensemble]` | Show active sessions and Temporal health |
| `config` | Configure Temporal connection settings (interactive or `set`/`show`) |
| `stop [ensemble]` | Stop sessions (`-n <name>` for one, `--all` for everything) |
| `init` | Register claude-tempo MCP server globally (`--project` for per-directory) |
| `preflight` | Run environment checks |
| `ensemble <sub>` | Manage saved lineups (`save`, `list`, `show`) |
| `agent-types <sub>` | Manage player types (`list`, `show <name>`, `init`) |
| `version` | Print the installed version |
| `help` | Show usage info |

### Global options

```
--temporal-address <addr>     Temporal server address (default: localhost:7233)
--temporal-namespace <ns>     Temporal namespace (default: default)
--temporal-api-key <key>      Temporal Cloud API key
--temporal-tls-cert <path>    mTLS client certificate path
--temporal-tls-key <path>     mTLS client key path
-n, --name <name>             Set the player name (start/conduct/up)
--agent <claude|copilot>      Agent backend to use (default: claude)
--skip-preflight              Skip preflight checks (start/conduct)
-d, --dir <path>              Target directory (default: cwd)
--background                  Run Temporal in background (server only)
--keep-mcp                    Preserve MCP config when tearing down (down only)
--lineup <name|file>          Load an ensemble lineup by name or file path (up only)
--resume                      Resume an existing conductor session (conduct only)
--replace                     Stop existing conductor and start fresh (conduct only)
-v, --version                 Print version and exit
```

### `claude-tempo up`

The recommended way to get started:

```
$ claude-tempo up myband

claude-tempo setup
  ✓ temporal CLI installed
  … Starting Temporal dev server...
  ✓ Temporal started (pid 12345, data in ~/.claude-tempo/)
  ✓ Registered search attributes
  ✓ .mcp.json created

Launching conductor in ensemble myband...

✓ You're all set!
  Conductor launched (pid 12346)
  Ensemble: myband

  What next?
  claude-tempo start myband    Add a player session
  claude-tempo status myband   See who's active
  Or ask the conductor to recruit players for you
```

### `claude-tempo server`

Starts the Temporal dev server with automatic search attribute registration:

```bash
claude-tempo server                 # foreground (Ctrl+C to stop)
claude-tempo server --background    # daemonize
```

Data persists in `~/.claude-tempo/temporal-data.db`. If Temporal is already running, registers attributes and exits.

### `claude-tempo status`

Shows all active sessions:

```
Ensemble: myband
  3 active sessions

  conductor (conductor)
    Orchestrating the team
    /Users/me/projects/app  main  my-machine.local

  alice
    Building the REST endpoints
    /Users/me/projects/app  feat/api  my-machine.local

  bob (pending)
    Working on the dashboard
    /Users/me/projects/app  feat/ui  my-machine.local

  1 active schedule
  deploy-watch → ops | every 1h | next: 3:00:00 PM
```

### `claude-tempo preflight`

Verifies your environment: Node.js >= 18, Temporal reachable, `claude` on PATH, `claude-tempo-server` on PATH, `.mcp.json` configured.

### `claude-tempo init`

Registers the claude-tempo MCP server globally so it's available in every Claude Code session:

```bash
claude-tempo init             # global install (recommended)
claude-tempo init --project   # per-directory .mcp.json instead
```

If the `claude` CLI is not available, falls back to creating `.mcp.json` in the current directory.

### `claude-tempo down`

Stops Temporal, terminates all sessions, and removes MCP config:

```bash
claude-tempo down              # full teardown
claude-tempo down --keep-mcp   # stop Temporal and sessions, but preserve MCP config
```

## Configuration

Run `claude-tempo config` to save Temporal connection settings so you don't need flags or env vars every time:

```
$ claude-tempo config

? Temporal address (localhost:7233): my-ns.tmprl.cloud:7233
? Temporal namespace (default): my-ns.abc123
? Auth method: (None / API key / mTLS)
? API key: ****
Saved to ~/.claude-tempo/config.json
✓ Connected successfully
```

Settings are stored in `~/.claude-tempo/config.json`. You can also set values non-interactively:

```bash
claude-tempo config set temporalAddress my-ns.tmprl.cloud:7233
claude-tempo config set temporalNamespace my-ns.abc123
claude-tempo config set temporalApiKey tcl_...
claude-tempo config show
```

### Resolution order

Settings are resolved in this order (first match wins):

1. CLI flags (`--temporal-address`, `--temporal-namespace`, etc.)
2. Environment variables (`TEMPORAL_ADDRESS`, `TEMPORAL_NAMESPACE`, etc.)
3. claude-tempo config file (`~/.claude-tempo/config.json`)
4. Temporal CLI config (`~/.config/temporalio/temporal.yaml`) — if you've already configured the Temporal CLI, claude-tempo reads it automatically
5. Defaults (`localhost:7233`, `default` namespace)

### Temporal Cloud

For Temporal Cloud, run `claude-tempo config` and provide your cloud address, namespace, and API key. Or set them as environment variables in CI:

```bash
export TEMPORAL_ADDRESS=my-ns.abc123.tmprl.cloud:7233
export TEMPORAL_NAMESPACE=my-ns.abc123
export TEMPORAL_API_KEY=tcl_...
```

## Environment variables

| Variable | Default | Description |
|----------|---------|-------------|
| `TEMPORAL_ADDRESS` | `localhost:7233` | Temporal server address |
| `TEMPORAL_NAMESPACE` | `default` | Temporal namespace |
| `TEMPORAL_API_KEY` | *(none)* | Temporal Cloud API key |
| `TEMPORAL_TLS_CERT_PATH` | *(none)* | mTLS client certificate path |
| `TEMPORAL_TLS_KEY_PATH` | *(none)* | mTLS client key path |
| `CLAUDE_TEMPO_TASK_QUEUE` | `claude-tempo` | Task queue name |
| `CLAUDE_TEMPO_ENSEMBLE` | `default` | Ensemble name |
| `CLAUDE_TEMPO_CONDUCTOR` | `false` | Enable conductor mode |
| `CLAUDE_TEMPO_PLAYER_NAME` | *(random hex)* | Player name on startup |
| `CLAUDE_TEMPO_DEFAULT_AGENT` | `claude` | Default agent type (`claude` or `copilot`) |

## Stale session cleanup

When a session crashes or closes without graceful shutdown, Temporal detects it automatically:

- If a message to a dead session remains undelivered for **3 minutes**, the workflow self-completes
- Before exiting, it notifies the conductor with the undelivered message so work can be reassigned
- Idle sessions with no pending messages are probed after 1 hour of inactivity via a heartbeat ping; if the ping goes undelivered, the session self-completes

No manual cleanup needed — `cue` a dead player and the system handles the rest.

## Copilot CLI integration (experimental)

> **Warning:** Copilot bridge support is experimental and subject to breaking changes.

GitHub Copilot CLI sessions can join an ensemble via the Copilot bridge. Bridge sessions are headless — they require a conductor or another player to receive work via `cue`.

<details>
<summary>Setup and usage</summary>

### Prerequisites

- [GitHub Copilot CLI](https://docs.github.com/en/copilot/github-copilot-in-the-cli) installed and authenticated
- An active GitHub Copilot subscription
- Node.js 20+
- Install the Copilot SDK: `npm install @github/copilot-sdk`

### Starting Copilot sessions

Use `--agent copilot` with any session-launching command:

```bash
claude-tempo start myband --agent copilot -n copilot-1      # start a player
claude-tempo conduct myband --agent copilot                  # start a conductor
claude-tempo up myband --agent copilot                       # full setup
```

Or recruit from within any active session:

> "Recruit a copilot session named 'copilot-dev' in /repos/my-project with agent copilot"

### Setting a default agent

To avoid passing `--agent copilot` every time:

```bash
claude-tempo config set default-agent copilot
```

Or via environment variable:

```bash
export CLAUDE_TEMPO_DEFAULT_AGENT=copilot
```

Resolution order: `--agent` flag → `CLAUDE_TEMPO_DEFAULT_AGENT` env → config file → `claude`.

### Model override

Set `COPILOT_BRIDGE_MODEL` to use a specific model for Copilot sessions:

```bash
COPILOT_BRIDGE_MODEL=gpt-4o claude-tempo start myband --agent copilot
```

### Limitations

- Headless only — bridge sessions respond to cues, no interactive terminal
- ~2-second polling latency (vs instant for Claude Code sessions)
- `@github/copilot-sdk` adds ~243MB to node_modules
- Node 20+ required (rest of claude-tempo works on Node 18+)

</details>

## Development

```bash
git clone https://github.com/vinceblank/claude-tempo.git
cd claude-tempo && npm install

npm run build        # compile TypeScript + pre-bundle workflows
npm test             # run tests
npm link             # link CLI for local testing
```

> **Important**: Run `npm run build` after changing workflow code (`src/workflows/`). The build pre-bundles workflows into `workflow-bundle.js` so all workers use identical code.

## Contributing

See [CLAUDE.md](CLAUDE.md) for project structure, key concepts, and development setup. Pull requests are welcome — please run `npm test` before submitting.

## Known limitations

- **`recruit` requires manual acknowledgment** — Recruited sessions use `--dangerously-load-development-channels`. Claude Code shows a confirmation prompt that must be manually acknowledged in the spawned terminal. This will be resolved once claude-tempo is published as an approved channel plugin. Copilot bridge sessions do not have this limitation.

## License

MIT
