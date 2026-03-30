# CLAUDE.md

## What is this?

claude-tempo is an MCP server that enables multiple Claude Code sessions to coordinate via Temporal.

## Tech Stack

- **Runtime**: Node.js 18+ with TypeScript
- **MCP**: `@modelcontextprotocol/sdk` (stdio transport)
- **Temporal**: `@temporalio/client`, `@temporalio/worker`, `@temporalio/workflow`, `@temporalio/activity`
- **No other dependencies** — no database, no custom broker

## Project Structure

```
src/
├── server.ts          # MCP server entry point
├── worker.ts          # Temporal worker setup
├── workflows/
│   ├── session.ts     # claude-session workflow
│   └── signals.ts     # Signal/query type definitions
├── tools/
│   ├── ensemble.ts    # Discover active sessions
│   ├── cue.ts         # Send message to peer
│   ├── set-name.ts    # Set session name
│   ├── set-part.ts    # Update own summary
│   ├── resolve.ts     # Search-attribute session lookup
│   ├── listen.ts      # Manual message check
│   ├── recruit.ts     # Spawn new session
│   ├── report.ts      # Report to conductor
│   ├── terminate.ts   # Terminate a session
│   └── helpers.ts     # Zod/MCP tool registration wrapper
├── types.ts           # Shared type definitions
├── channel.ts         # Claude channel notification helper
└── config.ts          # Env var handling
```

## Development

```bash
# Install dependencies
npm install

# Start Temporal dev server (separate terminal)
temporal server start-dev

# Run in development
npx ts-node src/server.ts

# Build (compiles TS and pre-bundles workflow code)
npm run build

# Test
npm test
```

> **Important**: Always run `npm run build` after changing workflow code (`src/workflows/`).
> The build pre-bundles workflows into `workflow-bundle.js` so all workers use identical code.

## Key Concepts

- **Player**: A Claude Code session registered as a Temporal workflow
- **Conductor**: A special player that acts as orchestration hub, connected to external interfaces (one per ensemble)
- **Ensemble**: The set of all active players, namespaced by `CLAUDE_TEMPO_ENSEMBLE`
- **Cue**: A message sent to a player by name via Temporal signal
- **Part**: A player's description of what it's working on
- **Recruit**: Spawning a new Claude Code session as a player
- **set_name**: Players start with a random hex ID; `set_name` updates the `ClaudeTempoPlayerId` search attribute to a human-readable name

## Commit Convention

Use conventional commits: `type(scope): message`

Examples:
- `feat(tools): add ensemble discovery tool`
- `fix(workflow): handle signal delivery edge case`
- `docs: update getting started guide`
