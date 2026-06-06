<p align="center">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="assets/logo-dark.svg">
    <source media="(prefers-color-scheme: light)" srcset="assets/logo-light.svg">
    <img alt="agent-tempo" src="assets/logo-light.svg" height="140">
  </picture>
</p>
<p align="center">
  <strong>Many agents, one tempo.</strong>
</p>
<p align="center">
  <a href="https://www.npmjs.com/package/agent-tempo"><img src="https://img.shields.io/npm/v/agent-tempo.svg" alt="npm version"></a>
  <a href="https://github.com/vinceblank/agent-tempo/actions/workflows/ci.yml"><img src="https://github.com/vinceblank/agent-tempo/actions/workflows/ci.yml/badge.svg" alt="CI"></a>
  <a href="LICENSE"><img src="https://img.shields.io/badge/license-MIT-blue.svg" alt="MIT License"></a>
</p>

Multiple Claude Code sessions discover each other, exchange messages in real time, and coordinate work — across machines, not just localhost.

Each session registers as a **player** in Temporal. Players discover each other with `ensemble`, send messages with `cue`, and coordinate via a **conductor** that connects to external interfaces like Discord, Telegram, or the built-in TUI.

📖 **[Full documentation](docs/README.md)**

## Why agent-tempo?

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
| ⏸️ **Hold / Pause / Resume** | Pre-warm a full team before delivering tasks; pause and resume mid-session |
| 🤖 **Headless adapters** | Copilot bridge, Claude API, OpenCode, Claude Code headless (`claude -p` — bills against your Claude Code subscription), and Pi AI (headless player or interactive conductor) — mix providers and headless agents in the same ensemble |

## Installation

```bash
npm install -g agent-tempo
# or without a global install:
npx agent-tempo
```

