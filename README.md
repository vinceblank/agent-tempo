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

Each session registers as a **player** in Temporal. Players discover each other with `ensemble`, send messages with `cue`, and coordinate via a **conductor** that connects to external interfaces like Discord, Telegram, or the built-in mission-control board.

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
| 🖥️ **Mission-control board** | Interactive operator board (`command-center`) — live ensemble view + cue/pause/restart/destroy controls + an LLM planner |
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

Or recruit players from the command-center board, or ask the conductor to `recruit` from inside Claude Code.

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

### Upgrading from 1.x to 2.0

A live-ensemble migration is required — a 2.0 worker cannot replay 1.x workflow histories. Run this on your 1.7.x install before switching to the 2.0 package:

```bash
agent-tempo upgrade-to-2
```

This runs a six-phase protocol (preflight → pause → drain → snapshot → destroy → done) that captures continuity before tearing down 1.x workflows. See the [1.7.0 → 2.0 Cutover Guide](docs/ops/v2-cutover.md) for the full procedure, flags (`--dry-run`, `--force-drain`, `--yes`), and rollback notes.

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

Players in one ensemble cannot see or message players in another. Run `agent-tempo` for status across ensembles (or `agent-tempo command-center` for the live board), or target a specific ensemble directly:

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
agent-tempo                    # bootstrap + status + operator hints (auto-provisions on first run)
agent-tempo up [ensemble]      # provision infrastructure and launch conductor
agent-tempo down [--destroy]   # tear down infrastructure (--destroy also terminates workflows)
agent-tempo status [ensemble]  # list active sessions
agent-tempo destroy [ensemble] # terminate all sessions in an ensemble (defaults to "default")
agent-tempo restore <ensemble> # restore orphaned sessions on this host
agent-tempo hosts              # list daemons polling this Temporal namespace (--all/--json)
agent-tempo recall <name>      # read a player's message history (--limit/--offset/--preview/--json)
agent-tempo attachment-info <name> # inspect a session's phase, holder, lease, and heartbeat age
agent-tempo release [ensemble] # release held players (unlock + deliver tasks)
agent-tempo command-center     # interactive operator board (aliases: cc, board)
agent-tempo dashboard          # open the web dashboard (--pair for QR-code cross-device access)
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

## Mission-control board

The interactive operator surface is the **command-center board** — an interactive
Pi session that turns one terminal into a live ensemble dashboard + operator
controller:

```bash
agent-tempo command-center                 # multi-ensemble board (aliases: cc, board)
agent-tempo command-center my-ensemble     # scoped to one ensemble
```

- **Live board** — coarse ensemble view (player phases, parts, current tool, context %) over the daemon's SSE stream, plus a fine per-player tail
- **Operator commands** — `/cue`, `/pause`, `/play`, `/go` (release held), `/restart`, `/destroy`, `/reset`, `/hosts`, `/status`, `/attachment-info`, `/recall`, `/schedule`, `/unschedule`, and more
- **LLM planner** — `ask` / `handoff` / `recruit` / `observe_board` tools for an operator who wants to plan and delegate from the same seat

A bare `agent-tempo` (no command) auto-provisions infrastructure, prints live
`status`, and points you at the board + web dashboard.

📖 [Concepts → docs/concepts.md](docs/concepts.md) (Command-center)

## Copilot Integration

> **Experimental** — subject to breaking changes.

GitHub Copilot CLI sessions can join an ensemble using `--agent copilot`. Recruit one from the command-center board or the conductor:

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

Set `conductor.agent: pi` in that ensemble's lineup to make it a Pi conductor.

**Prerequisites:** `@earendil-works/pi-coding-agent` on Node ≥ 22.19. Recommended: `ANTHROPIC_API_KEY` (without it the session falls back to Pi's own auth/default model).

**Headless Pi players** — recruit as a background agent slot using `agent: 'pi'`. Pi players run the full tool surface — including shell — without an approval layer, exactly like the other adapters. Observe them live via the mission-control board (coarse SSE + fine `/inner` tail); control via `cue`/`pause`/`restart`/`destroy`/`reset`. See [docs/concepts.md](docs/concepts.md#command-center-and-player-supervision).

**Mission-control board** — operator-only view that observes the ensemble and sends operator actions (cue, pause, restart, destroy) without joining as a player:

```bash
agent-tempo install-pi        # install Pi extensions (once per machine)
agent-tempo command-center    # launch the board (aliases: cc, board)
```

The admin token is injected automatically for loopback daemons — no manual token setup required locally (#736).

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
