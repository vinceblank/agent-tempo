# Configuration

## Interactive Setup

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

## Resolution Order

Settings are resolved in this order (first match wins):

1. CLI flags (`--temporal-address`, `--temporal-namespace`, etc.)
2. Environment variables (`TEMPORAL_ADDRESS`, `TEMPORAL_NAMESPACE`, etc.)
3. claude-tempo config file (`~/.claude-tempo/config.json`)
4. Temporal CLI config (`~/.config/temporalio/temporal.yaml`) — if you've already configured the Temporal CLI, claude-tempo reads it automatically
5. Defaults (`localhost:7233`, `default` namespace)

## Environment Variables

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
| `CLAUDE_TEMPO_DEFAULT_AGENT` | `claude` | Default agent type (`claude` or `copilot`) |

## Temporal Cloud

For Temporal Cloud, run `claude-tempo config` and provide your cloud address, namespace, and API key. Or set them as environment variables in CI:

```bash
export TEMPORAL_ADDRESS=my-ns.abc123.tmprl.cloud:7233
export TEMPORAL_NAMESPACE=my-ns.abc123
export TEMPORAL_API_KEY=tcl_...
```

## Related

- [cli.md](cli.md) — full list of CLI flags including `--temporal-address`, `--temporal-namespace`, etc.
- [daemon.md](daemon.md) — daemon configuration and log paths
