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

## Why claude-tempo?

- **Crash-safe durability** — Sessions are Temporal workflows. Crashes, restarts, and network blips don't lose messages or drop coordination state. Dead sessions are detected automatically and the conductor is notified.
- **Instant signaling** — Temporal signals deliver messages with no polling. Players receive cues the moment they're sent, regardless of which machine they're on.
- **Built-in scheduling** — Set up one-shot or recurring message schedules without any external infrastructure. Fan-out to all players at once for periodic status checks.
- **Extensible agent types** — Define reusable player roles as `.md` files. Ship lineups that assemble entire teams in one command. Mix Claude Code and Copilot CLI sessions in the same ensemble.

## Installation

```bash
npm install -g claude-tempo
```

**Prerequisites:** [Node.js](https://nodejs.org/) 18+, [Temporal CLI](https://docs.temporal.io/cli), [Claude Code](https://claude.ai/code)

## Quick Start

One command handles everything:

```bash
cd your-project
claude-tempo up
```

This starts the Temporal dev server, registers the MCP server globally, starts the worker daemon, and launches a conductor session in a new terminal.

Then add players:

```bash
claude-tempo start          # open a player session
claude-tempo status         # see who's active
```

Or ask the conductor to `recruit` players for you from inside Claude Code.

### Manual setup

For more control, run each step individually:

```bash
claude-tempo server         # start Temporal dev server (keep running)
claude-tempo init           # register MCP server globally
claude-tempo preflight      # verify environment
claude-tempo conduct        # start a conductor
claude-tempo start          # add players
```

### Basic MCP usage

Inside any Claude Code session connected to claude-tempo:

- "Show me the ensemble" — discover other sessions
- "Set your name to 'frontend'" — set a human-readable name
- "Cue backend: what are you working on?" — send a message to another player
- "Recruit a soloist in /repos/api" — spawn a new player session

📖 **[Full documentation](docs/README.md)**

## Core Concepts

Each Claude Code session registers as a **player** in Temporal. Players discover each other with `ensemble`, exchange messages with `cue`, and coordinate work across machines. An optional **conductor** orchestrates the group and connects to external interfaces. All players in the same **ensemble** can see and message each other; ensembles are isolated from each other.

```bash
claude-tempo conduct frontend   # conduct the "frontend" ensemble
claude-tempo start backend      # join the "backend" ensemble
```

## What You Can Do

### Terminal UI

Run `claude-tempo` (no arguments) to launch the built-in TUI — a chat-focused shell for managing your ensemble without leaving the terminal.

```bash
claude-tempo                        # launch TUI (multi-ensemble view)
claude-tempo tui --ensemble myteam  # connect directly to an ensemble
```

Inside the TUI, type `/help` to see all available slash commands: `/cue`, `/broadcast`, `/recruit`, `/stop`, `/encore`, `/recall`, `/search`, `/players`, `/schedule`, `/gates`, `/stages`, `/worktree`, and more. See [docs/dashboard.md](docs/dashboard.md) for the full TUI reference.

### Scheduling

Send messages on a delay, at a fixed time, on a recurring interval, or via cron expression:

```bash
# From inside Claude Code (via MCP tools)
schedule: { name: "standup", cron: "0 9 * * 1-5", target: "conductor", message: "Daily standup" }
```

Supports `delay`, `at`, `every`, and `cron` with optional IANA timezone. See [docs/scheduling.md](docs/scheduling.md).

### Lineups

Define your entire ensemble as a YAML file and bootstrap it in one command:

```bash
claude-tempo up --lineup lineups/dev-team.yml
```

Shipped lineups: `tempo-big-band` (full lifecycle), `tempo-dev-team` (feature work), `tempo-review-squad` (parallel review), `tempo-jam-session` (exploration). See [docs/ensembles.md](docs/ensembles.md).

### Orchestration

Conductors can track parallel work with **Quality Gates**, **Pipeline Stages**, and **Git Worktrees**:

- **Quality Gates** — named checklists of criteria; auto-aggregate to `passed`/`failed`/`open`
- **Pipeline Stages** — fan-out/fan-in tracking; conductor is notified when all players report
- **Git Worktrees** — provision isolated branches for players; clean up when done

See [docs/orchestration.md](docs/orchestration.md).

## Command Discovery

```bash
claude-tempo --help          # all CLI commands
claude-tempo <command> --help # flags for a specific command
```

Inside the TUI, type `/help` for slash commands. Inside Claude Code, use the `ensemble` tool to see who's active and explore from there.

### Key commands

**Session management**
| Command | Description |
|---------|-------------|
| `claude-tempo up` | Start everything (Temporal + daemon + conductor) |
| `claude-tempo start [ensemble]` | Open a player session |
| `claude-tempo conduct [ensemble]` | Start a conductor session |
| `claude-tempo status` | Show active sessions |
| `claude-tempo down` | Stop everything |

**Lineups**
| Command | Description |
|---------|-------------|
| `claude-tempo up --lineup <file>` | Bootstrap from a lineup YAML |
| `claude-tempo ensemble save <name>` | Save current ensemble as a lineup |
| `claude-tempo ensemble list` | List saved lineups |

**Player types**
| Command | Description |
|---------|-------------|
| `claude-tempo agent-types list` | List available player types |
| `claude-tempo agent-types show <name>` | Show a player type definition |
| `claude-tempo agent-types init <name>` | Create a new player type |

**Infrastructure**
| Command | Description |
|---------|-------------|
| `claude-tempo daemon start\|stop\|status\|logs` | Manage the worker daemon |
| `claude-tempo upgrade [version]` | Graceful self-update (stops daemon, installs, restarts) |
| `claude-tempo config` | Configure env vars interactively |
| `claude-tempo preflight` | Verify environment |

See [docs/cli.md](docs/cli.md) for the full CLI reference including all flags and examples.

## Maestro Dashboard

The [Maestro dashboard](https://github.com/vinceblank/maestro) is a web UI that connects to your Temporal server and provides a live view of your ensemble — player status, event log, and command input. See [docs/dashboard.md](docs/dashboard.md).

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

## License

MIT
