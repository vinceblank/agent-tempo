# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/),
and this project adheres to [Semantic Versioning](https://semver.org/).

## [0.8.0] - 2026-04-04

### Added

- **Pre-created workflows for recruits** — the conductor now creates the recruit's Temporal workflow with the initial message pre-loaded before spawning the process. This eliminates the race condition where slow-starting sessions (e.g., delayed by the dev channels prompt) would miss their initial instructions.
- **Session status lifecycle** — sessions now have a `status` field (`pending` → `active` → `stale`). Stale sessions stay alive instead of being terminated, preserving workflow state for resume. Status is visible via `ClaudeTempoStatus` search attribute in Temporal UI.
- **Windows Terminal tabs** — on Windows, recruited sessions open as new tabs in the current Windows Terminal window instead of separate cmd.exe windows. Tab titles show the player name.
- **`updateMetadata` signal** — sessions signal updated metadata (hostname, git info, status) when connecting, enabling conductor-created workflows to be updated with runtime details.

### Changed

- **Renamed `terminate` MCP tool to `stop`** — aligns with the CLI `stop` command. Both now use the same `updateMetadata({ status: 'terminated' })` mechanism.
- **Unified shutdown path** — removed the separate `shutdownSignal`. All shutdown (MCP `stop`, CLI `stop`, SIGINT) goes through `status: 'terminated'`. The workflow adds a termination message, waits for delivery, then completes.
- `claude-tempo status` now shows `(pending)` and `(stale)` indicators next to player names.
- Stale session detection no longer terminates workflows — marks status as `stale` instead.
- Pre-created workflows in `pending` status automatically transition to `stale` if the session doesn't connect within 3 minutes.


## [0.7.0] - 2026-04-04

### Added

- **Ensemble blueprints** — define reusable ensemble configurations as YAML files with players, instructions, schedules, and custom agents. Blueprints can be loaded from the CLI (`claude-tempo up --from`), from inside a session (`load_ensemble`), or saved from a running ensemble (`save_ensemble`).
- **`save_ensemble` MCP tool** — snapshot the current ensemble state (players, schedules) as a YAML blueprint file. Conductor only.
- **`load_ensemble` MCP tool** — load a blueprint to recruit players sequentially and create schedules. Accepts a saved blueprint name or explicit file path.
- **`claude-tempo up --from`** — load an ensemble blueprint during first-time setup.
- **`claude-tempo ensemble` CLI commands** — `save`, `list`, and `show` subcommands for managing saved blueprints in `~/.claude-tempo/ensembles/`.
- **`systemPrompt` parameter on recruit tool** — pass a path to a `.md` file to use as the session's custom agent system prompt (`--system-prompt`). Enables custom agent files in blueprints.
- **`target: "all"` schedule fan-out** — schedules can target `"all"` to deliver a message to every active player in the ensemble, skipping the conductor. Individual delivery failures are reported without failing the whole fire.

## [0.6.0] - 2026-04-03

### Added

- **Scheduling** — new `schedule`, `unschedule`, and `schedules` MCP tools for dynamic message scheduling. Supports one-shot delays (`delay: "10m"`), fixed times (`at: "2026-04-04T01:00:00Z"`), and recurring intervals (`every: "1h"`) with optional bounds (`until`, `count`). Uses a single durable `claudeSchedulerWorkflow` per ensemble with Temporal timers and `continueAsNew`. Scheduled messages use `[scheduled: name]` prefix and set `from` to the creator for natural reply semantics. Includes `isScheduled` metadata for dashboard integrations.
- **Schedule failure notifications** — when a target player is not found at fire time, the schedule creator is notified. Falls back to the conductor if the creator is also unavailable.
- **`claude-tempo status` shows schedules** — the status command now displays active schedules alongside session info per ensemble.

### Fixed

- **Recruited sessions no longer rename themselves** — the recruit tool previously sent a redundant `set_name` instruction via signal, which could cause the LLM to rename itself incorrectly if confused by concurrent messages. The name is now fully set via env var at startup, and MCP instructions tell pre-named sessions not to call `set_name`.

## [0.5.0] - 2026-04-03

### Fixed

- **Session discovery uses metadata queries instead of search attributes** — ensemble listing, session resolution, and CLI status/stop commands now query workflow metadata directly instead of relying on custom search attributes (`ClaudeTempoEnsemble`, `ClaudeTempoPlayerId`), which are eventually consistent and could be stale or missing. This fixes a bug where sessions (particularly conductors reconnecting via `WorkflowIdConflictPolicy.USE_EXISTING`) were invisible to the ensemble.
- **Recruit env var leakage** — recruited sessions no longer inherit the parent's `CLAUDE_TEMPO_CONDUCTOR` and `CLAUDE_TEMPO_PLAYER_NAME` env vars. Previously, a conductor recruiting a player would pass its own identity to the child, causing it to think it was the conductor.
- **Recruit sets `PLAYER_NAME`** — the recruit tool now passes the requested name via env var so the spawned session starts with the correct identity immediately, rather than relying on a `set_name` message the LLM may not act on.
- **"conductor" name collision guard** — non-conductor sessions are prevented from using "conductor" as a player name, which would collide with the conductor's deterministic workflow ID.
- **Terminate uses graceful shutdown** — the `terminate` tool now sends a shutdown signal instead of force-killing the workflow, and notifies the target session before shutting it down.
- Workflow upserts all search attributes at startup to keep the Temporal UI accurate, even when reconnecting to an existing workflow.

### Added

- **`conduct --resume` / `--replace`** — when a conductor is already running, `claude-tempo conduct` now requires an explicit choice: `--resume` reconnects to the existing workflow and resumes the Claude Code conversation, `--replace` stops the existing conductor and starts fresh.
- **`conductor` parameter on recruit tool** — explicitly controls whether the recruited session is a conductor, rather than relying on env var inheritance.
- **Test suite** — 33 tests using Temporal's `TestWorkflowEnvironment` with mocha. Covers workflow lifecycle, signals, queries, conductor behavior, multi-session ensemble discovery, session resolution after rename, conductor resume/replace, workflow ID collision, and end-to-end coordination scenarios.

### Changed

- Upgraded `@temporalio/*` packages from 1.11.7 to 1.15.0.
- Upgraded mocha to v11.

### Removed

- `sanitizeQueryValue` helper (no longer needed — visibility queries no longer include user-supplied values).

## [0.4.1] - 2026-04-02

### Added

- **`isMaestro` message flag** — messages sent from the Maestro dashboard carry `isMaestro: true`, signaling to agents that a human sent the message. Agents automatically receive an instruction to acknowledge receipt and share their planned next step.
- **Heartbeat probe** for orphaned session detection — workflows inject a `_ping` message after 1 hour of inactivity; if undelivered within the stale window, the session exits.
- **`stop` command** — stop sessions by name (`-n`), by ensemble, or all at once (`--all`). Sends graceful shutdown signals and cleans up bridge PID files.
- **`defaultAgent` config** — set a default agent type (`claude` or `copilot`) via `claude-tempo config set default-agent copilot`, `CLAUDE_TEMPO_DEFAULT_AGENT` env var, or `--agent` flag.
- **Global MCP registration** — `claude-tempo init` now registers globally via `claude mcp add` (use `--project` for per-directory `.mcp.json`).

### Changed

- Removed 24-hour workflow execution timeout — workflows now live until shutdown signal or stale detection.
- `continueAsNew` triggers only on `continueAsNewSuggested` (Temporal best practice), not arbitrary history length.
- `down` command now cleans up bridge PID files and removes both global and project-level MCP config.
- Revamped experimental Copilot CLI section in README to focus on CLI commands.

### Fixed

- `isGlobalMcpRegistered` uses word-boundary regex to avoid false-positives on similarly-named MCP servers.
- `defaultAgent` validated from all sources (env var, config file) — invalid values fall back to `claude`.

## [0.3.0] - 2026-04-01

### Added

- **`config` command** — interactive setup for Temporal connection settings (`claude-tempo config`), plus `config set` / `config show` for scripting. Settings persist in `~/.claude-tempo/config.json`.
- **Temporal Cloud support** — configure address, namespace, and API key via `config`, env vars, or CLI flags.
- **Temporal CLI config fallback** — reads `~/.config/temporalio/temporal.yaml` automatically so existing Temporal CLI users don't need to reconfigure.
- **`connection` subpath export** — `claude-tempo/connection` exposes `createTemporalConnection` for external consumers.
- **Agent type in session metadata** — `agentType` field on `SessionMetadata`; displayed as `[copilot]` tag in `status` and `ensemble` output.
- **Recruit inherits agent type** — Copilot sessions recruit copilot agents by default; Claude sessions recruit claude agents.
- **Config source display** — `config show` displays which source each value came from (flag, env, config, temporal-cli, default).

### Changed

- README overhauled for clarity: installation, quick start, core concepts, CLI reference, MCP tools, conductors, players. Copilot bridge docs collapsed into a `<details>` block.
- `-d` shorthand now maps to `--dir` (was `--background`).

### Fixed

- Child processes always receive `TEMPORAL_ADDRESS` and `TEMPORAL_NAMESPACE` env vars, even when they match defaults.
- `recruit` forwards Temporal address and namespace to child sessions.
- Copilot bridge clears parent env vars (`CLAUDE_TEMPO_PLAYER_NAME`, `BRIDGE_MODE`, `CONDUCTOR`) when spawning children.
- Config file permissions set to `0600` on Unix (matches credential file conventions).
- TLS fallback uses `tls: true` for API key auth instead of `tls: {} as any`.

## [0.2.0] - 2026-03-31

### Added

- **Copilot CLI bridge** — GitHub Copilot CLI sessions can now join ensembles via the `@github/copilot-sdk`. The bridge spawns a Copilot session with claude-tempo as an MCP server and polls Temporal for messages.
- `--agent <claude|copilot>` CLI flag for `start` and `conduct` commands to select the agent backend.
- `agent` parameter on the `recruit` tool to spawn Copilot players from within an ensemble.
- Shell shortcuts for launching Copilot bridge sessions (documented in README).
- Session crash recovery — bridge tracks consecutive failures and attempts to recreate the Copilot session (up to 2 times) before exiting.
- `createSession` timeout (45s) prevents indefinite hangs on auth/network failures.
- PID file (`logs/{name}.pid`) for detached bridge processes, cleaned up on graceful shutdown.
- `engines` field in package.json (`node >=18`); Copilot features require Node 20+.
- `repository` field in package.json for npm package page linking.

### Changed

- `recruit` tool description updated to mention Copilot support.
- Bridge uses deterministic workflow IDs via `CLAUDE_TEMPO_PLAYER_NAME` env var, eliminating the time-window heuristic that could misidentify workflows when multiple bridges start simultaneously.

### Fixed

- Missing `TEMPORAL_ADDRESS` env var when `recruit` spawns a copilot bridge subprocess.
- `sessionAlive` flag now resets to `true` on successful interactions (was permanently stuck on `false` after transient errors).
- `process.env` spread no longer uses unsafe `as Record<string, string>` cast; undefined values are filtered out.
- Log file descriptor leak in CLI — `closeSync` now runs in a `finally` block so the fd is closed even if spawn fails.
- Lockfile inconsistency — `@github/copilot-sdk` correctly listed only in `optionalDependencies`.
- `--agent` flag documented for both `start` and `conduct` in README (was listed as "start only").

### Security

- Documented why `approveAll` permission handler is used in the bridge (headless session with no interactive terminal).

## [0.1.3] - 2026-03-28

### Added

- Explicit package exports for `types`, `config`, `spawn`, and `signals` subpaths.

## [0.1.2] - 2026-03-27

### Added

- CLI tool (`claude-tempo`) with commands: `up`, `conduct`, `start`, `status`, `server`, `init`, `down`, `preflight`.
- Cross-platform terminal spawning (Windows, macOS, Linux).

### Fixed

- Windows terminal spawning and npx MCP resolution.
- Player naming via `CLAUDE_TEMPO_PLAYER_NAME` env var.

## [0.1.1] - 2026-03-26

### Added

- Outbound message tracking (`recordSentMessage` signal, `allSentMessages` query).
- Stale session detection toggle (`disableStaleDetection` input flag).
- Conductor history persistence across `continueAsNew`.

### Fixed

- Server skips Temporal connection when `CLAUDE_TEMPO_ENSEMBLE` is not set.

## [0.1.0] - 2026-03-25

### Added

- Initial release: MCP server for multi-session Claude Code coordination via Temporal.
- Workflow-backed sessions with signals (`receiveMessage`, `setPart`, `setName`, `shutdown`) and queries (`getPart`, `getMetadata`, `pendingMessages`).
- Tools: `ensemble`, `cue`, `set_name`, `set_part`, `listen`, `recruit`, `report`, `terminate`.
- Conductor role with command/report history.
- Channel-based message delivery for Claude Code sessions.
