# MCP Tools Reference

These tools are available inside Claude Code sessions connected to claude-tempo.

| Tool | Description |
|------|-------------|
| `ensemble` | Discover active sessions. Scope: `machine`, `repo`, or `all`. |
| `cue` | Send a message to a player by name. Delivered instantly via Temporal signal. |
| `set_name` | Set a human-readable name for this session. |
| `set_part` | Describe what you're working on. Visible to others via `ensemble`. |
| `listen` | Manually check for pending messages. |
| `recruit` | Spawn a new Claude Code session in a directory. Can recruit a conductor with `conductor: true`. |
| `report` | Send updates to the conductor. No-op if no conductor exists. |
| `stop` | Stop a player session by name. |
| `schedule` | Create a one-shot or recurring schedule to cue a player. |
| `unschedule` | Cancel a named schedule. |
| `schedules` | List all active schedules. |
| `who_am_i` | Get your identity, role, player type, and session details. |
| `agent_types` | List available player types with name, description, and source. |
| `save_lineup` | Save the current ensemble as a YAML lineup (conductor only). |
| `load_lineup` | Load a lineup to recruit players and create schedules. |
| `broadcast` | Send a message to all active players. Optional `type` filter limits to a specific player type. |
| `encore` | Revive a stale player session — restarts the process and reconnects to the existing workflow with context restored. |
| `recall` | Read your own message history. Shows received messages by default; pass `includeSent: true` for the full timeline. |
| `worktree` | Manage git worktrees for player isolation. Actions: `create`, `remove`, `list`. Conductor only. |
| `quality_gate` | Define or replace a quality gate for a task — a named checklist of criteria that must pass. Conductor only. |
| `evaluate_gate` | Mark one or more criteria on a quality gate as passed or failed. Conductor only. |
| `gates` | List quality gates and their status. Filter by task name or status (`open`, `passed`, `failed`). Conductor only. |
| `stage` | Define a stage — tracks a set of players doing parallel work and auto-notifies when all report. Conductor only. |
| `stages` | List stages and their status. Conductor only. |
| `cancel_stage` | Cancel an active stage by name. Conductor only. |
| `release` | Release held player sessions — unlocks their outboxes and delivers deferred task messages. Omit `player` to release all held sessions. |
| `pause_ensemble` | Pause all sessions in the ensemble: locks outbox dispatch and pauses the scheduler. `stop` commands still go through. |
| `resume_ensemble` | Resume a paused ensemble — unlocks outbox dispatch and resumes the scheduler. Buffered outbox entries are dispatched. |

## Related

- [scheduling.md](scheduling.md) — full reference for the `schedule`, `unschedule`, and `schedules` tools
- [orchestration.md](orchestration.md) — full reference for quality gates, stages, and worktrees
- [ensembles.md](ensembles.md) — full reference for lineups and player types
