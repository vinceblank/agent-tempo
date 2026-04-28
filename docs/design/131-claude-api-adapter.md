# Headless Claude API adapter — Phase 1 (no advisor)

> **Status**: Design proposal (spike — no implementation in this branch)
> **Author**: tempo-architect
> **Branch**: `design/131-claude-api-adapter`
> **Tracking**: issue #131 (Phase 1 only — advisor strategy deferred to a future Phase 2 issue)
> **Audience**: implementing engineer (eng-2 named as natural pickup), conductor for review.

---

## 0. TL;DR

Add a third adapter — `src/adapters/claude-api/` — that uses the Anthropic Messages API directly. New `DirectApiAttachment extends SdkAttachment` mirrors the Copilot bridge pattern: detached Node subprocess, `claimAttachment` + heartbeat + phase-watcher lifecycle inherited free, single override of `invokeSdk` for the LLM-turn loop.

The new adapter is selected via `recruit({ adapter: 'claude-api', ... })`. Tool bridging uses an **in-process MCP server + paired in-memory client** so every existing MCP tool (cue, report, recall, ensemble, broadcast, recruit, …) lights up automatically — no per-tool integration code, no second source of truth. **File-op tools** (`Bash`/`Read`/`Write`/`Edit`/`Glob`/`Grep`) are explicitly **out of scope for v1** — Phase 1's stated motivation (server-side automation, scheduled work, advisor precursor) doesn't depend on them; deferred to a Phase 2 follow-up.

**Locked decisions on the 8 open questions** (researcher's directional leans validated and tightened):

| Q | Decision |
|---|---|
| 1. Tool surface scope | **MCP-tools-only in v1**. File ops deferred to Phase 2. Document the limitation in `recruit`'s tool description and `src/adapters/README.md`. |
| 2. MCP transport | **In-process MCP server + `InMemoryTransport` paired client**. Avoids subprocess; preserves the abstraction. |
| 3. Per-turn usage telemetry | **Structured stderr log line** in v1 (`[claude-tempo:claude-api] turn-usage …`). Wire-protocol signal deferred until a consumer (cost dashboard / per-session cap) lands. |
| 4. Model selection | **Recruit-arg precedence** → `CLAUDE_TEMPO_API_MODEL` env → constants-pinned default (`claude-opus-4-7` at impl time; reviewable at the next minor bump). |
| 5. Prompt cache opt-out | **Always-on in v1**, no flag. The cache is strict-prefix; cost of re-validation is trivial. |
| 6. Context-overflow UX | **Emit workflow message** ("context window exhausted; recommend `save_state(...)` then `restart({ loadFromState: true })`"). Auto-compact via #334 deferred to Phase 2. |
| 7. AgentType naming | **`'claude-api'`**. Matches issue title; pairs with existing `'claude'` (CLI) and `'copilot'` cleanly. |
| 8. Cost cap | **No cap in v1**. Stderr usage logs surface burn rate. Cap policy (refuse vs warn vs graceful shutdown) is a separate UX problem; gather data first. |

**Wire surface**: zero new signals/queries/updates on `claudeSessionWorkflow`. Strictly additive on `recruit`'s tool schema (`adapter` + optional `model` arg) and `AgentType` (`'claude' | 'copilot' | 'claude-api'`). `AdapterRegistry.resolveFromAgentType` extended one line.

**Estimated implementation cost**: ~825–1,125 LoC per researcher's refined estimate (issue's 600–1,000 was light if the MCP-client glue bites). Single PR, additive, no breaking changes.

**Phase 2 explicitly out of scope** — advisor strategy, file-op tools, server-side `bash_20250124` / `text_editor_20250124` integration, cost caps, usage aggregation. All listed in §11 as forward-work hooks.

---

## Verification addendum (2026-04-28)

> Surfaced during pre-Phase-C verification spike — see also [`docs/research/131-claude-api-adapter-spike-verify.md`](../research/131-claude-api-adapter-spike-verify.md).
>
> Five impl-time landmines that this design doesn't surface but the implementing engineer must handle. The locked decisions in §0 above are unchanged; these notes adjust the worked skeleton (§8) and clarify operational behaviour against the mid-2026 Anthropic Messages API state.

1. **Model id** — use `'claude-opus-4-7'` (no date suffix) as the constants-pinned default. Anthropic dropped the `-YYYYMMDD` suffix convention in 2026 for direct-API model ids; the GA announcement (2026-04-16) ships the model as plain `claude-opus-4-7`. The `recruit.model` regex `^claude-[a-z0-9-]+$` already permits both forms — no schema change needed.

2. **Opus 4.7 parameter rejections** — do NOT pass `temperature`, `top_p`, `top_k`, or `thinking.budget_tokens` to `messages.create()` on Opus 4.7; each returns 400 `invalid_request_error`. Use `thinking: { type: 'adaptive' }` only — Opus 4.7 is adaptive-thinking-only (the legacy `{type: 'enabled', budget_tokens: N}` shape was removed). Default `thinking.display` is `'omitted'` — empty `thinking_delta` events stream by default. If the adapter ever wants reasoning visible in stderr telemetry, set `thinking: { type: 'adaptive', display: 'summarized' }`. (v1's stderr-log shape doesn't surface reasoning, so this is forward-friendliness only.)

3. **Adaptive thinking + tool use interleaving** — when pushing the assistant turn back into `messages` for the next iteration of the tool-use loop, include `thinking` content blocks (with their `signature`) verbatim alongside `tool_use`. As of mid-2026 adaptive thinking auto-interleaves between tool calls (what was previously gated behind `interleaved-thinking-2025-05-14` is now baseline on Opus 4.7 / Sonnet 4.6); stripping `thinking` blocks breaks reasoning continuity and may 400. The §8 skeleton's line `messages.push({ role: 'assistant', content: /* tool_use blocks */ })` should read `messages.push({ role: 'assistant', content: assistantMessage.content })` — push the full assistant content array, not just the tool_use subset.

