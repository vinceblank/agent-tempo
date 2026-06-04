# Configuration

## Interactive Setup

Run `agent-tempo config` to save Temporal connection settings so you don't need flags or env vars every time:

```
$ agent-tempo config

? Temporal address (localhost:7233): my-ns.tmprl.cloud:7233
? Temporal namespace (default): my-ns.abc123
? Auth method: (None / API key / mTLS)
? API key: ****
Saved to ~/.agent-tempo/config.json
✓ Connected successfully
```

Settings are stored in `~/.agent-tempo/config.json`. You can also set values non-interactively:

```bash
agent-tempo config set temporalAddress my-ns.tmprl.cloud:7233
agent-tempo config set temporalNamespace my-ns.abc123
agent-tempo config set temporalApiKey tcl_...
agent-tempo config set claude-bin /usr/local/bin/claude-nightly
agent-tempo config show
```

## Resolution Order

Settings are resolved in this order (first match wins):

1. CLI flags (`--temporal-address`, `--temporal-namespace`, etc.)
2. Environment variables (`TEMPORAL_ADDRESS`, `TEMPORAL_NAMESPACE`, etc.)
3. agent-tempo config file (`~/.agent-tempo/config.json`)
4. Temporal CLI config (`~/.config/temporalio/temporal.yaml`) — if you've already configured the Temporal CLI, agent-tempo reads it automatically
5. Defaults (`localhost:7233`, `default` namespace)

## Environment Variables

| Variable | Default | Description |
|----------|---------|-------------|
| `TEMPORAL_ADDRESS` | `localhost:7233` | Temporal server address |
| `TEMPORAL_NAMESPACE` | `default` | Temporal namespace |
| `TEMPORAL_API_KEY` | *(none)* | Temporal Cloud API key |
| `TEMPORAL_TLS_CERT_PATH` | *(none)* | mTLS client certificate path |
| `TEMPORAL_TLS_KEY_PATH` | *(none)* | mTLS client key path |
| `CLAUDE_TEMPO_TASK_QUEUE` | `agent-tempo` | Task queue name |
| `CLAUDE_TEMPO_ENSEMBLE` | `default` | Ensemble name |
| `CLAUDE_TEMPO_CONDUCTOR` | `false` | Enable conductor mode |
| `CLAUDE_TEMPO_PLAYER_NAME` | *(random hex)* | Player name on startup |
| `CLAUDE_TEMPO_DEFAULT_AGENT` | `claude` | Default agent type (`claude` or `copilot`) |
| `CLAUDE_TEMPO_CLAUDE_BIN` | *(auto-detected)* | Path to a custom `claude` executable. Takes precedence over the config file setting and `which`/`where` auto-detection. Useful when multiple Claude versions are installed or the binary is not on `PATH`. |
| `CLAUDE_TEMPO_DEV_MODE` | `false` | Enable dev profile (`1` or `true`). Flips home dir to `~/.agent-tempo-dev/`, HTTP port to 8474, Temporal namespace to `agent-tempo-dev`, task queue to `agent-tempo-dev`. Also enables the mock adapter (`agent: 'mock'`). Same effect as the `--dev` CLI flag. |

**Headless Pi adapter** (`agent: 'pi'`, requires `pi-ai` optional dependency on Node 22.19+):

| Variable | Default | Description |
|----------|---------|-------------|
| `AGENT_TEMPO_PI_MODEL` | *(Pi default)* | Pi provider/model selector (e.g. `anthropic/claude-opus-4-7`, `github-copilot/gpt-4o`). Absent → Pi's own default. `recruit` `model` arg takes precedence. |
| `AGENT_TEMPO_PI_CONTINUE_SESSION` | *(none)* | Pi conversation id to resume on restart (from `metadata.sessionId`). Set automatically by the daemon on restart. |
| `AGENT_TEMPO_TOOL_ACCESS` | `restricted` | Headless Pi MD-C tool-access policy. `restricted` (default) — Bash/shell/exec HARD-BLOCKED. `standard` — scoped Bash enabled. `full` — unsandboxed; requires `force: true` on recruit. Set by the daemon from the `toolAccess` recruit arg. |

**Dev-mode mock adapter** (requires `CLAUDE_TEMPO_DEV_MODE=1`):

| Variable | Default | Description |
|----------|---------|-------------|
| `CLAUDE_TEMPO_MOCK_MODE` | `echo` | Mock adapter mode: `echo`, `scripted`, `silent`, or `chaos`. |
| `CLAUDE_TEMPO_MOCK_SCENARIO` | *(none)* | Bare scenario name or absolute path to a YAML scenario file. Required when `mockMode: scripted`. |
| `CLAUDE_TEMPO_MOCK_CHAOS_DELAY_MS` | `0` | Fixed pre-reply delay in ms injected by chaos mode. |
| `CLAUDE_TEMPO_MOCK_CHAOS_FAIL_RATE` | `0.05` | Per-message probability (0–1) of throwing an error in chaos mode. |
| `CLAUDE_TEMPO_MOCK_CHAOS_CRASH_RATE` | `0.01` | Per-message probability (0–1) of `process.exit(1)` in chaos mode. |
| `CLAUDE_TEMPO_MOCK_CHAOS_SEED` | *(random)* | 32-bit integer seed for the chaos PRNG (mulberry32). Set for reproducible failure injection. |

## Custom Claude Executable

By default, agent-tempo auto-detects the `claude` binary using `which` (POSIX) or `where` (Windows). To use a different binary:

```bash
# Set via env var (takes highest precedence)
export CLAUDE_TEMPO_CLAUDE_BIN=/usr/local/bin/claude-nightly

# Or persist in config file
agent-tempo config set claude-bin /usr/local/bin/claude-nightly
```

**Resolution order:** `CLAUDE_TEMPO_CLAUDE_BIN` env var → config file → `which`/`where` → bare `claude` fallback.

Paths with spaces are handled correctly on both Windows and POSIX.

## Temporal Cloud

For Temporal Cloud, run `agent-tempo config` and provide your cloud address, namespace, and API key. Or set them as environment variables in CI:

```bash
export TEMPORAL_ADDRESS=my-ns.abc123.tmprl.cloud:7233
export TEMPORAL_NAMESPACE=my-ns.abc123
export TEMPORAL_API_KEY=tcl_...
```

## Related

- [cli.md](cli.md) — full list of CLI flags including `--temporal-address`, `--temporal-namespace`, etc.
- [daemon.md](daemon.md) — daemon configuration and log paths
- [dev-mode.md](dev-mode.md) — full dev-mode reference (mock adapter, scenario library, `--dev` flag)
