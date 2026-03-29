# claude-tempo

MCP server for multi-session Claude Code coordination via [Temporal](https://temporal.io).

Multiple Claude Code sessions discover each other, exchange messages in real time, and coordinate work — across machines, not just localhost.

## How it works

**claude-tempo** uses Temporal workflows as the coordination layer:

- Each Claude Code session registers as a **player** (a Temporal workflow)
- Players discover each other via `ensemble`, message via `cue`, and spawn new sessions via `recruit`
- An optional **conductor** workflow acts as a hub — connected to Discord/Telegram via Claude channel plugins, or queryable by any Temporal client
- Players can interact directly (peer-to-peer) — the conductor is a hub, not a gatekeeper

```
         You (Discord / Telegram / CLI / Claude Code)
              |
              | signal / query
              v
         Conductor Workflow
              |
    +---------+---------+
    v         v         v
 Player A  Player B  Player C
    |                   ^
    +------ cue --------+        (direct peer-to-peer)
```

## Tools

| Tool | Description |
|------|-------------|
| `ensemble` | Discover active sessions. Scope: `machine`, `repo`, `all`. |
| `cue` | Send a message to any session by ID. Instant via Temporal signal. |
| `set_part` | Describe what you're working on. Visible to others. |
| `listen` | Manual fallback for message checking. |
| `recruit` | Start a new Claude Code session in a directory. |
| `report` | Send updates to the conductor (surfaces to Discord/Telegram). |

## Prerequisites

- [Node.js](https://nodejs.org/) 18+
- [Temporal CLI](https://docs.temporal.io/cli) (for local dev server)
- [Claude Code](https://claude.ai/code) v2.1.80+

## Quick start

```bash
# Clone and install
git clone https://github.com/vinceblank/claude-tempo.git
cd claude-tempo && npm install

# Start Temporal dev server (separate terminal)
temporal server start-dev

# Register as MCP server
claude mcp add --scope user --transport stdio claude-tempo -- npx ts-node src/server.ts

# Launch Claude Code with channel support
claude --dangerously-load-development-channels server:claude-tempo
```

Open a second terminal with the same command. In either session, try:
- "Show me the ensemble" — discovers the other session
- "Cue [peer-id]: what are you working on?" — sends a message
- "Recruit a session in /repos/my-project to run tests" — spawns a new player

## Conductor mode

To use Discord/Telegram as your command interface:

```bash
# Conductor session (you interact via Discord)
claude --channels plugin:discord@claude-plugins-official \
  --dangerously-load-development-channels server:claude-tempo
```

Or interact via any Temporal client:

```typescript
import { Client } from '@temporalio/client';

const client = new Client();
const conductor = client.workflow.getHandle('conductor');

await conductor.signal('command', {
  text: 'recruit /repos/api and run tests',
  source: 'cli',
});

const status = await conductor.query('status');
```

## Configuration

| Environment Variable | Default | Description |
|---------------------|---------|-------------|
| `TEMPORAL_ADDRESS` | `localhost:7233` | Temporal server address |
| `TEMPORAL_NAMESPACE` | `default` | Temporal namespace |
| `CLAUDE_TEMPO_TASK_QUEUE` | `claude-tempo` | Task queue name |

## Why Temporal?

[claude-peers](https://github.com/louislva/claude-peers-mcp) pioneered multi-session Claude Code coordination. claude-tempo builds on that idea with Temporal because:

- **Cross-machine**: Any session that can reach the Temporal server can join the ensemble
- **No polling**: Temporal signals deliver messages instantly (vs. 1s polling)
- **Durable history**: Full audit trail of every message in Temporal's event history
- **No custom infrastructure**: No broker daemon, no SQLite — just Temporal
- **Extensible**: The conductor's signal/query contract is a public API anyone can build on

## Design

See [docs/design.md](docs/design.md) for the full architecture and design document.

## License

MIT
