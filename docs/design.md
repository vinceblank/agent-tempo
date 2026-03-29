# claude-tempo — Design Document

**Date:** 2026-03-29
**Status:** Draft
**Type:** New standalone project

## Overview

An MCP server that enables multiple Claude Code sessions to discover each other and exchange messages in real time using **Temporal** as the messaging layer. Unlike [claude-peers](https://github.com/louislva/claude-peers-mcp) (localhost-only, custom broker, SQLite, polling), claude-tempo leverages Temporal for cross-machine support, signal-based push delivery, and durable message history — with no custom infrastructure to manage.

## Goals (v1)

- Peer registration and discovery across machines
- Instant message delivery via Temporal signals (no polling)
- Conductor workflow with a Temporal-native API (signals in, queries out)
- External interface support (Discord, Telegram) via Claude channel plugins
- Any player can recruit new sessions or cue other players directly
- Generic signal/query contract so anyone can build custom clients

## Architecture

```
         You (Discord / Telegram / CLI / Claude Code)
              |
              | signal("command") / query("status")
              v
         Conductor Workflow         <-- Temporal-native API
         (orchestration hub,            anyone can signal/query
          also a player)
              |
    +---------+---------+
    v         v         v
 Player A  Player B  Player C      <-- claude-session workflows
    |                   ^
    +------ cue --------+           (direct peer-to-peer)
    +------ recruit --> Player D    (any player can spawn new sessions)
```

### Key Principles

- **Conductor is a hub, not a gatekeeper.** Players can cue each other directly and recruit new players without going through the conductor.
- **Temporal-native first.** The conductor exposes signals and queries. Discord/Telegram are just clients that use this API via Claude channel plugins.
- **Signals in, queries out.** Anyone with a Temporal client can interact — custom CLI tools, CI pipelines, web dashboards, other workflows.

## Components

### 1. Session Workflow (`claude-session`)

One per Claude Code session. The core building block.

```typescript
async function claudeSessionWorkflow(input: SessionInput) {
  // State
  let part = input.autoSummary ?? "No description set";
  let messages: Message[] = [];

  // Signal handlers
  setHandler(receiveMessageSignal, (msg) => {
    messages.push(msg);
    // MCP server picks up new messages and pushes to Claude channel
  });

  setHandler(setPartSignal, (newPart) => {
    part = newPart;
  });

  setHandler(shutdownSignal, () => {
    // Graceful cleanup
  });

  // Query handlers (read-only)
  setHandler(getPartQuery, () => part);
  setHandler(getMetadataQuery, () => input.metadata);
  setHandler(pendingMessagesQuery, () => messages.filter(m => !m.delivered));

  // Keep alive until cancelled (session ends)
  await condition(() => false);
}
```

**Lifecycle:**
- Starts when MCP server initializes
- Lives for the duration of the Claude Code session
- MCP server queries for pending messages and pushes to Claude channel
- Cancelled on MCP server shutdown

**Search attributes** (for filtering in `ensemble`):
- `hostname` — machine scope filtering
- `gitRoot` — repo scope filtering
- `workflowType` = `claude-session`

### 2. Conductor Workflow

A special `claude-session` with extra responsibilities. Single instance, lives indefinitely.

**Conductor Signal Contract (write — anyone can send):**

| Signal | Payload | Description |
|--------|---------|-------------|
| `command` | `{ text, source, replyTo? }` | Issue a command. Source identifies caller (discord, cli, ci, etc). |
| `player_report` | `{ peerId, text, type }` | Player reporting back. Type: `result`, `blocker`, `question`. |

**Conductor Query Contract (read — anyone can poll):**

| Query | Returns | Description |
|-------|---------|-------------|
| `status` | `{ ensemble, activeTasks, lastUpdate }` | Full conductor state snapshot. |
| `history` | `{ messages[] }` | Recent command/report log. |
| `ensemble` | `{ players[] }` | Active player list with metadata and parts. |

**Example: Custom CLI client**
```typescript
import { Client } from '@temporalio/client';

const client = new Client();
const conductor = client.workflow.getHandle('conductor');

// Send a command
await conductor.signal('command', {
  text: 'recruit /repos/api and run tests',
  source: 'cli',
});

// Check status
const status = await conductor.query('status');
console.log(status.ensemble);
```

**Example: GitHub Actions step**
```yaml
- name: Notify ensemble
  run: |
    npx ts-node -e "
      const { Client } = require('@temporalio/client');
      const c = new Client({ address: '${{ secrets.TEMPORAL_ADDRESS }}' });
      const h = c.workflow.getHandle('conductor');
      h.signal('command', {
        text: 'deploy complete, run smoke tests',
        source: 'github-actions'
      });
    "
```

### 3. MCP Server

One per Claude Code session. Runs both a Temporal client and worker.

**On startup:**
1. Generates a peer ID (random 8-char alphanumeric)
2. Starts a `claude-session` workflow with metadata (peerID, hostname, workDir, gitRoot, gitBranch)
3. Worker hosts the workflow locally
4. Registers Claude channel notification capability
5. Announces to conductor (if running) via signal

**On shutdown:**
- Signals own workflow to complete
- Workflow cleaned up by Temporal

**Server instructions** (injected into Claude's context):
> "You are part of an ensemble of Claude Code sessions coordinated via Temporal. When you receive a message from another session, treat it like a coworker asking for help — respond promptly, then resume your work. Use `ensemble` to see who else is active. Use `cue` to ask others for help. Use `recruit` if you need a session in a directory where none exists. Use `report` to send significant updates to the conductor."

## MCP Tools

| Tool | Available to | Temporal operation | Description |
|------|-------------|-------------------|-------------|
| `ensemble` | All | `listWorkflows` + `query` | Discover active sessions. Scope: `machine`, `repo`, `all`. |
| `cue` | All | `signal` to any peer | Send a message to any session by ID. Direct signal, instant delivery. |
| `set_part` | All | `signal` on own workflow | Describe current work. Visible via `ensemble`. |
| `listen` | All | `query` own workflow | Manual fallback for message checking (when channel push unavailable). |
| `recruit` | All | `child_process.spawn` + watch workflows | Start a new Claude Code session in a directory. Returns new peer ID. |
| `report` | Players | `signal` to conductor | Send a result/update to the conductor. No-op if no conductor running. |

### `recruit` Behavior

1. Spawns a detached `claude --dangerously-load-development-channels server:claude-tempo` process targeting the specified working directory
2. Polls `ensemble` briefly (up to ~10s) waiting for the new session's workflow to appear
3. Returns the new peer ID so you can immediately `cue` it
4. Optionally accepts an initial message — so `recruit("/repos/backend", "run the tests")` is a single action

### `report` Behavior

- Player signals the conductor workflow with a structured update (task completed, blocker hit, question for you)
- Conductor pushes it to whichever interfaces are connected (Discord, Telegram, Claude Code terminal)
- If no conductor is running, `report` is a no-op — the ensemble still works as a pure peer mesh

## External Interface Layer

The conductor connects to you via Claude Code's existing channel plugin system. No custom bot or webhook server needed.

**Setup:**
```bash
# Conductor session with Discord + claude-tempo
claude --channels plugin:discord@claude-plugins-official \
  --dangerously-load-development-channels server:claude-tempo

# Player sessions (just claude-tempo)
claude --dangerously-load-development-channels server:claude-tempo
```

**Flow:**
1. You message in Discord: "recruit a session in /repos/api and have it run tests"
2. Conductor receives via channel plugin
3. Conductor calls `recruit`, then `cue` with your instructions
4. Player executes, calls `report` back to conductor
5. Conductor replies to Discord with results

**For non-Discord/Telegram clients:** Poll the conductor's `status` and `history` queries directly via any Temporal client SDK.

## Configuration

| Environment Variable | Default | Description |
|---------------------|---------|-------------|
| `TEMPORAL_ADDRESS` | `localhost:7233` | Temporal server address |
| `TEMPORAL_NAMESPACE` | `default` | Temporal namespace |
| `CLAUDE_TEMPO_TASK_QUEUE` | `claude-tempo` | Task queue name |

## Project Structure

```
claude-tempo/
├── src/
│   ├── server.ts          # MCP server entry point (stdio transport)
│   ├── worker.ts          # Temporal worker setup
│   ├── workflows/
│   │   ├── session.ts     # claude-session workflow
│   │   └── signals.ts     # Signal/query type definitions
│   ├── tools/
│   │   ├── ensemble.ts    # Discover active sessions
│   │   ├── cue.ts         # Send message to peer
│   │   ├── set-part.ts    # Update own summary
│   │   ├── listen.ts      # Manual message check
│   │   ├── recruit.ts     # Spawn new session
│   │   └── report.ts      # Report to conductor
│   ├── channel.ts         # Claude channel notification helper
│   └── config.ts          # Env var handling
├── package.json
├── tsconfig.json
├── README.md
└── CLAUDE.md
```

**Dependencies:**
- `@modelcontextprotocol/sdk` — MCP server
- `@temporalio/client` — Temporal client (signals, queries, list workflows)
- `@temporalio/worker` — Hosts the session workflow
- `@temporalio/workflow` — Workflow definitions

No other dependencies. No database, no custom broker.

## Getting Started

```bash
# Clone and install
git clone https://github.com/vinceblank/claude-tempo.git ~/claude-tempo
cd ~/claude-tempo && npm install

# Start Temporal dev server
temporal server start-dev

# Register as MCP server
claude mcp add --scope user --transport stdio claude-tempo -- npx ts-node ~/claude-tempo/src/server.ts

# Launch Claude Code with channel support
claude --dangerously-load-development-channels server:claude-tempo

# Recommended alias
alias claudetempo='claude --dangerously-load-development-channels server:claude-tempo'
```

## Future (v2+)

- Orchestration workflow patterns (fan-out/fan-in, sagas)
- Web dashboard via Temporal UI + custom queries
- Persistent task tracking across sessions
- Auto-summary via Claude API (replacing claude-peers' OpenAI dependency)
- Temporal Cloud support (managed, no local server needed)
