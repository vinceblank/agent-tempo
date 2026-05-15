# MCP Tools Reference

These tools are available inside Claude Code sessions connected to claude-tempo.

| Tool | Description |
|------|-------------|
| `ensemble` | Discover active sessions. Scope: `machine`, `repo`, or `all`. **#563**: output is split into "Active" and "Dormant" sections — a player is dormant when `phase=gone`, or `phase=detached` with no recorded activity in the last 1 hour. Dormant entries include a "Last seen X ago" line. Use the `dormant` arg (`show` default, `hide`, or `show-only`) to filter. |
| `cue` | Send a message to a player by name. Delivered instantly via Temporal signal. **#562**: pre-flight phase check surfaces an actionable error when the target is `detached`/`gone` instead of silently returning "Message sent". Pass `attachmentTicket` to attach a coat-check ticket when the body exceeds ~100 KB — the cue body should carry a short summary; the recipient pulls the full artifact via `coat_check_get`. |
| `set_name` | Set a human-readable name for this session. |
| `set_part` | Describe what you're working on. Visible to others via `ensemble`. |
| `set_ensemble_description` | Update the ensemble's mission-flavor description (≤100 chars). Surfaces on the dashboard EnsembleCard. Empty string clears it. Conductors should refresh at milestone boundaries. |
| `listen` | Manually check for pending messages. |
| `recruit` | Spawn a new Claude Code session in a directory. Can recruit a conductor with `conductor: true`. When `host` is set, validates the target daemon is live and supports the requested agent before spawning; pass `force: true` to bypass pre-flight (#274). Dev mode only: `agent: 'mock'` with optional `mockMode` (`echo` \| `scripted` \| `silent` \| `chaos`) and `mockScenario` (bare name or YAML path, required for `scripted`). #131 Phase C — `agent: 'claude-api'` runs headless via the Anthropic Messages API; requires `ANTHROPIC_API_KEY` env var + the `@anthropic-ai/sdk` optional dependency installed. Optional `model` arg overrides the default (`claude-opus-4-7`); falls back to `CLAUDE_TEMPO_API_MODEL` env. claude-api players have access to claude-tempo MCP tools (cue, report, recall, ensemble, …) but NOT file-edit / shell / web tools — use `agent: 'claude'` for tasks requiring those. #449 Phase C — `agent: 'opencode'` runs headless via [SST OpenCode](https://opencode.ai); requires OpenCode CLI (`npm install -g opencode-ai`) + `@opencode-ai/sdk` optional dependency. Pass `model: 'provider/name'` (e.g. `'anthropic/claude-opus-4-7'`, `'openai/gpt-4o'`, `'ollama/llama3'`). OpenCode has MCP-native tool access and persists session history server-side across restarts. #520 — `agent: 'claude-code-headless'` runs the official Claude Code CLI as a per-turn `claude -p --output-format stream-json` subprocess; turns bill against the host's existing Claude Code subscription extra-usage credits (Pro / Max plans) — the only ToS-clean way for a third-party tool to tap that pool. Requires `claude` binary on PATH AND a logged-in Claude Code session (`claude auth login`); pre-flight rejects with an actionable error otherwise. Optional `permissionMode` recruit knob (`acceptEdits` \| `auto` \| `bypassPermissions` \| `default` \| `dontAsk` \| `plan`; default `acceptEdits`) OR `dangerouslySkipPermissions: true` (mutually exclusive). Headless players have full Claude Code tool access (Bash, Read, Write, Edit, Glob, Grep, WebSearch, WebFetch). |
| `report` | Send updates to the conductor. No-op if no conductor exists. |
| `schedule` | Create a one-shot or recurring schedule to cue a player. |
| `unschedule` | Cancel a named schedule. |
| `schedules` | List all active schedules. |
| `who_am_i` | Get your identity, role, player type, and session details. |
| `agent_types` | List available player types with name, description, and source. |
| `save_lineup` | Save the current ensemble as a YAML lineup (conductor only). |
| `load_lineup` | Load a lineup to recruit players and create schedules. `hold: true` spawns players in warm-hold (attached but deferred until `release`). `initialStartup: true` pauses the ensemble at startup and waits for the user's first message before the conductor acts. |
| `broadcast` | Send a message to all active players. Optional `type` filter limits to a specific player type. |
| `restart` | Restart a player session — detaches the current adapter and re-spawns a fresh process. Works from any non-`gone` phase. Optional `host` param routes restart to a remote machine. Pass `loadFromState: true` (or a slot key string) to seed the restarted session from a saved-state slot (#334) instead of replaying the transcript; combine with `transcript: 'replay'` to stack both. Falls back to transcript replay if the slot is empty. |
| `destroy` | Terminate a session via ordered shutdown (outbox drain). When `playerId` is omitted, destroys the entire ensemble (peers → scheduler/maestro → conductor last). On partial failure (`Promise.allSettled` returns any `failed`), the response surfaces a "N peer(s) in indeterminate state — run `/destroy <ensemble>` again to clean up" hint; re-running is safe (workflow-side `destroyUpdate` is idempotent). |
| `migrate` | Move a session to a different host — sets preferred host then triggers `restart` on the target machine's task queue. Requires `to` (target hostname). |
| `attachment_info` | Fetch the current attachment phase, adapter ID, lease expiry, heartbeat age, and in-flight message count for a player. Accepts `player` name. Output matches CLI and TUI surfaces (shared formatter, #264). |
| `recall` | Read your own message history. Shows received messages by default; pass `includeSent: true` for the full timeline. `limit` caps results (default 20, max 100); `offset` pages the timeline (gh-style `Showing X-Y of Z messages. Use offset: N for next page.`); `previewLength` truncates bodies to N chars (unset = full text). #128 unified the output with the TUI `/recall` and CLI `claude-tempo recall` via a shared formatter. |
| `save_state` | **#334.** Write a curated artifact to a named slot (max 4 slots × 32 KiB). Owner-only. A peer can read it via `fetch_state`; a future restart can seed itself from the slot via `loadFromState`. Slot key defaults to `"main"`. When all 4 slots are full, saving a new key fails with `PlayerStateSlotsFull` — call `clear_state` to free a slot first. |
| `fetch_state` | **#334.** Read a saved-state slot for yourself or a peer. Any player in the ensemble can read any other player's state (audit identity recorded in `savedBy`). Pass `playerId` for a peer; defaults to own `"main"` slot. Works even after `destroy` (last-known state served from workflow history). Returns a `(no state saved …)` message when the slot is empty. |
| `clear_state` | **#334.** Clear one of your own saved-state slots. Owner-only. Idempotent — clearing an already-empty slot is a no-op. Returns whether the slot was non-empty before the clear. |
| `coat_check_put` | **#318 (ADR 0008).** Stash a large content body on per-ensemble Maestro state. Returns a ticket id any player can redeem via `coat_check_get`. Use when a cue body would exceed the 100 KB cap — pass the ticket via `cue`'s `attachmentTicket` field; the cue body carries a short summary. Max 32 KiB per entry, 20 slots per ensemble; TTL default 7d, range [1h, 30d]. Saturation → `CoatCheckSlotsFull` (no LRU eviction — call `coat_check_evict` or wait for TTL). |
| `coat_check_get` | **#318 (ADR 0008).** Redeem a coat-check ticket and pull the full content body. Returns the full entry (summary + content + audit fields) or `null` for missing/expired/evicted tickets — no error on miss. Bumps `fetchCount`, `lastFetchedAt`, `lastFetchedBy` so the putter can confirm redemption. Implemented as a workflow Update (not Query) because it mutates audit state. |
| `coat_check_list` | **#318 (ADR 0008).** List coat-check entry headers for this ensemble (content body omitted), sorted newest-first. Read-only — does NOT bump fetch-audit counters. Optional filters: `putBy` (audit lens), `prefix` (summary-prefix narrow), `unfetchedOnly` (entries with `fetchCount === 0`). Expired entries are filtered from the view. |
| `coat_check_evict` | **#318 (ADR 0008).** Evict a coat-check entry before its TTL expires. Owner-or-conductor permission gate: must be the original putter or the ensemble conductor; others get `CoatCheckEvictPermissionDenied`. Returns `{ evicted: false }` for missing/expired/already-evicted tickets (no throw). |
| `hosts` | **#274.** List all daemons polling this Temporal namespace, joined with their boot-signaled capability profile (default agent, available player types, platform, claude bin basename). Optional `includeStale: true` shows hosts not seen in the last minute; `force: true` bypasses the 3-second result cache. Output matches CLI `claude-tempo hosts` and TUI `/hosts` (shared formatter, AC10a). |
| `worktree` | Manage git worktrees for player isolation. Conductor only. Actions: `create` (provision worktree for a player), `remove` (clean up), `list` (show active worktrees). Use when multiple players commit to different branches of the same repo simultaneously; skip for read-only work, sequential work, or tasks under ~5 min. **IMPORTANT:** before `remove`, have the player stop any long-running processes inside the worktree (dev servers, file watchers) — on Windows a memory-mapped native module will block directory removal and `remove` will fail. See [when to use worktrees](orchestration.md#when-to-use-worktrees). |
| `quality_gate` | Define or replace a quality gate for a task — a named checklist of criteria that must pass. Conductor only. |
| `evaluate_gate` | Mark one or more criteria on a quality gate as passed or failed. Conductor only. |
| `gates` | List quality gates and their status. Filter by task name or status (`open`, `passed`, `failed`). Conductor only. |
| `stage` | Define a stage — tracks a set of players doing parallel work and auto-notifies when all report. Conductor only. |
| `stages` | List stages and their status. Conductor only. |
| `cancel_stage` | Cancel an active stage by name. Conductor only. |
| `release` | Release held player sessions — unlocks their outboxes and delivers deferred task messages. Omit `player` to release all held sessions. |
| `pause` | Pause all sessions in the ensemble: locks outbox dispatch and pauses the scheduler. `destroy` commands still go through. (#287) |
| `play` | Resume a paused ensemble — unlocks outbox dispatch and resumes the scheduler. Buffered outbox entries are dispatched. Pass `release: true` to also release any held sessions in the same call — idempotent on non-held sessions. (#287) |
| `shutdown` | Gracefully shut down the entire ensemble — signals all players to drain and detach, then stops the conductor. Use instead of per-player `detach` calls when tearing down. (#287) |
| `restore` | Restore orphaned sessions in one ensemble — re-attaches a fresh adapter to every `detached` session whose preferred host matches. Defaults to scanning the local OS hostname. Pass `hostname: "<other-host>"` for cross-host setups (per-host task queues, #274) where the operator's daemon runs on a different machine than the parked sessions. (#287, #288, #306 follow-up) |

## Version History

### v0.29 Changes (#318)

- **`coat_check_put`, `coat_check_get`, `coat_check_list`, `coat_check_evict` added** — coat-check pattern for large cues. Stash artifacts up to 32 KiB on Maestro state and attach the ticket to a `cue` via `attachmentTicket`. (#318, ADR 0008)
- **`cue` gains `attachmentTicket`** — optional field to attach a coat-check ticket to a cue; the recipient sees it on `recall` and can pull the body via `coat_check_get`. (#318)
- **`cue` detached-target detection** — pre-flight phase check returns an actionable error when the target is `detached`/`gone` instead of silently returning "Message sent". (#562)
- **`ensemble` dormant split** — active and dormant players appear in separate sections. Dormant players include "Last seen X ago". Use `dormant` arg (`show` / `hide` / `show-only`). (#563)

### v0.28 Changes (#382, #385, #449, #485, #502, #503)

- **`save_state`, `fetch_state`, `clear_state` added** — per-player saveable-state slots. Owner writes/clears; any peer can read. Max 4 slots × 32 KiB. (#502)
- **`restart` gains `loadFromState`** — seed a restarted session from a saved-state slot instead of (or alongside) transcript replay. Pass `loadFromState: true` for the default slot or a key string for a named slot; `transcript: 'replay'` stacks both. (#503)
- **`recruit` mock params added** — `agent: 'mock'` (dev mode only) with `mockMode` and `mockScenario`. Gates reject mock outside dev mode and validate mode/scenario combinations.
- **`recruit` OpenCode support** — `agent: 'opencode'` with `model: 'provider/name'` for multi-provider headless sessions via SST OpenCode (#449/#485).
- **`recruit` Claude Code headless support** — `agent: 'claude-code-headless'` with optional `permissionMode` / `dangerouslySkipPermissions` knobs. Per-turn `claude -p` subprocess; bills against the host's Claude Code subscription extra-usage credits. Pre-flight probes `claude --version` + `claude auth status` (#520).

### v0.27 Changes (#285–#291)

- **`pause_ensemble` renamed to `pause`**, **`resume_ensemble` renamed to `play`** — shorter names, consistent with TUI `/pause` and `/play` slash commands.
- **`shutdown` added** — ensemble-scope graceful teardown; replaces per-player `detach` chains.
- **`restore` added** — ensemble-scope orphan recovery; replaces the v0.25 interactive CLI flow.
- **`detach` MCP tool removed** — functionality is now internal to `shutdown` (#287). Single-target graceful detach is no longer exposed on the MCP surface.

### v0.25 Changes

> **Breaking change in v0.25.0-beta.1**: The wire protocol between sessions and workers changed. If you are upgrading from v0.24.x, run `claude-tempo down` and `claude-tempo up` to reinitialize. Sessions from different versions cannot interoperate.

- **`encore` removed** — replaced by `restart`. The `restart` tool works from any non-`gone` attachment phase and is not limited to stale sessions.
- **`stop` removed** — use `destroy` (ordered shutdown) instead.
- **New lifecycle verbs**: `restart`, `detach`, `destroy`, `migrate`, and `attachment_info` expose the v0.25 attachment state machine directly.

## Related

- [scheduling.md](scheduling.md) — full reference for the `schedule`, `unschedule`, and `schedules` tools
- [orchestration.md](orchestration.md) — full reference for quality gates, stages, and worktrees
- [ensembles.md](ensembles.md) — full reference for lineups and player types
