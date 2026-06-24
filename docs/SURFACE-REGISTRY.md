# Surface Registry

Single canonical inventory of every public-facing surface in agent-tempo.
Use this as the ground truth when doing drift checks — compare against the
source files below rather than grepping multiple directories.

> **Drift check commands** (run from repo root):
> ```bash
> # MCP tools — post-MD-B each tool file exports `build<X>Tool(): TempoToolDescriptor`.
> # Canonical check: `node scripts/check-surface-drift.js` (keep the regex below in sync with it):
> #   /name:\s*'([^']+)',\s*description:/  over src/tools/*.ts (excluding descriptor.ts)
> # CLI commands
> grep -E "^\s+\\\$\{out\.cyan\('[a-z]" src/cli/help-text.ts
> # Adapter types
> grep "AGENT_TYPES" src/types.ts
> # HTTP endpoints
> grep -E "GET|POST|OPTIONS" src/http/server.ts | grep "v1\|dashboard"
> ```

---

## 1. MCP Tools

Source: `src/tools/*.ts` — each file exports a `build<X>Tool(...): TempoToolDescriptor` factory returning `{ name, description, params, handler }`. MCP registration is performed by `renderToMcp` in `src/tools/descriptor.ts` (MD-B, Phase 1); the former `defineTool` / `helpers.ts` wrapper was retired.

