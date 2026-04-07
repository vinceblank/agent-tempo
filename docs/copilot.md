# Copilot CLI Integration (Experimental)

> **Warning:** Copilot bridge support is experimental and subject to breaking changes.

GitHub Copilot CLI sessions can join an ensemble via the Copilot bridge. Bridge sessions are headless — they require a conductor or another player to receive work via `cue`.

## Prerequisites

- [GitHub Copilot CLI](https://docs.github.com/en/copilot/github-copilot-in-the-cli) installed and authenticated
- An active GitHub Copilot subscription
- Node.js 20+
- Install the Copilot SDK: `npm install @github/copilot-sdk`

## Starting Copilot Sessions

Use `--agent copilot` with any session-launching command:

```bash
claude-tempo start myband --agent copilot -n copilot-1      # start a player
claude-tempo conduct myband --agent copilot                  # start a conductor
claude-tempo up myband --agent copilot                       # full setup
```

Or recruit from within any active session:

> "Recruit a copilot session named 'copilot-dev' in /repos/my-project with agent copilot"

## Setting a Default Agent

To avoid passing `--agent copilot` every time:

```bash
claude-tempo config set default-agent copilot
```

Or via environment variable:

```bash
export CLAUDE_TEMPO_DEFAULT_AGENT=copilot
```

Resolution order: `--agent` flag → `CLAUDE_TEMPO_DEFAULT_AGENT` env → config file → `claude`.

## Model Override

Set `COPILOT_BRIDGE_MODEL` to use a specific model for Copilot sessions:

```bash
COPILOT_BRIDGE_MODEL=gpt-4o claude-tempo start myband --agent copilot
```

## Limitations

- Headless only — bridge sessions respond to cues, no interactive terminal
- ~2-second polling latency (vs instant for Claude Code sessions)
- `@github/copilot-sdk` adds ~243MB to node_modules
- Node 20+ required (rest of claude-tempo works on Node 18+)

## Related

- [configuration.md](configuration.md) — `CLAUDE_TEMPO_DEFAULT_AGENT` and other env vars
- [cli.md](cli.md) — `--agent` flag reference
