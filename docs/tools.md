# MCP Tools Reference

These tools are available inside Claude Code sessions connected to claude-tempo.

| Tool | Description |
|------|-------------|
| `ensemble` | Discover active sessions. Scope: `machine`, `repo`, or `all`. |
| `cue` | Send a message to a player by name. Delivered instantly via Temporal signal. |
| `set_name` | Set a human-readable name for this session. |
| `set_part` | Describe what you're working on. Visible to others via `ensemble`. |
| `listen` | Manually check for pending messages. |
| `recruit` | Spawn a new Claude Code session in a directory. Can recruit a conductor with `conductor: true`. When `host` is set, validates the target daemon is live and supports the requested agent before spawning; pass `force: true` to bypass pre-flight (#274). |
| `report` | Send updates to the conductor. No-op if no conductor exists. |
| `schedule` | Create a one-shot or recurring schedule to cue a player. |
| `unschedule` | Cancel a named schedule. |
| `schedules` | List all active schedules. |
| `who_am_i` | Get your identity, role, player type, and session details. |
| `agent_types` | List available player types with name, description, and source. |
| `save_lineup` | Save the current ensemble as a YAML lineup (conductor only). |
| `load_lineup` | Load a lineup to recruit players and create schedules. `hold: true` spawns players in warm-hold (attached but deferred until `release`). `initialStartup: true` pauses the ensemble at startup and waits for the user's first message before the conductor acts. |
| `broadcast` | Send a message to all active players. Optional `type` filter limits to a specific player type. |
| `restart` | Restart a player session — detaches the current adapter and re-spawns a fresh process. Works from any non-`gone` phase. Optional `host` param routes restart to a remote machine. |
| `detach` | Gracefully detach a player's adapter — triggers draining and clean handoff. Use before a planned `migrate` or host maintenance. |
| `destroy` | Terminate a session via ordered shutdown (outbox drain). Use for permanent removal. |
| `migrate` | Move a session to a different host — sets preferred host then triggers `restart` on the target machine's task queue. Requires `to` (target hostname). |
| `attachment_info` | Fetch the current attachment phase, adapter ID, lease expiry, heartbeat age, and in-flight message count for a player. Accepts `player` name. Output matches CLI and TUI surfaces (shared formatter, #264). |
| `recall` | Read your own message history. Shows received messages by default; pass `includeSent: true` for the full timeline. `limit` caps results (default 20, max 100); `offset` pages the timeline (gh-style `Showing X-Y of Z messages. Use offset: N for next page.`); `previewLength` truncates bodies to N chars (unset = full text). #128 unified the output with the TUI `/recall` and CLI `claude-tempo recall` via a shared formatter. |
| `hosts` | **#274.** List all daemons polling this Temporal namespace, joined with their boot-signaled capability profile (default agent, available player types, platform, claude bin basename). Optional `includeStale: true` shows hosts not seen in the last minute; `force: true` bypasses the 3-second result cache. Output matches CLI `claude-tempo hosts` and TUI `/hosts` (shared formatter, AC10a). |
| `worktree` | Manage git worktrees for player isolation. Actions: `create`, `remove`, `list`. Conductor only. |
| `quality_gate` | Define or replace a quality gate for a task — a named checklist of criteria that must pass. Conductor only. |
| `evaluate_gate` | Mark one or more criteria on a quality gate as passed or failed. Conductor only. |
| `gates` | List quality gates and their status. Filter by task name or status (`open`, `passed`, `failed`). Conductor only. |
| `stage` | Define a stage — tracks a set of players doing parallel work and auto-notifies when all report. Conductor only. |
| `stages` | List stages and their status. Conductor only. |
| `cancel_stage` | Cancel an active stage by name. Conductor only. |
| `release` | Release held player sessions — unlocks their outboxes and delivers deferred task messages. Omit `player` to release all held sessions. |
| `pause_ensemble` | Pause all sessions in the ensemble: locks outbox dispatch and pauses the scheduler. `destroy` commands still go through. |
| `resume_ensemble` | Resume a paused ensemble — unlocks outbox dispatch and resumes the scheduler. Buffered outbox entries are dispatched. Pass `release: true` to also release any held sessions (deliver deferred task messages and unlock their outboxes) in the same call — idempotent on non-held sessions. |

## v0.25 Changes

> **Breaking change in v0.25.0-beta.1**: The wire protocol between sessions and workers changed. If you are upgrading from v0.24.x, run `claude-tempo down` and `claude-tempo up` to reinitialize. Sessions from different versions cannot interoperate.

- **`encore` removed** — replaced by `restart`. The `restart` tool works from any non-`gone` attachment phase and is not limited to stale sessions.
- **`stop` removed** — use `destroy` (ordered shutdown) or `detach` (graceful adapter reap) instead.
- **New lifecycle verbs**: `restart`, `detach`, `destroy`, `migrate`, and `attachment_info` expose the v0.25 attachment state machine directly.

## Related

- [scheduling.md](scheduling.md) — full reference for the `schedule`, `unschedule`, and `schedules` tools
- [orchestration.md](orchestration.md) — full reference for quality gates, stages, and worktrees
- [ensembles.md](ensembles.md) — full reference for lineups and player types
