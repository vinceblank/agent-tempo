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

Each session registers as a **player** in Temporal. Players discover each other with `ensemble`, send messages with `cue`, and coordinate via a **conductor** that connects to external interfaces like Discord, Telegram, or the built-in TUI.

📖 **[Full documentation](docs/README.md)**

## Why claude-tempo?

- **Crash-safe durability** — Sessions are Temporal workflows. Crashes, restarts, and network blips don't lose messages or drop coordination state.
- **Instant signaling** — Temporal signals deliver messages with no polling. Players receive cues the moment they're sent, regardless of which machine they're on.
- **Built-in scheduling** — One-shot and recurring message schedules without any external infrastructure.
- **Extensible agent types** — Define reusable player roles as `.md` files. Ship lineups that assemble entire teams in one command.

## Features

| | |
|---|---|
| 🔁 **Ensemble Lineups** | YAML configs that define a full team and recruit them all in one command |
| ⏰ **Scheduling** | One-shot and recurring message schedules with fan-out and failure notifications |
| 🎭 **Player Types** | Reusable agent definitions with 8 shipped types and three-tier lookup |
| 🖥️ **Terminal UI** | Chat-focused TUI with slash commands, overlays, and interactive wizards |
| 🌐 **Cross-machine** | Any session that can reach your Temporal server can join the ensemble |
| 🤖 **Copilot bridge** | Mix Claude Code and GitHub Copilot CLI sessions in the same ensemble |

## Installation

```bash
npm install -g claude-tempo
```

