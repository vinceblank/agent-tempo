# opencode adapter

Headless multi-provider LLM adapter — drives [SST OpenCode](https://opencode.ai) as a local subprocess. Selected via `recruit({ agent: 'opencode', model: 'provider/name' })`.

- Class: `OpenCodeAttachment extends SdkAttachment` — pull-based delivery, blocks on LLM turn, `processingStart`/`End` paired by base class.
- LLM transport: HTTP/SSE via `opencode serve` subprocess (probed-free port, hardcoded `--hostname 127.0.0.1`).
- Tool bridging: **MCP-native** — OpenCode spawns `dist/server.js` as its own stdio MCP child via the `OPENCODE_CONFIG_CONTENT` env. No in-process MCP bridge / no schema translation layer.
- Session state: server-side persisted by OpenCode. Adapter sends only the new turn's parts; session id stashed on workflow metadata via the existing `sessionId` field on `updateMetadata`.

Design: [`docs/design/449-opencode-adapter.md`](../../../docs/design/449-opencode-adapter.md). ADR locked at [`docs/adr/0015-opencode-adapter.md`](../../../docs/adr/0015-opencode-adapter.md).

## Operator setup

```bash
# 1. Install the OpenCode binary (multi-platform; provides `opencode serve`)
npm install -g opencode-ai

# 2. Install the OpenCode SDK as the optional-dep gate
npm install @opencode-ai/sdk

# 3. Set provider auth — the adapter auto-detects from the `model`'s prefix
export ANTHROPIC_API_KEY=sk-...     # for `model: 'anthropic/claude-opus-4-7'`
export OPENAI_API_KEY=sk-...        # for `model: 'openai/gpt-4o'`
# (or rely on AWS / GCP / OAuth env chains for bedrock / vertex / github-copilot)

# 4. Recruit
claude-tempo recruit my-player --agent opencode --model anthropic/claude-opus-4-7
```

## Q6 — session persistence across `opencode serve` restart

**Path A (re-attach to stashed session id) is implemented.**

OpenCode persists session history server-side. The adapter stashes the session id on workflow metadata at create time via `updateMetadataSignal`'s existing `sessionId` field (same field copilot uses), so a workflow restart with a still-running `opencode serve` reattaches to the same session id and OpenCode continues appending to the existing history.

If the impl-time experiment had shown OpenCode does NOT persist sessions across server restart (Path B), the `invokeSdkWithBatch` first-turn branch would walk `allMessagesQuery` + `allSentMessagesQuery` and rebuild the conversation as `parts` on the new session — same shape as `claude-api`'s `buildAnthropicMessages`. ~80 LoC delta. Path A was selected because it is simpler and forward-compatible.

## Files

- [`adapter.ts`](./adapter.ts) — `OpenCodeAttachment` class + self-exec entry point
- [`server-bridge.ts`](./server-bridge.ts) — HTTP/SSE client over raw `fetch` (5 endpoints + `/event` SSE generator)
- [`config.ts`](./config.ts) — `OPENCODE_CONFIG_CONTENT` synthesis + provider env detection
- [`helpers.ts`](./helpers.ts) — `probeFreePort`, `waitForExit`, `redactSecrets`, `isVersionMatch`
- [`index.ts`](./index.ts) — barrel re-export

## Cancellation chain

Lease revocation → `onSuperseded()`:

1. Abort the in-flight SSE consumer / `prompt_async` fetch via `inFlightAbortController`
2. Fire-and-forget `POST /session/:id/abort` (graceful — OpenCode releases the turn)
3. `processingEnd` fires in the inherited `finally` per `SdkAttachment.deliver()`

Graceful detach (terminal callback / SIGTERM / SIGINT):

1. `POST /session/:id/abort` → `DELETE /session/:id` (best-effort cleanup)
2. `detachGracefully('user-stop')` → fires `adapterExited`
3. SIGTERM the `opencode serve` subprocess; SIGKILL after 5s if it doesn't exit (Windows-safe — Bun-runtime SIGTERM on Windows is unreliable per ADR 0015 §84, escalation handles it)

## PID file

Two-line file at `logs/{playerId}.pid`:

```
12345         # adapter PID
67890         # opencode serve subprocess PID
```

Operators can grep / `kill -9` either independently. Cleaned up on graceful shutdown; daemon `reconcile-on-boot` validates against `process.kill(pid, 0)` for orphan detection.

## Telemetry

Per-turn stderr log line:

```
[agent-tempo:opencode] turn-usage provider=anthropic model=anthropic/claude-opus-4-7 input=1234 output=567 cache_read=8910 elapsed_ms=4321 player=my-player stop_reason=end_turn
```

Same shape family as claude-api's `[agent-tempo:claude-api] turn-usage` — operators already grep `turn-usage` for cost monitoring. Provider attribution is added (`provider=...`) since opencode is multi-provider.

Per-provider semantics differ — Anthropic exposes `cache_read` / `cache_creation`, OpenAI doesn't. The adapter logs whatever's present; cross-provider normalization is a Phase 2 candidate.

## Version drift

The adapter probes `GET /global/health` on boot and logs:

```
[agent-tempo:opencode] WARNING: opencode version 1.15.0 drift from tested ~1.14.29
```

…when the running OpenCode major.minor diverges from the tested-pinned `~1.14.29`. **Warn-only** — refusing on every minor bump would brick users given OpenCode's daily release cadence (ADR 0015 §52, §65).

## Phase 2 forward-work hooks

See [`docs/adr/0015-opencode-adapter.md`](../../../docs/adr/0015-opencode-adapter.md#forward-looking-notes) for the full list:

- Cross-provider tool parity testing
- Subprocess-shared `opencode serve` (memory optimization)
- `type: "remote"` MCP transport
- Per-provider quota awareness
- Reconnect opt-in (server-side persistence makes this attractive)
- Advisor strategy (executor + advisor on different providers, both via opencode)
