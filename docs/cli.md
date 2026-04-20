# CLI Reference

```
claude-tempo <command> [options]
```

## Commands

| Command | Description |
|---------|-------------|
| `up [ensemble]` | First-time setup: start Temporal, configure MCP, launch conductor. Use `--lineup` to load a lineup. |
| `down [ensemble]` | Full teardown — stop all sessions, daemon, and Temporal. Use `--all` to stop all ensembles and Temporal, `--keep-mcp` to preserve MCP config, `--keep-daemon` to leave the daemon running, `-y`/`--yes` to skip confirmation. |
| `server` | Start the Temporal dev server and register search attributes |
| `conduct [ensemble]` | Start a conductor session (one per ensemble). Use `--resume` or `--replace` if one exists. Use `--lineup` to load a lineup with hold-on-startup semantics; `--no-hold` for immediate start. |
| `start [ensemble]` | Start a player session |
| `status [ensemble]` | Show active sessions and Temporal health |
| `config` | Configure Temporal connection settings (interactive or `set`/`show`) |
| `stop [ensemble]` | Stop sessions only — recoverable via `restart`. Use `-n <name>` for one, `--all` for all. |
| `init` | Register claude-tempo MCP server globally (`--project` for per-directory) |
| `preflight` | Run environment checks |
| `broadcast <msg>` | Send a message to all active players. Use `--type` to filter by player type, `--include-stale` to include stale sessions. |
| `restart <name>` | Restart a player session — detaches current adapter and re-spawns. Works from any non-`gone` attachment phase. Use `--host` to target a remote machine. |
| `detach <name>` | Gracefully detach the adapter for a session — triggers draining and clean handoff. Use when migrating a session to another host. |
| `destroy <name>` | Terminate a session's workflow — ordered shutdown via outbox drain. Use for permanent removal. |
| `migrate <name>` | Move a session to a different host — sugar for `setPreferredHost` + `restart` on the target machine. Use `--to <hostname>`. |
| `attachment-info <name>` | Inspect a session's attachment phase, current holder, lease expiry, heartbeat age, and in-flight message count. |
| `recall <name>` | Read a player's message history (#128). Flags: `--limit N` (default 20, max 100), `--offset N` (paging, default 0), `--preview N` (truncate bodies to N chars; omit for full text), `--from X` (sender filter for received), `--since ISO` (time filter), `--include-sent` (include outbound too), `--json` (emit raw `{received, sent, total, shown, hasMore, text}`). |
| `hosts` | **#274.** List daemons polling this Temporal namespace with their advertised capabilities. Flags: `--all` includes stale hosts; `--json` emits raw `HostInfo[]`. Output matches MCP `hosts` tool and TUI `/hosts` (shared formatter). |
| `refresh-host-profile` | **#274.** Re-advertise this daemon's capability profile to the global Maestro. Useful after editing `~/.claude-tempo/config.json` or adding/removing player-type files without restarting the daemon. Exits 0 on confirmed refresh, 1 on signal failure or unconfirmed after the 10s poll. |
| `restore [name]` | **v0.25.** Restore orphaned (detached) sessions. Interactive picker by default; `--all` restores every orphan, `--from-host <hostname>` filters by preferred host, `--dry-run` lists without restoring. |
| `release [ensemble]` | Release all held players — unlocks outboxes and delivers deferred task messages. Use `-n <name>` to release one player. |
| `pause [ensemble]` | Pause the ensemble — locks all session outbox dispatch and pauses the scheduler. |
| `resume [ensemble]` | Resume a paused ensemble — unlocks outbox dispatch and restarts the scheduler. Use `--release` to also release any held players in the same call. |
| `ensemble <sub>` | Manage saved lineups (`save`, `list`, `show`) |
| `agent-types <sub>` | Manage player types (`list`, `show <name>`, `init`) |
| `daemon <sub>` | Manage the worker daemon (`start [--force]`, `stop`, `status`, `logs`) |
| `tui [--ensemble <name>]` | Launch the interactive TUI — chat-focused shell with slash commands for managing players and ensembles |
| `upgrade [version]` | Graceful self-update — stops daemon, installs new version, restarts daemon |
| `version` | Print the installed version |
| `help` | Show usage info |

## Global Options

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
--lineup <name|file>          Load an ensemble lineup by name or file path (up and conduct)
--no-hold                     Skip hold-on-startup: deliver lineup instructions immediately without pausing the ensemble (up --lineup and conduct --lineup)
--release                     Also release held players when resuming (resume only) — combines resume_ensemble + release into one call
--resume                      Resume an existing conductor session (conduct only)
--replace                     Stop existing conductor and start fresh (conduct only)
-v, --version                 Print version and exit
```

## Command Details

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

If a conductor is already running in the target ensemble, `up` detects it and prompts with options: join as a player, reconnect to the existing conductor, tear down and start fresh, or cancel. This prevents two sessions from silently sharing the same Temporal workflow.

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

Full teardown — stops all sessions, the daemon, and Temporal, then removes MCP config:

```bash
claude-tempo down                  # full teardown (current ensemble)
claude-tempo down --all            # stop all ensembles, daemon, and Temporal
claude-tempo down --keep-mcp       # preserve MCP config
claude-tempo down --keep-daemon    # stop sessions and Temporal, but leave daemon running
claude-tempo down -y               # skip confirmation prompt
```

### `claude-tempo upgrade`

Graceful self-update — stops the daemon, installs the latest (or specified) version, then restarts the daemon:

```bash
claude-tempo upgrade            # install latest version
claude-tempo upgrade 0.20.0     # install a specific version
```

### `claude-tempo restart`

Detaches the current adapter and re-spawns a fresh process — functionally replaces the retired `encore` command. Works from any non-`gone` attachment phase (including `attached`, `awaiting`, `processing`, and `detached`):

```bash
claude-tempo restart alice             # restart on same host
claude-tempo restart alice --host bob-mac   # restart on remote host
```

The existing Temporal workflow is preserved — message history and metadata carry over.

### `claude-tempo detach`

Signals the adapter to drain and detach gracefully:

```bash
claude-tempo detach alice
```

Triggers the `requestDetach` signal → adapter enters `draining` → `detached`. Use before a planned `migrate` or host maintenance.

### `claude-tempo destroy`

Terminates a session's workflow via ordered shutdown (outbox drain):

```bash
claude-tempo destroy alice
```

Prefer `destroy` over `stop` for permanent removal — it respects the v0.25 outbox and attachment lifecycle rather than force-terminating.

### `claude-tempo restore`

Re-attaches a fresh adapter to a session whose previous adapter exited uncleanly (crash, OS kill, host reboot). Message history and metadata are preserved.

```bash
claude-tempo restore                    # interactive picker
claude-tempo restore alice              # restore a specific player by name
claude-tempo restore --all              # restore every orphan on this host
claude-tempo restore --from-host web-01 # filter by preferred host
claude-tempo restore --dry-run          # list candidates without restoring
```

The daemon auto-restores orphans on boot when `restorePolicy` is configured; `restore` lets you trigger it manually.

### `claude-tempo migrate`

Moves a session to a different host — sets the preferred host then triggers `restart` on the target machine's task queue:

```bash
claude-tempo migrate alice --to build-server
```

Requires the target host to have an active claude-tempo daemon. See [PR-F multi-host docs](https://github.com/vinceblank/claude-tempo) for cross-host setup.

## Related

- [configuration.md](configuration.md) — configuring Temporal connection settings
- [daemon.md](daemon.md) — managing the worker daemon
- [ensembles.md](ensembles.md) — `agent-types` and lineup commands
