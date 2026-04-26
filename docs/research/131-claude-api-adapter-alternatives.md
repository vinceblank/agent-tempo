# Headless Claude API Adapter — Issue #131 Phase A research

- **Author**: tempo-researcher (claude-tempo[bot] ensemble)
- **Date**: 2026-04-26
- **Status**: Phase A (research) — feeds tempo-architect's Phase B (design + ADR)
- **Tracking issue**: #131 (Phase 1 only — advisor strategy is deferred to a future Phase 2 issue)
- **Phase B output (when available)**: ADR + design doc authored by tempo-architect

---

## 1. Anthropic SDK landscape + version recommendation

- **`@anthropic-ai/sdk` v0.91.1** (released 2026-04-24) is current. Stainless-generated, ~weekly cadence, and breaking changes can ship under SemVer minor per the project's policy. Requires Node 20+ / TS 4.9+. **Pin `~0.91.1` (tilde, not caret)** so a minor bump doesn't surprise CI.
- **Streaming** — `messages.create({ stream: true })` returns a pure `AsyncIterable<MessageStreamEvent>`; events arrive in this order for a tool-using turn: `message_start` → (`content_block_start text` → N× `content_block_delta {text_delta}` → `content_block_stop`) → (`content_block_start tool_use` → N× `content_block_delta {input_json_delta}` → `content_block_stop`) → `message_delta` (`stop_reason` + cumulative `usage`) → `message_stop`. The SDK also exposes `messages.stream(...).on(...)` + `.finalMessage()` (EventEmitter convenience). **Use the AsyncIterable form** for the adapter loop — lower memory, full event visibility for phase tracking. Reserve the EventEmitter for non-tool one-shots.
- **Tool loop** — assistant turn with `tool_use` blocks → user turn with one `tool_result` per `tool_use_id` → repeat until `stop_reason === 'end_turn'`. The SDK ships `client.beta.messages.toolRunner` (Zod-validated convenience) — **don't use it inside our adapter**: we need lifecycle hooks, telemetry, and approval gates around tool execution, and the runner fights us.
- **Tokens + cost** — every response carries `usage.{input_tokens, output_tokens, cache_creation_input_tokens, cache_read_input_tokens}`. No first-class cost computation in SDK; maintain a price table keyed by model id.
- **Auth + retry** — `ANTHROPIC_API_KEY` env var auto-detected. Defaults: `maxRetries: 2`, exponential backoff, respects `Retry-After`. Error hierarchy `Anthropic.APIError → {Authentication,RateLimit,InternalServer,APIConnection,…}Error`. **Disable SDK retry (`maxRetries: 0`) inside the tool-use loop** so we don't double-execute side-effecting tools on retry; keep the default for stateless calls.
- **Prompt caching** — `cache_control: { type: 'ephemeral' }` (5-min default; `'1h'` available). Min cacheable prefix is 4096 tokens on Opus 4.7. Cache is strict-prefix — any byte change in `tools` → `system` → `messages` invalidates everything after. **Default ON** for the adapter — system prompt + tool definitions are stable, conversation grows append-only.
- **Context window** — Opus 4.7 / Sonnet 4.6 both 1M tokens; Haiku 4.5 200K. Overflow returns `stop_reason: 'model_context_window_exceeded'` (distinct from `'max_tokens'`). Server-side compaction (beta `compact-2026-01-12`) auto-summarizes near the window — dovetails with #334 saveable-state.

## 2. Existing adapter pattern audit

The codebase already has two classes per the registry: `interactive` (push-delivery, no LLM block — Claude Code CLI) and `sdk` (pull-delivery, blocks on LLM turn — Copilot). **The Claude API adapter is unambiguously `sdk`** — `messages.create` blocks on the model roundtrip.

