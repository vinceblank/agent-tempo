# #449 SST OpenCode Adapter — Phase A Research Spike

- **Author**: tempo-researcher
- **Date**: 2026-04-29
- **Branch**: `research/449-opencode-phase-a`
- **Status**: Phase A (research) — feeds tempo-architect's Phase B (design + ADR)
- **Tracking**: issue #449 (Phase 1 — headless, server-bridge pattern)
- **Predecessors / context**:
  - #131 Phase C just merged (PR #455 at `cf850293`, 2026-04-29 01:10 UTC) — the `claude-api` adapter and `agent: 'claude-api'` recruit-enum are now live. #449 extends the union with `'opencode'`.
  - [`docs/design/131-claude-api-adapter.md`](../design/131-claude-api-adapter.md) — the design pattern this spike builds on
  - [`docs/research/131-claude-api-adapter-spike-verify.md`](131-claude-api-adapter-spike-verify.md) — the verification methodology this spike adopts

---

## TL;DR

1. **`opencode serve` is real, mature, and well-suited.** First-class HTTP server mode (default `127.0.0.1:4096`), OpenAPI 3.1 spec at `/doc`, auto-generated `@opencode-ai/sdk` TypeScript client. SSE streaming via `GET /event`. The protocol shape is friendly and structurally simpler than the Anthropic Messages API (server-side conversation history, normalized cross-provider event stream, dedicated abort endpoint).
2. **🔑 Lead finding — OpenCode supports MCP natively as a first-class tool transport.** Adapter config block: `mcp: { "claude-tempo": { type: "local", command: [...], environment: {...} } }`. **No custom tool-bridge translation layer needed** — fundamentally different from the `claude-api` adapter where we implemented `mcp-bridge.ts` to translate MCP shapes to Anthropic API shapes. OpenCode owns tool-call resolution server-side and translates to whichever provider the user picks.
3. **Closest existing precedent: a hybrid of `copilot` and `claude-api`.** Subprocess-spawn lifecycle (copilot pattern), HTTP-bridge runtime (new — neither existing adapter has this exactly), `SdkAttachment` lifecycle reuse (both patterns). Estimated ~700–950 LoC for Phase 1, less than claude-api because no MCP-bridge translation layer.
4. **Dependency-stability verdict: proceed with caution.** OpenCode is a top-tier OSS project (151k ⭐, daily releases, YC-funded, primary product of SST), so **abandonment risk is LOW**. But the HTTP API is still labeled "experimental" and minor bumps have shipped breaking changes recently (diff format, `userMessage.variant`). **Tilde-pin (`~1.14.29`)** discipline is mandatory; loopback-only bind and a `/global/health` version probe are the operational mitigations.
5. **Six open design decisions for the architect** — subprocess-per-player vs subprocess-shared, config-delivery mechanism, MCP transport choice, port-allocation strategy, recruit-arg surface, session-persistence-across-restart. None of them block; all have lean recommendations in §6 below.

---

## 1. SST OpenCode current surface (mid-2026)

### 1.1 What OpenCode is

