# Worker Daemon

The **worker daemon** is a standalone background process that runs Temporal workers — it replaces the per-session workers from earlier versions. Sessions are now pure MCP clients.

The daemon auto-starts the first time any claude-tempo command needs it. You can also manage it explicitly:

```bash
claude-tempo daemon start           # start the daemon (no-op if already running)
claude-tempo daemon start --force   # bypass orphan check + clear stale pid file
claude-tempo daemon stop            # stop the daemon
claude-tempo daemon status          # show running state, PID, and heartbeat age
claude-tempo daemon logs            # tail daemon logs
claude-tempo daemon stats           # print live memory usage, uptime, ensembles, SSE subscriber count
```

## Memory Diagnostics

`claude-tempo daemon stats` prints a live snapshot from the daemon's `/v1/health` endpoint:

```
Daemon stats (pid 12345)
  Uptime:           2h 14m
  Memory (rss):     128 MB
  Heap used/total:  64 / 80 MB
  External:         4 MB
  Ensembles:        2
  SSE subscribers:  3
```

The daemon also logs a memory summary every 5 minutes to `~/.claude-tempo/daemon.log`:

```
memory: rss=128mb heapUsed=64 heapTotal=80 external=4 arrayBuffers=1
```

Pre-#336 daemons return `n/a` for memory fields — `daemon stats` handles this gracefully.

## How It Works

- On first use, any claude-tempo command calls `startDaemon()` and waits up to 10 seconds for it to confirm startup (by writing `~/.claude-tempo/daemon.pid`)
- The daemon runs detached — it survives terminal closes and session restarts
- All Temporal worker duties (workflow execution, activity dispatch) run in the daemon
- Logs are written to `~/.claude-tempo/daemon.log`
- On Linux/macOS, the daemon is stopped via `SIGTERM`; on Windows, the process is killed directly

### Heartbeat

The daemon touches `~/.claude-tempo/daemon.heartbeat` every 60 seconds. `daemon status` reports the age of that file and flags it **stale** when the last touch is more than 120 seconds ago. A stale heartbeat with a live PID indicates the daemon's main loop may be hung — the PID-alive check alone can't distinguish "serving" from "hung".

### Orphan pre-flight (`daemon start`)

Before spawning, `daemon start` scans for unexpected claude-tempo daemon processes and aborts (exit 1) if any are found. This prevents the scenario where a stale or crashed daemon goes undetected and a second one is piled on top of it.

- If orphans are found: the CLI prints the process list and a pointer to [troubleshooting.md](troubleshooting.md).
- Pass `--force` to skip the check and proceed anyway (also clears a stale pid file). Use only after manually verifying no conflicting daemons exist, or in CI scripts that need idempotent-start behaviour.

## File Locations

| File | Purpose |
|------|---------|
| `~/.claude-tempo/daemon.pid` | PID file written on daemon startup |
| `~/.claude-tempo/daemon.log` | Daemon log output |
| `~/.claude-tempo/daemon.heartbeat` | Touched every 60 s by the daemon; age reported by `daemon status` |
| `~/.claude-tempo/upgrade.log` | Progress log written by `claude-tempo upgrade` |
| `~/.claude-tempo/config.json` | Connection settings (see [configuration.md](configuration.md)) |
| `~/.claude-tempo/temporal-data.db` | Temporal dev server data (local dev only) |

## Troubleshooting

| Symptom | Fix |
|---------|-----|
| `workflow execution not found` errors | Restart the daemon: `claude-tempo daemon stop && claude-tempo daemon start` |
| Sessions not responding to messages | Run `claude-tempo daemon status` — ensure the daemon is running |
| `daemon start` aborts with "orphaned daemon processes" | Kill orphans manually (see [troubleshooting.md → Orphaned daemon processes](troubleshooting.md)); then `daemon start`. Or `daemon start --force` if you've already confirmed no conflicts. |
| `daemon status` reports stale heartbeat | The daemon's main loop may be hung — restart: `daemon stop && daemon start` |

See [troubleshooting.md](troubleshooting.md) for more.

## Related

- [cli.md](cli.md) — `daemon` subcommand reference
- [troubleshooting.md](troubleshooting.md) — stale sessions, upgrade notes, common issues
