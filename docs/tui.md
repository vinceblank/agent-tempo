# Terminal UI

## Launching

```bash
# Multi-ensemble mode — lists all running ensembles
claude-tempo tui

# Direct ensemble mode — connects straight to a named ensemble
claude-tempo tui --ensemble my-ensemble
```

## Interface

The TUI has a persistent layout:

- **TitleBar** (pinned top) — shows the current ensemble, player count, and connection state
- **Scroll area** — command output and sent messages accumulate as native scrollback history
- **Ensemble chat** — aggregated live feed of all maestro + conductor traffic; prefix messages with `@player` to address specific players
- **PromptArea** (pinned bottom) — type slash commands or bare text; bare text routes to the conductor (or a specific player with `@player` prefix)
- **StatusBar** (pinned bottom) — player count, schedule count, and connection health
- **CommandPalette** — autocomplete dropdown appears when typing `/`, with parameter hints for commands that accept player names or subcommands

## Messaging

Bare text in the ensemble view routes to the conductor by default. Prefix with `@player` to address a specific player directly:

```
@alice can you review the PR?
@frontend check your tests
```

The command palette provides autocomplete for player names — press Tab or continue typing after `@` to narrow the list. If no conductor is running, bare text shows a prompt to use `@player` or `/recruit`.

Use `/players <name>` to open a scrollable message history for any player.

## Keyboard Shortcuts

| Key | Action |
|-----|--------|
| `Enter` | Submit message / confirm selection |
| `↑` / `↓` | Navigate overlay items; scroll command history |
| `Tab` | Autocomplete slash commands and `@player` names |
| `Esc` | Dismiss overlays and pickers; go back to previous view |
| `Ctrl+C` | Exit the TUI |

## Slash Commands

