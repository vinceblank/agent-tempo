# CLAUDE.md

## What is this?

agent-tempo is an MCP server that enables multiple Claude Code sessions to coordinate via Temporal.

## Tech Stack

- **Runtime**: Node.js 20+ with TypeScript
- **MCP**: `@modelcontextprotocol/sdk` (stdio transport)
- **Temporal**: `@temporalio/client`, `@temporalio/worker`, `@temporalio/workflow`, `@temporalio/activity`
- **croner** — cron expression parsing and next-fire computation (used by `schedule` tool)
- **yaml**, **zod** — lineup parsing and schema validation

## Project Structure

```
src/
├── server.ts          # MCP server entry point
├── cli.ts             # CLI entry point (agent-tempo command)
├── daemon.ts          # Daemon entry point — runs Temporal workers as a detached background process
├── cli/
│   ├── commands.ts    # CLI command implementations (up, start, conduct, status, stop, …)
│   ├── config-command.ts # config subcommand (interactive + set/show) — crash-proof for show/set
│   ├── daemon.ts      # Daemon management utilities (start, stop, status, heartbeat, isDaemonRunning)
│   ├── daemon-command.ts # daemon subcommand handler — crash-proof, no Temporal deps
│   ├── dashboard-command.ts # dashboard subcommand — crash-proof; opens the web dashboard, optionally minting a QR-code pairing token (#340)
│   ├── dev-banner.ts  # [DEV MODE] banner formatter (ADR 0014 §5.4) — gate 4 production-safety line
│   ├── dev-mode-bootstrap.ts # pre-import side-effect: promotes top-level `--dev` flag to `CLAUDE_TEMPO_DEV_MODE=1` before any other module loads
│   ├── dev-verbs.ts   # dev-mode scriptable CLI verbs (#432) — shell-scriptable wrappers over MCP tools for E2E validation; stripped from production surface
│   ├── help-text.ts   # help output — crash-proof, no Temporal deps
│   ├── legacy-migration.ts # one-shot idempotent copy `~/.claude-tempo/` → `~/.agent-tempo/` on first v1.0 boot (PR-2 of rebrand)
│   ├── mcp.ts         # MCP server registration helpers (init, global vs project)
│   ├── output.ts      # Shared CLI output formatting helpers
│   ├── preflight.ts   # Environment preflight checks
│   ├── removed-verbs.ts # lookup table for the 10 CLI verbs removed in #288 — dispatches migration hints before loading Temporal surface
│   ├── sa-preflight.ts # search-attribute preflight — REQUIRED_SEARCH_ATTRIBUTES list (single source of truth), registerSearchAttribute, verifySearchAttributes, assertSearchAttributesOrExit
│   ├── scenarios-command.ts # scenarios subcommand (dev mode only) — list/show shipped YAML scenario library (ADR 0014 §4.8)
│   ├── startup.ts     # auto-provisioning bootstrap state machine (#289) — six-step idempotent sequence used by bare `agent-tempo` invocation
│   └── upgrade-command.ts # upgrade subcommand — crash-proof; dynamic-imports Temporal only for active-session warning
├── adapters/
│   ├── README.md      # Adapter contract documentation
│   ├── index.ts       # Adapter registry bootstrap + barrel exports (mock registered iff isDevMode())
│   ├── base.ts        # BaseAttachment + SdkAttachment base classes (lifecycle skeleton)
│   ├── terminal-error.ts # Shared terminal-class error classifier for signal/query failures (#249)
│   ├── claude-code/   # InteractiveAttachment — Claude Code CLI adapter
│   ├── copilot/       # CopilotSdkAttachment — Copilot bridge adapter
│   ├── claude-api/    # ClaudeApiAttachment — headless adapter via Anthropic Messages API (#131)
│   ├── opencode/      # OpenCodeAttachment — headless multi-provider adapter via SST OpenCode subprocess (#449)
│   ├── mock/          # MockAttachment — dev-mode-only SDK adapter (ADR 0014 PR-2). prepack strips dist/adapters/mock from npm tarball.
│   └── sdk/           # SDK-style adapter base (used by Copilot bridge and opencode)
├── client/
│   ├── interface.ts   # TempoClient TypeScript interface and related types
│   └── index.ts       # TempoClient factory implementation and barrel re-exports
├── worker.ts          # Temporal worker setup (used by daemon only)
├── connection.ts      # Temporal connection factory (shared by server + CLI)
├── constants.ts       # Shared string constants (ensemble ready banner/directive, etc.)
├── spawn.ts           # Cross-platform process spawning helpers
├── workflows/
│   ├── session.ts     # claude-session workflow
│   ├── scheduler.ts   # durable scheduler workflow (one per ensemble)
│   ├── maestro.ts     # Maestro workflows — per-ensemble hub and global hub
│   ├── attachment-math.ts # Pure CAN-boundary lease-extension helper (no Temporal imports)
│   ├── maestro-signals.ts / scheduler-signals.ts / signals.ts   # Signal/query/update type defs
│   └── index.ts       # Workflow re-exports for worker bundle
├── activities/
│   ├── outbox.ts         # Outbox delivery activities (cue, report, recruit, release, spawn)
│   ├── maestro.ts        # Maestro activities
│   ├── hard-terminate.ts # Per-host process kill activity (used by destroy when attached)
│   ├── resolve.ts        # Session resolver shared by outbox + schedule-fire activities
│   └── schedule-fire.ts
├── http/              # Daemon HTTP/SSE event source (#94/#95)
│   ├── server.ts      # Express-style HTTP server — snapshot + streaming endpoints
│   ├── event-bus.ts   # In-process EnsembleEventBus (fanout to SSE clients)
│   ├── event-types.ts # TempoEvent / ClusterEvent wire type definitions
│   ├── sse-handler.ts # SSE response lifecycle (ring-buffer replay, gap detection, backpressure)
│   ├── ring-buffer.ts # Fixed-size event ring buffer (256 events) for Last-Event-ID replay
│   ├── snapshot.ts    # On-demand ensemble state snapshot (prelude + poll)
│   ├── aggregate.ts   # AggregateRunner — wires bus + snapshot + HTTP server startup
│   ├── auth.ts / cors.ts / responses.ts / event-id.ts / port-file.ts / index.ts
├── reconcile/
│   └── orphans.ts     # Shared orphan-query helper (daemon reconcile-on-boot + CLI restore)
├── ensemble/
│   ├── schema.ts / loader.ts / saver.ts   # Lineup type definitions, load, save
│   └── agent-types.ts # Agent type discovery, resolution, and lineup resolution
├── tools/             # One file per MCP tool — see docs/tools.md for full reference
│   ├── ensemble.ts / cue.ts / recruit.ts / report.ts / broadcast.ts / recall.ts / listen.ts
│   ├── restart.ts / destroy.ts / migrate.ts / attachment-info.ts
│   ├── schedule.ts / unschedule.ts / schedules.ts
│   ├── quality-gate.ts / evaluate-gate.ts / gates.ts
│   ├── worktree.ts / stage.ts / stages.ts / cancel-stage.ts
│   ├── load-lineup.ts / save-lineup.ts / agent-types.ts / resolve.ts
│   ├── set-name.ts / set-part.ts / who-am-i.ts / release.ts
│   ├── pause.ts / play.ts / shutdown.ts / restore.ts
│   ├── hosts.ts / set-ensemble-description.ts
│   ├── save-state.ts / fetch-state.ts / clear-state.ts
│   ├── coat-check-put.ts / coat-check-get.ts / coat-check-list.ts / coat-check-evict.ts
│   └── helpers.ts     # Zod/MCP tool registration wrapper
├── tui/
│   ├── App.tsx / store.ts / commands.ts   # TUI root, state, slash commands
│   ├── sse-handler.ts # SSE event → TUI store dispatch mapping (PR-4a of #94/#95)
│   ├── components/    # Ink components — see docs/tui.md for inventory
│   └── utils/         # format, platform, theme, fullscreen, history
├── utils/
│   ├── validation.ts / worktree.ts / safe-path.ts / duration.ts / search-attributes.ts
│   ├── attachment-format.ts / recall-format.ts   # Shared display formatters (attachment-info, recall)
│   ├── hosts.ts / format-hosts.ts                # Host enumeration + shared hosts display formatter (#274)
│   └── sdk-probe.ts   # Filesystem-walk probe for installed optional npm deps (used by opencode adapter + recruit preflight, #449)
├── types.ts           # Shared type definitions
├── git-info.ts        # Git repository detection helper
└── config.ts          # Env var handling
```