**Prerequisites**: [Node.js](https://nodejs.org/) 20 LTS, 22 LTS, or 24 LTS, [Temporal CLI](https://docs.temporal.io/cli), [Claude Code](https://claude.ai/code)

> **No-global-install path**: On first run, `agent-tempo` auto-provisions `~/.agent-tempo/bin/agent-tempo` so subsequent invocations don't need `npx`. If that directory isn't on your PATH, a one-time hint is printed to stderr with the exact export line to add to your shell profile.

## Quick Start

One command handles everything:

```bash
cd your-project
agent-tempo up
```

This starts Temporal, registers the MCP server, launches the daemon, and opens a conductor session. Then add players:

```bash
agent-tempo status         # see who's active
```

Or use the TUI to recruit players, or ask the conductor to `recruit` from inside Claude Code.

### Manual setup

```bash
agent-tempo server         # start Temporal dev server
agent-tempo init           # register MCP server globally
agent-tempo preflight      # verify environment
agent-tempo up             # launch conductor via auto-provisioning
```

## Upgrading

```bash
agent-tempo upgrade
```

Stops the daemon, installs the latest version, and restarts automatically. To upgrade to a specific version:

```bash
agent-tempo upgrade 0.22.0
```

## Stopping & Tear Down

```bash
# Terminate all sessions in an ensemble
agent-tempo destroy my-ensemble

# Tear down everything (all sessions, schedulers, and Maestro workflows)
agent-tempo down --all

# Tear down and terminate all workflows in one step
agent-tempo down --destroy -y

# Stop the background daemon
agent-tempo daemon stop
```

📖 [Full CLI reference → docs/cli.md](docs/cli.md)

---

## Core Concepts

- **Player** — A Claude Code session registered as a Temporal workflow
- **Conductor** — Required orchestration hub (one per ensemble); receives `report` calls and connects to external interfaces. Lineup schema enforces its presence.
- **Ensemble** — A named group of players isolated from other ensembles; defaults to `default`
- **Cue** — A message sent to a player by name via Temporal signal
- **Lineup** — A YAML file that defines a full team and recruits them in one step
- **Player Type** — A reusable agent definition (`.md` with YAML frontmatter) that gives a player a named role

Players in one ensemble cannot see or message players in another. Launch `agent-tempo` to open the TUI and switch between ensembles, or target a specific ensemble directly:

```bash
agent-tempo up frontend        # provision and launch conductor in "frontend"
agent-tempo up backend         # provision and launch conductor in "backend"
```

## MCP Tools

Tools available inside Claude Code sessions connected to agent-tempo:

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
agent-tempo                    # launch TUI (auto-provisions on first run)
agent-tempo up [ensemble]      # provision infrastructure and launch conductor
agent-tempo down [--destroy]   # tear down infrastructure (--destroy also terminates workflows)
agent-tempo status [ensemble]  # list active sessions
agent-tempo destroy <ensemble> # terminate all sessions in an ensemble
agent-tempo restore <ensemble> # restore orphaned sessions on this host
agent-tempo hosts              # list daemons polling this Temporal namespace (--all/--json)
agent-tempo recall <name>      # read a player's message history (--limit/--offset/--preview/--json)
agent-tempo attachment-info <name> # inspect a session's phase, holder, lease, and heartbeat age
agent-tempo release [ensemble] # release held players (unlock + deliver tasks)
agent-tempo daemon <sub>       # manage the worker daemon
agent-tempo upgrade            # update to latest
```

Run `agent-tempo --help` or `agent-tempo <command> --help` for all flags.

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
agent-tempo up --lineup my-project.yaml   # load from CLI
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

Eight types ship out of the box: `tempo-conductor`, `tempo-composer`, `tempo-soloist`, `tempo-tuner`, `tempo-critic`, `tempo-roadie`, `tempo-improv`, `tempo-liner`. Six lineup presets are included: `tempo-big-band`, `tempo-dev-team`, `tempo-review-squad`, `tempo-jam-session`, `tempo-mock-jam`, `tempo-headless-jam`.

```bash
agent-tempo agent-types list   # discover available types
agent-tempo agent-types init   # copy shipped types to ~/.claude/agents/
```

📖 [Player types deep dive → docs/ensembles.md](docs/ensembles.md)

## Configuration

```bash
agent-tempo config   # interactive setup (Temporal address, namespace, API key)
```

Settings persist in `~/.agent-tempo/config.json`. Resolution order: CLI flags → env vars → config file → Temporal CLI config → defaults.

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
agent-tempo tui                          # multi-ensemble home screen
agent-tempo tui --ensemble my-ensemble   # direct ensemble mode
```

The TUI provides a chat-focused shell for managing your ensemble:

- **Ensemble chat feed** — live aggregated view of conductor + player traffic; type bare text to message the conductor, `@player message` to message directly
- **Slash commands** — `/recruit`, `/status`, `/schedule`, `/gates`, `/stages`, `/worktree`, `/go` (release held), `/pause`, `/play`, `/shutdown`, `/restore`, `/home`, and more; type `/help` for the full list
- **Interactive overlays and wizards** — step-by-step flows for recruiting players, creating schedules, and managing ensembles

📖 [TUI reference → docs/tui.md](docs/tui.md)

## Copilot Integration

> **Experimental** — subject to breaking changes.

GitHub Copilot CLI sessions can join an ensemble using `--agent copilot`. Recruit one from the TUI:

```
/recruit copilot-1 --agent copilot
```

📖 [Copilot bridge setup and limitations → docs/copilot.md](docs/copilot.md)

## Pi AI Integration

Pi AI sessions can join an ensemble in two modes:

**Interactive conductor** — launch Pi in a real terminal with the agent-tempo extension auto-loaded:

```
agent-tempo up --agent pi --ensemble <name>
```

The Pi session self-bootstraps its Temporal workflow and attaches as a conductor or player. The `AGENT_TEMPO_*` environment is wired automatically. For power users, the underlying extension path is `dist/pi/extension.js` — invoke directly with `pi -e dist/pi/extension.js`.

From the TUI, `/recruit-conductor` relaunches the active ensemble's conductor — set `conductor.agent: pi` in that ensemble's lineup to make it a Pi conductor.

**Prerequisites:** `@earendil-works/pi-coding-agent` on Node ≥ 22.19. Recommended: `ANTHROPIC_API_KEY` (without it the session falls back to Pi's own auth/default model).

**Headless Pi players** — recruit as a background agent slot using `agent: 'pi'`. Pass `guardrailPolicy: 'monitored' | 'supervised' | 'observe-only'` to control the operator gate (default `'autonomous'` — no gate). See [docs/concepts.md](docs/concepts.md#command-center-and-player-supervision) for the gate mechanics and the supervised caveat.

📖 [Pi integration reference → docs/design/pi-hardening-h1-h2-h3.md](docs/design/pi-hardening-h1-h2-h3.md)

## Worker Daemon

The daemon runs Temporal workers as a background process — it starts automatically on first use. Manage it explicitly with `agent-tempo daemon start|stop|status|logs`.

📖 [Daemon reference → docs/daemon.md](docs/daemon.md)

## Development

```bash
git clone https://github.com/vinceblank/agent-tempo.git
cd agent-tempo && npm install

npm run build   # compile TypeScript + pre-bundle workflows
npm test        # run tests
npm link        # link CLI for local testing
```

> **Important**: Run `npm run build` after changing workflow code (`src/workflows/`). The build pre-bundles workflows into `workflow-bundle.js` so all workers use identical code.

## Contributing

See [CLAUDE.md](CLAUDE.md) for project structure, conventions, and development setup. See [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) for the three-layer session model (workflow / adapter / process). Pull requests welcome — run `npm test` before submitting.

## Known Limitations

- **`recruit` requires manual acknowledgment** — Recruited sessions show a Claude Code confirmation prompt that must be acknowledged in the spawned terminal. This will be resolved once agent-tempo is a published approved channel plugin. Copilot bridge sessions are not affected.

## License

MIT
