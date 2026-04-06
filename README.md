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

This will start the Temporal dev server, register the MCP server globally, start the worker daemon, and launch a conductor session in a new terminal.

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

## Core Concepts

Each Claude Code session registers as a **player** in Temporal. Players discover each other with `ensemble`, exchange messages with `cue`, and coordinate work across machines. An optional **conductor** orchestrates the group and connects to external interfaces. All players in the same **ensemble** can see and message each other; ensembles are isolated from each other. By default, sessions join the `default` ensemble.

```bash
claude-tempo conduct frontend   # conduct the "frontend" ensemble
claude-tempo start backend      # join the "backend" ensemble
```

## Full Documentation

| Doc | Description |
|-----|-------------|
| [docs/tools.md](docs/tools.md) | MCP tools reference |
| [docs/cli.md](docs/cli.md) | CLI command reference |
| [docs/scheduling.md](docs/scheduling.md) | Scheduling — one-shot, recurring, cron, fan-out |
| [docs/orchestration.md](docs/orchestration.md) | Quality Gates, Pipeline Stages, Git Worktrees |
| [docs/ensembles.md](docs/ensembles.md) | Lineups, Player Types, Agent Type Discovery |
| [docs/configuration.md](docs/configuration.md) | Configuration — env vars, config file, Temporal Cloud |
| [docs/copilot.md](docs/copilot.md) | Copilot CLI integration (experimental) |
| [docs/dashboard.md](docs/dashboard.md) | TUI Dashboard and Maestro web dashboard |
| [docs/daemon.md](docs/daemon.md) | Worker Daemon |
| [docs/troubleshooting.md](docs/troubleshooting.md) | Stale sessions, common issues, upgrade notes |
| [docs/WIRE-PROTOCOL.md](docs/WIRE-PROTOCOL.md) | Stable Temporal signal/query/update names |

## Maestro Dashboard

The [Maestro dashboard](https://github.com/vinceblank/maestro) is a web UI that connects to your Temporal server and provides a live view of your ensemble — player status, event log, and command input. See [docs/dashboard.md](docs/dashboard.md) for details.

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
