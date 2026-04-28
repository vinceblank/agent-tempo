# Surface Registry

Single canonical inventory of every public-facing surface in claude-tempo.
Use this as the ground truth when doing drift checks — compare against the
source files below rather than grepping multiple directories.

> **Drift check commands** (run from repo root):
> ```bash
> # MCP tools
> grep -rh "defineTool(" src/tools/*.ts | grep -v helpers
> # CLI commands
> grep -E "^\s+\\\$\{out\.cyan\('[a-z]" src/cli/help-text.ts
> # TUI slash commands
> grep "usage:" src/tui/commands.ts
> ```

---

## 1. MCP Tools

Source: `src/tools/*.ts` — each file calls `defineTool(server, '<name>', '<description>', …)`.

| Tool name | Source file | Description |
|-----------|-------------|-------------|
| `agent_types` | `agent-types.ts` | List available player types that can be used when recruiting |
| `attachment_info` | `attachment-info.ts` | Query attachment lifecycle state — phase, holder, lease expiry, in-flight count |
| `broadcast` | `broadcast.ts` | Send a message to all active players; optional type filter |
| `cancel_stage` | `cancel-stage.ts` | Cancel an active pipeline stage (conductor only) |
| `cue` | `cue.ts` | Send a message to another session by player name via Temporal signal |
| `destroy` | `destroy.ts` | Terminate a session workflow or the entire ensemble (irreversible) |
| `ensemble` | `ensemble.ts` | Discover active sessions — player IDs, descriptions, metadata |
| `evaluate_gate` | `evaluate-gate.ts` | Mark quality gate criteria as passed or failed (conductor only) |
| `gates` | `gates.ts` | List quality gates and their status (conductor only) |
| `hosts` | `hosts.ts` | Show daemons polling this Temporal namespace with advertised capabilities |
| `listen` | `listen.ts` | Manually check for pending messages from other sessions |
| `load_lineup` | `load-lineup.ts` | Load an ensemble lineup — recruit players and create schedules |
| `migrate` | `migrate.ts` | Move a session to a different host (sugar for `restart` with required `host`) |
| `pause` | `pause.ts` | Pause all sessions — locks outbox dispatch and pauses the scheduler |
| `play` | `play.ts` | Resume a paused ensemble — unlocks dispatch and resumes the scheduler |
| `quality_gate` | `quality-gate.ts` | Define or replace a quality gate for a task (conductor only) |
| `recall` | `recall.ts` | Read your own message history with limit/offset/preview/filter options |
| `recruit` | `recruit.ts` | Start a new named session in a directory |
| `release` | `release.ts` | Release held sessions — unlock outboxes and deliver deferred task messages |
| `report` | `report.ts` | Send an update to the conductor (no-op if no conductor running) |
| `restart` | `restart.ts` | Restart a session — reap current attachment, claim fresh, spawn new adapter |
| `restore` | `restore.ts` | Revive ensemble after `shutdown` — reattach orphans, unpause maestro + scheduler |
| `save_lineup` | `save-lineup.ts` | Save current ensemble state as a YAML lineup (conductor only) |
| `schedule` | `schedule.ts` | Schedule a message to a player: one-shot, recurring, delay, or cron |
| `schedules` | `schedules.ts` | List all active schedules in this ensemble |
| `set_ensemble_description` | `set-ensemble-description.ts` | Update the ensemble's mission-flavor description (≤100 chars). Surfaces on the dashboard EnsembleCard |
| `set_name` | `set-name.ts` | Set a human-readable name for this session |
| `set_part` | `set-part.ts` | Update your description of what you are currently working on |
| `shutdown` | `shutdown.ts` | Graceful ensemble teardown — detach adapters, pause maestro + scheduler |
| `stage` | `stage.ts` | Create a pipeline stage tracking N players (conductor only) |
| `stages` | `stages.ts` | List all pipeline stages and per-player report status (conductor only) |
| `unschedule` | `unschedule.ts` | Remove a named schedule immediately |
| `who_am_i` | `who-am-i.ts` | Get your identity, role, player type, and session details |
| `worktree` | `worktree.ts` | Manage git worktrees for player isolation (conductor only) |

