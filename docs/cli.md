# CLI Reference

```
claude-tempo <command> [options]
```

## Commands

| Command | Description |
|---------|-------------|
| `up [ensemble]` | First-time setup: start Temporal, configure MCP, launch conductor. Use `--lineup` to load a lineup. |
| `down [ensemble]` | Full teardown — stop all sessions, daemon, and Temporal. Use `--all` to stop all ensembles and Temporal, `--keep-mcp` to preserve MCP config, `--keep-daemon` to leave the daemon running, `-y`/`--yes` to skip confirmation. Add `--destroy` to also terminate every workflow before tearing down. |
| `server` | Start the Temporal dev server and register search attributes |
| `status [ensemble]` | Show active sessions and Temporal health |
| `config` | Configure Temporal connection settings (interactive or `set`/`show`) |
| `init` | Register claude-tempo MCP server globally (`--project` for per-directory) |
| `preflight` | Run environment checks |
| `broadcast <msg>` | Send a message to all active players. Use `--type` to filter by player type, `--include-stale` to include stale sessions. |
| `destroy <ensemble> [-y]` | Terminate every workflow in an ensemble — ordered shutdown via outbox drain. Prompts for typed confirmation; `-y` skips. |
| `attachment-info <name>` | Inspect a session's attachment phase, current holder, lease expiry, heartbeat age, and in-flight message count. |
| `recall <name>` | Read a player's message history (#128). Flags: `--limit N` (default 20, max 100), `--offset N` (paging, default 0), `--preview N` (truncate bodies to N chars; omit for full text), `--from X` (sender filter for received), `--since ISO` (time filter), `--include-sent` (include outbound too), `--json` (emit raw `{received, sent, total, shown, hasMore, text}`). |
| `hosts` | **#274.** List daemons polling this Temporal namespace with their advertised capabilities. Flags: `--all` includes stale hosts; `--json` emits raw `HostInfo[]`. Output matches MCP `hosts` tool and TUI `/hosts` (shared formatter). |
| `refresh-host-profile` | **#274.** Re-advertise this daemon's capability profile to the global Maestro. Useful after editing `~/.claude-tempo/config.json` or adding/removing player-type files without restarting the daemon. Exits 0 on confirmed refresh, 1 on signal failure or unconfirmed after the 10s poll. |
| `restore <ensemble>` | Restore orphaned (detached) sessions in one ensemble on this host — re-attaches a fresh adapter to every matching `detached` session. (#288) |
| `release [ensemble]` | Release all held players — unlocks outboxes and delivers deferred task messages. Use `-n <name>` to release one player. |
| `ensemble <sub>` | Manage saved lineups (`save`, `list`, `show`) |
| `agent-types <sub>` | Manage player types (`list`, `show <name>`, `init`) |
| `daemon <sub>` | Manage the worker daemon (`start [--force]`, `stop`, `status`, `logs`) |
| `upgrade [version]` | Graceful self-update — stops daemon, installs new version, restarts daemon |
| `version` | Print the installed version |
| `help` | Show usage info |

> **Removed commands — use the TUI instead** (since v0.27 / #288):
> - `stop` / `restart` / `detach` / `migrate` → TUI `/destroy` · `/restart` · `/shutdown`
> - `conduct` / `start` / `recruit` / `disband` → launch `claude-tempo` · TUI `/recruit` · `/destroy`
> - `pause` / `resume` → TUI `/pause` · `/play`
>
> See [github.com/vinceblank/claude-tempo/issues/285](https://github.com/vinceblank/claude-tempo/issues/285) for the full migration table.

## Global Options

```
--temporal-address <addr>     Temporal server address (default: localhost:7233)
--temporal-namespace <ns>     Temporal namespace (default: default)
--temporal-api-key <key>      Temporal Cloud API key
--temporal-tls-cert <path>    mTLS client certificate path
--temporal-tls-key <path>     mTLS client key path
-n, --name <name>             Set the session name (up only)
--agent <claude|copilot>      Agent backend to use (default: claude)
--skip-preflight              Skip preflight checks
-d, --dir <path>              Target directory (default: cwd)
--background                  Run Temporal in background (server only)
--keep-mcp                    Preserve MCP config when tearing down (down only)
--destroy                     Also terminate every workflow (down only)
--lineup <name|file>          Load an ensemble lineup by name or file path (up)
--no-hold                     Skip hold-on-startup: deliver lineup instructions immediately (up --lineup)
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
  claude-tempo status myband   See who's active
  Or use the TUI to recruit players (/recruit)
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

Verifies your environment: Node.js >= 20, Temporal reachable, `~/.claude-tempo` writable, `.mcp.json` configured. Missing `claude` binary is now reported at spawn time rather than preflight.

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
claude-tempo down --destroy -y     # terminate every workflow, then tear down (skip confirmation)
claude-tempo down --keep-mcp       # preserve MCP config
claude-tempo down --keep-daemon    # stop sessions and Temporal, but leave daemon running
```

### `claude-tempo destroy`

Terminates every workflow in an ensemble via ordered shutdown (outbox drain). Prompts for typed confirmation; use `-y` to skip:

```bash
claude-tempo destroy myband        # terminate all sessions in "myband"
claude-tempo destroy myband -y     # skip confirmation
```

### `claude-tempo restore`

Restores orphaned (detached) sessions in one ensemble on this host — re-attaches a fresh adapter to every matching `detached` session:

```bash
claude-tempo restore myband        # restore all orphans in "myband" on this host
```

The daemon auto-restores orphans on boot when `restorePolicy` is configured; `restore` lets you trigger it manually.

### `claude-tempo upgrade`

Graceful self-update — stops the daemon, installs the latest (or specified) version, then restarts the daemon:

```bash
claude-tempo upgrade            # install latest version
claude-tempo upgrade 0.20.0     # install a specific version
```

## Related

- [configuration.md](configuration.md) — configuring Temporal connection settings
- [daemon.md](daemon.md) — managing the worker daemon
- [ensembles.md](ensembles.md) — `agent-types` and lineup commands