4. **`input_json_delta` partials** — accumulate `partial_json` strings; do NOT `JSON.parse` until `content_block_stop` fires for the tool_use block. The model streams tool-call arguments as fragmentary string chunks (`{"loc`, `ation":"Pa`, `ris"}`); intermediate states are not parseable JSON. The Anthropic SDK's `MessageStream.on('inputJson', …)` event handles this; manual async-iteration over `MessageStreamEvent` requires the engineer to do it themselves.

5. **Mid-stream error events** — wrap the streaming `for await` loop in `try { … } catch { … }`. The SDK throws `Anthropic.APIError` (or a subclass — typically `OverloadedError` for 529 mid-generation, `APIError` for 500 api_error) from the iterator when Anthropic emits an SSE `error` event mid-flight. On throw, fail the turn cleanly — `processingEnd` fires in the inherited `finally` per `SdkAttachment.deliver()` (§6.1), and the workflow's outbox retry on next deliver re-attempts the turn. No turn-level retry inside the adapter for v1.

**Cache breakpoint budget** — separate from the five landmines, two prompt-caching facts to keep in mind: max **4** `cache_control` breakpoints per request (we use 2 — system + tools — leaving 2 spare for any Phase 2 conversation-segment caching), and the minimum cacheable prefix is **4096 tokens** on Opus 4.7 / Haiku 4.5 but **2048 tokens** on Sonnet 4.6 (our default model is Opus 4.7, so 4096 is operationally correct for v1; only relevant if a recruit-arg switches the player to Sonnet 4.6).

The §0 locked decisions are unchanged. Proceed against the design as-written, applying these notes at impl time.

---

## 1. Why now

Issue #131 motivates the headless adapter on four orthogonal value props, all already painful with the CLI-wrapper adapters:

1. **TTY-free / process-free** — current `claude-code` adapter requires an interactive terminal (Ghostty, iTerm2, Windows Terminal, …) and a manual dev-channels prompt bypass on first launch. Cloud / CI / scheduled-work environments don't have a terminal.
2. **Server-side automation** — scheduled players (cron-driven cues), CI test-loop players, headless review pipelines all benefit from a non-interactive adapter.
3. **Advisor strategy precursor** — Anthropic's executor/advisor pattern (deferred to Phase 2 per issue) needs API-direct access to switch models per turn. Phase 1 lays the foundation.
4. **Cleaner cost monitoring** — `messages.create` returns per-turn `usage` directly; no parsing of CLI output, no token-counting workarounds.

The new adapter is **independent** of #318 (coat-check), #319 (protobuf), #334 (saveable-state), and the SSE event source (#94/#95). It composes naturally with #334 in v2 (auto-compact on context overflow) but doesn't require it for v1.