**Count:** 34 tools  
**Full reference:** [docs/tools.md](tools.md)  
**Note:** `detach` was removed from the MCP surface in v0.27 (#287) — its plumbing is used internally by `shutdown`.

---

## 2. CLI Commands

Source: `src/cli/help-text.ts` Commands section and `src/cli.ts` switch statement.

| Command | Description |
|---------|-------------|
| `tui [ensemble]` | Launch the Terminal UI (auto-provisions on first run; default bare invocation) |
| `up [ensemble]` | Start infrastructure — Temporal, daemon, MCP registration. Optional `--lineup <name>` loads an ensemble; `--scenario <name>` (dev-mode only, ADR 0014 §5.5) forces every `agent: "mock"` player in the lineup into `mockMode: scripted` with the named scenario. |
| `down [ensemble]` | Stop infrastructure; workflows stay parked |
| `down --destroy [-y]` | Terminate every workflow across every ensemble, then stop infrastructure |
| `server` | Start Temporal dev server and register search attributes |
| `status [ensemble]` | Show active sessions and Temporal health |
| `ensemble <sub>` | Manage saved ensemble lineups (`save` / `list` / `show`) |
| `broadcast <message>` | Send a message to all active players |
| `destroy <ensemble> [-y]` | Terminate every workflow in one ensemble (typed confirmation) |
| `attachment-info <name>` | Inspect V2 attachment phase, holder, lease expiry, and in-flight count |
| `recall <name>` | Read a player's message history |
| `hosts` | List daemons polling this Temporal namespace with advertised capabilities |
| `refresh-host-profile` | Re-advertise this daemon's capability profile to the global Maestro |
| `restore <ensemble>` | Restore orphaned sessions in one ensemble on this host |
| `release [ensemble]` | Release all held players — unlock outboxes, deliver messages |
| `agent-types <sub>` | Manage player type definitions (`list` / `show` / `init`) |
| `daemon <sub>` | Manage the worker daemon (`start` / `stop` / `status` / `logs` / `stats`) |
| `dashboard` | Open the web dashboard in the default browser (`--no-open` / `--pair` / `--json`) |
| `scenarios <sub>` | Discover mock-adapter scenarios shipped at `<package>/scenarios/` (`list` / `show <name>`). Available outside `--dev`; the recruit gate (`agent: 'mock'`) still requires it. |
| `upgrade [version]` | Upgrade claude-tempo to latest or a specific version |
| `config` | Configure Temporal connection settings (interactive or `set` / `show`) |
| `init` | Register MCP server globally (`--project` for per-directory) |
| `preflight` | Run environment preflight checks |
| `version` | Print the installed version |
| `help` | Show help message |

**Count:** 25 commands (including `down --destroy` as a distinct flag variant)  
**Full reference:** [docs/cli.md](cli.md)  
**Removed (v0.27 / #288):** `stop`, `restart`, `detach`, `migrate`, `conduct`, `start`, `recruit`, `disband`, `pause`, `resume` — see [docs/cli.md](cli.md) for migration hints.

---

## 3. TUI Slash Commands

Source: `src/tui/commands.ts` — `COMMANDS` record, `description:` + `usage:` fields.

| Command | Description |
|---------|-------------|
| `/attachment-info <player>` | Inspect the V2 attachment state of a session |
| `/back` | Return to maestro view |
| `/broadcast <message>` | Send a message to all active players |
| `/destroy <player\|ensemble> [reason]` | Terminally destroy a player (y/N) or an ensemble (typed-name) |
| `/ensemble [name]` | Switch active ensemble by name; no args navigates home |
| `/exit` | Exit the TUI (alias for `/quit`) |
| `/gates` | List quality gates and their status |
| `/go` | Release all held players (unlock outbox) |
| `/help [command]` | Show available commands; pass a command name for detailed usage |
| `/home` | Return to the home view (does not touch workflows) |
| `/hosts [--all]` | List daemons polling this Temporal namespace with advertised capabilities |
| `/lineup load <file> \| save [file]` | Load or save an ensemble lineup |
| `/migrate <player> <host> [--fresh] [--force]` | Restart a session on a different host |
| `/pause [ensemble]` | Pause every session + scheduler + maestro in the ensemble |
| `/play [ensemble]` | Resume a paused ensemble |
| `/players [name]` | List active players or show player detail |
| `/quit` | Exit the TUI |
| `/recall [player] [--limit N] [--offset N] [--preview N] [--from X] [--since ISO] [--include-sent]` | Read a player's message history |
| `/recruit <name> [--type <type>] [--dir <path>]` | Spawn a new player session |
| `/recruit-conductor` | Recruit a conductor for the current ensemble |
| `/restore [ensemble]` | Restore a parked ensemble — reattach orphans, unpause maestro + scheduler |
| `/restart <player> [--fresh] [--no-force]` | Restart a session; steals live lease by default |
| `/schedule [create \| delete <name>]` | Manage schedules — list, create, or delete |
| `/search <term>` | Search message history |
| `/shutdown [ensemble]` | Graceful ensemble teardown — detach adapters, pause maestro + scheduler |
| `/stages` | List stages and their status |
| `/status` | Show ensemble players and status |
| `/worktree [list \| create <player> \| remove <player>]` | Manage git worktrees for player isolation |

**Count:** 28 commands (`/quit` and `/exit` are both registered; `/back` and `/help` handled in App.tsx)  
**Full reference:** [docs/tui.md](tui.md)  
**Removed (v0.27):** `/resume`, `/detach`, `/disband`, `/pause_ensemble`, `/resume_ensemble` — show migration hints.

---

## 4. Temporal Wire Protocol (signals / queries / updates)

Documented in full in [`docs/WIRE-PROTOCOL.md`](WIRE-PROTOCOL.md). Not duplicated here.

Summary counts (as of v0.27):
- Session signals: 12 · Session queries: 14 · Session updates: 8
- Scheduler signals: 4 · Scheduler queries: 2
- Per-ensemble Maestro signals: 2 · queries: 5 · updates: 1
- Global Maestro signals: 2 · queries: 4 · updates: 4

---

## 5. HTTP/SSE Event Types (daemon event source)

Documented in full in [`docs/SSE-PROTOCOL.md`](SSE-PROTOCOL.md). Not duplicated here.

The daemon exposes an HTTP event source on a local port. Event types, endpoint paths, and payload schemas are the stable contract between the daemon and consumers (TUI, CLI follower, third-party integrations).
