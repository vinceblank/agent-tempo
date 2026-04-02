# claude-tempo

Multi-session [Claude Code](https://claude.ai/code) coordination via [Temporal](https://temporal.io).

Multiple Claude Code sessions discover each other, exchange messages in real time, and coordinate work — across machines, not just localhost.

Each Claude Code session registers as a **player** in Temporal. Players discover each other with `ensemble`, exchange messages with `cue`, and coordinate work — across machines, not just localhost. An optional **conductor** orchestrates the group and connects to external interfaces like Discord, Telegram, or a dashboard.

## Installation

```bash
npm install -g claude-tempo
```

### Prerequisites

- [Node.js](https://nodejs.org/) 18+
- [Temporal CLI](https://docs.temporal.io/cli) (for local dev server)
- [Claude Code](https://claude.ai/code)

## Quick start

One command handles everything:

```bash
cd your-project
claude-tempo up
```

This will:

1. Check that Temporal CLI is installed
2. Start the Temporal dev server (data persists in `~/.claude-tempo/`)
3. Register required search attributes
4. Create `.mcp.json` in your project
5. Launch a conductor session in a new terminal window

Then add players:

```bash
claude-tempo start          # open a player session
claude-tempo status         # see who's active
```

Or ask the conductor to `recruit` players for you from inside Claude Code.

### Manual setup

For more control, run each step individually:

```bash
# Start Temporal dev server (keep running)
claude-tempo server

# In your project directory, create .mcp.json
cd your-project
claude-tempo init

# Verify everything is ready
claude-tempo preflight

# Start a conductor
claude-tempo conduct

# Add players
claude-tempo start
```

## Core concepts

- **Player** — A Claude Code session registered as a Temporal workflow
- **Conductor** — An optional orchestration hub connected to external interfaces (one per ensemble)
- **Ensemble** — A named group of players that can see and message each other, isolated from other ensembles
- **Cue** — A message sent to a player by name via Temporal signal

Players in one ensemble cannot see or message players in another. By default, sessions join the `default` ensemble:

```bash
claude-tempo conduct frontend     # conduct the "frontend" ensemble
claude-tempo start backend        # join the "backend" ensemble
claude-tempo conduct              # conduct the "default" ensemble
```

## CLI reference

```
claude-tempo <command> [options]
```

### Commands

| Command | Description |
|---------|-------------|
| `up [ensemble]` | First-time setup: start Temporal, configure MCP, launch conductor |
| `down` | Stop Temporal, terminate sessions, remove MCP config |
| `server` | Start the Temporal dev server and register search attributes |
| `conduct [ensemble]` | Start a conductor session (one per ensemble) |
| `start [ensemble]` | Start a player session |
| `status [ensemble]` | Show active sessions and Temporal health |
| `config` | Configure Temporal connection settings (interactive or `set`/`show`) |
| `init` | Create `.mcp.json` config in the current directory |
| `preflight` | Run environment checks |
| `help` | Show usage info |

### Global options

```
--temporal-address <addr>     Temporal server address (default: localhost:7233)
--temporal-namespace <ns>     Temporal namespace (default: default)
--temporal-api-key <key>      Temporal Cloud API key
--temporal-tls-cert <path>    mTLS client certificate path
--temporal-tls-key <path>     mTLS client key path
-n, --name <name>             Set the player name (start/conduct/up)
--skip-preflight              Skip preflight checks (start/conduct)
-d, --dir <path>              Target directory (default: cwd)
--background                  Run Temporal in background (server only)
```

### `claude-tempo up`

The recommended way to get started:

```
$ claude-tempo up myband

claude-tempo setup
  ✓ temporal CLI installed
  … Starting Temporal dev server...
  ✓ Temporal started (pid 12345, data in ~/.claude-tempo/)
  ✓ Registered search attributes
  ✓ .mcp.json created

Launching conductor in ensemble myband...

✓ You're all set!
  Conductor launched (pid 12346)
  Ensemble: myband

  What next?
  claude-tempo start myband    Add a player session
  claude-tempo status myband   See who's active
  Or ask the conductor to recruit players for you
```

### `claude-tempo server`

Starts the Temporal dev server with automatic search attribute registration:

```bash
claude-tempo server                 # foreground (Ctrl+C to stop)
claude-tempo server --background    # daemonize
```

Data persists in `~/.claude-tempo/temporal-data.db`. If Temporal is already running, registers attributes and exits.

### `claude-tempo status`

Shows all active sessions:

```
Ensemble: myband
  3 active sessions

  conductor (conductor)
    Orchestrating the team
    /Users/me/projects/app  main  my-machine.local

  alice
    Building the REST endpoints
    /Users/me/projects/app  feat/api  my-machine.local

  bob
    Working on the dashboard
    /Users/me/projects/app  feat/ui  my-machine.local
```

### `claude-tempo preflight`

Verifies your environment: Node.js >= 18, Temporal reachable, `claude` on PATH, `claude-tempo-server` on PATH, `.mcp.json` configured.

### `claude-tempo init`

Creates `.mcp.json` in the current directory (or merges into an existing one):

```json
{
  "mcpServers": {
    "claude-tempo": {
      "command": "npx",
      "args": ["claude-tempo-server"]
    }
  }
}
```

## MCP tools

These tools are available inside Claude Code sessions connected to claude-tempo:

| Tool | Description |
|------|-------------|
| `ensemble` | Discover active sessions. Scope: `machine`, `repo`, or `all`. |
| `cue` | Send a message to a player by name. Delivered instantly via Temporal signal. |
| `set_name` | Set a human-readable name for this session. |
| `set_part` | Describe what you're working on. Visible to others via `ensemble`. |
| `listen` | Manually check for pending messages. |
| `recruit` | Spawn a new Claude Code session in a directory. Opens a new terminal window. |
| `report` | Send updates to the conductor. No-op if no conductor exists. |
| `terminate` | Terminate a player session by name. |

## Conductors

A **conductor** is an optional special player that acts as an orchestration hub. Use one when you want:

- A single session coordinating work across multiple players
- External access to the ensemble via Discord, Telegram, or any Temporal client
- A central point for players to `report` progress, blockers, and questions

Without a conductor, players work fine peer-to-peer — they discover each other via `ensemble` and communicate via `cue`.

```bash
claude-tempo conduct                # default ensemble
claude-tempo conduct my-project     # named ensemble
```

### External access

The conductor's Temporal workflow exposes a signal/query API:

```typescript
import { Client } from '@temporalio/client';

const client = new Client();
const conductor = client.workflow.getHandle('claude-session-default-conductor');

// Send a command
await conductor.signal('command', {
  text: 'recruit /repos/api and run tests',
  source: 'cli',
});

// Check history
const history = await conductor.query('history');
```

Connect external channel plugins (e.g., Discord):

```bash
CLAUDE_TEMPO_CONDUCTOR=true claude \
  --channels plugin:discord@claude-plugins-official \
  --dangerously-skip-permissions --dangerously-load-development-channels server:claude-tempo
```

## Players

### Starting players

```bash
# Terminal 1 — conductor
claude-tempo conduct my-project

# Terminal 2 — frontend
claude-tempo start my-project -n frontend

# Terminal 3 — backend
claude-tempo start my-project -n backend
```

Or let the conductor `recruit` players — this spawns new terminal windows automatically.

Inside a session, try:
- "Show me the ensemble" — discovers other sessions
- "Set your name to 'frontend'" — human-readable name
- "Cue frontend: what are you working on?" — sends a message

### Session naming

Sessions start with a random 8-character hex ID. Set a name at launch with `-n` or use `set_name` inside a session.

- Names are stored as Temporal search attributes (`ClaudeTempoPlayerId`)
- Other players use names to send messages via `cue`
- `recruit` automatically tells new sessions to set their name
- Names must be unique within an ensemble
- Names must contain only letters, numbers, hyphens, and underscores

### Terminal support

`recruit` and the CLI detect your terminal automatically:

| Terminal | macOS | Linux | Windows |
|----------|-------|-------|---------|
| Ghostty | ✓ | — | — |
| iTerm2 | ✓ | — | — |
| Terminal.app | ✓ | — | — |
| gnome-terminal | — | ✓ | — |
| konsole / xterm | — | ✓ | — |
| cmd.exe / PowerShell | — | — | ✓ |

macOS terminals preserve the full shell environment (fish, zsh, bash) including node version managers (fnm, nvm).

## Configuration

Run `claude-tempo config` to save Temporal connection settings so you don't need flags or env vars every time:

```
$ claude-tempo config

? Temporal address (localhost:7233): my-ns.tmprl.cloud:7233
? Temporal namespace (default): my-ns.abc123
? Auth method: (None / API key / mTLS)
? API key: ****
Saved to ~/.claude-tempo/config.json
✓ Connected successfully
```

Settings are stored in `~/.claude-tempo/config.json`. You can also set values non-interactively:

```bash
claude-tempo config set temporalAddress my-ns.tmprl.cloud:7233
claude-tempo config set temporalNamespace my-ns.abc123
claude-tempo config set temporalApiKey tcl_...
claude-tempo config show
```

### Resolution order

Settings are resolved in this order (first match wins):

1. CLI flags (`--temporal-address`, `--temporal-namespace`, etc.)
2. Environment variables (`TEMPORAL_ADDRESS`, `TEMPORAL_NAMESPACE`, etc.)
3. claude-tempo config file (`~/.claude-tempo/config.json`)
4. Temporal CLI config (`~/.config/temporalio/temporal.yaml`) — if you've already configured the Temporal CLI, claude-tempo reads it automatically
5. Defaults (`localhost:7233`, `default` namespace)

### Temporal Cloud

For Temporal Cloud, run `claude-tempo config` and provide your cloud address, namespace, and API key. Or set them as environment variables in CI:

```bash
export TEMPORAL_ADDRESS=my-ns.abc123.tmprl.cloud:7233
export TEMPORAL_NAMESPACE=my-ns.abc123
export TEMPORAL_API_KEY=tcl_...
```

## Environment variables

| Variable | Default | Description |
|----------|---------|-------------|
| `TEMPORAL_ADDRESS` | `localhost:7233` | Temporal server address |
| `TEMPORAL_NAMESPACE` | `default` | Temporal namespace |
| `TEMPORAL_API_KEY` | *(none)* | Temporal Cloud API key |
| `TEMPORAL_TLS_CERT_PATH` | *(none)* | mTLS client certificate path |
| `TEMPORAL_TLS_KEY_PATH` | *(none)* | mTLS client key path |
| `CLAUDE_TEMPO_TASK_QUEUE` | `claude-tempo` | Task queue name |
| `CLAUDE_TEMPO_ENSEMBLE` | `default` | Ensemble name |
| `CLAUDE_TEMPO_CONDUCTOR` | `false` | Enable conductor mode |
| `CLAUDE_TEMPO_PLAYER_NAME` | *(random hex)* | Player name on startup |

## Stale session cleanup

When a session crashes or closes without graceful shutdown, Temporal detects it automatically:

- If a message to a dead session remains undelivered for **3 minutes**, the workflow self-completes
- Before exiting, it notifies the conductor with the undelivered message so work can be reassigned
- Idle sessions with no pending messages remain running until the 24-hour timeout

No manual cleanup needed — `cue` a dead player and the system handles the rest.

## Copilot CLI integration (experimental)

> **Warning:** Copilot bridge support is experimental and subject to breaking changes.

GitHub Copilot CLI sessions can join an ensemble via the Copilot bridge. Bridge sessions are headless — they require a Claude conductor or custom Temporal client to receive work via `cue`.

<details>
<summary>Setup and usage</summary>

### Prerequisites

```bash
npm install @github/copilot-sdk    # optional dependency (~243MB)
```

Also requires [GitHub Copilot CLI](https://docs.github.com/en/copilot/github-copilot-in-the-cli) installed, authenticated, with an active subscription. Node 20+ required for Copilot features.

### Starting a Copilot player

The easiest way is via `recruit` from any active session:

> "Recruit a copilot session named 'copilot-dev' in /repos/my-project with agent copilot"

Or start the bridge directly:

```bash
CLAUDE_TEMPO_ENSEMBLE=default COPILOT_BRIDGE_NAME=copilot-dev npx ts-node src/copilot-bridge.ts
```

### How it works

1. Bridge spawns a Copilot CLI session via the SDK with claude-tempo as MCP server
2. MCP server registers the session as a Temporal workflow
3. Bridge polls for pending messages every 2 seconds
4. Messages are injected as prompts via `session.sendAndWait()`
5. The Copilot session can use all claude-tempo tools

### Copilot environment variables

| Variable | Default | Description |
|----------|---------|-------------|
| `COPILOT_BRIDGE_NAME` | *(none)* | Player name |
| `COPILOT_BRIDGE_MODEL` | *(Copilot default)* | Model override |
| `GITHUB_TOKEN` | *(logged-in user)* | GitHub auth token |

### Limitations

- No interactive access — bridge sessions only respond to cues
- 2-second polling latency (vs instant for Claude Code sessions)
- Must be spawned via the bridge to participate
- `@github/copilot-sdk` adds ~243MB to node_modules
- Node 20+ required (rest of claude-tempo works on Node 18+)

</details>

## Development

```bash
git clone https://github.com/vinceblank/claude-tempo.git
cd claude-tempo && npm install

npm run build        # compile TypeScript + pre-bundle workflows
npm test             # run tests
npm link             # link CLI for local testing
```

> **Important**: Run `npm run build` after changing workflow code (`src/workflows/`). The build pre-bundles workflows into `workflow-bundle.js` so all workers use identical code.

## Why Temporal?

- **Cross-machine** — Any session that can reach the Temporal server can join
- **Instant signaling** — Temporal signals deliver messages with no polling
- **Durable history** — Full audit trail in Temporal's event history
- **No custom infrastructure** — No broker, no database — just Temporal
- **Extensible** — The conductor's signal/query contract is a public API

## Known limitations

- **`recruit` requires manual acknowledgment** — Recruited sessions use `--dangerously-load-development-channels`. Claude Code shows a confirmation prompt that must be manually acknowledged in the spawned terminal. This will be resolved once claude-tempo is published as an approved channel plugin. Copilot bridge sessions do not have this limitation.

## License

MIT
