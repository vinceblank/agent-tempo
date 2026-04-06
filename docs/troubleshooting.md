# Troubleshooting

## Common Issues

| Symptom | Fix |
|---------|-----|
| `workflow execution not found` errors | Restart the daemon: `claude-tempo daemon stop && claude-tempo daemon start` |
| Sessions not responding to messages | Run `claude-tempo daemon status` — ensure the daemon is running |
| `.mcp.json` keeps being recreated with `npx` | Delete `.mcp.json` and use user-level registration: `claude-tempo init` |

## Stale Session Cleanup

When a session crashes or closes without graceful shutdown, Temporal detects it automatically:

- If a message to a dead session remains undelivered for **3 minutes**, the workflow self-completes
- Before exiting, it notifies the conductor with the undelivered message so work can be reassigned
- Idle sessions with no pending messages are probed after 1 hour of inactivity via a heartbeat ping; if the ping goes undelivered, the session self-completes

No manual cleanup needed — `cue` a dead player and the system handles the rest.

## Session Status Lifecycle

Each session has a status that tracks its connection state:

| Status | Meaning |
|--------|---------|
| `pending` | Workflow created by `recruit`, but the Claude Code process hasn't connected yet |
| `active` | Session is running and responsive |
| `stale` | Messages have gone undelivered for 3+ minutes — the session is likely disconnected |
| `blocked` | Messages are being delivered but the session has produced no outbound activity for 5+ minutes — it may be stuck or spinning |

Status transitions:
- **`pending` → `active`** — when the spawned session connects and sends its `updateMetadata` signal
- **`active` → `stale`** — when undelivered messages exceed the stale threshold (3 minutes)
- **`active` → `blocked`** — when delivered messages produce no outbound response for 5+ minutes; auto-recovers to `active` on next outbound activity
- Any status → **terminated** — on graceful shutdown or `stop`

`claude-tempo status` shows `(pending)` and `(stale)` indicators next to player names. The `ClaudeTempoStatus` search attribute is also set, so you can filter sessions by status in the Temporal UI (e.g., `ClaudeTempoStatus = "stale"`).

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