[SST OpenCode](https://opencode.ai) — open-source AI coding agent (MIT, TypeScript-dominant, Bun runtime). 151k GitHub stars, 11,967 commits, 780 releases, latest `v1.14.29` published 2026-04-28 (yesterday). Multi-provider native via [Models.dev](https://models.dev) — Anthropic, OpenAI, Google, Bedrock, Ollama, GitHub Copilot, ChatGPT account-based, ~70+ others.

| vs | OpenCode | Difference |
|---|---|---|
| Claude Code CLI | Multi-provider, MIT, real headless server mode | Claude Code is Anthropic-only, no first-class server mode |
| Aider | Built-in agentic loop end-to-end | Aider is interactive/diff-driven |
| cline | Runs anywhere (terminal, server, desktop) | cline is VS Code-only |

The differentiator that matters for #449: **OpenCode is the only mainstream AI coding agent with a stable headless HTTP server mode that we can drive programmatically.** That's the architectural fit claude-tempo wants.

### 1.2 `opencode serve` HTTP API surface

```bash
opencode serve [--port 4096] [--hostname 127.0.0.1] [--cors <origin>]
```

| Defaults | Value |
|---|---|
| Port | `4096` |
| Hostname | `127.0.0.1` (loopback by default) |
| Auth | HTTP Basic via `OPENCODE_SERVER_PASSWORD` env (optional; defaults to no auth) |
| OpenAPI spec | `GET /doc` (3.1) — auto-generates `@opencode-ai/sdk` |

**Endpoints relevant to the adapter** (curated from [Server docs](https://opencode.ai/docs/server/)):

```
# Sessions
POST   /session                        → create — body { parentID?, title? } → Session
GET    /session                        → list
GET    /session/:id                    → fetch
PATCH  /session/:id                    → rename
DELETE /session/:id                    → hard delete
POST   /session/:id/fork               → branch
POST   /session/:id/abort              → cancel running turn

# Messages (hot path)
POST   /session/:id/message            → blocking — body has model/agent/system/tools/parts
POST   /session/:id/prompt_async       → 204 + stream via /event
GET    /session/:id/message?limit=N    → history

# Streaming
GET    /event                          → SSE — primary observability hook

# Provider / config / health
GET    /global/health                  → { healthy: bool, version: string }
GET    /provider                       → list active providers + models
GET    /config / PATCH /config         → effective merged config

# Experimental (avoid in adapter hot path — see §7.1)
GET    /experimental/tool/ids
GET    /experimental/tool?provider=&model=
GET    /find?pattern=
GET    /file/content?path=
```

**Multiple concurrent sessions per server**: yes. One `opencode serve` instance can host N sessions distinguished by id. This makes "subprocess-shared across players" architecturally feasible (see §6 design decisions).

### 1.3 Streaming protocol — SSE

Standard `text/event-stream` over a long-lived `GET /event` connection. Events from a turn pipeline (per [DeepWiki — Prompt Orchestration](https://deepwiki.com/sst/opencode/2.3-prompt-orchestration)):

1. **Message events** — user input creates a `Message` with `Part` entries persisted individually
2. **Tool resolution events** — available tools assembled from `ToolRegistry` + active MCP servers, filtered by agent permissions
3. **LLM stream events** — `TextPart`, `ReasoningPart`, `ToolPart` entries arrive as the upstream provider streams
4. **Tool execution events** — `ToolPart` transitions to `running`, then populates with the result
5. **Loop continuation / terminate** — `finish: 'stop'` (or other terminal reason) ends the turn

**End-of-turn signal**: `finish` reason on the assistant message — normalized across providers by `ProviderTransform` (Anthropic vs OpenAI vs Mistral all surface uniform shape to the adapter). This is **structurally simpler than the Anthropic Messages API's `stop_reason`-tagged streaming** because OpenCode hides provider quirks behind a uniform contract.

**Mid-stream errors**: surface as event-stream entries; SDK throws when consuming the iterator. **Doom-loop detection** is built in (repeated tool failures don't infinite-loop; context overflow triggers compaction). Adapter's responsibility shrinks vs the Anthropic-direct case.

**As of v1.14.29 (yesterday): tool streaming defaults OFF.** This means **partial-JSON-streaming complexity is a non-issue here** — the adapter receives the completed tool call in one event, no `input_json_delta` accumulation needed. Direct contrast with the Anthropic Messages API, where `input_json_delta` partial-parse is one of the [#131 verification addendum landmines](../design/131-claude-api-adapter.md#verification-addendum-2026-04-28) (#4). **Big complexity win for the OpenCode adapter.**

### 1.4 Tool-calling surface — MCP-native (the lead finding)

This is the architectural keystone, and it dramatically simplifies the adapter vs claude-api.

**OpenCode interprets tools, not the underlying provider.** Tool definitions live in OpenCode's `ToolRegistry` plus active MCP servers; OpenCode normalizes them into each provider's native format (Anthropic `input_schema`, OpenAI `parameters`, etc.) when constructing the upstream LLM call. The adapter does **not** see provider-specific tool shapes — it sees OpenCode's canonical shape, and OpenCode handles all the per-provider translation.

**Tool sources** (config sources, ascending precedence):
1. Built-in tool registry
2. **MCP servers configured via `mcp:` block** ← the path claude-tempo uses
3. Custom tool files in `.opencode/tools/*.{ts,js}` (project) or `~/.config/opencode/tools/*` (global) using a `tool()` helper with Zod schemas
4. Per-request `tools` field on `POST /session/:id/message`

**MCP support is first-class** (per [`mcp-servers` docs](https://opencode.ai/docs/mcp-servers/)):

```json
{
  "mcp": {
    "claude-tempo": {
      "type": "local",
      "command": ["node", "dist/server.js"],
      "environment": { "CLAUDE_TEMPO_ENSEMBLE": "...", "CLAUDE_TEMPO_PLAYER_NAME": "..." },
      "enabled": true
    }
  }
}
```

Two MCP transport modes:
- **`type: "local"`** — stdio subprocess (`command` + `environment`). Same shape claude-code uses.
- **`type: "remote"`** — HTTP transport with `url` + optional `headers` for auth.

> "MCP tools are automatically available to the LLM alongside built-in tools" — works **across all providers** because OpenCode does tool-call interpretation server-side.

**Implication for claude-tempo**: the OpenCode adapter does **not need a tool-bridge translation layer**. The architectural delta vs `claude-api` is striking:

| Layer | `claude-api` adapter (#131) | `opencode` adapter (#449, proposed) |
|---|---|---|
| Tool registration | In-process `McpServer` + `Client` paired via `InMemoryTransport` | Same in-process `McpServer`, but exposed via stdio (or HTTP) for OpenCode subprocess to consume |
| Tool schema translation | `mcp-bridge.ts` (158 LoC) — `inputSchema` → `input_schema` (Anthropic shape) | **None** — OpenCode owns translation |
| Tool dispatch | Adapter loops through `tool_use` blocks, calls `mcp.callTool()`, builds `tool_result` blocks | OpenCode dispatches; adapter just observes via `/event` SSE |
| Provider portability | Anthropic-only | All ~70 providers OpenCode supports |

The adapter shrinks by removing a translation layer that's now upstream's responsibility.

### 1.5 Multi-provider config

Config lives in `opencode.json` (or JSONC) with a precedence chain ([Config docs](https://opencode.ai/docs/config/)):

1. Remote config (`.well-known/opencode`)
2. Global (`~/.config/opencode/opencode.json`)
3. `OPENCODE_CONFIG` env (custom path)
4. **Project (`opencode.json` in CWD)** ← what an end-user typically writes
5. `.opencode/` directory
6. **`OPENCODE_CONFIG_CONTENT` env (inline JSON)** ← the path claude-tempo can use to inject config without filesystem write

Variable substitution: `{env:VAR_NAME}` and `{file:path}` syntax inside config values.

Example for Anthropic + claude-tempo MCP:

```json
{
  "model": "anthropic/claude-opus-4-7",
  "small_model": "anthropic/claude-haiku-4-5",
  "provider": {
    "anthropic": {
      "options": { "apiKey": "{env:ANTHROPIC_API_KEY}", "setCacheKey": true }
    }
  },
  "server": { "port": 4096, "hostname": "127.0.0.1", "mdns": false },
  "mcp": {
    "claude-tempo": {
      "type": "local",
      "command": ["node", "dist/server.js"],
      "environment": { "CLAUDE_TEMPO_ENSEMBLE": "{env:CLAUDE_TEMPO_ENSEMBLE}" }
    }
  }
}
```

Same shape works with `provider.openai`, `provider.amazon-bedrock` (region + profile), `provider.ollama` (likely `baseURL`), etc. **Provider model strings are opaque to claude-tempo** — `anthropic/claude-opus-4-7`, `openai/gpt-4o`, `ollama/llama3`. The adapter passes them through verbatim.

### 1.6 Authentication delegation

OpenCode resolves provider auth itself via three mechanisms:

1. **Env vars** — `ANTHROPIC_API_KEY`, `OPENAI_API_KEY`, etc., read directly by provider client libs
2. **Config file** — `provider.{name}.options.apiKey` field, supports `{env:...}` substitution
3. **OAuth flow** — `POST /provider/{id}/oauth/authorize` for GitHub Copilot, ChatGPT account-based providers; tokens stored in OpenCode's auth store

**For claude-tempo: just inherit env vars.** The spawning daemon already has `ANTHROPIC_API_KEY` in its environment per the existing `claude-api` pattern; pass through to the spawned `opencode serve`. No claude-tempo-side credential handling.

### 1.7 Subprocess characteristics

| Property | Notes / verify-at-impl flag |
|---|---|
| Default port | 4096 — **not guaranteed free**. Adapter should probe a free port at recruit time and pass `--port` explicitly (matches the pattern claude-tempo's daemon HTTP server uses). |
| Stdio noise | v1.14.27 (2026-04-27) added "configurable default shell; terminal noise reduction" — implies historical noise. Adapter should pipe stdout/stderr to a log file (`~/.claude-tempo/opencode-{playerId}.log`), never surface to user terminal. |
| Signal handling | OpenCode is built on Bun. Bun handles SIGINT/SIGTERM by default. **Verify graceful shutdown at impl time.** Copilot bridge's pattern (timeout-bounded SIGTERM, then SIGKILL fallback) is the safe template. |
| Crash detection | Parent gets SIGCHLD on exit; subprocess stops responding to HTTP. Adapter's heartbeat ticks already detect both via the inherited `BaseAttachment` machinery. |
| Pre-flight | `GET /global/health` returns `{ healthy, version }` — cheap probe. Adapter waits for this to return 200 before claiming the workflow attachment. |
| mDNS leak | v1.14.x has `server.mdns` config (defaults unknown). Adapter should set `mdns: false` in the inline config to avoid leaking session presence over Bonjour. |

### 1.8 Session lifecycle on the OpenCode side

| Phase | OpenCode-side action | claude-tempo-side action |
|---|---|---|
| Create | `POST /session` returns `Session` with `id` | Stash `id` on workflow metadata via `updateMetadataSignal` (matches Copilot's `sessionId` stash pattern) |
| Send turn | `POST /session/:id/prompt_async` (preferred — 204 + observe via SSE) or `POST /session/:id/message` (blocking) | Wrap in `SdkAttachment.deliver()` — `processingStart` → POST → wait for `finish` event → `processingEnd` → `markDelivered` |
| History | **Server-side persisted** by OpenCode | **No per-turn rebuild** (different from `claude-api`); trust OpenCode |
| Abort | `POST /session/:id/abort` | Wired to `onSuperseded()` lease-revocation hook — cleaner than killing the subprocess |
| Destroy | `DELETE /session/:id` | Called on graceful detach to free server resources |

**Server-side history is the structural simplification of #449 vs #131.** The Anthropic Messages API is stateless, so the `claude-api` adapter rebuilds conversation from `allMessagesQuery` + `allSentMessagesQuery` every turn. OpenCode owns history server-side, so the adapter sends only the new turn's `parts` and OpenCode appends. This eliminates ~80 LoC of `buildAnthropicMessages()`-style code at the cost of one architectural concern (see §6, Q6 — session persistence across server restart).

---

## 2. Dependency stability assessment

### 2.1 Activity (quantitative)

| Metric | Value | Verdict |
|---|---|---|
| GitHub stars | 151k | Top-tier OSS scale |
| Forks | 17.4k | High community engagement |
| Total commits | 11,967 | Substantial codebase |
| Contributors (claimed) | 850 | Broad |
| Latest release | `v1.14.29` (2026-04-28) | Active — yesterday |
| Releases (last 30 days) | 9+ visible 2026-04-21 → 2026-04-28 | Daily-to-every-other-day cadence |
| Monthly users (claimed) | 6.5M / 650k MAU | Real adoption |
| License | MIT | Friendly |

### 2.2 Breaking-change history

The HTTP API is **labeled "experimental"** in release notes — most recently added endpoints live under `/experimental/*` (tool ids, file ops, MCP server status, config). The non-experimental endpoints (`/session/*`, `/event`, `/global/health`) are more stable but the line is fuzzy.

**Confirmed breaking changes in 2026** (per [SST Release Notes](https://releasebot.io/updates/sst)):
- `parts` data model: `edit`/`patch` tool diffs dropped `to`/`from` fields, kept only unified `patch`
- `userMessage.variant` relocated under `userMessage.model.variant`

Both shipped under minor version bumps without a major release. No public stability/SemVer policy in the docs.

### 2.3 Versioning discipline

Past 1.0 (currently 1.14.29), but minor bumps can include breaks. **Tilde-pin (`~1.14.29`)** is mandatory — same lesson as `@anthropic-ai/sdk` from #131.

### 2.4 Issue + PR responsiveness

- 4.4k open issues, 1.7k open PRs (high in absolute terms, typical for a 151k-star repo)
- Bug-fix turnaround is fast — daily releases include named bug fixes (e.g., v1.14.28 fixed an `opencode upgrade` regression within 24h)
- **Open issue [#24874](https://github.com/sst/opencode/issues/24874)** (today): "Support Bearer token authentication for opencode serve" — labeled `core`. **Auth is a real gap on the HTTP server today.** Loopback-only binding (`127.0.0.1`) is the architectural mitigation; no Bearer tokens needed for our headless single-machine adapter use case.

### 2.5 Sponsor / governance

- **SST took an undisclosed funding round in early 2026.** Angels include Reid Hoffman, Max Levchin, Steve Chen, YC, SV Angel.
- **SST team pivoted away from the original Serverless Stack framework** to focus on OpenCode as their primary product.
- **Pursuing the "Private Cloud" market** — defense, banks. Real revenue motion, not a hobby.

**Abandonment risk: LOW.** Materially safer than a typical solo-maintainer OSS dep.

### 2.6 Risk matrix

| Dimension | Risk | Notes |
|---|---|---|
| Abandonment | **LOW** | Funded primary product, YC team, daily commits |
| Breaking changes (HTTP API specifically) | **MEDIUM-HIGH** | "Experimental" label still attached; minor bumps have shipped breaks |
| Breaking changes (CLI / config) | **MEDIUM** | Active development, no semver-major discipline |
| Security walk-away | **LOW** | Active maintenance, daily releases catch bugs fast |
| Bus-factor | **LOW-MEDIUM** | 850 contributors but core team is small (Jay + Frank + small SST team) |
| Operational risk (no HTTP auth) | **MEDIUM** | Loopback-bind mitigation required; documented in design |

**Single biggest risk**: HTTP API breaks under minor bumps. **Fallback**: per #449's risk callout, the `claude-api` adapter (#131, just landed) is the documented first-party Anthropic-only path. If OpenCode dep ever bites, ensembles can fall back to `agent: 'claude-api'` with no third-party dep.

### 2.7 Stability comparison vs existing adapter deps

| Dep | Risk profile | Why |
|---|---|---|
| `@github/copilot-sdk` (copilot adapter) | **Similar to OpenCode** in third-party-bridge sense, but lower bus-factor risk (Microsoft-backed) | OpenCode wins on transparency (MIT, full source); Copilot wins on corporate guarantee |
| `@anthropic-ai/sdk` (claude-api adapter) | **Materially safer** — Stainless-generated by a multi-billion-dollar company with paying customers depending on stability | Different leagues |
| **OpenCode** | **Medium overall** | Bigger user base than Copilot SDK, smaller corporate backstop than Anthropic SDK, faster-moving HTTP API surface than either |

**Verdict: proceed with caution.** Tilde-pin, loopback-bind, abstract OpenCode protocol concerns behind a thin layer, document the `claude-api` fallback in the ADR. With those four hedges in place, OpenCode is a sound bet — without them, expect ~1 dev-day per minor bump chasing API breaks.

---

## 3. Pattern alignment with existing adapters

### 3.1 Closest precedent

OpenCode's adapter is **a hybrid of the `copilot` subprocess pattern and the `claude-api` HTTP-bridge pattern**:

| Aspect | `claude-code` (interactive) | `copilot` (sdk, subprocess) | `claude-api` (sdk, in-process Anthropic SDK + MCP bridge) | **`opencode` (proposed — sdk, subprocess + HTTP bridge)** |
|---|---|---|---|---|
| Class hierarchy | `BaseAttachment` (push) | `SdkAttachment` (pull) | `SdkAttachment` (pull) | **`SdkAttachment` (pull)** |
| LLM transport | TTY → claude CLI | `@github/copilot-sdk` JS API → Copilot stdio subprocess | `@anthropic-ai/sdk` HTTP → Anthropic | **Custom HTTP/SSE → local `opencode serve` subprocess** |
| Tool surface | Claude Code built-ins + tempo MCP | Copilot built-ins + tempo MCP | tempo MCP only (no built-ins in v1) | tempo MCP via OpenCode's native MCP server config + OpenCode built-ins |
| Tool translation | Claude Code does it | Copilot does it | **`mcp-bridge.ts` (158 LoC)** | **None — OpenCode does it server-side** |
| History rebuild | Workflow-side via env-var hand-off | Per-turn pull-poll model | **Per-turn `buildAnthropicMessages()`** | **None — OpenCode persists server-side** |
| Subprocess managed by adapter | No (Claude Code is the subprocess; the `node dist/...` is the adapter) | Yes (`@github/copilot-sdk` spawns Copilot CLI internally) | No (HTTP to Anthropic) | **Yes (`opencode serve` spawned by adapter on claim)** |
| Abort mechanism | Exit subprocess | `session.disconnect()` | `AbortController` on `messages.create` | **`POST /session/:id/abort`** |
| Optional dep | `@github/copilot-sdk` | `@anthropic-ai/sdk` | `@opencode-ai/sdk` (auto-generated TS client) — or raw fetch | |

### 3.2 SdkAttachment lifecycle reuse

`SdkAttachment` (`src/adapters/sdk/base.ts`) covers the same ~80% of lifecycle as it does for `claude-api`:

- `claimAttachment` + heartbeat (30s cadence per descriptor)
- Phase watcher loop, `WorkflowNotFound` handling, runId pinning
- `processingStart` / `processingEnd` pairing via `deliver()`
- `markDelivered` on successful turn
- `onSuperseded` hook for lease revocation → adapter's `POST /session/:id/abort` + subprocess SIGTERM
- Auto-reconnect for `'continued-as-new'` (#226) inherited free

Subclass overrides:
- `descriptor` — `{ adapterId: 'opencode', adapterClass: 'sdk', blocksOnLLMTurn: true, heartbeatMs: 30_000 }`
- `invokeSdk(prompt, timeoutMs)` — wraps `POST /session/:id/prompt_async` + SSE consumption + finish-reason wait + assembled-text return
- `onSuperseded()` — calls `POST /session/:id/abort` (graceful, no subprocess kill)
- `shouldReconnect()` — same call as `claude-api`: NOT opted in. Lease loss exits the subprocess; restart recovers.

### 3.3 What's NEW (not present in `claude-api` or `copilot`)

- **Subprocess HTTP client** — neither existing adapter speaks HTTP to a sibling subprocess. Closest analog is the **daemon HTTP/SSE event source** (`src/http/`) which serves SSE; the OpenCode adapter would be a *consumer* of similar shape.
- **OpenCode session-id stash** — like Copilot's `sessionId` (stashed via `updateMetadataSignal`), but distinct semantics (OpenCode IDs are server-internal, not provider-internal).
- **Inline-config JSON synthesis** — the adapter builds `OPENCODE_CONFIG_CONTENT` env at spawn time from recruit args (model, provider) + claude-tempo MCP server config. No equivalent in existing adapters.

### 3.4 What's REUSABLE (same pattern, copy-paste-able)

- Subprocess spawn shape from `copilot/adapter.ts` — env-var contract, dual-purpose entry point (`require.main === module`), unbuffered stderr logging
- Pinned-runId pattern from `claude-api/adapter.ts` (post-claim, prevents zombie resurrection)
- PID file pattern (`logs/{playerId}.pid`) for orphan kill
- Terminal-cleanup wiring (set up BEFORE `startV2Lifecycle` to avoid race on lease loss)
- Test helper conventions (`__verbNounForTests` per ADR 0006)

---

## 4. MCP tool bridging into OpenCode

(This section formalizes the §1.4 lead finding into design implications.)

### 4.1 Architecture: claude-tempo's MCP server, OpenCode's MCP client

The adapter does **NOT** translate tool schemas. Instead:

1. The adapter spawns `opencode serve` with an inline config (`OPENCODE_CONFIG_CONTENT` env) that includes:
   ```json
   "mcp": {
     "claude-tempo": {
       "type": "local",
       "command": ["node", "<absolute-path-to-claude-tempo-dist-server.js>"],
       "environment": {
         "CLAUDE_TEMPO_ENSEMBLE": "...",
         "CLAUDE_TEMPO_PLAYER_NAME": "...",
         "CLAUDE_TEMPO_TEMPORAL_ADDRESS": "...",
         "CLAUDE_TEMPO_TEMPORAL_NAMESPACE": "...",
         "CLAUDE_TEMPO_BRIDGE_MODE": "1"
       }
     }
   }
   ```
2. OpenCode reads this config, spawns `node dist/server.js` as a stdio MCP subprocess, and listens for `list_tools` / `call_tool` requests.
3. The MCP server (existing `src/server.ts`) registers all tempo tools (cue, report, recall, ensemble, broadcast, recruit, set_part, set_name, who_am_i, schedule, …) — the same surface every adapter sees.
4. When OpenCode runs a turn and the LLM elects a tool call, OpenCode dispatches the tool via the MCP client, gets the result, and feeds it back into the next LLM call **without the adapter being on the path**.

The adapter's only role in tool dispatch is **observing** the tool execution via the SSE stream — for telemetry, processingEnd timing, and turn-level finish detection.

### 4.2 Two transport options: local vs remote

| Option | Shape | Pros | Cons |
|---|---|---|---|
| **(a) `type: "local"` stdio** ← lean | OpenCode spawns a *second* `node dist/server.js` as its own MCP child process | Symmetric with `claude-api`'s in-process MCP server; no network surface; auto-cleanup on subprocess exit | Two MCP server instances per claude-api+opencode mixed-ensemble (one in-process for claude-api, one stdio-spawned for opencode); minor memory overhead |
| **(b) `type: "remote"` HTTP** | Adapter exposes the MCP server via HTTP; OpenCode connects via URL | Single MCP server instance shared across adapters; could integrate with daemon's HTTP layer | Adds network surface (auth concerns), requires port allocation for MCP server, more wire surface to maintain |

**Lean: (a) `type: "local"` stdio.** Symmetric, simpler, no new transport surface. The minor memory overhead is acceptable. (b) is a valid Phase 2 optimization if mixed-ensemble memory becomes a problem.

### 4.3 Why we DON'T need a `mcp-bridge.ts` translation layer

Direct contrast with `claude-api`:

```
claude-api adapter:
  MCP server (in-process)
       │  inputSchema → input_schema (Anthropic shape) ← mcp-bridge.ts (158 LoC)
       ▼
  Anthropic Messages API
       │  tool_use blocks
       ▼
  Adapter receives tool_use, dispatches via mcp.callTool, builds tool_result, feeds next turn

opencode adapter:
  MCP server (stdio, spawned by OpenCode subprocess)
       │  (no translation — OpenCode owns the contract)
       ▼
  OpenCode tool registry
       │  OpenCode dispatches; adapter only observes via /event SSE
       ▼
  (Adapter unaware of tool execution mechanics)
```

The 158 LoC of `mcp-bridge.ts` (Anthropic schema translation) has no analog in the OpenCode adapter. **This is the single largest LoC saving** vs `claude-api`.

### 4.4 Cross-provider tool consistency (Phase 2 Q for #449)

OpenCode's tool dispatcher normalizes provider quirks ([DeepWiki — Tool Translation](https://deepwiki.com/sst/opencode/2.3-prompt-orchestration)) — e.g., "Mistral's requirement for 9-character alphanumeric tool call IDs." But there's a real Phase 2 question: do all providers honor the same tool surface equally well? An OpenAI GPT-4o player using `cue` may behave subtly differently from a Claude Opus 4.7 player using `cue`. Cross-provider parity testing is explicitly out-of-scope for Phase 1 per #449's body — but worth flagging as a Phase 2 follow-up.

---

## 5. Provider-config plumbing

### 5.1 Recruit-arg surface

Extend the existing recruit Zod schema additively:

```ts
// src/tools/recruit.ts — additive on the existing schema
{
  // ... existing fields ...
  agent: z.enum(['claude', 'copilot', 'mock', 'claude-api', 'opencode']).optional()
    .describe(`Which agent to use … "opencode" runs headless via local opencode serve subprocess.`),
  // NEW — only meaningful for adapter='opencode'
  model: z.string().optional()  // ← already exists post-#131; expand semantics
    .describe('Model id. For claude-api: "claude-opus-4-7". For opencode: "anthropic/claude-opus-4-7" or "openai/gpt-4o" or "ollama/llama3" — opaque pass-through.'),
  // (Optional explicit provider arg — see §6 Q5)
  provider: z.string().optional()
    .describe('Provider id for opencode adapter (e.g. "anthropic", "openai", "ollama"). Optional — model id can encode provider via "provider/model" syntax.'),
}
```

**Provider/model strings are opaque to claude-tempo.** No validation regex (would constrain new providers), no enum (would lock us to a hardcoded list). The recruit pre-flight only verifies that `opencode` binary resolves at recruit time (or `@opencode-ai/sdk` if going SDK-first); OpenCode itself will reject invalid provider/model strings at session-create time with a clear error.

### 5.2 Config delivery: `OPENCODE_CONFIG_CONTENT` env vs filesystem write

Two viable paths:

| Path | Shape | Pros | Cons |
|---|---|---|---|
| **(a) Filesystem write** | Adapter writes `~/.claude-tempo/opencode-{playerId}.json`, spawns `opencode serve` with `OPENCODE_CONFIG=<path>` | Inspectable on disk for debugging | Cleanup hassle (stale configs if adapter crashes mid-spawn); permissions concerns on multi-user systems |
| **(b) `OPENCODE_CONFIG_CONTENT` inline JSON** ← lean | Adapter builds the JSON in-memory and passes via env var | No filesystem write, no cleanup, no permissions concerns | Less inspectable (operator has to read process env to see the config) |

**Lean: (b).** Cleaner cleanup. For debugging, the adapter logs the config (with secrets redacted) at spawn time.

### 5.3 Cost telemetry per provider

OpenCode tracks per-message token counts internally (visible in `parts` metadata on `GET /session/:id/message`). The adapter can:
- **v1**: log `[claude-tempo:opencode] turn-usage provider=… model=… input=… output=… cache_read=… elapsed_ms=… player=…` to stderr — same shape as `claude-api`'s addendum #2.6 telemetry
- **Phase 2**: aggregate per-session-per-provider via a workflow-side signal (deferred per #449 out-of-scope)

The OpenCode SSE `/event` stream emits `usage` data on `assistant.message` finish events; that's the harvest point. **Different per-provider semantics** (Anthropic exposes cache_read/cache_creation; OpenAI doesn't have those concepts) — adapter logs whatever's present, doesn't try to normalize.

---

## 6. Open design decisions for architect

Six questions. Each has a "lean" recommendation but is the architect's call.

| # | Question | Lean | Rationale |
|---|---|---|---|
| Q1 | **Subprocess-per-player vs subprocess-shared**: should each `opencode` player have its own `opencode serve` subprocess, or do all opencode-class players share one? | **Per-player** | Simpler crash recovery, isolation, matches Copilot pattern. Subprocess-shared could conserve ~50-100 MB per player but tightly couples lifecycles — a stuck `prompt_async` for one player would block all others on the same server. |
| Q2 | **Config delivery**: filesystem vs `OPENCODE_CONFIG_CONTENT` env | **Inline env (b)** | No filesystem cleanup risk (§5.2); operator-debuggability via stderr config-log |
| Q3 | **MCP transport**: `type: "local"` stdio vs `type: "remote"` HTTP | **Local (a)** | Symmetric with `claude-api`; no new wire surface; auto-cleanup on subprocess exit (§4.2) |
| Q4 | **Port allocation**: probe a free port at recruit, or rely on default 4096 + retry-on-conflict | **Probe** | Default 4096 not guaranteed free; matches the daemon HTTP server pattern (`src/http/server.ts` already does this) |
| Q5 | **Provider/model recruit-arg shape**: combined `model: 'anthropic/claude-opus-4-7'` (provider/model) vs separate `provider: 'anthropic'` + `model: 'claude-opus-4-7'` | **Combined** | One opaque string; matches OpenCode's own config shape; fewer surface fields. Separate fields are a v2 if cross-cutting per-provider knobs emerge. |
| Q6 | **Session persistence across server restart**: rely on OpenCode (verify it persists), or replay from workflow `messages[]` (matches `claude-api`) | **Verify first** | OpenCode's TUI session-sharing feature suggests persistence, but the adapter MUST verify. If not persistent, replay from workflow on subprocess restart (more code; simpler model). The verification is one Phase B impl-time experiment — out of scope for this research doc. |
| Q7 | **Version probe gate strictness**: `/global/health` returns `version`. Should the adapter warn on minor drift, refuse, or ignore? | **Warn-only** | Stderr warning on version mismatch from tested-pinned version. Refuse would brick on every minor bump (unacceptable given OpenCode's daily cadence); ignore loses the diagnostic signal. Warn is a `[claude-tempo:opencode] WARNING: opencode version X.Y.Z drift from tested ~1.14.29` line. |

---

## 7. Risks + unknowns

### 7.1 Risk: `/experimental/*` endpoint reliance

The adapter SHOULD restrict its hot path to non-experimental endpoints: `/session/*`, `/event`, `/global/health`. The `/experimental/tool/ids` and `/experimental/tool` endpoints are tempting for adapter-side tool inspection but OpenCode handles tool dispatch — the adapter doesn't need to enumerate tools.

**Mitigation**: design constraint. ADR documents the restriction.

### 7.2 Risk: HTTP API minor-bump breaks

Per §2.2, breaks have shipped under minor version bumps (`parts` data model, `userMessage.variant`). Tilde-pin is a partial mitigation; another `1.14.x → 1.14.y` could break the same way.

**Mitigations**:
- Tilde-pin `~1.14.29`
- Adapter logs OpenCode version on every spawn (operator can correlate failures with version drift)
- Integration test (Phase B test plan) hits `/session` + `/event` round-trip — drift detector at CI time

### 7.3 Risk: HTTP server has no built-in auth (issue #24874)

`opencode serve` ships without Bearer auth in v1.14.x. Loopback bind (`127.0.0.1`) is the operational mitigation — anyone with shell access on the same machine can drive the session, but the spawning user is the same user already with that access.

**Mitigation**: hardcode `--hostname 127.0.0.1` in the adapter spawn. Document the single-machine-trust model in the ADR.

### 7.4 Unknown: subprocess restart crash recovery

Verify at impl time:
- Does `opencode serve` persist sessions across restart? (Phase B impl-time experiment)
- If not, the adapter's restart path must rebuild conversation from workflow `messages[]` (matches `claude-api` per-turn pattern, ~80 LoC)
- If yes, the adapter just re-attaches to the existing session-id stashed in workflow metadata (simpler)

### 7.5 Unknown: doom-loop / context-overflow behavior

OpenCode has built-in doom-loop detection and context compaction. **Verify**: how does the adapter learn that compaction has happened? Does the SSE stream emit a `compacted` event? Does the next `GET /session/:id/message` show a different shape? **Phase B impl-time experiment.**

### 7.6 Unknown: signal-handling semantics on Windows

Bun runtime on Windows handles SIGINT/SIGTERM differently from POSIX. Adapter's graceful-detach path needs Windows-specific testing. (Same concern that bit `claude-code` adapter on Windows; cross-platform tests should cover it.)

---

## 8. Effort estimate

| Area | LoC range | Notes |
|---|---|---|
| `src/adapters/opencode/adapter.ts` (`OpenCodeAttachment extends SdkAttachment`) | 350–500 | Subprocess spawn + HTTP/SSE consumption + finish-reason wait + abort. Smaller than `claude-api`'s 737 because no MCP-bridge layer and no per-turn history rebuild. |
| `src/adapters/opencode/server-bridge.ts` (HTTP/SSE client wrapping `@opencode-ai/sdk` or raw fetch) | 150–250 | Connection + auth + session-create + prompt_async + event-stream subscribe + abort + delete |
| `src/adapters/opencode/index.ts` (descriptor + barrel) | 16 | Match `claude-api/index.ts` |
| Registry hook (`src/adapters/index.ts`, `src/adapters/base.ts`) | 5 | One-line union extension + resolveFromAgentType |
| `src/tools/recruit.ts` agent-enum extension + preflight (model/provider arg validation, opencode binary check) | 30–50 | Bigger than `claude-api`'s extension because of provider/model arg semantics |
| `src/types.ts` `AgentType` extension | 1 | Additive |
| `package.json` optional dep on `@opencode-ai/sdk` | 3 | Tilde-pin |
| `src/server-tools.ts` — no change required (existing `registerAllTempoTools` works) | 0 | OpenCode consumes via stdio MCP subprocess |
| Tests (vitest unit + mocha integration covering spawn → claim → turn → detach lifecycle, with `opencode serve` mocked via in-process http server) | 200–300 | Mock OpenCode's `/global/health`, `/session/*`, `/event` SSE; conformance with the existing SDK-class lifecycle suite |
| Docs (`src/adapters/README.md`, `docs/concepts.md`, recruit tool description) | 50 | Four adapter types now |
| **Total** | **~700–950 LoC** | Smaller than #131's ~825–1,125 estimate (and much smaller than #131's actual 911 LoC final) — no MCP-bridge layer, no per-turn history rebuild, OpenCode handles tool dispatch. |

Issue #449's body cites 600–1,000 LoC; my refined estimate is consistent.

---

## 9. Candidate follow-up issues

(Not auto-filed per process notes — conductor decides what to elevate.)

| # | Candidate | Rationale |
|---|---|---|
| F1 | **Cross-provider tool parity testing** (Phase 2 of #449) | Does `cue`/`report`/`recall` behave consistently across Anthropic, OpenAI, Bedrock, Ollama players? Per #449 explicit out-of-scope. |
| F2 | **Provider-aware throttling/quota tracking** (Phase 2 of #449) | Per-provider rate-limit awareness — distinct from claude-api's #131 stderr-only telemetry. |
| F3 | **OpenCode version-drift CI** | Pin against latest `~1.14.x` in CI; detect breaking changes within 24h of each minor release. |
| F4 | **Per-turn usage signal + workflow-side aggregation** | Same Phase 2 candidate as #131's deferred follow-up (recordTurnUsage signal); applies to opencode + claude-api + future adapters. |
| F5 | **Subprocess-shared opencode serve** (memory optimization) | If mixed-ensemble memory becomes a problem, share one server across multiple opencode players. |
| F6 | **Remote MCP transport** (`type: "remote"`) | Phase 3 — share a single MCP server across all adapter types via daemon HTTP. Composes with #94/#95 SSE work. |
| F7 | **`opencode auth` / OAuth flows** | Provider-specific OAuth (GitHub Copilot via OpenCode, ChatGPT account auth) — verify whether claude-tempo can pass through cleanly or needs a wrapper. |

---

## Appendix A: Code pointers

- `src/adapters/sdk/base.ts` — `SdkAttachment` lifecycle (~80% reuse for opencode)
- `src/adapters/copilot/adapter.ts` — closest subprocess-pattern precedent
- `src/adapters/claude-api/adapter.ts` (737 LoC) — closest HTTP-bridge pattern; reuse pinned-runId, PID file, terminal-cleanup wiring
- `src/adapters/claude-api/mcp-bridge.ts` (158 LoC) — **no analog needed** for opencode (OpenCode does translation)
- `src/adapters/index.ts` — registry bootstrap (one-line addition)
- `src/adapters/base.ts:1354+` — `AdapterRegistry.resolveFromAgentType` (one-line extension)
- `src/tools/recruit.ts:58` — Zod enum (one-value addition)
- `src/types.ts:15` — `AgentType` union (one-value addition)
- `src/server.ts` — existing MCP server (consumed by OpenCode via stdio MCP subprocess; no changes)
- `src/http/server.ts` — daemon HTTP/SSE event source — useful pattern reference for opencode adapter's SSE consumption (consumer side, not server side)

## Appendix B: Web sources consulted (2026-04-29)

- [opencode.ai homepage](https://opencode.ai)
- [OpenCode Server docs](https://opencode.ai/docs/server/)
- [OpenCode SDK docs](https://opencode.ai/docs/sdk/)
- [OpenCode MCP servers docs](https://opencode.ai/docs/mcp-servers/)
- [OpenCode Custom Tools docs](https://opencode.ai/docs/custom-tools/)
- [OpenCode Config docs](https://opencode.ai/docs/config/)
- [OpenCode Agents docs](https://opencode.ai/docs/agents/)
- [OpenCode Releases (GitHub)](https://github.com/sst/opencode/releases)
- [`@opencode-ai/sdk` on npm](https://www.npmjs.com/package/@opencode-ai/sdk)
- [DeepWiki: Prompt Orchestration](https://deepwiki.com/sst/opencode/2.3-prompt-orchestration)
- [DeepWiki: Message and Session Management](https://deepwiki.com/sst/opencode/7-message-and-session-management)
- [DeepWiki: Release Pipeline](https://deepwiki.com/sst/opencode/13.2-release-pipeline)
- [Models.dev](https://models.dev) — provider catalog
- [SST Release Notes — April 2026 (Releasebot)](https://releasebot.io/updates/sst)
- [TFN: OpenCode background story](https://techfundingnews.com/opencode-the-background-story-on-the-most-popular-open-source-coding-agent-in-the-world/)
- [Open issue #24874 — Bearer auth](https://github.com/sst/opencode/issues/24874) (no auth on `opencode serve` today)
