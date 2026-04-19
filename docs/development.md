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

> **Note**: The `claude-tempo up` CLI command handles this automatically for production use.
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
must run `npm run build` before running tests after any workflow change.

When temporarily skipping a test, every `this.skip()` call must carry a
`// SKIP-REASON: <why>` annotation on the same line or the line immediately above.
CI enforces this via `scripts/lint-skip-reasons.js` (exit 1 if any unannotated skip is found).

## Run in development

```bash
# Start the daemon (runs Temporal workers in background)
claude-tempo daemon start

# Run the MCP server directly (connects to the running daemon)
npx ts-node src/server.ts
```

## Daemon workers

Temporal workers are no longer run in-process by sessions. The daemon (`src/daemon.ts`)
runs as a detached background process and owns all worker duties:

- PID stored at `~/.claude-tempo/daemon.pid`
- Logs at `~/.claude-tempo/daemon.log`
- Managed via `claude-tempo daemon start|stop|status|logs`

Sessions are pure MCP clients. The daemon is auto-started by any `claude-tempo` command
if not already running — you don't need to start it manually except in development.

## Related

- [configuration.md](configuration.md) — env var reference
- [daemon.md](daemon.md) — daemon management detail