`scripts/check-surface-drift.js` enumerates the names below from the ACTUAL `buildAllTempoTools()` output (via `scripts/enumerate-tool-names.ts`), not a source-regex scrape, and fails loud on a zero count (#793 §6 / #707). So canonical tools and their forwarding aliases cannot silently escape the drift gate.

**#793 tool-family merge (beta.2):** 5 canonical multi-action tools (`coat_check`, `state`, `schedule`, `stage`, `gate`) each take an `action` enum. The old per-action names remain registered as **forwarding aliases** (marked `DEPRECATED` below) with their exact original schemas — the alias-not-remove invariant. Alias removal is a future GA event, not beta.2.

| Tool name | Source file | Description |
|-----------|-------------|-------------|
| `agent_types` | `agent-types.ts` | List available player types that can be used when recruiting |
| `attachment_info` | `attachment-info.ts` | Query attachment lifecycle state — phase, holder, lease expiry, in-flight count |
| `broadcast` | `broadcast.ts` | Send a message to all active players; optional type filter |
| `cancel_stage` | `stage.ts` | DEPRECATED (alias of `stage` action="cancel") — Cancel an active pipeline stage (conductor only) |
| `clear_state` | `clear-state.ts` | DEPRECATED (alias of `state` action="clear") — Clear one of your saved-state slots (owner-only; idempotent) |
| `coat_check` | `coat-check.ts` | Canonical coat-check tool (#793). `action` = put \| get \| list \| evict. Stash/redeem/survey/evict ensemble-shared transient content |
| `coat_check_evict` | `coat-check.ts` | DEPRECATED (alias of `coat_check` action="evict") — Evict a coat-check entry before TTL expires (owner-or-conductor) |
| `coat_check_get` | `coat-check.ts` | DEPRECATED (alias of `coat_check` action="get") — Redeem a coat-check ticket and pull the stashed content; null when missing/expired/evicted |
| `coat_check_list` | `coat-check.ts` | DEPRECATED (alias of `coat_check` action="list") — List coat-check entry headers in this ensemble; optional putBy / prefix / unfetchedOnly filters |
| `coat_check_put` | `coat-check.ts` | DEPRECATED (alias of `coat_check` action="put") — Stash content (≤32 KiB) on per-ensemble Maestro state and return a ticket for later redemption |
| `cue` | `cue.ts` | Send a message to another session by player name via Temporal signal |
| `destroy` | `destroy.ts` | Terminate a session workflow or the entire ensemble (irreversible) |
| `ensemble` | `ensemble.ts` | Discover active sessions — player IDs, descriptions, metadata |
| `evaluate_gate` | `evaluate-gate.ts` | Mark quality gate criteria as passed or failed (conductor only) |
| `fetch_state` | `state.ts` | DEPRECATED (alias of `state` action="fetch") — Read a saved-state slot for yourself or a peer (defaults to your own `main` slot) |
| `gate` | `gate.ts` | Canonical quality-gate tool (#793, partial). `action` = define \| list. `evaluate_gate` stays separate. Conductor only |
| `gates` | `gate.ts` | DEPRECATED (alias of `gate` action="list") — List quality gates and their status (conductor only) |
| `hosts` | `hosts.ts` | Show daemons polling this Temporal namespace with advertised capabilities |
| `listen` | `listen.ts` | Manually check for pending messages from other sessions |
| `load_lineup` | `load-lineup.ts` | Load an ensemble lineup — recruit players and create schedules |
| `migrate` | `migrate.ts` | Move a session to a different host (sugar for `restart` with required `host`) |
| `pause` | `pause.ts` | Pause all sessions — locks outbox dispatch and pauses the scheduler |
| `play` | `play.ts` | Resume a paused ensemble — unlocks dispatch and resumes the scheduler |
| `quality_gate` | `gate.ts` | DEPRECATED (alias of `gate` action="define") — Define or replace a quality gate for a task (conductor only) |
| `recall` | `recall.ts` | Read your own message history with limit/offset/preview/filter options |
| `recruit` | `recruit.ts` | Start a new named session in a directory |
| `release` | `release.ts` | Release held sessions — unlock outboxes and deliver deferred task messages |
| `report` | `report.ts` | Send an update to the conductor (no-op if no conductor running) |
| `reset` | `reset.ts` | Clean-wipe a player's context — target starts a fresh session, no replay (D14) |
| `restart` | `restart.ts` | Restart a session — reap current attachment, claim fresh, spawn new adapter |
| `restore` | `restore.ts` | Revive ensemble after `shutdown` — reattach orphans, unpause maestro + scheduler |
| `respond` | `respond.ts` | Answer a planner's correlated `[Q <id>]` question — parks the answer on the maestro Q&A mailbox for the inbox-less command center (#700) |
| `save_lineup` | `save-lineup.ts` | Save current ensemble state as a YAML lineup (conductor only) |
| `save_state` | `state.ts` | DEPRECATED (alias of `state` action="save") — Save curated state for yourself into a named slot — peers can read it via `state` action="fetch" |
| `schedule` | `schedule.ts` | Canonical schedule tool (#793). `action` = create (default) \| cancel \| list. Schedule a message: one-shot, recurring, delay, or cron |
| `schedules` | `schedule.ts` | DEPRECATED (alias of `schedule` action="list") — List all active schedules in this ensemble |
| `set_ensemble_description` | `set-ensemble-description.ts` | Update the ensemble's mission-flavor description (≤100 chars). Surfaces on the dashboard EnsembleCard |
| `set_name` | `set-name.ts` | Set a human-readable name for this session |
| `set_part` | `set-part.ts` | Update your description of what you are currently working on |
| `shutdown` | `shutdown.ts` | Graceful ensemble teardown — detach adapters, pause maestro + scheduler |
| `stage` | `stage.ts` | Canonical pipeline-stage tool (#793). `action` = create (default) \| list \| cancel. Track N players (conductor only) |
| `stages` | `stage.ts` | DEPRECATED (alias of `stage` action="list") — List all pipeline stages and per-player report status (conductor only) |
| `state` | `state.ts` | Canonical player saveable-state tool (#793). `action` = save \| fetch \| clear. Owner-write / self-or-peer read; survives restart |
| `unschedule` | `schedule.ts` | DEPRECATED (alias of `schedule` action="cancel") — Remove a named schedule immediately |
| `who_am_i` | `who-am-i.ts` | Get your identity, role, player type, and session details |
| `worktree` | `worktree.ts` | Manage git worktrees for player isolation (conductor only) |

**Count:** 42 tools  
**Full reference:** [docs/tools.md](tools.md)  
**Note:** `detach` was removed from the MCP surface in v0.27 (#287) — its plumbing is used internally by `shutdown`.

---

## 2. CLI Commands

Source: `src/cli/help-text.ts` Commands section and `src/cli.ts` switch statement.

| Command | Description |
|---------|-------------|
| `home [ensemble]` | Bare-`agent-tempo` landing (#789, D2) — auto-provision (bootstrap), show live `status`, then print operator hints (command-center board / dashboard). The default when no command is given; not typically typed. Replaced the deleted Terminal UI launch. |
| `up [ensemble]` | Start infrastructure — Temporal, daemon, MCP registration. Optional `--lineup <name>` loads an ensemble; `--scenario <name>` (dev-mode only, ADR 0014 §5.5) forces every `agent: "mock"` player in the lineup into `mockMode: scripted` with the named scenario. |
| `down [ensemble]` | Stop infrastructure; workflows stay parked |
| `down --destroy [-y]` | Terminate every workflow across every ensemble, then stop infrastructure |
| `server` | Start Temporal dev server and register search attributes |
| `status [ensemble]` | Show active sessions and Temporal health |
| `ensemble <sub>` | Manage saved ensemble lineups (`save` / `list` / `show`) |
| `broadcast <message>` | Send a message to all active players |
| `destroy <ensemble> [-y]` | Terminate every workflow in one ensemble (typed confirmation) |
| `attachment-info <name>` | Inspect V2 attachment phase, holder, lease expiry, and in-flight count |
| `recall <name>` | Read a player's message history |
| `hosts` | List daemons polling this Temporal namespace with advertised capabilities |
| `refresh-host-profile` | Re-advertise this daemon's capability profile to the global Maestro |
| `restore <ensemble>` | Restore orphaned sessions in one ensemble on this host |
| `release [ensemble]` | Release all held players — unlock outboxes, deliver messages |
| `agent-types <sub>` | Manage player type definitions (`list` / `show` / `init`) |
| `daemon <sub>` | Manage the worker daemon (`start` / `stop` / `status` / `logs` / `stats`) |
| `dashboard` | Open the web dashboard in the default browser (`--no-open` / `--pair` / `--json`) |
| `command-center [ensemble]` | Launch the interactive Pi mission-control board (operator seat; sets the `command-center` role opt-in). Aliases: `cc` / `board` |
| `scenarios <sub>` | Discover mock-adapter scenarios shipped at `<package>/scenarios/` (`list` / `show <name>`). Available outside `--dev`; the recruit gate (`agent: 'mock'`) still requires it. |
| `upgrade [version]` | Upgrade agent-tempo to latest or a specific version |
| `config` | Configure Temporal connection settings (interactive or `set` / `show`) |
| `init` | Register MCP server globally (`--project` for per-directory) |
| `install-pi` | Install the agent-tempo Pi extensions (player + command-center) into Pi's `settings.json` by reference (`--project` for `.pi/settings.json`) |
| `preflight` | Run environment preflight checks |
| `version` | Print the installed version |
| `help` | Show help message |

**Count:** 26 commands (including `down --destroy` as a distinct flag variant)  
**Full reference:** [docs/cli.md](cli.md)  
**Removed (v0.27 / #288):** `stop`, `restart`, `detach`, `migrate`, `conduct`, `start`, `recruit`, `disband`, `pause`, `resume` — see [docs/cli.md](cli.md) for migration hints. **#789:** `tui` removed (the Ink TUI was deleted) — a bare `agent-tempo` now lands on `home` (status + hints); the operator board is `agent-tempo command-center`. **#794:** `migrate-from-claude-tempo` removed — the 1.x home-dir shim is no longer needed post-`upgrade-to-2`.

---

## 3. Command-Center Board Commands

The interactive operator board (`agent-tempo command-center`) registers its slash
commands at runtime via `pi.registerCommand` in
`src/pi/mission-control/extension.ts` — these are Pi-extension commands, not a
static registry, so they are **not** machine-checked by `check-surface-drift.js`
(unlike the deleted TUI's `COMMANDS` record). The board replaced the Ink TUI in
#789; its operator command parity was established in #742. See
[docs/concepts.md](concepts.md) (Command-center) for the live command set.

---

## 4. Adapter Types

Source: `src/types.ts` — `AGENT_TYPES` tuple; registration in `src/adapters/index.ts`.

| Key | Adapter class | Notes |
|-----|---------------|-------|
| `claude` | `InteractiveAttachment` (`src/adapters/claude-code/`) | Default — interactive Claude Code CLI subprocess |
| `copilot` | `CopilotSdkAttachment` (`src/adapters/copilot/`) | GitHub Copilot bridge |
| `claude-api` | `ClaudeApiAttachment` (`src/adapters/claude-api/`) | Headless via Anthropic Messages API (#131) |
| `opencode` | `OpenCodeAttachment` (`src/adapters/opencode/`) | OpenCode CLI adapter (#449) |
| `mock` | `MockAttachment` (`src/adapters/mock/`) | Dev-mode only — stripped from npm tarball. Modes: `echo`, `scripted`, `silent`, `chaos` |

The `mock` adapter is only registered when `isDevMode()` is true (`src/adapters/index.ts`).

**Count:** 5 adapter types (4 production, 1 dev-mode only)

---

## 5. HTTP Endpoints (daemon)

Source: `src/http/server.ts` — request dispatcher.

**Full reference:** [`docs/SSE-PROTOCOL.md`](SSE-PROTOCOL.md) (SSE streams), [`docs/daemon.md`](daemon.md)

### Read endpoints

| Method | Path | Description |
|--------|------|-------------|
| `GET` | `/v1/health` | Health check — no auth required |
| `GET` | `/v1/ensembles` | List ensembles |
| `GET` | `/v1/hosts` | List registered daemons |
| `GET` | `/v1/agent-types` | Catalog available agent types |
| `GET` | `/v1/lineups` | Catalog saved lineups |
| `GET` | `/v1/state/:ensemble` | Ensemble snapshot (`?fixture=<name>` in dev mode) |
| `GET` | `/v1/events` | SSE global event stream |
| `GET` | `/v1/events/:ensemble` | SSE per-ensemble event stream (`?fixture=<name>` in dev mode) |
| `GET` | `/dashboard/*` | Static SPA dashboard |

### Write endpoints

| Method | Path | Description |
|--------|------|-------------|
| `POST` | `/v1/ensembles` | Create ensemble |
| `POST` | `/v1/ensembles/:ensemble/<action>` | Ensemble write actions |
| `POST` | `/dashboard/api/pair` | Mint a QR-code pairing token (bearer required) |

### Auth-exempt endpoints

| Method | Path | Description |
|--------|------|-------------|
| `GET` | `/dashboard/api/pair/:token` | Consume a single-use pairing token |
| `OPTIONS` | `*` | CORS preflight — always allowed |

**Auth rule:** Bearer token required when bind address is non-loopback or `Origin` is non-loopback (DNS-rebinding defense). No auth in default loopback mode. Exempt regardless of mode: `/v1/health`, `OPTIONS`, `GET /dashboard/api/pair/:token`.

---

## 6. Temporal Wire Protocol (signals / queries / updates)

Documented in full in [`docs/WIRE-PROTOCOL.md`](WIRE-PROTOCOL.md). Not duplicated here.

Summary counts (as of v0.27):
- Session signals: 12 · Session queries: 14 · Session updates: 8
- Scheduler signals: 4 · Scheduler queries: 2
- Per-ensemble Maestro signals: 2 · queries: 5 · updates: 1
- Global Maestro signals: 2 · queries: 4 · updates: 4

---

## 7. SSE Event Types (daemon event source)

Documented in full in [`docs/SSE-PROTOCOL.md`](SSE-PROTOCOL.md). Not duplicated here.

Event types, payload schemas, and ring-buffer replay semantics are the stable contract between the daemon and consumers (TUI, CLI follower, third-party integrations).
