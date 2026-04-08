# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/),
and this project adheres to [Semantic Versioning](https://semver.org/).

## [0.20.1] - 2026-04-08

### Fixed

- `claude-tempo up` now detects an existing running conductor and prompts with options: join as player, reconnect, tear down and start fresh, or cancel. Prevents two sessions from silently sharing the same Temporal workflow (#85)

## [0.20.0] - 2026-04-08

### Added

- `claude-tempo upgrade [version]` command for graceful self-update — stops daemon, installs new version, restarts daemon (#79, #82)
- Complete TUI rewrite — multi-ensemble home screen, view router, adaptive polling (#58)
- TempoClient API layer replacing core-api.ts with Maestro-first fallback (#58)
- 10 new components: ChatView, CommandPalette, ErrorView, MainView, Picker, PromptArea, RecruitWizard, ScheduleWizard, StatusBar, TitleBar (#58)
- Slash command system with parser, registry, tab completion, persistent history (#58)
- Two-way conductor chat via Global Maestro relay (#58)
- Interactive wizards for recruiting and scheduling (#58)
- Message search, scrollback navigation, player detail view (#58)
- Splash screen with connection checklist (#58)
- `claude-tempo tui` as default CLI command (#58)

### Changed

- `down` command now always stops the daemon, requires confirmation when no ensemble is specified, and exits with code 1 in non-TTY environments (#78, #83)

### Fixed

- `load_lineup` MCP tool now resolves shipped example lineups by name, in addition to saved lineups and file paths (#80, #81)
- Blocked detection no longer triggers on informational messages — broadcasts, schedule-fires, heartbeats, and system notifications now set `responseRequested: false`, preventing false positives (#75, #66)
- TUI input lag eliminated — animation timers removed, Yoga nodes flattened, stale ref fix (#58)
- Live message lists capped at ~20 entries to prevent render slowdown (#58)

## [0.19.0] - 2026-04-07

### Fixed

- Schedule targets now validated against player names at lineup load time; mismatches warn instead of silently failing (#74)
- `set_name` propagates renames to scheduler via new `updateScheduleTarget` signal (#74)
- `schedule` tool validates target player exists at creation time (#74)
- Conductor no longer blocks player recruitment on 15s timeout — workflow pre-created before spawn (#56)
- `load_lineup` migrated to outbox recruit pattern — eliminates spawn+poll loops (#56)

## [0.19.0-beta.0] - 2026-04-06

### Added

- **Global Maestro** — single `claudeGlobalMaestroWorkflow` (ID: `claude-maestro-global`) spanning all ensembles. Full inbox/outbox relay for third-party dashboards: 4 poll queries, 3 on-demand updates, 1 command relay. Daemon auto-starts it on boot. (#61)
- **Worker Daemon** — standalone background process (`src/daemon.ts`) running Temporal workers. Sessions are now pure MCP clients. Auto-starts on first use; PID at `~/.claude-tempo/daemon.pid`, logs at `~/.claude-tempo/daemon.log`. Managed via `claude-tempo daemon start|stop|status|logs`. (#57)
- Beta release workflow — prerelease tags publish to npm `beta` dist-tag.

### Changed

- Sessions no longer run in-process Temporal workers — all worker duties delegated to the daemon.

## [0.18.0] - 2026-04-06

### Added

- **Pipeline Stages** — Conductors can track fan-out/fan-in of parallel work via `stage`, `stages`, and `cancel_stage` tools. Define a stage with player names, cue the players, and the workflow auto-notifies when all players report. Supports `halt` (fail on first blocker) and `continue` (wait for all) failure policies. (#26)

### Fixed

- Ensemble MCP tool now displays `(blocked)` status tag (was already detected but not rendered)

## [0.17.1] - 2026-04-05

### Fixed

- **`load_lineup` conductor section** — `load_lineup` MCP tool now correctly applies the `conductor` section of YAML lineups, recruiting the conductor player as expected (#48)

## [0.17.0] - 2026-04-05

### Added

- **Maestro workflow** — durable `claudeMaestroWorkflow` that runs alongside the conductor, monitoring ensemble state in real time: tracks player joins/leaves, status changes (`active`/`stale`/`blocked`), and part updates. Accessible via Maestro signals/queries/updates (#45)
- **`scanEnsembleSessions` shared helper** — centralises Temporal ensemble querying, used by both the Maestro workflow and the `ensemble` MCP tool
- **Branch coordination rules** — conductor and player instructions injected at server startup, reminding conductors to provision worktrees and players to check their assigned branch before starting work
- **Wire protocol** — Maestro workflow signals, queries, and updates documented in `docs/WIRE-PROTOCOL.md`

## [0.16.3] - 2026-04-05

### Fixed

- **Copilot bridge graceful shutdown** — Bridge process now watches workflow status via Temporal query and terminates cleanly when the session ends, fixing a PID file leak on exit (#13)

## [0.16.2] - 2026-04-05

### Fixed

- **Flaky CI test** — `saveLineup` test now waits for Temporal search index to index the new workflow before querying, fixing a race condition that caused intermittent CI failures

## [0.16.1] - 2026-04-05

### Fixed

- **Conductor false-blocked detection** — `commandSignal` handler now updates `lastOutboundTime`, preventing conductors from being incorrectly marked `blocked` when processing Maestro commands
- **Docs** — Added `broadcast` and `encore` CLI commands to README reference table

## [0.16.0] - 2026-04-05

### Added

- **`blocked` session status** — Sessions that receive delivered messages but produce no outbound activity for 5+ minutes are automatically marked `blocked`. Auto-recovers to `active` when the session resumes output. Blocked sessions are excluded from broadcast (#34)

### Fixed

- **Encore session UUID** — Encore previously passed the player name to `--resume`, which triggers an interactive picker when multiple Claude Code sessions share a name. Now generates a UUID at recruit time (`--session-id`) and uses it for deterministic `--resume` on encore. Falls back to player name for legacy sessions (#44)

## [0.15.0] - 2026-04-05

### Added

- **`worktree` MCP tool** — Conductors can provision isolated git worktrees for players. `create` checks out a new branch in a sibling directory, installs dependencies, and notifies the player with the path; `remove` cleans up the worktree after the task completes and notifies the player; `list` shows all active worktree assignments. Worktree state is stored in the conductor workflow (`WorktreeEntry`) and survives `continueAsNew`. Cross-machine worktrees are not supported — conductor and player must be on the same host (#36).

### Changed

- Lineup player schema no longer accepts `isolation`/`branch` fields — worktree provisioning is now done via the `worktree` tool at the conductor level rather than inline at lineup load time

## [0.14.0] - 2026-04-05

### Added

- **Worktree isolation** — Lineup players support `isolation: worktree` (with a required `branch` field). When set, `load_lineup` auto-creates a git worktree and runs `npm install` before recruiting (#36)

### Fixed

- **`down` command scoping** — The `down` command previously ignored the ensemble argument and terminated all running workflows across all ensembles. Now filters by `ClaudeTempoEnsemble` search attribute and validates the ensemble name to prevent query injection (#37)

## [0.13.1] - 2026-04-05

### Fixed

- **Conductor naming** — Four locations hardcoded `'conductor'` as the player name, ignoring lineup and CLI overrides. Conductor name now flows correctly through `schema → loader → CLI → server`. Also fixes a latent bug where default conductors were unnecessarily prompted to call `set_name` (#39)

## [0.13.0] - 2026-04-05

### Added

- **Quality Gates** — Conductors can define named checklists of pass/fail criteria to track task completion. Three new MCP tools: `quality_gate` (create or replace a gate), `evaluate_gate` (mark criteria as passed or failed), and `gates` (list all gates, filterable by task or status). Gate aggregate status is derived automatically: all passed → `passed`; any failed → `failed`; otherwise `open`. Gates survive `continueAsNew`.

## [0.12.0] - 2026-04-05

### Added

- **Cron schedule support** — The `schedule` tool now accepts a `cron` parameter (e.g. `"0 9 * * 1-5"`) alongside an optional `timezone` (IANA, e.g. `"America/New_York"`). Cron schedules use `croner` for expression parsing and next-fire computation. `ScheduleEntry.type` gains a new `'cron'` value; `cronExpression` and `timezone` fields are stored on the entry.
- **`allowedTools` agent type frontmatter** — Agent type `.md` files may include an `allowedTools` array to restrict which tools a recruited session can use. Resolved by `agent_types` and passed through `RecruitOutboxEntry` to the spawn activity, which appends `--allowedTools` to the Claude Code launch command. The type's value is authoritative and overrides any lineup-level setting.

### Fixed

- **`at` + `every` schedule combination** — Specifying both `at` and `every` now correctly returns a validation error ("provide exactly one timing option") instead of silently ignoring `at`.

## [0.11.1] - 2026-04-05

### Changed

- Version bump to correct release sequencing — `0.11.0` was published prematurely (before the feature PR merged). This `0.11.1` release contains all the same changes as the intended `0.11.0` and is the canonical release of the broadcast/encore/recall feature set.

## [0.11.0] - 2026-04-05

### Added

- **`broadcast` MCP tool** — Send a message to all active players in the ensemble with a single call. Fan-out is implemented via outbox entries, so each delivery is individually durable. Optional `type` parameter limits recipients to a specific player type (e.g., `"tempo-soloist"`). Optional `includeStale` flag extends delivery to stale sessions (pending and terminated sessions are always excluded).
- **`encore` MCP tool** — Revive a stale player session. Restarts the Claude process and reconnects to the existing Temporal workflow, restoring recent message context (configurable via `contextMessages`, default 10). Validates session status before submitting — returns a clear error if the target is active (use `cue`), pending (wait), or terminated (use `recruit`). Cross-machine encore supported via the optional `host` parameter.
- **`recall` MCP tool** — Read your own message history from the Temporal workflow. Returns received messages by default (newest first, limit 20). Supports `includeSent: true` for a merged sent/received timeline, plus `limit` (max 100), `since` (ISO timestamp), and `from` (sender name) filters.
- **`EncoreOutboxEntry` type** — New outbox entry type (`type: 'encore'`) carrying `targetPlayerId`, optional `targetHostname`, and optional `contextMessageCount`. Processed by the outbox dispatch loop via a new encore activity.

## [0.10.0] - 2026-04-04

### Added

- **Player types** — Reusable agent definitions using Claude Code's standard subagent format (`.md` files with YAML frontmatter). Ensemble lineups can reference player types by name via a `type` field on players.
- **Three-tier agent type lookup** — project (`.claude/agents/`) → user (`~/.claude/agents/`) → shipped (`examples/agents/`). If found in Claude Code's standard dirs, recruits use `--agent <name>`; shipped examples fall back to `--system-prompt <path>`.
- **`who_am_i` MCP tool** — Players can query their own identity: name, player type, description, ensemble, role (conductor/player), recruited by, current part, directory, host, branch, and status.
- **`agent_types` MCP tool** — Conductors can discover available player types with name, description, and source (project/user/shipped).
- **`recruit` tool `type` parameter** — Recruit with `type: "tempo-composer"` to spawn a session using a predefined agent definition. Resolves and validates the type, passes through to the spawn flow.
- **Player identity in metadata** — `playerType`, `playerTypeDescription`, and `recruitedBy` fields on `SessionMetadata`, persisted in Temporal workflows and search attributes.
- **`ensemble` tool shows player types** — Output includes player type in parens, e.g., `**arch** (architect)`.
- **CLI `agent-types` command** — `list` (show available types), `show <name>` (print full definition), `init` (copy shipped examples to `~/.claude/agents/` for customization).
- **Saver preserves player types** — `save_lineup` includes `type` field in saved YAML for typed players.
- **Shipped player types** — 8 music-themed agent definitions: tempo-conductor (coordinator), tempo-composer (architect), tempo-soloist (engineer), tempo-tuner (QA), tempo-critic (reviewer), tempo-roadie (devops), tempo-improv (researcher), tempo-liner (documentation). All include opinionated Ensemble Collaboration sections with claude-tempo tool usage patterns.
- **Shipped ensemble lineups** — 4 pre-built team compositions: tempo-big-band (flagship full-lifecycle with all 8 player types, 6-phase pipeline), tempo-dev-team (feature development), tempo-review-squad (parallel code review), tempo-jam-session (exploratory/spike work).

### Changed

- `load_lineup` tool and `up --lineup` CLI now resolve player type references via `loadAndResolveLineup()`.
- MCP server instructions now include player type info when available.
- `examples/` directory included in npm package.

### Migration

- **Backward compatible**: the `type` field on players is optional. Existing lineups without `type` work unchanged. Players recruited without a type behave exactly as before.

## [0.9.0] - 2026-04-04

### Added

- **Outbox pattern** — MCP tools (`cue`, `report`, `stop`, `recruit`) no longer signal other workflows directly. Instead, they submit entries to the session's own workflow outbox via `executeUpdate`. A dispatch loop processes entries through activities, decoupling tools from cross-workflow signaling.
- **Cross-machine recruiting** — the `recruit` tool now accepts an optional `host` parameter to spawn sessions on a remote machine. Spawn activities are routed to per-host task queues (`claude-tempo-{hostname}`).
- **Per-host task queues** — dual worker architecture: a shared `claude-tempo` queue (workflows + delivery activities) and a per-host `claude-tempo-{hostname}` queue (`spawnProcess` activity only).
- **Outbox activity layer** (`src/activities/outbox.ts`) — `deliverCue`, `deliverReport`, `terminateSession`, `startRecruitedSession`, and `spawnProcess` activities handle all cross-workflow delivery.
- **`submitOutbox` workflow update** and **`outbox` query** for inspecting outbox state.

### Changed

- `cue`, `report`, `stop`, and `recruit` tools simplified — each is now validation + a single `executeUpdate` call.
- `report` tool no longer requires `client`, `config`, or `getPlayerId` parameters.
- `recruit` tool no longer spawns processes or polls for startup directly — this is handled asynchronously by the outbox dispatch loop.
- Outbox entries carry through `continueAsNew` (pending/processing entries only).

### Migration

- **Backward compatible**: all existing signals (`receiveMessage`, `playerReport`, `updateMetadata`, etc.) are preserved. Old clients can still signal workflows directly alongside the new outbox path.

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

- **Ensemble lineups** — define reusable ensemble configurations as YAML files with players, instructions, schedules, and custom agents. Lineups can be loaded from the CLI (`claude-tempo up --lineup`), from inside a session (`load_lineup`), or saved from a running ensemble (`save_lineup`).
- **`save_lineup` MCP tool** — snapshot the current ensemble state (players, schedules) as a YAML lineup file. Conductor only.
- **`load_lineup` MCP tool** — load a lineup to recruit players sequentially and create schedules. Accepts a saved lineup name or explicit file path.
- **`claude-tempo up --lineup`** — load an ensemble lineup during first-time setup.
- **`claude-tempo ensemble` CLI commands** — `save`, `list`, and `show` subcommands for managing saved lineups in `~/.claude-tempo/ensembles/`.
- **`systemPrompt` parameter on recruit tool** — pass a path to a `.md` file to use as the session's custom agent system prompt (`--system-prompt`). Enables custom agent files in lineups.
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