**Prerequisites**: [Node.js](https://nodejs.org/) 18+, [Temporal CLI](https://docs.temporal.io/cli), [Claude Code](https://claude.ai/code)

## Quick Start

One command handles everything:

```bash
cd your-project
claude-tempo up
```

This starts Temporal, registers the MCP server, launches the daemon, and opens a conductor session. Then add players:

```bash
claude-tempo start          # open a player session
claude-tempo status         # see who's active
```

Or ask the conductor to `recruit` players from inside Claude Code.

### Manual setup

```bash
claude-tempo server         # start Temporal dev server
claude-tempo init           # register MCP server globally
claude-tempo preflight      # verify environment
claude-tempo conduct        # start a conductor
claude-tempo start          # start a player
```

## Upgrading

```bash
claude-tempo upgrade
```

Stops the daemon, installs the latest version, and restarts automatically. To upgrade to a specific version:

```bash
claude-tempo upgrade 0.22.0
```

## Stopping & Tear Down

```bash
# Stop all sessions in an ensemble
claude-tempo stop my-ensemble --all

# Tear down an ensemble (stops all sessions + scheduler)
claude-tempo down my-ensemble

# Stop the background daemon
claude-tempo daemon stop
```

📖 [Full CLI reference → docs/cli.md](docs/cli.md)

---

## Core Concepts

- **Player** — A Claude Code session registered as a Temporal workflow
- **Conductor** — An optional orchestration hub (one per ensemble); receives `report` calls and connects to external interfaces
- **Ensemble** — A named group of players isolated from other ensembles; defaults to `default`
- **Cue** — A message sent to a player by name via Temporal signal
- **Lineup** — A YAML file that defines a full team and recruits them in one step
- **Player Type** — A reusable agent definition (`.md` with YAML frontmatter) that gives a player a named role

Players in one ensemble cannot see or message players in another:

```bash
claude-tempo conduct frontend   # conduct the "frontend" ensemble
claude-tempo start backend      # join the "backend" ensemble
```

## MCP Tools

Tools available inside Claude Code sessions connected to claude-tempo:

| Tool | Description |
|------|-------------|
| `ensemble` | Discover active sessions |
| `cue` | Send a message to a player by name |
| `recruit` | Spawn a new Claude Code session |
| `report` | Send updates to the conductor |
| `broadcast` | Send a message to all active players |
| `recall` | Read your own message history |
| `who_am_i` | Get your identity, role, and player type |

📖 [Full tools reference → docs/tools.md](docs/tools.md) (includes `schedule`, `stage`, `quality_gate`, `worktree`, and all others)

## CLI

```bash
claude-tempo up [ensemble]      # first-time setup
claude-tempo conduct [ensemble] # start a conductor
claude-tempo start [ensemble]   # start a player
claude-tempo status [ensemble]  # list active sessions
claude-tempo tui                # open the terminal UI
claude-tempo daemon <sub>       # manage the worker daemon
claude-tempo upgrade            # update to latest
```

Run `claude-tempo --help` or `claude-tempo <command> --help` for all flags.

📖 [Full CLI reference → docs/cli.md](docs/cli.md)

## Ensemble Lineups

Define reusable team configurations as YAML files and load them in one command:

```yaml
name: my-project
conductor:
  instructions: "Coordinate the frontend and backend teams"
players:
  - name: frontend
    type: tempo-soloist
    workDir: /repos/my-app
    instructions: "Build the React dashboard"
  - name: backend
    type: tempo-soloist
    workDir: /repos/my-api
    instructions: "Implement the REST endpoints"
schedules:
  - name: status-check
    message: "Report your current progress"
    target: all
    every: 30m
```

```bash
claude-tempo up --lineup my-project.yaml   # load from CLI
```

Or from inside a session: *"Load the my-project lineup"*

📖 [Lineups, player types, and shipped examples → docs/ensembles.md](docs/ensembles.md)

## Player Types

Player types are reusable agent definitions — `.md` files with YAML frontmatter. Reference them by name in lineups:

```yaml
players:
  - name: arch
    type: tempo-composer
  - name: eng
    type: tempo-soloist
```

Eight types ship out of the box: `tempo-conductor`, `tempo-composer`, `tempo-soloist`, `tempo-tuner`, `tempo-critic`, `tempo-roadie`, `tempo-improv`, `tempo-liner`. Four lineup presets are included: `tempo-big-band`, `tempo-dev-team`, `tempo-review-squad`, `tempo-jam-session`.

```bash
claude-tempo agent-types list   # discover available types
claude-tempo agent-types init   # copy shipped types to ~/.claude/agents/
```

📖 [Player types deep dive → docs/ensembles.md](docs/ensembles.md)

## Configuration

```bash
claude-tempo config   # interactive setup (Temporal address, namespace, API key)
```

Settings persist in `~/.claude-tempo/config.json`. Resolution order: CLI flags → env vars → config file → Temporal CLI config → defaults.

Key environment variables:

| Variable | Default | Description |
|----------|---------|-------------|
| `TEMPORAL_ADDRESS` | `localhost:7233` | Temporal server address |
| `TEMPORAL_NAMESPACE` | `default` | Temporal namespace |
| `TEMPORAL_API_KEY` | *(none)* | Temporal Cloud API key |
| `CLAUDE_TEMPO_ENSEMBLE` | `default` | Ensemble name |

📖 [Full configuration reference → docs/configuration.md](docs/configuration.md)

## Terminal UI

```bash
claude-tempo tui                          # multi-ensemble home screen
claude-tempo tui --ensemble my-ensemble   # direct ensemble mode
```

The TUI provides a chat-focused shell for managing your ensemble:

- **Ensemble chat feed** — live aggregated view of conductor + player traffic; type bare text to message the conductor, `@player message` to message directly
- **Slash commands** — `/recruit`, `/status`, `/schedule`, `/gates`, `/stages`, `/worktree`, and more; type `/help` for the full list
- **Interactive overlays and wizards** — step-by-step flows for recruiting players, creating schedules, and managing ensembles

📖 [TUI reference → docs/dashboard.md](docs/dashboard.md)

## Copilot Integration

> **Experimental** — subject to breaking changes.

GitHub Copilot CLI sessions can join an ensemble using `--agent copilot`:

```bash
claude-tempo start myband --agent copilot -n copilot-1
```

📖 [Copilot bridge setup and limitations → docs/copilot.md](docs/copilot.md)

## Worker Daemon

The daemon runs Temporal workers as a background process — it starts automatically on first use. Manage it explicitly with `claude-tempo daemon start|stop|status|logs`.

📖 [Daemon reference → docs/daemon.md](docs/daemon.md)

## Development

```bash
git clone https://github.com/vinceblank/claude-tempo.git
cd claude-tempo && npm install

npm run build   # compile TypeScript + pre-bundle workflows
npm test        # run tests
npm link        # link CLI for local testing
```

> **Important**: Run `npm run build` after changing workflow code (`src/workflows/`). The build pre-bundles workflows into `workflow-bundle.js` so all workers use identical code.

## Contributing

See [CLAUDE.md](CLAUDE.md) for project structure, conventions, and development setup. Pull requests welcome — run `npm test` before submitting.

## Known Limitations

- **`recruit` requires manual acknowledgment** — Recruited sessions show a Claude Code confirmation prompt that must be acknowledged in the spawned terminal. This will be resolved once claude-tempo is a published approved channel plugin. Copilot bridge sessions are not affected.

## License

MIT
