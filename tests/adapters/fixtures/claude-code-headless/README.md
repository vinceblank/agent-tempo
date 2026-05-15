# claude-code-headless adapter test fixtures

Captured during the §11 pre-impl spike for issue #520. See the spike-results comment on
[issue #520](https://github.com/vinceblank/agent-tempo/issues/520) for context.

| Fixture | Source | Notes |
|---|---|---|
| `success-simple.jsonl` | Real `claude -p --output-format stream-json --verbose` (v2.1.126), hook & status frames stripped | 4-frame canonical happy path: init, assistant, rate_limit_event, result/success. Used to drive `stream-json.ts` parser unit tests. |
| `tool-use-bash.jsonl` | Real `claude -p` (v2.1.126) with Bash tool call, hook & status frames stripped | 7 frames demonstrating assistant→tool_use→user/tool_result→assistant text loop. Adapter does NOT need to handle tool dispatch; Claude Code owns the loop, we just observe `result.result` for assembled text. |
| `hook-frames.jsonl` | **Synthesized** | 3 system frames the adapter must filter/ignore: `system/hook_started`, `system/hook_response`, `system/status`. Real captures emit these whenever the host has SessionStart hooks configured; their `output`/`stdout` fields can carry arbitrary user-specific content. |
| `api-retry-rate-limit.jsonl` | **Synthesized** per Anthropic's documented `system/api_retry` schema | Two-frame retry sequence; classifier should categorize as `retriable-immediate` (CLI handles backoff). |
| `api-retry-billing.jsonl` | **Synthesized** | Single frame; classifier should categorize as `fatal`. |
| `api-retry-auth.jsonl` | **Synthesized** | Single frame; classifier should categorize as `fatal`. |
| `auth-status-logged-in-subscription.json` | Real `claude auth status` from a Max-subscription host | JSON envelope; `loggedIn: true`, `authMethod: 'claude.ai'`. |
| `auth-status-logged-in-api-token.json` | Synthesized (matches `claude auth setup-token` shape) | `authMethod: 'api-token'` — long-lived OAuth for CI. |
| `auth-status-logged-out.json` | Synthesized | `loggedIn: false`. |

## Sanitized fields

`auth-status-logged-in-subscription.json` and `success-simple.jsonl` had personal identifying
fields replaced before commit (email, orgId, session UUIDs, project paths). The
behavioral schemas are unchanged.

## Capture pattern

Spike captures used the **strict-isolation** pattern to prevent the spike subprocess
from auto-registering with the host's running agent-tempo ensemble:

```bash
env -u AGENT_TEMPO_PLAYER_NAME \
    -u AGENT_TEMPO_PLAYER_TYPE \
    -u AGENT_TEMPO_ENSEMBLE \
  claude -p \
    --strict-mcp-config \
    --mcp-config '{"mcpServers":{}}' \
    --output-format stream-json --verbose \
    --session-id <fresh-uuid> \
    "<prompt>"
```

This is also the production adapter's spawn shape (sans the env-strip — adapter strips
those env vars in code per design §3.6 env hygiene).
