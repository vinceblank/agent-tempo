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

- **TitleBar** (pinned top) — shows the current ensemble, player count, and connection state; in chat mode shows the target player and their status
- **Scroll area** — command output and sent messages accumulate here as scrollback history
- **Live view** — real-time ensemble state (players, recent messages, schedules); switches to a per-player chat view in `/cue` mode
- **PromptArea** (pinned bottom) — type slash commands or, in chat mode, bare text to send to the target player

### Slash Commands

| Command | Description |
|---|---|
| `/cue <player> [message]` | Enter chat mode with a player, or send a quick one-off message |
| `/broadcast <message>` | Send a message to all active players across all ensembles |
| `/recruit <name> [--type <type>] [--dir <path>]` | Spawn a new player session |
| `/stop <player>` | Terminate a player session |
| `/encore <player>` | Revive a stale player session |
| `/recall [player]` | Show recent message history (optionally filtered to one player) |
| `/players` | List all players with status, type, and current part |
| `/schedule` | List active schedules across all ensembles |
| `/unschedule <name>` | Cancel a named schedule |
| `/gates` | List quality gates and their criteria status |
| `/stages` | List stages and per-player report status |
| `/worktree [list]` | List active git worktrees |
| `/back` | Exit chat mode or navigate back to the ensemble list |
| `/help` | Show all available commands with usage |
| `/quit` | Exit the TUI |

In chat mode (`/cue <player>` with no message), bare text is sent directly to the target player as a cue. Press `Ctrl+C` to exit at any time.

## Maestro Web Dashboard

The **Maestro** workflow runs alongside the conductor, monitoring ensemble state in real time — tracking player joins/leaves, status changes, and part updates. It also accepts commands from external sources for relay to the conductor.

The [Maestro dashboard](https://github.com/vinceblank/maestro) is a web UI that connects to this workflow and provides a live view of your ensemble:

- Player list with status, part, host, and git branch
- Event log of recent ensemble activity
- Command input to interact with the conductor

The Maestro workflow starts automatically with the conductor and requires no additional setup. Connect the dashboard to your Temporal server's address and namespace to get started.

### How Maestro Works

Two Maestro workflow variants exist:

- **Per-ensemble** (`claude-maestro-{ensemble}`) — monitors a single ensemble, maintains a player snapshot and ring-buffer event log (max 200 entries), and queues commands for relay to the conductor via `maestroSendCommand`
- **Global** (`claude-maestro-global`) — spans all ensembles, aggregates players by ensemble, maintains a cross-ensemble message ring buffer (max 500 entries), and exposes on-demand player/conductor history via `maestroFetchPlayerMessages` and `maestroFetchConductorHistory` updates

Both are implemented in `src/workflows/maestro.ts`. Signal/query/update names are documented in [WIRE-PROTOCOL.md](WIRE-PROTOCOL.md).

## Related

- [cli.md](cli.md) — `claude-tempo tui` command reference
- [WIRE-PROTOCOL.md](WIRE-PROTOCOL.md) — stable Temporal signal/query names for Maestro
