# Development Setup

## Prerequisites

- Node.js 20+
- A running Temporal server (see below)

## Install

```bash
npm install
```

## Temporal dev server

Claude-tempo requires Temporal with 10 custom search attributes registered. Start the dev server
with all attributes in a separate terminal:

```bash
temporal server start-dev \
  --search-attribute ClaudeTempoEnsemble=Keyword \
  --search-attribute ClaudeTempoPlayerId=Keyword \
  --search-attribute ClaudeTempoHostname=Keyword \
  --search-attribute ClaudeTempoGitRoot=Keyword \
  --search-attribute ClaudeTempoPlayerType=Keyword \
  --search-attribute ClaudeTempoIsConductor=Bool \
  --search-attribute ClaudeTempoAttachedHost=Keyword \
  --search-attribute ClaudeTempoAttachmentState=Keyword \
  --search-attribute ClaudeTempoAttachmentId=Keyword
```

> `ClaudeTempoStatus` was removed in v0.26. If you're upgrading a long-lived cluster,
> see [`docs/ops/v0.26-migration.md`](ops/v0.26-migration.md) for the operator-side drop.

> **Note**: The `agent-tempo up` CLI command handles this automatically for production use.
> The manual command above is the fallback for development environments where you want
> direct control over the Temporal server.

The same attributes are registered in `.github/workflows/ci.yml` for CI runs.

## Build

```bash
# Compile TypeScript and pre-bundle workflow code
npm run build
```

> **Important**: Always run `npm run build` after changing any file in `src/workflows/`.
> The build step pre-bundles workflows into `workflow-bundle.js` so all workers load
> identical code. If you skip this after a workflow change, tests will run against stale
> workflow code.

## Test

```bash
npm test
```

Tests use Temporal's `TestWorkflowEnvironment` — no live Temporal server required for
`npm test`. The test harness loads the pre-built `workflow-bundle.js` from disk, so you
must produce the bundle before running tests after any workflow change.

In a **fresh worktree or clean checkout** (no `node_modules`/`dist/`/bundle), the fast
path is `npm run build:bundle` — `tsc` + `build:scripts` + the workflow bundle, skipping
the heavy dashboard build the tests never need:

```bash
npm ci && npm run build:bundle && npm test
```

If the bundle is missing, the `pretest` guard fails fast with a one-line fix. See
[`test/README.md`](../test/README.md#running-tests-in-a-fresh-worktree--cold-checkout-720)
for the full cold-worktree walkthrough.

When temporarily skipping a test, every `this.skip()` call must carry a
`// SKIP-REASON: <why>` annotation on the same line or the line immediately above.
CI enforces this via `scripts/lint-skip-reasons.js` (exit 1 if any unannotated skip is found).

## Surface registry

`docs/SURFACE-REGISTRY.md` is the canonical inventory of every public-facing surface:
MCP tools, CLI commands, and TUI slash commands. Keep it in sync when adding or removing
a surface entry.

```bash
# Verify the registry matches source (fast, no build required):
npm run lint:surface-drift
```

CI enforces this via the `lint-surface-drift` job in `.github/workflows/ci.yml`.

**What to update after adding a new surface:**

| Surface added | Update |
|---|---|
| New MCP tool in `src/tools/` | Add row to `docs/SURFACE-REGISTRY.md` § 1 |
| New CLI command in `src/cli.ts` | Add row to `docs/SURFACE-REGISTRY.md` § 2 |
| New TUI slash command in `src/tui/commands.ts` | Add row to `docs/SURFACE-REGISTRY.md` § 3 |

The lint script exits non-zero if any entry is missing or if a removed surface still
appears in the registry. Run it locally before pushing to catch drift early.

## Running an isolated dev environment

Dev mode provides a fully isolated profile for E2E testing with zero impact on any installed prod agent-tempo. No global install required — `node dist/cli.js` is the canonical entry point.

```bash
# 1. Build from source (required before first run and after any src/ change)
npm run build

# 2. Start the dev daemon — isolated namespace (agent-tempo-dev), port 8474,
#    home dir ~/.agent-tempo-dev/. Leaves prod daemon and shared Temporal server alone.
node dist/cli.js --dev daemon start

# 3. Run the all-mock lineup (conductor + 4 players are all mock — zero real LLM calls)
node dist/cli.js --dev up --lineup tempo-mock-jam

# 4. Tear down — prod profile and shared Temporal server are left running
node dist/cli.js --dev down
```

**Key points:**

- `node dist/cli.js --dev <verb>` works for every command (`daemon`, `up`, `down`, `status`, `cue`, `scenarios`, …). The `agent-tempo` shell command is a convenience shim — never required.
- Do NOT set `TEMPORAL_NAMESPACE` or `TEMPORAL_ADDRESS` shell-wide for dev work. Post-#423, dev mode ignores these env vars to prevent namespace leaks; use `--temporal-namespace` / `--temporal-address` CLI flags or `~/.agent-tempo-dev/config.json` if you need to override.
- Dev profile data lives in `~/.agent-tempo-dev/`. Delete it for a clean slate: `rm -rf ~/.agent-tempo-dev/` (leaves prod at `~/.agent-tempo/` untouched).
- `--dev down` skips the Temporal server kill if the prod profile appears active (ADR 0014 §5.6). Add `--kill-shared-temporal` to override — **this will disconnect the prod daemon** from Temporal.

See [dev-mode.md](dev-mode.md) for the mock adapter, scenario library, and chaos mode reference.

## Run in development

```bash
# Start the daemon (runs Temporal workers in background)
agent-tempo daemon start

# Run the MCP server directly (connects to the running daemon)
npx ts-node src/server.ts
```

## Daemon workers

Temporal workers are no longer run in-process by sessions. The daemon (`src/daemon.ts`)
runs as a detached background process and owns all worker duties:

- PID stored at `~/.agent-tempo/daemon.pid`
- Logs at `~/.agent-tempo/daemon.log`
- Managed via `agent-tempo daemon start|stop|status|logs`

Sessions are pure MCP clients. The daemon is auto-started by any `agent-tempo` command
if not already running — you don't need to start it manually except in development.

## Related

- [configuration.md](configuration.md) — env var reference
- [daemon.md](daemon.md) — daemon management detail
