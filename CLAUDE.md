# CLAUDE.md

## What is this?

claude-tempo is an MCP server that enables multiple Claude Code sessions to coordinate via Temporal. See [docs/design.md](docs/design.md) for the full architecture.

## Tech Stack

- **Runtime**: Node.js 18+ with TypeScript
- **MCP**: `@modelcontextprotocol/sdk` (stdio transport)
- **Temporal**: `@temporalio/client`, `@temporalio/worker`, `@temporalio/workflow`
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
│   ├── set-part.ts    # Update own summary
│   ├── listen.ts      # Manual message check
│   ├── recruit.ts     # Spawn new session
│   └── report.ts      # Report to conductor
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

# Build
npm run build

# Test
npm test
```

## Key Concepts

- **Player**: A Claude Code session registered as a Temporal workflow
- **Conductor**: A special player that acts as orchestration hub, connected to external interfaces
- **Ensemble**: The set of all active players
- **Cue**: A message sent to a player via Temporal signal
- **Part**: A player's description of what it's working on
- **Recruit**: Spawning a new Claude Code session as a player

## Commit Convention

Use conventional commits: `type(scope): message`

Examples:
- `feat(tools): add ensemble discovery tool`
- `fix(workflow): handle signal delivery edge case`
- `docs: update getting started guide`
