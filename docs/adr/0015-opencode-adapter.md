# ADR 0015 — Headless OpenCode adapter — Phase 1 (multi-provider via `opencode serve`)

- **Status**: Accepted (design — implementation deferred to Phase C engineer pickup)
- **Date**: 2026-04-29
- **Authors**: tempo-architect
- **Related**: [`docs/design/449-opencode-adapter.md`](../design/449-opencode-adapter.md), [`docs/research/449-opencode-adapter-spike.md`](../research/449-opencode-adapter-spike.md), [ADR 0012](0012-claude-api-adapter.md), issue #449 (Phase 1 — headless, server-bridge)

## Context

After ADR 0012 (claude-api, just landed in #455), claude-tempo ships three session adapters:

| Adapter | Class | Delivery | LLM transport |
|---|---|---|---|
| `claude-code` | interactive | push | TTY → claude CLI |
| `copilot` | sdk | pull | `@github/copilot-sdk` → Copilot stdio subprocess |
| `claude-api` | sdk | pull | `@anthropic-ai/sdk` → Anthropic Messages API |

All three are single-provider: Claude Code (Anthropic-only), Copilot (GitHub-only), claude-api (Anthropic-only). Issue #449 motivates a fourth adapter — `opencode` — to give claude-tempo a **multi-provider headless story** by driving [SST OpenCode](https://opencode.ai) as a local subprocess.

Phase A research (PR #468, [`docs/research/449-opencode-adapter-spike.md`](../research/449-opencode-adapter-spike.md)) audited:

- **OpenCode current surface** — `opencode serve` (default `127.0.0.1:4096`), OpenAPI 3.1 at `/doc`, auto-generated `@opencode-ai/sdk`, SSE at `/event`, server-side persisted sessions, dedicated `POST /session/:id/abort`. **151k ⭐, 11,967 commits, daily releases, latest `v1.14.29` on 2026-04-28.** YC-funded; SST team's primary product.
- **Lead architectural finding** — **OpenCode supports MCP natively as a first-class tool transport** (`mcp` config block, `type: "local"` stdio child or `type: "remote"` HTTP). The adapter does **not** need a translation layer analogous to claude-api's `mcp-bridge.ts` (158 LoC saved); OpenCode owns tool dispatch + per-provider translation server-side.
- **Dependency stability** — abandonment risk **LOW** (funded, daily commits, broad adoption); HTTP-API breaking-change risk **MEDIUM-HIGH** (still labeled "experimental"; minor bumps have shipped breaks for `parts` data model and `userMessage.variant`); HTTP server has **no built-in auth** in v1.14.x (issue [sst/opencode#24874](https://github.com/sst/opencode/issues/24874)). **Verdict: proceed with caution** — tilde-pin, loopback-bind, document the `claude-api` fallback as the Anthropic-only first-party path.
- **Pattern precedent** — hybrid of `copilot` (subprocess-managed-by-adapter) and `claude-api` (HTTP-bridge runtime); `SdkAttachment` covers ~80 % of the lifecycle for free.

The design spike was tasked with locking seven open questions before engineer pickup:

1. Subprocess-per-player vs subprocess-shared
2. Config delivery (filesystem write vs `OPENCODE_CONFIG_CONTENT` env)
3. MCP transport (`type: "local"` stdio vs `type: "remote"` HTTP)
4. Port allocation (default `4096` vs probe-free at recruit)
5. Provider/model recruit-arg shape (combined `provider/model` vs separate `provider` + `model`)
6. Session persistence across server restart (verify-then-decide)
7. Version-probe-gate strictness (`/global/health` returned `version` — refuse / warn / ignore on drift)

## Decision

**Adopt the headless OpenCode adapter as designed in [`docs/design/449-opencode-adapter.md`](../design/449-opencode-adapter.md).** The full design lives there; this ADR records the architectural decision and locks the seven open questions.

Headline locked-in choices:

- **Class**: `OpenCodeAttachment extends SdkAttachment`. Concrete subclass overrides `invokeSdk` (HTTP/SSE round-trip + finish-reason wait), `onSuperseded` (`POST /session/:id/abort` first; SIGTERM fallback if subprocess hangs), and the descriptor; everything else (claim + heartbeat + phase watcher + `processingStart`/`End` pairing + `markDelivered`) inherited from `SdkAttachment` / `BaseAttachment`. **No reconnect opt-in** (SDK adapters don't reconnect per `src/adapters/README.md`).
- **Spawn model**: detached Node subprocess matching Copilot bridge / claude-api pattern. Self-exec entry point gated by `require.main === module`. **Adapter-managed `opencode serve` child subprocess** spawned during `run()` between Temporal connect and attachment claim — bound to `127.0.0.1` only, on a probed-free port, with `mdns: false`. New optional dep `@opencode-ai/sdk@~1.14.29` (tilde, not caret — OpenCode ships breaking changes under SemVer minor; tilde stays on the `1.14.x` line). Falling back to raw `fetch` is acceptable if the SDK adds disproportionate dependency weight (decision deferred to impl time per design §8).
- **Tool bridging**: **MCP-native via OpenCode's config block**, `type: "local"` stdio. The adapter synthesizes an inline JSON config (`OPENCODE_CONFIG_CONTENT` env) that registers `claude-tempo` as an OpenCode MCP child (`command: ["node", "<absolute path to dist/server.js>"]`). OpenCode spawns a **second** copy of `src/server.ts` as its own stdio MCP subprocess and dispatches tool calls there directly. **No `mcp-bridge.ts` analog needed** — OpenCode owns tool-shape translation per provider. The adapter only **observes** tool execution via `/event` SSE for telemetry and finish-reason detection.
- **Recruit surface**: extend `agent` enum from `'claude' | 'copilot' | 'mock' | 'claude-api'` to add `'opencode'`. The existing `model` Zod field's regex (`^claude-[a-z0-9-]+$`) is too restrictive for OpenCode's `provider/model` strings; relax to `^[a-z0-9][a-z0-9-/.:_]*$` so `'anthropic/claude-opus-4-7'`, `'openai/gpt-4o'`, `'ollama/llama3'`, etc. all flow through. **No new `provider` field** — combined `provider/model` is the OpenCode-native shape (matches their config). `AgentType` extended one value (additive). `AdapterRegistry.resolveFromAgentType` extended one line. **No new signals/queries/updates** on `claudeSessionWorkflow`.
- **Conversation state**: **server-side persisted by OpenCode.** The adapter sends only the new turn's `parts` via `POST /session/:id/prompt_async`; OpenCode appends to its own session history. **No per-turn `buildAnthropicMessages()` analog** — eliminates ~80 LoC vs claude-api. The adapter stashes `session.id` on workflow metadata via `updateMetadataSignal` (matches Copilot's `sessionId` stash pattern) so cross-restart attachment can recover the OpenCode-side session. **Cross-restart persistence verification deferred to Phase C impl time** — OpenCode's TUI session-sharing feature implies persistence, but the adapter MUST verify and fall back to workflow-history replay if not.
- **Streaming consumption**: SSE `GET /event` connection scoped to the active session id. Adapter accumulates `assistant.message` text parts, observes tool execution events for telemetry, waits for the `finish` reason on the final assistant message. **Tool streaming is OFF by default in v1.14.29** — no `input_json_delta` partial-parse complexity; tool calls arrive in a single event.
- **Cancellation**: `POST /session/:id/abort` is the primary path — clean, no subprocess kill required. Subprocess SIGTERM is the fallback if abort hangs (timeout-bounded), then SIGKILL. The `onSuperseded()` hook fires abort on lease revocation; `processingEnd` releases in the inherited `finally`.
- **Per-turn usage**: structured stderr log line in v1 (`[claude-tempo:opencode] turn-usage provider=… model=… input=… output=… cache_read=… elapsed_ms=… player=…` — same shape family as `claude-api`'s `[claude-tempo:claude-api] turn-usage`, with provider attribution added). Per-provider semantics differ (Anthropic exposes `cache_read`/`cache_creation`; OpenAI doesn't); adapter logs whatever's present, doesn't normalize. **No wire-protocol signal in v1.**
- **Model selection**: recruit-arg precedence → `CLAUDE_TEMPO_OPENCODE_MODEL` env → constants-pinned default (`anthropic/claude-opus-4-7` at impl time, reviewable at next minor SDK bump). Provider/model strings are opaque to claude-tempo — OpenCode validates them at session-create time.
- **Version-probe gate**: warn-only on minor drift from the tested-pinned `~1.14.29`. Refuse would brick users on every minor bump (unacceptable given OpenCode's daily cadence); ignore loses the diagnostic signal. The adapter logs a stderr `WARNING: opencode version X.Y.Z drift from tested ~1.14.29` line on `/global/health` mismatch.
- **Loopback-only single-machine trust model**: hardcode `--hostname 127.0.0.1` in the spawn args (no Bearer auth in v1.14.x; loopback bind is the operational mitigation). `mdns: false` in the inline config to avoid leaking session presence over Bonjour. Documented in design §6.

Seven open questions — locked answers:

| Q | Locked decision | Rationale |
|---|---|---|
| Q1: Subprocess-per-player vs shared | **Per-player** | Simpler crash recovery, isolation, matches Copilot pattern. Subprocess-shared could conserve ~50-100 MB per player but tightly couples lifecycles — a stuck `prompt_async` for one player would block all others. Phase 2 optimization candidate. |
| Q2: Config delivery | **Inline `OPENCODE_CONFIG_CONTENT` env** | No filesystem cleanup risk; operator-debuggability via stderr config-log (with secrets redacted). Filesystem path retained as Phase 2 fallback if inline-env hits length limits. |
| Q3: MCP transport | **`type: "local"` stdio** | Symmetric with `claude-api`'s in-process MCP server; no new wire surface; auto-cleanup on subprocess exit. Phase 2 optimization candidate to share a single MCP server across multiple adapters via `type: "remote"`. |
| Q4: Port allocation | **Probe a free port at recruit** | Default 4096 not guaranteed free; matches the daemon HTTP server pattern (`src/http/server.ts` already does this). Adapter passes `--port <probed>` explicitly to `opencode serve`. |
| Q5: Provider/model recruit-arg shape | **Combined `model: 'provider/name'`** | Opaque pass-through string; matches OpenCode's own config shape; fewer surface fields. Separate `provider` + `model` fields are a v2 if cross-cutting per-provider knobs (auth, region, base-url) emerge. |
| Q6: Session persistence across server restart | **Verify at Phase C impl time** | OpenCode's TUI session-sharing feature suggests persistence, but adapter MUST verify and fall back to workflow-history replay if not. Architecturally identical-shape outcome either way; just affects how the restart path reconstitutes the OpenCode-side session. Surfaced as the single Phase B → C carry-forward decision. |
| Q7: Version-probe-gate strictness | **Warn-only** | Refuse would brick on every minor bump (unacceptable given OpenCode's daily cadence); ignore loses the diagnostic signal. Stderr WARNING line is a `[claude-tempo:opencode] WARNING: opencode version X.Y.Z drift from tested ~1.14.29` shape; operators correlate failures with version drift. |

## Consequences

- **Positive**:
  - **Multi-provider headless capability** — claude-tempo ensembles can recruit a player driven by Anthropic, OpenAI, GitHub Copilot, ChatGPT account-based, Bedrock, Vertex, Ollama, or any other Models.dev-backed provider, all through a uniform claude-tempo MCP surface.
  - **Strict additivity on the workflow surface** — zero new signals/queries/updates; the adapter uses only existing wire contracts. Old workflow runs are unaffected. `agentType: 'opencode'` is a string-enum addition.
  - **Single source of truth for tool surface** — OpenCode consumes `src/server.ts` directly via stdio MCP; every existing and future tempo tool lights up automatically across all OpenCode-supported providers, with no per-provider integration code.
  - **No translation layer needed** — `claude-api`'s `mcp-bridge.ts` (158 LoC) has no analog because OpenCode owns tool-shape translation per provider. Net LoC win against the bottom-up estimate.
  - **Server-side history** — OpenCode persists conversations server-side; no per-turn `buildAnthropicMessages()` rebuild (~80 LoC saved vs claude-api). Adapter sends only the new turn's parts.
  - **Tool streaming OFF by default in v1.14.29** — no `input_json_delta` partial-parse complexity; tool calls arrive in a single event. Direct contrast with claude-api's verification-addendum #4 landmine.
  - **Doom-loop detection + context compaction built into OpenCode** — adapter's responsibility shrinks vs claude-api (which emits a workflow message and exits on context overflow). Phase 2 follow-up to wire into context-compacted-event observability.
  - **Lifecycle hygiene inherited** — `SdkAttachment` covers ~80 % of the wiring. Concrete adapter is small (~350-500 LoC for `adapter.ts`) and focused; the new piece is the HTTP/SSE bridge (~150-250 LoC) and subprocess management.
  - **Cancellation-clean** — `POST /session/:id/abort` is a dedicated endpoint; cleaner than tearing down a subprocess. Ghost-reply window bounded per design §6 (mirrors §9.3 of session-lifecycle-rebuild-v2).
  - **Optional dependency pattern matches Copilot / claude-api** — non-opencode users pay no install cost. Recruit pre-flight rejects with an actionable error if the SDK or `opencode` binary is missing.
- **Negative**:
  - **Subprocess memory cost** — ~50-100 MB per active opencode player (one `opencode serve` per session). Subprocess-shared optimization is a Phase 2 candidate if mixed-ensemble memory becomes a problem.
  - **HTTP-API minor-bump break risk MEDIUM-HIGH** — OpenCode HTTP API still labeled "experimental"; minor bumps have shipped breaks (`parts` data model, `userMessage.variant`). Tilde-pin discipline is mandatory; expect ~1 dev-day per minor bump chasing API breaks until OpenCode adopts a stability policy. **Documented `claude-api` fallback** — operators wanting Anthropic-only without third-party dep can fall back to the v0.x adapter with no recruit-flag change beyond `agent`.
  - **No HTTP auth in v1.14.x** — `opencode serve` ships without Bearer auth. Loopback-bind (`127.0.0.1`) is the operational mitigation; anyone with shell access on the same machine can drive the session, but that user is the spawning user already with that access. Single-machine-trust model documented.
  - **Cross-platform signal-handling unknowns** — Bun runtime on Windows handles SIGINT/SIGTERM differently from POSIX. Adapter's graceful-detach path needs Windows-specific testing. Cross-platform matrix is the Phase C engineer's responsibility per design §9.
  - **`@opencode-ai/sdk` install is opt-in** — recruit pre-flight rejects with an actionable error if missing. Operators must `npm install @opencode-ai/sdk` to use the adapter.
  - **Q6 decision is deferred to Phase C** — session-persistence-across-server-restart is the single carry-forward unknown. Phase B locks the architecture either way; Phase C engineer verifies and picks the restart-path implementation. Worst case: ~80 LoC of workflow-history replay matches `claude-api`'s pattern.
  - **`/experimental/*` endpoints constrained** — adapter must NOT use `/experimental/tool/ids`, `/experimental/tool`, `/experimental/find`, `/experimental/file/content`. Hot path restricted to non-experimental endpoints. Documented in design §5.
  - **No reconnect opt-in for SDK adapters** — lease loss exits the process; daemon `reconcile-on-boot` or operator `restart` recovers. Matches Copilot / claude-api; revisit if a specific need emerges.
- **Neutral**:
  - **~805-1,175 LoC bottom-up estimate** matches researcher's range, slightly over #449's stated 600-1,000 ceiling. Design §8 proposes tightening (shared SDK-class lifecycle test helper, raw `fetch` over `@opencode-ai/sdk` if SDK weight bites) to land back inside 1,000. Single PR, additive, no breaking changes.
  - **Adapter conformance** — the new adapter must pass the SDK-class lifecycle baseline currently exercised by `test/adapter-sdk-lifecycle-v2.test.ts` (or its successor — see design §9). New `test/adapter-opencode-lifecycle-v2.test.ts` follows the existing per-adapter naming convention.
  - **Headless-identity addendum is OPENCODE-specific** — unlike claude-api (where the player is NOT file-op-capable), an opencode player IS file-op-capable through OpenCode's own built-in tool registry. The system-prompt addendum tells the model "you have claude-tempo MCP tools PLUS OpenCode's built-ins (file edits, shell, web)" — design §10. This is the substantive UX delta vs claude-api: opencode players are full-power, just multi-provider.

## Alternatives considered

- **Subprocess-shared `opencode serve`** (one server hosting N sessions across players) — rejected for v1; Phase 2 optimization candidate. Memory savings ~50-100 MB per player are real, but lifecycle coupling is a worse trade-off for v1: a stuck `prompt_async` for one player would block all others on the shared server. Per-player isolation is the simpler crash-recovery story. Revisit when mixed-ensemble memory becomes a measurable problem.
- **`type: "remote"` HTTP MCP transport** — rejected for v1; Phase 2 optimization candidate. Would let a single MCP server instance be shared across all adapters, composing with the daemon's existing HTTP layer (`src/http/`). Adds network surface (auth concerns), requires port allocation for the MCP server. Phase 1's `type: "local"` stdio is symmetric with `claude-api`'s in-process pattern and avoids new wire surface.
- **Filesystem config write** (`~/.claude-tempo/opencode-{playerId}.json`) — rejected. Cleanup hassle (stale configs if adapter crashes mid-spawn); permissions concerns on multi-user systems. Inline `OPENCODE_CONFIG_CONTENT` env is cleaner; secrets-redacted stderr config-log gives operators inspectability without filesystem state.
- **Separate `provider: 'anthropic'` + `model: 'claude-opus-4-7'` recruit args** — rejected. Surface bloat for no benefit; OpenCode's own config uses combined `provider/model` strings. If cross-cutting per-provider knobs (region, base-url, OAuth scope) emerge in Phase 2, separate fields can be added additively then.
- **Default `--port 4096`, retry-on-conflict** — rejected. Default 4096 not guaranteed free; matches the daemon HTTP server pattern (`src/http/server.ts` already probes a free port at startup). Probe-at-recruit is the cheaper-by-design choice and avoids race conditions in CI environments running multiple ensembles.
- **Refuse on `/global/health` version drift** — rejected. OpenCode's daily release cadence would brick the adapter on every minor bump; unacceptable. Warn-only is the right balance: operators see the diagnostic signal without losing functionality on innocuous bumps.
- **Ignore `/global/health` version drift** — rejected. Loses diagnostic signal entirely. Operators must be able to correlate failures with version drift; warn-only is mandatory.
- **Vercel AI SDK / LangChain wrappers** — rejected. claude-tempo already owns the adapter abstraction; another layer adds indirection without surface gain. OpenCode's own SDK + raw `fetch` cover the wire surface we need.
- **Replicate OpenCode's tool dispatch into claude-tempo (own all tools client-side)** — rejected. Defeats the architectural keystone; would re-introduce a `mcp-bridge.ts`-style translation layer per provider OpenCode supports. Owning `tool_use` round-tripping is OpenCode's job; we leverage that.
- **`@opencode-ai/sdk@^1.14.29`** (caret) — rejected. OpenCode ships breaking changes under SemVer minor (e.g., `parts` data model, `userMessage.variant`). Tilde stays on the `1.14.x` line; reviews happen at minor bump.
- **Use Claude Code CLI as a multi-provider proxy** — rejected. Claude Code is Anthropic-only by design. The whole point of #449 is multi-provider via OpenCode.
- **`'sst-opencode'` / `'oc'` / `'opencode-serve'`** as `AgentType` value — rejected. `'opencode'` matches the upstream project's primary name and is the most-likely operator-typed value. Pairs cleanly with existing `'claude' | 'copilot' | 'mock' | 'claude-api'`.

## Forward-looking notes

- **Phase 2 cross-provider tool parity testing** — `cue`/`report`/`recall` should behave consistently across Anthropic, OpenAI, Bedrock, Ollama, Copilot opencode-players. Per #449's body explicitly out of scope for Phase 1 / Phase B. File a separate Phase 2 issue when ready.
- **Phase 2 per-provider quota / throttling awareness** — distinct from claude-api's #131 stderr-only telemetry. Different providers have different rate-limit shapes; an opencode-aware throttle would aggregate per-provider-per-session.
- **Phase 2 OpenCode version-drift CI** — pin against latest `~1.14.x` in CI; detect breaking changes within 24h of each minor release. Matches release cadence; avoids surprise regressions.
- **Phase 2 subprocess-shared optimization** — if mixed-ensemble memory becomes a problem, share one `opencode serve` instance across multiple opencode players in the same ensemble. Architectural delta is small (lifecycle coupling + session-id routing); LoC delta is moderate.
- **Phase 2 `type: "remote"` MCP transport** — share a single claude-tempo MCP server across all adapter types via daemon HTTP. Composes with #94/#95 SSE work. Reduces per-player memory footprint; useful if subprocess-shared lands.
- **Phase 2 OpenCode OAuth flows** — provider-specific OAuth (GitHub Copilot via OpenCode, ChatGPT account auth) bypassed in v1 via env-var pass-through. Verify whether claude-tempo can pass through cleanly or needs a wrapper.
- **Phase 2 advisor strategy** — composes naturally with multi-provider. Per-player advisor opt-in could pick `model: 'openai/gpt-4o'` for the executor and `model: 'anthropic/claude-opus-4-7'` for the advisor, both running through OpenCode adapters. File a separate issue when advisor strategy is ready.
- **Wire-protocol additions post-v1.0** must register with the protobuf field-number plan in `protos/README.md` reservations log when #319 (protobuf migration) lands. The new `agentType: 'opencode'` value is a string-enum addition — minimal protobuf surface.
- **Reconnect opt-in for SDK adapters** — current `src/adapters/README.md` guidance says SDK adapters don't reconnect. OpenCode's server-side persistence makes reconnect more attractive (session is alive, just lost the lease); revisit if specific need emerges in Phase 2 (e.g., long-running scheduled work where lease churn becomes painful).
- **Dependency-stability hedge** — `claude-api` (#131) is the documented Anthropic-only first-party fallback. If OpenCode dep ever bites in a way that takes the adapter offline, ensembles can fall back to `agent: 'claude-api'` with no recruit-flag change beyond the agent value. This is a real architectural property, not aspirational — both adapters are SDK-class, both use `SdkAttachment`, both expose the same tempo MCP surface.

## References

- [`docs/design/449-opencode-adapter.md`](../design/449-opencode-adapter.md) — full design (14 sections, interface skeletons, integration points, test strategy, decision log)
- [`docs/research/449-opencode-adapter-spike.md`](../research/449-opencode-adapter-spike.md) — Phase A research spike (PR #468) — OpenCode surface audit, dependency stability, pattern alignment, MCP-native finding, 7 open design decisions
- Issue #449 — Phase 1 scope + Phase 2 deferred questions
- ADR 0012 — [`0012-claude-api-adapter.md`](0012-claude-api-adapter.md) — closest design-spike template precedent (also: ADR 0007 TempoClient split, ADR 0008 coat-check, ADR 0009 protobuf, ADR 0011 player-saveable state, ADR 0014 dev-mode mock adapter)
- `src/adapters/sdk/base.ts` — `SdkAttachment` lifecycle contract (~80 % of adapter wiring inherited)
- `src/adapters/copilot/adapter.ts` — closest existing subprocess-pattern precedent
- `src/adapters/claude-api/adapter.ts` — closest existing HTTP-bridge precedent (pinned-runId, PID file, terminal-cleanup wiring, optional-dep guard)
- `src/adapters/base.ts:1346+` — `AdapterRegistry`, `resolveFromAgentType`
- `src/adapters/index.ts` — registry bootstrap (one-line addition)
- `src/adapters/README.md` — adapter contract + reconnect opt-in guidance
- `src/tools/recruit.ts` — agent-enum surface + preflight pattern
- `src/types.ts` — `AgentType` union (one-value addition)
- [`docs/design/session-lifecycle-rebuild-v2.md`](../design/session-lifecycle-rebuild-v2.md) §4 (adapter extensibility), §4.3 (lifecycle), §4.5 (conformance suite), §9.3 (ghost-reply window)
- [OpenCode Server docs](https://opencode.ai/docs/server/), [SDK docs](https://opencode.ai/docs/sdk/), [MCP Servers docs](https://opencode.ai/docs/mcp-servers/), [Config docs](https://opencode.ai/docs/config/)
- `@opencode-ai/sdk` — auto-generated TypeScript client from OpenCode's OpenAPI 3.1 spec
- MCP TypeScript SDK — `@modelcontextprotocol/sdk` `Server`, `Client`, stdio transport
