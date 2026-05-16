# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/),
and this project adheres to [Semantic Versioning](https://semver.org/).

## [Unreleased]

### Fixed
- `agent-tempo down --destroy` no longer skips sessions and maestro/scheduler workflows that
  were started without the `AgentTempoEnsemble` search attribute (e.g. from a partially-migrated
  build). The previous logic derived workflow IDs from the search attribute and bailed out early
  when the attribute was absent, leaving orphans behind. Enumeration now queries each workflow
  type directly and terminates by ID, independent of search-attribute state.
- Search-attribute registration errors are now surfaced instead of silently swallowed. Previously
  every non-zero `temporal operator search-attribute create` exit was labeled "already exists",
  hiding real failures (namespace Keyword cap exceeded, server unreachable, CLI missing) until a
  downstream workflow start failed with a confusing `INVALID_ARGUMENT` hours later.

## [1.0.0] - 2026-05-15

### ⚠️ BREAKING — `claude-tempo` is now `agent-tempo`

v1.0 is a hard-break rebrand. Wire-level identifiers (Temporal search attributes, workflow
types, workflow IDs, task queues) have been renamed without a backward-compatibility shim.
Every v0.x workflow still in Temporal history becomes a permanent orphan after this
release — by design. Operators MUST follow the
[v1.0 migration guide](docs/ops/v1.0-migration.md) before upgrading.

All four engineering PRs of the v1.0 rebrand series land in this release:

- **Documentation rename** (PR-1): brand string `claude-tempo` → `agent-tempo` across all
  live docs, README, and community files. Hero tagline: "Many agents, one tempo."
- **Code surface rename** (PR-2): env vars `CLAUDE_TEMPO_*` → `AGENT_TEMPO_*`; filesystem
  `~/.claude-tempo[-dev]/` → `~/.agent-tempo[-dev]/`; MCP server name `claude-tempo` →
  `agent-tempo`; log prefixes `[claude-tempo:*]` → `[agent-tempo:*]`. Dual-bin
  (`claude-tempo` + `agent-tempo`) on package.json `bin` for the migration window.
  New verb `agent-tempo migrate-from-claude-tempo` + bootstrap step auto-runs on first
  boot, copying state to the new home with SHA-256 partial-copy resume.
- **Wire-level rename** (PR-3): search attributes `ClaudeTempo*` →
  `AgentTempo*` (~455 sites); workflow type names `claudeSessionWorkflow` /
  `claudeSchedulerWorkflow` / `claudeMaestroWorkflow` / `claudeGlobalMaestroWorkflow` →
  `agent*Workflow`; workflow ID prefixes `claude-{session,scheduler,maestro}-` →
  `agent-*-`; task queues `claude-tempo` / `claude-tempo-{hostname}` / `claude-tempo-dev`
  → `agent-tempo*`; dashboard `localStorage` keys `claudeTempo*` → `agentTempo*`. New
  daemon boot-time preflight (`src/cli/sa-preflight.ts`) fails fast with an actionable
  error message containing the exact `temporal operator search-attribute create`
  commands operators need to paste.
- **npm publish flip** (PR-4, this release): package `name` = `agent-tempo`; `bin` now
  only `agent-tempo` / `agent-tempo-server` (the migration-window `claude-tempo*` aliases
  are dropped); `homepage` / `repository.url` / `bugs.url` point at
  `vinceblank/agent-tempo`. The auto-publish workflow (`release.yml`) was removed —
  publish is intentionally manual for v1.0 (see `docs/release-process-v1.0.md`).
  Packaging templates renamed: `agent-tempo.service`, `com.agent.tempo.plist`
  (`agent-tempo daemon uninstall` removes either the new or the legacy unit / plist
  so v0.x installs migrate cleanly). Logo SVG wordmarks updated to `agent-tempo`.

### Required operator actions before upgrading

1. Drain in-flight work — workflow state from v0.x is unrecoverable from v1.x.
2. `claude-tempo down --all` on every host.
3. (Recommended) `claude-tempo destroy --ensemble <name> --all` for each ensemble.
4. `npm install -g agent-tempo` (or project-local replacement).
5. Update `.mcp.json` files: `claude-tempo` → `agent-tempo` server entries.
6. `agent-tempo migrate-from-claude-tempo` to copy `~/.claude-tempo/` → `~/.agent-tempo/`.
7. Rename `CLAUDE_TEMPO_*` env vars (shell profiles, CI secrets, `.env` files) → `AGENT_TEMPO_*`.
8. Register `AgentTempo*` search attributes on each Temporal namespace — the daemon
   surfaces the exact commands on first boot. Self-hosted only; Temporal Cloud users:
   ops handles namespace registration before this version is published.
9. `agent-tempo up --lineup <name>` to recruit fresh ensembles. Lineup YAMLs need no edits.

Full walkthrough: [docs/ops/v1.0-migration.md](docs/ops/v1.0-migration.md).

### Unchanged

- Lineup YAML schema (no edits to existing lineups).
- `TEMPORAL_*` and `COPILOT_BRIDGE_*` environment variables.
- Saved state slot semantics; the fs migration helper carries them across.
- `claude-tempo[bot]` GitHub App slug — renamed in a follow-up release; existing
  installations preserve their installation ID.

## [0.29.1] - 2026-05-15

### Fixed

- **`worktree` remove silently failing on Windows** — on Windows the `worktree` MCP tool's
  `remove` action could half-succeed when a worktree contained a memory-mapped `.node` binary
  (e.g. a running Next.js dev server): `git worktree remove --force` cleared `.git/worktrees`
  metadata but Windows refused the directory deletion, leaving a stale orphan on disk while
  the tool reported success. The next `create` for the same player then failed with a
  confusing `fatal: '...' already exists`. Fix: post-removal `existsSync` verification with
  surfaced failure, and stale-orphan recovery in `createWorktree` (auto-`fs.rmSync` of a
  detected orphan path before `git worktree add`, with a clear error if recovery itself
  fails). (#594, #595)

### Docs

- **`docs/tools.md` v0.29 Changes header** — corrected the issue-ref list under the
  `v0.29 Changes` heading; the previous list mixed in issues that shipped in v0.28. (#592,
  #593)
- **`docs/orchestration.md` — "Stop long-running processes before `remove`"** — new section
  explaining why processes inside a worktree must be stopped before `remove`, with Windows-
  specific detail on memory-mapped file locks and the auto-recovery behaviour added in #594.
  Also reflected as an IMPORTANT warning in the `worktree` MCP tool description. (#594, #595)

## [0.29.0] - 2026-05-13

### Added

- **Coat-check pattern for large cues** — new `coat_check_put` / `coat_check_get` /
  `coat_check_list` / `coat_check_evict` MCP tools let players stash large content bodies
  (up to 32 KiB) on per-ensemble Maestro state and pass a lightweight ticket via `cue`'s
  new `attachmentTicket` field. Solves the 100 KB cue body cap for researcher reports,
  review dumps, and other large artifacts. Limits: 20 slots per ensemble, TTL 7 days
  (configurable 1h–30d), no LRU eviction — saturation rejects with `CoatCheckSlotsFull`.
  Eviction is owner-or-conductor; fetch audit (`fetchCount`, `lastFetchedAt`,
  `lastFetchedBy`) lets the putter confirm redemption. (#318, ADR 0008)

## [0.28.0] - 2026-05-13

### Added

- **`restore --all-hosts`** — `claude-tempo restore` and the `restore` MCP tool now accept
  `--all-hosts` / `{ allHosts: true }` to surface orphaned sessions from every host in the
  cluster, not just the local one. Unifies cross-machine orphan visibility into a single
  command. (#151, #582)
- **`--yes-steal` deliberate-action gate on `/migrate`** — the TUI `/migrate` command now
  requires an explicit `--yes-steal` flag when the target player is attached on a different
  host, preventing accidental lease steals. Mirrors the `confirmStealFromHost` guard already
  on `/restart`. (#580, #585)
- **Cron schedules honoured in lineup loader + status display** — `claude-tempo up --lineup`
  and `claude-tempo status` now parse and surface `cron`-typed schedule entries correctly;
  previously cron schedules loaded from lineup YAML were silently ignored. (#586, #587)
- **`cue` actionable error on unknown player** — sending a cue to a player name that does
  not exist now returns an immediate structured error with a Levenshtein-ranked suggestion
  list, replacing the previous silent timeout. (#560)
- **`cue` detached-target detection** — when the destination player is in a detached phase,
  `cue` surfaces the accurate delivery truth (queued-but-undeliverable) instead of silently
  enqueuing to a dead mailbox. (#562)
- **`ensemble` active/dormant split** — the `ensemble` tool output now groups players into
  "active" (attached/processing) and "dormant" (detached/draining) sections for clearer
  roster visibility. (#563)
- **Web dashboard** (`claude-tempo dashboard`) — full Vite + React web UI serving all
  ensemble and player data live. Screens: Overview, Workspace (chat + player list),
  PlayerDetail, PlayerTypes, Hosts, Loadouts/Schedules, CreateEnsemble + Recruit wizards,
  Settings. Action wiring: Recall, Restart, Detach, Destroy trigger real workflow operations.
  Chat notification toasts for incoming messages. Cross-device pairing via QR-code one-time
  bearer token. Flags: `--port`, `--bind`, `--no-open`, `--pair`. (#340)
- **Daemon HTTP/SSE event source** — The daemon exposes a local HTTP server with snapshot +
  streaming endpoints: `GET /v1/health`, `/v1/ensembles`, `/v1/state/:ensemble`,
  `/v1/hosts`, `/v1/events/:ensemble` (SSE stream), `/v1/events` (cluster stream). SSE
  streams deliver a snapshot prelude, replay from a 256-event ring buffer on reconnect
  (`Last-Event-ID`), and a `gap` event on overflow. Bearer auth + CORS; loopback skips
  auth. (#94, #95)
- **`TempoClient.subscribe()` AsyncIterable** — programmatic SSE consumer for dashboards
  and external integrations. Dual transport: native `EventSource` (browser/loopback) and
  `fetch`-based (Node/bearer). Exposes the full `ClusterEvent` type stream. (#94, #95)
- **TUI live streaming** — all ensemble/player state now drives from `client.subscribe()`
  instead of the 2-second poll loop. Sub-second event latency; reconnect handled
  transparently. (#94, #95)
- **OpenCode adapter** (`agent: 'opencode'`) — headless multi-provider adapter via SST
  OpenCode subprocess. Supports Anthropic, OpenAI, Bedrock, Vertex, Ollama, and ~70 other
  providers via `model: 'provider/name'`. Tool bridging is MCP-native; session state
  persisted server-side with reconnect across `opencode serve` restarts. Requires
  `opencode-ai` CLI + `@opencode-ai/sdk`. (#449)
- **Claude-code-headless adapter** (`agent: 'claude-code-headless'`) — headless adapter
  driving sessions via the `claude` CLI as per-turn `claude -p --output-format stream-json`
  subprocesses. Bills against the host's Claude Code subscription (Pro/Max extra-usage
  credits). Full Claude Code built-ins + claude-tempo MCP surface. Requires `claude` binary
  on PATH and a logged-in Claude Code session. (#520)
- **Player saveable state** — `save_state`, `fetch_state`, `clear_state` MCP tools let
  players persist curated context to named slots (max 4, 32 KiB each). Owner-write /
  peer-read. `restart` accepts `loadFromState` to seed the next session from a saved slot.
  Implements ADR 0011. (#334)
- **Dev mode** (`--dev` flag / `CLAUDE_TEMPO_DEV_MODE=1`) — fully isolated testing profile:
  home dir `~/.claude-tempo-dev/`, HTTP port 8474, namespace `claude-tempo-dev`, task queue
  `claude-tempo-dev`. Shell env vars (`TEMPORAL_NAMESPACE`, `TEMPORAL_ADDRESS`) are ignored
  in dev mode. `--dev down` does not kill Temporal if the prod profile is live. (#423)
- **Mock adapter** (`agent: 'mock'`, dev mode only) — four modes: `echo`, `scripted`,
  `silent`, `chaos`. Stripped from the npm tarball by `prepack`. (#340)
- **Dashboard chat notifications** — incoming maestro messages trigger bottom-right toasts
  (6s TTL, max 3 visible, `+N more` chip, same-sender grouping). Sidebar ensemble rows show
  unread badges; click navigates to that ensemble's chat. (#513)
- **`claude-tempo daemon stats`** — new CLI subcommand prints live memory usage, uptime,
  active ensembles, and SSE subscriber count from `/v1/health`. (#336)
- **Adapter process-lifecycle telemetry** — structured log lines on all process exit/signal/
  uncaught events. Grep `[claude-tempo:adapter]` in daemon logs. (#258)
- **CI: Windows test matrix** — `build-and-test-windows` job (Node 22, 2 shards); catches
  OS-specific EACCES failures with retry-and-reap on Windows Defender scan interference.
  (#150)
- **Surface drift detector** — `scripts/check-surface-drift.js` + `npm run lint:surface-drift`
  diffs `docs/SURFACE-REGISTRY.md` against source; wired into CI. (#305)
- **Overflow Playwright guardrail** — `npm run test:overflow` visual regression suite for
  the dashboard overflow surface. CI `dashboard-overflow` job. (#461)
- **`update-overflow-snapshots` workflow** — `workflow_dispatch`-only CI workflow
  regenerates Playwright baseline PNGs on Linux (matching CI rendering environment) and
  commits them back to the feature branch as `claude-tempo[bot]`. (#493)

### Fixed

- **Dashboard overflow refutations resolved** — 3 CSS fixes (pill flex-wrap, title
  `min-width: 0`, `.ec-meta` flex-shrink relaxation) + 2 test-heuristic refinements; all
  skipped Walk A tests re-enabled. (#494)
- **Dashboard icon-glyph footprint on PlayerTypes card** — normalised to remove excess
  spacing regression. (#575, #578)
- **Migrate hint in removed-verbs** — `/migrate` hint now shows the correct TUI form
  instead of a stale CLI verb. (#581)
- **Memory leak + unbounded iterator deadlines** — `listEnsembles` and `listActivePlayers`
  iterators are now bounded; `TempoClient.subscribe()` no longer leaks the long-poll
  connection on caller-side cancellation; schedule-fire and orphan-query activities bounded.
  (#336, #529)
- **HTTP aggregate carry-forward** — per-ensemble fan-out snapshot diff loop now propagates
  all player-phase / agent-type updates to each SSE subscriber independently, preventing
  stale snapshots after reconnect. (#550)
- **claude-api adapter retry classification** — fatal 4xx errors detach immediately;
  retriable errors use jittered backoff capped at 30s with `retry-after` support; 10-
  consecutive-failure cap escalates to fatal. (#521)
- **Outbox silently broken after force-restart** — server.ts now uses an unpinned workflow
  handle (`getHandle`) for MCP tool registrations, so `executeUpdate` resolves to the latest
  run after any continue-as-new or force-restart. (#347)
- **Adapter post-CAN double-loop silence** — tiebreaker + structured `fireTerminal` log
  prevent the post-continue-as-new double-loop from silently reaping a healthy attachment.
  (#258)
- **Dashboard snapshot responsiveness** — `buildEnsembleSnapshot` query calls bounded at
  2s/call; 15s aggregate tick watchdog as defense-in-depth. Eliminates unbounded `tick
  skipped` accumulation on wedged sessions. (#433)
- **Mocha zombie Temporal server cleanup** — `mochaGlobalTeardown` + `process.on('exit')`
  + signal handlers reap orphan ephemeral Temporal server processes even when teardown is
  skipped mid-suite. (#306)
- **Test flake hardening** — maestro discovery test race deflaked via ensemble-scoped
  teardown; lifecycle-v2 stabilised with explicit phase-wait sequencing. (#383, #583, #584)
- **Dev-mode isolation** — prod env vars (`TEMPORAL_NAMESPACE`, `TEMPORAL_ADDRESS`) no
  longer bleed into the dev profile; `down` no longer kills prod workers when invoked in
  dev mode. (#423)

### Changed

- **Wire protocol: `PlayerSummaryV1.agentType` union expanded** — adds `'claude-api'`,
  `'opencode'`, and `'claude-code-headless'` alongside existing values. Additive extension
  per the §6 stability rule; no `/v1/` → `/v2/` path bump. (#537)
- **Communication-discipline rules delivered to every player** — three protocol rules
  injected via MCP server instructions on connect: drafting ≠ sending, silent conductor =
  HOLD, no autonomous player dispatch. (#505)
- **`TempoClient` split into `Core` + `WithSpawn`** — `TempoClientCore` exposes 38 pure-RPC
  methods; `TempoClientWithSpawn` extends with spawn helpers. `type TempoClient =
  TempoClientWithSpawn` preserves every existing import. (#308)
- **Dashboard: Sonner system toasts removed** — 29 call sites migrated to inline
  `<ComposerStatus>` banner + inline wizard errors + silent success; bundle −8 kB gzipped.
  (#514)

### Docs

- Agent-tool vs recruit guidance + `ensemble` tool description hint added to docs. (#561, #577)
- `docs/release-process.md` updated with lockstep version-bump rule. (#549)
- `docs/SURFACE-REGISTRY.md` — canonical inventory of all MCP tools, CLI commands, and TUI
  slash commands. (#305)
- 5 design ADRs added: coat-check pattern (ADR 0008), protobuf migration (ADR 0009),
  player-saveable state (ADR 0011), Claude API adapter scoping (ADR 0012), web dashboard
  scoping (ADR 0013). (#334, #340)
- Dashboard design handoff bundle at `docs/design/dashboard-handoff/`. (#340)
- When-to-use-worktrees guidance. (#564)

---

<!-- Pre-release history: beta.1 through beta.19 entries are preserved below. -->

## [0.28.0-beta.19] - 2026-05-11

### Added

- `cue` tool: actionable error with Levenshtein suggestion when the target player name does not exist — silent timeout replaced by an immediate structured error listing the closest match (#560)
- `ensemble` tool: active and dormant players are now shown in separate sections — attached/processing players listed first, detached/draining players in a distinct "dormant" group for clearer roster visibility (#563)
- `cue` tool: detached-target detection — when the destination player is in a detached phase, `cue` surfaces accurate delivery truth (queued-but-undeliverable) instead of silently enqueuing to a dead mailbox (#562)
- Dashboard: dev-only `/__overflow/` route shim serves fixture data for the Playwright overflow spec suite, eliminating the need for a live Temporal daemon in overflow CI (#492)
- Docs: when-to-use-worktrees guidance added to `docs/` covering the worktree tool decision tree (#564)

### Changed

- Tests: registry conformance suite now derives the expected agent-type list from the canonical SSOT (`src/ensemble/agent-types.ts`) rather than a parallel hand-maintained list — future type additions auto-propagate to conformance assertions (#486)

## [0.28.0-beta.18] - 2026-05-11

### Added

- CI: synthetic no-op success reporters for all required status checks on docs-only PRs — branch protection no longer blocks docs/scripts merges when the heavy test matrix is correctly skipped (#547, #551)
- Dashboard: `lint:no-stale-scaffold` CI gate prevents stale placeholder text from shipping; existing PR-7 placeholder removed from TUI (#375, #545)
- Scripts: heap-snapshot reproducer harness (`scripts/dev/heap-snapshot-336.sh`) for diagnosing the #336 memory regression (#548)

### Changed

- HTTP: recruit allowlist is now a single source of truth in `src/http/body.ts`; removed the duplicated inline list that was the root cause of the #541 gap (#546)
- Dashboard: TypeScript strict unused-variables cleanup across dashboard components and tests; tsconfig tightened (#368, #553)
- Docs: protobuf migration readiness assessment added to `docs/design/` (#544)
- Docs: release-process runbook updated with lockstep version-bump rule (root + `dashboard/package.json` + `dashboard/package-lock.json` in the same commit) (#549)

### Fixed

- Memory leak + unbounded iterator deadlines: new `src/utils/visibility-deadline.ts` caps `listEnsembles` and `listActivePlayers` iterators; `TempoClient.subscribe()` no longer leaks the long-poll connection on caller-side cancellation; `reconcile/orphans.ts` and schedule-fire activities bounded (#336, #529, #555)
- HTTP aggregate: per-ensemble fan-out carry-forward — snapshot diff loop now propagates all player-phase / agent-type updates to each SSE subscriber independently, preventing stale snapshots after reconnect (#550, #557)
- claude-api adapter: retry classification + exponential backoff + give-up budget — fatal 4xx errors (auth, permission, bad request) now detach immediately instead of retrying indefinitely; retriable errors (408, 429, 5xx) use jittered backoff capped at 30 s with `retry-after` header support; 10-consecutive-failure cap escalates to fatal (#521, #552)
- Test race hardening: flaky lifecycle-v2 and global-maestro tests stabilised via explicit phase-wait sequencing and ensemble-scoped teardown (#383, #554, #556)

## [0.28.0-beta.17] - 2026-05-11

### Added

- Dashboard: muted adapter-badge chip now renders for headless players (copilot, claude-code-headless, opencode, claude-api, mock) when no explicit type is set, making them visually distinguishable from interactive Claude Code sessions (#537)

### Changed

- Default session part for headless adapters now reads "Headless \<adapter\> session" instead of the generic "Session in \<repo\>" — explicit `set_part` calls still override (#537)
- **Wire protocol: `PlayerSummaryV1.agentType` union expanded** to mirror
  `AgentType` in `src/types.ts` — adds `'claude-api'`, `'opencode'`, and
  `'claude-code-headless'` alongside the existing `'claude'`, `'copilot'`,
  `'mock'`. Pre-fix, the snapshot projection coerced every headless
  adapter to `'claude'`, making `claude-api` / `opencode` /
  `claude-code-headless` players visually indistinguishable from
  interactive Claude Code sessions in the dashboard. Additive extension
  per the §6 stability rule in `src/http/event-types.ts` — no `/v1/` →
  `/v2/` path bump. Aggregate diff loop now tracks `playerAgentTypes`
  per-ensemble in lockstep with `playerPhases`, so the prior-snapshot
  reconstruction carries each player's real adapter family instead of a
  hardcoded stand-in. (#535)

### Fixed

- copilot adapter: recruit pre-flight now fails fast with an actionable error
  when `@github/copilot-sdk` is not installed; daemon host profile correctly
  advertises copilot when the SDK is available — closes the gap where
  cross-host `recruit { agent: 'copilot', host: 'X' }` was rejected with a
  misleading "Host \"X\" cannot run copilot" message even on hosts where the
  SDK was installed and Copilot was logged in. (#532)
- claude-code-headless adapter: model now reliably replies via the `cue` MCP
  tool by injecting a per-turn `--append-system-prompt` with the canonical
  "use your MCP tools to reply" framing (shared verbatim with the copilot
  adapter via `src/adapters/sdk/system-prompt.ts`). Previously, replies were
  lost as discarded subprocess stdout — the model had no framing telling it
  to call `cue`, so it produced English-prose responses that the adapter
  captured but had nowhere to deliver. MAESTRO_ACK augmentation for
  human-from-dashboard messages is now also factored into the same shared
  module so copilot and headless apply the identical augmentation. (#536)

## [0.28.0-beta.16] - 2026-05-03

### Added

- **Headless Claude Code adapter** (`agent: 'claude-code-headless'`) — fifth
  shipped adapter, peer of `claude-code` / `claude-api` / `copilot` /
  `opencode`. Spawns the host's installed `claude` CLI as a per-turn
  `claude -p --output-format stream-json` subprocess; uses the operator's
  existing Claude Code OAuth login so turns bill against subscription
  extra-usage credits (Pro / Max plans) rather than a Console workspace
  API key — the only ToS-clean way for a third-party tool to tap that
  pool. Tool surface is the union of full Claude Code built-ins
  (Bash / Read / Write / Edit / Glob / Grep / WebSearch / WebFetch) plus
  the claude-tempo MCP surface (registered via inline `--mcp-config` so
  `claude` spawns `dist/server.js` as its own MCP child — no in-process
  bridge). Recruit pre-flight probes for `claude` binary on PATH AND
  `claude auth status` returning logged-in (`force: true` bypass).
  Supports `permissionMode` + `dangerouslySkipPermissions` recruit knobs
  for the per-turn `--permission-mode` flag. Daemon boot probe extends
  `availableAgentTypes` for cross-host recruit gating. Includes a
  `tempo-headless-jam` example lineup. Wire-protocol impact: zero new
  signals/queries/updates. (#520)

## [0.28.0-beta.15] - 2026-05-02

### Added

- **Chat-notification system** — `<ToastStack>` renders bottom-right toasts for incoming
  `maestro-in` messages with 6s TTL, max 3 visible, `+N more` overflow chip, and
  same-sender grouping within 8s. Sidebar ensemble rows show numeric unread badges.
  Click either → routes to that ensemble's chat, clears badge, drops pending toasts from
  that sender. Suppressed when operator is on the active ensemble's chat. (#513)

### Changed

- **Sonner system toasts removed** — 29 toast call sites migrated to inline UI scoped to
  where the action happens: composer-anchored `<ComposerStatus>` banner (slash command
  errors, cue failures), inline wizard error rows (CreateEnsemble, Recruit), and silent
  success for state-changing mutations. `/help` is now a persistent dismissible inline
  banner — fixes the long-standing 4s auto-dismiss wart. Removing Sonner shrinks the
  dashboard JS bundle by ~8 kB gzipped. (#514)

### Fixed

- **Conductor self-report chat projection** — conductor `report` calls rendered as
  `tempo-conductor → conductor` (a self-loop) in the maestro chat feed. Now projects as
  `tempo-conductor → maestro` with `role: 'maestro-in'`, picking up the left-aligned
  in-variant rendering. (#512)
- **CI matrix-skip on doc-only PRs** — `dorny/paths-filter@v3` defaults to
  `predicate-quantifier: 'some'`, causing the `**` pattern to always win on docs-only
  diffs. Added `predicate-quantifier: 'every'` to make negation patterns subtractive
  (gitignore-style). Closes #354. (#518)

### Docs

- `docs/tools.md` updated with `save_state`, `fetch_state`, `clear_state` rows and
  `restart` `loadFromState` / `transcript` params (drift from #502, #503). (#511)
- Design docs filed: notifications system port from canvas (#515); maestro session
  availability fix root-cause + Layer 1/2 design (#517).

## [0.28.0-beta.14] - 2026-05-01

### Added

- **Player saveable state** — `save_state`, `fetch_state`, `clear_state` MCP tools let
  players persist curated context to named slots (max 4, 32 KiB each). Owner-write /
  peer-read by structure; refuses on saturation with `PlayerStateSlotsFull`. Implements
  ADR 0011. (#502)
- **`loadFromState` restart integration** — `restart` now accepts `loadFromState` to seed
  the next session from a saved-state slot instead of (or stacked with) transcript replay.
  Six flag combinations supported including graceful empty-slot fallback and
  `transcript: 'replay'` stack mode. Closes #334. (#503)

### Fixed

- **Daemon snapshot responsiveness under orphaned workflows** — `handle.query()` calls in
  `buildEnsembleSnapshot` and the aggregate poll loop are now bounded with a 2s per-call
  timeout via `queryHandleWithTimeout`. An aggregate tick watchdog (15s) provides
  defense-in-depth. Eliminates unbounded `tick skipped` accumulation when sessions have
  wedged workers. Closes #433. (#501)
- **Dashboard `EnsembleCard` link prefix** — regression test added to lock the fix for the
  `/dashboard/dashboard/` double-prefix bug (fix already on main via drive-by in
  `389edbd28`). Closes #376. (#509)

### Changed

- **Communication-discipline rules in MCP server instructions** — three protocol rules
  delivered to every player on connect: drafting ≠ sending, silent conductor = HOLD, no
  autonomous player dispatch. Captured from real failure modes in overnight orchestration.
  (#505)

### CI / DX

- **Skip build/test shards on doc-only PRs and main merge pushes** — `dorny/paths-filter`
  gates the 4 heavy job groups; lint tripwires still run on every event. Squash-merges to
  main no longer re-run the full matrix. Closes #354, #355. (#507)
- **`npm run check:all`** — chains all locally-runnable CI gates fail-fast; exposes 4 new
  npm scripts (`lint:test-ensemble-literals`, `lint:skip-reasons`, `lint:lockstep-version`,
  `lint:dashboard-css-sync`) that were previously bare CI shell steps. (#508)

### Docs

- PR body conventions for multi-PR issues: use `Refs #N` on intermediate PRs, `Closes #N`
  only on the final PR. Prevents premature GitHub auto-close. (#506)
- CLAUDE.md project-structure tree updated with `terminal-error.ts` and `sdk-probe.ts`
  entries. (#500)

## [0.28.0-beta.13] - 2026-04-30

### Changed

- **Dashboard page-header typography (canvas v=49)** — page-actions optical alignment,
  title-row cap-height alignment, and prefix transform refinement from the Claude Design
  bundle. Popout chat is now non-modal (`role="dialog"` → `role="region"`): the workspace
  stays fully interactive when the popout is open. (#497)

### Docs

- OpenCode adapter coverage added across CLAUDE.md, `docs/tools.md`, and README.md:
  `opencode/` directory entry, `agent: 'opencode'` recruit example, Phase A→B→C trilogy
  summary. (#496)

## [0.28.0-beta.12] - 2026-04-30

### Added

- **OpenCode headless adapter (Phase C)** — fourth adapter `opencode` brings multi-provider
  LLM access (OpenAI, Anthropic, Gemini, Bedrock, etc.) via OpenCode's headless mode.
  `OpenCodeAttachment extends SdkAttachment` inherits the V2 attachment lifecycle (claim,
  heartbeat, phase watcher, processingStart/End pairing) and integrates with the full MCP
  tool surface. Recruit via `recruit({ agent: 'opencode', model? })`; requires OpenCode CLI
  installed. Completes the #449 OpenCode adapter trilogy (Phase A spike → Phase B ADR →
  Phase C implementation). (#485)

### Fixed

- **Dashboard CSS surface tokens** — `--surface-1`, `--surface-2`, and `--text-1` tokens
  are now declared in the canonical CSS, resolving silent token-miss fallbacks introduced
  when the token layer was split in #459. (#487)
- **Dashboard CSS overflow cluster** — 13 audit findings from #461 resolved: `min-width:0`
  guards on flex children, `overflow-wrap: break-word` on text containers, and `flex-wrap`
  discipline across card and list layouts. Prevents content-length-driven layout breaks at
  all tested breakpoints. (#489)

### Tests

- **Dashboard overflow CI guardrail** — 35 new Playwright assertions graduate the #461 audit
  walkers to a canonical CI check; refutation-as-regression locks prevent silent regressions
  on the 13 fixed findings. (#491)

### Docs

- `docs/design/` — #461 dashboard overflow + content-length robustness audit: 13 findings,
  1 auto-P1, v0.28.10 baseline. (#484)
- Surface registry updated to include adapter types and HTTP endpoints (daemon `/v1/*`
  routes), completing #305 coverage. (#488)

## [0.28.0-beta.11] - 2026-04-29

### Added

- **Dashboard chat-input TUI parity** — `@` player-picker and `/` command-picker autofill now
  work in the dashboard chat input, matching the TUI experience. Direct-cue routing sends
  messages straight to the addressed player without the conductor relay. (#477)
- **Dev-mode scriptable CLI verbs** — new CLI verbs available in dev mode for E2E validation
  scripts: deterministic ensemble setup, scenario replay triggers, and teardown hooks.
  Enables fully automated end-to-end test runs without manual orchestration. (#479)

### Fixed

- **CLI `--agent` parser allowlist** — `--agent` flag now sources its allowlist from
  `AGENT_TYPES` instead of a hard-coded list, so newly registered adapter types (e.g.
  `claude-api`) are accepted without a code change. Closes #476. (#478)
- **Dashboard sidebar maestro avatar tile-frame** — maestro avatar in the sidebar was missing
  its tile-frame border; now rendered consistently with other player tiles. Closes #473. (#480)

### Docs

- Post-beta.10 cleanup — adapter listing updated to include `claude-api`, tools-row table
  corrected, WIRE-PROTOCOL model field documented. (#470)
- `docs/research/` — #461 overflow-audit CI tooling spike: Hybrid v0→v1 lean evaluation,
  gap analysis, recommended integration path. (#474)
- `docs/design/` — #449 Phase B: OpenCode adapter ADR + design doc covering protocol
  mapping, session lifecycle, and integration architecture. (#475)
- `docs/design/` — #449 Phase C sequencing note added to OpenCode adapter design. (#481)

## [0.28.0-beta.10] - 2026-04-29

### Added

- **Headless Claude API adapter (#131 Phase C)** — New third adapter `claude-api` runs entirely
  headless via the Anthropic Messages API: no terminal, no Claude Code CLI, suitable for cloud /
  CI / scheduled-work / advisor-precursor environments. `DirectApiAttachment extends SdkAttachment`
  inherits the V2 attachment lifecycle (claim, heartbeat, phase watcher, processingStart/End
  pairing) and adds an in-process MCP server + paired in-memory client so every existing tempo MCP
  tool (cue, report, recall, ensemble, broadcast, recruit, …) works automatically with no per-tool
  integration code. Tool surface is MCP-tools-only in v1; file-edit / shell / web tools deferred
  to Phase 2. Recruit via `recruit({ agent: 'claude-api', model? })`; requires `ANTHROPIC_API_KEY`
  env var and the new `@anthropic-ai/sdk` optional dependency. Default model is `claude-opus-4-7`
  (overridable via recruit-arg or `CLAUDE_TEMPO_API_MODEL` env); model selection is durable on
  `SessionMetadata.model` so restart / encore / migrate recover the original choice across
  `continueAsNew`. Per-turn cost telemetry via structured stderr log
  (`[claude-tempo:claude-api] turn-usage …`); wire-protocol signal deferred until a consumer
  lands. Verification-addendum landmines all wired: thinking-block round-trip, Opus 4.7 parameter
  discipline, `input_json_delta` deferred parse, mid-stream error try/catch, cache-control
  breakpoints (last system + last tool, 2/4 used). Design + ADR + research docs landed in #339,
  #344, #452. Implementation spans `src/adapters/claude-api/` + `src/spawn.ts`
  (`spawnClaudeApiAdapter`) + the shared `src/server-tools.ts` extraction. (#455)
- **PlayerDetail Radix Dialog** — player-detail overlay now uses a proper Radix `Dialog`
  primitive (focus trap, `aria-modal`, `Escape` to close), replacing the ad-hoc overlay.
  Fixes F-A-1 and F-LEAD-2 from the pixel-alignment audit. (#465)
- **Conductor-first sort** — player lists in all dashboard views now place the conductor at
  position 0 regardless of join order or alphabetical name. Fixes a latent bug where a
  7+ player ensemble whose conductor sorted late alphabetically could silently drop the
  conductor from `EnsembleCard`'s 5-row preview slice. Closes #462. (#467)
- **Drift CI guard for `components.css`** — new CI step hard-fails if
  `dashboard/src/components.css` diverges from the canonical port snapshot, preventing silent
  token drift between releases. (#460)

### Fixed

- **Chat-row classifier** — maestro-relative rule now correctly identifies the local player's
  rows when the chat log contains sessions from multiple ensembles. Closes #446. (#448)
- **Settings panel `taskQueue`** — `/v1/health` now surfaces `taskQueue` so the Settings panel
  shows the correct queue name in both production and dev mode. Closes #444. (#451)
- **Generic part default** — players recruited without an explicit `part` now receive a
  player-type-aware default ("Conductor session", "Session in …") instead of a blank string.
  Closes #450. (#453)
- **Dashboard JSX micro-fixes** — closed 6 pixel-audit findings (F-A-3..F-A-7 + H-1) by
  fixing JSX class-application drift across Workspace, PickerList, PickerOption,
  CreateEnsemble, Recruit, and Hosts. The canonical CSS rules were already shipped via
  PR-B (#460); this PR makes them live by applying the classes the rules select. (#466)

### Changed

- **Phone `.table` collapse parity** — dashboard phone breakpoint now fully collapses `.table`
  wrappers to match the pixel-alignment audit target (PR-A of #454). (#456)
- **PlayerTypes column rule** — canonical `.row`/`.display` migration applied to the PlayerTypes
  column; stale class names removed. (#463)
- **Settings test pinning** — ST-1, ST-3, ST-4 design-canvas verdicts pinned; Settings panel
  tests no longer fail on render variance. (#464)
- **Dashboard token hygiene** — hex colour values normalised to lowercase; redundant `rgba`
  whitespace removed from shadow tokens (PR-F of #454). (#457)

### Docs

- `docs/release-process.md` — lockstep call-out: both `package.json` and
  `dashboard/package.json` must be bumped in the same commit; CI hard-fails if they
  diverge. (#447)
- `docs/design/` — pixel-alignment audit for beta.9 baseline (37 findings across 7 PR
  clusters). (#454)
- Settings panel ST-2 live-controls direction ratified in design doc. (#458)
- `docs/research/` — #131 Phase C verification addendum (thinking-block + Opus 4.7
  discipline confirmed). (#452)
- `docs/research/` — #449 OpenCode adapter Phase A spike: architecture mapping, gap
  analysis, integration patterns for future Phase B/C. (#468)

## [0.28.0-beta.9] - 2026-04-28

### Added

- **Dashboard alignment certified (#389)** — Final 100% structural-fidelity pass across all screens. Audit doc, polish bundle, final cleanup, and rev3-cert addendum land in `docs/design/`. (#435, #440, #442, #443)

### Fixed

- **Dev-mode isolation trilogy (#423)** — Dev profile is now fully isolated from production:
  - `TEMPORAL_NAMESPACE` / `TEMPORAL_ADDRESS` env vars are dropped in dev mode so global env can't bleed into the dev profile. (#427)
  - `claude-tempo down` no longer sends a Temporal kill signal that could terminate production workers when invoked in dev mode. (#426)
  - `tempo-mock-jam` lineup: conductor slot was inadvertently set to `claude-code`; corrected to `mock`, making the lineup fully all-mock as advertised. (#429)
- **HostProfile `taskQueue` threading** — `TempoClient.listHosts()` now threads `taskQueue` through correctly in dev mode, fixing host enumeration against the dev Temporal namespace. (#441)
- **Dashboard rev3 follow-up sweep** — Closed 4 residual audit items: empty-description fallback (#430), sub-minute uptime formatting (#431), Settings panel reads live `/v1/health` instead of static config (#436), stale beta.8 copy on Overview (#438). (#439)

### Changed

- Dev-mode isolation design spec added at `docs/design/dev-mode-isolation-fix-423.md`. (#425)
- Dev-mode isolation docs merged into `docs/dev-mode.md`, `docs/configuration.md`, `docs/troubleshooting.md`, and `docs/development.md`. (#428)
- Dashboard rev3 follow-up audit doc at `docs/design/dashboard-audit-389-followup-rev3.md`. (#435)

### Docs

- Post-PR sweep: `CLAUDE.md`, `README.md`, and docs aligned with PRs #382/#385 changes. (#424)

## [0.28.0-beta.8] - 2026-04-28

### Added

- **Wire-extension epic (closes #399)** — 7 new fields surface across the MCP + dashboard layers:
  - **Session**: `runId`, received/sent/outbox message counts, lease expiration (`session.ts` extensions + `claimAttachment` tracking). (#410)
  - **Maestro**: ensemble `description`, `uptime`, `tempo` BPM + 30-min sparkline. New `set_ensemble_description` MCP tool for conductors to maintain mission summaries. (#411)
  - **HostProfile**: `daemonStartedAt` (for Hosts table uptime) and `adapterVersions` (probed at daemon boot via `claude --version` + Copilot SDK `package.json`). (#409)
- **Daemon catalog endpoints (closes #400)** — 3 new HTTP routes: `POST /v1/ensembles`, `GET /v1/agent-types`, `GET /v1/lineups`. CreateEnsemble + Recruit wizards now use live data instead of hardcoded fallbacks. (#412)
- **Destructive action endpoints** — 4 new daemon HTTP routes: `POST /v1/ensembles/:e/{restart,destroy,detach,recall}`. Bearer-protected on non-loopback, thin shims over existing `TempoClient` methods. (#418)
- **Dashboard action wiring** — Player actions (Recall, Restart, Detach, Destroy) now trigger real workflow operations from the dashboard. `ConfirmDialog` gates all destructive actions. Audit P1.3/P1.4/P1.6 fidelity polish folded in. (#420)
- **Dashboard data binding (DB1a/DB1b)** — Q5 wire fields projected into `EnsembleStateV1` + `PlayerSummaryV1`; `EnsembleCard`, `PlayerDetail`, `Hosts`, `Workspace` components consume live data. (#413, #414)
- **Wizard live data (DB2)** — CreateEnsemble + Recruit + PlayerTypes screens use live catalog endpoints instead of static fallbacks. (#415)

### Fixed

- `recall` HTTP response now projects into `{ ok, playerId, messages: number }` for dashboard parity (was returning raw workflow result). (#421)
- `wire-shape.ts` retired — resolved a DB1a/DB1b import race that caused stale type definitions to shadow live ones. (#417)

### Changed

- Audit rev-2 follow-up: Loadouts wire, Workspace schedules side-panel, page-subtitle fidelity. Audit doc landed at `docs/design/dashboard-audit-389-followup-rev2.md`. (#416, #419)

## [0.28.0-beta.7] - 2026-04-28

### Added

- **Dashboard refresh (#389)** — Comprehensive rebuild of the web dashboard to align with the canonical Claude design handoff. Closes the ~70% content gap reported in #389. 13 PRs landed across two days:
  - **Layout & shell**: Layout primitives (PR-A1), mobile shell with PhoneAppBar/TabBar/Switcher (PR-A1m), audit binding spec landed in repo
  - **Chat & tempo primitives**: FeedMessage, Composer, TempoStrip, PopoutWindow (PR-A2)
  - **Screens**: Overview rebuild (PR-B), Workspace desktop+tablet (PR-C1), Workspace mobile (PR-C3), Workspace chat polish + artboard-body containing-block fix (PR-C2), PlayerDetail (PR-D), Loadouts+Schedules (PR-F1), PlayerTypes+Hosts (PR-F2), CreateEnsemble+Recruit wizards (PR-E), Settings sidebar route retiring SettingsSheet (PR-G)
  - Wire-extension fields (#399) render `"—"` placeholders pending follow-up
- **Test infrastructure hardening (#383)** — `setupSharedEnv()` helper centralizes 120 s before-all timeout across all 20 test files; `pollWithTimeout` + `holdAssertion` helpers replace racy `sleep`+assert patterns. Eliminates the class of `before-all` setup-cost timeouts (P1+P2). (#387)
- **Outbox worker sharing + sleep-to-poll migration** — `outbox.test.ts` refactored to shared-worker pattern; sleep-to-poll sweep across the suite; adapter-lifecycle tick bump (P3 of #383). (#391)

### Changed

- **`allow agent="mock"` in dev mode** for `POST /v1/ensembles/:e/recruit` — previously rejected; now gated on `isDevMode()` check. (#388, #390)

## [0.28.0-beta.6] - 2026-04-27

### Added

- **`--dev` profile** for isolated testing — flips home dir to `~/.claude-tempo-dev/`, HTTP port to 8474, Temporal namespace to `claude-tempo-dev`, task queue to `claude-tempo-dev`. Auto-creates the namespace on first dev-daemon boot. Cross-profile coexistence verified (dev + prod daemons run side-by-side without orphan-detector collateral damage). (#381)
- **Mock adapter** (`agent: 'mock'`) — dev-only player adapter with 4 modes: `echo` (replies with `[ECHO] <input>`), `scripted` (replays YAML scenarios), `silent` (drains without dispatch — heartbeat-stale validation surface), `chaos` (probabilistic fail/crash injection with mulberry32 seeded PRNG). 4-layer production safety prevents accidental use outside dev mode. (#382, #385)
- **Scenario library** at `scenarios/` — 5 reference YAMLs (echo-roundtrip, two-player-conversation, conductor-recruit-mock, multi-player-handoff, recruit-cascade). (#382, #385)
- **`tempo-mock-jam` lineup** — example 4-mock ensemble with mixed modes for end-to-end mock testing. (#385)
- **`--scenario <name>` CLI flag** on `up` — forces every mock in the lineup into scripted mode with the named scenario. (#385)
- **`__MOCK__:` cue prefix** — drives mock players interactively from any other player (e.g., `cue mock-1 "__MOCK__:reply Hello"`). Inert in production adapters. (#382)
- Daemon test-fixture mode regression-tested via mock-adapter integration suite. (#382)

### Changed

- **CI Windows mocha now sharded** (1 → 2 jobs, same shard-config as Linux). Per-shard wall-clock roughly halves; pre-existing heavy tests (`pause-resume`, `adapter-claude-code-lifecycle-v2`, `outbox`) get headroom. (#384)
- **CI shard-drift-check gate** added — hard-fails PRs when shard-2/shard-1 wall-clock ratio exceeds 1.2× design limit. Forces rebalance at PR-time before flakes ship. (#384)
- **`MockMode` literal union consolidated** to `src/types.ts` SSOT (was duplicated across 7 files). (#385)

### Internal

- Cross-profile orphan-detector coexistence — `selectOrphans` extended with cross-profile known-PIDs awareness; weak-evidence suppression on partial-state crashes. Documented as design lesson §5.7 in dev-mode-mock-adapter.md. (#381)
- Architect's design + ADR 0014 published for dev-mode + mock adapter. (#379)

## [0.28.0-beta.5] - 2026-04-27

### Fixed

- Published npm tarball was missing `dashboard/dist/` because `npm pack` fell back to `dashboard/.gitignore` (which excludes `dist/*`). Added `dashboard/.npmignore` (presence overrides the fallback) so `package.json#files` whitelist is honored. Added `verify-tarball` guard to both `release.yml` and `ci.yml` to catch regressions. (#378)
- `claude-tempo dashboard` CLI verb missing from `docs/cli.md`, `docs/SURFACE-REGISTRY.md`, and `CLAUDE.md`. Added the entries + extended `scripts/check-surface-drift.js` to recognize pre-switch dispatch verbs (root cause: it had a hardcoded list missing `dashboard`). (#377)

## [0.28.0-beta.4] - 2026-04-27

### Added

- **Web dashboard v1** (#340 — PRs #363, #365, #366, #367, #369, #370, #371, #372, #373):
  React + Vite + Tailwind 4 SPA served at `/dashboard` from the existing daemon HTTP server.
  Open via new CLI verb `claude-tempo dashboard`. Read-only Overview, Workspace, PlayerDetail,
  and 5 secondary screens. Cross-device pairing via QR-code one-time-bearer token flow.
- **Daemon test-fixture mode** (#340 — PR #365): `/v1/state/:ensemble` and `/v1/events/:ensemble`
  accept `?fixture=<name>` to return canned scenarios instead of live Temporal queries. Six
  fixtures: `empty-ensemble`, `single-conductor`, `eight-player-broadcast`, `conductor-leaving`,
  `sse-reconnect`, `chat-stress`. Type-safe: every fixture imports from `src/http/event-types.ts`.
  See `docs/SSE-PROTOCOL.md` § 11a.
- **Daemon HTTP write endpoints** (#340 — PR #371): `POST /v1/ensembles/:ensemble/{cue,pause,play,release,recruit}` —
  bearer-protected on non-loopback. Thin shims over existing `TempoClient` methods; zero new
  Temporal signals/queries/updates. See `docs/SSE-PROTOCOL.md` § 11b.
- **`claude-tempo dashboard` CLI verb** (#340 — PR #372): Opens the dashboard in the default
  browser. Flags: `--port`, `--bind`, `--no-open`, `--pair` (prints/QR-codes a one-time pairing token).

### Changed

- `docs/SSE-PROTOCOL.md` §2 updated: "Reads via GET, writes via POST under same auth model"
  (was: "No write endpoints in v1")

### Internal

- Dashboard testability infrastructure (#340 — PR #366): ESLint custom rule blocks native
  modals (`confirm`/`alert`/`prompt`/`<dialog>`); structured `logEvent('[claude-tempo:dashboard] ...', {...})`
  wrapper; `data-testid` convention enforced via DOM-crawl test.
- Optimistic update + SSE reconciliation for cue mutations (no duplicate chat rows)
- Playwright e2e suite (4 smoke tests) wired into CI (#340 — PR #372)

## [0.28.0-beta.3] - 2026-04-27

### Added

- `broadcastId` field on `EnsembleChatMessage` wire shape — additive optional field; all fan-out messages from a single broadcast share the same id (#357)
- `--received-only` flag on TUI `/recall` command for opting out of the new default (#361)

### Fixed

- TUI status bar and chat-input footer no longer show "No conductor" when one exists — single source of truth via `state.players.find(p => p.isConductor)` (#358)
- TUI broadcast messages collapse to one chat row with `📡 broadcast → N players` badge instead of N duplicate rows (#357)
- TUI directed messages render with `→ @<player>` recipient prefix in chat history (#360)

### Changed

- TUI `/recall` defaults to showing both received and sent messages (was: received-only) — pass `--received-only` to restore old behavior. MCP tool default unchanged. (#361)

### Internal

- `ConversationEntry` type consolidation in TUI store (qa-1)
- `UPSERT_PLAYER` action documented as requiring full `MaestroPlayerInfo` snapshot — for sparse updates use `PATCH_PLAYER_PHASE` pattern (qa-2)

## [0.28.0-beta.2] - 2026-04-27

### Fixed

- SSE event envelope was not unwrapped by client subscriber, causing TUI to stay in "Loading..." state and miss snapshots (#351)
- `player.phase_changed` handler clobbered hostname/part/isConductor with empty strings via spread merge (#351)

## [0.28.0-beta.1] - 2026-04-27

### Added

- **Daemon HTTP/SSE event source** (#94, #95 — PRs #320 + #324): The daemon now exposes an HTTP
  server on a local port with snapshot + streaming endpoints. New endpoints:
  `GET /v1/health`, `GET /v1/ensembles`, `GET /v1/state/:ensemble`, `GET /v1/hosts`,
  `GET /v1/events/:ensemble` (per-ensemble SSE stream), `GET /v1/events` (global cluster stream).
  Per-ensemble streams deliver a snapshot prelude, replay from a 256-event ring buffer on
  reconnect (`Last-Event-ID`), and a `gap` event on overflow. Bearer auth + CORS; loopback
  connections skip auth. Token auto-generated to `~/.claude-tempo/config.json` on first
  bearer-required boot. See [docs/SSE-PROTOCOL.md](docs/SSE-PROTOCOL.md).
- **`TempoClient.subscribe()` AsyncIterable** (#94, #95 — PR #325): Programmatic SSE consumer
  for dashboards and external integrations. Dual transport: native `EventSource` (browser /
  loopback, free auto-reconnect) and `fetch`-based (Node / bearer, manual reconnect). Exposes
  the full `ClusterEvent` type stream from the daemon event source.
- **TUI live streaming** (#94, #95 — PR #348): The TUI now drives all ensemble/player state
  from `client.subscribe()` instead of the previous 2-second poll loop. Sub-second event
  latency; reconnect handled transparently.
- **`claude-tempo daemon stats`** (#336 — PR #343): New CLI subcommand prints live memory usage,
  uptime, active ensembles, and SSE subscriber count from the local daemon's `/v1/health`
  endpoint. Defensive formatters return `n/a` for pre-#336 daemons.
- **`/v1/health` memory field** (#336 — PR #343): Health endpoint now includes a `memory`
  snapshot (`rss`, `heapUsed`, `heapTotal`, `external`, `arrayBuffers`). Optional field —
  backward-compatible with older consumers.
- **Adapter process-lifecycle telemetry** (#258 — PR #328): Structured log lines on all
  process exit/signal/uncaught events (Hypothesis A coverage). Distinguishes process-death
  from in-loop `fireTerminal` silence. Grep `[claude-tempo:adapter]` in daemon logs.
- **`destroy` partial-failure UX hint** (#306): When an ensemble-scope destroy has any
  failed peer, the response headline shifts to `"partially destroyed"` and adds a recovery
  hint (`run /destroy <ensemble> again to clean up`).
- **`restore` cross-host `hostname` arg** (#306): The `restore` MCP tool and `claude-tempo restore`
  CLI now accept an optional `hostname` parameter to target orphaned sessions from a specific
  remote host.
- **Surface drift detector + CI** (#305 — PR #342): `scripts/check-surface-drift.js` +
  `npm run lint:surface-drift` — diffs `docs/SURFACE-REGISTRY.md` against source (MCP tools,
  CLI commands, TUI slash commands); exits non-zero on undocumented or phantom entries.
  Wired into CI as the `lint-surface-drift` job.
- **Windows test matrix + EACCES retry** (#150 — PR #335): New `build-and-test-windows` CI
  job (Node 22). `TestWorkflowEnvironment.createLocal()` now retries up to 3 times with
  back-off on `EACCES`, reaping orphan Temporal server PIDs between attempts. Handles
  Windows Defender real-time scans and stale file handles from prior crashed runs.

### Fixed

- **Outbox silently broken after force-restart** (#347 — PR #349): Any player that was
  force-restarted could not send outbox messages (cue, report, etc.) — all failed with
  `workflow execution not found`. Root cause: `src/server.ts` used the handle returned by
  `client.workflow.start()` for MCP tool registrations, pinning `firstExecutionRunId`. After
  a continue-as-new or force-restart mint, `executeUpdate` on the stale run ID rejected
  immediately. Fix: 2-line change — replace with `client.workflow.getHandle(workflowId)`
  (unpinned, resolves to latest run). The `startedHandle` for chain-end watching is retained
  with `followRuns: true`.
- **Adapter post-CAN double-loop silence** (#258 — PR #322): Added a `describe()` tiebreaker
  + structured `fireTerminal` log to prevent the post-continue-as-new double-loop from
  silently reaping a healthy adapter attachment.
- **Mocha zombie test-server cleanup** (PR #312): `mochaGlobalTeardown` + `process.on('exit')`
  + signal handlers now reap orphan ephemeral Temporal server processes even when
  `TestWorkflowEnvironment.teardown()` is skipped mid-suite (crash, signal).

### Changed

- **`TempoClient` split into `Core` + `WithSpawn`** (#308 — PR #329): `TempoClientCore`
  exposes 38 pure-RPC methods (including `subscribe`); `TempoClientWithSpawn` extends it
  with `createEnsemble` and `spawnConductor`. `type TempoClient = TempoClientWithSpawn`
  preserves every existing import — no migration required.
- **Tier-1 dead code removed (~408 LoC)**: `src/tools/detach.ts` (file removed; plumbing
  stays internal to `shutdown`), `CommandOverlay.tsx`, `ScheduleOverlay.tsx` (superseded TUI
  components), 7 dead utility exports, `buildOrphanQuery` positional overload,
  `DEFAULT_RECRUIT_ANSWERS` constant.
- **Hosts cluster cleanup** (#280–#283): DI grouping, combined `hostProfilesWithExistence`
  query, concurrency cap, and ADR to document the design.

### Docs

- **5 design ADRs merged**: coat-check pattern for large cues (ADR 0008, #318), protobuf
  payload migration strategy (ADR 0009, #319), player-saveable state primitive (ADR 0011,
  #334), headless Claude API adapter scoping (ADR 0012, #131), web dashboard scoping
  (ADR 0013, #340).
- **Surface registry** (#305 — PR #333): `docs/SURFACE-REGISTRY.md` — canonical inventory
  of all 33 MCP tools, 23 CLI commands, and 28 TUI slash commands for drift detection.
- **Dashboard design handoff bundle** (#340 — PR #345): `docs/design/dashboard-handoff/`
  includes the Claude Design export (HTML prototypes, JSX components, CSS design tokens,
  SVG assets). Canonical source of truth for the #340 implementation phase.
- **Doc archive sweep** (PR #311): Completed handoff notes, design spikes, and ops checklists
  moved to `archive/` subdirectories; ghost `src/tui/client.ts` shim references removed.

## [0.27.0] - 2026-04-26

### Breaking Changes

- **CLI minimal surface** (#288): `stop`, `restart`, `detach`, `migrate`, `conduct`, `start`,
  `pause`, `resume`, and `disband` are removed from the CLI. Use the TUI slash commands
  (`/restart`, `/shutdown`, `/destroy`, `/pause`, `/play`, `/recruit`) instead. A migration
  table is at [github.com/vinceblank/claude-tempo/issues/285](https://github.com/vinceblank/claude-tempo/issues/285).
- **MCP tool renames** (#287): `pause_ensemble` renamed to `pause`; `resume_ensemble` renamed
  to `play`. Update any scripts or prompts that call these tools by name.
- **Lineup schema: conductor required** (#286): Lineup YAML files must now include a top-level
  `conductor` field. Lineups without one are rejected at load time with a schema validation
  error.

### Changed

- **Bootstrap preflight slimmed** (#289): Bare `claude-tempo` invocation no longer probes for
  the `claude` binary at startup — redundant with `resolveClaudePath()` and too strict for
  Copilot-only setups. Missing `claude` is now surfaced at spawn time with a clearer
  per-recruit error. Preflight hard requirements remain Node ≥ 20 and a writable
  `~/.claude-tempo`.
- **`down --destroy`** (#288): `claude-tempo down` gains a `--destroy` flag that terminates
  every workflow across every ensemble before tearing down infrastructure. Replaces the
  previous multi-step `destroy` + `down` sequence.
- **`restore` rewritten to ensemble-scope** (#288): `claude-tempo restore <ensemble>` now
  targets a single ensemble on this host. The interactive multi-flag picker (`--all`,
  `--from-host`, `--dry-run`) is replaced by the TUI home-view restore modal.

### Added

- **`shutdown` and `restore` MCP tools** (#287): New ensemble-scope tools — `shutdown` gracefully drains all players and stops the conductor; `restore` reattaches orphaned `detached` sessions on the current host. Replace per-player `detach` call chains.
- **TUI home view** (#290): Bare `claude-tempo` invocation launches a two-list home screen
  (all running ensembles + players) with a restore modal for orphaned sessions. Connects to
  the global Maestro for cross-ensemble discovery.
- **TUI slash commands aligned with MCP surface** (#291): New commands — `/play`, `/shutdown`,
  `/restore`, `/home` — mirror the renamed/new MCP tools. `/destroy` extended to accept an
  ensemble name in addition to a player name. Legacy commands (`/detach`, `/disband`,
  `/resume`, `/pause_ensemble`, `/resume_ensemble`) show migration hints.
- **`TempoClient.spawnConductor` + `ensureConductorSpawned`** (#291): New helpers on the
  `TempoClient` interface for orchestrating conductor lifecycle from the TUI restore flow and
  bootstrap state machine.
- **`TempoClient.restore()`** (#302): Wired through `TempoClient` so the TUI restore modal
  and CLI `restore` command share a single implementation path.
- **Auto-provisioning bootstrap state machine** (#289): Six-step idempotent sequence
  (preflight → MCP config → Temporal reachability → search attributes → daemon → conductor)
  runs on bare `claude-tempo` invocation and produces a `BootstrapResult` consumed by the
  home view as initial props.
- **`/exit` alias** (#306): `/exit` is now a registered alias for `/quit` in the TUI.
- **`/restart` defaults `force=true`** (#306): `/restart` steals a live lease by default;
  pass `--no-force` to refuse if a lease is currently held.
- **Home view ensemble classification** (#306): The home screen now classifies ensembles as
  `online`, `paused`, or `offline` with distinct visual groupings.
- **Paused-ensemble indicator in StatusBar** (#306): The TUI status bar shows a visual
  indicator when the current ensemble is paused.
- **Bottom-pinned notifications** (#306): Command summaries, confirmations, and errors are
  pinned below the input field with configurable TTL (8 s errors, 5 s info/warn) so they
  don't scroll away.
- **Player-name autocomplete** (#306): The command palette autocompletes player names for
  `/restart`, `/destroy`, `/attachment-info`, and `/worktree`.

### Fixed

- **Orphan-recovery helper extracted to shared module** (#93): `reconcileOrphans` logic moved
  to `src/reconcile/orphans.ts` and reused by both daemon reconcile-on-boot and the new CLI
  `restore` command, eliminating the previous duplication.
- **`/destroy conductor` blocked** (#306): Attempting to destroy the conductor via `/destroy`
  now shows an error with a redirect hint to `/shutdown` or `/restart conductor`.
- **`/ensemble` (no args) navigates home** (#306): Bare `/ensemble` used to open an
  interactive picker; it now navigates to the home view. Use `/ensemble <name>` to switch.
- **`stopDaemon` reaps zombie processes** (#306): `claude-tempo daemon stop` now also reaps
  any zombie daemon processes left behind by a crash, preventing stale PID files from
  blocking subsequent starts.
- **`restore` treats 'conductor already running' as success** (#306): The restore flow no
  longer errors when the conductor is already live — it records the session as `alreadyLive`
  and continues.
- **`restore` fans out `setPaused=false` to every session** (#306): Unpausing an ensemble
  via restore now correctly signals every session, not just the maestro.
- **Home view refresh on mount** (#306): The home screen now refreshes ensemble data on
  mount and shows 'Loading…' instead of a blank flash before data arrives.
- **Chat input hidden on home view** (#306): The message input area is no longer visible
  on the home screen, where it has no function.

## [0.26.0] - 2026-04-20

> **Upgrade guide:** [`docs/ops/v0.26-migration.md`](docs/ops/v0.26-migration.md) —
> cluster-side attribute-drop commands, SDK consumer-update checklist, and rollback steps.

### Breaking Changes

- **`ClaudeTempoStatus` search attribute removed.** Lifecycle truth now lives on
  `ClaudeTempoAttachmentState` (seven phases: `booting | attached | processing |
  awaiting | draining | detached | gone`) and the `attachmentInfo` query. Long-lived
  Temporal clusters must manually drop the attribute — see the migration guide. (#174, beta.1)
- **`SessionStatus` TypeScript enum removed** from the public SDK surface.
  Use `AttachmentPhase` for lifecycle-typed code. (#174, beta.1)
- **`SessionMetadata.status`, `EnsembleSessionInfo.status`, and `MaestroPlayerInfo.status`
  removed.** `EnsembleSessionInfo.phase?: AttachmentPhase` and `MaestroPlayerInfo.phase`
  replace them. (#174, beta.1)
- **`updateMetadata` signal: `status?` field removed** from the TypeScript payload type.
  The handler has ignored the field since v0.26-beta.1; callers passing
  `status: 'active' | 'pending' | 'terminated'` must drop the field. (#212, beta.2)
- **Dropped Node 18.** Minimum is now Node 20. (#204, beta.2)
- **`createWorker()` factory removed** from `src/worker.ts` (threw-on-call since v0.10).
  Use `createWorkers()` which returns `{ sharedWorker, hostWorker }`. (#212, beta.2)
- **`src/tui/client.ts` back-compat re-export removed.** Switch to
  `claude-tempo/client`. (#212, beta.2)
- **TUI `/recall [player]`** now queries the named player's inbox directly (or the maestro
  session if omitted), matching MCP and CLI. Previously rendered an aggregated maestro
  relay-log view filtered by player name. (#128, beta.6)
- **End-to-end upgrade required.** A v0.25 CLI/TUI paired with a v0.26 daemon (or the
  reverse) is not supported. Upgrade both sides together. (#174, beta.1)

### Added

- **`hosts` MCP tool + `claude-tempo hosts` CLI command** — lists daemons polling this
  Temporal namespace with their advertised capabilities. `recruit` now validates the
  target host is live before spawning; pass `force: true` to bypass pre-flight. (#274)
- **GitHub App integration** — `scripts/ensemble-gh` wrapper mints `claude-tempo[bot]`
  installation tokens per-call for bot-authored PR/issue writes. (#276)
- **`claude-tempo recall <player>` CLI command** — reads a player's inbox with full flag
  parity to the MCP tool (`--limit`, `--offset`, `--preview`, `--from`, `--since`,
  `--include-sent`, `--json`). (#128, beta.6)
- **`attachment-info` heartbeat age** — CLI (`--heartbeat`) and TUI now display heartbeat
  age alongside lease expiry, matching the MCP tool. Output is identical across all three
  surfaces via a shared formatter (`src/utils/attachment-format.ts`). (#264, #138, betas 5–6)
- **`recall` paging + preview** — MCP tool gains `offset` (paging) and `previewLength`
  (body truncation) parameters. Message bodies are returned in full by default (no
  implicit truncation). (#128, beta.6)
- **Daemon heartbeat file** at `~/.claude-tempo/daemon.heartbeat` (touched every 60 s);
  `daemon status` reports its age, distinguishing a healthy main loop from a hung
  process. (#157, beta.3)
- **`daemon start` pre-flight orphan check** — aborts with exit 1 if unexpected
  claude-tempo daemon processes are found; `--force` bypasses. (#157, beta.3)
- **Crash-proof CLI commands** — `version`, `help`, `upgrade`, `config show/set` no
  longer import Temporal at startup, so they work even when the daemon connection is
  broken. (#157, beta.3)
- **Migration guide:** [`docs/ops/v0.26-migration.md`](docs/ops/v0.26-migration.md) —
  cluster attribute-drop commands, SDK consumer-update checklist, rollback steps. (beta.1)

### Fixed

- **Message-delivery trilogy** (#249, beta.4): Four compounding bugs caused long-running
  ensembles to silently stop delivering inbound cues after a `continueAsNew` boundary:
  (1) `tickHeartbeat` `try/finally` reschedule — orphaned heartbeat timer on any guard
  trip; (2) `tickPhaseWatcher` orphan parity — same fix; (3) CAN-boundary lease math now
  uses `currentAttachment.leaseMs` (3× heartbeatMs) instead of a hardcoded 30 s; (4)
  message-poller surfaces terminal `WorkflowNotFoundError` and rebinds to the successor
  run instead of spinning against a dead runId.
- **Sessions self-heal after `continueAsNew`** (#226, beta.3) — adapter reads the closed
  run's history for a `WorkflowExecutionContinuedAsNewEvent` and rebinds `pinnedHandle`
  to the successor in place; no re-claim required.
- **Sessions self-heal after laptop sleep / network drop** (#201, #205, beta.2) —
  `InteractiveAttachment` re-attempts `claimAttachment` with exponential back-off for up
  to 15 minutes before giving up.
- **`destroy` terminates orphaned processes on `phase=detached` sessions** (#227, beta.4)
  — hard-terminate guard now fires whenever a hostname is known, not only when
  `currentAttachment` is non-null.
- **worktree `create` correctly repoints HEAD** (#261, beta.5) — reusing an existing
  directory with a different branch no longer silently reports the requested branch
  without updating HEAD.
- **Orphan reconcile mis-parsed player identities with dashes** (#217, beta.3) — e.g.
  `tempo-eng` in ensemble `tempo-impl` no longer splits as
  `ensemble=tempo-impl-tempo, playerId=eng`.
- **Copilot bridge stderr noise suppressed on non-Copilot startup** (#122, beta.4) —
  `@github/copilot-sdk is not installed` no longer prints on every `claude-tempo up`
  for users without the Copilot SDK.

### Removed

- Legacy `_heartbeat` / `_ping` workflow probe messages.
- 3-minute stale detection and 5-minute blocked-window heuristics (replaced by adapter
  lease expiry and `processingDeadline`).
- `ClaudeTempoStatus` search attribute (use `ClaudeTempoAttachmentState`).
- `BLOCKED_WINDOW_MS` / `SessionStatus` from `src/utils/validation.ts`.
- `test/blocked-detection.test.ts` — obsolete.
- `docs/ops/v0.25-beta1-release-checklist.md` — superseded by the v0.26 migration guide.

---

<!-- Pre-release history: beta.1 through beta.7 entries are preserved below. -->

## [0.26.0-beta.7] - 2026-04-20

### Fixed
- `recall` CLI and TUI now enforce `--limit` max=100, matching the MCP tool (closes a parity gap from v0.26.0-beta.6). (#270)

## [0.26.0-beta.6] - 2026-04-19

### Added
- `recall` MCP tool: new `offset` (paging) and `previewLength` (body truncation) parameters (#128).
- New `claude-tempo recall <player>` CLI command — reads a player's inbox with full flag parity to the MCP tool (`--limit`, `--offset`, `--preview`, `--from`, `--since`, `--include-sent`, `--json`) (#128).
- TUI `/attachment-info` now renders heartbeat age, matching the CLI and MCP surfaces (#264).

### Changed
- **Breaking (TUI):** `/recall [player]` semantics changed — now queries the named player's inbox directly (or the maestro session if omitted), matching MCP and CLI. Previously rendered an aggregated maestro relay-log view filtered by player name. (#128)
- `recall` no longer truncates message bodies by default — full text is returned unless `previewLength` is set (#128).
- `attachment-info` output is now identical across CLI, TUI, and MCP, rendered by a single shared formatter (`src/utils/attachment-format.ts`) (#264).

## [0.26.0-beta.5] - 2026-04-19

### Added
- CLI: `attachment-info` command now displays heartbeat age (#138)

### Fixed
- worktree tool `create` action: reusing an existing directory with a different branch now correctly repoints the inner HEAD and refuses to destroy uncommitted work (previously silently reported the requested branch without changing HEAD) (#261)

## [0.26.0-beta.4] - 2026-04-19

> **Beta release.** Closes the message-delivery trilogy (#249): heartbeat/watcher orphan fix,
> CAN-boundary lease math correction, poller CAN-blindness fix, and full diagnostic observability.
> Also includes TUI identity-guard fixes, outbox retry hardening, and wire-protocol cleanup.
>
> **Install:** `npm i -g claude-tempo@0.26.0-beta.4`
> **Rollback:** `npm i -g claude-tempo@0.26.0-beta.3`

### Fixed

- **Message-delivery trilogy — heartbeat/watcher orphan + CAN lease math +
  poller CAN-blindness** (#249). Four compounding bugs caused long-running
  ensembles to silently stop delivering inbound cues: cues landed in workflow
  inboxes as signal events, the workflow reported `phase=detached`, `recall`
  still retrieved messages, but nothing ever pushed them into the Claude Code
  session's context — and no adapter log fired. Reliable repro on
  `v0.26.0-beta.3` after a multi-hour conductor session with at least one
  `continueAsNew` boundary. Fixes:
  1. **`tickHeartbeat` try/finally reschedule** (`src/adapters/base.ts`).
     Pre-fix early-return paths (guard trips, handled terminal errors)
     silently orphaned the heartbeat timer; the loop died with no teardown,
     no log, no state change. Now wrapped in `try/finally` that reschedules
     unless `stopped`, `reconnecting`, or `terminalFired` — the reconnect loop
     and terminal machinery retain ownership of their cases, everything else
     rearms.
  2. **`tickPhaseWatcher` orphan parity** (`src/adapters/base.ts`). Same
     orphan shape, same fix. When the heartbeat loop dies, the watcher is the
     only remaining self-heal surface — losing it too meant no recovery short
     of process restart.
  3. **CAN-boundary lease math matches adapter cadence**
     (`src/workflows/session.ts`, `src/workflows/attachment-math.ts`).
     Pre-fix the `continueAsNew` extension was a hardcoded 30s, disconnected
     from the adapter's actual `heartbeatMs` (60s for `claude-code`). A CAN
     between heartbeats reaped healthy attachments before their next tick
     could land. Post-fix uses `currentAttachment.leaseMs` (= 3× heartbeatMs,
     negotiated at claim time), guarded by a `patched('v0.26-can-lease-from-attachment')`
     so pre-#249 histories still replay deterministically. `extendAttachmentForCAN`
     parameter renamed `heartbeatMs → extendMs` to match the semantic.
  4. **Message-poller surfaces terminal `WorkflowNotFoundError`**
     (`src/adapters/claude-code/adapter.ts`). Pre-fix the poller swallowed
     every error — a CAN closed the pinned runId, `handle.query('pendingMessages')`
     threw terminal-class, but the poller just backed off and spun forever
     against a dead run while the successor ran unattended. Post-fix the
     poller uses the newly-extracted `src/adapters/terminal-error.ts`
     `isTerminalWorkflowError` classifier, logs the terminal event, and
     exits cleanly; the base class's heartbeat/watcher rebind path restarts
     a fresh poller on the successor via `onReconnected` (depends on bugs
     1+2 being fixed — revert together).
  5. **Diagnostic logging** for recurrence detection: `first heartbeat
     scheduled in Xms` after claim, `heartbeat#1 delivered` on first tick,
     `heartbeats-delivered=N` / `phase-ticks=N` summary every 10 ticks,
     structured `guard tripped: {...}` on any tick early-return, and a
     `WARNING: heartbeat staleness` line when the phase-watcher observes
     `lastHeartbeatAt` falling more than 2× `heartbeatMs` behind `now`.
     Operators can `grep '\[claude-tempo:adapter\]'` for breadcrumbs instead
     of parsing Temporal history for hours.
- **Suppress spurious `[copilot-bridge]` stderr on non-Copilot MCP startup** (#122).
  `src/adapters/copilot/adapter.ts` was printing "Error: @github/copilot-sdk is not
  installed" to stderr on every `claude-tempo up` / `src/server.ts` startup for users
  who don't have the Copilot SDK installed. The error only makes sense when the file is
  run as the Copilot bridge subprocess entrypoint — not when the adapter registry imports
  the class descriptor at startup. Fix: moved the `console.error` + `process.exit(1)`
  inside the `require.main === module` guard so non-Copilot users see no noise at startup.
- **`destroy` now terminates orphaned processes on `phase=detached` sessions**
  (#227). Before this, the destroy handler's hard-terminate branch was gated on
  `if (currentAttachment)` — correct for `phase=attached` (the original #164
  repro) but silently skipped when `phase=detached` (currentAttachment had been
  nulled by the lease-reap path). Combined with the #226 CAN-cascade that
  commonly left entire ensembles detached before teardown, every destroy
  leaked its `claude.exe` + terminal tab; reliable repro during beta.2
  teardown where 7/7 player workflows destroyed successfully but 7/7 processes
  survived. The fix expands the guard to fire `hardTerminateAttachment`
  whenever a host is known, pulling from the same provenance chain used
  elsewhere (`currentAttachment.hostname` → `lastAdapterMeta.hostname` →
  `preferredHost` → `input.metadata.hostname`). `hardTerminateAttachment`
  itself is unchanged — its existing command-line match (`-n <playerName>`
  AND `--remote-control-session-name-prefix <ensemble>`) plus image-name
  PID-reuse guard already gives the equivalent of a stored-PID +
  attach-time validation without any wire-protocol change. Best-effort, 5s
  timeout, log-and-continue on failure. Regression-guarded by two new
  integration tests in `test/destroy.test.ts` (one each for the attached
  and detached paths) and an edge-case guard for the never-attached path.
  Cross-reference: #159 (earlier same-family Windows orphan bug), #164
  (initial attached-path hardTerminate wiring), #226 (adapter CAN-reconnect
  bug that exposed this cascade in the wild).
- TUI store reducer now preserves state identity on clamped no-ops for
  `STATUS_SCROLL_UP` and `PICKER_UP` — dispatching up-arrow at the top of a
  list no longer triggers a spurious re-render (#244).
- TUI palette reducer now preserves state identity on clamped no-ops, eliminating
  spurious re-renders when arrow-key repeat hits index 0 / clamped max (#108).
- TUI `/`-command parser respects quoted arguments; `/schedule create … "0 * * * *"`
  and any other command taking a multi-word quoted value now tokenize correctly.
  Adds an optional `unterminatedQuote?: boolean` flag on `ParsedCommand` for
  strict downstream callers — the on-keystroke TUI path ignores it and keeps
  forgiving input behavior (#109).
- `PlayerDetailView` correctly pluralizes "earlier message(s)" via the existing
  `formatEarlierIndicator` helper — fixes the long-standing "1 earlier messages"
  grammar bug (#110).

### Changed

- Extended the `classifyAndRethrow` / `isRetryableTemporalError` error-
  classification pattern (introduced for `deliverDetach` /
  `deliverDestroy` / `deliverRestart` in PR #235) to the remaining six
  outbox delivery activities: `deliverCue`, `deliverReport`,
  `terminateSession`, `startRecruitedSession`, `releasePlayer`, and
  `spawnProcess`. Transient Temporal RPC errors (`TransportError`,
  `DEADLINE_EXCEEDED`, `UNAVAILABLE`, `ECONN*`, etc.) now re-throw as
  plain `Error` so the activity retry policy can back off and retry;
  permanent classes (`WorkflowNotFoundError`, `WorkflowUpdateFailedError`,
  "workflow execution already completed") and unknown errors stay
  `ApplicationFailure.nonRetryable`. Pre-existing `deliverCue` and
  `terminateSession` gain a new outer try/catch (previously no
  catch-all; `handle.signal` / `handle.executeUpdate` errors bubbled
  raw); `startRecruitedSession` and `spawnProcess` additionally gain the
  `ApplicationFailure` passthrough guard (pre-#236 minor bug —
  `classifyAndRethrow` restores it for free). Fifteen new unit tests
  cover the retryable / non-retryable / unknown-default paths for the
  five mock-driveable activities; `spawnProcess` coverage is deferred
  pending module-stubbing test infra (OS-level errors don't match the
  classifier's Temporal signatures, so behavior is byte-for-byte
  preserved). (#236, follow-up to #140)
- Replaced the wire-protocol drift detector's keyword-based
  `kindFromSectionHeader` with an explicit `SECTION_TO_KIND` allowlist that
  throws on any section header not in the table
  (`test/wire-protocol.test.ts`). Renames or typos in
  `docs/WIRE-PROTOCOL.md` `## Section Header`s now surface as an immediate
  test failure (`"Unknown WIRE-PROTOCOL section: ..."`) instead of
  silently dropping drift coverage for the renamed section. Also removes
  the dead `|| lower.includes('query')` branch from the old keyword
  matcher. Two new unit tests pin classification for all 18 current
  sections and assert the unknown-throws contract. (#239, follow-up to #126)
- Tightened `phaseTag()` in `src/tools/ensemble.ts` to accept
  `AttachmentPhase | undefined` instead of `string | undefined`. Callers
  always have the typed phase in hand via `EnsembleSessionInfo.phase`;
  `string` lost enum discipline. Pure type tightening, zero runtime
  behavior change. (#203)
- Extracted shared search-attribute extraction helper to
  `src/utils/search-attributes.ts` and migrated 9 call sites across
  `src/client/index.ts`, `src/cli/commands.ts`, `src/tools/broadcast.ts`,
  and `src/activities/resolve.ts`. The new module exports
  `getSearchAttrString` / `getSearchAttrBool` primitives and typed wrappers
  `getAttachmentPhase` (reads `ClaudeTempoAttachmentState` as
  `AttachmentPhase`), `getEnsembleName` (reads `ClaudeTempoEnsemble`), and
  `getIsConductor` (reads `ClaudeTempoIsConductor`). Structural
  `SearchAttributeCarrier` type — no `@temporalio/client` import — keeps
  the util reusable from tests and future callers. Pure refactor, no
  behavior change. (#203)
- **Extract CAN-boundary attachment-extension math into a pure function** (#127).
  The 4-line "push `lastHeartbeatAt` / `expiresAt` out to `now + heartbeatMs` so
  the new execution has room to land the next heartbeat" math was previously
  inlined in `src/workflows/session.ts` immediately before `continueAsNew`,
  making it effectively untestable without a full history-fill harness (rejected
  in the PR-G architect review per #127 rationale — such a harness would test
  Temporal's CAN-trigger heuristic rather than our extension logic, and is
  brittle to SDK internals). The math now lives in
  `src/workflows/attachment-math.ts` as the pure function
  `extendAttachmentForCAN(attachment, heartbeatMs, now)`, backed by focused
  unit tests in `test/workflows/can-boundary-extension.test.ts` (which was
  previously an all-skipped stub awaiting this extraction). Behavior unchanged
  — the session workflow call site is a one-line swap. Follow-up to #125
  (PR-G) architect review.
- **Outbox delivery activities now retry transient Temporal RPC errors** instead
  of flattening every mid-algorithm failure to `ApplicationFailure.nonRetryable`.
  `deliverDetach`, `deliverDestroy`, and `deliverRestart` route uncaught errors
  through a new `isRetryableTemporalError` classifier: `TransportError`,
  `TimeoutError`, `DEADLINE_EXCEEDED`, `UNAVAILABLE`, `RESOURCE_EXHAUSTED`,
  `CANCELLED`, and common `ECONN*` / `ETIMEDOUT` signatures are re-thrown as
  plain `Error` so the activity retry policy backs off and retries. Permanent
  classes (`WorkflowNotFoundError`, `WorkflowUpdateFailedError`, "workflow
  execution already completed") and unknown errors stay non-retryable. Typed
  `ApplicationFailure.nonRetryable` throws inside the activity (e.g. "no
  session found", "phase=gone") pass through unchanged. (#140)
- Extracted `DEFAULT_RESTART_DETACH_DEADLINE_MS` (5s) and
  `DEFAULT_RESTART_LEASE_MS` (90s) constants from `deliverRestart` into
  `src/utils/validation.ts` for consistency with the other restart / detach
  knobs already documented there. No behavioral change. (#139)
- **Wire-protocol drift detector scopes doc extraction to section headers** (#126).
  `test/wire-protocol.test.ts` now splits `docs/WIRE-PROTOCOL.md` at `## Section Header`
  boundaries and only extracts names from sections whose headers indicate signal / query /
  update content. Sections like "## Type Reference", "## Workflow Names", and
  "## Search Attributes" are skipped. This eliminates the `TYPE_REFERENCE_FIELDS` allowlist
  that grew with doc surface and could silently mask a real undocumented wire name sharing
  a common field identifier. Matching is now by `(kind, name)` pairs — a handler documented
  as a Signal but declared as `defineQuery` in source will be caught as drift.
- **`this.skip()` calls in test files now require a `// SKIP-REASON:` annotation** (#223). `scripts/lint-skip-reasons.js` scans `test/` and `tests/` and fails CI (as part of the `lint-test-ensemble` job) if any unannotated skip is found. Existing skips in `hard-terminate.test.ts` and `cli-crash-proof-isolation.test.ts` have been annotated.
- **Scripts compiled from TypeScript to `dist/scripts/`** (#224). `scripts/run-shard.ts` and `scripts/verify-daemon-isolation-guard.ts` are now TypeScript sources; `npm run build:scripts` (included in `npm run build`) compiles them to `dist/scripts/`. Removes the fragile `!scripts/*.js` gitignore negation that would accidentally commit any future generated `.js` file. Invocation for the verification script: `npm run build:scripts && node dist/scripts/verify-daemon-isolation-guard.js`.
- **`updateMetadata` signal no longer accepts `status?` field** (PR-H / #132, docs cleaned up in #252). The `status: 'terminated'` shim was retired in PR-H; `docs/WIRE-PROTOCOL.md` now reflects this. Use the `destroy` update for ordered session teardown.

## [0.26.0-beta.3] - 2026-04-18

> **Beta release.** Completes the adapter resilience trilogy: reconnect across `continueAsNew`
> (#226), plus daemon singleton hardening, crash-proof CLI, and shared test environment.
>
> **Install:** `npm i -g claude-tempo@0.26.0-beta.3`
> **Rollback:** `npm i -g claude-tempo@0.26.0-beta.2`

### Changed

- **2-way Mocha shard in CI** (#231, #191 Phase 2). The `build-and-test` GitHub
  Actions job is now a `shard × node-version` matrix: 2 shards × 3 Node versions
  = 6 Mocha jobs, with a separate Vitest-only job for the TUI / client
  fallback suite. `test/shard-config.json` is the single source of truth for
  the split — shard-1 pins the top-N heaviest files by CI wall-clock (initial
  N=3: session-phase-machine, outbox, scheduler; ~52% of total time),
  shard-2 runs the remaining files via Mocha's native `--ignore` flag.
  Cross-shard drift lands at ~1.09× (well within the 20% rebalance bound).
  Local `npm test` still runs the full suite unchanged;
  `npm run test:shard-1` / `test:shard-2` mirror the CI invocations.
  `scripts/run-shard.js` is a thin wrapper that expands the JSON into Mocha
  args — no custom runner, no test-code changes. CI posts each shard's
  wall-clock to the job summary so drift is visible without log diving.
  Rebalance rule, shard-move procedure, and rationale live in the new
  `test/README.md`. Critical-path target (post-#210 + shard): ~215s → ~108s.
  See `docs/design/191-test-parallelization.md` §2 for the wall-clock math
  and v5 appendix for the data-derived split rationale.
- **Shared `TestWorkflowEnvironment` across Mocha spec files** (#210 Phase 1). The
  first `setupTestEnv()` call in a test run now builds a process-wide test
  environment; subsequent calls reuse it and only re-seed a per-file random
  ensemble prefix (`test-ensemble-<hex>`) so `playerMetadata()` defaults
  auto-namespace without per-test edits. Real teardown happens once at process
  exit via a Mocha `mochaGlobalTeardown` hook. Saves ~50-85s on the full Mocha
  suite. Set `TEMPO_TEST_ISOLATED=1` to restore per-file env lifecycle when
  debugging cross-file state leaks.
- Added `afterEach` shutdown safety net to `test/maestro.test.ts` and
  `test/global-maestro.test.ts` so a failing assertion doesn't leak a running
  Maestro workflow into the next test under the shared env.
- New CI lint (`scripts/check-test-ensemble-literals.sh`) fails on stray
  `'test-ensemble'` literals outside `test/helpers.ts` / `test/root-hooks.ts`.
- Removed dead cleanup pass that called `terminate()` on already-completed workflows
  (silent error swallow). (#144, #217)
- `OrphanSummary` now includes `ensemble` and `playerId` fields directly, eliminating a
  per-orphan lookup round-trip. (#145, #217)

### Fixed

- **Orphan reconcile mis-parsed player identities** when either the ensemble or player name
  contained dashes (e.g. `tempo-eng` in ensemble `tempo-impl` was parsed as
  `ensemble=tempo-impl-tempo, playerId=eng`). Affected the `restore` CLI command and daemon
  reconcile-on-boot. (#143, #217)
- **Adapter reconnects across `continueAsNew`** (closes #226). When the session
  workflow continued-as-new, the adapter's heartbeat + phase-watcher ticks on
  the (now-closed) pinned runId hit `WorkflowNotFoundError` with message
  "workflow execution already completed" and fired `destroy` terminal
  permanently — the adapter tore down even though the successor run was live
  and accepting signals. Inbound cues accumulated in `pendingMessages` and were
  silently marked `(undelivered)`; the reported repro was a cue signaled after
  CAN that never surfaced in Claude Code context. Fix: on any terminal-class
  error the adapter now reads the closed pinned run's history for a
  `WorkflowExecutionContinuedAsNewEvent`, and if found rebinds `pinnedHandle`
  to the successor runId in place (no re-claim — the workflow's §2.3 CAN-
  boundary lease extension keeps the lease alive across the transition). A new
  `DetachReason` value `'continued-as-new'` surfaces to the subclass via
  `shouldReconnect`/`onReconnectStart`; `InteractiveAttachment` opts in, Copilot
  keeps default-false. Follow-up to #201/#205 (lease-revoked reconnect) and
  #215 (reconnecting-flag hardening). Added integration tests in
  `test/adapter-reconnect.test.ts` covering both the CAN-rebind happy path
  (driven by a new test-only `testForceContinueAsNew` signal) and the
  regression path where `destroy` fires when no CAN event exists in history.
- **`test`: CLI crash-proof isolation test was silently skipping in CI** due
  to a wrong `__dirname` path resolution from the compiled test location
  (`dist-test/test/` → `..` → `dist-test/` instead of the repo root). The
  `before` hook's `fs.existsSync` check then failed, triggering `this.skip()`
  on the entire suite, and mocha reports silent-skip as a benign pending
  count that looks green in CI summaries. **PR #218's isolation guarantee
  was never empirically verified by CI** for the duration between its merge
  and this fix — only `scripts/verify-daemon-isolation-guard.js` (shipped in
  PR #219) actually ran the detector. The property itself held in practice,
  but the CI test was a placebo. This PR: (a) uses the correct two-level
  `__dirname` resolution, (b) **fails loud** (throws) instead of skipping
  when dist is missing — explicit `SKIP_ISOLATION_TEST=1` env gate for
  dev-loop opt-out, (c) adds a counter + `after`-hook assertion that catches
  any future `this.skip()` regression in the suite's `before` path. Caught
  while extending the isolation suite for #157 PR C. (partial fix for #157)
- **Adapter reconnect loop always resets its `reconnecting` flag** on every exit path.
  `BaseAttachment.runReconnectLoop` is now wrapped in `try/finally`, so aborts during
  backoff sleep, success, terminal bails, and unexpected throws all clean up state.
  Before this, a user-initiated `stopV2Lifecycle` racing a reconnect backoff could leave
  `reconnecting=true` — harmless in practice (`stopped=true` gated all ticks) but the
  leaked state masked diagnostics. Also adds an integration test for the
  `reconnect-exhausted` terminal path (previously only covered by the abort-during-sleep
  unit test). (closes #206)

### Added

- **`daemon start` pre-flight orphan check + `--force` escape hatch** (partial fix
  for #157). Before spawning, the CLI now scans for unexpected claude-tempo daemon
  processes (command-line match via PR A's `scanClaudeTempoDaemons`) and aborts
  with exit 1 + orphan list + troubleshooting-docs pointer if any are found. Pass
  `--force` to bypass the check (and clear a stale pid file as a side effect).
  Exit-1 default is deliberate: piling a new daemon on top of orphans is the
  original #157 user-pain scenario; `--force` is the opt-in for CI scripts that
  want idempotent-start behavior.
- **Daemon heartbeat file** at `~/.claude-tempo/daemon.heartbeat`. The daemon
  touches this file every 60 seconds; `daemon status` reports its age, flagging
  "stale" when the last touch is >120s ago. Disambiguates "pid is alive AND
  main loop is serving" from "pid is alive but something hung" — informational,
  doesn't drive any automatic action. (partial fix for #157)
- **`scripts/verify-daemon-isolation-guard.ts`** — one-shot manual verification
  script for the #157 isolation guard's fail-path. The `daemon-command-isolation`
  test asserts no forbidden Temporal imports leak into the `require.cache` of
  the daemon CLI module. This script empirically confirms the detector would
  FAIL if a forbidden import were injected — belt-and-suspenders paranoia per
  tempo-qa observation on PR #218. Run before a release or after touching CLI
  imports. (Compiled to `dist/scripts/` as of #224: `npm run build:scripts && node dist/scripts/verify-daemon-isolation-guard.js`)
- **`claude-tempo version` / `help` / `upgrade` / `config` are now crash-proof**
  (partial fix for #157 PR C). Each now routes through a dedicated minimal
  module (`src/cli/help-text.ts`, `src/cli/upgrade-command.ts`) or is inlined
  in `src/cli.ts` (`version`), dispatched from `src/cli.ts` *before* the full
  `./cli/commands` surface loads. `upgrade` references `@temporalio/client`
  via dynamic import inside its active-session-warning try/catch so SDK
  load failure silently skips the warning instead of crashing — exactly the
  scenario a user invoking `upgrade` is trying to recover from. `config show`
  and `config set` become crash-proof; `config` interactive's connection-test
  step is still dynamic-imported Temporal. The `test/cli-crash-proof-isolation.test.ts`
  suite enumerates `CRASH_PROOF_MODULES` and asserts — both at runtime (child-process
  `require.cache` scan) and statically (source-file regex for `import X from 'pkg'`
  syntax, excluding comments and `await import(...)`) — that no new regressions
  leak Temporal-adjacent modules into these crash-proof entrypoints. Future
  crash-proof candidates are a one-line addition to `CRASH_PROOF_MODULES`.

## [0.26.0-beta.2] - 2026-04-18

> **Beta release.** Fixes the adapter poller reconnect bug (#201), drops Node 18,
> and removes the last v0.26 wire-compat vestiges.
>
> **Install:** `npm i -g claude-tempo@0.26.0-beta.2`
> **Rollback:** `npm i -g claude-tempo@0.26.0-beta.1`

### Fixed

- **Sessions now self-heal after laptop sleep / network drop.** `InteractiveAttachment` opts into
  the new reconnect loop in `BaseAttachment`: when the workflow revokes a lease (heartbeat-timeout
  or superseded), the adapter re-attempts `claimAttachment` with exponential back-off for up to
  15 minutes before giving up. Previously, any lease revocation caused permanent shutdown.
  Adds `DetachReason: 'reconnect-exhausted'` for the terminal case. (closes #201, #205)

### BREAKING CHANGES

- **Dropped Node 18 support.** Minimum is now Node 20.
  `@temporalio/core-bridge` 1.15.0 already required Node 20 at runtime
  (its `engines.node` is `">= 20.0.0"`); the Node 18 CI job only passed
  because npm's engines field is advisory. This change aligns the
  declared supported surface with reality and removes the unsupported
  matrix slot, saving ~6 min per CI run. Users still on Node 18 must
  upgrade to Node 20 LTS (or later) before installing claude-tempo. (#204)
- **`updateMetadata` signal no longer accepts `status` field.** The
  legacy `status` field (kept as a TypeScript wire-compat vestige in
  v0.26-beta.1 so older clients wouldn't get a schema-mismatch on
  TypeScript type-check) has been removed from the signal's TypeScript
  payload type. Runtime behavior is unchanged — the handler has ignored
  the field since #175. Callers passing
  `status: 'active' | 'pending' | 'terminated'` in `updateMetadata`
  payloads must drop the field; attachment phase is driven by the V2
  wire surface (`claimAttachment` / `adapterExited` / `forceDetach` /
  `destroyUpdate`), visible via the `attachmentInfo` workflow query and
  the `ClaudeTempoAttachmentState` search attribute. (#212)
- **`createWorker()` factory removed** from `src/worker.ts`. The
  function has thrown-on-call since v0.10. Use `createWorkers()` which
  returns `{ sharedWorker, hostWorker }` — both must be run for
  cross-machine recruiting to function. (#212)
- **`src/tui/client.ts` back-compat re-export removed.** The shim
  re-exported `createTempoClient` from `src/client/` for v0.24 TUI
  compatibility. Internal consumers migrated by v0.26-beta.1 (#177).
  Any external importer of `claude-tempo/tui/client` must switch to
  `claude-tempo/client`. (#212)

## [0.26.0-beta.1] - 2026-04-18

> **Beta release.** Completes the #174 legacy-shim removal epic (PRs
> [#175](https://github.com/vinceblank/claude-tempo/pull/192),
> [#176](https://github.com/vinceblank/claude-tempo/pull/196),
> [#177](https://github.com/vinceblank/claude-tempo/pull/197),
> #178). The attachment-phase lifecycle (shipped in v0.25) is now the
> single source of lifecycle truth; the compat shim that let adapters
> migrate at their own pace through v0.25.x is gone.
>
> **Upgrade guide:** [`docs/ops/v0.26-migration.md`](docs/ops/v0.26-migration.md).
>
> **Install:** `npm i -g claude-tempo@0.26.0-beta.1`
> **Rollback:** `npm i -g claude-tempo@0.25.0-beta.5`

### BREAKING CHANGES

- **`ClaudeTempoStatus` search attribute removed.** Long-lived Temporal
  clusters must manually drop the attribute — Temporal does not
  auto-unregister. See the migration guide for `tcld` / `temporal
  operator` commands. Lifecycle truth now lives on
  `ClaudeTempoAttachmentState` (seven-phase values) and the
  `attachmentInfo` query.
- **`SessionStatus` TypeScript enum removed** from the public SDK
  surface. Use `AttachmentPhase` (`booting | attached | processing |
  awaiting | draining | detached | gone`) for lifecycle-typed code.
- **`SessionMetadata.status` field removed.** Query `attachmentInfo`
  on the workflow handle for phase instead.
- **`EnsembleSessionInfo.status` field removed**; replaced by
  `EnsembleSessionInfo.phase?: AttachmentPhase`. `scanEnsembleSessions`
  reads the new field from `ClaudeTempoAttachmentState`.
- **`MaestroPlayerInfo.status` renamed to `phase?: AttachmentPhase`.**
  External `TempoClient` consumers reading `player.status` must
  migrate to `player.phase`.
- **`BLOCKED_WINDOW_MS` / `SessionStatus` removed** from
  `src/utils/validation.ts`.
- **`updateMetadata` signal no longer writes `status`.** The field
  remains on the signal wire-shape for backward compat (prevents older
  clients from crashing on schema-mismatch) but has no observable
  effect — phase transitions happen through the V2 wire surface
  (`claimAttachment` / `adapterExited` / `forceDetach` /
  `destroyUpdate`).
- **Ensemble / CLI / TUI output labels collapsed.** Where v0.25
  rendered `(stale)` / `(blocked)` / `(pending)` / `(terminated)`
  tags, v0.26 renders `(pending)` / `(disconnected)` / `(gone)` — the
  Option-B mapping from the seven underlying phases to five
  user-facing buckets.
- **End-to-end upgrade required.** A v0.25 CLI / TUI paired with a
  v0.26 daemon (or the reverse) is not supported. Upgrade both sides
  together.

### Removed

- Legacy `_heartbeat` / `_ping` probe messages (the workflow used to
  inject these after 1 hour of idle) — the adapter `heartbeat` signal
  is the real liveness channel.
- 3-minute stale detection heuristic and 5-minute blocked-window
  heuristic — replaced by adapter lease expiry and
  `processingDeadline`.
- `docs/ops/v0.25-beta1-release-checklist.md` — marked as historical
  / superseded by the v0.26 migration guide.
- `test/blocked-detection.test.ts` — obsolete (heuristics removed).
- 9 other shim-era skipped tests (deleted or rewritten against
  attachment phase assertions).

### Fixed

- **Node 24 CI flake on `test/stages.test.ts`.** Bumped the
  `retry()` helper's default timeout from 5 s → 10 s to absorb
  Node 24 scheduler variance; the "completes stage when all players
  report result" test flaked on first CI run during #196 / #197 and
  passed on rerun.

### Docs

- New [`docs/ops/v0.26-migration.md`](docs/ops/v0.26-migration.md) —
  operator-facing migration guide with cluster-side attribute-drop
  commands, SDK consumer-update checklist, and rollback steps.
- Rewrote `docs/concepts.md`, `docs/troubleshooting.md`, and
  `CLAUDE.md` "Attachment phase" section to describe the seven
  phases in place of the removed `ClaudeTempoStatus`.
- Added editor's note to `docs/design/session-lifecycle-rebuild-v2.md`
  marking the design as realized.
- Added § 11 to
  `docs/design/session-lifecycle-rebuild-v2-sequencing.md` capturing
  the PR-H shim-removal ladder (PRs #175–#178).
- New `CLAUDE.md` callout on the `test/` (Mocha) vs `tests/`
  (Vitest) directory split — both are first-class test targets and
  must be grepped together during call-site migrations.

## [0.25.0-beta.5] - 2026-04-18

> **Beta release.** Three daemon and outbox stability fixes.
>
> **Install:** `npm i -g claude-tempo@beta`
> **Rollback:** `npm i -g claude-tempo@0.25.0-beta.4`

### Fixed

- **#182 — Daemon recovers from stale startup lock.** A daemon process that
  died abruptly (OOM kill, power loss) left a `.lock` file behind, causing the
  next daemon startup to hang indefinitely waiting for the lock to clear. The
  lock file is now JSON-formatted (`{ pid, mtime }`) so the daemon can detect
  whether the lock owner is still alive; stale locks (dead PID) are removed and
  acquisition retried. Atomic tmp+rename pid writes prevent partial reads.
  Daemon-ready timeout extended from 10 s to 30 s to accommodate slower CI
  machines.
  ([#182](https://github.com/vinceblank/claude-tempo/issues/182), [#186](https://github.com/vinceblank/claude-tempo/pull/186))
- **#183 — `restart --fresh` regenerates session UUID.** `restart --fresh` (and
  `migrate --fresh`) reused the session's stored UUID for the new spawn, causing
  "Session ID already in use" errors when a prior spawn had written a partial
  `.jsonl` transcript before crashing. A new UUID is now generated for every
  forced-fresh restart, ensuring a clean transcript path.
  ([#183](https://github.com/vinceblank/claude-tempo/issues/183), [#187](https://github.com/vinceblank/claude-tempo/pull/187))
- **#184 — Agent type propagates through `restart --fresh` pipeline.** A
  regression caused forced-fresh restarts to lose the player's agent type
  (`agentDefinition`, `agentDefinitionPath`, `nativeResolvable`), falling back to
  defaults on the new spawn. These fields now flow through `restart --fresh` →
  `enqueueSpawnUpdate` → spawn activity. The `enqueueSpawnUpdate` wire protocol
  change is additive (new optional fields, non-breaking).
  ([#184](https://github.com/vinceblank/claude-tempo/issues/184), [#188](https://github.com/vinceblank/claude-tempo/pull/188))

---

## [0.25.0-beta.4] - 2026-04-17

### Added

- **#172 — Ensemble startup waits for the user's first message before the
  conductor acts.** Previously, `claude-tempo up <ens> --lineup <name>`
  immediately delivered `lineup.conductor.instructions` to the conductor,
  which then auto-executed the lineup's default Phase-1 workflow before the
  user had said anything. Now the conductor stays quiet on startup and
  decomposes from user intent instead. User-facing behavior is unchanged
  from the previous iteration; the implementation is simpler.
  - **Simplified design** (v0.26 refactor): workflow-level
    `pendingStartupContext` state and the `receiveMessage` interceptor were
    **removed**. Instead, the conductor's lineup instructions plus a
    combined banner + "wait for user, call `resume_ensemble` first"
    directive are baked directly into `SessionInput.messages[]` at workflow
    creation. The directive text itself drives the hold — the LLM reads
    "wait silently until the user speaks, then call `resume_ensemble`
    FIRST" and honors it. No workflow state, no signal filter.
  - `load_lineup` tool gains an `initialStartup: boolean` param. When true,
    it signals the lineup instructions (`from: 'lineup'`) and the banner +
    directive (`from: 'system'`) immediately and then pauses the entire
    ensemble via `pause_ensemble` (scheduler + per-session outbox +
    maestro). When false, it keeps legacy immediate-signal behavior with
    no banner and no pause.
  - CLI: `up --lineup` defaults to the new behavior and seeds the
    conductor workflow's `SessionInput.messages` with the lineup
    instructions + banner+directive at pre-creation time; `--no-hold` opts
    out for scripts that want legacy immediate-start. New
    `conduct --lineup <name>` flag applies the same semantics when
    starting just a conductor.
  - Shared `ensembleReadyBanner(name, playerCount)` is rendered verbatim
    on CLI stdout. The combined banner + directive message body used by
    the CLI and `load_lineup` tool is centralized in
    `ensembleReadyDirective(name, playerCount)` in `src/constants.ts`.
  - **Removed from the previous iteration** (none of these are reachable
    without upstream code paths that no longer exist):
    - `setPendingStartupContext` workflow update + `pendingStartupContext`
      query — removed from `docs/WIRE-PROTOCOL.md`.
    - `SessionInput.pendingStartupContext` and
      `SessionInput.hasInitialStartupRun` fields.
    - Workflow-level idempotency guard and `receiveMessage` interceptor —
      the user's message typed in the conductor tab never flowed through
      `receiveMessageSignal` anyway, so the interceptor fired on
      player-join announcements instead of real user input.
    - TUI `startupBanner` state + poll loop + `getPendingStartupContext`
      TempoClient method. If the chat-header banner is useful later it
      can be added back with a simpler mechanism.
    - Blocked-detection suppression guard keyed on
      `pendingStartupContext` — no longer needed because the conductor
      is paused at the ensemble level, not via workflow state.
  - The `patched('v0.26-pending-startup-context')` replay marker is
    retained as a no-op in the session workflow so existing replay
    histories that recorded the command deserialize cleanly.
  - Conductor-invoked `load_lineup` mid-work and `recruit` mid-work are
    unchanged — the conductor is already oriented there.

### Fixed

- **`resume_ensemble` directive lie** (#172): `ensembleReadyDirective` previously told the
  conductor that `resume_ensemble` "unpauses the scheduler and unlocks player outboxes" — but
  `resume_ensemble` never touched outbox locks. Held players would stay silent until the
  conductor also called `release` by hand. Directive text now accurately describes the correct
  sequence: call `resume_ensemble { release: true }` → decompose.
- **`resume_ensemble` opt-in release** (#172): added `release?: boolean` arg (default `false`,
  non-breaking). When `true`, fans out `releaseHeld` to every running session after unpausing —
  idempotent on non-held sessions. Surface via `claude-tempo resume --release`. Eliminates the
  two-step `resume` + `release` that the deferred-startup flow previously required.
- **Directive message ordering** (#172): the system directive ("wait silently, then call
  `resume_ensemble { release: true }`") is now seeded *before* the lineup instructions in the
  conductor's `messages[]`. Previously the directive appeared after the lineup briefing, which
  caused the LLM to miss the required startup tool calls when lineup instructions were long
  (e.g. multi-phase lineups like `my-tempo-po`).

---

## [0.25.0-beta.3] - 2026-04-16

> **Beta release.** Consolidates session-lifecycle cleanup fixes validated via
> live Windows smoke test across all single-machine verbs.
>
> **Install:** `npm i -g claude-tempo@beta`
> **Rollback:** `npm i -g claude-tempo@0.25.0-beta.2`
>
> **Smoke coverage:** `recruit`, `cue`, `report`, `set_name`, `set_part`,
> `who_am_i`, `recall`, `broadcast`, `listen`, `detach`, `restart --force`,
> `destroy`, `schedule` / `unschedule` / `schedules`, `save_lineup` /
> `load_lineup` / `release`, `worktree` (create/list/remove), `stage` /
> `stages` / `cancel_stage`, `quality_gate` / `evaluate_gate` / `gates`.
> `migrate` (cross-host) pending — requires second host to validate.

### Fixed

- **#164 — `destroy` kills the live attachment's OS process tree.** Previously,
  `destroyUpdate` cleared the workflow attachment and flipped phase to `gone`
  without killing `claude.exe`, silently leaking a process per destroy on
  Windows. The handler now awaits `hardTerminateAttachment` on the host's
  per-host task queue before flipping `destroyRequested`, using a
  destroy-specific 5s timeout so a missing host worker in test envs fails
  fast instead of wedging for 20s. Best-effort: if the activity throws, we
  log and continue to `setPhase('gone')` because `destroy` is terminal per
  §2.5. Only fires when `currentAttachment` is non-null — no activity
  overhead for sessions destroyed while already detached.
  ([#164](https://github.com/vinceblank/claude-tempo/issues/164), [#166](https://github.com/vinceblank/claude-tempo/pull/166), [#169](https://github.com/vinceblank/claude-tempo/pull/169))
- **#165 — parent `cmd.exe` walk closes the Windows Terminal tab orphan.**
  The #159 fix killed `claude.exe` but not the parent `cmd.exe /k` shell that
  WT spawned, leaving an unresponsive tab per `detach` / `restart --force` /
  `destroy`. `findProcessesByCommandLine` now walks up exactly one PPID level
  per matched PID and — if the parent is `cmd.exe` with the same
  `-n <playerName>` sentinel in its CommandLine — adds it to the
  `taskkill /T /F` set. Grandparents (`wt.exe`, `conhost.exe`) are out of
  scope by design; WT auto-closes the tab once its shell process exits. New
  profile setting `closeOnExit: "always"` on the `claude-tempo` WT profile
  handles the non-zero-exit cases as a fallback.
  ([#165](https://github.com/vinceblank/claude-tempo/issues/165), [#166](https://github.com/vinceblank/claude-tempo/pull/166))
- **Latent #159 regex fix: `hardTerminate` now tolerates the production
  quoted-arg form.** The original `-n\s+<playerName>` regex assumed a bare
  space between `-n` and the player name, but `src/spawn.ts` §WT hand-quotes
  each token in the `cmd /k` innerCmd, producing `... "-n" "<playerName>" ...`
  in the CommandLine visible to `Win32_Process`. `\s` didn't match the `"`, so
  **every previous #159 hardTerminate call was a silent no-op in production** —
  earlier smoke runs only passed because the adapter self-terminated on MCP
  detach. The regex is now `-n[\s"']+<escapedName>([\s"']|$)` on the PowerShell
  branch, `[[:space:]"']` on the Unix pgrep branch (POSIX ERE — `\s` matches
  literal 's' there), and `%-n%<name>%` + post-filter on the wmic fallback. Test
  fixtures reproduce the production-quoted topology via a `.bat` indirection so
  future regex-quoting regressions fail loudly instead of silently. ([#166](https://github.com/vinceblank/claude-tempo/pull/166))
- **Fire-and-forget destroyUpdate regression from the bundled #166 fix.** An
  early revision of #166 dropped the `await` on `hardTerminateAttachment` to
  avoid CI test-env cascades. Temporal does not dispatch activities from a
  workflow that has already set its terminal flag, so the activity was
  scheduled but never run. Restored the `await` with a 5s best-effort timeout
  and flipped `destroyRequested = true` after the await, keeping the main loop
  alive long enough for the activity to reach the host worker. Verified
  end-to-end via live smoke: `hardTerminate done (search) — killedPids=[<pid>]`
  appears in the daemon log and the WT tab closes. ([#169](https://github.com/vinceblank/claude-tempo/pull/169))
- **macOS: close terminal tabs on `detach` / `destroy`.** Parity with the
  Windows WT fix from #166. Terminal.app, iTerm2, and Ghostty previously left
  an interactive shell at a prompt after `claude.exe` exited. Now: Ghostty's
  `initial input` and iTerm2's `write text` both append `; exit` (so the shell
  exits after claude returns, regardless of exit code); Terminal.app's
  `.command` script prepends `exec` to the claude invocation so the shell
  slot is replaced — when claude exits, the script ends and Terminal.app
  closes the window per its settings. iTerm2's AppleScript injection path was
  also hardened with `JSON.stringify` escaping (reviewer catch). **Not tested
  on macOS** — no Apple hardware available at release time; no process-leak
  risk in any failure mode. ([#168](https://github.com/vinceblank/claude-tempo/pull/168))

### Tests

- **Closed review gaps from #166.** (1) Replaced the 1.5s fixed sleep in the
  #165 parent-walk test with a polling loop, matching `spawnTestVictim`'s 60×100ms
  pattern — prevents CI flakes on slow machines. (2) Added end-to-end coverage
  for player names containing dots (`tempo.player-1.test-...`) so the
  `replace(/[.-]/g, ...)` regex-escape path is exercised. (3) `afterEach`
  cleanup is now platform-aware: `taskkill /F /PID` on Windows,
  `process.kill('SIGKILL')` on Unix — fixes EPERM on Windows when the test
  spawned `cmd.exe` processes without an IPC channel. ([#167](https://github.com/vinceblank/claude-tempo/pull/167))
- **Added #164 behavioral tests.** `destroys a session with a live attachment —
  workflow completes, isDestroyed=true` exercises the actual production bug
  path (`claimAttachment` first, then `destroy`). `concurrent forceDetach +
  destroy — workflow reaches gone without errors` tests the race window
  discussed in the PR #166 review. ([#166](https://github.com/vinceblank/claude-tempo/pull/166))

### Docs

- **`load_lineup` `hold` flag: docstring now matches warm-hold implementation.**
  The tool description previously claimed `hold=true` would create workflows
  without spawning processes. The activity actually implements a "warm hold":
  processes DO spawn and attach, but the outbox is locked and the player
  receives a standby message until `release` is called. Surfaced during
  smoke testing when a user reasonably expected no spawn. Behavior unchanged;
  description corrected. ([#170](https://github.com/vinceblank/claude-tempo/pull/170))

### Known Limitations (unchanged from beta.2)

- `migrate` (cross-host) not validated in this beta — needs a second host.
- Windows Terminal's `closeOnExit: "always"` profile setting may not auto-close
  tabs on some WT versions when the shell exits non-zero; functional kill still
  works, tab persists with "process exited" banner. Cosmetic only.

---

## [0.25.0-beta.2] - 2026-04-14

> **Beta release.** Docs-only update on top of `0.25.0-beta.1`.
>
> **Install:** `npm i -g claude-tempo@beta`
> **Rollback:** `npm i -g claude-tempo@0.25.0-beta.1`

### Docs

- **Agent examples modernized for v0.25** — `detach`, `destroy`, `restart`, and `migrate`
  replace the retired `stop` verb across all shipped agent types. Adds a new
  "Session Lifecycle" section to relevant agents. Generic agents ported with
  11 improvements (PR #154)
- **Subagent offload guidance** — read-heavy agent types (`tempo-critic`,
  `tempo-improv`, `tempo-composer`, `tempo-tuner`) now document the
  `Task`/`Explore` dispatch pattern for multi-file archaeology (PR #152)
- **CLAUDE.md restructured** — trimmed from 261 to 127 lines; detail split into
  four new companion docs (`docs/architecture.md`, `docs/tui.md`,
  `docs/configuration.md`, `docs/development.md`). Replaces `docs/dashboard.md`
  with `docs/tui.md` (PR #155)
- **docs/README.md index** — updated to include all four new companion docs (PR #156)

---

## [0.25.0-beta.1] - 2026-04-13

> **Beta release.** This is the consolidated v0.25 session-lifecycle-rebuild beta.
> All v0.25 PRs (A/B/C/D/E/F/G/H) are included. Please validate before GA.
>
> **Install:** `npm i -g claude-tempo@beta`
> **Rollback:** `npm i -g claude-tempo@latest` (returns to v0.24.x)
> **Report issues:** https://github.com/vinceblank/claude-tempo/issues
>
> **Known limitations:**
> - Windows test environment: `npm test` shows 22 failures due to `TestWorkflowEnvironment.createLocal` EACCES on ephemeral-server startup. Tracked in [#150](https://github.com/vinceblank/claude-tempo/issues/150). Does NOT affect runtime correctness — CI (Ubuntu) passes clean.
> - Multi-host integration tests are skipped by default (`INTEGRATION_MULTI_HOST=1` to opt in with a running docker-compose harness).
> - `CLAUDE_TEMPO_LIFECYCLE_V2` environment variable no longer exists — V2 is the only code path. If you set it, it's ignored.
>
> **2-week soak target:** GA as `v0.25.0` after validation.

The v0.25 session-lifecycle rebuild. Complete adapter attachment-lease model,
7-phase session state machine, explicit wire primitives for claim / heartbeat
/ detach / destroy. Replaces the v0.24 `updateMetadata({ status })` shim with
a dedicated attachment surface that cleanly separates adapter lifecycle (the
attached process) from session lifecycle (the Temporal workflow).

Design reference: `docs/design/session-lifecycle-rebuild-v2.md`.

### Added

- **V2 wire primitives** — `claimAttachmentUpdate` (transactional claim/renew
  with lease tracking), `heartbeatSignal` (extends `expiresAt` by the
  attachment's negotiated `leaseMs`), `forceDetachUpdate` (revoke with TOCTOU
  guard), `requestDetachSignal` (graceful drain request), `adapterExitedSignal`
  (collapse `draining → detached`), `attachmentInfoQuery` (phase + attachment
  snapshot), `orphanSummaryQuery` (daemon restore metadata),
  `enqueueSpawnUpdate` (spawn outbox entry with pre-claimed attachment),
  `setPreferredHostUpdate` (reconcile-on-boot targeting)
- **7-phase session state machine** — `booting` / `attached` / `processing` /
  `awaiting` / `draining` / `detached` / `gone`. Phase is exposed as the
  `ClaudeTempoAttachmentState` search attribute and via `attachmentInfo`.
  Transitions documented in `docs/design/session-lifecycle-rebuild-v2.md` §2.4
- **Awaiting phase wiring (#117)** — `setPhase('awaiting')` now fires when
  `processingEnd` lands in-flight at 0 with an idle outbox, and again as a
  main-loop refinement after outbox-dispatch drain. Previously the phase was
  declared in the enum but never actually entered
- **`Attachment.leaseMs` (#119a)** — attachment carries its negotiated lease
  duration; heartbeat renewals honour it rather than a workflow-side default
- **`SpawnOutboxEntry` discriminated union (#118)** — typed member of
  `OutboxEntry` with the 5 attachment-specific fields (`attachmentId`,
  `attachmentRunId`, `resumeAttachment`, `sessionId?`, `adapterId`) wired
  end-to-end through the spawn activity. Replaces the prior double-cast
  `type: 'recruit'` workaround
- **V2 attachment search attributes** — `ClaudeTempoAttachedHost`,
  `ClaudeTempoAttachmentId`, `ClaudeTempoAttachmentState`
- **Adapter class registry** — `AdapterRegistry` keyed by `adapterId`; shipped
  `InteractiveAttachment` (Claude Code CLI, 60s heartbeat) and
  `CopilotSdkAttachment` (Copilot bridge, 30s heartbeat, `sendAndWait`
  pairing via `processingStart`/`End`). Registry descriptors drive dispatch
  without hardcoded `isBridgeMode` branches
- **`SdkAttachment` base class** — synchronous `processingStart`/`End` pairing
  with `expectedAttachmentId`, batch-ack via optional `ackIds`,
  `onSuperseded` hook, `sdkInFlight` guard for split-brain safety (§9.3)
- **CAN-boundary lease extension (§2.3)** — before `continueAsNew`, extends
  `currentAttachment.expiresAt` by one heartbeat interval so a healthy
  attachment isn't reaped during the CAN transition
- **Attachment-phase + heartbeat-timeout test coverage** — new cases in
  `test/session-phase-machine.test.ts` assert the 5 awaiting transitions
  (§2.4), the `#119a` leaseMs-honouring heartbeat renewal, and the
  phase-agnostic §9.5.a lease-expiry reap (covers
  `attached`/`awaiting`/`processing` → `detached` with
  `reason: 'heartbeat-timeout'`)
- **`restart` tool** — revives any non-`gone` session: graceful
  `requestDetach` (or `forceDetach` with `force: true`), fresh
  `claimAttachment` on the target host, optional context replay, then
  `enqueueSpawn`. Works from any non-`gone` phase. Replaces `encore`
  (which was limited to `stale` sessions)
- **`detach` tool** — gracefully reaps the adapter (`requestDetach` signal
  → `draining → detached`); workflow survives and can be `restart`ed
- **`destroy` tool** — terminally ends the workflow (§2.5 semantics: phase →
  `gone`, outbox abandoned, COMPLETE immediately). Irreversible
- **`migrate` tool** — sugar for `restart --host=<h>`; sets `preferredHost`
  and routes the spawn to `claude-tempo-{host}` task queue
- **`attachment-info` tool** — diagnostic query for current attachment phase,
  holder, and in-flight count (`attachmentInfo` query wrapper)
- **Daemon reconcile-on-boot** (PR-E §10.1) — `reconcileOnBoot()` in
  `src/daemon.ts` scans for sessions whose workflow is Running but whose
  adapter process is gone (attached-to-local with dead PID, or detached
  with local `ClaudeTempoHostname`). Candidate set fetched via a single
  visibility query; per-candidate `attachmentInfo` + `orphanSummary`
  resolved before the policy decision. Shared `queryOrphanedSessions`
  helper in `src/reconcile/orphans.ts` is reused by the CLI `restore`
  command. `isAdapterProcessAlive` stubbed as `() => false` in
  v0.25.0-beta.1 — conservative always-restore, with silent backoff on
  `AttachmentConflict` per §10.6
- **`restorePolicy` decision tree** (PR-E §10.2) — new `DaemonConfig` in
  `~/.claude-tempo/config.json` with `restorePolicy`
  (`"auto"`/`"prompt"`/`"never"`, default `"prompt"`),
  `autoRestoreMaxAgeHours` (default 24), `autoRestoreEnsembles`
  (simple-prefix allowlist, empty = all), and `cleanupPolicy`
  (`detachedMaxAgeDays` 7, `destroyedMaxAgeDays` 30). `"never"` is the
  effective off-switch — there is no feature flag. Zod-validated with
  per-field defaults so partial configs merge cleanly
- **Daemon cleanup loop** (PR-E §13.4) — `cleanupLoop()` runs every 6
  hours (hardcoded; no config field). Two passes: detached orphans
  exceeding `detachedMaxAgeDays` are `destroy`ed with an audit reason;
  completed workflows exceeding `destroyedMaxAgeDays` are `terminate`d
  to reinforce the namespace retention policy. Retention math lives in
  exported `selectStaleDetachedOrphans()` for unit testing
- **`claude-tempo restore` CLI** (PR-E §10.3) — new top-level command:
  interactive picker (no args), specific `<name>`, `--all`,
  `--from-host=<h>`, `--dry-run`. Thin wrapper over
  `queryOrphanedSessions` + `TempoClient.restart`. `AttachmentConflict`
  on concurrent restore logged + counted as "skipped"
- **`claude-tempo daemon install` / `uninstall`** (PR-E §10.5) — OS
  service registration. Linux (`systemd --user` unit copied to
  `~/.config/systemd/user/`), macOS (launchd agent copied to
  `~/Library/LaunchAgents/`, best-effort untested with NOTE banner),
  Windows (Task Scheduler via `packaging/windows/install-task.ps1`,
  current-user task at logon). **User-level only** — never requires
  `sudo` or Administrator
- **Cross-host `restart` / `migrate`** (PR-F design §16, §16.5 Option B)
  — the `restart` MCP tool accepts an optional `host` parameter that
  routes the downstream `spawnProcess` activity to the per-host
  `claude-tempo-{host}` task queue. The `migrate` tool is sugar over
  `restart --host=<h>`. Both verbs surface a `confirmStealFromHost`
  arg and a CLI `--yes-steal=<hostname>` flag; cross-host force-restart
  requires the flag to match the current attachment's hostname exactly
  (client-side guard; no interactive prompts per §8 answer 5).
  `claude-tempo migrate <name> --to <hostname>` is the operator-friendly
  surface with copy-paste-friendly re-run errors
- **Daemon `reconcileOnBoot` cross-host filter** (PR-F §8 answer 2) —
  orphans whose `preferredHost` differs from the local hostname are
  logged + skipped rather than auto-restored. The remote host's daemon
  is the authoritative restorer for its own sessions. Proactive
  cross-daemon notification of orphans is a v0.26 follow-up (tracked
  as a separate issue). Log line format includes both hostnames for
  observability: `skipping restore for {workflowId}: preferredHost={X}, localHost={Y}`
- **TUI cross-host indicator** (PR-F §8 answer 3) — `ChatView` and
  `PlayerDetailView` surface the attached host when a session is on a
  remote machine: status line gains a `{host} · ` prefix in amber
  (`THEME.accent`) for remote sessions; local sessions omit the host
  entirely to reduce noise for the common case. Zero new Yoga nodes —
  the host segment is composed inline in the existing `<Text>` tree as
  a nested virtual text node per CLAUDE.md TUI Performance rules

### Changed

- **`processingStart` / `processingEnd`** — now Temporal updates (not signals),
  require `messageId` for idempotency, suppress stale detection while
  in-flight (§9.5.b safety timer ejects wedged entries after 15 min)
- **`processingStart` validator** — uses canonical `phase === 'gone'` (#119b;
  was compound `destroyed || destroyRequested` pre-PR-C-commit-4)
- **`stop` tool + CLI stop paths** — migrated from
  `updateMetadata({ status: 'terminated' })` to `destroyUpdate` (§2.5 semantics:
  abandon in-flight, COMPLETE immediately). Legacy terminate fallback retired
- **MCP server SIGINT/SIGTERM** — closing the terminal no longer destroys the
  workflow. Graceful detach via adapter's `adapterExited` only; the session
  stays in `detached` awaiting the next claim (e.g. `restart`)
- **Copilot adapter cleanup** — drops duplicate `updateMetadata({ status:
  'terminated' })` signal. `stopV2Lifecycle(graceful=true)` already fires
  `adapterExited` for the workflow-side detach collapse

### Fixed

- **#117** — awaiting phase was defined in `AttachmentPhase` enum and guarded
  by `processingStart` but never entered. Sessions cycled `attached ↔
  processing` instead of the spec'd `attached ↔ awaiting ↔ processing`
- **#118** — spawn outbox entry double `as unknown as OutboxEntry` cast
  removed via the new discriminated-union member
- **#119a** — heartbeat renewal now extends `expiresAt` by the caller-negotiated
  `leaseMs` stored on the attachment at claim time, not a hardcoded 90s default
- **#119b** — `processingStart` validator uses canonical `phase === 'gone'`
- **#120** — main-loop comment at `session.ts:1047` correctly describes the
  `updateMetadata({ status: 'terminated' })` shim as routing to
  `destroyRequested`. Resolved by commit 4 (`34dc888`) without a separate fix

### Removed

- **`encore` MCP tool** — retired; use `restart` instead (works on any
  non-`gone` phase, not just `stale`)
- **`encore` CLI command** (`claude-tempo encore`) — removed; use
  `claude-tempo restart`
- **`encore` TUI slash command** (`/encore`) — removed; use `/restart`
- **`EncoreOutboxEntry`** — outbox entry type and dispatch case deleted
  alongside the `encore` activity
- **`CLAUDE_TEMPO_LIFECYCLE_V2` feature flag (#132)** — removed. V2
  attachment-lease is now the only path; `lifecycleV2Enabled()` helper,
  `BaseAttachmentOptions.lifecycleV2` field, and all `if (this.lifecycleV2)`
  branches in the Claude Code / Copilot / SDK adapters have been deleted
- **`updateMetadata({ status: 'terminated' })` compat shim (#132)** — the
  v0.25.1-deferred handler branch in `session.ts` is gone. Status-only
  metadata updates stay supported for presentation fields; phase transitions
  now exclusively go through the V2 wire surface (`destroyUpdate`,
  `adapterExitedSignal`, `forceDetachUpdate`, `claimAttachmentUpdate`).
  Test fixtures (~165 call sites across 13 files) migrated to
  `executeUpdate(destroyUpdate, { args: [{}] })`
- **`stop` MCP tool (#132)** — the v0.25.1-deferred deprecation hint tool is
  gone. Callers use `detach` / `destroy` / `restart` directly
- **`claude-tempo stop --terminate` CLI flag (#132)** — the `hardTerminate`
  escape hatch is gone. Bulk `stop` always routes through `destroyUpdate`
- **TUI `/stop` slash command (#132)** — renamed to `/destroy`, routed
  through `TempoClient.destroy()` (V2 destroy semantics, confirmed prompt)
- **Workflow `LEASE_MS` constant** — removed in favour of per-attachment
  `leaseMs`

### Operator notes

- **Wire protocol is reset as of v0.25.0-beta.1.** Previous versions are not
  compatible. Stop all sessions, `npm i -g claude-tempo@beta`,
  restart ensembles. No migration path for in-flight v0.24.x sessions.

---

## [0.24.0] - 2026-04-12

### Added

- **Ensemble startup hold** — `load_lineup(hold: true)` spawns all players with locked outboxes and a standby message; `release` (MCP tool + CLI) unlocks and delivers the real task, enabling controlled team pre-warming before a job begins (#91)
- **Pause / resume ensemble** — `pause_ensemble` / `resume_ensemble` MCP tools and `claude-tempo pause` / `resume` CLI commands lock all session outbox dispatch and pause the scheduler mid-session; `stop` entries bypass the lock; the ensemble Maestro owns pause ground truth (#91)
- **New MCP tools**: `release`, `pause_ensemble`, `resume_ensemble` (#91)
- **New CLI commands**: `claude-tempo release`, `claude-tempo pause`, `claude-tempo resume` (#91)
- **New TUI slash commands**: `/go` (release all held players), `/pause`, `/resume` (#91)
- **New session signals**: `releaseHeld` (unlock held outbox + deliver deferred message), `setPaused` (pause/resume outbox dispatch) (#91)
- **New session queries**: `outboxLocked` (boolean — held at startup), `paused` (boolean — currently paused) (#91)
- **New scheduler signal**: `setSchedulerPaused` (pause/resume fire delivery; skipped fires are not replayed) (#91)
- **New Maestro signal/query**: `maestroSetPaused` (ensemble-wide pause ground truth), `maestroPaused` (query current pause state) (#91)

### Fixed

- Hardcoded hold standby instruction now fires for any conductor when `hold=true`, regardless of whether the lineup has a `conductor:` section (#91)

---

## [0.23.0] - 2026-04-12

### Added

- **`ClaudeTempoIsConductor` search attribute** (Bool) — registered in schema, set at workflow startup and `continueAsNew`, with workflow ID fallback for indexing delay. Enables direct conductor lookup without scanning all sessions (#68)

### Changed

- **`TempoClient` extracted to `src/client/`** — interface and factory moved from `src/tui/client.ts` to `src/client/interface.ts` and `src/client/index.ts` for multi-interface reuse. `src/tui/client.ts` is now a thin re-export shim for backward compatibility (#68)
- **WIRE-PROTOCOL.md** — updated to document `ClaudeTempoIsConductor` search attribute and conductor lookup semantics (#68)

---

## [0.22.1] - 2026-04-11

### Fixed

- TUI `getPlayerMetadata` query name mismatch — was calling `metadata` instead of `getMetadata`, causing "Query not found" errors

---

## [0.22.0] - 2026-04-11

### Added

- **Ensemble chat feed** — aggregated maestro + conductor traffic as the default TUI view. Backed by the new `maestroEnsembleChat` per-ensemble Maestro query with delta-based caching (max 500 entries, refreshed every ~10s via `fetchEnsembleChat` activity). New wire protocol types: `EnsembleChatMessage`, `EnsembleChatQuery`, `EnsembleChatResult`, `ChatHighWater` (#58)
- **`@player` messaging** — type `@player message` in the ensemble view to address a player directly, with inline autocomplete palette (#58)
- **Copilot bridge in TUI** — `defaultAgent` config threaded through TUI; recruit wizard defaults to the configured agent type (claude/copilot) (#58)
- **Interactive overlays** — `/schedule`, `/gates`, `/stages`, `/worktree` overlays now support arrow-key navigation and action keys (n=new, d=delete, esc=close) (#58)
- **`/worktree create/remove`** — new subcommands route worktree provisioning requests to the conductor (#58)
- **`/encore` player picker** — filters the interactive picker to stale players only (#58)
- **`/help <command>`** — pass a command name to `/help` for a per-command usage overlay; e.g. `/help recruit` or `/help /recruit` (#58)
- **`NO_COLOR` support** — set `NO_COLOR=1` to disable all color output in the TUI and CLI, following https://no-color.org/ (#58)
- **Minimum terminal size check** — TUI exits with code 1 at launch if the terminal is below 80×24; soft in-app warning renders when resized below 60×15 (#58)
- 555 passing tests (#58)

### Changed

- Viewport height estimation uses `wordWrap()` — same function for both estimate and render, eliminating layout drift between static scrollback and live area (#58)
- Poll cycle deduplication skips redundant state dispatches when nothing has changed (#58)

### Fixed

- `/gates` and `/stages` now scoped to the active ensemble (were incorrectly querying all ensembles) (#58)
- `/encore` works without a conductor via direct API — no longer requires a conductor command relay (#58)
- `/recruit-conductor` uses `claude-tempo conduct` directly, bypassing the broken conductor-command relay path (#58)
- Direct (maestro/conductor) messages shown in full; third-party messages truncated at 500 chars. Previously all messages were truncated (#58)
- `@player` message dedup: sent text now matches server-returned text, eliminating duplicate echoes (#58)
- TUI message layout: top-aligned with a reserved 1-line gap above the footer; static and live areas use matching word-wrap and indentation (#58)
- `/schedule delete <name>` is the canonical schedule cancellation path — the previously documented `/unschedule` alias was never registered (#58)
- `exec()` replaced with `execFile()` in TUI ensemble creation to prevent shell injection (#58)
- TUI exits with code 1 on Temporal connection error (previously exited cleanly, masking failures) (#58)

### Removed

- Dead `/cue` slash command handler (use bare text or `@player` prefix instead)
- Redundant command aliases: `/home`, `/maestro`, `/exit`, `/dashboard`, `/unschedule`

---

## [0.21.1] - 2026-04-08

### Fixed

- Recruit and encore tools now use the configured `claudeBin` setting when spawning new player sessions. Previously, mid-session recruits ignored the custom binary path and fell back to the default `claude` command (#90)

## [0.21.0] - 2026-04-08

### Added

- Custom claude executable alias: `CLAUDE_TEMPO_CLAUDE_BIN` env var and `claude-tempo config set claude-bin` (#87)

## [0.20.1] - 2026-04-08

### Fixed

- `claude-tempo up` now detects an existing running conductor and prompts with options: join as player, reconnect, tear down and start fresh, or cancel. Prevents two sessions from silently sharing the same Temporal workflow (#85)

## [0.20.0] - 2026-04-08

### Added

- `claude-tempo upgrade [version]` command for graceful self-update — stops daemon, installs new version, restarts daemon (#79, #82)
- Complete TUI rewrite — multi-ensemble home screen, view router, adaptive polling (#58)
- TempoClient API layer replacing core-api.ts with Maestro-first fallback (#58)
- 13 new components: ChatView, CommandPalette, ConversationStream, ErrorView, MainView, Picker, PlayerDetailView, PromptArea, RecruitWizard, ScheduleWizard, Splash, StatusBar, StatusOverlay, TitleBar (#58)
- Slash command system with parser, registry, tab completion, persistent history (#58)
- `/status` command — dismissible overlay (`StatusOverlay`) showing all players with status, type, and current part (#58)
- `/unschedule` command wired — cancels a named schedule via the durable scheduler workflow (#58)
- `PlayerDetailView` — per-player panel with scrollable message history (#58)
- `ConversationStream` — live message area merging server conversation with optimistic sent-message echo (#58)
- `Picker` — interactive full-screen picker with player type grouping (groups items under shared headers) (#58)
- `CreateEnsembleWizard` — guided step-by-step flow for creating new ensembles (name → workDir → lineup → confirm), accessible from the splash screen and `/ensemble` (#58)
- Loading states for splash screen (connection checklist) and status bar (#58)
- Two-way conductor chat via Global Maestro relay (#58)
- Interactive wizards for recruiting and scheduling (#58)
- Message search, scrollback navigation, ensemble switching (#58)
- Splash screen with connection checklist and ensemble picker (#58)
- `claude-tempo tui` as default CLI command (#58)

### Changed

- TUI input area restyled to match Claude Code: `❯` prompt, inline hints, second divider line (#58)
- TUI message display: header line (player name + timestamp) above word-wrapped indented body (#58)
- `/up` command removed from TUI slash commands — ensemble creation is now handled by `CreateEnsembleWizard` via `/ensemble` (#58)
- `down` command now always stops the daemon, requires confirmation when no ensemble is specified, and exits with code 1 in non-TTY environments (#78, #83)

### Fixed

- `load_lineup` MCP tool now resolves shipped example lineups by name, in addition to saved lineups and file paths (#80, #81)
- Blocked detection no longer triggers on informational messages — broadcasts, schedule-fires, heartbeats, and system notifications now set `responseRequested: false`, preventing false positives (#75, #66)
- TUI input lag eliminated — animation timers removed, Yoga nodes flattened, stale ref fix (#58)
- `ErrorView` refactored to zero Yoga nodes — single `<Text>` root with nested virtual-text children, matching the `StatusOverlay`/`ConversationStream` pattern (#58)
- Live message lists capped at ~20 entries to prevent render slowdown (#58)
- Ensemble switching: maestro session identity stabilised, `/back` navigation and context-based messaging corrected (#58, #89)

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
