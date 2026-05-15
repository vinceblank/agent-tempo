# Headless Claude Code adapter — Phase 1 (`claude -p` subprocess, taps subscription extra-usage)

> **Status**: Design proposal (spike — no implementation in this branch)
> **Author**: tempo-researcher
> **Branch**: `design/520-claude-code-headless`
> **Tracking**: issue [#520](https://github.com/vinceblank/agent-tempo/issues/520)
> **Audience**: implementing engineer (tempo-eng pickup), tempo-architect for ratification, conductor for review.

---

## 0. TL;DR

Add a fifth adapter — `src/adapters/claude-code-headless/` — that drives the **official Claude Code CLI** (`claude -p`) as a per-turn subprocess. The point: the host's existing Claude Code OAuth session does the billing, so the adapter naturally taps **subscription extra-usage credits** that raw-API-key adapters (`claude-api`, #131) cannot reach.

New `ClaudeCodeHeadlessAttachment extends SdkAttachment` mirrors the `claude-api` and `opencode` patterns: detached Node subprocess, `claimAttachment` + heartbeat + phase-watcher lifecycle inherited free, single override of `invokeSdk` for the per-turn `claude -p` invocation.

The new adapter is selected via `recruit({ agent: 'claude-code-headless', ... })`. **Tool bridging uses Claude Code's native `--mcp-config` flag** — the adapter synthesizes an inline JSON config that registers `agent-tempo` as a stdio MCP child of the spawned `claude` process. **No `mcp-bridge.ts` translation layer** (matches `opencode` #449's MCP-native architecture, not `claude-api` #131's in-process bridge).

**Cross-adapter consistency with #521**: Issue [#521](https://github.com/vinceblank/agent-tempo/issues/521) (just-filed, parallel to this design) flags the `claude-api` adapter's tight retry loop on non-retriable 4xx — no error classification, no backoff, no give-up. The same failure-mode shapes apply here at the **subprocess-exit boundary**, not the SDK-call boundary. Decision: **defer to #521's classifier shape**, with the subprocess-specific translation layer documented in §5.8. See §5.8 for the classifier-translation table; see §13's Q4 for the locked decision.

**Locked decisions on the 5 open questions** (issue body):

| Q | Decision | Rationale |
|---|---|---|
| 1. Persistence model | **Per-turn `claude -p` invocation** with `--session-id` + `--resume` for continuity. | Simpler control flow; abort = subprocess SIGTERM; matches OpenCode's per-turn `prompt_async` shape. Long-lived `claude` via `--input-format stream-json` is undocumented (per Anthropic's own issue #24594). Pay subprocess startup cost (~1-2s) for the simplification. |
| 2. Session continuity (restart / encore / migrate) | **Stash session UUID on workflow metadata via `updateMetadataSignal`**; resume via `--session-id <uuid>` on every turn AND on adapter restart. **Cross-machine `migrate` not supported in v1** — Claude Code persists session JSONL per-cwd in `~/.claude/projects/<encoded-cwd>/`, so the resume only works from the same host + cwd. | Identical to Copilot/OpenCode metadata stash pattern. Cross-machine migrate deferred to Phase 2 (would need session-export/import or a remote session store). |
| 3. Tool surface | **Full inheritance + agent-tempo MCP overlay.** Spawn with `--strict-mcp-config --mcp-config <synthesized>` so only agent-tempo's MCP server is registered (no stray user `.mcp.json` configs). File-op / shell / web tools inherit from the CLI by default. **Permission mode**: `--permission-mode acceptEdits` default; `--dangerously-skip-permissions` opt-in via recruit arg. | Strictly more capable than `claude-api` — file-ops come free. `acceptEdits` matches operator expectation that recruited players can do their job; full bypass is opt-in. |
| 4. Stream-json error mapping | **Map `system/api_retry` event categories** to agent-tempo failure modes: `authentication_failed` / `oauth_org_not_allowed` → exit + surface "log in via `claude` first"; `billing_error` → exit + surface "subscription/extra-usage exhausted"; `rate_limit` / `server_error` → let CLI's own backoff handle (log warning); subprocess exit code != 0 → exit and let next poll retry. **Result frame** (`type: 'result'`) closes the turn cleanly with stop_reason + usage. | Aligns with Anthropic's documented error-category enum (`/en/headless`); operator-actionable error surfaces. |
| 5. Pre-flight contract | **`claude auth status` invocation with 5s timeout** (not a billed call — official supported subcommand). Plus `claude --version` (binary version probe). Both gated by `force: true` bypass. Daemon's `hostProfile.availableAgentTypes` extended to include `'claude-code-headless'` only when both probes pass at boot. | No billed test message; clean op-ergonomic failure mode if user isn't logged in. |

**Wire surface**: zero new signals/queries/updates on `claudeSessionWorkflow`. Strictly additive on `recruit`'s tool schema (`agent: 'claude-code-headless'` enum value), `AgentType` (`… | 'claude-code-headless'`), and `AdapterRegistry.resolveFromAgentType` (one line).

**Estimated implementation cost**: ~600–850 LoC. Smaller than `claude-api` (~1,000) and `opencode` (~900) because:
- No in-process MCP bridge translation layer (`-200 LoC` vs claude-api)
- No HTTP/SSE consumer (`-300 LoC` vs opencode — `claude -p` writes JSONL to stdout, simple line reader)
- No subprocess lifecycle manager beyond per-turn spawn/wait (`-100 LoC` vs opencode)
- Adds: `--mcp-config` synthesis (~50 LoC), stream-json frame parser (~100 LoC), session-id stash (~30 LoC), pre-flight (~50 LoC)

Single PR, additive, no breaking changes. Estimated 2-3 days for engineer pickup.

**Phase 2 explicitly out of scope** — long-lived subprocess via `--input-format stream-json` (undocumented), cross-machine migrate, custom system prompt overrides, `--max-budget-usd` cost-cap integration, advisor strategy, sandbox-mode tool restrictions.

---

## 1. Why now

Issue #520 motivates the adapter on three orthogonal value props, all complementary to existing adapters:

1. **Subscription extra-usage access** — the immediate trigger. PR #131's `claude-api` adapter hit a 400 `"credit balance too low"` on a smoke test even though the operator had ~$159 of unused subscription extra-usage credits sitting idle. Researcher confirmed (~30 min spike, see [reseach memo](#)) the gap is structural: subscription extra-usage credits are OAuth-gated and unreachable via raw `sk-ant-api03-...` keys. **Spawning the official `claude` binary is the only ToS-clean way for a third-party tool to tap that pool** — Anthropic's [authentication policy](https://code.claude.com/docs/en/authentication) explicitly forbids using subscription OAuth tokens in non-Claude-Code third-party products.
2. **Headless with file-op tools, Anthropic-only path** — `claude-api` is headless but lacks file-ops (deferred to Phase 2 in #131). `opencode` players are headless + file-op-capable but go through a third-party multi-provider tool (extra dep risk, weekly breaking changes per #449's stability stance). `claude-code-headless` players are **first-party Anthropic** + headless + file-op-capable — closing a real gap in the matrix.
3. **CI / scheduled work on a personal subscription** — operators with Pro/Max plans want to run scheduled agent-tempo cron jobs (cleanup PRs, gate evaluators, doctor checks) without burning Console-billed credits. This adapter makes that natively supported.

The new adapter is **independent** of #318 (coat-check), #319 (protobuf), #334 (saveable-state), and #94/#95 (SSE event source). It composes naturally with #449 (`opencode`) and #131 (`claude-api`) — all three are SDK-class, all three inherit `SdkAttachment`, all three expose the same tempo MCP surface.

**Adapter matrix after this PR:**

| Adapter | Class | Provider | Auth | Subscription extra-usage? | File-op tools? | First-party? |
|---|---|---|---|---|---|---|
| `claude-code` | interactive | Anthropic | OAuth (CLI native) | ✅ | ✅ | ✅ |
| `claude-code-headless` (NEW) | sdk | Anthropic | OAuth (via spawned CLI) | ✅ | ✅ | ✅ |
| `claude-api` | sdk | Anthropic | API key | ❌ | ❌ (Phase 2) | ✅ |
| `copilot` | sdk | GitHub Copilot | OAuth (Copilot CLI) | n/a | ✅ (limited) | ❌ |
| `opencode` | sdk | 70+ providers | per-provider | provider-dependent | ✅ | ❌ |

This adapter is the **headless mirror** of the existing `claude-code` interactive adapter. They share the same auth path (host's Claude Code login), the same tool surface, and the same provider — but `claude-code-headless` uses pull-based delivery (`SdkAttachment`) and runs without a terminal, making it suitable for daemon/CI/scheduled contexts.

---

## 2. Existing adapter precedents

The new adapter slots into the existing 2-class registry (`docs/design/session-lifecycle-rebuild-v2.md` §4.1):

| Class | Delivery model | Existing adapters | Base class |
|---|---|---|---|
| `interactive` | push (no LLM block) | `claude-code` | `BaseAttachment` |
| `sdk` | pull (blocks on LLM turn; pairs `processingStart` / `processingEnd`) | `copilot`, `claude-api`, `opencode`, **`claude-code-headless` (new)** | `SdkAttachment` |

Unambiguously **`sdk`** — `claude -p` blocks until the turn completes (or streams stream-json frames over stdout, then exits), and we need the synchronous `processingStart` / `processingEnd` pairing that `SdkAttachment.deliver()` provides.

**`SdkAttachment` (`src/adapters/sdk/base.ts`) gives us free** (same 80 % as `claude-api` / `opencode`):

- `deliver(pinned, msg, prompt, timeoutMs, invokeSdk, ackIds?)` — wraps each turn in `processingStart` (synchronous update) → `invokeSdk` → `processingEnd` (in `finally`) → `markDelivered`.
- `onSuperseded()` hook called when the phase watcher detects lease revocation.
- `startV2Lifecycle(workflowId)` from `BaseAttachment`: claim attachment, start heartbeat (30 s per descriptor), phase watcher, `WorkflowNotFound` handling, `runId` pinning.
- `detachGracefully()` for clean shutdown via `adapterExited`.
- Auto-reconnect for `'continued-as-new'` (#226) handled in base.

**Closest precedents to read alongside this design:**

- **`src/adapters/claude-api/adapter.ts`** — SDK-class scaffolding, dual-purpose entry point, env-var contract, optional-dep pattern (we'll skip the optional-dep gate for this adapter — `claude` binary check belongs in pre-flight, not module-load), in-process MCP bridge (we DON'T use this — see §4).
- **`src/adapters/opencode/adapter.ts`** — subprocess management pattern, MCP-native config synthesis (we DO use this), session-id stash via `updateMetadataSignal`, per-turn spawn lifecycle, two-PID-file pattern.
- **`src/adapters/claude-code/adapter.ts`** — sibling adapter for the same provider; shares the auth assumption (host's `claude` CLI is logged in) but uses interactive class.

**What `ClaudeCodeHeadlessAttachment` overrides:**

- `invokeSdk(prompt, timeoutMs)` — spawns `claude -p --output-format stream-json --verbose --session-id <uuid> [--resume <uuid>] --strict-mcp-config --mcp-config <synthesized> --permission-mode <mode>`, streams stdout JSONL, parses frames, returns assembled assistant text + stop_reason + usage on `result` frame.
- `onSuperseded()` — close subprocess stdin → SIGTERM → SIGKILL fallback after 5s grace.
- `descriptor` — `{ adapterId: 'claude-code-headless', adapterClass: 'sdk', blocksOnLLMTurn: true, heartbeatMs: 30_000 }`.
- `shouldReconnect()` — **NOT** opted in (matches `claude-api`, `opencode`). Lease loss exits the process; daemon's `reconcile-on-boot` or operator `restart` recovers.

---

## 3. Spawn integration

### 3.1 `recruit` tool surface

Extends the existing `recruit` Zod schema additively:

```ts
// src/tools/recruit.ts — additive on the existing schema
{
  // ... existing fields ...
  agent: z.enum(['claude', 'copilot', 'mock', 'claude-api', 'opencode', 'claude-code-headless']).optional()
    .describe(`Which agent to use (default: "${ownAgentType}", same as this session). … "claude-code-headless" runs the official Claude Code CLI as a headless per-turn subprocess; uses the host's existing Claude Code login (OAuth), so it taps subscription extra-usage credits — no API key needed. Requires the "claude" binary on PATH.`),
  // NOTE — `model` recruit-arg is NOT exposed for claude-code-headless in v1.
  // The spawned `claude -p` uses its own default model selection (operator can
  // override via `~/.claude/settings.json`'s `model` field, or by passing
  // `--model` env-var indirection). Rationale: claude-code-headless inherits
  // the host CLI's preferences end-to-end so headless and interactive players
  // on the same host bill against the same model tier. Phase 2 candidate if
  // recruit-time override becomes a real ask.
  // NEW — only meaningful for adapter='claude-code-headless'
  permissionMode: z.enum(['acceptEdits', 'auto', 'bypassPermissions', 'default', 'dontAsk', 'plan']).optional()
    .describe('Permission mode for claude-code-headless adapter. Default "acceptEdits" auto-approves writes + common fs commands. "bypassPermissions" / "dangerouslySkipPermissions" trades safety for speed in trusted contexts. Ignored for other adapters.'),
  dangerouslySkipPermissions: z.boolean().optional()
    .describe('claude-code-headless: pass --dangerously-skip-permissions to bypass ALL permission checks. Use only in sandboxed/trusted contexts. Mutually exclusive with permissionMode.'),
}
```

### 3.2 `AgentType` extension

```ts
// src/types.ts
export type AgentType = 'claude' | 'copilot' | 'mock' | 'claude-api' | 'opencode' | 'claude-code-headless';
```

Strictly additive. Old code that handles a subset falls through to a default branch; the test suite catches any unhandled-case regressions.

### 3.3 `AdapterRegistry.resolveFromAgentType` extension

```ts
// src/adapters/base.ts — one-line extension
resolveFromAgentType(agent: string | undefined): string {
  if (agent === 'copilot') return 'copilot';
  if (agent === 'mock') return 'mock';
  if (agent === 'claude-api') return 'claude-api';
  if (agent === 'opencode') return 'opencode';
  if (agent === 'claude-code-headless') return 'claude-code-headless';   // NEW
  return 'claude-code';
}
```

### 3.4 Pre-flight checks in `recruit`

Before submitting the recruit outbox entry, validate (mirrors the established pattern at `src/tools/recruit.ts`):

1. **Binary probe** — `claude --version` resolves and exits 0 within 3s. Pre-flight rejects with actionable error if missing or hangs (`force: true` bypasses).
2. **Auth probe** — `claude auth status` exits 0 within 5s (no billed call — official supported subcommand). Output parsed to confirm logged-in state. Reject with: *"`claude` is installed but not logged in. Run `claude auth login` (subscription) or `claude auth setup-token` (CI), or recruit with `agent: 'claude-api'` instead."*
3. **Version drift** — log a stderr WARNING (not a reject) if `claude --version` reports a major different from the tested-pinned version. Phase A spike confirms 2.x is current; pin reviewable at next minor.
4. **Cross-host recruit** (`host:` param): the target daemon's `hostProfile.availableAgentTypes` is extended by one entry — the daemon includes `'claude-code-headless'` only if all three probes (binary, auth, version) pass at boot. **NEW host-profile field** `claudeAuthState` (boolean) advertises whether the daemon's host has a logged-in `claude` (so cross-host recruit can fail fast).

### 3.5 Optional dependency + adapter registration

**No new npm optional dep** — `claude` is a system binary, not an npm package. The probe is shell-based (`spawn('claude', ['--version'])`), so the adapter itself has zero new package dependencies. This is a meaningful simplification vs `claude-api` (`@anthropic-ai/sdk`) and `opencode` (`@opencode-ai/sdk`), neither of which is required at adapter-import time but both of which add install-time decisions for end users.

**Install instruction** for new agent-tempo users surfaces the binary requirement in CLAUDE.md, README, and the recruit tool description.

**Registration shape** (per ADR 0012, mirrors the four shipped adapters):

```
src/adapters/claude-code-headless/
├── adapter.ts        # ClaudeCodeHeadlessAttachment + claudeCodeHeadlessDescriptor (colocated)
├── index.ts          # Barrel re-export + binary-probe guard for the require.main self-exec path
├── stream-json.ts    # Frame parser (extracted for unit-testability; ~100 LoC)
├── error-mapper.ts   # Subprocess-failure → #521 classifier translation (§5.8; ~80 LoC)
└── pre-flight.ts     # claude --version + claude auth status helpers (shared with src/tools/recruit.ts)
```

`src/adapters/index.ts` (the shared registry bootstrap) gets one new line: `import './claude-code-headless';` — registers the adapter on module load alongside the four shipped ones. Optional-dep gating (binary check) lives in `pre-flight.ts` and is invoked from both `recruit`'s pre-flight and the `index.ts` self-exec path. **Never a runtime crash mid-session** — failures surface either at recruit time (pre-flight rejects) or at adapter-startup time (`run()` exits with a clear stderr message).

### 3.6 Spawn process model

Detached Node adapter subprocess matching the established pattern; the `claude` CLI is a transient per-turn child of THAT adapter:

```bash
# Spawned by deliverStartRecruitedSession activity:
node dist/adapters/claude-code-headless/adapter.js
#   └── spawn('claude', [-p, --output-format, stream-json, …])  per turn
```

Process tree at runtime:

```
node dist/adapters/claude-code-headless/adapter.js     (long-lived; manages V2 lifecycle + poll loop)
  └── claude -p --output-format stream-json …          (transient, one per turn — exits after `result` frame)
        └── node dist/server.js                        (agent-tempo MCP server — spawned by `claude` for tool dispatch)
```

**One long-lived adapter process; per turn, a transient `claude -p` child plus a short-lived MCP server grandchild.** When idle (no in-flight cue), only the adapter process exists. Memory cost is trivial; the architectural simplicity is worth it.

**Env var contract for the adapter process:**

| Variable | Source | Purpose |
|---|---|---|
| `CLAUDE_TEMPO_ENSEMBLE` | spawner | Workflow-id derivation |
| `CLAUDE_TEMPO_PLAYER_NAME` | spawner | Workflow-id derivation; identity |
| `CLAUDE_TEMPO_TEMPORAL_ADDRESS` | spawner | Temporal connection |
| `CLAUDE_TEMPO_TEMPORAL_NAMESPACE` | spawner | Temporal connection |
| `CLAUDE_TEMPO_PERMISSION_MODE` | operator (optional) | Default `--permission-mode` for child `claude` invocations; recruit arg takes precedence. Default `acceptEdits`. |

**Env var hygiene for the `claude` child:**

- ✅ **PASS THROUGH**: `HOME`, `USER`, `PATH`, locale vars, `CLAUDE_CONFIG_DIR` if set
- ⚠️  **STRIP** before spawning `claude`:
  - `ANTHROPIC_API_KEY` — if present, `claude` would use Console billing (Anthropic auth precedence: env > keychain). The whole point of this adapter is to use the OAuth keychain; setting this env var on the child defeats it.
  - `CLAUDE_CODE_OAUTH_TOKEN` — if present, `claude` uses long-lived OAuth (CI mode). Same precedence concern; let the keychain win.
  - `CLAUDE_TEMPO_*` — adapter-internal, not for the CLI.

The adapter logs a stderr WARNING at boot if `ANTHROPIC_API_KEY` is set in the environment (likely operator confusion: "you're recruiting a `claude-code-headless` player but your env has `ANTHROPIC_API_KEY` set; the adapter strips this from the child to ensure subscription billing — recruit `agent: 'claude-api'` if you wanted Console billing").

No new shell-quoting concerns — the spawn path matches `claude-api`'s and `opencode`'s, both already cross-platform-tested.

---

## 4. Tool bridging — `--mcp-config` strict mode (no translation layer)

The architectural keystone. Direct contrast with `claude-api`'s `mcp-bridge.ts` (158 LoC); aligned with `opencode`'s MCP-native design.

### 4.1 Locked: agent-tempo's MCP server runs as a `claude`-spawned stdio child

The adapter does **NOT** translate tool schemas. Instead:

1. The adapter (running in agent-tempo's adapter process) builds an inline JSON MCP config at turn time.
2. The adapter spawns `claude -p --strict-mcp-config --mcp-config <inline-json>`.
3. `claude` reads the config, spawns `node dist/server.js` as a stdio MCP subprocess (a **second, separate** Node process from the adapter), and registers the tools from `list_tools` alongside its built-in tools.
4. The MCP server (existing `src/server.ts`, unchanged) registers all tempo tools — same surface every adapter sees: `cue`, `report`, `recall`, `ensemble`, `broadcast`, `recruit`, `set_part`, `set_name`, `who_am_i`, `schedule`, `pause`, `play`, `release`, `set_ensemble_description`, `save_state`, `fetch_state`, `clear_state`, etc.
5. When `claude` runs the turn and the LLM elects a tempo tool call, `claude` dispatches via its MCP client, gets the result, and feeds it back into the next LLM call **without the adapter being on the path**.
6. The adapter's only role in tool dispatch is **observing** the tool execution via the stream-json frames — for telemetry and turn-level finish-reason detection.

`--strict-mcp-config` is critical: without it, `claude -p` reads the user's `.mcp.json` from the project root and from `~/.claude/`, potentially registering MCP servers the operator never asked for. Strict mode means **only** the inline config is used.

### 4.2 Inline `--mcp-config` synthesis

The flag accepts either a file path or a JSON string (per `claude --help`: *"Load MCP servers from JSON files or strings (space-separated)"*). The adapter generates the JSON string per turn:

```jsonc
// Synthesized inline (per turn):
{
  "mcpServers": {
    "agent-tempo": {
      "type": "stdio",
      "command": "node",
      "args": ["/abs/path/to/dist/server.js"],
      "env": {
        "CLAUDE_TEMPO_ENSEMBLE": "tempo-impl",
        "CLAUDE_TEMPO_PLAYER_NAME": "tempo-eng",
        "CLAUDE_TEMPO_TEMPORAL_ADDRESS": "127.0.0.1:7233",
        "CLAUDE_TEMPO_TEMPORAL_NAMESPACE": "default"
      }
    }
  }
}
```

Stringify and pass via `--mcp-config <json>` — the flag accepts JSON strings directly. No filesystem temp-file dance, no cleanup. Mirrors `opencode`'s `OPENCODE_CONFIG_CONTENT` env-var pattern, but as a CLI argument.

**Cross-platform argv length**: synthesized JSON is ~400 bytes; well below ARG_MAX on every supported platform (Linux 128KB, macOS 1MB, Windows 32KB).

### 4.3 Why we DON'T need a `mcp-bridge.ts` translation layer

Direct contrast with `claude-api`'s `src/adapters/claude-api/mcp-bridge.ts`:

```
claude-api adapter:
  In-process MCP server (paired with in-process MCP client via InMemoryTransport)
       │  inputSchema → input_schema (Anthropic shape) ← mcp-bridge.ts (158 LoC)
       ▼
  Anthropic Messages API (HTTP)
       │  tool_use blocks streamed back
       ▼
  Adapter dispatches mcp.callTool(), assembles tool_result, feeds next turn

claude-code-headless adapter:
  stdio MCP server (spawned BY `claude`, NOT by adapter)
       │  (no translation — `claude` owns the contract)
       ▼
  Claude Code's tool dispatcher
       │  `claude` calls tools; adapter only observes via stdout JSONL
       ▼
  (Adapter unaware of tool execution mechanics; just reads stream-json frames)
```

The 158 LoC of `mcp-bridge.ts` (Anthropic schema translation) has no analog here. **This is the single largest LoC saving** vs `claude-api` — `claude` already speaks MCP natively as the canonical client.

### 4.4 Tool surface — what the LLM sees

A `claude-code-headless` player has access to:

- **Tempo MCP tools** (via `--mcp-config`): `cue`, `report`, `recall`, `ensemble`, `broadcast`, `recruit`, `set_part`, `set_name`, `who_am_i`, `schedule`, `unschedule`, `schedules`, `pause`, `play`, `shutdown`, `release`, `restart`, `destroy`, `migrate`, `attachment_info`, `agent_types`, `hosts`, `set_ensemble_description`, `save_state`, `fetch_state`, `clear_state`, `restore`, `load_lineup`, `save_lineup`. Tool names are prefixed with `mcp__agent-tempo__` per Claude Code's MCP convention (`claude --help` confirms).
- **Built-in Claude Code tools** (inherited): `Bash`, `Read`, `Write`, `Edit`, `Glob`, `Grep`, `WebSearch`, `WebFetch`, `Task`, `TodoWrite`, `NotebookEdit`, etc.
- **No user MCP servers** (because `--strict-mcp-config`). This is intentional — predictable surface in CI / scheduled contexts.

**Headless-identity addendum** in the system prompt (§10) tells the LLM it's an ensemble player; the addendum doesn't constrain tools — the model picks whatever it needs.

### 4.5 Permission mode — locked: `acceptEdits` default

Per the issue's open question Q3, the adapter must run non-interactively and not block on permission prompts. Three options from `claude -p`:

| Mode | Behavior | Suitable for claude-code-headless v1? |
|---|---|---|
| `default` (interactive) | Prompts on every tool call | ❌ blocks the turn |
| `acceptEdits` | Auto-approves writes + common fs (mkdir, touch, mv, cp) | ✅ **DEFAULT** |
| `dontAsk` | Denies anything not in `permissions.allow` | ✅ via `permissionMode` recruit-arg (locked-down CI) |
| `bypassPermissions` (≡ `--dangerously-skip-permissions`) | Bypasses all checks | ✅ via `dangerouslySkipPermissions: true` recruit-arg |
| `plan` | Plans without executing | ❌ no tool execution |

**Locked: `acceptEdits` default**. Operators can override per recruit via `permissionMode` arg. `dangerouslySkipPermissions: true` is a separate boolean (mutually exclusive with `permissionMode`) for explicit full-bypass intent.

The default's blast radius: writes, common fs commands, and tempo MCP tools auto-approve. Bash beyond the read-only command set (`git diff`, `ls`, etc.) and network requests (`curl`) still need either `--allowedTools` rules or the operator opts into `bypassPermissions`. For Phase 1, the recruit tool description documents the surface clearly; Phase 2 can add `allowedTools` recruit-arg if real usage shows operators want finer control.

---

## 5. Streaming + state

### 5.1 Conversation state — Claude Code persists per-cwd JSONL

Claude Code's session storage:

```
~/.claude/projects/<encoded-cwd>/<session-id>.jsonl
```

Each session is a per-cwd, per-id, append-only JSONL file. `claude -p --resume <session-id>` reads it back; `--continue` resumes the most recent. **Cross-cwd resume does not work** — the adapter must run from the same working directory across turns, or the resume falls through to a fresh session.

Per Phase A spike:

| Phase | claude-side action | agent-tempo-side action |
|---|---|---|
| First turn | Adapter spawns `claude -p --session-id <uuid>` (UUID generated by adapter) | Stash `<uuid>` on workflow metadata via `updateMetadataSignal` (matches Copilot's `sessionId` stash pattern at `src/adapters/copilot/`) |
| Subsequent turns | Adapter spawns `claude -p --session-id <uuid> --resume <uuid>` | Read `<uuid>` from workflow metadata, pass to spawn |
| Restart / encore (#226) | New adapter process re-reads metadata, resumes via `--resume <uuid>` | Same |
| Migrate to different host | **Not supported in v1** — JSONL is local | Document in recruit tool description; defer to Phase 2 |

**Why explicit `--session-id` not `--continue`**: `--continue` resumes "the most recent conversation in the current directory" — order-of-operations dependent and fragile when multiple players share a cwd. Explicit UUIDs are deterministic.

**UUID source**: adapter generates a UUIDv4 on first turn (`crypto.randomUUID()`), stashes via `updateMetadataSignal`. Mirrors Copilot. The JSONL file ends up named `<uuid>.jsonl` in `~/.claude/projects/<encoded-cwd>/`.

### 5.2 Per-turn vs long-lived subprocess — locked: per-turn

The Q1 carry-forward decision. Two architectures considered:

| Architecture | Pros | Cons |
|---|---|---|
| **(A) Per-turn `claude -p`** ← **LOCKED** | Simpler control flow; abort = SIGTERM; stateless adapter logic; no subprocess crash recovery; matches OpenCode's `prompt_async` shape; testable | ~1-2s subprocess startup cost per turn (warmed paths via `claude --bare` would help but skip OAuth — see §3.6 env hygiene); per-turn JSONL append (cwd-local I/O, fine on every supported FS) |
| (B) Long-lived `claude` with `--input-format stream-json` | Faster turn latency; one subprocess per session | Stream-json input format is **undocumented** (Anthropic issue #24594); abort requires close-stdin or signal; subprocess-crash recovery is harder; introduces subprocess-state in a place we don't otherwise have it |

**Locked: (A)**. The per-turn cost is small (~1-2s vs typical 20+ second turn duration), the simplicity is large, and the long-lived path depends on undocumented behavior we'd likely have to revisit on every Claude Code minor bump. **Phase 2 candidate** to switch to (B) when the input-format stream-json schema stabilizes and operators report turn latency as a real complaint.

### 5.3 Stream-json wire format

`claude -p --output-format stream-json --verbose --include-partial-messages` writes newline-delimited JSON frames to stdout. Per [Anthropic's headless docs](https://code.claude.com/docs/en/headless) and external references, the frame schema:

| Frame `type` | Subtype / shape | Adapter handling |
|---|---|---|
| `system` | `subtype: 'init'` — first frame; reports `model`, `tools`, `mcp_servers`, `plugins`, `plugin_errors`, `session_id` | Verify `session_id` matches the adapter-generated UUID; log MCP server registration confirmation; fail loudly if `plugin_errors` non-empty (likely a config error) |
| `system` | `subtype: 'api_retry'` — retry events with `attempt`, `max_retries`, `retry_delay_ms`, `error_status`, `error` (category enum) | Categorize error per §5.4 |
| `system` | `subtype: 'plugin_install'` — only when `CLAUDE_CODE_SYNC_PLUGIN_INSTALL` set | Ignore in v1 (we don't set the env var) |
| `assistant` | Turn-level assistant message | Accumulate text content for stderr telemetry log |
| `user` | Tool result wrapped as user turn | Observe for telemetry; `tool_use_id` correlation if needed for Phase 2 |
| `stream_event` | Token-delta and tool-call events when `--include-partial-messages` is set | Optional in v1 (use `--include-partial-messages` for richer telemetry; skip if turn-text accumulation is enough) |
| `result` | Final turn frame; has `stop_reason`, `total_cost_usd`, `usage`, `session_id`, `result` (assembled text) | **Turn-completion signal.** Return assembled text + stop_reason + usage from `invokeSdk`; emit per-turn telemetry log; close subprocess |

**Frame source**:
- The CLI's `--output-format stream-json` doc: `"newline-delimited JSON for real-time streaming"`
- The CLI help text: confirms `--include-partial-messages` requires `--output-format=stream-json`
- The headless docs explicitly enumerate `system/api_retry` (full schema) and `system/init` (full schema)
- `stream_event` shape inferred from the docs' jq example: `select(.type == "stream_event" and .event.delta.type? == "text_delta")` — confirms `stream_event` wraps an Anthropic SSE event under `.event`
- `result` shape: per the `--output-format json` doc, the JSON envelope has `result`, `session_id`, `total_cost_usd` — `stream-json` emits the same envelope as the closing frame

**Implementation**: line-buffered stdout reader (split on `\n`), `JSON.parse` each non-empty line, dispatch on `type` + `subtype`. Pure code; trivial to unit-test with synthesized fixtures.

**Frame parser fixture corpus**: §11.1 lists fixtures the engineer must capture during impl-time spike (one capture from a real `claude -p` invocation per scenario: success, tool-use, api_retry, billing_error). These become the basis for offline unit tests.

### 5.4 Error mapping — `system/api_retry` categories

Per [headless docs](https://code.claude.com/docs/en/headless), `system/api_retry` events carry an `error` field with category enum:

| Category | agent-tempo handling |
|---|---|
| `authentication_failed` | Exit 1 immediately. Surface to operator: `"claude is not logged in or token expired. Run 'claude auth status' to diagnose."` Don't retry. |
| `oauth_org_not_allowed` | Exit 1. Surface: `"OAuth org access denied. Operator needs to authorize agent-tempo via 'claude auth login --org <id>' or recruit with agent: 'claude-api'."` |
| `billing_error` | Exit 1. Surface: `"Subscription extra-usage exhausted or billing issue. Top up at console.anthropic.com or wait for plan reset. Recruit agent: 'claude-api' to use Console credits instead."` |
| `rate_limit` | Log WARNING; let CLI's own backoff handle (the retry event tells us it's already being retried) |
| `invalid_request` | Exit 1; this is a bug — log full retry-event payload for triage |
| `server_error` | Log WARNING; let CLI's own backoff handle |
| `unknown` | Log WARNING; let CLI's own backoff handle |

> **Spike check**: `max_output_tokens` appears in the docs as a `system/api_retry` `error` category but is more naturally expressed as a `result` frame `stop_reason` (matching claude-api's `max_tokens` stop_reason). Engineer verifies at impl time which path the CLI actually emits and either keeps a row in this table or drops it (see §11.4).

**Subprocess-level errors** (orthogonal to retry events):

| Symptom | Adapter handling |
|---|---|
| Subprocess exits with code != 0 (no `result` frame) | Log stderr from subprocess; treat as turn failure; do NOT call `markDelivered`; message stays PENDING for next poll. Same retry semantics as claude-api §5.4. |
| Subprocess hangs > `TURN_TIMEOUT_MS` | Adapter SIGTERMs the subprocess; `processingEnd` fires in `SdkAttachment.deliver()`'s `finally`; message stays PENDING |
| Subprocess crashes mid-stream (SIGSEGV, OOM) | Same as exit != 0; message stays PENDING |
| stdout JSON parse error | Log line; skip (defensive — should never happen but let's not crash on malformed frames) |

### 5.5 Retry-loop discipline — defer to #521's classifier

Issue #521 flags that `claude-api`'s adapter retry loop has three independent gaps: no error classification, no backoff, no give-up budget. The proposed fix is a `fatal | retriable-with-backoff | retriable-immediate` classifier (parallel to `src/adapters/terminal-error.ts`'s `isTerminalWorkflowError` for Temporal-side errors).

**The same failure-mode shapes apply here**, but at the **subprocess-exit boundary** rather than the SDK-call boundary. Translation table:

| #521 classifier output | claude-api source signal | claude-code-headless source signal | Adapter behavior |
|---|---|---|---|
| `fatal` | `Anthropic.APIError` 400 `invalid_request_error`, 401, 403, 404 | `system/api_retry` event with `error: 'authentication_failed' \| 'oauth_org_not_allowed' \| 'billing_error' \| 'invalid_request'`, OR subprocess exit != 0 with stderr matching auth-failure regex | Detach immediately; `requestDetachSignal` with structured reason; surface to operator via `attachment_info` |
| `retriable-with-backoff` | `APIError` 5xx, 529, network errors, `ETIMEDOUT` | Subprocess exit != 0 with no `system/api_retry` events captured (transient subprocess crash) | Apply exponential backoff (2s → 4s → 8s → 16s → 32s, capped 60s); leave message PENDING for next poll; track consecutive-failure count |
| `retriable-immediate` | Lease lost during streaming, abort fired | `onSuperseded` SIGTERM during in-flight subprocess | Loop continues — message stays PENDING for next adapter (after restart) to pick up |

**Retry budget**: shared with #521 — N=10 consecutive `retriable-with-backoff` failures → escalate to `fatal` and detach.

**Reset semantics**: counter resets to 0 on **any successful turn** (`result` frame seen + `markDelivered` succeeded). On adapter restart (lease loss, crash, operator restart), counter starts fresh at 0 — no cross-process accounting. Rationale: a pure in-memory budget with success-driven reset matches the "is something sustained-broken vs transient" intent without requiring durable state.

**Important asymmetry**: `claude -p`'s **internal** retry loop is observable to us via `system/api_retry` frames, but we do NOT add a second retry layer on top. When the CLI emits `api_retry` and continues, we let it. We only act on **subprocess termination** signals (exit code, no `result` frame). This means our classifier is **simpler** than claude-api's — we don't have to wrap each turn in a try/catch around `messages.create` because the CLI's own retry hides transient blips from us.

**Decision**: **share the classifier module with claude-api** — locate at `src/adapters/sdk/api-error-classifier.ts` (a peer of `src/adapters/sdk/base.ts`) so both adapters import it. Each adapter provides its own source-signal-to-error-shape adapter (claude-api's reads the `Anthropic.APIError` structure; claude-code-headless's reads the `system/api_retry` frame + subprocess exit code). The classifier itself is the shared core — making future error categories (e.g. new Anthropic error codes) trivially pickup-by-both-adapters.

**Sequencing**: #521 ships first → defines the classifier interface → #520 picks it up. If #521 lands after this PR, the headless adapter ships with a local-only classifier and migrates to the shared one in a follow-up. Either order works; the architectural shape doesn't change.

### 5.6 Per-turn usage telemetry

```ts
log(`turn-usage adapter=claude-code-headless model=${frame.model ?? 'unknown'} input=${frame.usage?.input_tokens ?? 0} output=${frame.usage?.output_tokens ?? 0} cache_read=${frame.usage?.cache_read_input_tokens ?? 0} cache_create=${frame.usage?.cache_creation_input_tokens ?? 0} elapsed_ms=${elapsedMs} cost_usd=${frame.total_cost_usd ?? 0} player=${playerName} stop_reason=${frame.stop_reason ?? 'none'}`);
```

Same shape family as `claude-api` and `opencode` `[agent-tempo:*] turn-usage` log lines — operators already grep `turn-usage` for cost monitoring. **`cost_usd` is a v1 win** for this adapter — `claude -p`'s `result` frame includes `total_cost_usd` per Anthropic's documented JSON envelope, so we get authoritative cost without computing from token counts ourselves.

**No wire-protocol signal in v1** — same forward-compatibility argument as claude-api §5.6 / opencode §5.6.

### 5.7 Cancellation — lease revocation → SIGTERM (mirrors `opencode/adapter.ts:160-173`)

```ts
class ClaudeCodeHeadlessAttachment extends SdkAttachment {
  private childProcess: ChildProcess | null = null;

  protected onSuperseded(): void {
    const child = this.childProcess;
    this.childProcess = null;
    if (!child) return;
    log('lease revoked — closing claude subprocess (SIGTERM)');
    // Try graceful close first (let claude flush any in-flight stream-json frames);
    // SIGKILL after grace timeout if needed.
    try { child.kill('SIGTERM'); } catch (err) { log('SIGTERM threw:', (err as Error)?.message ?? err); }
    setTimeout(() => {
      if (!child.exitCode && !child.killed) {
        log('SIGTERM grace expired — escalating to SIGKILL');
        try { child.kill('SIGKILL'); } catch { /* already gone */ }
      }
    }, 5_000);
  }
}
```

`SdkAttachment`'s phase watcher fires `onSuperseded()` when `attachmentInfo.currentAttachment.attachmentId` diverges from our token. The adapter SIGTERMs the in-flight `claude` subprocess; `processingEnd` fires in `SdkAttachment.deliver()`'s `finally`; the adapter process exits cleanly. Ghost-reply window documented in `docs/design/session-lifecycle-rebuild-v2.md` §9.3 — same as Copilot / claude-api.

**Subprocess SIGTERM behavior**: `claude -p` handles SIGTERM gracefully and exits without writing the `result` frame (so the adapter knows the turn was aborted, not completed). If SIGTERM hangs (rare — claude-code 2.x is well-behaved), SIGKILL after 5s. Pattern is identical to `src/adapters/opencode/adapter.ts:160-173` (graceful → forced fallback) — reuse the `helpers.ts:waitForExit` utility verbatim.

### 5.8 Subprocess-error → classifier translation

See §5.5 above for the cross-adapter classifier discussion. This section codifies the precise translation:

```ts
// src/adapters/claude-code-headless/error-mapper.ts (new — ~80 LoC)
import { classifyApiError, type ApiErrorCategory } from '../sdk/api-error-classifier';   // shared with claude-api per #521

export interface SubprocessFailureContext {
  exitCode: number | null;   // null if we SIGTERMed
  stderr: string;            // captured stderr (may be empty)
  observedRetryEvents: ApiRetryFrame[];  // any system/api_retry frames we saw on stdout
  resultFrameSeen: boolean;
}

export function mapSubprocessFailure(ctx: SubprocessFailureContext): ApiErrorCategory {
  // Result frame seen → success path; caller should not be invoking us
  if (ctx.resultFrameSeen) throw new Error('mapSubprocessFailure called on success — programmer error');

  // Auth/billing/oauth_org failures observed via api_retry → fatal
  for (const evt of ctx.observedRetryEvents) {
    if (evt.error === 'authentication_failed' || evt.error === 'oauth_org_not_allowed' || evt.error === 'billing_error') {
      return 'fatal';
    }
    if (evt.error === 'invalid_request') {
      return 'fatal';   // bug or stale config; not a transient
    }
  }

  // Stderr regex for auth/billing failures NOT surfaced via api_retry (older CLI versions, etc.)
  if (/not (logged in|authenticated)|expired|please run.*claude auth/i.test(ctx.stderr)) return 'fatal';
  if (/credit balance|billing/i.test(ctx.stderr)) return 'fatal';

  // SIGTERMed (we initiated): retriable-immediate (lease loss → next poll handles)
  if (ctx.exitCode === null) return 'retriable-immediate';

  // Subprocess crashed without a clear signal: retriable with backoff
  return 'retriable-with-backoff';
}
```

The classifier composes with the retry-budget logic from #521. The adapter's poll loop tracks consecutive `retriable-with-backoff` failures; on the Nth (N=10), it escalates to `fatal` and `requestDetach`s.

### 5.9 Heartbeat cadence

`heartbeatMs: 30_000` per the SDK-class default in `docs/design/session-lifecycle-rebuild-v2.md` §4.3. Inherited from `SdkAttachment`'s descriptor convention — no override needed.

---

## 6. Wire-protocol implications

**Zero new signals/queries/updates on `claudeSessionWorkflow`.** The adapter uses the existing surface:

| Surface | Use |
|---|---|
| `claimAttachmentUpdate` | Inherited from `BaseAttachment.startV2Lifecycle` |
| `heartbeatSignal` | Inherited |
| `processingStartUpdate` / `processingEndUpdate` | Inherited from `SdkAttachment.deliver()` |
| `markDeliveredSignal` | Inherited from `SdkAttachment.deliver()` |
| `attachmentInfoQuery` | Inherited from `BaseAttachment` phase watcher |
| `pendingMessagesQuery` | Used by poll loop (§5) |
| `updateMetadataSignal` | **Used to stash Claude Code session UUID** — see §5.1 |
| `requestDetachSignal` / `adapterExitedSignal` | Inherited from `SdkAttachment.detachGracefully` |

The only wire-protocol-doc touchpoint is the `agentType: 'claude-code-headless'` extension. `docs/WIRE-PROTOCOL.md` doesn't enumerate `AgentType` values today — no doc change required there.

### 6.1 Strictly-additive metadata + host-profile extensions

Two adjacent additive surfaces; neither is a new signal/query/update — both ride existing wire shapes.

**(a) `SessionMetadata` extension**: add a typed `claudeCodeSessionId?: string` field alongside the existing `sessionId` (Copilot) field. Strictly additive; pre-existing workflow runs that don't have it just see `undefined`.

```ts
// src/types.ts — addition to SessionMetadata
interface SessionMetadata {
  // ... existing fields ...
  /** Copilot adapter session id */
  sessionId?: string;
  /** Claude Code headless adapter session id (UUID; written via updateMetadataSignal). */
  claudeCodeSessionId?: string;
}
```

**(b) Daemon `hostProfile` extension**: add `claudeAuthState: boolean` field to advertise whether the host has a logged-in `claude` CLI. Exchanged via the existing `hostProfileSignal` in the maestro layer (no new signal). Strictly additive; pre-existing daemons that don't advertise it default to `undefined`, which the cross-host pre-flight treats as "unknown — fall through to standard probe at recruit time".

```ts
// src/types.ts — addition to HostProfile
interface HostProfile {
  // ... existing fields (hostname, platform, availableAgentTypes, …) ...
  /** True when the host's `claude` CLI is installed AND logged in (probed at daemon boot). */
  claudeAuthState?: boolean;
}
```

Both fields are strictly read-and-write-extension on existing types — no schema migrations, no replay-incompatibility, no protobuf-side break.

---

## 7. Engineer-facing skeleton

```ts
// src/adapters/claude-code-headless/adapter.ts (skeleton, ~400 LoC actual)

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as crypto from 'crypto';
import { spawn, ChildProcess } from 'child_process';
import { Client, WorkflowHandle } from '@temporalio/client';
import type { Message, AdapterDescriptor, SessionMetadata } from '../../types';
import { SdkAttachment, type SdkDeliverResult } from '../sdk/base';
import { ENV, getConfig } from '../../config';
import { createTemporalConnection } from '../../connection';
import {
  pendingMessagesQuery,
  isDestroyedQuery,
  metadataQuery,
  updateMetadataSignal,
} from '../../workflows/signals';

export const claudeCodeHeadlessDescriptor: AdapterDescriptor = {
  adapterId: 'claude-code-headless',
  adapterClass: 'sdk',
  blocksOnLLMTurn: true,
  heartbeatMs: 30_000,
};

const log = (...args: unknown[]) => {
  const msg = `[agent-tempo:claude-code-headless] ${args.map((a) => typeof a === 'string' ? a : JSON.stringify(a)).join(' ')}\n`;
  fs.writeSync(2, msg);
};

const POLL_INTERVAL_MS = 2000;
const TURN_TIMEOUT_MS = 5 * 60 * 1000;
const SIGTERM_GRACE_MS = 5_000;

export class ClaudeCodeHeadlessAttachment extends SdkAttachment {
  readonly descriptor: AdapterDescriptor = claudeCodeHeadlessDescriptor;

  private childProcess: ChildProcess | null = null;
  private permissionMode: string;
  private dangerouslySkipPermissions: boolean;
  private claudeCodeSessionId: string | null = null;
  private playerName = '';

  constructor(opts: { permissionMode?: string; dangerouslySkipPermissions?: boolean } = {}) {
    super();
    this.permissionMode = opts.permissionMode ?? process.env[ENV.PERMISSION_MODE] ?? 'acceptEdits';
    this.dangerouslySkipPermissions = opts.dangerouslySkipPermissions ?? false;
  }

  protected onSuperseded(): void {
    const child = this.childProcess;
    this.childProcess = null;
    if (!child) return;
    log('lease revoked — SIGTERM claude subprocess');
    try { child.kill('SIGTERM'); } catch (err) { log('SIGTERM threw:', (err as Error)?.message ?? err); }
    setTimeout(() => {
      if (!child.killed && child.exitCode === null) {
        try { child.kill('SIGKILL'); } catch { /* already gone */ }
      }
    }, SIGTERM_GRACE_MS);
  }

  async run(): Promise<void> {
    const config = getConfig();
    // ── Reusable boilerplate from claude-api/adapter.ts ────────────────
    // Lines 168-216  (workflow-id + pinnedRunId discovery loop)
    // Lines 256-273  (terminal-cleanup hook)
    // Lines 279-287  (startV2Lifecycle + claim)
    // Lines 289-308  (PID file + signal handlers)
    // SKIP claude-api lines 246-254 (Anthropic SDK construction) — this adapter
    //      doesn't use the SDK. SKIP lines 218-244 (MCP bridge boot + system
    //      prompt build) — this adapter passes MCP via spawn arg per turn.

    // Hydrate session UUID from workflow metadata (if exists from prior turn);
    // generate fresh UUID and stash on metadata if not.
    const meta = await handle.query(metadataQuery) as SessionMetadata;
    if (meta.claudeCodeSessionId) {
      this.claudeCodeSessionId = meta.claudeCodeSessionId;
      log(`Resuming Claude Code session ${this.claudeCodeSessionId} from workflow metadata`);
    } else {
      this.claudeCodeSessionId = crypto.randomUUID();
      await handle.signal(updateMetadataSignal, { claudeCodeSessionId: this.claudeCodeSessionId });
      log(`Created new Claude Code session ${this.claudeCodeSessionId}; stashed on workflow metadata`);
    }

    await this.pollLoop(handle);
  }

  protected async invokeSdk(_prompt: string, _timeoutMs: number): Promise<SdkDeliverResult> {
    if (!this.pinnedHandle || !this.claudeCodeSessionId) throw new Error('invokeSdk called before run() init');
    const handle = this.pinnedHandle;
    const t0 = Date.now();

    // Read pending messages; concatenate as the prompt for this turn.
    // (Claude Code session JSONL stores its own conversation history; we just
    // pass the new user input. On `--resume`, the prior history is already
    // loaded server-side by claude.)
    const pending = await handle.query(pendingMessagesQuery) as Message[];
    const promptText = pending.map((m) => `[from ${m.from}]: ${m.text}`).join('\n\n');

    // Synthesize --mcp-config inline JSON.
    const mcpConfig = JSON.stringify({
      mcpServers: {
        'agent-tempo': {
          type: 'stdio',
          command: 'node',
          args: [path.resolve(__dirname, '..', '..', 'server.js')],
          env: {
            CLAUDE_TEMPO_ENSEMBLE: process.env[ENV.ENSEMBLE]!,
            CLAUDE_TEMPO_PLAYER_NAME: this.playerName,
            CLAUDE_TEMPO_TEMPORAL_ADDRESS: process.env[ENV.TEMPORAL_ADDRESS]!,
            CLAUDE_TEMPO_TEMPORAL_NAMESPACE: process.env[ENV.TEMPORAL_NAMESPACE]!,
          },
        },
      },
    });

    // Build argv. Strip ANTHROPIC_API_KEY etc. from child env (§3.6).
    const args = [
      '-p',
      '--output-format', 'stream-json',
      '--verbose',
      '--include-partial-messages',
      '--strict-mcp-config',
      '--mcp-config', mcpConfig,
      '--session-id', this.claudeCodeSessionId,
    ];
    // First turn doesn't need --resume; subsequent turns do.
    // (Detected by checking whether the JSONL file exists — see §5.1.)
    const sessionFile = path.join(os.homedir(), '.claude', 'projects', encodeCwd(process.cwd()), `${this.claudeCodeSessionId}.jsonl`);
    if (fs.existsSync(sessionFile)) {
      args.push('--resume', this.claudeCodeSessionId);
    }
    if (this.dangerouslySkipPermissions) {
      args.push('--dangerously-skip-permissions');
    } else {
      args.push('--permission-mode', this.permissionMode);
    }

    const childEnv = { ...process.env };
    delete childEnv.ANTHROPIC_API_KEY;
    delete childEnv.CLAUDE_CODE_OAUTH_TOKEN;
    for (const k of Object.keys(childEnv)) {
      if (k.startsWith('CLAUDE_TEMPO_')) delete childEnv[k];
    }

    log(`spawning claude ${args.slice(0, 4).join(' ')} … (session=${this.claudeCodeSessionId})`);
    this.childProcess = spawn('claude', args, { stdio: ['pipe', 'pipe', 'pipe'], env: childEnv });

    // Write the user prompt to stdin and close it. ⚠️ Windows stdin race risk:
    // synchronous write-and-end immediately after `spawn` can drop the first
    // chunk if `claude` hasn't opened stdin yet. Use a `setImmediate` to defer
    // the `end()` until after the event loop turn, OR cork+uncork. Verify at
    // impl time on Windows specifically — see §11.5 spike checklist.
    this.childProcess.stdin!.write(promptText);
    setImmediate(() => this.childProcess?.stdin?.end());

    let assembledText = '';
    let stopReason: string | null = null;
    let usage: Record<string, number> | null = null;
    let totalCostUsd: number | null = null;

    // Stream-json frame parser — line-buffered stdout reader.
    let lineBuffer = '';
    const onData = (chunk: Buffer) => {
      lineBuffer += chunk.toString('utf8');
      let nl: number;
      while ((nl = lineBuffer.indexOf('\n')) !== -1) {
        const line = lineBuffer.slice(0, nl).trim();
        lineBuffer = lineBuffer.slice(nl + 1);
        if (!line) continue;
        try {
          const frame = JSON.parse(line);
          ({ assembledText, stopReason, usage, totalCostUsd } =
            this.handleStreamJsonFrame(frame, { assembledText, stopReason, usage, totalCostUsd }));
        } catch (err) {
          log(`malformed stream-json frame skipped: ${(err as Error).message}`);
        }
      }
    };
    this.childProcess.stdout!.on('data', onData);

    const stderrChunks: string[] = [];
    this.childProcess.stderr!.on('data', (chunk) => stderrChunks.push(chunk.toString('utf8')));

    // Wait for subprocess exit. Use the `result` frame to detect successful turn end;
    // exit-without-result = failure (catch handles it).
    const exitCode = await new Promise<number>((resolve) => {
      this.childProcess!.on('exit', (code) => resolve(code ?? -1));
    });
    this.childProcess = null;

    if (exitCode !== 0 && stopReason === null) {
      const stderr = stderrChunks.join('').slice(0, 4000);  // cap to avoid log spam
      log(`claude subprocess exited ${exitCode} without result frame; stderr: ${stderr}`);
      throw new Error(`claude -p exited ${exitCode}: ${stderr.slice(0, 200)}`);
    }

    log(`turn-usage adapter=claude-code-headless model=${this.claudeCodeSessionId} input=${usage?.input_tokens ?? 0} output=${usage?.output_tokens ?? 0} cache_read=${usage?.cache_read_input_tokens ?? 0} cost_usd=${totalCostUsd ?? 0} elapsed_ms=${Date.now() - t0} player=${this.playerName} stop_reason=${stopReason ?? 'none'}`);

    return {
      sdkResult: { assistantText: assembledText, stopReason, usage, totalCostUsd },
      elapsedMs: Date.now() - t0,
    };
  }

  /** Process one stream-json frame; mutate-and-return turn-state accumulator. Pure-ish for testability. */
  private handleStreamJsonFrame(frame: any, state: any): typeof state {
    switch (frame.type) {
      case 'system':
        if (frame.subtype === 'init') {
          // Verify session_id matches; log MCP server registration; check plugin_errors.
          if (frame.plugin_errors?.length) log(`WARNING: plugin_errors: ${JSON.stringify(frame.plugin_errors)}`);
        } else if (frame.subtype === 'api_retry') {
          this.handleApiRetry(frame);
        }
        return state;
      case 'assistant':
        // Accumulate text content for stderr telemetry; the canonical assembled
        // text comes from the `result` frame at end-of-turn.
        return state;
      case 'user':
        // Tool result wrapped as user turn — observe for telemetry only.
        return state;
      case 'stream_event':
        // Token deltas + tool calls; ignore for v1 (we only need turn-level state).
        return state;
      case 'result':
        return {
          ...state,
          assembledText: frame.result ?? state.assembledText,
          stopReason: frame.stop_reason ?? state.stopReason,
          usage: frame.usage ?? state.usage,
          totalCostUsd: frame.total_cost_usd ?? state.totalCostUsd,
        };
      default:
        return state;
    }
  }

  private handleApiRetry(frame: any): void {
    const cat = frame.error;
    switch (cat) {
      case 'authentication_failed':
      case 'oauth_org_not_allowed':
      case 'billing_error':
        log(`FATAL api_retry category=${cat} attempt=${frame.attempt}/${frame.max_retries} status=${frame.error_status} — adapter will exit on subprocess termination`);
        // Don't try to interrupt; let claude give up naturally and our exit-code
        // path handle the failure surface.
        break;
      case 'rate_limit':
      case 'server_error':
      case 'unknown':
        log(`api_retry category=${cat} attempt=${frame.attempt}/${frame.max_retries} delay=${frame.retry_delay_ms}ms — letting CLI backoff handle`);
        break;
      case 'invalid_request':
        log(`api_retry category=invalid_request — likely a bug, attempt=${frame.attempt}/${frame.max_retries}: ${JSON.stringify(frame)}`);
        break;
      case 'max_output_tokens':
        log(`api_retry category=max_output_tokens — turn ended at max_tokens; treat as soft end-of-turn`);
        break;
    }
  }
}

function encodeCwd(cwd: string): string {
  // Claude Code's project-dir encoding scheme; mirror it exactly (verify at impl time
  // — likely path-with-slashes-replaced-by-hyphens or similar). See §11.1 fixture corpus.
  return cwd.replace(/[\/\\:]/g, '-');
}

if (require.main === module) {
  const opts: { permissionMode?: string; dangerouslySkipPermissions?: boolean } = {};
  const pmode = process.env[ENV.PERMISSION_MODE];
  if (pmode) opts.permissionMode = pmode;
  if (process.env.CLAUDE_TEMPO_DANGEROUSLY_SKIP_PERMISSIONS === '1') opts.dangerouslySkipPermissions = true;
  new ClaudeCodeHeadlessAttachment(opts).run().catch((err) => {
    log('Fatal error:', err);
    process.exit(1);
  });
}
```

---

## 8. Test strategy

### 8.1 Unit (Vitest, `tests/`)

- `tests/adapters/claude-code-headless.test.ts`:
  - **Frame parser** — exercise `handleStreamJsonFrame` with synthesized fixtures (one per scenario per §11.1). Assert `result` frame populates `assembledText` / `stopReason` / `usage` / `totalCostUsd`; `system/init` parses without throwing; `system/api_retry` triggers correct category dispatch.
  - **Argv synthesis** — verify spawn args include `--strict-mcp-config`, `--mcp-config`, `--session-id`, `--resume` only on second turn, permission-mode flag, no `--bare`.
  - **Env hygiene** — verify `ANTHROPIC_API_KEY` and `CLAUDE_CODE_OAUTH_TOKEN` are stripped from child env.
  - **Session UUID stash** — first turn generates UUID + signals `updateMetadata`; second turn reads from metadata.
  - **Abort path** — `onSuperseded` SIGTERMs the child; SIGKILL after 5s grace.
  - **Subprocess crash** — exit code != 0 without `result` frame surfaces as turn failure (no `markDelivered`).
- `tests/tools/recruit.test.ts` — extend with `agent: 'claude-code-headless'` cases:
  - Pre-flight rejects when `claude` binary not on PATH (mock `spawn`)
  - Pre-flight rejects when `claude auth status` exits != 0
  - `permissionMode` flows through to outbox entry
  - `dangerouslySkipPermissions: true` and `permissionMode` are mutually exclusive

### 8.1.1 Golden-file test for `encodeCwd()`

Critical safety net — wrong cwd-encoding silently breaks session continuity (no error signal, just falls through to a fresh session JSONL). The test:

1. Pick a known cwd (e.g. test fixture `/tmp/agent-tempo-encodecwd-test`).
2. Spawn a real `claude -p` from that cwd with a synthesized `--session-id` and a no-op prompt.
3. After exit, `glob` `~/.claude/projects/*/<uuid>.jsonl` and discover the actual encoded directory name.
4. Assert `encodeCwd('/tmp/agent-tempo-encodecwd-test')` produces exactly that string.
5. Capture the result as a fixture in `tests/adapters/fixtures/claude-code-headless/cwd-encoding.json`; CI runs it as a normal unit test against the fixture without spawning `claude`.

This test runs as part of the impl-time spike (§11) and again periodically (manual, not CI — gated on `claude` being installed). If the encoding scheme ever changes in a Claude Code minor bump, this test catches it before users hit silent session-fork bugs.

### 8.2 Workflow integration (Mocha, `test/`)

- `test/adapter-sdk-lifecycle-v2.test.ts` (existing) — already validates SDK-class lifecycle. **Parameterize over the new descriptor** if not already (claude-api should already have done this for #131); otherwise extract shared helper.
- `test/adapter-claude-code-headless-lifecycle.test.ts` (**NEW**, naming follows `adapter-{id}-lifecycle-v2.test.ts` convention):
  - Full spawn → claim → turn (with mocked `claude` subprocess via `child_process` stub) → tool dispatch round-trip → detach
  - Verifies `processingStart`/`End` pairing fires correctly per turn
  - Verifies session-UUID stash via `updateMetadataSignal` round-trips through workflow query
  - Verifies SIGTERM propagates on superseded
  - Verifies child `env` lacks `ANTHROPIC_API_KEY` (regression on §3.6)

### 8.3 Wire-protocol drift detector

`SessionMetadata` extension (`claudeCodeSessionId` field) is additive — drift detector validates the field is referenced via `metadataQuery` + `updateMetadataSignal`. No new wire surface.

### 8.4 Manual smoke (acceptance-criteria check)

Per the issue's acceptance criteria, the hand-test:

1. Recruit a `claude-code-headless` player on a host with a logged-in `claude` CLI: `agent-tempo recruit foo --agent claude-code-headless`
2. Cue it: from another player or via `agent-tempo cue foo "hello, what's your subscription billing state?"`
3. Verify the player responds via `cue` or `report`
4. **Verify billing source** — check `console.anthropic.com/usage` for the test ensemble; should show `$0.00` Console burn (the test billed against the subscription pool, not Console)
5. `restart` the player; verify next cue resumes the same Claude Code session (check `~/.claude/projects/<encoded-cwd>/` for the JSONL file with the stashed UUID)
6. **Force superseded** by recruiting a second player with the same name; verify abort fires and ghost reply doesn't land
7. **Force auth failure** by setting `ANTHROPIC_API_KEY=invalid` in the daemon env (which the adapter strips, but check the warning) AND running `claude auth logout` first; verify pre-flight reject

---

## 9. Phase 2 forward-work hooks (deliberately out of scope)

| Phase 2 candidate | Rationale for v1 deferral |
|---|---|
| **Long-lived `claude` subprocess via `--input-format stream-json`** | Stream-json input format is undocumented (Anthropic issue #24594); needs schema stabilization before we can build on it. v1's per-turn pattern is sufficient. |
| **Cross-machine `migrate`** | Claude Code session JSONL is local to host's `~/.claude/projects/<cwd>/`. Migrating across hosts requires session export/import or a remote session store; both non-trivial. Document the constraint in v1; revisit when there's pull. |
| **Custom system prompt overrides** | `claude -p`'s default system prompt + the host's CLAUDE.md auto-discovery is the right default for the headless mirror of `claude-code`. Operators wanting full control can use `claude-api`. v2 candidate: `--append-system-prompt` recruit-arg for additive overlay. |
| **`--max-budget-usd` integration** | Claude Code's built-in cost cap is a well-defined hook. v2 candidate: `recruit({ maxBudgetUsd: N })` flows to `--max-budget-usd N`. |
| **`--allowedTools` / `--disallowedTools` recruit-args** | v1's permission-mode default is sufficient for typical recruit. Phase 2 candidate when operator feedback shows they want finer control (e.g., a "read-only inspector" recruit that can't write). |
| **Plugin / skill loading** | v1 uses `--strict-mcp-config` so user MCP servers don't load — but plugin / skill auto-discovery still happens. Phase 2 may add `--bare` mode for fully reproducible CI runs (caveat: `--bare` skips OAuth; we'd have to feed `apiKeyHelper` via `--settings`, which means CI runs would NOT use subscription billing — a feature regression for many use cases). |
| **Per-turn `--include-partial-messages` token streaming** | v1 turn-level telemetry is sufficient. Token-level streaming events (via `stream_event` frames) would let us surface live progress to a TUI / dashboard; defer until that consumer lands. |
| **JSON Schema structured-output recruit-arg** | `claude -p --json-schema` lets the model produce schema-validated JSON. Not on Phase 1's path. Phase 2 candidate for evaluator / gate-checker recruits. |
| **Reconnect opt-in for SDK adapters** | Per `src/adapters/README.md` guidance: SDK adapters generally don't reconnect. Revisit if operator feedback shows real friction with the current restart-on-lease-loss path. |

---

## 10. System prompt scaffolding

The `claude-code-headless` adapter does NOT inject a custom system prompt in v1. The reasoning:

- `claude -p` reads the host's `CLAUDE.md` (project + user) by default; this is exactly the context a `claude-code` interactive player would have.
- `claude -p` registers the agent-tempo MCP server as `mcp__agent-tempo__*` tools; the LLM sees the tool descriptions (which include role/responsibility cues set by `src/server-tools.ts`).
- The tempo MCP server's `instructions` field carries the player-identity addendum (ensemble name, player name, available tools) per the existing pattern; this addendum is delivered as MCP server instructions, which Claude Code surfaces in its prompt automatically.

**No `--append-system-prompt` in v1.** Phase 2 candidate if operator feedback shows the existing addendum isn't surfacing strongly enough through MCP-instructions-only delivery.

The headless-identity addendum that `claude-api` adds (§10 of #131) is unnecessary here because `claude-code-headless` players DO have file-edit / shell / web tools — there's no capability gap to disclose.

---

## 11. Implementation prerequisites

### 11.1 Frame parser fixture corpus (engineer captures during impl-time spike)

Before writing the parser, capture real `claude -p` output for these scenarios into `tests/adapters/fixtures/claude-code-headless/`:

| Fixture | Capture command (run on a test ensemble) |
|---|---|
| `success-simple.jsonl` | `claude -p --output-format stream-json --verbose --include-partial-messages "echo hello"` (no MCP, no tool use) |
| `tool-use-bash.jsonl` | `claude -p --output-format stream-json --verbose "list files in cwd" --allowedTools Bash` |
| `tool-use-mcp.jsonl` | `claude -p --output-format stream-json --verbose --strict-mcp-config --mcp-config <agent-tempo-config> "use the cue tool to send a test message"` |
| `api-retry-rate-limit.jsonl` | Synthesized — write a frame matching the documented `system/api_retry` schema with `error: 'rate_limit'` |
| `api-retry-billing.jsonl` | Synthesized — `error: 'billing_error'` |
| `auth-failed.jsonl` | Capture from a session where `claude auth logout` was run first, then `claude -p ...` |
| `result-with-cost.jsonl` | Any successful turn — verify `total_cost_usd` is present in `result` frame |

Captures become offline test inputs; no live `claude` calls in CI.

### 11.2 cwd-encoding scheme

`encodeCwd()` in §7's skeleton is a stub. Engineer verifies the actual scheme by inspecting `~/.claude/projects/` after running a `claude` CLI session in a known cwd. As of mid-2026, the scheme is path-with-slashes-replaced-by-hyphens (e.g., `/Users/foo/repos/agent-tempo` → `-Users-foo-repos-agent-tempo`), but verify and pin via tests.

### 11.3 Pre-flight `claude auth status` parser

Engineer captures `claude auth status` output for: logged-in (subscription), logged-in (long-lived OAuth via `setup-token`), logged-out, OAuth org denied. Each becomes a parser fixture; the pre-flight returns a structured result (`{ ok: boolean, mode?: 'subscription' | 'oauth-token', error?: string }`) that `recruit` surfaces actionably.

### 11.4 `max_output_tokens` emission path

Per §5.4 spike-check note: docs list `max_output_tokens` as a `system/api_retry` `error` category, but it's also a documented `result` frame `stop_reason`. Engineer captures one fixture forcing `max_output_tokens` (e.g. `claude -p --output-format stream-json --max-tokens 50 "write a 10000-word essay"`) and observes which path the CLI emits. Outcomes:

- **Emitted as `system/api_retry`**: keep the §5.4 row; classifier returns `fatal` (no point retrying — same prompt will hit the same limit).
- **Emitted only as `result.stop_reason`**: drop the §5.4 row; the success-path handler already covers it (assistant text returns truncated; operator handles in next turn).
- **Both**: keep the row but document the duplicate signal.

### 11.5 Windows stdin race verification

Per §7 skeleton inline comment: synchronous `child.stdin.write(prompt); child.stdin.end()` can drop the first chunk on Windows if `claude` hasn't opened stdin yet. Engineer verifies on Windows specifically (the lead Linux/macOS test environment doesn't surface this). Three potential mitigations to spike (in order of preference):

1. **`setImmediate(() => child.stdin.end())`** — defer end() to next event-loop turn. Cheapest fix; matches the skeleton.
2. **Wait for `child.stdin` `'open'` or first `'drain'` event** before writing. More robust but more code.
3. **`--input-text <prompt>` flag** if Claude Code adds it (current CLI doesn't). Eliminates stdin entirely. Track in Phase 2.

If (1) is unreliable on Windows, fall back to (2). Capture the chosen pattern in `src/adapters/claude-code-headless/stdin-helper.ts` for clarity.

### 11.6 Ensemble-identity surfacing (system-prompt fallback path)

Per architect's Q2 review: §10 relies on Claude Code surfacing the agent-tempo MCP server's `instructions` field strongly enough that the LLM internalizes ensemble identity (player name, conductor presence, fellow players). claude-api and opencode added explicit `HEADLESS_*_ADDENDUM` strings precisely because operators couldn't trust the MCP-instructions-only path. **This v1 design assumes Claude Code's MCP instructions surfacing is sufficient — engineer must verify.**

**Spike check**:
1. Recruit a `claude-code-headless` player with the design's default (no `--append-system-prompt`).
2. Cue it: *"What ensemble are you in? Who's the conductor? List the other players."*
3. If the player answers correctly (knows ensemble name, conductor, can use `ensemble` MCP tool to list peers): the design is correct as-written.
4. If the player is unsure or doesn't know: add `--append-system-prompt` with a `HEADLESS_CCH_ADDENDUM` constant (mirror claude-api's §10) before merging.

Cheap to verify, cheap to add later. The fallback addendum text already exists in the codebase (`buildServerInstructions` in `src/server-tools.ts`); this only adds an `--append-system-prompt <built-string>` argv entry — no new content authoring required.

---

## 12. Sequencing

### 12.1 Independence

- **#318 coat-check** — orthogonal; either can ship first.
- **#319 protobuf migration** — additive on JSON wire; the new `agentType: 'claude-code-headless'` value goes through the same wire transition as everything else.
- **#334 saveable-state (merged)** — composes naturally; `save_state` works for `claude-code-headless` players via the standard MCP tool surface.
- **#449 opencode (merged)** — sister adapter. Shares the MCP-native architecture; design copy can mirror `opencode/config.ts` patterns where relevant.
- **#131 claude-api (merged)** — sibling SDK-class adapter. Shares the `SdkAttachment` lifecycle scaffold; design lineage extends #131.
- **#94/#95 SSE event source** — adapter doesn't observe SSE in v1.

### 12.2 Recommended drop point

Single PR, ~600–850 LoC. Estimated 2-3 days for engineer pickup (smaller than #131's ~1,000 LoC; comparable to #449's ~900 LoC minus the HTTP/SSE layer).

Fits in any quiet engineering slot. Recommended sequencing: drop after #520 design ratification by tempo-architect, before any adapter-layer-touching PRs that might collide.

### 12.3 Phase 2 prerequisites

When long-lived subprocess via `--input-format stream-json` lands in Phase 2, the v1 design must NOT need refactoring — the per-turn pattern is the simpler subset; switching to long-lived only adds state, doesn't restructure.

When cross-machine `migrate` lands in Phase 2, the v1 design must NOT pre-empt the choice of session-export-import vs remote-session-store — both are clean extensions of the v1 metadata-stash pattern.

---

## 13. Decision log — answers to the 5 open questions

| Q | Decision | Rationale |
|---|---|---|
| Q1: Persistence model | **Per-turn `claude -p`** with `--session-id` + `--resume` for continuity | Long-lived path depends on undocumented `--input-format stream-json` schema; per-turn pays only ~1-2s startup cost vs simpler control flow |
| Q2: Session continuity | **Stash UUID on workflow metadata via `updateMetadataSignal`**; resume via `--session-id`. **Cross-machine migrate not in v1.** | Matches Copilot/OpenCode pattern; cross-machine constraint is a JSONL-locality property of Claude Code itself |
| Q3: Tool surface | **Full inheritance + agent-tempo MCP overlay via `--strict-mcp-config`**. **Permission mode `acceptEdits` default**, `--dangerously-skip-permissions` opt-in. | Strictly more capable than `claude-api`; default permission mode matches operator expectation that recruited players can do their job |
| Q4: Stream-json error mapping | **Map `system/api_retry` categories** → exit-with-actionable-error for `auth/billing/oauth_org_not_allowed`; let CLI's backoff handle `rate_limit/server_error/unknown` | Leverages Anthropic's documented error-category enum; operator-actionable failure surface |
| Q5: Pre-flight contract | **`claude auth status`** (no billed call) + `claude --version` (binary probe), both timeout-bounded; `force: true` bypasses | Official supported subcommand; clean op ergonomics; no billed test message |
| **Cross-adapter retry consistency (#521)** | **Defer to #521's `fatal | retriable-with-backoff | retriable-immediate` classifier**; share the module at `src/adapters/sdk/api-error-classifier.ts` between claude-api and claude-code-headless. See §5.5 + §5.8. | Single source of truth for error classification; pickup-by-both-adapters when new error categories emerge; subprocess-specific signal translation lives in this adapter's error-mapper |

---

## 14. Risks / unknowns

1. **`claude` policy drift** — Anthropic could announce restrictions on third-party tools spawning the binary (similar to the OAuth-token policy). Mitigation: monitor Anthropic's policy page; the adapter only spawns the binary as a transparent intermediary, which is functionally identical to the operator running `claude` themselves. Risk graded LOW.
2. **Stream-json schema churn** — frame schema isn't versioned in the docs. Mitigation: capture fixtures (§11.1); adapter tolerates unknown frame `type`s by ignoring; CI smoke test re-validates against the live CLI. Risk graded MEDIUM.
3. **`--strict-mcp-config` semantics** — verify at impl time that strict mode disables BOTH `.mcp.json` lookup AND `~/.claude` lookup (docs say "Only use MCP servers from `--mcp-config`" — verify literally). Risk graded LOW.
4. **JSONL session-file path stability** — `~/.claude/projects/<encoded-cwd>/<uuid>.jsonl` could change in a Claude Code minor bump. Mitigation: pin a tested-version range in CLAUDE.md; engineer verifies the path scheme via a one-off impl-time experiment (§11.2). Risk graded LOW.
5. **MCP server subprocess startup cost** — every `claude -p` spawn means a fresh `node dist/server.js` MCP child. ~200ms overhead per turn on a warm system. Acceptable for v1; long-lived pattern (Phase 2) eliminates this. Risk graded LOW.
6. **Permission-mode UX** — `acceptEdits` may surprise operators who expect locked-down behavior; `bypassPermissions` may surprise operators who expect approve-each-tool. Mitigation: clear recruit-tool description; document in CLAUDE.md "Key concepts" section. Risk graded LOW.
7. **Argv length on Windows** — synthesized `--mcp-config` JSON is ~400 bytes; well below Windows' 32KB ARG_MAX. Verified informally; spike at impl time if any concern. Risk graded VERY LOW.

---

## 15. References

- **Issue #520** — this PR's input
- **Researcher's spike** (2026-05-02) — confirmed OpenClaw uses subprocess pattern; Anthropic OAuth policy forbids third-party token use
- **Lineage**:
  - [`docs/design/131-claude-api-adapter.md`](131-claude-api-adapter.md) — the SDK-class adapter shape (this design extends)
  - [`docs/design/449-opencode-adapter.md`](449-opencode-adapter.md) — the MCP-native subprocess pattern (this design mirrors)
  - [`docs/design/session-lifecycle-rebuild-v2.md`](session-lifecycle-rebuild-v2.md) §4 (adapter extensibility), §4.3 (lifecycle guarantees), §9.3 (ghost-reply window)
- **Adapter precedents**:
  - [`src/adapters/sdk/base.ts`](../../src/adapters/sdk/base.ts) — `SdkAttachment` lifecycle contract
  - [`src/adapters/claude-api/adapter.ts`](../../src/adapters/claude-api/adapter.ts) — closest SDK-class precedent
  - [`src/adapters/opencode/adapter.ts`](../../src/adapters/opencode/adapter.ts) — closest subprocess-spawn precedent
  - [`src/adapters/claude-code/adapter.ts`](../../src/adapters/claude-code/adapter.ts) — sibling adapter (interactive class, same provider)
- **External**:
  - [Claude Code headless docs](https://code.claude.com/docs/en/headless) — `claude -p` spec, `system/api_retry` schema, `system/init` schema
  - [Claude Code authentication](https://code.claude.com/docs/en/authentication) — OAuth policy, env-var precedence
  - [Anthropic issue #24594](https://github.com/anthropics/claude-code/issues/24594) — `--input-format stream-json` documentation gap
  - [OpenClaw provider docs](https://docs.openclaw.ai/providers/anthropic) — external reference for the subprocess-spawn pattern
- **MCP**:
  - `claude --help` — `--mcp-config`, `--strict-mcp-config`, `--allowedTools`, `--permission-mode` flag specs
  - [Claude Code MCP docs](https://code.claude.com/docs/en/mcp) — stdio MCP server schema

---

## 16. Spike findings (impl-time corrections to §5.x and §6.1)

> **Status**: Append-only record of what was actually observed against
> `claude --version` 2.1.126 during the §11 pre-impl spike (2026-05-02)
> and confirmed during PR-3 implementation. **Does NOT rewrite §5.x or
> §6.1** — the original sections are preserved as the design record;
> this section documents the wild-vs-design deltas and the resolutions
> ratified by the architect during PR-1 → PR-3.
>
> Future readers: §5.x and §6.1 reflect the design intent; §16 reflects
> the implemented reality.

### 16.1 `result` frame `subtype` field — Delta #1 (minor)

**§5.3 said** `result` is a top-level type. **Reality**: every `result`
frame carries a `subtype: 'success' | 'error'` and a richer envelope
than documented. Concretely:

```json
{"type":"result","subtype":"success","is_error":false,"api_error_status":null,
 "duration_ms":2191,"num_turns":1,"result":"PINEAPPLE","stop_reason":"end_turn",
 "session_id":"...","total_cost_usd":0.088202,"usage":{...},
 "modelUsage":{"claude-opus-4-7[1m]":{...}},"permission_denials":[],
 "terminal_reason":"completed","fast_mode_state":"off"}
```

Bonus fields the adapter now consumes:

- **`is_error: boolean`** — clean fatal-vs-success boolean.
- **`api_error_status: number | null`** — HTTP status when API errored.
  **Architect-ratified preferred classifier input** — see §16.4.
- `permission_denials: []` — denied tool calls (telemetry).
- `terminal_reason: 'completed' | 'aborted' | …` — orthogonal to `stop_reason`.
- `total_cost_usd` — **present even on subscription billing** (reflects
  equivalent API cost, not actual subscription burn). Logged in
  `turn-usage` lines so operators see cost regardless of billing path.
- `modelUsage` keyed by model — multi-model turn accounting.

**Resolution**: stream-json parser (`src/adapters/claude-code-headless/stream-json.ts`)
treats `result.subtype` as future-proofed; PR-3 dispatches on
`result.is_error` + `result.api_error_status` directly via
`error-mapper.ts`'s preferred path.

### 16.2 `system/hook_*` and `system/status` frames — Delta #2 (filtering)

**§5.3 didn't enumerate** `system/hook_started`, `system/hook_response`,
`system/status`. **Reality**: these emit unconditionally whenever the host
has Claude Code hooks configured (most operators do — SessionStart hooks
for project context, language-server hooks, etc). The `output`/`stdout`
fields can carry arbitrary user content (saw a 107KB SessionStart hook
body in real captures).

**Resolution**: parser explicitly enumerates these subtypes as IGNORED in
the dispatch switch, with a comment so future readers don't think the
pass-through is accidental. Documented in `hook-frames.jsonl` synthetic
fixture so unit tests assert the ignore behavior.

### 16.3 `rate_limit_event` is a top-level type — Delta #3 (classifier shape)

**§5.4 / §5.5 / §5.8 assumed** `system/api_retry` is the carrier for
rate-limit / billing / auth signals. **Reality**: `rate_limit_event` is
a top-level frame type (NOT a `system/*` subtype), AND it carries TWO
overloaded signal modes on the same wire shape, distinguished by
`rate_limit_info.status`:

```json
{"type":"rate_limit_event",
 "rate_limit_info":{"status":"allowed","resetsAt":1777782000,
                    "rateLimitType":"five_hour","overageStatus":"allowed",
                    "overageResetsAt":1777769400,"isUsingOverage":false},
 "session_id":"...","uuid":"..."}
```

Critically, `status: 'allowed'` events fire **on every successful turn**
as informational telemetry; only `status: 'blocked'` events represent
action-required signals. Naively treating every `rate_limit_event` as a
classifier input would overflow the N=10 retry budget on turn 1.

**Architect ratification** (issue #520 spike-comment thread) — handle
both channels with a 5-rule precedence table (most-fatal-wins, single
increment per failure):

| Rule | Signal | Category |
|---|---|---|
| 1 | subprocess+stderr-regex (auth/billing patterns) | `fatal` |
| 2 | `system/api_retry` with `error: 'authentication_failed' \| 'oauth_org_not_allowed' \| 'billing_error' \| 'invalid_request' \| 'max_output_tokens'` | `fatal` |
| 3 | `rate_limit_event` with `status: 'blocked'` AND `overageStatus: 'blocked'` | `fatal` |
| 4 | `system/api_retry` with `error: 'rate_limit' \| 'server_error' \| 'unknown'` | `retriable-with-backoff` |
| 5 | `rate_limit_event` with `status: 'blocked'` AND `overageStatus: 'allowed'` | `retriable-with-backoff` |

Plus three pinned constraints:
- `rate_limit_event` with `status: 'allowed'` is **NEVER** a classifier
  input (informational telemetry only)
- Auth/billing/oauth-org/invalid-request stay on `system/api_retry` +
  stderr regex — `rate_limit_event` doesn't carry these categories
- Multi-channel de-dupe: each subprocess failure increments the retry
  budget exactly ONCE

### 16.4 Architect-ratified preferred classifier path — `result.is_error` + `api_error_status`

Independently surfaced from Delta #1: when the `result` frame arrives
with `is_error: true` AND a non-null `api_error_status`, dispatch
directly on the HTTP code (reuse claude-api's mapping shape):

| HTTP status | Category |
|---|---|
| 401, 403 | `fatal` (auth) |
| 400, 404, 422, … (other 4xx) | `fatal` |
| 5xx, 529 | `retriable-with-backoff` |

**Architect comment**: *"this is actually CLEANER than relying on either
rate_limit_event or system/api_retry, and the design didn't anticipate
it."* The result-frame path bypasses both streaming channels entirely
for fatal-vs-transient classification.

### 16.5 `sessionId` field — `claudeCodeSessionId` retracted (was §6.1)

**§6.1 proposed** adding a typed `claudeCodeSessionId?: string` field to
`SessionMetadata` "alongside the existing `sessionId` (Copilot) field."
**Reality** (`src/types.ts:215` JSDoc): `sessionId` was already typed
for shared use across Copilot AND interactive Claude Code:

> *"Session UUID — used for Copilot SDK sessionId and Claude Code
> --resume/--session-id."*

The design's premise that `sessionId` was "Copilot-only" was working
from a stale assumption — the field was already typed for shared use
before this design doc was written.

**Architect ratification — Option (a) — REUSE `sessionId`**:
- Zero new wire surface (no `WIRE-PROTOCOL.md` change to the
  `updateMetadata` payload)
- Free interactive↔headless continuity if a player ever migrates
  within the same cwd (Claude Code's session JSONL is per-cwd, not
  per-adapter)
- Avoids two-UUIDs-per-session forking pathologies

**§6.1's proposed `claudeCodeSessionId` field is RETRACTED.** The
canonical name is `sessionId` and it was already typed for shared use
per `types.ts` JSDoc. PR-2 refreshed the JSDoc to reflect three usage
paths (Copilot SDK + Claude Code interactive + Claude Code headless)
plus an opaque-UUID warning.

**Constraint for adapter-side consumers**: `sessionId` MUST be treated
as opaque UUID string; different adapters write different shapes
through this field (Copilot SDK ids, Claude Code UUIDv4, OpenCode
server-session ids, even `mock-<pid>` placeholders in dev mode), and
that's by design.

### 16.6 Recruit-tool Zod mutex — `refine`/`superRefine` not callable

**§3.1 implied** the recruit tool's Zod schema would enforce the
`permissionMode` ↔ `dangerouslySkipPermissions` mutex via `refine` /
`superRefine`. **Reality**: `defineTool()` (in `src/tools/helpers.ts`)
takes `paramsSchema` as `Record<string, ZodTypeAny>` — NOT a
`ZodObject` — so `refine` / `superRefine` aren't callable on it.

**Resolution**: PR-1 enforces the mutex in the handler body via a
runtime guard:

```ts
if (permissionMode != null && dangerouslySkipPermissions) {
  return fail(`permissionMode and dangerouslySkipPermissions are mutually exclusive — pass at most one.`);
}
```

This matches the existing `model` agent-guard pattern elsewhere in
`recruit.ts` (e.g., `if (model != null && agent !== 'claude-api' && agent !== 'opencode')`).

### 16.7 PR-2 closure-vs-method bug surfaced by QA

PR-2 wrote `pollLoop` with a comment claiming `invokeSdk` *"reads
`messages` directly via closure"* — but `invokeSdk` is a class method,
not a closure-captured variable. QA flagged this; PR-3 fixed by
adopting opencode's pattern: closure-wrap the `deliver` callback so
`messages` flows through the closure-captured argument explicitly:

```ts
await this.deliver(
  handle, messages[0], '', TURN_TIMEOUT_MS,
  (timeoutPrompt, timeoutMs) => this.invokeSdkWithBatch(messages, timeoutPrompt, timeoutMs),
  ackIds,
);
```

`invokeSdk` (the original method name) was renamed to
`invokeSdkWithBatch` and gained a leading `messages: Message[]`
parameter. The original `invokeSdk` signature on `SdkAttachment` is
unchanged — the wrapper closure satisfies the base class contract.

### 16.8 Argv-prompt simplification — no stdin race

§11.5 spike check found that for per-turn invocation (Phase 1 locked),
the prompt can be passed as the trailing positional argv argument
rather than written to stdin. This eliminates the design §7's "Windows
stdin race" concern entirely for typical prompts. The adapter passes
the multi-cue batch as a single concatenated argv string; only when
the prompt would exceed Windows ARG_MAX (32KB) would the adapter need
to fall back to a stdin pipe (deferred — none observed in real-world
multi-cue batches so far).

### 16.9 `claude -p --session-id X --resume X` mutually exclusive — Delta #4 (PR-4 smoke)

Surfaced during PR-4's manual §8.4 smoke test (issue #520). PR-3's argv
synthesis sent BOTH `--session-id <uuid>` AND `--resume <uuid>` on resume
turns, following design §5.1's literal recommendation. **Reality**:
`claude -p` v2.1.126 rejects the combo with:

> Error: --session-id can only be used with --continue or --resume if --fork-session is also specified.

The design's premise ("explicit `--session-id` for deterministic resume,
matched on the JSONL filename") was correct, but the CLI enforces a
mutex that the design didn't anticipate.

**Resolution**: when `isResume === true`, drop `--session-id` and pass
`--resume <uuid>` alone. The `--resume` argument identifies the session
via the JSONL filename embed (the per-cwd `~/.claude/projects/<encoded>/<uuid>.jsonl`
file is named after the same UUID that was set with `--session-id` on
the first turn). First-turn argv stays as `--session-id <uuid>` (no
`--resume`) to PIN the deterministic UUID; subsequent turns use
`--resume <uuid>` only.

**Smoke evidence** (PR-4 §8.4 manual run):
- First turn: `cache_create=33865 cost_usd=0.21` (fresh session, full context load)
- Second turn (after restart, `--resume <same-uuid>`): `cache_read=33865 cost_usd=0.028` (cache hits prove session continuity)
- The `cache_read` exactly matching the prior `cache_create` is the
  authoritative proof that the resumed session loaded the same context
  — `--resume <uuid>` works correctly with the JSONL-filename embed.

**Bonus finding**: PR-3's classifier returns `retriable-with-backoff`
on this kind of CLI-rejection failure, but the adapter currently has no
actual backoff logic — the poll loop spins as fast as the workflow
delivers PENDING messages, spawning a new `claude -p` (and on Windows,
a new `cmd.exe /c claude` shim) per attempt. During the smoke this
manifested as ~20 cmd-shim windows briefly flashing on screen before
the operator killed them. The flash is cosmetic on POSIX (no shim
window) but disruptive on Windows. Real backoff is deferred to #521's
shared classifier work; the immediate fix in this PR removes the
underlying retry trigger by sending the correct argv.
