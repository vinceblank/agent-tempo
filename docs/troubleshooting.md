# Troubleshooting

## Common Issues

| Symptom | Fix |
|---------|-----|
| `workflow execution not found` errors | Restart the daemon: `claude-tempo daemon stop && claude-tempo daemon start` |
| Sessions not responding to messages | Run `claude-tempo daemon status` — ensure the daemon is running |
| `.mcp.json` keeps being recreated with `npx` | Delete `.mcp.json` and use user-level registration: `claude-tempo init` |
| `claude-tempo daemon status` reports orphan processes | See **Orphaned daemon processes** below |
| Multiple `node` processes pinning `@temporalio/core-bridge/index.node` (npm uninstall blocked) | See **Orphaned daemon processes** below |

## Orphaned daemon processes

> Added in response to issue [#157](https://github.com/vinceblank/claude-tempo/issues/157) —
> users running on unsupported Node versions (or after a crashed daemon shutdown) may
> accumulate node processes pinned to `claude-tempo/dist/daemon.js`. The PID file
> (`~/.claude-tempo/daemon.pid`) can be missing even while daemons are still running,
> which means `claude-tempo daemon stop` is a no-op. The command-line-scan helper
> in `daemon status` now lists these, and this section documents the emergency
> escape hatches.

### Inspect

```bash
claude-tempo daemon status
```

If the daemon is tracked via the PID file, this lists any additional daemon processes
the scanner finds. If the PID file is absent but the scanner finds matches, they are
reported as orphans.

### Windows — PowerShell

```powershell
# List all claude-tempo daemon processes
Get-CimInstance Win32_Process -Filter "Name='node.exe'" |
  Where-Object { $_.CommandLine -match 'claude-tempo.*[\\/]dist[\\/]daemon\.js' } |
  Select-Object ProcessId, CommandLine |
  Format-List

# Kill all of them (after confirming the list above matches what you expect!)
Get-CimInstance Win32_Process -Filter "Name='node.exe'" |
  Where-Object { $_.CommandLine -match 'claude-tempo.*[\\/]dist[\\/]daemon\.js' } |
  ForEach-Object { Stop-Process -Id $_.ProcessId -Force }
```

### macOS / Linux — shell

```bash
# List
pgrep -af 'claude-tempo.*dist/daemon\.js'

# Kill (again: inspect first)
pkill -f 'claude-tempo.*dist/daemon\.js'
```

### After cleanup

```bash
rm -f ~/.claude-tempo/daemon.pid ~/.claude-tempo/daemon.pid.lock   # clear any stale file locks
claude-tempo daemon start                                          # spawn a single fresh daemon
claude-tempo daemon status                                         # verify orphan count is zero
```

Pattern match is narrow (`claude-tempo` + `dist/daemon.js` in the command line) so
these commands won't touch unrelated node processes. Review the list output before
running the kill variant.

## Stale Session Cleanup

When a session crashes or closes without graceful shutdown, Temporal detects it automatically:

Liveness is now tracked via the attachment-phase lifecycle (see below) instead of the
pre-v0.26 time-based heuristics (3-min stale, 5-min blocked). The adapter itself reports
liveness to the workflow via the `heartbeat` signal; the workflow reaps the attachment
if the lease expires. No message is force-undelivered or auto-re-routed — sessions that
lose their adapter transition to `detached` and wait for a fresh `claimAttachment`.

## Attachment Phase Lifecycle (v0.26+)

Each session workflow has an attachment phase tracked on the `ClaudeTempoAttachmentState`
search attribute and returned by the `attachmentInfo` query. The five user-facing buckets
the CLI and TUI render are derived from the seven underlying phases:

| Label | Phases | When you see it |
|-------|--------|-----------------|
| `active` (green) | `attached`, `processing` | Session is connected and responsive |
| `idle` (neutral) | `awaiting` | Attached, no work in flight, outbox drained |
| `pending` (dim) | `booting` | Workflow created, adapter hasn't claimed yet |
| `disconnected` (yellow) | `draining`, `detached` | Attachment reaped or in the middle of detaching; session is alive but unreachable until a fresh `claimAttachment` |
| `gone` (gray) | `gone` | Terminal — `destroy` has run, workflow is complete |

Phase transitions are deterministic and adapter-driven:
- **`booting → attached`** on first `claimAttachment` from the spawned adapter
- **`attached → processing`** on `processingStart` update (blocking LLM/tool call)
- **`processing → attached`** (or `awaiting`) on `processingEnd`
- **`attached → draining`** on `requestDetach` signal (graceful reap)
- **`draining → detached`** on `adapterExited` signal or `drainingDeadline` timeout
- **`detached → attached`** on a fresh `claimAttachment` (restart / migrate / recovery)
- **any → `gone`** on `destroyUpdate`

`claude-tempo status` shows `(pending)` / `(disconnected)` / `(gone)` labels next to player
names. Filter sessions in the Temporal UI via `ClaudeTempoAttachmentState = "detached"`.

> **Historical** — The pre-v0.26 `ClaudeTempoStatus` attribute (values `pending | active |
> stale | blocked | terminated`) was removed in v0.26. See
> [`docs/ops/v0.26-migration.md`](ops/v0.26-migration.md) for the operator upgrade path.

## Known Limitations

- **`recruit` requires manual acknowledgment** — Recruited sessions use `--dangerously-load-development-channels`. Claude Code shows a confirmation prompt that must be manually acknowledged in the spawned terminal. This will be resolved once claude-tempo is published as an approved channel plugin. Copilot bridge sessions do not have this limitation.

## Upgrading to v0.19.0

v0.19.0 introduces the **worker daemon** — a single background process that runs all Temporal workers instead of each session running its own. Old sessions running in-process workers will compete on the same task queue as the daemon, causing errors. A clean restart is required.

1. **Stop everything:**

   ```bash
   claude-tempo down --all
   ```

2. **Install the new version:**

   ```bash
   npm install -g claude-tempo@latest
   ```

3. **Fix MCP registration (if you previously used `npx`):**

   If you registered with `npx` (e.g. via `claude-tempo init` before v0.19.0):

   ```bash
   # Remove old registration
   claude mcp remove claude-tempo -s user

   # Re-register with the direct binary
   claude mcp add claude-tempo -s user -- claude-tempo-server
   ```

   If you have a project-level `.mcp.json` with `"command": "npx"`, either delete it or change the entry:

   ```json
   { "command": "claude-tempo-server", "args": [] }
   ```

4. **Start fresh:**

   ```bash
   claude-tempo up <ensemble>
   ```

   The daemon starts automatically — no manual daemon management needed.

## Terminal Support

`recruit` and the CLI detect your terminal automatically:

| Terminal | macOS | Linux | Windows |
|----------|-------|-------|---------|
| Ghostty | ✓ | — | — |
| iTerm2 | ✓ | — | — |
| Terminal.app | ✓ | — | — |
| gnome-terminal | — | ✓ | — |
| konsole / xterm | — | ✓ | — |
| Windows Terminal | — | — | ✓ (tabs) |
| cmd.exe / PowerShell | — | — | ✓ |

macOS terminals preserve the full shell environment (fish, zsh, bash) including node version managers (fnm, nvm).

Windows Terminal is detected automatically via the `WT_SESSION` environment variable. When running inside Windows Terminal, recruited sessions open as new tabs (with the player name as the tab title) instead of separate cmd.exe windows.

## Related

- [daemon.md](daemon.md) — daemon management and log locations
- [cli.md](cli.md) — `preflight` command to verify environment
