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

> **Automatic reaping (commit `5399945`):** `claude-tempo daemon stop` now automatically
> reaps zombie daemon processes left over from a crash — no manual `taskkill`/`kill` needed
> in most cases. Fall back to the steps below only if `daemon stop` itself fails or exits
> while processes remain.

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

Alternatively, once orphans are killed and the pid file is cleared, `daemon start --force` is a one-step shortcut — it bypasses the orphan pre-flight check and removes any stale pid file before spawning:

```bash
claude-tempo daemon start --force
```

Pattern match is narrow (`claude-tempo` + `dist/daemon.js` in the command line) so
these commands won't touch unrelated node processes. Review the list output before
running the kill variant.

## Crash-proof subcommands (recovery levers under broken Temporal SDK)

Some CLI subcommands are engineered to work even when the Temporal SDK itself
fails to load — for example, when upgrading across Node-version breakage or
recovering from a corrupted native-dep build. These bypass `src/cli/commands`
(which statically imports `@temporalio/client`) and route through minimal
dedicated modules before any heavy import fires.

| Subcommand | Crash-proof under broken Temporal SDK? | Notes |
|---|---|---|
| `claude-tempo version` / `-v` / `--version` | ✅ Yes | Reads `package.json.version` directly |
| `claude-tempo help` / `-h` / `--help` | ✅ Yes | Static help text (`src/cli/help-text.ts`) |
| `claude-tempo daemon <sub>` (`start`, `stop`, `status`, `logs`, `install`, `uninstall`) | ✅ Yes | `src/cli/daemon-command.ts` |
| `claude-tempo upgrade [version]` | ✅ Yes | Temporal used dynamically for the *optional* active-session warning; silently skipped on SDK failure |
| `claude-tempo config show` / `config set` | ✅ Yes | Pure fs / zod |
| `claude-tempo config` (interactive) | ✅ Mostly | Connection-test step uses dynamic Temporal import; the rest of the flow (prompts, file writes) is crash-proof |
| `claude-tempo preflight` | ❌ No | Intentional — preflight's job is to test Temporal reachability |
| `claude-tempo attachment-info <name>` | ❌ No | Queries a workflow directly; requires live Temporal |
| All other verbs (`start`, `stop`, `status`, `restart`, `detach`, `destroy`, `migrate`, `restore`, `pause`, `resume`, `release`, `broadcast`, `server`, `up`, `down`, `init`, …) | ❌ No | Inherently Temporal-touching |

If you hit a broken SDK scenario and need to recover:

```bash
claude-tempo version                # confirms CLI loads at all
claude-tempo daemon stop            # halt the broken daemon
claude-tempo upgrade                # reinstall latest
claude-tempo daemon start           # fresh daemon on repaired SDK
```

The `test/cli-crash-proof-isolation.test.ts` suite enforces this contract in
CI — any static import of `@temporalio/*` / `rxjs` / `@grpc/*` / `nice-grpc`
sneaking into the crash-proof modules fails the build.

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

## Dev mode

### Dev daemon connects to wrong namespace

**Symptom**: The dev banner prints `namespace claude-tempo-dev` but the daemon log says `Connecting to Temporal at localhost:7233 (namespace: default)`. Workflows and workers end up on the wrong namespace.

**Diagnosis**: Run `node dist/cli.js --dev config show` to see resolved values with source annotations. The banner now reads from the same resolved config, so a disagreement is immediately visible — look for `(env)` next to any field:

```
[DEV MODE] using ~/.claude-tempo-dev · port 8474 · namespace default (env) · queue claude-tempo-dev (default)
```

`(env)` means a shell environment variable overrode the dev default.

**Common causes and fixes**:

| Cause | Fix |
|-------|-----|
| `TEMPORAL_NAMESPACE=default` set in shell rc (`.bashrc`, `.zshrc`, PowerShell profile) | Post-#423, dev mode ignores this var automatically. If you're on an older build, `unset TEMPORAL_NAMESPACE` before running dev commands. |
| `~/.claude-tempo-dev/config.json` has `temporalNamespace` set to prod value | Edit or delete the file: `rm ~/.claude-tempo-dev/config.json`. |
| Explicit `--temporal-namespace` CLI flag pointing at wrong namespace | Omit the flag; the dev default fills in. |

The daemon also emits a boot-time warning to `~/.claude-tempo-dev/daemon.log` if the resolved namespace differs from `claude-tempo-dev` — grep `[dev-mode] WARNING` for it.

### `down` command refuses to kill Temporal server

**Symptom**: `claude-tempo --dev down` finishes but prints:

```
⚠ Temporal server kept running — the prod profile appears active. Pass --kill-shared-temporal to override.
```

**Explanation**: Dev and prod share the same Temporal dev server process (both connect to `localhost:7233` on different namespaces). `--dev down` detects the prod profile is alive (via PID file or port file) and skips the Temporal kill to avoid disconnecting the prod daemon. This is intentional — the isolation guarantee per ADR 0014 §5.6.

**Remedies**:

- **Normal teardown**: leave it. The dev daemon and its workers are stopped; the shared Temporal server keeps running for prod. This is correct.
- **Hard reset** (you want to kill everything, including prod): `node dist/cli.js --dev down --kill-shared-temporal`. ⚠️ This will disconnect the prod daemon from Temporal.
- **Prod-only teardown of Temporal**: `claude-tempo down` (prod mode, no `--dev`) — this has the same cross-profile guard and will skip the kill if dev is alive.

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
