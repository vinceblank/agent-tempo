# TUI Dashboard and Maestro Web Dashboard

## TUI Dashboard

The built-in terminal UI provides a chat-focused shell for managing your ensemble without leaving the terminal.

### Launching

```bash
# Multi-ensemble mode — lists all running ensembles
claude-tempo tui

# Direct ensemble mode — connects straight to a named ensemble
claude-tempo tui --ensemble my-ensemble
```

### Interface

The TUI has a persistent layout:

- **TitleBar** (pinned top) — shows the current ensemble, player count, and connection state
- **Scroll area** — command output and sent messages accumulate as native scrollback history
- **Ensemble chat** — aggregated live feed of all maestro + conductor traffic; prefix messages with `@player` to address specific players
- **PromptArea** (pinned bottom) — type slash commands or bare text; bare text routes to the conductor (or a specific player with `@player` prefix)
- **StatusBar** (pinned bottom) — player count, schedule count, and connection health
- **CommandPalette** — autocomplete dropdown appears when typing `/`, with parameter hints for commands that accept player names or subcommands

### Slash Commands

| Command | Description |
|---|---|
| `/broadcast <message>` | Send a message to all active players in the current ensemble |
| `/recruit [name] [--type <type>] [--dir <path>]` | Spawn a new player (launches wizard if args omitted) |
| `/recruit-conductor` | Recruit a conductor for the current ensemble |
| `/stop <player>` | Stop a player session (with confirmation) |
| `/encore <player>` | Revive a stale player session |
| `/disband` | Tear down the current ensemble — all sessions, scheduler, and Maestro |
| `/player [name]` | Show detailed player info; no args opens interactive picker |
| `/ensemble [name]` | Switch active ensemble context; no args opens picker |
| `/status` | Show dismissible overlay with all players, status, type, and part |
| `/recall [player]` | Show recent message history (optionally filtered to one player) |
| `/search <term>` | Search message history across the ensemble |
| `/schedule [create \| delete <name>]` | List active schedules (interactive overlay); `create` launches the schedule wizard; `delete <name>` cancels a named schedule |
| `/lineup load <file> \| save [file]` | Load or save an ensemble lineup |
| `/gates` | List quality gates and their criteria status |
| `/stages` | List stages and per-player report status |
| `/worktree [list \| create <player> \| remove <player>]` | List active git worktrees; `create`/`remove` delegate to the conductor |
| `/back` | Return to the main ensemble view |
| `/help [command]` | Show all commands; pass a command name for detailed usage (e.g. `/help recruit`) |
| `/quit` | Exit the TUI |

Bare text (no `/` prefix) routes to the conductor by default. Prefix with `@player` to address a specific player: `@alice can you review the PR?`. Use `/player <name>` to open a scrollable message history for any player. Press `Ctrl+C` to exit at any time.

## Maestro Web Dashboard

The **Maestro** workflow runs alongside the conductor, monitoring ensemble state in real time — tracking player joins/leaves, status changes, and part updates. It also accepts commands from external sources for relay to the conductor.

The [Maestro dashboard](https://github.com/vinceblank/maestro) is a web UI that connects to this workflow and provides a live view of your ensemble:

- Player list with status, part, host, and git branch
- Event log of recent ensemble activity
- Command input to interact with the conductor

The Maestro workflow starts automatically with the conductor and requires no additional setup. Connect the dashboard to your Temporal server's address and namespace to get started.

### How Maestro Works

Two Maestro workflow variants exist:

- **Per-ensemble** (`claude-maestro-{ensemble}`) — monitors a single ensemble, maintains a player snapshot, ring-buffer event log (max 200 entries), and an aggregated ensemble chat cache (max 500 entries, refreshed every ~10s via `fetchEnsembleChat`). The chat cache merges maestro + conductor traffic and is served via the `maestroEnsembleChat` query. Also queues commands for relay to the conductor via `maestroSendCommand`
- **Global** (`claude-maestro-global`) — spans all ensembles, aggregates players by ensemble, maintains a cross-ensemble message ring buffer (max 500 entries), and exposes on-demand player/conductor history via `maestroFetchPlayerMessages` and `maestroFetchConductorHistory` updates

Both are implemented in `src/workflows/maestro.ts`. Signal/query/update names are documented in [WIRE-PROTOCOL.md](WIRE-PROTOCOL.md).

## Related

- [cli.md](cli.md) — `claude-tempo tui` command reference
- [WIRE-PROTOCOL.md](WIRE-PROTOCOL.md) — stable Temporal signal/query names for Maestro
