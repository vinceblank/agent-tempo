# Headless OpenCode adapter — Phase 1 (multi-provider via `opencode serve`)

> **Status**: Design proposal (Phase B — implementation deferred to Phase C engineer pickup)
> **Author**: tempo-architect
> **Branch**: `feat/449-opencode-phase-b-design`
> **Tracking**: issue #449 (Phase 1 — headless, server-bridge pattern)
> **Audience**: implementing engineer (Phase C), conductor for review.

---

## 0. TL;DR

Add a fourth adapter — `src/adapters/opencode/` — that drives [SST OpenCode](https://opencode.ai) as a headless local subprocess, giving agent-tempo a multi-provider LLM story (Anthropic, OpenAI, GitHub Copilot, ChatGPT account-based, Bedrock, Vertex, Ollama, ~70+ providers). New `OpenCodeAttachment extends SdkAttachment` mirrors the Copilot bridge / claude-api structure: detached Node subprocess, `claimAttachment` + heartbeat lifecycle inherited free, single override of `invokeSdk` for the LLM-turn loop.

The new adapter is selected via `recruit({ agent: 'opencode', model: 'provider/name', ... })`. **Tool bridging uses OpenCode's native MCP config block** (`type: "local"` stdio child) — the adapter synthesizes an inline JSON config (`OPENCODE_CONFIG_CONTENT` env) that registers `agent-tempo` as an OpenCode MCP child process. OpenCode owns tool dispatch + per-provider translation server-side, so **no `mcp-bridge.ts` translation layer is needed** — the single largest LoC saving vs claude-api (#131).

**Locked decisions on the 7 open questions** (researcher's directional leans validated and tightened):

| Q | Decision |
|---|---|
| 1. Subprocess-per-player vs shared | **Per-player**. Simpler crash recovery, isolation; matches Copilot. |
| 2. Config delivery | **Inline `OPENCODE_CONFIG_CONTENT` env**. No filesystem cleanup; secrets-redacted stderr config-log preserves debuggability. |
| 3. MCP transport | **`type: "local"` stdio**. Symmetric with claude-api's in-process MCP; auto-cleanup on subprocess exit. |
| 4. Port allocation | **Probe a free port at recruit**. Default 4096 not guaranteed free; matches `src/http/server.ts` pattern. |
| 5. Provider/model recruit-arg shape | **Combined `model: 'provider/name'`**. Opaque pass-through; matches OpenCode's own config shape. |
| 6. Session persistence across server restart | **Verify at Phase C impl time**. Architecturally identical-shape outcome either way; engineer picks restart-path implementation after impl-time experiment. |
| 7. Version-probe-gate strictness | **Warn-only**. Refuse would brick on every minor bump (OpenCode ships daily); ignore loses diagnostic signal. |

**Wire surface**: zero new signals/queries/updates on `claudeSessionWorkflow`. Strictly additive on `recruit`'s tool schema (`agent: 'opencode'`, model regex relaxed for `provider/model` shape) and `AgentType` (`'claude' | 'copilot' | 'mock' | 'claude-api' | 'opencode'`). `AdapterRegistry.resolveFromAgentType` extended one line.

**Estimated implementation cost**: ~805–1,175 LoC bottom-up per Phase A spike §8. Slightly over #449's 600-1,000 ceiling — design §8 proposes tightening (shared SDK-class lifecycle test helper, raw `fetch` over `@opencode-ai/sdk` if SDK weight bites, narrower v1 telemetry surface) to land back inside 1,000 LoC.

**Phase 2 explicitly out of scope** — cross-provider tool parity testing, subprocess-shared optimization, `type: "remote"` MCP transport, OpenCode OAuth flows, per-provider quota awareness, advisor strategy, version-drift CI. All listed in §11 as forward-work hooks.

**Dependency-stability stance**: proceed with caution. Tilde-pin (`~1.14.29`) discipline mandatory; loopback-only single-machine trust model; **`claude-api` (#131) documented as the Anthropic-only first-party fallback** — operators can switch on a single recruit-flag change if OpenCode dep ever bites.

---

## 1. Why now

Issue #449 motivates the OpenCode adapter on three orthogonal value props, all complementary to the existing 3-adapter family:

1. **Multi-provider headless** — `claude-code` / `copilot` / `claude-api` are each single-provider. Issue #449's primary motivation is to extend agent-tempo's headless story across all providers OpenCode supports (Anthropic, OpenAI, GitHub Copilot, ChatGPT account-based, Bedrock, Vertex, Ollama, ~70+). Per-provider, per-player-class flexibility unlocks ensembles where the executor uses one provider and the advisor uses another (Phase 2 advisor strategy).
2. **Headless with file-op tools** — claude-api players are headless but lack file-edit / shell / web tools (deferred to Phase 2 in #131). OpenCode players ARE file-op-capable through OpenCode's own built-in tool registry — without agent-tempo having to ship those bridges. The headless-identity addendum in §10 makes this UX delta explicit to the LLM.
3. **Provider-portable cost monitoring** — OpenCode's normalized event stream surfaces per-turn `usage` data uniformly across providers. Different providers expose different fields (Anthropic has `cache_read`/`cache_creation`; OpenAI doesn't), but the wire shape is consistent. v1 logs whatever's present to stderr; Phase 2 can add per-provider aggregation.

The new adapter is **independent** of #318 (coat-check), #319 (protobuf), #334 (saveable-state), and the SSE event source (#94/#95). It composes naturally with the just-merged #131 (claude-api) — both SDK-class, both inherit `SdkAttachment`, both expose the same tempo MCP surface — so operators can fall back to `claude-api` (Anthropic-only, no third-party dep) if OpenCode's HTTP API ever breaks under a minor bump. The **dependency-stability hedge** is real architectural property, not aspirational.

Phase A research (PR #468, [`docs/research/449-opencode-adapter-spike.md`](../research/449-opencode-adapter-spike.md)) validated:

- `opencode serve` is mature: HTTP server mode default `127.0.0.1:4096`, OpenAPI 3.1 spec at `/doc`, auto-generated `@opencode-ai/sdk` TypeScript client, SSE at `/event`, server-side persisted sessions, dedicated `POST /session/:id/abort`.
- **MCP-native config block** — OpenCode reads `mcp: { name: { type, command, environment } }` and spawns the MCP child directly. The adapter does NOT need a translation layer.
- Tool streaming is OFF by default in v1.14.29 — no `input_json_delta` partial-parse complexity.
- Doom-loop detection + context compaction built into OpenCode — adapter's responsibility shrinks vs claude-api.
- Server-side history — adapter sends only the new turn's parts; no per-turn `buildAnthropicMessages()` rebuild.
- Dependency stability: abandonment risk **LOW** (151k ⭐, daily releases, YC-funded, primary product); HTTP-API breaking-change risk **MEDIUM-HIGH** (still labeled "experimental"; minor bumps have shipped breaks).
- `SdkAttachment` covers ~80 % of the lifecycle for free — same as claude-api.

This document locks the design; the research doc records the evidence.

---

## 2. Existing adapter precedents

The new adapter slots into the existing 2-class registry (`docs/design/session-lifecycle-rebuild-v2.md` §4.1):

| Class | Delivery model | Existing adapters | Base class |
|---|---|---|---|
| `interactive` | push (no LLM block) | `claude-code` | `BaseAttachment` |
| `sdk` | pull (blocks on LLM turn; pairs `processingStart` / `processingEnd`) | `copilot`, `claude-api`, **`opencode` (new)** | `SdkAttachment` |

The OpenCode adapter is unambiguously **`sdk`** — `POST /session/:id/prompt_async` returns 204 immediately and the turn streams over SSE; we need the synchronous `processingStart` / `processingEnd` pairing that `SdkAttachment.deliver()` provides to bracket the streaming consumption.

**`SdkAttachment` (`src/adapters/sdk/base.ts`) gives us free** (same 80 % as claude-api):

- `deliver(pinned, msg, prompt, timeoutMs, invokeSdk, ackIds?)` — wraps each turn in `processingStart` (synchronous update) → `invokeSdk` → `processingEnd` (in `finally`) → `markDelivered`.
- `onSuperseded()` hook called when the phase watcher detects lease revocation; `sdkInFlight` flag for cancellation targeting.
- `startV2Lifecycle(workflowId)` from `BaseAttachment`: claim attachment, start heartbeat (30 s per descriptor), phase watcher, `WorkflowNotFound` handling, `runId` pinning.
- `detachGracefully()` for clean shutdown via `adapterExited`.
- Auto-reconnect for `'continued-as-new'` (#226) handled in base.

**Both `CopilotSdkAttachment` (`src/adapters/copilot/adapter.ts`) and `DirectApiAttachment` (`src/adapters/claude-api/adapter.ts`) are precedents** — read both for: `pinnedRunId` pattern, dual-purpose entry point (class export + `require.main === module` self-exec), env-var contract, unbuffered stderr logging via `fs.writeSync(2, ...)`, optional-dep guard, terminal-cleanup wiring (set up BEFORE `startV2Lifecycle` to avoid race on lease loss), PID file pattern (`logs/{playerId}.pid`).

**What's NEW in the OpenCode adapter** (not present in copilot or claude-api):

- **Subprocess-managed-by-adapter speaks HTTP/SSE to a sibling subprocess.** Closest analog is the daemon HTTP/SSE event source (`src/http/`), but inverted — the adapter is a *consumer* of similar shape, not a producer.
- **Inline-config JSON synthesis** — the adapter builds `OPENCODE_CONFIG_CONTENT` env at spawn time from recruit args (model, MCP server config) before launching `opencode serve`.
- **Free-port probe before spawn** — matches `src/http/server.ts`'s probe pattern.
- **OpenCode session-id stash** — like Copilot's `sessionId` (stashed via `updateMetadataSignal`), but distinct semantics (OpenCode IDs are server-internal, not provider-internal).
- **Dual abort path** — graceful `POST /session/:id/abort` first, subprocess SIGTERM/SIGKILL only if HTTP abort hangs.
- **Version-drift gate** — `/global/health` probe at boot; warn-only on minor drift from tested-pinned `~1.14.29`.

**What `OpenCodeAttachment` adds beyond `SdkAttachment`** — true overrides plus the `invokeSdk` callback-method pattern:

- `invokeSdk(prompt, timeoutMs)` — **subclass-defined class method, NOT a base-class override.** `SdkAttachment.deliver()` accepts `invokeSdk` as a callback parameter (`src/adapters/sdk/base.ts:111-116`); `pollLoop` calls `this.deliver(..., this.invokeSdk.bind(this), ...)` (mirrors `DirectApiAttachment` at `src/adapters/claude-api/adapter.ts:385`). The concrete adapter implements `invokeSdk` as a `protected` method on the class so `.bind(this)` resolves cleanly. Wraps `POST /session/:id/prompt_async` + SSE consumption + finish-reason wait + assembled-text return.
- `onSuperseded()` — **true abstract override** (`SdkAttachment` declares `protected abstract onSuperseded(): void`). `POST /session/:id/abort` first; subprocess SIGTERM as fallback after timeout.
- `descriptor` — true override of the abstract field. `{ adapterId: 'opencode', adapterClass: 'sdk', blocksOnLLMTurn: true, heartbeatMs: 30_000 }`.
- `shouldReconnect()` — **NOT** opted in (matches claude-api, copilot). Lease loss exits the process; daemon's `reconcile-on-boot` path or operator `restart` recovers. Worth revisiting in Phase 2 since OpenCode's server-side persistence makes reconnect more attractive than for claude-api.

---

## 3. Spawn integration

### 3.1 `recruit` tool surface

Extends the existing recruit Zod schema additively:

```ts
// src/tools/recruit.ts — additive on the existing schema
{
  // ... existing fields ...
  agent: z.enum(['claude', 'copilot', 'mock', 'claude-api', 'opencode']).optional()
    .describe(`Which agent to use (default: "${ownAgentType}", same as this session). … "opencode" runs headless via a local opencode serve subprocess; multi-provider (Anthropic, OpenAI, Bedrock, Ollama, …) — requires the @opencode-ai/sdk optional dep and an opencode binary on PATH.`),
  // EXISTING — relax regex to accept OpenCode's provider/model strings
  model: z.string().regex(/^[a-z0-9][a-z0-9-/.:_]*$/).optional()
    .describe(`Model id. For claude-api: "claude-opus-4-7" (no provider prefix). For opencode: "anthropic/claude-opus-4-7", "openai/gpt-4o", "ollama/llama3" (provider/model). Falls back to CLAUDE_TEMPO_API_MODEL (claude-api) or CLAUDE_TEMPO_OPENCODE_MODEL (opencode), then a constants-pinned default. Ignored for claude / copilot / mock adapters.`),
}
```

The existing `^claude-[a-z0-9-]+$` regex (locked by #131 for claude-api) is too restrictive for OpenCode's `provider/model` strings. **Relax to `^[a-z0-9][a-z0-9-/.:_]*$`** — first character alphanumeric, then alphanumerics + hyphens + slashes + dots + colons + underscores. This admits:

- claude-api: `claude-opus-4-7`, `claude-sonnet-4-6`, `claude-haiku-4-5` (existing values continue to validate)
- opencode: `anthropic/claude-opus-4-7`, `openai/gpt-4o`, `ollama/llama3.1:70b`, `bedrock/anthropic.claude-opus-4-7-v1:0`

The regex is only a sanity check — OpenCode itself rejects invalid provider/model strings at session-create time with a clear error. **No enum allowlist** — would constrain new providers (OpenCode adds them weekly).

### 3.2 `AgentType` extension

```ts
// src/types.ts
export type AgentType = 'claude' | 'copilot' | 'mock' | 'claude-api' | 'opencode';
```

Strictly additive. Old code that handles a subset falls through to a default branch for `'opencode'`; the test suite catches any unhandled-case regressions.

### 3.3 `AdapterRegistry.resolveFromAgentType` extension

```ts
// src/adapters/base.ts:1346 — one-line extension
resolveFromAgentType(agent: string | undefined): string {
  if (agent === 'copilot') return 'copilot';
  if (agent === 'mock') return 'mock';
  if (agent === 'claude-api') return 'claude-api';
  if (agent === 'opencode') return 'opencode';   // NEW
  return 'claude-code';
}
```

### 3.4 Pre-flight checks in `recruit`

Before submitting the recruit outbox entry, validate (mirrors claude-api's pattern at `src/tools/recruit.ts:139-152`):

1. `agent === 'opencode'` → `@opencode-ai/sdk` package resolves locally via `require.resolve('@opencode-ai/sdk')`. Pre-flight rejects with an actionable error if missing (`force: true` bypasses).
2. `agent === 'opencode'` → an `opencode` binary resolves on PATH (or via a shipping wrapper). Phase C engineer decides whether to invoke `opencode serve` directly or via the SDK; pre-flight checks whichever path Phase C picks.
3. `model` arg, if present, matches the relaxed regex (cheap sanity check; OpenCode rejects bad ids at runtime anyway).
4. Cross-host recruit (`host:` param): the target daemon's `hostProfile` advertisement (`availableAgentTypes`) is extended by one entry — the daemon includes `'opencode'` only if both the SDK resolves AND the `opencode` binary resolves at boot. Mirrors claude-api's `availableAgentTypes` extension.
5. **NOT a pre-flight check, but a v0 reminder for §3.6**: `--agent` parsing in `src/cli.ts:235` currently rejects values other than `'claude' | 'copilot'`. Phase C engineer extends to include `'opencode'` (and `'claude-api'` — staleness flagged during #432 boundary check).

### 3.5 Optional dependency

`@opencode-ai/sdk` joins `@github/copilot-sdk` and `@anthropic-ai/sdk` as an `optionalDependency` in `package.json`:

```json
"optionalDependencies": {
  "@github/copilot-sdk": "...",
  "@anthropic-ai/sdk": "~0.91.1",
  "@opencode-ai/sdk": "~1.14.29"
}
```

**Tilde, not caret** — OpenCode ships breaking changes under SemVer minor (e.g., `parts` data model dropped `to`/`from` fields, kept only `patch`; `userMessage.variant` relocated under `userMessage.model.variant`). Both shipped under minor-version bumps without a major release. A caret would auto-bump to `1.15.x` and silently break CI; tilde stays on the `1.14.x` line until a deliberate review.

The adapter `require()`s the SDK guarded by `require.main === module` so non-opencode users never see the import error (mirrors copilot at `src/adapters/copilot/adapter.ts:67-87` and claude-api at `src/adapters/claude-api/adapter.ts:70-83`).

**Phase C decision flagged in §8 LoC tightening**: if the auto-generated SDK adds disproportionate dependency weight (the OpenCode SDK pulls in OpenAPI runtime + per-endpoint typed clients), engineer can fall back to raw `fetch` over the OpenCode HTTP surface. The hot path uses ~5 endpoints (`/global/health`, `POST /session`, `POST /session/:id/prompt_async`, `POST /session/:id/abort`, `DELETE /session/:id`) plus the `/event` SSE stream — all small enough that hand-rolling beats SDK-bundling. **The architectural shape of the adapter is unchanged either way.**

### 3.6 Spawn process model

Detached Node subprocess matching the established pattern:

```bash
# Spawned by deliverStartRecruitedSession activity:
node dist/adapters/opencode/adapter.js
# (or `npx ts-node src/adapters/opencode/adapter.ts` in dev)
```

Env var contract:

| Variable | Source | Purpose |
|---|---|---|
| `CLAUDE_TEMPO_ENSEMBLE` | spawner | Workflow-id derivation |
| `CLAUDE_TEMPO_PLAYER_NAME` | spawner | Workflow-id derivation; identity |
| `CLAUDE_TEMPO_TEMPORAL_ADDRESS` | spawner | Temporal connection |
| `CLAUDE_TEMPO_TEMPORAL_NAMESPACE` | spawner | Temporal connection |
| `CLAUDE_TEMPO_OPENCODE_MODEL` | operator (optional) | Default model override; recruit `model` arg takes precedence. **NEW** — distinct from `CLAUDE_TEMPO_API_MODEL` to keep namespaces clean |
| `ANTHROPIC_API_KEY` / `OPENAI_API_KEY` / etc. | operator | Provider auth — read directly by OpenCode's provider client libs, not by agent-tempo |

The adapter then synthesizes `OPENCODE_CONFIG_CONTENT` and exports it for the spawned `opencode serve` child. **Synthesis happens inside the adapter process, not the spawner activity** — keeps the inline-JSON construction colocated with the rest of the spawn-side adapter logic, and avoids leaking provider/model knobs into the outbox-entry surface.

No new shell-quoting concerns — the spawn path matches claude-api's, which is already cross-platform-tested.

### 3.7 `OPENCODE_CONFIG_CONTENT` synthesis

The adapter builds the inline JSON config at spawn time from:

- `model` from recruit-arg (combined `provider/model` string)
- agent-tempo's MCP server registration (absolute path to `dist/server.js` + the standard env-var contract)
- Server config (`port: <probed>`, `hostname: '127.0.0.1'`, `mdns: false`)

Example synthesized config (with secrets redacted in stderr config-log):

```json
{
  "model": "anthropic/claude-opus-4-7",
  "provider": {
    "anthropic": {
      "options": { "apiKey": "{env:ANTHROPIC_API_KEY}", "setCacheKey": true }
    }
  },
  "server": { "port": 4732, "hostname": "127.0.0.1", "mdns": false },
  "mcp": {
    "agent-tempo": {
      "type": "local",
      "command": ["node", "/abs/path/to/dist/server.js"],
      "environment": {
        "CLAUDE_TEMPO_ENSEMBLE": "{env:CLAUDE_TEMPO_ENSEMBLE}",
        "CLAUDE_TEMPO_PLAYER_NAME": "{env:CLAUDE_TEMPO_PLAYER_NAME}",
        "CLAUDE_TEMPO_TEMPORAL_ADDRESS": "{env:CLAUDE_TEMPO_TEMPORAL_ADDRESS}",
        "CLAUDE_TEMPO_TEMPORAL_NAMESPACE": "{env:CLAUDE_TEMPO_TEMPORAL_NAMESPACE}"
      }
    }
  }
}
```

OpenCode's config supports `{env:VAR_NAME}` substitution natively — provider API keys flow through without agent-tempo seeing them in plaintext. The adapter logs the synthesized config to stderr at spawn time with provider `apiKey` substrings replaced by `***` so operators can debug without leaking creds.

**Provider auto-detection**: the adapter populates `provider.<name>.options` only for providers whose env vars are present at spawn time (same as OpenCode's own behavior). Non-Anthropic recruits with `model: 'openai/gpt-4o'` get a `provider.openai.options.apiKey: '{env:OPENAI_API_KEY}'` block instead. The mapping table is small (~10 entries for the major providers) and lives in `src/adapters/opencode/config.ts`.

---

## 4. Tool bridging — MCP-native (no translation layer)

The architectural keystone. Direct contrast with claude-api's `mcp-bridge.ts`.

### 4.1 Locked: agent-tempo's MCP server runs as an OpenCode-spawned stdio child

The adapter does **NOT** translate tool schemas. Instead:

1. The adapter (running in agent-tempo's process) builds `OPENCODE_CONFIG_CONTENT` (§3.7) with an `mcp.agent-tempo` block pointing at `node dist/server.js`.
2. The adapter spawns `opencode serve` with that config.
3. OpenCode reads the config, spawns `node dist/server.js` as a stdio MCP subprocess (a **second, separate** Node process from the adapter), and listens for `list_tools` / `call_tool` requests.
4. The MCP server (existing `src/server.ts`, unchanged) registers all tempo tools — the same surface every adapter sees: `cue`, `report`, `recall`, `ensemble`, `broadcast`, `recruit`, `set_part`, `set_name`, `who_am_i`, `schedule`, `pause`, `play`, `release`, `set_ensemble_description`, etc.
5. When OpenCode runs a turn and the LLM elects a tool call, OpenCode dispatches via the MCP client, gets the result, and feeds it back into the next LLM call **without the adapter being on the path**.
6. The adapter's only role in tool dispatch is **observing** the tool execution via the SSE stream — for telemetry, processingEnd timing, and turn-level finish-reason detection.

```
OpenCode adapter process tree at runtime:
  node dist/adapters/opencode/adapter.js          (agent-tempo adapter — manages lifecycle)
    └── opencode serve --port 4732 ...            (OpenCode subprocess — spawned by adapter)
          └── node /abs/path/to/dist/server.js    (agent-tempo MCP server — spawned by OpenCode for tool dispatch)
```

Three Node processes per opencode player. Memory cost is the trade-off; the architectural simplification is worth it.

### 4.2 Why we DON'T need a `mcp-bridge.ts` translation layer

Direct contrast with claude-api's `src/adapters/claude-api/mcp-bridge.ts` (158 LoC):

```
claude-api adapter:
  In-process MCP server (paired with in-process MCP client via InMemoryTransport)
       │  inputSchema → input_schema (Anthropic shape) ← mcp-bridge.ts (158 LoC)
       ▼
  Anthropic Messages API (HTTP)
       │  tool_use blocks streamed back
       ▼
  Adapter dispatches mcp.callTool(), assembles tool_result, feeds next turn

opencode adapter:
  stdio MCP server (spawned BY OpenCode, NOT by adapter)
       │  (no translation — OpenCode owns the contract)
       ▼
  OpenCode's tool registry
       │  OpenCode dispatches; adapter only observes via /event SSE
       ▼
  (Adapter unaware of tool execution mechanics; just consumes assistant.message text)
```

The 158 LoC of `mcp-bridge.ts` (Anthropic schema translation) has no analog in the OpenCode adapter. **This is the single largest LoC saving** vs claude-api. OpenCode's `ProviderTransform` ([DeepWiki — Prompt Orchestration](https://deepwiki.com/sst/opencode/2.3-prompt-orchestration)) handles per-provider quirks (Anthropic `input_schema`, OpenAI `parameters`, Mistral's 9-character alphanumeric tool call IDs, etc.) — that's OpenCode's job, not ours.

### 4.3 Transport choice — `type: "local"` stdio (locked)

Two transport options per OpenCode's MCP docs:

| Option | Shape | Pros | Cons |
|---|---|---|---|
| **(a) `type: "local"` stdio** ← **LOCKED** | OpenCode spawns `node dist/server.js` as its own MCP child process | Symmetric with `claude-api`'s in-process MCP server; no network surface; auto-cleanup on subprocess exit | Two MCP server processes per claude-api+opencode mixed-ensemble (one in-process for claude-api, one stdio-spawned for opencode); minor memory overhead |
| **(b) `type: "remote"` HTTP** | Adapter exposes the MCP server via HTTP; OpenCode connects via URL | Single MCP server instance shareable across adapters | Adds network surface (auth concerns), requires port allocation for MCP server, more wire surface to maintain |

**Locked: (a) `type: "local"` stdio.** Symmetric, simpler, no new transport surface. Phase 2 candidate to switch to `(b)` if the MCP-server-process count becomes a memory problem in mixed-ensemble setups (composes with subprocess-shared optimization).

### 4.4 Cross-provider tool consistency (Phase 2 follow-up)

OpenCode's tool dispatcher normalizes provider quirks, but there's a real Phase 2 question: **do all providers honor the same tool surface equally well?** An OpenAI GPT-4o player using `cue` may behave subtly differently from a Claude Opus 4.7 player using `cue` even if the tool schema is identical. Cross-provider parity testing is explicitly out-of-scope for Phase 1 per #449's body — but flagged as a Phase 2 follow-up.

---

## 5. Streaming + state

### 5.1 Conversation state — server-side, persisted by OpenCode

OpenCode's HTTP API persists session history server-side. Per Phase A spike §1.8, session lifecycle on the OpenCode side:

| Phase | OpenCode-side action | agent-tempo-side action |
|---|---|---|
| Create | `POST /session` returns `Session` with `id` | Stash `id` on workflow metadata via `updateMetadataSignal` (matches Copilot's `sessionId` stash pattern) |
| Send turn | `POST /session/:id/prompt_async` (preferred — 204 + observe via SSE) | Wrap in `SdkAttachment.deliver()` — `processingStart` → POST → wait for `finish` event → `processingEnd` → `markDelivered` |
| History | **Server-side persisted by OpenCode** | **No per-turn rebuild** (different from `claude-api`); trust OpenCode |
| Abort | `POST /session/:id/abort` | Wired to `onSuperseded()` lease-revocation hook — cleaner than killing the subprocess |
| Destroy | `DELETE /session/:id` | Called on graceful detach to free server resources |

**Server-side history is the structural simplification of #449 vs #131.** The Anthropic Messages API is stateless, so the `claude-api` adapter rebuilds conversation from `allMessagesQuery` + `allSentMessagesQuery` every turn (`buildAnthropicMessages()`, ~80 LoC). OpenCode owns history server-side, so the OpenCode adapter sends only the new turn's `parts` and OpenCode appends. **This eliminates the per-turn workflow-history-replay path entirely.**

### 5.2 The Q6 carry-forward — session persistence across server restart

The single Phase B → C carry-forward decision. OpenCode's TUI session-sharing feature suggests sessions persist across `opencode serve` restart, but the adapter MUST verify and pick a restart-path implementation:

**Path A — OpenCode persists**: adapter stashes `session.id` on workflow metadata at create time, re-attaches to the existing session-id on restart. **Simpler model, fewer LoC.**

**Path B — OpenCode does not persist**: adapter rebuilds OpenCode-side history from workflow `messages[]` + `sentMessages[]` on restart. Mirrors `claude-api`'s per-turn pattern, ~80 LoC.

**Architectural shape is identical either way** — the adapter still uses `updateMetadataSignal` to track the OpenCode session id; the difference is whether restart re-attaches or rebuilds. Phase C engineer runs a one-off impl-time experiment (`POST /session` → kill subprocess → restart → `GET /session/:id`) and picks the path. **Both paths are forward-compatible** — picking A and discovering it's wrong only adds the rebuild logic; picking B and discovering A would have worked just leaves dead code (deletable in a follow-up).

Recommend Phase C engineer time-box the experiment to ≤30 min and pick the simpler path A unless evidence forces B.

### 5.3 SSE consumption — `GET /event` stream

The adapter consumes OpenCode's `text/event-stream` over a long-lived `GET /event` connection. Events from a turn pipeline:

1. `Message` events — user input creates a `Message` with `Part` entries persisted individually
2. `ToolPart` events — tool resolution + tool execution (tool-use observability)
3. `TextPart` / `ReasoningPart` events — assistant streaming
4. **`finish` reason on assistant message** — turn completion signal

The adapter:

- Filters events to the active session id (multiple sessions may share an `opencode serve` instance — though Phase 1 is per-player, the filtering is cheap insurance)
- Accumulates `assistant.message` text parts into a running buffer
- Observes `ToolPart` events for telemetry breadcrumbs (`[agent-tempo:opencode] tool=cue parts=...` style)
- On `finish` reason, returns the assembled assistant text + finish reason from `invokeSdk`

**No `input_json_delta` partial-parse complexity** — tool streaming is OFF by default in v1.14.29 (Phase A spike §1.3). Tool calls arrive in a single completed event. This is a complexity-win over claude-api (where verification-addendum #4 documents the partial-parse landmine).

**Mid-stream errors** surface as event-stream entries; SSE consumer wraps in `try { … } catch { … }`. **Doom-loop detection** is built in upstream (repeated tool failures don't infinite-loop; context overflow triggers compaction). Adapter's responsibility shrinks vs claude-api.

### 5.4 `prompt_async` vs `message` — locked: `prompt_async` + SSE

Two ways to send a turn:

| Endpoint | Shape | Choice |
|---|---|---|
| `POST /session/:id/message` | Blocking — body has model/agent/system/tools/parts; returns the full assembled message | Rejected — defeats SSE observability; blocks the adapter HTTP call for the entire turn |
| `POST /session/:id/prompt_async` | 204 + stream via /event | **LOCKED** — the adapter posts, then consumes SSE; processingStart/End bracket only the SSE consumption |

`prompt_async` matches the `SdkAttachment.deliver()` pairing cleanly: `processingStart` → POST returns 204 → SSE consumption → finish event → `processingEnd` → `markDelivered`. The blocking variant would have `processingStart` covering the HTTP request itself, which is sub-optimal for stale-detection.

### 5.5 Doom-loop / context-compaction (Phase C verify-at-impl)

OpenCode has built-in doom-loop detection and context compaction. Phase A spike §7.5 flags this as an unknown for impl time:

- How does the adapter learn that compaction has happened? Does the SSE stream emit a `compacted` event?
- Does the next `GET /session/:id/message` show a different shape?

**Phase C engineer's responsibility.** The architectural shape doesn't change either way — the adapter just observes whichever signal OpenCode emits. Document the answer in `src/adapters/opencode/README.md` at impl time. **No agent-tempo-side context-overflow message** like claude-api §5.5 emits — OpenCode handles this upstream.

### 5.6 Per-turn usage telemetry

```ts
log(`turn-usage provider=${provider} model=${model} input=${usage.input_tokens ?? 0} output=${usage.output_tokens ?? 0} cache_read=${usage.cache_read_input_tokens ?? 0} elapsed_ms=${elapsedMs} player=${playerName} stop_reason=${stopReason ?? 'none'}`);
```

Same shape family as `claude-api`'s `[agent-tempo:claude-api] turn-usage` log line — operators already grep `turn-usage` for cost monitoring. Provider attribution added (`provider=anthropic` / `provider=openai`).

**Per-provider semantics differ**: Anthropic exposes `cache_read` / `cache_creation`; OpenAI doesn't have those concepts. Adapter logs whatever's present in OpenCode's event-stream `usage` field, doesn't try to normalize across providers. Operators triaging burn rate know provider-specific shapes.

**No wire-protocol signal in v1** — same forward-compatibility argument as claude-api §5.6. When a consumer (cost dashboard / per-session cap / ensemble-level budget) lands, add `recordTurnUsage` signal at that time.

### 5.7 Subprocess lifecycle — spawn / health-probe / log redirection

The adapter spawns `opencode serve` between Temporal connect and attachment claim:

1. **Probe a free port** (port-file pattern from `src/http/server.ts`)
2. **Spawn `opencode serve --port <probed> --hostname 127.0.0.1`** with `OPENCODE_CONFIG_CONTENT` env populated
3. **Redirect stdout/stderr** to `~/.agent-tempo/opencode-{playerId}.log` (per Phase A spike §1.7 — terminal noise reduction acknowledged in OpenCode's own changelog)
4. **Health-probe** `GET /global/health` until 200 (timeout-bounded — fail loudly if OpenCode doesn't come up in 10s)
5. **Version-drift check** — log `WARNING: opencode version X.Y.Z drift from tested ~1.14.29` if mismatch (locked: warn-only)
6. **Then** proceed to `startV2Lifecycle(workflowId)` and the poll loop

The adapter records the OpenCode subprocess PID alongside its own PID in `logs/{playerId}.pid` (one file with two PIDs — adapter PID and OpenCode subprocess PID, separated by newline) so operators can find / kill orphans cleanly.

---

## 6. Cancellation + lifecycle

### 6.1 Lease revocation → graceful abort first, subprocess kill fallback

```ts
class OpenCodeAttachment extends SdkAttachment {
  private openCodeSessionId: string | null = null;
  private serveProcess: ChildProcess | null = null;
  private inFlightAbortController: AbortController | null = null;

  protected onSuperseded(): void {
    // Path 1: graceful — POST /session/:id/abort. Most cases land here.
    if (this.openCodeSessionId && this.serveProcess) {
      void this.abortGracefully().catch((err) => {
        log('graceful abort failed:', (err as Error)?.message ?? err);
        // Path 2 (fallback): subprocess SIGTERM. Only if HTTP abort hangs.
        this.killSubprocess('SIGTERM');
      });
    }
    // The active fetch (SSE stream consumer) is also aborted via AbortController
    this.inFlightAbortController?.abort();
  }

  private async abortGracefully(): Promise<void> {
    const ctrl = new AbortController();
    const timeout = setTimeout(() => ctrl.abort(), 3000);   // 3s timeout
    try {
      await fetch(`http://127.0.0.1:${this.port}/session/${this.openCodeSessionId}/abort`, {
        method: 'POST',
        signal: ctrl.signal,
      });
    } finally {
      clearTimeout(timeout);
    }
  }

  private killSubprocess(sig: 'SIGTERM' | 'SIGKILL'): void {
    const p = this.serveProcess;
    if (!p || p.killed) return;
    try { p.kill(sig); } catch (err) { log(`kill(${sig}) threw:`, err); }
  }
}
```

`SdkAttachment`'s phase watcher fires `onSuperseded()` when `attachmentInfo.currentAttachment.attachmentId` diverges from our token. The adapter:

1. Aborts the in-flight `fetch` (SSE consumer or `prompt_async` POST)
2. Posts to `/session/:id/abort` — graceful, no subprocess kill required
3. Falls back to `SIGTERM` if the HTTP abort hangs (3s timeout)
4. Falls back to `SIGKILL` if SIGTERM doesn't terminate within 5s (further timeout in graceful detach path, §6.4)

`processingEnd` fires in the inherited `finally` per `SdkAttachment.deliver()`, and the workflow's outbox retry on next deliver re-attempts the turn (lease loss → exit, no retry inside the adapter for v1).

### 6.2 No reconnect opt-in

Per `src/adapters/README.md` guidance for SDK adapters. `OpenCodeAttachment` does NOT override `shouldReconnect()`. Lease loss exits the process; daemon `reconcile-on-boot` (or operator `restart`) recovers.

**Worth flagging for Phase 2 revisit**: OpenCode's server-side persistence makes reconnect more architecturally attractive than for claude-api — the OpenCode session is alive and recoverable across adapter restart. Reconnect path would: re-claim attachment → re-attach to existing OpenCode session-id (Q6 path A) → resume SSE consumption. ~50 LoC delta if Phase 2 picks this up.

### 6.3 Heartbeat cadence

`heartbeatMs: 30_000` per the SDK-class default in `docs/design/session-lifecycle-rebuild-v2.md` §4.3. Inherited from `SdkAttachment`'s descriptor convention — no override.

### 6.4 Graceful detach

On `cleanup()` (terminal callback or signal handler):

1. **Abort in-flight turn** (if any) — `inFlightAbortController.abort()` + `POST /session/:id/abort`
2. **Delete OpenCode session** — `DELETE /session/:id` to free server resources (best-effort; swallow errors if subprocess is already dead)
3. **SIGTERM the subprocess** — graceful Bun shutdown; 5s timeout
4. **SIGKILL the subprocess** if SIGTERM didn't terminate
5. **Detach gracefully** — `this.detachGracefully('user-stop')` → fires `adapterExited` → workflow collapses `draining` → `detached`
6. **Unlink PID file**

Steps 1-4 are wrapped in idempotent guards so racing signals (SIGINT during cleanup, terminal callback firing twice) don't double-kill. Mirrors `claude-api`'s cleanup wiring at `src/adapters/claude-api/adapter.ts:259-273`.

### 6.5 PID file format

```
<adapter-PID>
<opencode-serve-PID>
```

Two-line file at `logs/{playerId}.pid`. Operators can grep / kill either or both. Maintenance: clean up on shutdown (best-effort `unlinkSync`); daemon reconcile-on-boot reads and validates against `process.kill(pid, 0)` for orphan detection.

---

## 7. Wire-protocol implications

**Zero new signals/queries/updates on `claudeSessionWorkflow`.** The adapter uses the existing surface (identical to claude-api §7):

| Surface | Use |
|---|---|
| `claimAttachmentUpdate` | Inherited from `BaseAttachment.startV2Lifecycle` |
| `heartbeatSignal` | Inherited |
| `processingStartUpdate` / `processingEndUpdate` | Inherited from `SdkAttachment.deliver()` |
| `markDeliveredSignal` | Inherited from `SdkAttachment.deliver()` |
| `attachmentInfoQuery` | Inherited from `BaseAttachment` phase watcher |
| `updateMetadataSignal` | OpenCode `Session.id` stashed via the **existing `sessionId` field** on the signal payload — same field Copilot already uses for its session id. OpenCode joins as the second consumer; **no new field on the signal**. The skeleton at §8.1 emits `signal(updateMetadataSignal, { sessionId: session.id })`. |
| `requestDetachSignal` / `adapterExitedSignal` | Inherited from `SdkAttachment.detachGracefully` |

**Not used by this adapter** (different from claude-api):

- `allMessagesQuery` / `allSentMessagesQuery` — only consumed by Q6 path B (workflow-history replay on restart). If Phase C picks path A, these queries aren't read at all.
- `pendingMessagesQuery` — yes, this one IS used by the poll loop (same as copilot / claude-api).
- `receiveMessageSignal` — NOT used. claude-api uses this to deliver context-overflow messages; OpenCode handles context-compaction upstream so the adapter doesn't need this path.

The only wire-protocol-doc touchpoint is the `agentType: 'opencode'` extension. `docs/WIRE-PROTOCOL.md` doesn't enumerate AgentType values today — no doc change required there.

`SessionMetadata.agentType` accepts the new value via the AgentType type extension (§3.2). Old workflow runs that pre-date this PR have `agentType` as `'claude' | 'copilot' | 'mock' | 'claude-api'` only; the new value appears only on freshly-recruited opencode players. Strictly additive.

### 7.1 Phase C implementation steps that touch shared surface

Two small, additive changes the Phase C engineer must land **in the implementation PR** (not retroactively in this design PR):

1. **`docs/WIRE-PROTOCOL.md`** — extend the `sessionId` field description on `updateMetadata` to note that OpenCode joins Copilot as a consumer (the field stores the OpenCode `Session.id` returned by `POST /session`). Same field, second use; no schema change. This keeps the wire-protocol doc honest about which adapters write the field — surfaces the reuse to anyone auditing the surface later.
2. **`src/config.ts`** — add `OPENCODE_MODEL: 'CLAUDE_TEMPO_OPENCODE_MODEL'` to the `ENV` constant (declared next to the existing `API_MODEL: 'CLAUDE_TEMPO_API_MODEL'`). The skeleton at §8.1 references `process.env[ENV.OPENCODE_MODEL]` in the constructor; the constant must be declared before the adapter compiles. The env var is also referenced in §3.4's spawn-env table — both call-sites resolve to the same constant once added.

Neither is a wire-protocol break; both are bookkeeping that lives alongside the adapter code.

---

## 8. Engineer-facing skeleton + LoC tightening

### 8.1 Skeleton

```ts
// src/adapters/opencode/adapter.ts (skeleton, ~350-500 LoC actual)

import * as fs from 'fs';
import * as net from 'net';
import * as os from 'os';
import * as path from 'path';
import { spawn, ChildProcess } from 'child_process';
import { Client, WorkflowHandle } from '@temporalio/client';
import type { Message, AdapterDescriptor } from '../../types';
import { SdkAttachment, type SdkDeliverResult } from '../sdk/base';
import { ENV, getConfig } from '../../config';
import { createTemporalConnection } from '../../connection';
import {
  pendingMessagesQuery, isDestroyedQuery,
  updateMetadataSignal,
} from '../../workflows/signals';
import { synthesizeOpenCodeConfig, type ProviderEnvMap } from './config';
import { OpenCodeServerBridge } from './server-bridge';

let OpenCodeSdk: unknown;
try {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  OpenCodeSdk = require('@opencode-ai/sdk');
} catch {
  if (require.main === module) {
    console.error(
      'Error: @opencode-ai/sdk is not installed.\n' +
      'Install it with: npm install @opencode-ai/sdk\n' +
      'Or recruit with a different agent (claude / copilot / claude-api).',
    );
    process.exit(1);
  }
}

const log = (...args: unknown[]) => {
  const msg = `[agent-tempo:opencode] ${args.map((a) => typeof a === 'string' ? a : JSON.stringify(a)).join(' ')}\n`;
  fs.writeSync(2, msg);
};

export const opencodeDescriptor: AdapterDescriptor = {
  adapterId: 'opencode',
  adapterClass: 'sdk',
  blocksOnLLMTurn: true,
  heartbeatMs: 30_000,
};

const DEFAULT_MODEL = 'anthropic/claude-opus-4-7';
const POLL_INTERVAL_MS = 2000;
const WORKFLOW_REGISTER_ATTEMPTS = 30;
const WORKFLOW_REGISTER_INTERVAL_MS = 1000;
const WORKFLOW_STATUS_CHECK_INTERVAL = 15;
const TURN_TIMEOUT_MS = 5 * 60 * 1000;
const TESTED_OPENCODE_VERSION = '~1.14.29';
const HEALTH_PROBE_TIMEOUT_MS = 10_000;
const GRACEFUL_ABORT_TIMEOUT_MS = 3000;
const SIGTERM_TIMEOUT_MS = 5000;
const HEADLESS_OPENCODE_ADDENDUM =
  '\n\nYou are an **opencode** player — you have access to the agent-tempo MCP tools ' +
  '(cue, report, recall, ensemble, broadcast, recruit, set_part, …) AND OpenCode\'s built-in ' +
  'tools (file edits, shell, web search). Use the agent-tempo tools for ensemble coordination ' +
  'and OpenCode\'s built-ins for local task work. Your model is delivered via OpenCode, so the ' +
  'underlying provider (Anthropic, OpenAI, Bedrock, Ollama, …) is opaque to you and to the rest ' +
  'of the ensemble.';

export class OpenCodeAttachment extends SdkAttachment {
  readonly descriptor: AdapterDescriptor = opencodeDescriptor;

  private model: string;
  private port = 0;
  private serveProcess: ChildProcess | null = null;
  private bridge: OpenCodeServerBridge | null = null;
  private openCodeSessionId: string | null = null;
  private inFlightAbortController: AbortController | null = null;
  private playerName = '';
  private systemPrompt = '';

  constructor(opts: { model?: string } = {}) {
    super();
    this.model = opts.model
      ?? process.env[ENV.OPENCODE_MODEL]   // NEW env var — keeps namespace clean from claude-api's API_MODEL
      ?? DEFAULT_MODEL;
  }

  protected onSuperseded(): void {
    log('lease revoked — aborting in-flight + posting /session/abort');
    this.inFlightAbortController?.abort();
    this.inFlightAbortController = null;
    if (this.openCodeSessionId && this.bridge) {
      void this.bridge.abortSession(this.openCodeSessionId)
        .catch((err) => log('graceful abort failed:', (err as Error)?.message ?? err));
    }
  }

  async run(): Promise<void> {
    if (!OpenCodeSdk) {
      throw new Error('@opencode-ai/sdk not installed — adapter cannot start.');
    }
    const config = getConfig();
    const isConductor = process.env[ENV.CONDUCTOR] === 'true';
    const requestedName = process.env[ENV.PLAYER_NAME] || '';
    const playerIdForWorkflow = isConductor
      ? 'conductor'
      : (requestedName && requestedName !== 'conductor' ? requestedName : '') || `opencode-${Date.now()}`;
    const expectedWorkflowId = `claude-session-${config.ensemble}-${playerIdForWorkflow}`;
    const workDir = process.cwd();

    log(`Starting opencode adapter in ${workDir} (ensemble: ${config.ensemble}, player: ${playerIdForWorkflow}, model: ${this.model})`);

    // 1. Probe a free port
    this.port = await probeFreePort();
    log(`Probed free port: ${this.port}`);

    // 2. Synthesize OPENCODE_CONFIG_CONTENT (provider-aware, secrets via {env:...} substitution)
    const configContent = synthesizeOpenCodeConfig({
      model: this.model,
      port: this.port,
      mcpServerPath: path.resolve(__dirname, '../../server.js'),
      ensemble: config.ensemble,
      playerName: playerIdForWorkflow,
      temporalAddress: config.temporalAddress,
      temporalNamespace: config.temporalNamespace,
      providerEnv: detectProviderEnvFromModel(this.model),
    });
    log(`Synthesized OPENCODE_CONFIG_CONTENT (secrets redacted): ${redactSecrets(configContent)}`);

    // 3. Spawn opencode serve, redirected to logs/opencode-{playerId}.log
    const logFile = path.join(workDir, 'logs', `opencode-${playerIdForWorkflow}.log`);
    fs.mkdirSync(path.dirname(logFile), { recursive: true });
    const logFd = fs.openSync(logFile, 'a');
    this.serveProcess = spawn(
      'opencode',
      ['serve', '--port', String(this.port), '--hostname', '127.0.0.1'],
      {
        stdio: ['ignore', logFd, logFd],
        env: { ...process.env, OPENCODE_CONFIG_CONTENT: configContent },
        detached: false,
      },
    );
    log(`Spawned opencode serve (pid=${this.serveProcess.pid}, port=${this.port})`);

    // 4. Health-probe + version check
    this.bridge = new OpenCodeServerBridge(`http://127.0.0.1:${this.port}`, log);
    await this.bridge.waitForHealth(HEALTH_PROBE_TIMEOUT_MS);
    const health = await this.bridge.getHealth();
    if (!isVersionMatch(health.version, TESTED_OPENCODE_VERSION)) {
      log(`WARNING: opencode version ${health.version} drift from tested ${TESTED_OPENCODE_VERSION}`);
    }

    // 5. Connect Temporal, wait for workflow registration, claim attachment
    const connection = await createTemporalConnection(config);
    const client = new Client({ connection, namespace: config.temporalNamespace });
    this.configureV2(client, os.hostname());
    let handle = await waitForWorkflow(client, expectedWorkflowId);   // helper — same shape as claude-api

    // 6. Build cached system prompt (agent-tempo MCP_INSTRUCTIONS + OpenCode-specific addendum)
    this.systemPrompt = buildServerInstructions({
      ensemble: config.ensemble,
      playerId: playerIdForWorkflow,
      isConductor,
      hasRequestedName: true,
    }) + HEADLESS_OPENCODE_ADDENDUM;
    this.playerName = playerIdForWorkflow;

    // 7. Wire terminal cleanup BEFORE claim (race-safe)
    let shuttingDown = false;
    const cleanup = async () => {
      if (shuttingDown) return;
      shuttingDown = true;
      log('Cleanup running...');
      try {
        if (this.openCodeSessionId && this.bridge) {
          await this.bridge.abortSession(this.openCodeSessionId).catch(() => {});
          await this.bridge.deleteSession(this.openCodeSessionId).catch(() => {});
        }
      } catch { /* best-effort */ }
      try { await this.detachGracefully('user-stop'); }
      catch (err) { log('detachGracefully error:', (err as Error)?.message ?? err); }
      // SIGTERM → SIGKILL with timeout
      if (this.serveProcess && !this.serveProcess.killed) {
        try { this.serveProcess.kill('SIGTERM'); } catch {}
        await waitForExit(this.serveProcess, SIGTERM_TIMEOUT_MS);
        if (!this.serveProcess.killed) {
          try { this.serveProcess.kill('SIGKILL'); } catch {}
        }
      }
    };
    this.onTerminal((reason) => {
      log(`V2 terminal (${reason}) — triggering cleanup`);
      cleanup().catch((err) => log('terminal cleanup error:', err));
    });

    // 8. Claim attachment via V2 lifecycle
    try {
      const expectedAttachmentId = process.env[ENV.ATTACHMENT_ID] || undefined;
      handle = await this.startV2Lifecycle(expectedWorkflowId, expectedAttachmentId);
      log(`V2 attachment claimed (attachmentId=${this.token?.attachmentId})`);
    } catch (err) {
      log(`ERROR: V2 claim failed: ${(err as Error)?.message ?? err}`);
      await cleanup();
      process.exit(1);
    }

    // 9. PID file (two-line: adapter PID + opencode subprocess PID)
    const pidDir = path.join(workDir, 'logs');
    const pidFile = path.join(pidDir, `${playerIdForWorkflow}.pid`);
    try {
      fs.writeFileSync(pidFile, `${process.pid}\n${this.serveProcess.pid ?? ''}\n`);
    } catch (err) {
      log(`Warning: PID file write failed: ${(err as Error)?.message ?? err}`);
    }

    // 10. Signal handlers
    const shutdown = async () => {
      log('Shutting down (signal received)...');
      await cleanup();
      try { fs.unlinkSync(pidFile); } catch { /* gone */ }
      process.exit(0);
    };
    process.on('SIGINT', shutdown);
    process.on('SIGTERM', shutdown);

    // 11. Drive the poll loop
    await this.pollLoop(handle);
    try { fs.unlinkSync(pidFile); } catch { /* gone */ }
  }

  private async pollLoop(handle: WorkflowHandle): Promise<void> {
    // Same shape as claude-api's pollLoop — query pendingMessages, deliver per turn,
    // periodic workflow-status check. See src/adapters/claude-api/adapter.ts:324-400.
    // ...
  }

  protected async invokeSdk(_prompt: string, _timeoutMs: number): Promise<SdkDeliverResult> {
    if (!this.bridge) throw new Error('OpenCodeAttachment invokeSdk called before run() finished initialization');

    // 1. Ensure OpenCode session exists. First turn: POST /session, stash the OpenCode
    //    Session.id on workflow metadata via updateMetadataSignal's existing `sessionId`
    //    field (reused — same field copilot uses; see §7 wire-protocol note).
    //    Subsequent turns: re-use stashed id. Restart path: see §5.2 (Q6 verify-at-impl).
    if (!this.openCodeSessionId) {
      const session = await this.bridge.createSession();
      this.openCodeSessionId = session.id;
      await this.pinnedHandle!.signal(updateMetadataSignal, { sessionId: session.id });
      log(`Created OpenCode session ${session.id}`);
    }

    // 2. Build the new turn's parts. agent-tempo MCP server runs as OpenCode's child;
    //    the messages from the workflow's pendingMessages are flattened into a single
    //    user-prompt parts array. (Multi-cue batching mirrors claude-api's history sort.)
    const pendingMessages = await this.pinnedHandle!.query(pendingMessagesQuery) as Message[];
    const parts = pendingMessages.map((m) => ({ type: 'text', text: `[from ${m.from}]: ${m.text}` }));

    // 3. Post prompt_async, observe SSE for finish.
    this.inFlightAbortController = new AbortController();
    const t0 = Date.now();
    let assistantText = '';
    let stopReason: string | null = null;
    let usage: Record<string, number> | null = null;

    try {
      // 3a. Subscribe to /event SSE (filtered to this session id)
      const sse = this.bridge.subscribeEvents(this.openCodeSessionId, this.inFlightAbortController.signal);

      // 3b. Post prompt_async (returns 204; turn streams over SSE)
      await this.bridge.promptAsync(this.openCodeSessionId, {
        model: this.model,
        system: this.systemPrompt,
        parts,
      });

      // 3c. Consume SSE until finish
      for await (const event of sse) {
        if (event.session_id !== this.openCodeSessionId) continue;   // ignore other sessions
        if (event.type === 'assistant.message.text') assistantText += event.text;
        if (event.type === 'tool.use') log(`tool=${event.name} session=${event.session_id}`);
        if (event.type === 'assistant.message.finish') {
          stopReason = event.finish_reason;
          usage = event.usage ?? null;
          break;
        }
        if (event.type === 'error') {
          throw new Error(`OpenCode SSE error: ${event.message ?? 'unknown'}`);
        }
      }
    } finally {
      this.inFlightAbortController = null;
    }

    // 4. Per-turn telemetry — design §5.6 stderr-only shape
    if (usage) {
      const provider = this.model.split('/')[0];
      log(`turn-usage provider=${provider} model=${this.model} input=${usage.input_tokens ?? 0} output=${usage.output_tokens ?? 0} cache_read=${usage.cache_read_input_tokens ?? 0} elapsed_ms=${Date.now() - t0} player=${this.playerName} stop_reason=${stopReason ?? 'none'}`);
    }

    return {
      sdkResult: { assistantText, stopReason, usage },
      elapsedMs: Date.now() - t0,
    };
  }

  // helpers: shouldStop(), waitForWorkflow(), probeFreePort(), waitForExit(),
  // detectProviderEnvFromModel(), redactSecrets(), isVersionMatch() —
  // see commit notes for placement (some inline, some in `./helpers.ts`).
}

if (require.main === module) {
  if (!OpenCodeSdk) process.exit(1);
  const model = process.env[ENV.OPENCODE_MODEL];
  new OpenCodeAttachment(model ? { model } : {}).run().catch((err) => {
    log('Fatal error:', err);
    process.exit(1);
  });
}
```

The companion `src/adapters/opencode/server-bridge.ts` (~150-250 LoC) handles HTTP/SSE plumbing:

- `waitForHealth(timeoutMs)` — poll `/global/health` until 200 or timeout
- `getHealth()` — `{ healthy, version }`
- `createSession()` — `POST /session`
- `promptAsync(sessionId, body)` — `POST /session/:id/prompt_async`
- `abortSession(sessionId)` — `POST /session/:id/abort`
- `deleteSession(sessionId)` — `DELETE /session/:id`
- `subscribeEvents(sessionId, abortSignal)` — `AsyncGenerator<OpenCodeEvent>` over `GET /event` SSE

Phase C engineer decides whether to use `@opencode-ai/sdk` or raw `fetch` for these — see §8.3 LoC tightening below.

### 8.2 Module layout

```
src/adapters/opencode/
├── adapter.ts          # OpenCodeAttachment class + self-exec entry point (~350-500 LoC)
├── server-bridge.ts    # HTTP/SSE client wrapping @opencode-ai/sdk or raw fetch (~150-250 LoC)
├── config.ts           # synthesizeOpenCodeConfig(), provider env detection (~50-80 LoC)
├── helpers.ts          # probeFreePort, waitForExit, redactSecrets, isVersionMatch (~30-50 LoC)
├── index.ts            # descriptor + barrel re-exports (matches claude-api/index.ts)
└── README.md           # adapter contract + Q6 outcome documentation (~50 LoC)
```

Five files — same module density as `src/adapters/claude-api/`.

### 8.3 LoC tightening proposals

Phase A spike's bottom-up estimate is **805-1,175 LoC**. #449's body cites a 600-1,000 ceiling. The high end (1,175) exceeds the ceiling by ~17%. Three concrete tightening proposals to land back inside 1,000:

1. **Shared SDK-class lifecycle test helper** (-80 to -150 LoC). The Mocha integration test for the new adapter currently looks like it'd duplicate the SDK-class lifecycle baseline (`test/adapter-sdk-lifecycle-v2.test.ts`). Extract the SDK-class lifecycle cases (claim → first heartbeat → processingStart/End pairing → markDelivered → graceful detach → superseded abort) into a shared helper (`test/helpers/sdk-class-lifecycle.ts`) that both copilot, claude-api, and the new opencode test consume. Yields recurring savings: future SDK-class adapters (advisor strategy, etc.) all reuse the helper.
2. **Raw `fetch` over `@opencode-ai/sdk`** if SDK weight bites (-50 to -100 LoC). The auto-generated SDK adds OpenAPI runtime + per-endpoint typed clients. The hot path uses ~5 endpoints + SSE. Hand-rolled `server-bridge.ts` over raw `fetch` is leaner and avoids an additional dependency. Phase C engineer makes the call after a quick sizing experiment. **Architectural shape unchanged either way.**
3. **Narrower v1 telemetry surface** (-20 to -40 LoC). Phase C should ship the stderr `turn-usage` line + the `WARNING: opencode version drift` line, but defer the more elaborate breadcrumbs (`tool=cue session=...` per-tool-use logs) to a Phase 2 enhancement. Operators can grep `[agent-tempo:opencode]` for adapter health; per-tool-use breadcrumbs are diagnostic richness, not v1 critical path.

**Combined potential savings: 150-290 LoC**, comfortably landing the v1 implementation inside #449's 1,000-LoC ceiling. Phase C engineer picks the actual tightening; design-doc commitment is "the architecture supports landing inside the ceiling, here's how."

---

## 9. Test strategy

### 9.1 Unit (Vitest, `tests/`)

- `tests/adapters/opencode.test.ts` — mock `OpenCodeServerBridge` (in-process http server stub). Cases:
  - Single-turn (no tool_use) — assistant text reaches workflow via markDelivered
  - SSE event consumption assembles text correctly when split across multiple `assistant.message.text` events
  - SSE error events propagate as thrown errors
  - `onSuperseded()` posts `/session/abort` AND aborts in-flight `inFlightAbortController`
  - `onSuperseded()` falls back to SIGTERM if abort hangs (3s timeout)
  - Subprocess SIGTERM fails over to SIGKILL after 5s
  - Version-drift warning logs on minor mismatch (`1.14.30` vs tested `~1.14.29`)
  - `OPENCODE_CONFIG_CONTENT` synthesis includes correct model + MCP block + provider auto-detection
  - Synthesized config redacts API keys in stderr log
- `tests/adapters/opencode-config.test.ts` — `synthesizeOpenCodeConfig()` cases:
  - Anthropic provider auto-detected from `model: 'anthropic/...'`
  - OpenAI provider auto-detected from `model: 'openai/...'`
  - Ollama provider auto-detected from `model: 'ollama/...'`
  - Multi-provider env (both ANTHROPIC_API_KEY and OPENAI_API_KEY set) — config includes both `provider.anthropic.options` and `provider.openai.options`
  - mDNS `false` always set
  - Hostname `127.0.0.1` always hardcoded
- `tests/tools/recruit.test.ts` — extend with `agent: 'opencode'` cases:
  - Pre-flight rejects when `@opencode-ai/sdk` not installed
  - Pre-flight rejects when `opencode` binary not on PATH
  - `model` regex accepts `'anthropic/claude-opus-4-7'`, `'openai/gpt-4o'`, `'ollama/llama3'`
  - `model` regex still accepts the legacy claude-api-only forms (`'claude-opus-4-7'`)
  - `model` flows through to outbox entry
  - Cross-host recruit (`host:` set) skips local pre-flight; delegates to target daemon's `availableAgentTypes`

### 9.2 Workflow integration (Mocha, `test/`)

- `test/adapter-sdk-lifecycle-v2.test.ts` (existing) — extract SDK-class lifecycle cases into `test/helpers/sdk-class-lifecycle.ts` per §8.3 proposal #1. Both copilot, claude-api, and opencode lifecycle tests call into the helper.
- `test/adapter-opencode-lifecycle-v2.test.ts` (**NEW**, naming follows the existing `adapter-{id}-lifecycle-v2.test.ts` convention used by claude-api) — opencode-specific integration with mock `opencode serve` (in-process http server stub):
  - Spawn → claim → turn (with mocked SSE events) → detach
  - `processingStart` / `End` pairing fires correctly per turn
  - `inFlightAbortController` propagates on superseded
  - `POST /session/:id/abort` is the first cancellation path
  - SIGTERM fallback fires only after HTTP abort timeout
  - Subprocess cleanup on graceful detach (DELETE session → SIGTERM → SIGKILL)
  - Version-drift warning emitted on mismatch
  - PID file format (two-line: adapter + opencode-serve)
- Wire-protocol drift detector — no new wire surface; detector is a no-op for this PR. Detector still validates that `claimAttachment` / `heartbeat` / `processingStart` / `processingEnd` / `markDelivered` / `updateMetadata` are referenced (they are, via `SdkAttachment` inheritance + `updateMetadataSignal` usage in §5).

### 9.3 Manual smoke

- Recruit an `opencode` player against a real `opencode` binary + real `ANTHROPIC_API_KEY` + `model: 'anthropic/claude-opus-4-7'`; verify it cues, reports, recalls, and detaches cleanly.
- Same with `model: 'openai/gpt-4o'` + `OPENAI_API_KEY` — multi-provider e2e.
- Force superseded via `restart` — verify abort fires before subprocess kill, ghost reply doesn't land.
- Kill the subprocess externally (`kill -9 $(cat logs/opencode-X.pid | tail -1)`) — verify the adapter detects and exits cleanly via the periodic workflow-status check.
- Q6 verification: kill `opencode serve` process, restart adapter — verify session-id re-attach (path A) or workflow-history replay (path B). Pick the simpler path. Document outcome in `src/adapters/opencode/README.md`.
- Cross-platform: same scenarios on macOS, Linux, Windows. Bun runtime on Windows handles SIGINT/SIGTERM differently from POSIX — exercise.

### 9.4 Wire-protocol drift detector

No new wire surface — drift detector is a no-op for this PR. The detector still validates the inherited references (claimAttachment, heartbeat, processingStart/End, markDelivered, updateMetadata).

---

## 10. System prompt scaffolding

The OpenCode adapter needs a system prompt that establishes the player as part of a tempo ensemble — same `MCP_INSTRUCTIONS` reuse pattern as `claude-api` §10. The shared instructions document:

- Ensemble identity
- Player name + role
- Available agent-tempo MCP tools (cue, report, recall, ensemble, …)
- Coordination conventions (broadcast intent before branch switches, conductor authority, etc.)

Implementer pulls the same `buildServerInstructions(...)` output into the system prompt at session-init time (one-shot, lives in OpenCode's per-session system context — note: NOT explicitly cached client-side because OpenCode handles caching server-side per its provider transform layer).

**Headless-identity addendum is OPENCODE-SPECIFIC** — distinct from claude-api's addendum.

claude-api's addendum tells the model "you do NOT have file edit / shell / web tools" because claude-api has no analog. **OpenCode's addendum says the opposite**: the player IS file-op-capable through OpenCode's own built-in tool registry:

```
You are an **opencode** player — you have access to the agent-tempo MCP tools
(cue, report, recall, ensemble, broadcast, recruit, set_part, …) AND OpenCode's
built-in tools (file edits, shell, web search). Use the agent-tempo tools for
ensemble coordination and OpenCode's built-ins for local task work. Your model
is delivered via OpenCode, so the underlying provider (Anthropic, OpenAI,
Bedrock, Ollama, …) is opaque to you and to the rest of the ensemble.
```

This is the substantive UX delta vs claude-api: opencode players are full-power, just multi-provider. The addendum lives in OpenCode's `system` field on the `POST /session/:id/prompt_async` body — sent every turn (cheap; the prompt is small).

---

## 11. Phase 2 forward-work hooks (deliberately out of scope)

| Phase 2 candidate | Rationale for v1 deferral |
|---|---|
| **Cross-provider tool parity testing** | Per #449's body explicitly out of scope for Phase 1. OpenAI GPT-4o and Claude Opus 4.7 may behave subtly differently using the same `cue` tool schema. |
| **Subprocess-shared `opencode serve`** | Memory savings ~50-100 MB per player, but lifecycle coupling (stuck `prompt_async` blocks all sessions on the shared server) is worse trade-off for v1. |
| **`type: "remote"` MCP transport** | Share single MCP server across all adapter types via daemon HTTP; composes with #94/#95. Reduces per-player MCP-server-process count. |
| **OpenCode OAuth flows** | Provider-specific OAuth (GitHub Copilot via OpenCode, ChatGPT account-based) bypassed in v1 via env-var pass-through. Verify whether agent-tempo can pass through cleanly or needs a wrapper. |
| **Per-provider quota / throttling awareness** | Distinct from stderr-only telemetry. Different providers have different rate-limit shapes; aggregation by provider per ensemble. |
| **OpenCode version-drift CI** | Pin against latest `~1.14.x` in CI; detect breaking changes within 24h of each minor release. Matches OpenCode's daily cadence. |
| **Per-turn usage signal + workflow-side aggregation** | When a consumer (cost dashboard / per-session cap / ensemble-level budget) lands, add `recordTurnUsage` signal at that time. Same Phase 2 candidate as claude-api #131's deferred follow-up. |
| **Auto-compact + restart on context overflow** | OpenCode handles context-compaction upstream; if the adapter ever needs to surface a "session reset" event to the workflow, that's a Phase 2 wire-up. |
| **Reconnect opt-in for SDK adapters** | OpenCode's server-side persistence makes reconnect more attractive than for claude-api (the OpenCode session is alive across adapter restart). ~50 LoC delta if Phase 2 picks this up. |
| **Advisor strategy (composes with multi-provider)** | Per-player advisor opt-in could pick `model: 'openai/gpt-4o'` for executor and `model: 'anthropic/claude-opus-4-7'` for advisor, both via OpenCode adapters. File a separate issue when advisor strategy is ready. |

---

## 12. Sequencing

### 12.1 Independence

- **#318 coat-check** — orthogonal (different storage, different scope); either can ship first.
- **#319 protobuf migration** — additive on JSON wire; when protobuf migration lands, the new `agentType: 'opencode'` value goes through the same wire transition as everything else. Single-string-enum addition; minimal protobuf surface.
- **#334 saveable-state** — composes naturally; v1 doesn't depend on it. OpenCode's server-side context-compaction obviates the auto-compact path that claude-api §5.5 emits.
- **#94/#95 SSE event source** — adapter doesn't observe daemon SSE in v1; Phase 5+ adapter-state.changed events are additive.
- **#131 claude-api** — JUST MERGED (PR #455). Composes structurally — both SDK-class, both inherit `SdkAttachment`, both use the same tempo MCP surface. Documented as the Anthropic-only fallback for operators who want to avoid the third-party dep.

### 12.2 Recommended drop point

Single PR, ~805-1,175 LoC bottom-up (with §8.3 tightening, can land back inside 1,000). Estimated 2-3 days for engineer pickup. Phase C engineer needs:

- Familiarity with `SdkAttachment` lifecycle (`src/adapters/sdk/base.ts`) — same primer as claude-api Phase C
- Comfort with HTTP / SSE consumption — the new piece
- Cross-platform spawn / signal handling instincts (Bun on Windows is a different beast)

Recommended sequencing: drop after current dashboard parity (#454 series, #460 just landed) finishes, so we don't have multiple adapter-layer-touching PRs in flight. **Recruiter / engineer pickup**: open to the conductor's call; would naturally land with `tempo-eng` or `tempo-lead` per their availability after dashboard parity wraps.

### 12.3 Phase 2 prerequisites

When advisor strategy is added in Phase 2, the model selection knob (§3.1, §3.6) extends naturally — advisor consultation calls `bridge.promptAsync({ model: ADVISOR_MODEL })` independently of the session default. v1's `model` field becomes a session default; advisor can override per-turn.

When subprocess-shared optimization is added in Phase 2, the per-player session-id stash (§5.1) becomes a per-server multi-session-id stash, with routing in the `subscribeEvents` filter. ~80 LoC delta; architectural shape unchanged.

---

## 13. Decision log — answers to researcher's 7 open questions

| Q | Researcher lean | Locked decision | Rationale (where it differs) |
|---|---|---|---|
| Q1: Subprocess-per-player vs shared | Per-player | **Per-player** | Confirmed; Phase 2 candidate to switch if memory becomes an issue |
| Q2: Config delivery | Inline env (b) | **Inline `OPENCODE_CONFIG_CONTENT`** | Confirmed; secrets-redacted stderr config-log preserves debuggability |
| Q3: MCP transport | Local (a) | **`type: "local"` stdio** | Confirmed; symmetric with claude-api's in-process MCP |
| Q4: Port allocation | Probe | **Probe at recruit** | Confirmed; matches `src/http/server.ts` pattern |
| Q5: Provider/model recruit-arg | Combined | **Combined `model: 'provider/name'`** | Confirmed; relaxed regex `^[a-z0-9][a-z0-9-/.:_]*$` accepts both claude-api and opencode forms |
| Q6: Session persistence across restart | Verify first | **Verify at Phase C impl time, recommend Path A (re-attach)** | Confirmed; architecturally identical-shape outcome either way; engineer time-boxes the experiment to ≤30 min |
| Q7: Version-probe-gate strictness | Warn-only | **Warn-only** | Confirmed; refuse would brick on every minor bump (OpenCode ships daily); ignore loses diagnostic signal |

---

## 14. References

- **Issue #449** — Phase 1 scope + Phase 2 deferred questions (this PR's input)
- **Phase A research** — [`docs/research/449-opencode-adapter-spike.md`](../research/449-opencode-adapter-spike.md) (PR #468) — OpenCode surface audit, dependency stability, pattern alignment, MCP-native finding, 7 open design decisions
- **ADR 0015** — [`0015-opencode-adapter.md`](../adr/0015-opencode-adapter.md) — decision record for this design
- **Closest prior precedent (just merged)** — [`docs/design/131-claude-api-adapter.md`](131-claude-api-adapter.md) — same template, single-provider Anthropic, in-process MCP. Read before this for adapter pattern context.
- **Adapter precedents**:
  - [`src/adapters/sdk/base.ts`](../../src/adapters/sdk/base.ts) — `SdkAttachment` lifecycle contract (~80 % reuse)
  - [`src/adapters/copilot/adapter.ts`](../../src/adapters/copilot/adapter.ts) — closest existing subprocess-pattern precedent
  - [`src/adapters/claude-api/adapter.ts`](../../src/adapters/claude-api/adapter.ts) (~737 LoC) — closest existing HTTP-bridge precedent; reuse pinned-runId, PID file, terminal-cleanup wiring, optional-dep guard
  - [`src/adapters/claude-api/mcp-bridge.ts`](../../src/adapters/claude-api/mcp-bridge.ts) (158 LoC) — **no analog needed** for opencode (OpenCode owns translation)
  - [`src/adapters/index.ts`](../../src/adapters/index.ts) — registry bootstrap (one-line addition)
  - [`src/adapters/base.ts:1346+`](../../src/adapters/base.ts) — `AdapterRegistry.resolveFromAgentType` (one-line extension)
  - [`src/adapters/README.md`](../../src/adapters/README.md) — adapter contract + reconnect opt-in guidance
- **Recruit + types**:
  - [`src/tools/recruit.ts:58+`](../../src/tools/recruit.ts) — Zod enum (one-value addition); model regex relaxation
  - [`src/types.ts:15`](../../src/types.ts) — `AgentType` union (one-value addition)
- **OpenCode docs** (mid-2026):
  - [opencode.ai homepage](https://opencode.ai)
  - [Server docs](https://opencode.ai/docs/server/) — HTTP API surface
  - [SDK docs](https://opencode.ai/docs/sdk/) — `@opencode-ai/sdk` shape
  - [MCP servers docs](https://opencode.ai/docs/mcp-servers/) — config block format, `type: "local"` vs `"remote"`
  - [Custom Tools docs](https://opencode.ai/docs/custom-tools/) — for context only
  - [Config docs](https://opencode.ai/docs/config/) — precedence chain, `OPENCODE_CONFIG_CONTENT` env
- **Other ADR precedents** (same design-spike template) — ADR 0007 (TempoClient split), 0008 (coat-check), 0009 (protobuf), 0011 (saveable-state), 0012 (claude-api), 0014 (dev-mode mock)
- **Design doc** — [`docs/design/session-lifecycle-rebuild-v2.md`](session-lifecycle-rebuild-v2.md) §4 (adapter extensibility), §4.3 (lifecycle), §4.5 (conformance suite), §9.3 (ghost-reply window)
- **MCP TypeScript SDK** — `@modelcontextprotocol/sdk` `Server`, `Client`, stdio transport
- **Open OpenCode issue** — [sst/opencode#24874](https://github.com/sst/opencode/issues/24874) — Bearer auth not yet supported on `opencode serve` (loopback-bind is the v1 mitigation)