| Command | Description |
|---|---|
| `/broadcast <message>` | Send a message to all active players in the current ensemble |
| `/recruit [name] [--type <type>] [--dir <path>]` | Spawn a new player (launches wizard if args omitted) |
| `/recruit-conductor` | Recruit a conductor for the current ensemble |
| `/stop <player>` | Hard-terminate a workflow — bypasses v0.25 outbox drain. Prefer `/destroy` for ordered shutdown. |
| `/restart <player>` | Restart a player — detaches current adapter and re-spawns. Works from any non-`gone` phase. |
| `/detach <player>` | Gracefully detach a player's adapter — triggers draining and clean handoff. |
| `/destroy <player>` | Terminate a session via ordered shutdown (outbox drain). Use for permanent removal. |
| `/migrate <player> --to <hostname>` | Move a session to a different host. Requires target host to have an active daemon. |
| `/attachment-info <player>` | Show the current attachment phase, lease expiry, heartbeat age, and in-flight count for a player. Output matches CLI and MCP surfaces (shared formatter, #264). |
| `/disband` | Tear down the current ensemble — all sessions, scheduler, and Maestro |
| `/players [name]` | Show detailed player info; no args opens interactive picker |
| `/ensemble [name]` | Switch active ensemble context; no args opens picker |
| `/status` | Show dismissible overlay with all players, status, type, and part |
| `/recall [player]` | Query a player's inbox directly. Omit player to target the maestro session. Flags: `--limit N` (default 20, max 100), `--offset N` (paging), `--preview N` (truncate bodies; omit = full text), `--from X`, `--since ISO`, `--include-sent`. (#128: unified semantics with MCP `recall` and `claude-tempo recall` CLI.) |
| `/search <term>` | Search message history across the ensemble |
| `/schedule [create \| delete <name>]` | List active schedules (interactive overlay); `create` launches the schedule wizard; `delete <name>` cancels a named schedule |
| `/lineup load <file> \| save [file]` | Load or save an ensemble lineup |
| `/gates` | List quality gates and their criteria status |
| `/stages` | List stages and per-player report status |
| `/worktree [list \| create <player> \| remove <player>]` | List active git worktrees; `create`/`remove` delegate to the conductor |
| `/back` | Return to the main ensemble view |
| `/help [command]` | Show all commands; pass a command name for detailed usage (e.g. `/help recruit`) |
| `/quit` | Exit the TUI |

Interactive overlays (`/schedule`, `/gates`, `/stages`, `/worktree`) support arrow-key navigation and action keys shown in the overlay hint bar (e.g. `n=new  d=delete  esc=close`).

## v0.25 Changes

> **Breaking change in v0.25.0-beta.1**: The wire protocol changed. If upgrading from v0.24.x, run `claude-tempo down` and `claude-tempo up` to reinitialize before launching the TUI.

- **`/encore` removed** — use `/restart` instead. Restart works from any non-`gone` attachment phase.
- **`/stop` semantics changed** — now hard-terminates the workflow directly (bypasses outbox drain). Prefer `/destroy` for ordered shutdown.
- **New lifecycle commands**: `/restart`, `/detach`, `/destroy`, `/migrate`, `/attachment-info` expose the v0.25 attachment state machine.

## How the TUI Gets Data

The TUI queries two background Temporal workflows for its data — no separate server process is needed:

- **Per-ensemble Maestro** (`claude-maestro-{ensemble}`) — the primary data source. Maintains a player snapshot (refreshed periodically), a ring-buffer event log (max 200 entries), and an aggregated ensemble chat cache (max 500 entries, refreshed every ~10s via `fetchEnsembleChat`). The TUI polls the `maestroEnsembleChat` query to populate the conversation stream.
- **Global Maestro** (`claude-maestro-global`) — spans all ensembles. Used by the TUI home screen to discover running ensembles and aggregate players across them. Exposes on-demand player/conductor message history via `maestroFetchPlayerMessages` and `maestroFetchConductorHistory` updates.

The TUI's API layer (`src/tui/client.ts`) wraps these queries behind a `TempoClient` interface, with graceful fallback from Global → per-ensemble Maestro → direct workflow list queries. Both workflows start automatically with the conductor and require no additional setup. Signal/query/update names are documented in [WIRE-PROTOCOL.md](WIRE-PROTOCOL.md).

## Behaviors and Edge Cases

- **Routing**: Bare text routes to the conductor via `sendCommand`. Prefix with `@player` to message a specific player directly (e.g. `@alice can you review this?`). When no conductor is present, bare text shows an error; use `@player` to message directly.
- **Schedule management**: `/schedule` is the single entry point — no standalone `/unschedule`. Subcommands: `/schedule` (show overlay), `/schedule create` (wizard), `/schedule delete <name>` (cancel).
- **Interactive overlays**: `/status`, `/schedule`, `/gates`, `/stages`, `/worktree` display dismissible overlays. `/player`, `/ensemble` open full-screen interactive pickers.
- **Removed aliases**: `/home`, `/maestro`, `/dashboard`, `/exit`, and `/unschedule` are **not** registered commands. Using them produces a "command not found" error. Use `/back`, `/quit`, and `/schedule delete` respectively.
- **`/help <command>`**: `/help` alone shows all commands; `/help recruit` (or `/help /recruit`) shows the usage and description for a specific command in an overlay.
- **NO_COLOR**: Set `NO_COLOR=1` to disable all color output — respected in both the TUI theme (`src/tui/utils/theme.ts`) and CLI output helpers (`src/cli/output.ts`). Follows the https://no-color.org/ convention.
- **Terminal size requirement**: The TUI requires a minimum terminal size of **80×24**. If the terminal is smaller at launch, the process exits with code 1. A soft in-app warning appears at 60×15 during resize.

## Related

- [cli.md](cli.md) — `claude-tempo tui` command reference
- [WIRE-PROTOCOL.md](WIRE-PROTOCOL.md) — stable Temporal signal/query names for Maestro
- [tui-performance.md](tui-performance.md) — Ink/React performance lessons for contributors
