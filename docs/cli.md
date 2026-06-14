# CLI Reference

```
agent-tempo <command> [options]
```

## Commands

| Command | Description |
|---------|-------------|
| `tui [ensemble]` | Launch the Terminal UI. Omit `ensemble` for the multi-ensemble home view; pass a name to open directly in that ensemble. (Auto-provisions on first run.) |
| `up [ensemble]` | First-time setup: start Temporal, configure MCP, launch conductor. Use `--lineup` to load a lineup. |
| `down [ensemble]` | Full teardown — stop all sessions, daemon, and Temporal. Use `--all` to stop all ensembles and Temporal, `--keep-mcp` to preserve MCP config, `--keep-daemon` to leave the daemon running, `-y`/`--yes` to skip confirmation. Add `--destroy` to also terminate every workflow. `--kill-shared-temporal` overrides the cross-profile guard and kills the Temporal server even if the other profile is active (#423). |
| `server` | Start the Temporal dev server and register search attributes |
| `status [ensemble]` | Show active sessions and Temporal health |
| `config` | Configure Temporal connection settings (interactive or `set`/`show`) |
| `init` | Register agent-tempo MCP server globally (`--project` for per-directory) |
| `preflight` | Run environment checks |
| `broadcast <msg>` | Send a message to all active players. Use `--type` to filter by player type, `--include-stale` to include stale sessions. |
| `destroy [ensemble] [-y]` | Terminate every workflow in an ensemble — ordered shutdown via outbox drain. Resolves the ensemble via the shared resolver (`--ensemble` flag > positional > env > `default`); with no arguments, targets `default`. Prompts for typed confirmation; `-y` skips. |
| `attachment-info <name>` (alias: `attachment`) | Inspect a session's attachment phase, current holder, lease expiry, heartbeat age, and in-flight message count. |
| `recall <name>` | Read a player's message history (#128). Flags: `--limit N` (default 20, max 100), `--offset N` (paging, default 0), `--preview N` (truncate bodies to N chars; omit for full text), `--from X` (sender filter for received), `--since ISO` (time filter), `--include-sent` (include outbound too), `--json` (emit raw `{received, sent, total, shown, hasMore, text}`). |
| `hosts` | **#274.** List daemons polling this Temporal namespace with their advertised capabilities. Flags: `--all` includes stale hosts; `--json` emits raw `HostInfo[]`. Output matches MCP `hosts` tool and TUI `/hosts` (shared formatter). |
| `refresh-host-profile` | **#274.** Re-advertise this daemon's capability profile to the global Maestro. Useful after editing `~/.agent-tempo/config.json` or adding/removing player-type files without restarting the daemon. Exits 0 on confirmed refresh, 1 on signal failure or unconfirmed after the 10s poll. |
| `restore <ensemble>` | Restore orphaned (detached) sessions in one ensemble on this host — re-attaches a fresh adapter to every matching `detached` session. (#288) |
| `release [ensemble]` | Release all held players — unlocks outboxes and delivers deferred task messages. Use `-n <name>` to release one player. |
| `ensemble <sub>` | Manage saved lineups (`save`, `list`, `show`) |
| `agent-types <sub>` | Manage player types (`list`, `show <name>`, `init`) |
| `daemon <sub>` | Manage the worker daemon (`start [--force]`, `stop`, `status`, `logs`, `stats`) |
| `dashboard` | Open the web dashboard in the default browser. Flags: `--port`, `--bind`, `--no-open` (print URL, skip launch), `--pair` (mint a one-time QR-code pairing token for cross-device access), `--json` (machine-parseable output). Requires the daemon to be running. (#340) |
| `command-center [ensemble]` (aliases: `cc`, `board`) | Launch the interactive Pi mission-control board for an ensemble. Operator-only — never claims attachment or registers as a player. Requires `@earendil-works/pi-coding-agent` and Node ≥ 22.19. See [Command-center](#agent-tempo-command-center) below. (#729) |
| `install-pi` | Install agent-tempo's Pi extensions (player + command-center) into Pi's settings.json. Idempotent; prunes stale/old-version paths on re-run. Use `--project` for per-directory installation. (#700, #738) |
| `migrate-from-claude-tempo` | One-shot home-directory migration from `~/.claude-tempo/` → `~/.agent-tempo/`. Use `--dry-run` to preview without writing; `--force` to bypass conflict and volatile-state guards. |
| `scenarios <sub>` | **Dev mode only.** Browse the shipped scenario library (`list`, `show <name>`). Requires `--dev`. See [dev-mode.md](dev-mode.md). |
| `upgrade [version]` | Graceful self-update — stops daemon, installs new version, restarts daemon |
| `version` | Print the installed version |
| `help` | Show usage info |

> **Removed commands — use the TUI instead** (since v0.27 / #288):
> - `stop` / `restart` / `detach` / `migrate` → TUI `/destroy` · `/restart` · `/shutdown`
> - `conduct` / `start` / `recruit` / `disband` → launch `agent-tempo` · TUI `/recruit` · `/destroy`
> - `pause` / `resume` → TUI `/pause` · `/play`
>
> See [github.com/vinceblank/agent-tempo/issues/285](https://github.com/vinceblank/agent-tempo/issues/285) for the full migration table.

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
--kill-shared-temporal        Kill Temporal dev server even if the other profile (dev/prod) is active (down only, #423)
--lineup <name|file>          Load an ensemble lineup by name or file path (up)
--no-hold                     Skip hold-on-startup: deliver lineup instructions immediately (up --lineup)
--scenario <name>             Force every mock player in the lineup into scripted mode with this scenario (up --dev, dev mode only)
--dev                         Run in dev-mode isolated profile (home: ~/.agent-tempo-dev/, port: 8474, namespace: agent-tempo-dev). See dev-mode.md.
-v, --version                 Print version and exit
```

## Command Details

### `agent-tempo up`

The recommended way to get started:

```
$ agent-tempo up myband

agent-tempo setup
  ✓ temporal CLI installed
  … Starting Temporal dev server...
  ✓ Temporal started (pid 12345, data in ~/.agent-tempo/)
  ✓ Registered search attributes
  ✓ .mcp.json created

Launching conductor in ensemble myband...

✓ You're all set!
  Conductor launched (pid 12346)
  Ensemble: myband

  What next?
  agent-tempo status myband   See who's active
  Or use the TUI to recruit players (/recruit)
```

If a conductor is already running in the target ensemble, `up` detects it and prompts with options: join as a player, reconnect to the existing conductor, tear down and start fresh, or cancel. This prevents two sessions from silently sharing the same Temporal workflow.

### `agent-tempo server`

Starts the Temporal dev server with automatic search attribute registration:

```bash
agent-tempo server                 # foreground (Ctrl+C to stop)
agent-tempo server --background    # daemonize
```

Data persists in `~/.agent-tempo/temporal-data.db`. If Temporal is already running, registers attributes and exits.

### `agent-tempo status`

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

### `agent-tempo preflight`

Verifies your environment: Node.js >= 20, Temporal reachable, `~/.agent-tempo` writable, `.mcp.json` configured. Missing `claude` binary is now reported at spawn time rather than preflight.

### `agent-tempo init`

Registers the agent-tempo MCP server globally so it's available in every Claude Code session:

```bash
agent-tempo init             # global install (recommended)
agent-tempo init --project   # per-directory .mcp.json instead
```

If the `claude` CLI is not available, falls back to creating `.mcp.json` in the current directory.

### `agent-tempo down`

Full teardown — stops all sessions, the daemon, and Temporal, then removes MCP config:

```bash
agent-tempo down                  # full teardown (current ensemble)
agent-tempo down --all            # stop all ensembles, daemon, and Temporal
agent-tempo down --destroy -y     # terminate every workflow, then tear down (skip confirmation)
agent-tempo down --keep-mcp       # preserve MCP config
agent-tempo down --keep-daemon    # stop sessions and Temporal, but leave daemon running
```

When `--destroy` is passed and Temporal is not yet running, `down` starts a temporary Temporal
dev server (same port and database as `up`), runs workflow terminations, then shuts it down
again. This ensures workflows are actually gone and do not resurrect on the next `up`. If the
`temporal` CLI is missing or the server fails to start within 10 seconds, the command warns
loudly rather than silently skipping termination.

### `agent-tempo destroy`

Terminates every workflow in an ensemble via ordered shutdown (outbox drain). Prompts for typed confirmation; use `-y` to skip.

The ensemble is resolved via the shared resolver (`--ensemble` flag > positional > env > `default`). When `--ensemble` and a positional differ, the flag wins and a warning is printed. With no arguments, `destroy` targets `default`.

```bash
agent-tempo destroy myband              # terminate all sessions in "myband"
agent-tempo destroy myband -y           # skip confirmation
agent-tempo destroy                     # targets "default" (prompts for confirmation)
agent-tempo destroy --ensemble myband   # explicit flag form
```

### `agent-tempo restore`

Restores orphaned (detached) sessions in one ensemble on this host — re-attaches a fresh adapter to every matching `detached` session:

```bash
agent-tempo restore myband        # restore all orphans in "myband" on this host
agent-tempo restore --all-hosts   # cluster-view: list detached sessions across all hosts (read-only, no re-attach)
```

`--all-hosts` (#151) is a discovery mode — it queries Temporal for every detached session in the ensemble regardless of preferred host and prints a grouped listing so you can see what's parked on remote machines. No sessions are re-attached; use `agent-tempo restore <ensemble>` on the appropriate host to recover them.

The daemon auto-restores orphans on boot when `restorePolicy` is configured; `restore` lets you trigger it manually.

### `agent-tempo upgrade`

Graceful self-update — stops the daemon, installs the latest (or specified) version, then restarts the daemon:

```bash
agent-tempo upgrade            # install latest version
agent-tempo upgrade 0.20.0     # install a specific version
```

### `agent-tempo command-center`

Launches the interactive Pi mission-control board (aliases: `cc`, `board`). The board is the **operator seat** — it observes the ensemble via the daemon SSE stream and POSTs operator actions (cue, pause, play, restart, destroy) to the daemon write surface. It is **not a player** and never registers as an ensemble member.

```bash
agent-tempo command-center              # observe + control the default ensemble
agent-tempo command-center myband       # target a named ensemble
agent-tempo cc myband                   # alias
agent-tempo board myband                # alias
```

Requirements:
- `@earendil-works/pi-coding-agent` installed and Node ≥ 22.19
- Daemon running (`agent-tempo daemon start`)
- `AGENT_TEMPO_HTTP_ADMIN_TOKEN` for a **remote** daemon; loopback daemons grant full trust automatically (no token required) (#736)

Install the Pi extensions first (once per machine or per project):

```bash
agent-tempo install-pi            # global install
agent-tempo install-pi --project  # per-directory .pi/settings.json
```

**Board connection states** — the board header shows the live stream health:

| Label | Meaning |
|---|---|
| *(no label)* | Stream live |
| `[RECONNECTING]` | Actively retrying after a transport drop |
| `[STREAM DOWN]` | Settled reconnect loop — retrying every 30s |
| `ENSEMBLE GONE` | Daemon returned 404 — the ensemble was destroyed |
| `[STREAM ENDED]` | Daemon returned 401 — auth error (check `AGENT_TEMPO_HTTP_ADMIN_TOKEN`) |

The board reconnects automatically on transient drops (bounded-ramp then 30s steady). A 35s staleness watchdog (keyed off the daemon's ≤10s heartbeat) catches daemon-death and wedged sockets that the transport alone can't detect. On `ENSEMBLE GONE` the roster clears automatically; on `[STREAM DOWN]` the last-known roster is preserved under the banner.

See [concepts.md](concepts.md) for the Q&A mechanics.

### `agent-tempo install-pi`

Installs agent-tempo's two Pi extensions (player + command-center) into Pi's settings.json. The install is idempotent — re-running prunes stale or old-version extension paths and adds the current ones:

```bash
agent-tempo install-pi            # global ~/.pi/agent/settings.json
agent-tempo install-pi --project  # per-directory .pi/settings.json
```

After installation, use the deliberate launch paths — a bare `pi` keeps both extensions dormant:

```
agent-tempo up --agent pi         # conductor/player session
agent-tempo command-center        # operator mission-control board
```

## Related

- [configuration.md](configuration.md) — configuring Temporal connection settings
- [daemon.md](daemon.md) — managing the worker daemon
- [ensembles.md](ensembles.md) — `agent-types` and lineup commands