See [docs/tui-performance.md](docs/tui-performance.md) for Ink/React performance notes when
touching `src/tui/`.

## Development

```bash
npm install
npm run build       # compiles TS, scripts/*.ts → dist/scripts/, and pre-bundles workflow code into workflow-bundle.js
npm test
npm run check:all   # runs every CI gate locally (build, tests, drift checks, lints, dashboard, size-limit, tarball). Run before pushing to catch CI failures up front.
```

> **Always run `npm run build` after changing workflow code (`src/workflows/`).** The build
> pre-bundles workflows into `workflow-bundle.js` so all workers use identical code.

> **Two test directories.** Mocha tests live in `test/` (Temporal workflow integration
> suites, wire-protocol drift detector). Vitest tests live in `tests/` (TUI components,
> TempoClient fallback paths). Both are first-class targets — when doing call-site
> surveys or migrations, always grep **both** `test/` and `tests/` or you will miss
> mocks and assertions that only live in one directory.

> **Test-only hooks live with the module they reset and follow the
> `__<verb><Noun>ForTests` naming convention** — see
> [docs/adr/0006-test-hooks-naming.md](docs/adr/0006-test-hooks-naming.md). The
> double-underscore prefix telegraphs "test escape hatch, do not call from
> production code"; the hook's doc-comment should restate that explicitly. Hooks
> are never surfaced through barrels or `TempoClient`.

