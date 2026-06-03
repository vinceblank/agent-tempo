# Design: agent-tempo × Pi native integration

> **Status:** Draft / Proposal · **Author:** vinceblank (with Claude) · **Created:** 2026-06-03
> **Spike:** GREEN (see [Feasibility](#feasibility-summary)) · **Tracking issue:** _TBD_

## TL;DR

Integrate agent-tempo with [Pi](https://github.com/badlogic/pi-mono) — an open-source,
TypeScript, extensible terminal coding agent — as a **native Pi extension package**, so that
a Pi session can be a first-class agent-tempo player **without the MCP server, without the
"dev channels" injection hacks, and without the adapter heartbeat-inference machinery**.

This is **additive, not a fork or a rewrite**. The Temporal coordination core
(workflows/activities/client/daemon) is reused unchanged. The existing adapters keep working.
Pi becomes a new, cleaner runtime alongside them, and two of the existing headless adapters
(`claude-api`, `opencode`) become candidates for eventual deprecation because Pi subsumes them.

A source-level spike (Pi `badlogic/pi-mono` @ `564ad70`, packages `0.78.0`) confirmed every
required primitive exists on Pi's supported `ExtensionAPI` — including the make-or-break case
of injecting a cue into a **live, human-attached interactive session**.

---

## Motivation

agent-tempo's hardest, most bug-prone machinery exists only because **Claude Code is a black
box driven from outside**:

- **MCP stdio bridge** — every session spawns `dist/server.js` as an MCP child; a handshake,
  a process, a permission round-trip per tool call.
- **"Dev channels" injection** — delivering a cue into a live Claude Code TUI requires
  terminal automation that has caused recruit-message loss (#18) and the
  `/clear`-fires-no-session-hook problem (first cue must be fully self-contained).
- **Heartbeat / phase-watcher inference** (#249) — because Claude Code emits no lifecycle
  events, the adapter *infers* the attachment phase from heartbeat ticks, with all the
  silent-guard-trip and staleness-warning complexity that entails.
  Note: Pi's lifecycle events cover *graceful* transitions only. Abrupt death (crash / SIGKILL / laptop-sleep) emits **no** event, so a liveness signal (heartbeat or equivalent) is still required workflow-side — the phase *inference* dissolves, the liveness *primitive* does not (MD-A).

None of these are inherent to multi-agent coordination — they're artifacts of the substrate.
Pi removes the premise: it's the **same language** as agent-tempo (TS/Node), it's
**extensible by design**, and it exposes **real lifecycle events** and **programmatic message
injection**. The Temporal client can live in the same process as the agent loop, and tools
register natively instead of over MCP.

The goal: *streamline as much as possible — build the coordination directly into Pi — while
keeping the durable Temporal core that is agent-tempo's actual value.*

---

## What Pi is

- Open-source TS terminal coding agent (Mario Zechner / `badlogic`, Armin Ronacher).
- Minimal core: 4 tools (Read/Write/Edit/Bash), ~300-word prompt. **Ships no MCP** — extends
  instead via TypeScript Extensions, Skills, Prompt Templates, Themes.
- Provider-agnostic / BYO-key: 15+ providers via `pi-ai` (Anthropic, OpenAI, Gemini, Bedrock,
  …), plus OAuth into Claude Pro/Max, ChatGPT Plus/Pro, GitHub Copilot subscriptions.
- Monorepo `badlogic/pi-mono`; published packages: `@earendil-works/pi-coding-agent` (CLI),
  `pi-agent-core` (agent loop), `pi-ai` (LLM), `pi-tui` (terminal UI).

> The npm listing `@mariozechner/pi-coding-agent` is an alias; the canonical published name is
> `@earendil-works/pi-coding-agent`.

---

## Feasibility summary

**Verdict: GREEN — a Pi package/extension, no fork required.** Every primitive agent-tempo
needs is on Pi's supported surface; no monkey-patching, no private internals. The pivotal
unknown — pushing a cue into a *running interactive* session — is natively supported and
demonstrated by a shipped Pi example.

Confirmed against `badlogic/pi-mono` @ commit `564ad70fb84de3eb2450f378660242b679f28e69`,
packages at `0.78.0`. Citations below are file:line in that tree.

| Capability | Pi mechanism | Source |
|---|---|---|
| Inject a turn into a **live interactive** session | `sendMessage(msg,{triggerTurn})`, `sendUserMessage(content,{deliverAs:"steer"\|"followUp"})`, `steer()`, `followUp()` — bound in the `AgentSession` **constructor, no mode gate** | `core/agent-session.ts:2194-2213`, `:1207`, `:1343`; example `examples/extensions/file-trigger.ts`, `send-user-message.ts` |
| Headless SDK loop (recruited players) | `createAgentSession(options)` → `{session}`; `session.prompt()`, `session.subscribe()`, `session.dispose()` | `core/sdk.ts:166`; example `examples/sdk/06-extensions.ts` |
| Native tool registration | `pi.registerTool(ToolDefinition)`; params are **TypeBox** (`@sinclair/typebox`), not zod | `core/extensions/types.ts:1142`, `:433` |
| Lifecycle events | `pi.on(...)`: `session_start`, `agent_start/end`, `turn_start/end`, `message_*`, `tool_execution_*`, `tool_call`, `session_shutdown`, … | `core/extensions/types.ts:1098-1135`; `packages/agent/src/types.ts:403` |
| Pre-tool-use allow/deny | `tool_call` event → `{block?, reason?}` (mutate `event.input` to edit args) | `core/extensions/types.ts:993`; example `examples/extensions/permission-gate.ts` |
| Extension packaging / loading | `export default function(pi: ExtensionAPI){}`; npm `pi.extensions[]` manifest; `~/.pi/agent/extensions/`, `.pi/extensions/`, `settings.json` `extensions[]`; inline `extensionFactories` (zero-FS) | `core/extensions/loader.ts:396`, `:468-509`, `:552`; `core/extensions/types.ts:1388` |
| Persistent Temporal connection in-extension | Extension is a plain in-process async fn — no sandbox; can hold a gRPC client/timers/sockets, torn down on `session_shutdown` | `loader.ts` (no VM/worker isolation) |

---

## Architecture

Think of agent-tempo as **three stacked layers**; Pi only touches the top one.

### Layer 1 — Temporal coordination core (shared, unchanged)
`src/workflows/`, `src/activities/`, `src/client/` (TempoClient), `src/connection.ts`,
`src/ensemble/`, `src/http/`, and the **daemon as Temporal worker host**. This is "the
library." Pi integration is a *consumer* of it, never a replacement.

**Worker placement:** the Temporal `Worker` stays in the daemon (always-on, independent of any
session). The Pi extension holds only a thin `WorkflowClient` that signals/queries it. This
preserves the durability model — session workflows must outlive any one attached human, which
is exactly why a daemonless "worker-in-the-agent-process" model is unsuitable for the
multi-session case. (A single-process in-extension worker remains possible for a solo/ephemeral
mode — see [Open Decisions](#open-decisions) D4.)

### Layer 2 — Tool surface (dual front-end over one core)
The existing centralization in `server-tools.ts` is real but **MCP-shaped**: both current front-ends are concrete `McpServer` instances — `src/server.ts` (stdio) and the claude-api adapter's in-process server (`mcp-bridge.ts`, `new McpServer` over `InMemoryTransport`). `registerAllTempoTools(server: McpServer, …)` and every `register*Tool` bind to that concrete type; `defineTool` calls `server.tool(...)`; handlers return the MCP `ToolResult` shape. So a Pi-native front-end is **not** a clean drop-in third consumer — it requires first extracting a transport-neutral tool descriptor (see **MD-B**), then rendering it onto MCP (existing) and Pi (new). The handler *bodies* are already transport-neutral (they call `handle.executeUpdate(submitOutboxUpdate, …)` and return data) — the MCP coupling is only in the registration wrapper + result shape. D1 (schemas) is downstream of MD-B.

### Layer 3 — Runtime / adapters (Pi joins; others stay)
Pi is a new player runtime in two shapes:

- **Interactive Pi player** — a human runs `pi` with the agent-tempo extension loaded. The
  extension is a *client*: on `session_start` it registers/attaches a session workflow, awaits
  cue signals, and injects them via `sendMessage(..., {triggerTurn})` (or `steer()` to interrupt
  an in-flight turn). Attachment phase is driven from real events.
- **Headless / recruited Pi player** — the daemon spawns a `createAgentSession` loop with the
  extension injected as an **inline factory**. Cues arrive via `session.prompt()`. No terminal,
  no human, no separate install.

The **attachment-driver** sub-layer dissolves for Pi players — `InteractiveAttachment`, the `SdkAttachment` base, and the #249 heartbeat/phase-watcher/reconnect machinery in `adapters/base.ts`. This is **clean for the interactive Pi player** (a human launches `pi`, no spawn). It is **partial for headless/recruited Pi players**: spawn (`src/spawn.ts`), recruit host-routing, the `AdapterRegistry` + `adapterId`/`AdapterClass` identity, and the per-host `spawnProcess` activity all persist — a headless Pi player still has to be spawned and named in the attachment model.

### Layer map

| agent-tempo today | Under Pi | Disposition |
|---|---|---|
| MCP server (`src/server.ts`) + stdio | `pi.registerTool` native registration | Dissolves (for Pi players) |
| Tools (`src/tools/*`, zod) via `server-tools.ts` | Pi extension front-end over same core (TypeBox) | Replaced front-end, shared logic |
| `InteractiveAttachment` (Claude Code driver) | Pi extension + cue inject | Replaced for interactive Pi; spawn/registry/recruit-routing **persist for headless Pi** |
| `claude-api`, `opencode` headless adapters | `createAgentSession` headless + Pi's own multi-provider models | **Subsumed** — deprecation candidates |
| `SdkAttachment` base + heartbeat (#249) | Pi `agent_*`/`turn_*`/`session_shutdown` events | **Phase inference dissolves; liveness heartbeat persists in reduced form** (see MD-A) |
| Copilot `onPreToolUse` auto-allow | `pi.on("tool_call") → {block?}` | Replaced (largely moot once tools are native) |
| Session resume (`sessionId`) | Pi `SessionManager` / `continueSession` / fork | Reused (Pi's, richer) |
| TempoClient + workflows + daemon worker | Held by extension (thin client) / daemon (worker) | **Reused unchanged** |
| Attachment-phase search attribute | Driven from Pi event handlers | Reused (workflow side), re-sourced (driver side) |

---

## Adapter coexistence strategy

Pi does **not** force abandoning the existing adapters. Honest per-adapter outlook:

| Adapter | Fate | Why |
|---|---|---|
| `claude-code` (interactive Claude Code) | **Stays** | Different agent; Claude Code isn't extensible, so it *needs* MCP+adapter |
| `copilot` (GitHub Copilot SDK) | **Stays** | Distinct product |
| `claude-code-headless` (subscription-billed `claude`) | **Stays** (for now) | Distinct billing model; Pi OAuth into Claude Max overlaps eventually |
| `claude-api` (headless Anthropic API) | **Deprecation candidate** | Pi headless against Anthropic subsumes it, with a real tool loop |
| `opencode` (headless multi-provider) | **Deprecation candidate** | Pi is itself multi-provider (15+ via `pi-ai`) |
| `mock` (dev-only) | **Stays** | Test substrate |

The streamlining (no MCP, no dev-channels, event-driven phase) accrues **only to Pi players** —
Pi cannot make Claude Code extensible. So the adapter machinery persists as long as non-Pi
agents are supported. Mental model: *agent-tempo becomes a Temporal coordination core with two
skins — MCP for black-box agents, native extension for Pi.*

---

## Installation / distribution

Three components, but **not** three install commands — the extension is **bundled inside
agent-tempo** and auto-registered, mirroring today's MCP auto-provisioning (#289 bootstrap:
`isMcpConfigured → addGlobalMcp`).

**Interactive Pi player — 2 installs, auto-wired:**
```
npm i -g @earendil-works/pi-coding-agent   # Pi (the agent the human runs)
npm i -g agent-tempo                        # coordination core + bundled extension + daemon
```
agent-tempo's bootstrap gains a step: write the bundled extension into Pi's
`~/.pi/agent/extensions/` (or `settings.json` `extensions[]`). The user just runs `pi`.

**Headless / recruited Pi player — effectively zero extra installs:** the daemon constructs the
Pi SDK session with the extension as an **inline factory**; headless uses Pi's SDK *library* (a
dependency of agent-tempo), not the global `pi` CLI. Recruiting works once agent-tempo is
installed.

**Tighter options:** the extension can self-bootstrap the daemon on `session_start`
(`isDaemonRunning() || startDaemon()`); and/or ship as a Pi-loadable npm package via the
`pi.extensions[]` manifest.

**Version coupling (real gotcha):** the extension targets a specific Pi `ExtensionAPI` (churn
risk — packages at `0.78.0`). Declare Pi as a **peer/optional dependency with a version range**
and run a **preflight** (the existing `sdk-probe` pattern used for the `claude` binary,
`@anthropic-ai/sdk`, OpenCode) with an actionable error on mismatch.

---

## Meijer deployment view

A concrete target deployment exercising all three requirements.

**Model backend — GitHub Copilot subscription.** Headless players authenticate via a mounted `auth.json` or `COPILOT_GITHUB_TOKEN` env (no interactive login in-container); an interactive Pi player authenticates via `/login`. (OAuth-in-container feasibility under research.)

**Containerized ensemble.** The container runs the **daemon**, which hosts all headless Pi players (their `createAgentSession` loops + extension run in-process) plus the Temporal workers and the HTTP/SSE server. The conductor's terminate/recruit/reset maps to existing `destroy`/`recruit`/`restart`(+`loadFromState`) and **D14**.

**Remote human observe + steer — Path A (MD-E).** A human on their own dev machine connects to the container daemon's HTTP over one TLS-fronted port (reverse proxy / Tailscale — no native TLS in the daemon). Observe = SSE `/v1/events/:ensemble` + `/v1/state`; steer = the HTTP write surface (cue/recruit/restart/destroy/pause/play). Inner-loop **tail** = `/v1/players/:e/:p/inner` (MD-F); **gate** = MD-G. Access tiered per MD-E RBAC.

**Durability invariant (load-bearing).** Session workflows live in Temporal and are serviced by the **daemon's** worker; the remote human's Pi (if any) is a **thin client**. Closing the human's Pi, or losing the human's network, NEVER kills players — the autonomous ensemble keeps making progress with no human connected. This is precisely why **D4b (in-extension worker / no-daemon) is rejected**: an in-extension worker would couple player liveness to a client process.

---

## Implementation roadmap

Sequenced so the riskiest assumption is validated first. **Note on critical paths:** Phase 0 is the *technical* de-risker (interactive injection is the highest-uncertainty primitive); but **Meijer's user-value critical path is Phase 3 (headless) + inner-loop tail**. Phase 0's cue-handler + tool-registration work drops directly into the headless runtime, so Phase 0 is not wasted for the headless-first use case.

- **Phase 0 — Conductor-cue PoC (~1 day) + MD-B seed.** Pi extension: on `session_start` open a `WorkflowClient` + register/attach the session workflow (reuse existing workflow code); await a cue and inject via `steer`+`triggerTurn` (D10 default; adapt pi-messenger); register **one** native tool (`report`) via the MD-B descriptor + narrow TypeBox converter (proves the path); drive attachment-phase from `session_start`/`agent_start`/`agent_end`/`session_shutdown` (phase mapping below). **ADD acceptance criterion: kill the Pi process abruptly (no `session_shutdown`) and confirm the workflow detects the dead attachment within the lease window** — this exercises MD-A on day 1. Also fold in D12's shared-connection spike.
- **Phase 1 — Tool-surface port.** MD-B descriptor refactor → render onto Pi; D1 narrow converter + CI parity test; wire the `tool_call` auto-allow posture (D8 state i/ii). Full tool parity.
- **Phase 2 — Interactive runtime hardening.** Lifecycle→phase mapping, naming/part/who-am-i, sessionId↔SessionManager reconcile (D11), cue delivery semantics (D10 operator-vs-peer), Pi identity in the registry (MD-D).
- **Phase 3 — Headless Pi runtime (Meijer critical path).** Daemon-spawned `createAgentSession` players with inline extension; recruit `model`→provider/model (D7); MD-A liveness finalized; claude-api/opencode freeze evaluation (D3); reset verb (D14); headless security posture (MD-C, with tempo-security).
- **Phase 3.5 / parallel — Inner-loop observability.** Tier-1 coarse always-on + Tier-2 fine-on-demand per-player SSE (MD-F); [INNER-LOOP-PROTOCOL.md](../INNER-LOOP-PROTOCOL.md).
- **Phase 4 — Interaction depth + packaging.** Gate (MD-G) + manual-mode/take-over (MD-H); MD-E three-tier RBAC; D5 packaging via Pi manifest, D6 version pin + Node 22.19+ + preflight. Docs.

**Pi event → attachment-phase mapping** (drive phase from `agent_start`/`agent_end` ONLY; `turn_*`/`tool_execution_*` stamp last-activity for liveness, never transition phase):
`booting` = WorkflowClient connecting + claimAttachment in flight · `attached` ← `session_start` · `processing` ← `agent_start` · `awaiting` ← `agent_end` (NOT detached) · `draining` ← `session_shutdown` handler (fire `adapterExited` graceful) · `detached` = workflow collapse on `adapterExited` OR lease-reaper on abrupt death (MD-A) · `gone` = destroy.

---

## Risks

1. **zod→TypeBox tool schemas** — mechanical but ~30 tools. Low risk, medium effort. (→ D1)
2. **Pi API churn** — root version `0.0.3` vs package `0.78.0` suggests active development; the
   `ExtensionAPI` could shift between minors. Pin `@earendil-works/pi-coding-agent@0.78.0`;
   read `oh-my-pi` to see what the community patches around. (→ D6)
3. **Single-process coupling** — running the Temporal worker in the agent process couples crash
   domains. Mitigated by the recommended split (worker in daemon, extension is a thin client).
   (→ D4)
4. **Reproducibility** — spike read only `pi-mono`, not `earendil-works/pi` or `oh-my-pi`. Two
   spike items UNCONFIRMED: (a) sharing one Temporal connection across loops in one OS process;
   (b) exact streaming `AgentToolResult`/`onUpdate` shape. Neither blocks the verdict. (→ D12)
5. **Pi `tool_call` handler async semantics (gate-blocking) — UNCONFIRMED.** MD-G's live gate requires the `tool_call` handler to **await a Promise** so the agent loop pauses until the operator's approve/deny arrives. If Pi's `tool_call` handler is synchronous-only (cannot return/await a Promise), the gate cannot pause the loop and MD-G needs a different mechanism (e.g. pre-emptive `block` + re-issue on approval). **Phase-0 / researcher verify item.**

---

## Open Decisions

Status legend: ✅ RESOLVED-with-default · ⚠️ NEEDS-MAINTAINER

| # | Decision | Leaning / Resolution | Status | Blocks |
|---|---|---|---|---|
| **MD-A** | Liveness model for Pi players (crash/SIGKILL/sleep — event map has NO abrupt-death entry) | Keep a reduced workflow-side liveness signal: the extension sends a low-frequency heartbeat (or the workflow lease reaper detects silence). Phase transitions come from Pi events; lease/liveness stays. Do NOT go event-only. | ⚠️ NEEDS-MAINTAINER (sizing) | Phase 0 |
| **MD-B** | Transport-neutral tool-descriptor refactor | Extract `{name, description, params, handler→plain data}`; render onto McpServer (existing) + Pi. Handler bodies reused verbatim (outbox-routing preserved). Prerequisite to D1. | ✅ (do it) | Phase 1 (gates D1) |
| **D1** | zod→TypeBox tool schemas | Import from **`typebox` 1.x** (NOT `@sinclair/typebox`). Write a **narrow** converter for the actual zod feature subset used by the ~30 tools + a **CI parity test** mirroring the wire-protocol drift detector (fails on unconverted feature OR MCP/Pi tool-set divergence). Sequence AFTER MD-B. | ✅ | Phase 1 |
| **D2** | Long-term tool surface | Keep MCP **and** Pi front-ends while non-Pi agents (Claude Code) exist. | ✅ | Strategy |
| **D3** | Deprecate `claude-api`/`opencode`? | **Freeze** (no new features), re-evaluate after Phase 3 proves real parity. Do NOT pre-commit deprecation — claude-api prompt-cache control + opencode 70-provider breadth aren't obviously subsumed. | ✅ (downgraded) | Phase 3 |
| **D4** | Worker placement / daemonless | (a) worker-in-daemon + thin WorkflowClient in extension. **D4b (in-extension worker / no-daemon) REJECTED** — see Meijer durability invariant. | ✅ | Phase 0 |
| **D5** | Distribution shape | **Prefer Pi's first-class package manifest + pinned npm: spec** (`pi.extensions[]`) over hand-writing into `~/.pi/agent/extensions/`. Keep bundle-and-auto-register as fallback. | ✅ | Phase 4 |
| **D6** | Version policy | Pin Pi **minor**; preflight **hard-fail** (sdk-probe pattern). **Add Node 22.19+ requirement** (doc currently says 20+ — Pi needs newer). | ✅ | Phase 4 |
| **D7** | Provider/model mapping | Reuse opencode-style `provider/model` string for recruit `model` → Pi selector. | ✅ | Phase 3 |
| **D8** | Permission posture for Pi players | **Three states**: (i) auto-allow agent-tempo tools when no operator; (ii) Pi's own `tool_call` policy for Bash/Edit/Write; (iii) **live operator-gate** when an operator is tailing-with-gating-on (see MD-G). | ✅ (extended) | Phase 1 |
| **D9** | Repo / package strategy | Start as `src/pi/` **in the same package** (shares types/signals/server-tools refactor/validation). Promote to a workspace/standalone npm package only if/when D5's separate-package path is pursued. Determinism guard: `src/workflows/**` must import nothing from `src/pi/**` or any pi pkg (add import-boundary CI check). | ✅ | Phase 0 |
| **D10** | Cue delivery semantics | **DEFAULT = `steer`+`triggerTurn`** (proven by pi-messenger). Distinguish **operator-cue = interrupt** (steer, priority human override) vs **peer-cue = followUp** (queue, don't interrupt in-flight work). Confirm Pi `followUp`-while-idle triggers a turn (else idle delivery needs triggerTurn). | ✅ (flipped) | Phase 2 |
| **D11** | Identity & session resume | Map Pi `SessionManager` sessionId → workflow metadata; reuse existing `sessionId` resume; set_name/set_part/who_am_i via the shared tool handlers. | ✅ | Phase 2 |
| **D12** | Close spike gaps | Verify shared Temporal connection across in-process headless loops; streaming `AgentToolResult` shape; read earendil-works/pi + oh-my-pi. Pull the shared-connection spike INTO Phase 0. | ⚠️ (verify) | Phase 0 |
| **D13** | Tracking & scope | Epic + per-phase PRs (`Refs #N`). | ✅ | Now |
| **D14** | Reset verb semantics | Two distinct ops: **clean wipe** → Pi `newSession()` (fresh context, no seed); **seeded reset** → existing `restart` + `loadFromState` (#334). Map conductor "reset player context" to whichever the caller asks; default clean-wipe for "reset", seeded for "restart with state". | ⚠️ NEEDS-MAINTAINER (default choice) | Phase 3 |
| **MD-C** | Headless-Pi tool-access security posture | Baseline default-deny/sandbox for **unsupervised** full-Bash/Edit headless Pi in a container STANDS. Live gate (MD-G) is an **additive** human-in-the-loop layer for the *supervised* window only — NOT a license to relax the unsupervised baseline. Route to tempo-security. | ⚠️ NEEDS-MAINTAINER (+ security) | Phase 3 |
| **MD-D** | Pi identity in attachment model | New `adapterId`/`AdapterClass` entry for Pi (interactive + headless); new `ClaudeTempoPlayerType` value(s). Registry gains a Pi entry — it doesn't fully dissolve. | ✅ | Phase 2 |
| **MD-E** | Remote-access posture | **Path A (daemon-HTTP + dashboard) = default** remote-human model. **THREE-TIER RBAC**: coarse-observe (low) / inner-tail (higher — sees raw file/secret content) / gate+manual-mode+steer (highest). **Single shared bearer is insufficient.** Path B (Temporal-cluster exposure) reserved for "human joins as a player" future. | ⚠️ NEEDS-MAINTAINER (RBAC scope) | Deploy / Phase 3 |
| **MD-F** | Inner-loop observability transport | **Daemon-local ephemeral per-player SSE side-channel** `GET /v1/players/:e/:p/inner`. NO ring/replay/seq, NOT Temporal, NOT the coordination event-bus (would trip the 50 ev/s cap + flood the 256 ring). **Tier 1** coarse-always-on (current tool/busy-idle/token-count — mostly exists via player.phase_changed + activityCount) on the existing bus; **Tier 2** fine-on-demand per-player (subscription presence = start/stop signal). Coalesce token-deltas at source (~100ms/N-tokens); bounded per-sub queue + `compacted{dropped:N}` marker. Own mini-protocol doc ([docs/INNER-LOOP-PROTOCOL.md](../INNER-LOOP-PROTOCOL.md)). Keep OUT of SSE_EVENT_KINDS. | ✅ | Phase 3+ |
| **MD-G** | Gate policy (live tool_call approve/deny) | Pi `tool_call` handler awaits an in-process Promise resolved by operator `POST /v1/players/:e/:p/gate/:requestId`. **Required: timeout + default posture when no operator** (autonomous-first → default-allow-on-timeout preserves autonomy; default-deny safer but stalls). Only the highest RBAC tier (MD-E) may gate. Depends on the Pi-Promise-return confirmation (Risk 5). | ⚠️ NEEDS-MAINTAINER (default posture) | Phase 4 |
| **MD-H** | Take-over model | Build **TAIL + GATE + STEER + "manual mode"** (hold conductor cues + route every tool_call to operator gate). Do **NOT** build a true bidirectional/keystroke REPL take-over (needs WebSocket, fights autonomous-first, duplicates the above). Real terminal drive = run an **interactive Pi locally** (Path B + interactive Pi). | ✅ | Phase 4 |

---

## References

- Spike memory: `project_pi_native_integration_spike` (commit/version, full citations)
- Pi monorepo: <https://github.com/badlogic/pi-mono> (@ `564ad70`, packages `0.78.0`)
- Pi (alt org): <https://github.com/earendil-works/pi> · community fork: <https://github.com/can1357/oh-my-pi>
- agent-tempo shared tool core: `src/server-tools.ts`; auto-provisioning: `src/cli/startup.ts` (#289)
- Related pain points: #18 (recruit message loss), #249 (heartbeat/phase observability),
  `/clear` no-session-hook (see CLAUDE.md concepts)
