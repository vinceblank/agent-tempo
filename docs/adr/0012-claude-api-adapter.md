# ADR 0012 — Headless Claude API adapter (Phase 1, no advisor)

- **Status**: Accepted (design — implementation deferred to scheduled engineer pickup; eng-2 named per conductor)
- **Date**: 2026-04-26
- **Authors**: tempo-architect
- **Related**: [`docs/design/131-claude-api-adapter.md`](../design/131-claude-api-adapter.md), [`docs/research/131-claude-api-adapter-alternatives.md`](../research/131-claude-api-adapter-alternatives.md), issue #131 (Phase 1)

## Context

Today claude-tempo ships two session adapters: `claude-code` (interactive CLI, push-delivery) and `copilot` (SDK-class, pull-delivery via `@github/copilot-sdk`). Both inherit constraints from their underlying processes — interactive TTYs, manual dev-channels prompt bypass, terminal lifecycle baggage. CI / cloud / scheduled-work environments don't have a terminal, and the executor/advisor pattern Anthropic published needs API-direct access to switch models per turn.

Issue #131 proposes a third adapter — `claude-api` — that uses the Anthropic Messages API directly. Phase 1 ships the basic headless adapter; Phase 2 (advisor strategy, file-op tools) is explicitly deferred pending strategy clarity on opt-in mechanism, executor/advisor coupling, cost monitoring, fallback behaviour, and audit trail.