> **Project standard is npm** (declared via `package.json#packageManager`,
> enforced in CI by `lint:lockfile-canonical`). If `npm` is blocked locally
> (e.g. corp networks), `pnpm` works as a personal workaround — `pnpm-lock.yaml`
> is gitignored, so it can exist on disk but must NOT be committed. The
> `lint:lockfile-canonical` step inside `check:all` fails if any non-npm
> lockfile (`pnpm-lock.yaml`, `yarn.lock`, or their `dashboard/` counterparts)
> appears in `git ls-files`. The `dashboard/` subworkspace also uses npm and
> ships its own `package-lock.json` — see `.github/workflows/ci.yml` for why
> the install is intentionally independent.

See [docs/development.md](docs/development.md) for full setup (Temporal dev server command,
daemon worker notes, `npx ts-node` dev runner).

## Key Concepts

> **Architecture overview**: See [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md) for the three-layer workflow/adapter/process model and ensemble coordination layer.

- **Player**: A Claude Code session registered as a Temporal workflow
- **Conductor**: A special player that acts as orchestration hub, connected to external interfaces (one per ensemble)
- **Ensemble**: The set of all active players, namespaced by `CLAUDE_TEMPO_ENSEMBLE`
- **Cue**: A message sent to a player by name via Temporal signal
- **Part**: A player's description of what it's working on
- **Outbox**: Outbound requests (cue, report, recruit, restart, detach, destroy, …) go through the session's workflow outbox instead of directly signaling other workflows. The dispatch loop processes entries via activities, decoupling tools from cross-workflow signaling.
- **Attachment phase** (v0.26): Seven phases tracked on the session workflow — `booting → attached → processing | awaiting → draining → detached → gone`. The phase is authoritative for lifecycle truth: adapters drive it via `claimAttachment` / `adapterExited` / `forceDetach` / `destroy`, and the workflow publishes it on the `ClaudeTempoAttachmentState` search attribute. Replaced the v0.25 `ClaudeTempoStatus` heuristic (removed in v0.26). See [docs/concepts.md](docs/concepts.md) for the phase table and [docs/ops/v0.26-migration.md](docs/ops/v0.26-migration.md) for the upgrade path.
- **Adapter heartbeat observability** (#249): After `claimAttachment`, the base adapter logs `first heartbeat scheduled in Xms` then `heartbeat#1 delivered` on the first tick. Every 10 ticks it emits `heartbeats-delivered=N / phase-ticks=N` breadcrumbs. Any silent guard trip in `tickHeartbeat` / `tickPhaseWatcher` now emits a structured `guard tripped: {stopped, reconnecting, …}` log instead of silently orphaning the timer. The phase-watcher emits `WARNING: heartbeat staleness` when `lastHeartbeatAt` falls more than 2× `heartbeatMs` behind `now`. Grep `[agent-tempo:adapter]` to confirm loop health without parsing Temporal history.
- **Per-host task queues**: `host` param on `recruit`/`restart`/`migrate` routes to `agent-tempo-{hostname}` task queue. When `host` is set on `recruit`, a pre-flight check validates the target daemon is live and supports the requested agent type (`force: true` bypasses). Daemon boot profiles (hostname, platform, available player types) are advertised via the `hostProfile` signal and maintained in the global maestro's `hostProfiles` map — surfaced by the `hosts` MCP tool, `agent-tempo hosts` CLI, and `/hosts` TUI command (#274). See [docs/concepts.md](docs/concepts.md) for cross-machine recruiting details.
- **Wire protocol**: All signal/query/update names are documented in [`docs/WIRE-PROTOCOL.md`](docs/WIRE-PROTOCOL.md) and are stable — renaming or removing any is a breaking change. **Process**: update `docs/WIRE-PROTOCOL.md` in the same commit as any new signal, query, or update.
- **Daemon**: Standalone background process (`src/daemon.ts`) that runs all Temporal workers and the HTTP/SSE event source (`src/http/`). Auto-started by any `agent-tempo` command. PID at `~/.agent-tempo/daemon.pid`; logs at `~/.agent-tempo/daemon.log`. Exposes local HTTP endpoints (`/v1/health`, `/v1/ensembles`, `/v1/state/:ensemble`, `/v1/events/:ensemble` SSE stream, etc.) consumed by the TUI and `TempoClient.subscribe()`. See [docs/SSE-PROTOCOL.md](docs/SSE-PROTOCOL.md).
- **Player types**: Reusable agent definitions in Claude Code's subagent format (`.md` files with YAML frontmatter). Three-tier lookup: project `.claude/agents/` → user `~/.claude/agents/` → shipped `examples/agents/`. Discover via `agent_types` tool or `agent-tempo agent-types` CLI. Shipped types: tempo-conductor, tempo-composer, tempo-soloist, tempo-tuner, tempo-critic, tempo-roadie, tempo-improv, tempo-liner.
- **Dev mode** (`--dev` flag or `CLAUDE_TEMPO_DEV_MODE=1`): Isolated testing profile — flips home dir to `~/.agent-tempo-dev/`, HTTP port to 8474, Temporal namespace to `agent-tempo-dev`, task queue to `agent-tempo-dev`. Required to use the mock adapter. Post-#423 isolation guarantees: (1) `TEMPORAL_NAMESPACE` / `TEMPORAL_ADDRESS` shell env vars are ignored in dev mode — the dev namespace is not overridable by shell config, only CLI flags and `~/.agent-tempo-dev/config.json`. (2) `--dev down` will not kill the Temporal server if the prod profile is alive; use `--kill-shared-temporal` to override. Canonical entry point (no global install required): `node dist/cli.js --dev <verb>`. Quick E2E: `node dist/cli.js --dev daemon start && node dist/cli.js --dev up --lineup tempo-mock-jam`. See [docs/dev-mode.md](docs/dev-mode.md) for the full reference.
- **Claude API adapter** (`agent: 'claude-api'`, #131): Headless adapter that drives sessions via the Anthropic Messages API (`@anthropic-ai/sdk`) — no terminal, no Claude Code CLI. Requires `ANTHROPIC_API_KEY` env var and the `@anthropic-ai/sdk` optional dependency. Default model `claude-opus-4-7` (overridable via `model` recruit arg or `CLAUDE_TEMPO_API_MODEL` env). Claude-API players have access to agent-tempo MCP tools (cue, report, recall, ensemble, …) but not file-edit/shell/web tools. See `src/adapters/claude-api/`.
- **OpenCode adapter** (`agent: 'opencode'`, #449): Headless multi-provider adapter that drives sessions via [SST OpenCode](https://opencode.ai) as a managed subprocess — supports Anthropic, OpenAI, Bedrock, Vertex, Ollama, and ~70 other providers via OpenCode's `provider/model` selector. Requires OpenCode CLI (`npm install -g opencode-ai`) and the `@opencode-ai/sdk` optional dependency. Recruit with `model: 'provider/name'` (e.g. `'anthropic/claude-opus-4-7'`). Tool bridging is MCP-native — OpenCode spawns `dist/server.js` as its own stdio MCP child. Session state is persisted server-side by OpenCode; the adapter stashes the session id on workflow metadata for reconnect across `opencode serve` restarts. See `src/adapters/opencode/`.
- **Claude Code headless adapter** (`agent: 'claude-code-headless'`, #520): Headless adapter that drives sessions via the official `claude` CLI as a per-turn `claude -p --output-format stream-json` subprocess. The whole point: turns bill against the host's existing Claude Code subscription extra-usage credits (Pro / Max plans) rather than a Console workspace API key — the only ToS-clean way for a third-party tool to tap that pool. Requires the `claude` binary on PATH AND a logged-in Claude Code session (`claude auth login`); recruit pre-flight rejects with an actionable error otherwise. Tool surface is the union of full Claude Code built-ins (Bash / Read / Write / Edit / Glob / Grep / WebSearch / WebFetch) and the agent-tempo MCP surface — registered via inline `--mcp-config` so `claude` spawns `dist/server.js` as its own MCP child (no in-process bridge). Recruit knobs: `permissionMode` (default `'acceptEdits'`) or `dangerouslySkipPermissions: true` (mutually exclusive). Sessions resume across restart via the existing `sessionId` metadata field — the same UUID is shared with the interactive `claude-code` adapter (per-cwd JSONL is per-cwd, not per-adapter). See `src/adapters/claude-code-headless/` and `examples/ensembles/tempo-headless-jam.yaml`.
- **Mock adapter** (`agent: 'mock'`, dev mode only): Four modes: `echo` (echoes input), `scripted` (replays YAML scenario rules), `silent` (drains messages without replying — heartbeat-stale validation), `chaos` (probabilistic fail/crash injection via seeded PRNG). Only registered when `isDevMode()` is true; stripped from the npm tarball by `prepack`. See `src/adapters/mock/`.
- **Saveable state** (#334, ADR 0011): Per-player curated state slots — the player itself decides what context survives a restart. Three MCP tools: `save_state` (owner-only write, max 4 slots × 32 KiB), `fetch_state` (read self or peer; audit identity recorded on each entry's `savedBy`), `clear_state` (owner-only). `restart` accepts `loadFromState: true | 'someKey'` to seed the new session from a saved-state slot instead of (or, with `transcript: 'replay'`, alongside) transcript replay. Saved-state delivery uses `from: 'self-restart'` as a stable system identity. Empty-slot fallback: graceful — falls through to transcript replay with a log line. See [docs/design/334-player-saveable-state.md](docs/design/334-player-saveable-state.md).
- **Coat-check** (#318, ADR 0008): Per-ensemble transient content store on Maestro state. Solves the 100 KB cue body cap — stash a large artifact with `coat_check_put` (returns a ticket id) and attach the ticket to a `cue` via `attachmentTicket`; the recipient calls `coat_check_get` to pull the full body. Four MCP tools: `coat_check_put` (any player; max 32 KiB per entry, 20 slots per ensemble, TTL 7d default), `coat_check_get` (any player; bumps fetch-audit counters), `coat_check_list` (read-only survey; headers only, content omitted), `coat_check_evict` (owner or conductor). Saturation rejects with `CoatCheckSlotsFull` (no LRU eviction). See `src/tools/coat-check-*.ts` and [docs/adr/0008-coat-check-pattern.md](docs/adr/0008-coat-check-pattern.md).
- **Lineup examples**: Six pre-built ensemble YAML files in `examples/ensembles/` — `tempo-big-band`, `tempo-dev-team`, `tempo-review-squad`, `tempo-jam-session`, `tempo-mock-jam` (dev-mode all-mock ensemble), `tempo-headless-jam` (#520 — all-`claude-code-headless` subscription-billed ensemble). Load with `agent-tempo up --lineup <name>` or the `load_lineup` tool.
- **GitHub App identity** (`claude-tempo[bot]`): When a player writes to GitHub — issue comments, PR creation/merge, commits, labels, check runs — **use `./scripts/ensemble-gh`** instead of `gh`. The wrapper mints a short-lived installation token so the action is attributed to `claude-tempo[bot]`, not to the human maintainer, making the AI authorship visible. Plain `gh` is still correct for read-only local dev (`gh pr view`, `gh repo clone`, `gh auth status`). Every bot-authored comment/PR body must include the AI attribution footer documented in [docs/github-app.md](docs/github-app.md).

See [docs/concepts.md](docs/concepts.md) for the full glossary (Adapter, Attachment phases, Restart, Detach/Destroy, Migrate, Broadcast, Recall, Schedule, Lineup, Quality Gate, Worktree, Stage, Hold/Release, Pause/Resume, Maestro, TempoClient, and more).

## Commit Convention

Use conventional commits: `type(scope): message`

Examples:
- `feat(tools): add ensemble discovery tool`
- `fix(workflow): handle signal delivery edge case`
- `docs: update getting started guide`

## PR Body Conventions

GitHub's auto-close keywords (`Closes`, `Fixes`, `Resolves`) ignore any trailing qualifier text. They cannot express "this PR closes part of an issue" — they always close the full issue.

For multi-PR efforts tracked under a single issue, use these conventions in PR bodies:

| Form | When to use |
|---|---|
| `Refs #N` | Any intermediate PR of a multi-PR effort. No auto-close. |
| `Implements PR-K of #N` | Same as above, more explicit. No keyword match → no auto-close. |
| `Closes #N` | Final PR of the effort (or single-PR efforts). Triggers auto-close on merge. |

**Avoid `Closes #N PR-K`** — GitHub ignores the `PR-K` qualifier and auto-closes #N prematurely. If you find yourself wanting to express "closes part of," use `Refs #N` and add a manual close on the final PR.

When sequencing multi-PR work, name the issue's open question explicitly in the first PR's body (e.g., "PR-1 of 2: foundation; PR-2 follows for the user-visible payoff") so reviewers know more is coming.

## Release Process

> **Release rule**: Bump `package.json` + CHANGELOG before tagging. Never tag a commit that
> doesn't match the version. Tagging prematurely publishes the old version to npm.

See [docs/release-process.md](docs/release-process.md) for the full 4-step sequence.
