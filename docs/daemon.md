# Worker Daemon

The **worker daemon** is a standalone background process that runs Temporal workers — it replaces the per-session workers from earlier versions. Sessions are now pure MCP clients.

The daemon auto-starts the first time any claude-tempo command needs it. You can also manage it explicitly:

```bash
claude-tempo daemon start    # start the daemon (no-op if already running)
claude-tempo daemon stop     # stop the daemon
claude-tempo daemon status   # show running state and PID
claude-tempo daemon logs     # tail daemon logs
```

## How It Works

- On first use, any claude-tempo command calls `startDaemon()` and waits up to 10 seconds for it to confirm startup (by writing `~/.claude-tempo/daemon.pid`)
- The daemon runs detached — it survives terminal closes and session restarts
- All Temporal worker duties (workflow execution, activity dispatch) run in the daemon
- Logs are written to `~/.claude-tempo/daemon.log`
- On Linux/macOS, the daemon is stopped via `SIGTERM`; on Windows, the process is killed directly

## File Locations

| File | Purpose |
|------|---------|
| `~/.claude-tempo/daemon.pid` | PID file written on daemon startup |
| `~/.claude-tempo/daemon.log` | Daemon log output |
| `~/.claude-tempo/config.json` | Connection settings (see [configuration.md](configuration.md)) |
| `~/.claude-tempo/temporal-data.db` | Temporal dev server data (local dev only) |

## Troubleshooting

| Symptom | Fix |
|---------|-----|
| `workflow execution not found` errors | Restart the daemon: `claude-tempo daemon stop && claude-tempo daemon start` |
| Sessions not responding to messages | Run `claude-tempo daemon status` — ensure the daemon is running |

See [troubleshooting.md](troubleshooting.md) for more.

## Related

- [cli.md](cli.md) — `daemon` subcommand reference
- [troubleshooting.md](troubleshooting.md) — stale sessions, upgrade notes, common issues