**`SdkAttachment` (`src/adapters/sdk/base.ts`) gives us for free**:
- `deliver(pinned, msg, prompt, timeoutMs, invokeSdk, ackIds?)` — wraps each turn in `processingStart` (synchronous update) → `invokeSdk` → `processingEnd` (in `finally`) → `markDelivered`. We just supply `invokeSdk`.
- `onSuperseded()` hook called when the phase watcher detects lease revocation; `sdkInFlight` flag for cancellation targeting.
- `startV2Lifecycle(workflowId)` from `BaseAttachment`: claim attachment, start heartbeat (30 s per descriptor), phase watcher, `WorkflowNotFound` handling, `runId` pinning (no zombie resurrection).
- `detachGracefully()` for clean shutdown via `adapterExited`.
- Auto-reconnect for `'continued-as-new'` (#226) handled in base.

**`CopilotSdkAttachment` is the closest precedent** — read it for: `pinnedRunId` pattern, `activeSession` stash for cancellation, dual-purpose entry point (class export + `require.main === module` self-exec), env-var contract (`CLAUDE_TEMPO_ENSEMBLE`, `CLAUDE_TEMPO_PLAYER_NAME`, etc.), unbuffered stderr logging.

**What we override for `claude-api`**:
- `invokeSdk(prompt, timeoutMs)` — wraps `messages.create({ stream: true })`, runs the tool-use loop, returns the final assembled assistant message.
- `onSuperseded()` — `abortController.abort()` on the in-flight `messages.create`. The SDK respects `AbortSignal` cleanly.
- `descriptor` — `{ adapterId: 'claude-api', adapterClass: 'sdk', blocksOnLLMTurn: true, heartbeatMs: 30_000 }`.
- `shouldReconnect()` — per the README, SDK adapters generally do NOT opt in. The Claude API adapter can rebuild conversation from workflow `messages` on respawn, so **don't opt in**; let lease loss exit the process cleanly.

## 3. Tool bridging design space

The hard problem of Phase B. Two core options:

**Option A — Adapter-as-MCP-client.** Reuse the existing `src/server.ts` MCP setup: spawn the MCP server in-process (or stdio-piped subprocess), have the adapter speak MCP. List MCP tools on session start → marshal into Messages API `tools` array. On `tool_use` content block, route to `mcpClient.callTool()`. Marshal `tool_result` back into the next user turn. **Preserves the MCP abstraction** — the adapter is "an MCP client wrapping the Messages API."

**Option B — Adapter calls tool implementations directly.** Bypass MCP, instantiate `src/tools/*` registrations against an in-memory shim. Simpler, lower latency, but breaks the MCP boundary and forces every new tempo tool to know about both surfaces.

**Lean: Option A.** Preserves a single source of truth for tool surface; new tempo tools work in claude-api adapter automatically.

**Tools that don't translate cleanly**:
- File-op tools (`Bash`, `Read`, `Write`, `Edit`, `Glob`, `Grep`) — Claude Code provides these as built-ins; they are NOT in our MCP surface. The Claude API adapter has three options: (a) implement them in the adapter directly, (b) use Anthropic's server-side `bash_20250124` + `text_editor_20250124` built-in tools (still requires adapter-side execution loop), (c) ship Phase 1 with **MCP-tools-only** scope and document the constraint. **Lean: (c) for v1**, defer file-op coverage to a follow-up. Phase 1's stated scope ("scheduled work, server-side automation, Phase 2 advisor precursor") doesn't critically depend on file ops.
- `recruit` from inside a Claude API adapter — works fine, the new player's adapter type is independent.

## 4. Streaming + state design space

- **Conversation state is rebuilt every turn from workflow `messages[]`.** The Messages API is stateless; the workflow is durable. The adapter on each `deliver()` reads the cumulative message history (similar to restart's transcript replay), formats it as `[{role: 'user' | 'assistant', content: …}]`, and sends. Prompt caching makes this cheap (cached prefix on the stable head; only the tail is uncached).
- **`processingStart`/`End` granularity** — fire once per turn (one `deliver()` call), NOT per content block. The whole turn is one logical message-in-flight. `inFlightMessages` on the workflow already models this.
- **Per-turn `usage` telemetry** — propose a new optional field on `MarkDeliveredSignal` payload (or a separate `recordTurnUsage` signal — Phase B decides). Lets the conductor surface cost per session. *Phase B follow-up*.
- **Context overflow handling** — on `stop_reason: 'model_context_window_exceeded'`, two paths: (i) emit a system message into the workflow asking the user to `restart` or call `save_state` (#334), (ii) auto-compact via `save_state(server-side-compaction-summary) + restart({loadFromState: true})`. **Lean: (i) for v1**, (ii) requires #334 to land.
- **No coupling to the daemon SSE event source (#94/#95).** Different concern — that's TUI/web-dashboard-side. The adapter speaks MCP and Messages API only.

## 5. Spawn path considerations

- **Process model**: detached Node subprocess, same pattern as Copilot bridge (`node dist/adapters/claude-api/adapter.js`). NOT in-daemon — adapter lifecycle must be independently destroyable + restartable; embedding in the daemon would couple cleanup.
- **Recruit surface change** (`src/tools/recruit.ts`): extend the `agent` enum from `z.enum(['claude', 'copilot'])` to `z.enum(['claude', 'copilot', 'claude-api'])`. Extend `AgentType` in `src/types.ts`. Extend `AdapterRegistry.resolveFromAgentType` in `src/adapters/base.ts:1354+` with the new mapping.
- **Env vars passed by spawner**: `CLAUDE_TEMPO_ENSEMBLE`, `CLAUDE_TEMPO_PLAYER_NAME`, `CLAUDE_TEMPO_TEMPORAL_ADDRESS`, `CLAUDE_TEMPO_TEMPORAL_NAMESPACE`, plus new `ANTHROPIC_API_KEY`, optional `CLAUDE_TEMPO_API_MODEL` (default `claude-opus-4-7-20250115` or whatever the locked latest at impl time).
- **Pre-flight**: before submitting the recruit outbox entry, verify `ANTHROPIC_API_KEY` is set (cheap fail-fast — same pattern as Copilot's `@github/copilot-sdk` install check).
- **Optional dep on `@anthropic-ai/sdk`** — match Copilot's `optionalDependencies` pattern in `package.json` so users not running claude-api don't pay the install cost. Adapter code uses `require()` with a graceful "not installed" message gated on `require.main === module`.

## 6. Alternatives evaluated

| Alternative | Verdict | Why |
|---|---|---|
| **Vercel AI SDK (`@ai-sdk/anthropic`)** | Reject | Higher-level abstraction over the same Messages API; we already own the loop and event model. Unnecessary indirection that hides the events `processingStart/End` needs. |
| **Raw HTTP (no SDK)** | Reject | SDK provides retry, error hierarchy, AsyncIterable streaming, and AbortController wiring for free. SDK exposes `client.post()` / `.asResponse()` escape hatches if needed. |
| **`@anthropic-ai/bedrock-sdk` / `vertex-sdk`** | Out of scope | Not direct API; users wanting Bedrock/Vertex can file follow-ups. |
| **Extend `claude-code` adapter to support API-direct mode** | Reject | Conflates `interactive` vs `sdk` delivery models; muddles the abstraction the registry is built around. |
| **Use Claude Code CLI as a subprocess (`claude --headless`)** | Reject | That's just the existing claude-code adapter. Phase 1's whole point is to escape CLI/TTY constraints. |
| **Tool execution via Anthropic server-side `bash` / `text_editor` tools** | Defer to v2 | These are still adapter-executed (Anthropic just defines the tool schema). Worth investigating once Phase 1 ships and we have signal on tool needs. |
| **Adapter-calls-tools-directly (bypass MCP)** | Reject | Breaks the MCP-as-source-of-truth invariant. Two surfaces every new tool must know about. |

## 7. Open questions for architect's Phase B

1. **Tool surface for v1**: MCP-tools-only (lean: yes) or include file ops via Anthropic server-side bash/text_editor? Document the constraint clearly in the recruit tool description.
2. **MCP-client transport**: in-process vs subprocess MCP server? The existing `src/server.ts` is built for stdio — does in-process work, or do we run a sidecar?
3. **Per-turn usage telemetry**: new signal (`recordTurnUsage`) vs piggyback on `MarkDeliveredSignal` vs adapter-local-only?
4. **Model selection**: `recruit({ agent: 'claude-api', model: '…' })` per recruit, or `CLAUDE_TEMPO_API_MODEL` env default, or both? (Lean: both, with recruit-arg taking precedence.)
5. **Prompt cache opt-out**: expose `cache: false` per session, or always-on?
6. **Context overflow UX**: emit a workflow message ("you are at context limit; call `/save_state` then `/restart` ") vs auto-handle (depends on #334)?
7. **AgentType naming**: `'claude-api'` vs `'claude-direct'` vs `'claude-headless'`? (Lean: `'claude-api'` matches the issue title.)
8. **Cost cap**: should the adapter enforce a per-session token budget? (Lean: defer to follow-up; no cap in v1.)

## 8. Effort estimate

| Area | LoC range |
|---|---|
| `src/adapters/claude-api/adapter.ts` (`DirectApiAttachment extends SdkAttachment`) | 300–400 |
| `src/adapters/claude-api/index.ts` (descriptor + barrel) | 30 |
| Registry hook (`src/adapters/index.ts`, `src/adapters/base.ts`) | 15 |
| `src/tools/recruit.ts` agent-enum extension + preflight | 20 |
| `src/types.ts` `AgentType` extension | 5 |
| MCP-client glue (list_tools → API tools array; tool_use → callTool; tool_result → next turn) | 150–250 |
| `package.json` optional dep | 3 |
| Tests (vitest unit + mocha integration covering spawn → claim → turn → detach) | 250–350 |
| Docs (`src/adapters/README.md`, `docs/concepts.md`, `docs/tools.md`) | 50 |
| **Total** | **~825–1,125 LoC** |

The issue's 600–1000 estimate is on the low side if the MCP-client glue (the unknown unknown) bites. Recommend Phase B explicitly scope the tool bridge before locking the LoC budget.

## Sources

- [`@anthropic-ai/sdk` v0.91.1 on npm](https://www.npmjs.com/package/@anthropic-ai/sdk)
- [Anthropic TypeScript SDK GitHub](https://github.com/anthropics/anthropic-sdk-typescript)
- [Anthropic Messages API streaming docs](https://docs.anthropic.com/en/api/messages-streaming)
- [Anthropic Prompt Caching](https://docs.anthropic.com/en/docs/build-with-claude/prompt-caching)
- `src/adapters/sdk/base.ts` — `SdkAttachment` lifecycle contract
- `src/adapters/copilot/adapter.ts` — closest existing SDK-class precedent (`CopilotSdkAttachment`)
- `src/adapters/base.ts:1306+` — `AdapterRegistry`, `resolveFromAgentType`
- `src/adapters/README.md` — adapter contract + reconnect opt-in
- `src/tools/recruit.ts` — agent-enum surface + preflight pattern
- Issue #131 — Phase 1 scope + Phase 2 deferred questions
- Issues #318 / #319 / #334 — same Phase A/B/C cadence precedent