Phase A research (PR #339, `docs/research/131-claude-api-adapter-alternatives.md`) audited the Anthropic SDK landscape (`@anthropic-ai/sdk` v0.91.1, AsyncIterable streaming preferred, manual tool-use loop required, retry disabled inside the loop, prompt caching default ON), the existing adapter base classes (`SdkAttachment` covers ~80 % of the lifecycle for free), and the tool-bridging design space (in-process MCP via `InMemoryTransport` vs subprocess vs adapter-calls-tools-directly).

The design spike was tasked with locking eight open questions before engineer pickup:

1. Tool-surface scope for v1 (MCP-tools-only or include file ops)
2. MCP transport (in-process vs subprocess)
3. Per-turn usage telemetry shape
4. Model selection (recruit-arg vs env vs both)
5. Prompt-cache opt-out mechanism
6. Context-overflow UX (emit-message vs auto-compact via #334)
7. `AgentType` naming
8. Cost cap

## Decision

**Adopt the headless Claude API adapter as designed in [`docs/design/131-claude-api-adapter.md`](../design/131-claude-api-adapter.md).** The design lives there; this ADR records the decision.

Headline locked-in choices:

- **Class**: `DirectApiAttachment extends SdkAttachment`. Concrete subclass overrides `invokeSdk`, `onSuperseded`, and the descriptor; everything else (claim + heartbeat + phase watcher + `processingStart`/`End` pairing + `markDelivered`) inherited from `SdkAttachment` / `BaseAttachment`. **No reconnect opt-in** (SDK adapters don't reconnect per `src/adapters/README.md`).
- **Spawn model**: detached Node subprocess matching Copilot bridge pattern. Self-exec entry point gated by `require.main === module`. New optional dep `@anthropic-ai/sdk@~0.91.1` (tilde, not caret — Stainless ships breaking changes under SemVer minor).
- **Tool bridging**: in-process MCP server + paired in-memory client via `InMemoryTransport.createLinkedPair()`. The adapter registers all existing tempo tools onto an `McpServer`, holds a paired `Client`, calls `client.listTools()` once at session start, dispatches `tool_use` content blocks via `client.callTool()`. **MCP-tools-only in v1**; file-op tools (Bash/Read/Write/Edit/Glob/Grep) and WebSearch/WebFetch deferred to Phase 2.
- **Recruit surface**: extend `agent` enum from `'claude' | 'copilot'` to `'claude' | 'copilot' | 'claude-api'`; add optional `model` Zod field. `AgentType` extended one value (additive). `AdapterRegistry.resolveFromAgentType` extended one line. **No new signals/queries/updates** on `claudeSessionWorkflow`.
- **Conversation state**: rebuilt every turn from workflow `messages[]` + `sentMessages[]` queries. Stateless API + durable workflow = single source of truth. Prompt caching always-on with `cache_control: { type: 'ephemeral' }` on the system prompt + tools head; conversation tail is uncached and walks forward each turn.
- **Tool-use loop**: AsyncIterable streaming, manual loop (NOT `client.beta.messages.toolRunner` — fights us on lifecycle hooks). SDK `maxRetries: 0` inside the loop (avoids double-execution of side-effecting tools). Stop on `end_turn` / `max_tokens`; on `model_context_window_exceeded` emit a workflow message and exit.
- **Cancellation**: `AbortController` wired into `messages.create({ signal })`; `onSuperseded()` aborts. Inherited `processingEnd` `finally` ensures the in-flight marker releases even on throw.
- **Per-turn usage**: structured stderr log line in v1 (`[claude-tempo:claude-api] turn-usage model=… input=… output=… cache_create=… cache_read=… elapsed_ms=… player=…`). **No wire-protocol signal in v1** — adding `recordTurnUsage` without a consumer (cost dashboard / per-session cap) inflates surface for no gain. Forward-compatible: signal can be added later without breaking the adapter.
- **Model selection**: recruit-arg precedence → `CLAUDE_TEMPO_API_MODEL` env → constants-pinned default (`claude-opus-4-7-20250115` at impl time, reviewable at next minor SDK bump).
- **Context-overflow UX**: emit a workflow message recommending `save_state` + `restart({ loadFromState: true })`. Auto-compact via #334 deferred to Phase 2.

Eight open questions — locked answers:

| Q | Locked decision |
|---|---|
| Tool-surface scope | **MCP-tools-only**; file ops + web tools Phase 2 |
| MCP transport | **In-process server + `InMemoryTransport`** |
| Per-turn usage telemetry | **Stderr structured log only**; signal deferred |
| Model selection | **Recruit-arg → env → constants-pinned default** |
| Prompt-cache opt-out | **Always-on, no flag** |
| Context-overflow UX | **Emit message in v1**; auto-compact Phase 2 |
| AgentType naming | **`'claude-api'`** |
| Cost cap | **No cap in v1**; UX needs evidence first |

## Consequences

- **Positive**:
  - **Headless capability** — TTY-free, terminal-free; works in CI / cloud / scheduled-work / advisor-precursor contexts.
  - **Strict additivity on the workflow surface** — zero new signals/queries/updates; the adapter uses only existing wire contracts. Old workflow runs are unaffected.
  - **Single source of truth for tool surface** — in-process MCP means every existing and future tempo tool lights up automatically. New tools added to `src/tools/*` work in claude-api players with no adapter change.
  - **Lifecycle hygiene inherited** — `SdkAttachment` covers ~80 % of the wiring (claim, heartbeat, phase watcher, processingStart/End, markDelivered, runId pinning, WorkflowNotFound handling). Concrete adapter is small (~300 LoC) and focused.
  - **Cancellation-clean** — `AbortController` integration with `messages.create({ signal })` matches Copilot's `session.cancel()` pattern; ghost-reply window bounded per design §9.3.
  - **Prompt caching by default** — system prompt + tools cached; only conversation tail is uncached; cost amortized.
  - **Per-turn `usage` directly visible** — operators grep stderr for cost monitoring; no parsing of CLI output.
  - **Optional dependency pattern matches Copilot** — non-claude-api users pay no install cost.
- **Negative**:
  - **No file-op tools in v1** — claude-api players can't read/write/edit files or run shell commands. Recruit's tool description must call this out so the conductor / operator picks the right adapter for the task. Phase 2 follow-up.
  - **No web tools in v1** — same reasoning; same Phase 2 follow-up.
  - **No cost cap in v1** — burn rate visible in stderr but not enforced. Operators must watch logs. Acceptable for v1; cap policy needs UX evidence (refuse vs warn vs graceful shutdown vs fall back to cheaper model).
  - **Conversation rebuild every turn** — sends the full message history each call, costing a non-trivial `input_tokens` reload per turn. Mitigated by prompt caching (cached prefix amortizes); still pays once per session for the first uncached turn.
  - **SDK pin is tilde, not caret** — manual review required at each Stainless minor bump (~weekly). Acceptable; better than silent breakage.
  - **`@anthropic-ai/sdk` install is opt-in** — recruit pre-flight rejects with an actionable error if missing. Operators must `npm install @anthropic-ai/sdk` to use the adapter.
  - **No reconnect opt-in for SDK adapters** — lease loss exits the process. Operator restart or daemon `reconcile-on-boot` recovers. Matches Copilot; revisit if a specific need emerges.
  - **Per-turn usage telemetry is stderr-only** — operators see live burn rate but there's no aggregated query. Adding the wire-protocol signal in a follow-up is forward-compatible by construction.
- **Neutral**:
  - **~825-1,125 LoC implementation cost** matches researcher's refined estimate. Single PR, additive, no breaking changes. eng-2 named as natural implementer (TempoClient context fresh from #329).
  - **Adapter conformance suite (`test/adapter-conformance.test.ts`) parameterizes over registered descriptors** — the new adapter must pass nine conformance cases; no new test framework needed.

## Alternatives considered

- **Vercel AI SDK (`@ai-sdk/anthropic`)** — rejected. Higher-level abstraction over the same Messages API; we already own the loop and event model; unnecessary indirection that hides the events `processingStart/End` needs.
- **Raw HTTP (no SDK)** — rejected. SDK provides retry, error hierarchy, AsyncIterable streaming, AbortController wiring for free. SDK exposes `client.post()` / `.asResponse()` escape hatches if needed.
- **`@anthropic-ai/bedrock-sdk` / `vertex-sdk`** — out of scope for v1. Direct Messages API only; users wanting Bedrock/Vertex can file follow-ups.
- **Extend `claude-code` adapter to support API-direct mode** — rejected. Conflates `interactive` vs `sdk` delivery models; muddles the abstraction the registry is built around. New adapter is the right structure.
- **Use Claude Code CLI as a subprocess (`claude --headless`)** — rejected. That's just the existing `claude-code` adapter. Phase 1's whole point is to escape CLI/TTY constraints.
- **Tool execution via Anthropic server-side `bash_20250124` / `text_editor_20250124`** — deferred to Phase 2. These are still adapter-executed (Anthropic just defines the tool schema). Worth investigating once Phase 1 ships and we have signal on tool needs.
- **Adapter-calls-tools-directly (bypass MCP)** — rejected. Breaks the MCP-as-source-of-truth invariant. Forces every new tempo tool to know about both surfaces (server registration + adapter shim). Two sources of drift.
- **Subprocess MCP server (stdio sidecar)** — rejected. Adds a second process to manage; stdio buffering edge cases; ~150 LoC of sidecar glue vs ~50 LoC of in-process glue. In-process is clean wins.
- **`client.beta.messages.toolRunner`** (SDK convenience) — rejected. Hides the events `processingStart/End` needs; can't easily wire approval gates / lifecycle hooks / structured telemetry around tool execution.
- **`@anthropic-ai/sdk@^0.91.1`** (caret) — rejected. Stainless ships breaking changes under SemVer minor per Anthropic's own policy. Tilde stays on the `0.91.x` line; reviews happen at minor bump.
- **Always-spawn the SDK adapter via in-daemon code path** — rejected. Adapter lifecycle must be independently destroyable / restartable; embedding in the daemon couples cleanup. Detached subprocess matches Copilot.
- **Workflow-side `recordTurnUsage` signal in v1** — rejected. No consumer in v1; surface inflation. Stderr log is sufficient for operator triage; signal added later when cost dashboard / per-session cap lands. Forward-compatible.
- **Per-recruit prompt-cache opt-out flag** — rejected. Strict-prefix cache invalidates on any system-prompt or tools-array byte change anyway; one less knob. Restart spawns a fresh cache.
- **Auto-compact context overflow via #334** — deferred to Phase 2. v1 emits a workflow message recommending `save_state` + `restart`; v2 (post #334 implementation soak) wires the auto-compact path.
- **`'api'` / `'claude-direct'` / `'claude-headless'`** as `AgentType` value — rejected. `'claude-api'` matches the issue title, pairs cleanly with the existing `'claude'` (CLI) and `'copilot'`, and is the most descriptive of the network shape.

## Forward-looking notes

- **Phase 2 advisor strategy** — needs strategy clarity (per-player advisor opt-in, executor/advisor model coupling, cost monitoring, fallback, audit trail) before implementation. File a separate issue when ready. v1's `model` knob extends naturally — advisor consultation calls `messages.create({ model: ADVISOR_MODEL })` independently of the session default.
- **Phase 2 file-op tools** — three paths: (a) implement directly in adapter (300+ LoC, mirrors Claude Code's built-ins), (b) bridge Anthropic server-side `bash_20250124` + `text_editor_20250124` (still adapter-executed; ~200 LoC), (c) MCP-first via a `mcp__filesystem__*` tool family (lights up automatically given v1's MCP-client glue). Decide at Phase 2 issue filing.
- **Phase 2 per-turn usage signal + workflow-side aggregation** — when a consumer lands (cost dashboard / per-session cap / ensemble-level budget), add `recordTurnUsage` signal + ring-buffer query at that time. v1 stderr log stays as the operator-triage path.
- **Phase 2 cost cap** — UX-heavy decision: refuse new turns? warn? graceful shutdown? fall back to cheaper model? Gather data first via v1 stderr logs.
- **Phase 2 auto-compact on context overflow** — composes naturally with #334 saveable-state (just landed). Adapter saves a curated summary, calls `restart({ loadFromState: true })`, new session resumes from the summary. Phase 2 enhancement.
- **Wire-protocol additions post-v1.0** must register with the protobuf field-number plan in `protos/README.md` reservations log when #319 (protobuf migration) lands. The new `agentType: 'claude-api'` value is a string-enum addition — minimal protobuf surface; just an enum value reservation.
- **Reconnect opt-in for SDK adapters** — current `src/adapters/README.md` guidance says SDK adapters don't reconnect. Revisit if a specific need emerges (e.g. long-running scheduled work where lease churn becomes painful).

## References

- [`docs/design/131-claude-api-adapter.md`](../design/131-claude-api-adapter.md) — full design (14 sections, interface skeletons, integration points, test strategy, decision log)
- [`docs/research/131-claude-api-adapter-alternatives.md`](../research/131-claude-api-adapter-alternatives.md) — Phase A research (PR #339) — SDK landscape, adapter audit, tool-bridging design space, alternatives
- Issue #131 — Phase 1 scope + Phase 2 deferred questions (advisor strategy)
- ADR 0007 (TempoClient Core/WithSpawn split), ADR 0008 (coat-check pattern), ADR 0009 (protobuf migration), ADR 0011 (player-saveable state) — same design-spike template precedent
- `src/adapters/sdk/base.ts` — `SdkAttachment` lifecycle contract (~80 % of adapter wiring)
- `src/adapters/copilot/adapter.ts` — closest existing SDK-class precedent
- `src/adapters/base.ts:1306+` — `AdapterRegistry`, `resolveFromAgentType`
- `src/adapters/README.md` — adapter contract + reconnect opt-in guidance
- `src/tools/recruit.ts` — agent-enum surface + preflight pattern
- [`docs/design/session-lifecycle-rebuild-v2.md`](../design/session-lifecycle-rebuild-v2.md) §4 (adapter extensibility), §4.3 (lifecycle), §4.5 (conformance suite), §4.6 (worked example: headless Claude SDK adapter — *this design*), §9.3 (ghost-reply window)
- Anthropic Messages API streaming docs, prompt caching docs, tool use docs
- `@anthropic-ai/sdk` v0.91.1 — Stainless-generated TypeScript SDK
- MCP TypeScript SDK — `InMemoryTransport`, `Server`, `Client`
