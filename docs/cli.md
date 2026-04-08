# CLI Reference

```
claude-tempo <command> [options]
```

## Commands

| Command | Description |
|---------|-------------|
| `up [ensemble]` | First-time setup: start Temporal, configure MCP, launch conductor. Use `--lineup` to load a lineup. |
| `down` | Full teardown — stop all sessions, daemon, and Temporal. Use `--keep-mcp` to preserve MCP config, `--keep-daemon` to leave the daemon running, `-y`/`--yes` to skip confirmation. |
| `server` | Start the Temporal dev server and register search attributes |
| `conduct [ensemble]` | Start a conductor session (one per ensemble). Use `--resume` or `--replace` if one exists. |
| `start [ensemble]` | Start a player session |
| `status [ensemble]` | Show active sessions and Temporal health |
| `config` | Configure Temporal connection settings (interactive or `set`/`show`) |
| `stop [ensemble]` | Stop sessions only — recoverable via `encore`. Use `-n <name>` for one, `--all` for all. |
| `init` | Register claude-tempo MCP server globally (`--project` for per-directory) |
| `preflight` | Run environment checks |
| `broadcast <msg>` | Send a message to all active players. Use `--type` to filter by player type, `--include-stale` to include stale sessions. |
| `encore <name>` | Revive a stale player session by name. Use `--host` to target a remote machine. |
| `ensemble <sub>` | Manage saved lineups (`save`, `list`, `show`) |
| `agent-types <sub>` | Manage player types (`list`, `show <name>`, `init`) |
| `daemon <sub>` | Manage the worker daemon (`start`, `stop`, `status`, `logs`) |
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
--lineup <name|file>          Load an ensemble lineup by name or file path (up only)
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
claude-tempo down                  # full teardown
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

## Related

- [configuration.md](configuration.md) — configuring Temporal connection settings
- [daemon.md](daemon.md) — managing the worker daemon
- [ensembles.md](ensembles.md) — `agent-types` and lineup commands