Phase A research (PR #339, `docs/research/131-claude-api-adapter-alternatives.md`) validated:

- Anthropic SDK pin `~0.91.1` (Stainless cadence; minor bumps may include breaking changes — tilde, not caret)
- AsyncIterable streaming for adapter loop
- Manual tool-use loop (NOT `client.beta.messages.toolRunner`)
- SDK retry **disabled** inside tool-use loop (avoid double-execution of side-effecting tools)
- Prompt caching default ON; minimum 4096-token prefix on Opus 4.7
- 1M context window on Opus 4.7 / Sonnet 4.6; 200K on Haiku 4.5
- `SdkAttachment` covers ~80% of the lifecycle wiring out of the box

This document locks the design; the research doc records the evidence.

---

## 2. Existing adapter precedents

The new adapter slots into the existing 2-class registry (`docs/design/session-lifecycle-rebuild-v2.md` §4.1):

| Class | Delivery model | Existing adapters | Base class |
|---|---|---|---|
| `interactive` | push (no LLM block) | `claude-code` | `BaseAttachment` |
| `sdk` | pull (blocks on LLM turn; pairs `processingStart` / `processingEnd`) | `copilot`, **`claude-api` (new)** | `SdkAttachment` |

The Claude API adapter is unambiguously **`sdk`** — `messages.create` blocks on the model roundtrip, and we need the synchronous `processingStart` / `processingEnd` pairing that `SdkAttachment.deliver()` provides.

**`SdkAttachment` (`src/adapters/sdk/base.ts`) gives us free**:

- `deliver(pinned, msg, prompt, timeoutMs, invokeSdk, ackIds?)` — wraps each turn in `processingStart` (synchronous update) → `invokeSdk` → `processingEnd` (in `finally`) → `markDelivered`.
- `onSuperseded()` hook called when the phase watcher detects lease revocation; `sdkInFlight` flag for cancellation targeting.
- `startV2Lifecycle(workflowId)` from `BaseAttachment`: claim attachment, start heartbeat (30 s per descriptor), phase watcher, `WorkflowNotFound` handling, `runId` pinning (no zombie resurrection).
- `detachGracefully()` for clean shutdown via `adapterExited`.
- Auto-reconnect for `'continued-as-new'` (#226) handled in base.

**`CopilotSdkAttachment` (`src/adapters/copilot/adapter.ts`) is the closest precedent** — read it for: `pinnedRunId` pattern, `activeSession` stash for cancellation, dual-purpose entry point (class export + `require.main === module` self-exec), env-var contract, unbuffered stderr logging.

**What `DirectApiAttachment` overrides**:

- `invokeSdk(prompt, timeoutMs)` — wraps `messages.create({ stream: true })`, runs the manual tool-use loop, returns the final assembled assistant text.
- `onSuperseded()` — `abortController.abort()` on the in-flight `messages.create`.
- `descriptor` — `{ adapterId: 'claude-api', adapterClass: 'sdk', blocksOnLLMTurn: true, heartbeatMs: 30_000 }`.
- `shouldReconnect()` — **NOT** opted in. Per `src/adapters/README.md`: SDK adapters generally don't opt in. Lease loss exits cleanly; the daemon's reconcile-on-boot path can recover via restart.

---

## 3. Spawn integration

### 3.1 `recruit` tool surface

Extends the existing recruit Zod schema additively:

```ts
// src/tools/recruit.ts — additive on the existing schema
{
  // ... existing fields ...
  adapter: z.enum(['claude', 'copilot', 'claude-api']).optional()
    .describe(`Which adapter to use (default: "${ownAgentType}", same as this session). "claude-api" runs headless via the Anthropic Messages API; requires ANTHROPIC_API_KEY env var.`),
  // NEW — only meaningful for adapter='claude-api'
  model: z.string().optional()
    .describe('Model id for claude-api adapter (e.g. "claude-opus-4-7"). Falls back to CLAUDE_TEMPO_API_MODEL env, then a constants-pinned default. Ignored for claude / copilot adapters.'),
}
```

The existing `agent` field remains supported (it's the legacy short-form: `'claude'` → CLI, `'copilot'` → Copilot CLI, plus new `'claude-api'`). Extending the Zod enum to three values is the smallest possible surface change.

### 3.2 `AgentType` extension

```ts
// src/types.ts
export type AgentType = 'claude' | 'copilot' | 'claude-api';
```

The existing `'claude'` value continues to mean Claude Code CLI — **no rename**. Adding `'claude-api'` is strictly additive; old code that handles `claude | copilot` falls through to a default branch for `claude-api`, and the test suite catches any unhandled-case regressions.

### 3.3 `AdapterRegistry.resolveFromAgentType` extension

```ts
// src/adapters/base.ts:1354 — one-line extension
resolveFromAgentType(agent: string | undefined): string {
  if (agent === 'copilot') return 'copilot';
  if (agent === 'claude-api') return 'claude-api';   // NEW
  return 'claude-code';
}
```

### 3.4 Pre-flight checks in `recruit`

Before submitting the recruit outbox entry, validate:

1. `adapter === 'claude-api'` → `ANTHROPIC_API_KEY` env var is set on the **target** host. Cross-host recruit (`host:` param) needs the daemon there to advertise this in `hostProfile`. Mirrors Copilot's pre-flight pattern.
2. `model` arg, if present, matches `^claude-[a-z0-9-]+$` — cheap regex sanity check; the SDK rejects bad ids at runtime anyway.
3. The `@anthropic-ai/sdk` package is installed (optional dep — see §3.5). Pre-flight tries `require.resolve('@anthropic-ai/sdk')` and rejects with an actionable error if missing.

The existing `daemon hostProfile` advertisement (`availableAgentTypes`) is extended by one entry — the daemon includes `'claude-api'` only if both `ANTHROPIC_API_KEY` is set AND `@anthropic-ai/sdk` resolves at boot.

### 3.5 Optional dependency

`@anthropic-ai/sdk` joins `@github/copilot-sdk` as an `optionalDependency` in `package.json`:

```json
"optionalDependencies": {
  "@github/copilot-sdk": "...",
  "@anthropic-ai/sdk": "~0.91.1"
}
```

**Tilde, not caret** — Stainless ships breaking changes under SemVer minor per Anthropic's policy. A caret would auto-bump to `0.92.x` and silently break CI; tilde stays on the `0.91.x` line until a deliberate review.

The adapter `require()`s the SDK guarded by `require.main === module` so non-claude-api users never see the import error (mirrors Copilot adapter §1306+).

### 3.6 Spawn process model

Detached Node subprocess matching Copilot bridge:

```bash
# Spawned by deliverStartRecruitedSession activity:
node dist/adapters/claude-api/adapter.js
# (or `npx ts-node src/adapters/claude-api/adapter.ts` in dev)
```

Env var contract:

| Variable | Source | Purpose |
|---|---|---|
| `CLAUDE_TEMPO_ENSEMBLE` | spawner | Workflow-id derivation |
| `CLAUDE_TEMPO_PLAYER_NAME` | spawner | Workflow-id derivation; identity |
| `CLAUDE_TEMPO_TEMPORAL_ADDRESS` | spawner | Temporal connection |
| `CLAUDE_TEMPO_TEMPORAL_NAMESPACE` | spawner | Temporal connection |
| `ANTHROPIC_API_KEY` | operator | API auth (SDK auto-detects) |
| `CLAUDE_TEMPO_API_MODEL` | operator (optional) | Default model override; recruit `model` arg takes precedence |

No new shell-quoting concerns — the spawn path matches Copilot's, which is already cross-platform-tested.

---

## 4. Tool bridging — in-process MCP

The hard problem of Phase B. Researcher framed two options; locking Option A.

### 4.1 Locked: in-process MCP server + `InMemoryTransport`

The MCP TS SDK ships `InMemoryTransport.createLinkedPair()` — a paired client/server transport that works in-process with no network or stdio. The adapter:

1. Boots an MCP **`Server`** (same `McpServer` class `src/server.ts` uses) and registers all tempo tools onto it. Tool registrations live in `src/tools/*.ts` already; the adapter imports them.
2. Boots an MCP **`Client`** and connects it to the server via `InMemoryTransport.createLinkedPair()`.
3. Calls `client.listTools()` once at session start to populate the Anthropic Messages API `tools` array.
4. On every `tool_use` content block in a streaming response, calls `client.callTool({ name, arguments })` and feeds the result back as `tool_result` in the next user turn.

```ts
// src/adapters/claude-api/adapter.ts (sketch)
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';

const server = new McpServer({ name: 'claude-tempo', version: PACKAGE_VERSION });
registerEnsembleTool(server, ...);    // every tool from src/tools/*
registerCueTool(server, ...);
// ... full registrar bundle, identical to src/server.ts ...

const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
await server.connect(serverTransport);
const mcp = new Client({ name: 'claude-api-adapter', version: PACKAGE_VERSION });
await mcp.connect(clientTransport);
```

**Why in-process, not subprocess**:

- No second process to manage / lifecycle / clean up
- Zero stdio buffering edge cases
- Direct JS function calls under the hood
- Same MCP SDK boundary preserved — adding new tempo tools lights up automatically with no adapter change
- ~50 LoC of glue vs 200+ for a stdio sidecar

**Why MCP at all (vs tool-impls direct)**:

- MCP is the source of truth for tool schemas (Zod → JSON-schema for the Messages API `tools[]`)
- Future tools added to `src/tools/*` work in `claude-api` adapter automatically
- No drift between what `claude-code` players see and what `claude-api` players see

### 4.2 Tool list translation

MCP `Tool` shape → Messages API `Tool` shape:

```ts
// MCP tool (from list_tools response)
{ name: 'cue', description: '...', inputSchema: { type: 'object', properties: {...}, required: [...] } }

// Messages API tool input shape
{ name: 'cue', description: '...', input_schema: { type: 'object', properties: {...}, required: [...] } }
```

Field names are the same except `inputSchema` vs `input_schema`. Trivial mapping function (~10 LoC). Cache the translated list once per session (tools don't change mid-session for v1).

### 4.3 Tool call dispatch

```ts
// Inside the tool-use loop:
for (const block of assistantMessage.content) {
  if (block.type === 'tool_use') {
    const result = await mcp.callTool({ name: block.name, arguments: block.input as Record<string, unknown> });
    toolResults.push({
      type: 'tool_result',
      tool_use_id: block.id,
      content: result.content,        // MCP returns { content: [{type, text}] }; passes through
      is_error: result.isError ?? false,
    });
  }
}
// Next turn: messages.push({ role: 'user', content: toolResults });
```

### 4.4 Tool surface scope — locked v1

| Tool family | v1 scope | Rationale |
|---|---|---|
| **Tempo MCP tools** (cue, report, recall, ensemble, broadcast, recruit, set_part, set_name, who_am_i, schedule, …) | **In** | Source of truth via MCP; lights up automatically |
| **File ops** (Bash, Read, Write, Edit, Glob, Grep) | **Out** — Phase 2 | Phase 1's stated scope (server-side automation, advisor precursor) doesn't critically depend on them. Two paths in Phase 2: (a) implement directly in adapter, (b) bridge Anthropic server-side `bash_20250124` + `text_editor_20250124`. Defer the choice. |
| **WebSearch / WebFetch** | **Out** — Phase 2 | Same reasoning — not on Phase 1's critical path. |

**Document the constraint** in:
- `recruit`'s tool description: "claude-api players have access to claude-tempo MCP tools (cue, report, recall, …) but NOT file-edit or shell tools — use claude-code adapter for tasks requiring file ops."
- `src/adapters/README.md` — tool-availability matrix per adapter
- `docs/concepts.md` — adapter-comparison table

---

## 5. Streaming + state

### 5.1 Conversation state — rebuilt every turn from workflow

The Messages API is stateless; the workflow is durable. Per `deliver()`, the adapter:

1. Reads cumulative message history from the workflow via `allMessagesQuery` + `allSentMessagesQuery`.
2. Formats as `[{role: 'user' | 'assistant', content: ...}, ...]` — `from: 'maestro' | 'self' | <other-player>` maps to `'user'`; the player's own previous responses map to `'assistant'`.
3. Sends with `cache_control: { type: 'ephemeral' }` on the **last system content block** and the **last tool** in the `tools` array — the breakpoint marks where the cached prefix *ends*, so placing it on the last element caches the entire tools array + system prompt as one prefix block. The cached prefix amortizes cost; only the conversation tail is uncached.

This mirrors restart's transcript-replay framing (`src/activities/outbox.ts:687-709`) — same data source, different consumer.

### 5.2 Prompt caching strategy — locked: always-on

System prompt + tool definitions are stable per session → place under `cache_control: { type: 'ephemeral' }`. Conversation history grows append-only → cached prefix walks forward each turn (5-min TTL by default; SDK auto-handles invalidation).

**No per-recruit opt-out flag in v1**. Cache is strict-prefix; if the player wants a clean cache they can `restart` (which spawns a fresh session). One less knob.

### 5.3 Tool-use loop

```
turn:
  request: messages.create({ model, system, tools, messages, stream: true, max_tokens })
  consume AsyncIterable<MessageStreamEvent>:
    on text_delta → append to running assistant text (for final markDelivered output)
    on tool_use_block_start → start collecting tool_use input
    on input_json_delta → accumulate input json
    on content_block_stop (tool_use) → finalize tool_use block
    on message_delta → stop_reason + cumulative usage
    on message_stop → end of turn
  if any tool_use blocks:
    for each: dispatch to mcp.callTool, collect tool_result
    messages.push(assistant turn) + messages.push(user turn with tool_results)
    goto turn  // tool-use loop
  if stop_reason in ('end_turn', 'max_tokens'): exit
  if stop_reason === 'model_context_window_exceeded':
    deliver context-overflow message to workflow and exit (§5.5)
```

### 5.4 SDK retry — disabled inside the tool-use loop

```ts
const client = new Anthropic({
  apiKey: process.env.ANTHROPIC_API_KEY,
  maxRetries: 0,   // critical — tool calls are side-effecting
});
```

The SDK's default `maxRetries: 2` is fine for stateless calls but **must be disabled** for the tool-use loop. A retry would re-execute the previous turn's `tool_use` calls (cue / report / etc.) — duplicating side effects. Adapter handles retry policy at the turn level if needed (Phase 1: no turn-level retry; on hard failure, surface the error to the workflow and exit).

### 5.5 Context-overflow UX — locked: emit message

When `stop_reason === 'model_context_window_exceeded'`:

```ts
const overflowMessage = [
  '⚠️ **Context window exhausted.**',
  '',
  'The conversation has grown beyond this model\'s context. Recommended actions:',
  '1. `save_state(content: "<curated summary of where you are>")`',
  '2. `restart({ loadFromState: true })` — new session resumes from your saved state',
  '',
  'Alternatively, ask the conductor to recruit a fresh player and hand off via cue.',
].join('\n');
await pinned.signal(receiveMessageSignal, {
  from: 'system',
  text: overflowMessage,
  responseRequested: false,
});
return { sdkResult: { stopReason: 'context_overflow' }, elapsedMs };
```

The player sees the message on the next deliver cycle. Auto-compact via #334 is a Phase 2 enhancement once `save_state` ships.

### 5.6 Per-turn usage telemetry — locked: stderr log

```ts
log(`turn-usage model=${model} input=${usage.input_tokens} output=${usage.output_tokens} cache_create=${usage.cache_creation_input_tokens ?? 0} cache_read=${usage.cache_read_input_tokens ?? 0} elapsed_ms=${elapsedMs} player=${playerName}`);
```

Operators grep `[claude-tempo:claude-api] turn-usage` from daemon logs. **No wire-protocol signal in v1** — adding a `recordTurnUsage` signal without a consumer (cost dashboard / per-session cap) inflates surface for no gain. When a consumer lands, add the signal at that time; v1's structured stderr log is sufficient for operator triage.

---

## 6. Cancellation + lifecycle

### 6.1 Lease revocation → abort

```ts
class DirectApiAttachment extends SdkAttachment {
  private abortController: AbortController | null = null;

  protected onSuperseded(): void {
    this.abortController?.abort();   // SDK respects AbortSignal cleanly
  }

  protected async invokeSdk(prompt: string, timeoutMs: number): Promise<unknown> {
    this.abortController = new AbortController();
    try {
      // tool-use loop with this.abortController.signal passed to messages.create
    } finally {
      this.abortController = null;
    }
  }
}
```

`SdkAttachment`'s phase watcher fires `onSuperseded()` when `attachmentInfo.currentAttachment.attachmentId` diverges from our token. The adapter aborts in-flight `messages.create`, `processingEnd` fires in the `finally`, and the process exits cleanly. Ghost-reply window documented in `docs/design/session-lifecycle-rebuild-v2.md` §9.3 — same as Copilot.

### 6.2 No reconnect opt-in

Per `src/adapters/README.md` guidance for SDK adapters. `DirectApiAttachment` does NOT override `shouldReconnect()`. Lease loss exits the process; daemon `reconcile-on-boot` (or operator `restart`) recovers.

### 6.3 Heartbeat cadence

`heartbeatMs: 30_000` per the SDK-class default in `docs/design/session-lifecycle-rebuild-v2.md` §4.3. Inherited from `SdkAttachment`'s descriptor convention — no override needed.

---

## 7. Wire-protocol implications

**Zero new signals/queries/updates on `claudeSessionWorkflow`.** The adapter uses the existing surface:

| Surface | Use |
|---|---|
| `claimAttachmentUpdate` | Inherited from `BaseAttachment.startV2Lifecycle` |
| `heartbeatSignal` | Inherited |
| `processingStartUpdate` / `processingEndUpdate` | Inherited from `SdkAttachment.deliver()` |
| `markDeliveredSignal` | Inherited from `SdkAttachment.deliver()` |
| `receiveMessageSignal` | Used for context-overflow message (§5.5) |
| `attachmentInfoQuery` | Inherited from `BaseAttachment` phase watcher |
| `allMessagesQuery` / `allSentMessagesQuery` | Used for conversation rebuild (§5.1) |
| `requestDetachSignal` / `adapterExitedSignal` | Inherited from `SdkAttachment.detachGracefully` |

The only wire-protocol-doc touchpoint is the `agentType: 'claude-api'` extension. `docs/WIRE-PROTOCOL.md` doesn't enumerate AgentType values today — no doc change required there.

`SessionMetadata.agentType` accepts the new value via the AgentType type extension (§3.2). Old workflow runs that pre-date this PR have `agentType` as `'claude' | 'copilot'` only; the new value appears only on freshly-recruited claude-api players. Strictly additive.

---

## 8. Engineer-facing skeleton

```ts
// src/adapters/claude-api/adapter.ts (skeleton, ~300 LoC actual)

import { Client as McpClient } from '@modelcontextprotocol/sdk/client/index.js';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import type { WorkflowHandle } from '@temporalio/client';
import { SdkAttachment } from '../sdk/base';
import { receiveMessageSignal, allMessagesQuery, allSentMessagesQuery } from '../../workflows/signals';
import type { AdapterDescriptor, Message } from '../../types';

let Anthropic: any;
try {
  Anthropic = require('@anthropic-ai/sdk').default;
} catch {
  if (require.main === module) {
    console.error(
      'Error: @anthropic-ai/sdk is not installed.\n' +
      'Install with: npm install @anthropic-ai/sdk\n' +
      'Or recruit with a different adapter.',
    );
    process.exit(1);
  }
}

export const claudeApiDescriptor: AdapterDescriptor = {
  adapterId: 'claude-api',
  adapterClass: 'sdk',
  blocksOnLLMTurn: true,
  heartbeatMs: 30_000,
};

const DEFAULT_MODEL = 'claude-opus-4-7';   // pin reviewable at next minor

export class DirectApiAttachment extends SdkAttachment {
  readonly descriptor = claudeApiDescriptor;
  private abortController: AbortController | null = null;
  private mcp: McpClient | null = null;
  private mcpTools: Array<{ name: string; description: string; input_schema: object }> = [];
  private apiClient: any;
  private model: string;

  constructor(opts: { model?: string }) {
    super();
    this.model = opts.model ?? process.env.CLAUDE_TEMPO_API_MODEL ?? DEFAULT_MODEL;
  }

  protected onSuperseded(): void {
    this.abortController?.abort();
  }

  async run(workflowId: string): Promise<void> {
    const pinned = await this.startV2Lifecycle(workflowId);
    await this.bootMcp();
    this.apiClient = new Anthropic({
      apiKey: process.env.ANTHROPIC_API_KEY,
      maxRetries: 0,   // tool calls are side-effecting; no retry
    });
    await this.pollLoop(pinned);
  }

  private async bootMcp(): Promise<void> {
    const server = new McpServer({ name: 'claude-tempo', version: PACKAGE_VERSION });
    registerAllTempoTools(server, /* … workflow handle, identity context … */);
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await server.connect(serverTransport);
    this.mcp = new McpClient({ name: 'claude-api-adapter', version: PACKAGE_VERSION });
    await this.mcp.connect(clientTransport);
    const { tools } = await this.mcp.listTools();
    this.mcpTools = tools.map((t) => ({
      name: t.name,
      description: t.description ?? '',
      input_schema: t.inputSchema,
    }));
  }

  private async pollLoop(pinned: WorkflowHandle): Promise<void> {
    // POLL_INTERVAL_MS: 2-5s typical (Copilot bridge uses 2000ms; implementer
    // picks one in that range — too tight wastes Temporal RPCs, too loose
    // delays cue delivery noticeably).
    while (!this.shouldStop()) {
      const messages = await pinned.query(pendingMessagesQuery);
      if (messages.length === 0) {
        await sleep(POLL_INTERVAL_MS);
        continue;
      }
      const msg = messages[0];
      // Stash the conversation on `this` for invokeSdk to consume; skip the
      // intermediate JSON-stringify/parse round trip (build the Anthropic
      // message array directly inside invokeSdk from `this.pendingHistory`).
      await this.loadHistory(pinned);
      await this.deliver(pinned, msg, /* prompt unused */ '', TURN_TIMEOUT_MS, this.invokeSdk.bind(this));
    }
  }

  private pendingHistory: { received: Message[]; sent: Array<{ to: string; text: string }> } = { received: [], sent: [] };

  private async loadHistory(pinned: WorkflowHandle): Promise<void> {
    const [received, sent] = await Promise.all([
      pinned.query(allMessagesQuery) as Promise<Message[]>,
      pinned.query(allSentMessagesQuery) as Promise<Array<{ to: string; text: string }>>,
    ]);
    this.pendingHistory = { received, sent };
  }

  protected async invokeSdk(_prompt: string, _timeoutMs: number): Promise<unknown> {
    this.abortController = new AbortController();
    // Build the Anthropic Messages API array directly from in-memory history —
    // no JSON stringify/parse round trip. `from: 'maestro' | <other-player>` →
    // 'user'; the player's own previous responses → 'assistant'.
    const messages = this.buildAnthropicMessages(this.pendingHistory);
    let assistantText = '';

    try {
      let stopReason: string | null = null;
      while (stopReason === null || stopReason === 'tool_use') {
        const stream = await this.apiClient.messages.create({
          model: this.model,
          max_tokens: 8192,
          system: SYSTEM_PROMPT,    // see §10
          tools: this.mcpTools,
          messages,
          stream: true,
        }, { signal: this.abortController.signal });

        const turnText: string[] = [];
        const toolUses: Array<{ id: string; name: string; input: any }> = [];
        let usage: any = null;
        for await (const event of stream) {
          // accumulate text deltas, tool_use blocks, usage on message_delta
        }
        assistantText += turnText.join('');

        // Per-turn telemetry (stderr only in v1)
        log(`turn-usage model=${this.model} input=${usage?.input_tokens} output=${usage?.output_tokens} cache_create=${usage?.cache_creation_input_tokens ?? 0} cache_read=${usage?.cache_read_input_tokens ?? 0} player=${process.env.CLAUDE_TEMPO_PLAYER_NAME}`);

        if (toolUses.length === 0) break;
        // Dispatch tool calls and append next user turn
        const toolResults = [];
        for (const tu of toolUses) {
          const result = await this.mcp!.callTool({ name: tu.name, arguments: tu.input });
          toolResults.push({ type: 'tool_result', tool_use_id: tu.id, content: result.content, is_error: result.isError ?? false });
        }
        messages.push({ role: 'assistant', content: /* tool_use blocks */ });
        messages.push({ role: 'user', content: toolResults });
      }

      if (stopReason === 'model_context_window_exceeded') {
        await this.deliverContextOverflowMessage(/* … */);
      }
    } finally {
      this.abortController = null;
    }
    return assistantText;
  }
}

if (require.main === module) {
  // Self-exec entry point — same shape as Copilot adapter
  const model = process.env.CLAUDE_TEMPO_API_MODEL;
  const a = new DirectApiAttachment({ model });
  a.run(deriveWorkflowId()).catch((err) => {
    console.error('claude-api adapter exited:', err);
    process.exit(1);
  });
}
```

---

## 9. Test strategy

### 9.1 Unit (Vitest, `tests/`)

- `tests/adapters/claude-api.test.ts` — mock `@anthropic-ai/sdk`; exercise tool-use loop with synthesized stream events. Cases:
  - Single-turn (no tool_use) — assistant text reaches workflow via markDelivered
  - Multi-turn tool-use loop terminates on `stop_reason: 'end_turn'`
  - SDK abort during in-flight message → `processingEnd` still fires
  - Retry disabled inside tool-use loop (verify `maxRetries: 0` on Anthropic constructor)
  - Context-overflow path emits the overflow message
- `tests/tools/recruit.test.ts` — extend with `adapter: 'claude-api'` cases:
  - Pre-flight rejects when `ANTHROPIC_API_KEY` unset
  - Pre-flight rejects when `@anthropic-ai/sdk` not installed
  - `model` arg flows through to outbox entry

### 9.2 Workflow integration (Mocha, `test/`)

- `test/adapter-sdk-lifecycle-v2.test.ts` (existing) — the SDK-class lifecycle baseline that `CopilotSdkAttachment` already passes. The new adapter must pass the same lifecycle cases (claim → first heartbeat → processingStart/End pairing → markDelivered → graceful detach → superseded abort). Either parameterize this suite over both `copilot` and `claude-api` descriptors, or extract its cases into a shared helper that the new test (below) calls.
- `test/adapter-claude-api-lifecycle.test.ts` (**NEW**, naming follows the existing `adapter-{id}-lifecycle-v2.test.ts` convention) — claude-api-specific integration with mock `@anthropic-ai/sdk`: full spawn → claim → turn (with mocked stream events) → tool_use round-trip → detach. Verifies `processingStart`/`End` pairing fires correctly per turn, `AbortController` propagates on superseded, `maxRetries: 0` is set on the Anthropic constructor.

The conformance suite the design originally referenced (`adapter-conformance.test.ts` parameterizing over every descriptor) does NOT exist as a single file today — it lives distributed across `adapter-sdk-lifecycle-v2.test.ts` (SDK class), `adapter-claude-code-lifecycle-v2.test.ts` (interactive class), and the targeted suites (`adapter-258-precheck-tiebreaker`, `adapter-process-lifecycle-telemetry`, `adapter-reconnect`). Implementer should add the new claude-api lifecycle test alongside, NOT consolidate the existing layout.

### 9.3 Wire-protocol drift detector

No new wire surface — drift detector is a no-op for this PR. The detector still validates that `claimAttachment` / `heartbeat` / `processingStart` / `processingEnd` / `markDelivered` / `receiveMessage` are all referenced (they are, via `SdkAttachment` inheritance).

### 9.4 Manual smoke

- Recruit a `claude-api` player against a real `ANTHROPIC_API_KEY`; verify it cues, reports, recalls, and detaches cleanly.
- Force superseded scenario via `restart` — verify abort fires, ghost reply doesn't land.
- Force context overflow with a small `max_tokens` — verify overflow message reaches the workflow.

---

## 10. System prompt scaffolding

The Claude API adapter needs a system prompt that establishes the player as part of a tempo ensemble. Reuses the pattern from `src/server.ts` `MCP_INSTRUCTIONS` — which already documents:
- Ensemble identity
- Player name + role
- Available tools (cue, report, recall, ensemble, …)
- Coordination conventions (broadcast intent before branch switches, conductor authority, etc.)

Implementer pulls the same instructions string into the system prompt at session-init time (one-shot, cached). The prompt does **not** repeat per turn — it lives in the cached prefix.

**Headless-identity addendum** — the system prompt must clearly distinguish a `claude-api` player from a `claude-code` player so the LLM doesn't reach for tools it doesn't have. Append a short paragraph after `MCP_INSTRUCTIONS` such as:

> You are a **headless** claude-api player — you have access to the claude-tempo MCP tools (cue, report, recall, ensemble, broadcast, recruit, set_part, …) but **NOT** the file-edit, shell, or web tools that a `claude-code` player would have (no Bash, Read, Write, Edit, Glob, Grep, WebSearch, WebFetch). For tasks requiring file edits or shell commands, ask the conductor to recruit a `claude-code` player and hand off via cue. (File-op tool support is planned for a Phase 2 enhancement.)

The addendum lives under the same `cache_control: { type: 'ephemeral' }` block as the rest of the system prompt — cost is amortized across the session.

---

## 11. Phase 2 forward-work hooks (deliberately out of scope)

| Phase 2 candidate | Rationale for v1 deferral |
|---|---|
| **Advisor strategy (`advisor_20260301`)** | Per issue #131's own framing; advisor needs separate strategy clarity (executor model selection, opt-in mechanism, audit trail, cost monitoring, fallback behaviour) — file a fresh Phase 2 issue when ready. |
| **File-op tools** (Bash/Read/Write/Edit/Glob/Grep) | Phase 1 motivations don't depend on them. Phase 2 picks one of: (a) implement directly, (b) bridge Anthropic server-side `bash_20250124` + `text_editor_20250124`, (c) MCP-first via a `mcp__filesystem__*` tool family. |
| **WebSearch / WebFetch** | Same reasoning as file ops — not on Phase 1's critical path. |
| **Per-turn usage signal + workflow-side aggregation** | v1 stderr-only is sufficient for operator triage. When a consumer (cost dashboard, per-session cap, ensemble-level budget) lands, add `recordTurnUsage` signal + ring-buffer query at that time. |
| **Per-session / per-ensemble cost cap** | Cap policy (refuse vs warn vs graceful shutdown vs fall back to cheaper model) is a non-trivial UX problem. Gather data first. |
| **Auto-compact on context overflow** | Requires #334 saveable-state to land. v1 emits a workflow message; v2 can wire the auto-compact path. |
| **Anthropic Bedrock / Vertex SDK variants** | Direct Messages API only in v1. Bedrock/Vertex are separate SDKs (`@anthropic-ai/bedrock-sdk`, `@anthropic-ai/vertex-sdk`). File follow-ups when needed. |
| **Reconnect opt-in for SDK adapters** | Per `src/adapters/README.md` guidance: SDK adapters generally don't reconnect — pull-loop adapters own their session lifecycle. Revisit if specific need emerges. |

---

## 12. Sequencing

### 12.1 Independence

- **#318 coat-check** — orthogonal (different storage, different scope); either can ship first.
- **#319 protobuf migration** — additive on JSON wire; when protobuf migration lands, the new `agentType: 'claude-api'` value goes through the same wire transition as everything else.
- **#334 saveable-state (just merged)** — composes naturally with auto-compact in Phase 2; v1 doesn't depend on it.
- **#94/#95 SSE event source** — adapter doesn't observe SSE in v1; future "adapter-state.changed" events are additive Phase 5+.

### 12.2 Recommended drop point

Single PR, ~825-1,125 LoC (researcher's refined estimate; issue's 600-1,000 was light if the MCP-client glue bites). Estimated 2-3 days for engineer pickup. eng-2 named as natural implementer per conductor (TempoClient context fresh from #329).

Fits in any quiet engineering slot. Recommended sequencing: drop after current Phase-3-PR-4 + #334 implementation finishes (so we don't have multiple adapter-layer-touching PRs in flight).

### 12.3 Phase 2 prerequisites

When file-op tools are added in Phase 2, the locked v1 design must NOT need refactoring — the MCP-client glue is forward-compatible by construction (any new tool registered on `src/tools/*` flows through automatically).

When advisor strategy is added in Phase 2, the model selection knob (§3.1, §3.5) extends to per-turn model overrides. v1's `model` field becomes a session default; advisor consultation calls `messages.create({ model: ADVISOR_MODEL })` independently. No v1 lock-in.

---

## 13. Decision log — answers to researcher's 8 open questions

| Q | Researcher lean | Locked decision | Rationale (where it differs) |
|---|---|---|---|
| Q1: Tool-surface scope | MCP-tools-only for v1 | **MCP-tools-only**; file ops Phase 2 | Confirmed |
| Q2: MCP transport | (open) | **In-process MCP server + InMemoryTransport** | Avoids subprocess; preserves abstraction; ~50 LoC |
| Q3: Per-turn usage telemetry | (open — defer to Phase B) | **Stderr structured log only in v1**; signal deferred to follow-up | Forward-compatible — no premature wire surface |
| Q4: Model selection | both, recruit-arg precedence | **Confirmed** — recruit-arg → env → constants-pinned default | Confirmed |
| Q5: Prompt-cache opt-out | always-on | **Always-on, no flag** | Confirmed; one less knob |
| Q6: Context-overflow UX | emit-message vs auto-compact (depends on #334) | **Emit message in v1**; auto-compact via #334 deferred to Phase 2 | Confirmed; #334 just landed but adapter shouldn't gate on it |
| Q7: AgentType naming | `'claude-api'` | **`'claude-api'`** | Confirmed; matches issue title; pairs with existing `'claude'` (CLI) |
| Q8: Cost cap | defer to follow-up | **No cap in v1** | Confirmed; cap policy needs UX evidence first |

---

## 14. References

- **Issue #131** — Phase 1 scope + Phase 2 deferred questions (this PR's input)
- **Phase A research** — [`docs/research/131-claude-api-adapter-alternatives.md`](../research/131-claude-api-adapter-alternatives.md) (PR #339)
- **ADR 0012** — [`0012-claude-api-adapter.md`](../adr/0012-claude-api-adapter.md) — decision record for this design
- **Anthropic SDK docs** — [Messages API streaming](https://docs.anthropic.com/en/api/messages-streaming), [Prompt caching](https://docs.anthropic.com/en/docs/build-with-claude/prompt-caching), [Tool use](https://docs.anthropic.com/en/docs/build-with-claude/tool-use)
- **Adapter precedents**:
  - [`src/adapters/sdk/base.ts`](../../src/adapters/sdk/base.ts) — `SdkAttachment` lifecycle contract
  - [`src/adapters/copilot/adapter.ts`](../../src/adapters/copilot/adapter.ts) — closest existing SDK-class precedent
  - [`src/adapters/base.ts`](../../src/adapters/base.ts) — `BaseAttachment`, `AdapterRegistry`, `resolveFromAgentType`
  - [`src/adapters/README.md`](../../src/adapters/README.md) — adapter contract + reconnect opt-in
- **Design doc** — [`docs/design/session-lifecycle-rebuild-v2.md`](session-lifecycle-rebuild-v2.md) §4 (adapter extensibility), §4.3 (lifecycle guarantees), §4.5 (conformance suite), §4.6 (worked example: headless Claude SDK adapter — *this design*), §9.3 (ghost-reply window)
- **MCP TypeScript SDK** — `@modelcontextprotocol/sdk` `InMemoryTransport`, `Server`, `Client`
- **Prior Phase B precedents** — ADR 0007 (TempoClient split), 0008 (coat-check), 0009 (protobuf), 0011 (saveable-state) — same template
