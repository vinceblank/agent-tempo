# Greenfield: A Pi-Native agent-tempo

> **Status:** Blue-sky vision / design spike. UNTRACKED draft — not committed. For vinceblank's review.
> **Author:** greenfield-architect (my-tempo-architect), tempo-impl ensemble.
> **Framing:** "What does agent-tempo look like if rebuilt from scratch, Pi as the *only* runtime?"
> This is the **target**, not a migration plan. Opinionated and concrete.

---

## 1. The one-sentence thesis

agent-tempo's durable core — **Temporal workflows + the outbox + the ensemble/maestro coordination
layer** — was never the part that touched MCP, adapters, or the Ink TUI. Those three were always a
*presentation and runtime-shim layer* bolted onto a clean coordination backbone. **Delete them, make
Pi the single runtime, and agent-tempo collapses to roughly half its surface area while losing almost
nothing that's load-bearing.**

The proof is already in the tree: `src/pi/extension.ts` talks to Temporal *directly* via
`PiWorkflowClient`. It has **zero MCP dependency**. `renderToPi` registers the exact same tool
descriptors natively on Pi's `ExtensionAPI`. The `CuePump` already delivers messages by polling the
workflow and injecting into the live Pi session. The Pi-native world isn't a rewrite — it's *what's
left when you remove the scaffolding for every other agent type.*

---

## 2. What the system IS (Pi-native target architecture)

Four layers, top to bottom:

```
┌─────────────────────────────────────────────────────────────────────────┐
│  RUNTIME SURFACE  —  Pi, in three modes (all the same extension family)   │
│                                                                           │
│   (a) Interactive player   pi -e tempo/extension.js   (human at a TUI)    │
│   (b) Headless player      createAgentSession(...)     (recruited, no TUI) │
│   (c) Command-center       pi -e tempo/mission-control (observer console)  │
└─────────────────────────────────────────────────────────────────────────┘
                │  native tools (renderToPi)        ▲  cue injection
                │  + cue pump + heartbeat           │  (sendCustomMessage)
                ▼                                    │
┌─────────────────────────────────────────────────────────────────────────┐
│  CLIENT BRIDGE  —  src/pi/  (the ONLY way agents reach Temporal)          │
│   PiWorkflowClient · PhaseDriver · CuePump · ResetPump · render-tools     │
│   tool descriptors (zod SSOT) · gate/inner-loop clients                   │
└─────────────────────────────────────────────────────────────────────────┘
                │  executeUpdate(submitOutbox) · signals · queries
                ▼
┌─────────────────────────────────────────────────────────────────────────┐
│  DURABLE CORE  —  Temporal (the persistence + messaging layer)            │
│   session workflow · scheduler · maestro (per-ensemble + global)          │
│   the OUTBOX (workflow-internal) · search attributes (visibility)         │
└─────────────────────────────────────────────────────────────────────────┘
                │  workers poll task queues
                ▼
┌─────────────────────────────────────────────────────────────────────────┐
│  DAEMON  —  shrinks to "Temporal workers + spawn + optional web"          │
│   shared queue: workflows + delivery activities                           │
│   per-host queue: spawn Pi subprocess + hard-terminate                    │
│   OPTIONAL: HTTP/SSE event source (web dashboard connector, stands alone) │
└─────────────────────────────────────────────────────────────────────────┘
```

The mental model: **Temporal is the spine. The Pi extension is the only nervous system that plugs into
it. Everything else is optional skin.**

---

## 3. Today → Pi-native: KEEP / CUT / REPLACE

vinceblank's headline question — *which daemons/components are no longer needed?* This table is the
answer.

| Component (today) | Verdict | Rationale |
|---|---|---|
| **`src/workflows/`** (session, scheduler, maestro) | **KEEP** — unchanged | The durable coordination backbone. Deterministic, runtime-agnostic. Nothing here knows or cares what an "agent" is. |
| **The outbox** (workflow-internal) | **KEEP** — unchanged | It was *never* MCP plumbing. It's the workflow's outbound queue; tool handlers `executeUpdate(submitOutbox)` on their **own** workflow handle. Pi tools already route through it verbatim (see `render-tools.ts` "OUTBOX-COMPLIANCE INVARIANT"). |
| **`src/ensemble/`** (lineup YAML, agent-type resolution) | **KEEP** — simplified | Lineups + player roles survive. But `AgentType = 'claude' \| 'copilot' \| …` **collapses to a single implicit `'pi'`**; "player type" (conductor/composer/soloist) becomes a Pi **persona/system-prompt + part**, not an adapter selector. |
| **`src/pi/`** (extension, headless, render-tools, mission-control) | **KEEP** — promoted to THE runtime | This stops being "one adapter among six" and becomes the entire runtime surface. The module-scope singleton, phase driver, cue pump, reset pump all stay. |
| **Temporal workers / `src/worker.ts`** | **KEEP** — unchanged | Dual-queue (shared: workflows+delivery; per-host: spawn) is exactly right and untouched by going Pi-only. |
| **`src/http/`** (HTTP + SSE event source) | **KEEP** — as an **optional** standalone connector | Decoupled web-dashboard / inner-loop / gate surface. A browser dashboard can attach; if nobody runs one, the daemon works without it. Already isolated behind `reconcileClient` in `daemon.ts`. |
| **`src/config`, `connection`, `git-info`, `utils/*`** | **KEEP** | Plumbing. Runtime-neutral. |
| **`src/cli/`** | **KEEP** — simplified | `up`, `recruit`, `status`, `conduct`, `daemon`, `hosts` survive. They stop *resolving adapters* and just *launch Pi*. |
| **`src/spawn.ts`** | **REPLACE** — collapse to one path | Cross-platform terminal spawning stays, but for **one program (`pi`)** instead of N adapters. The macOS/Windows/Linux quoting matrix remains; the "which binary + which env shape per adapter" fan-out is gone. |
| **`src/server.ts`** (MCP server entry) | **CUT** | The MCP stdio server exists to give *claude-code/copilot* a tool surface. Pi registers tools natively. No MCP server child, no stdio bridge. |
| **`src/adapters/`** (entire layer: base, claude-code, copilot, claude-api, opencode, claude-code-headless, mock, sdk) | **CUT** | This is the single biggest deletion. `BaseAttachment`/`SdkAttachment`, the registry, six descriptors, the `AdapterClass` dispatch — all of it existed to normalize *non-Pi* runtimes. Pi's extension IS the attachment driver (the `pi` descriptor is already "registry/identity only — the singleton owns lifecycle, not a `BaseAttachment`"). |
| **`src/tui/`** (Ink/React TUI) | **CUT** | Pi's own TUI is the interface. The custom App/store/components/SSE-handler go away. Operator oversight moves to the **command-center Pi extension** (§6c). |
| **MCP "channel" delivery** (`notifications/claude/channel`, `isBridgeMode`, copilot bridge) | **CUT** | This was the *push* path for claude-code. Pi gets messages via the **cue pump** (`sendCustomMessage` injection) — already the Pi delivery mechanism. One delivery model, not two. |
| **`registerAllTempoTools` → McpServer path / `renderToMcp`** | **CUT** | Keep `buildAllTempoTools` (the neutral descriptors, zod SSOT) and `renderToPi`. Drop the MCP renderer. The descriptor layer was *designed* transport-neutral for exactly this. |
| **Adapter version probes** in host-profile (`probeClaudeBinary`, copilot SDK probe, claude-code-headless pre-flight) | **CUT/REPLACE** | Host-profile capability collapses to a single question: *"can this host run Pi?"* (Node ≥ 22.19 + `@earendil-works/pi-coding-agent` installed). |

### The "what shrinks" summary

- **The daemon does NOT go away** — but it sheds the adapter probes and becomes purely *Temporal
  workers + spawn + optional HTTP/SSE*. It was already adapter-light; this finishes the job.
- **The MCP server process goes away entirely.**
- **The Ink TUI process goes away entirely.**
- **Five of six adapters + the entire adapter abstraction go away.**
- Net: the two big *processes* deleted are the **MCP server** and the **Ink TUI**. The daemon stays,
  leaner.

---

## 4. What stays LOAD-BEARING (and why it can't be cut)

1. **Temporal** — the durable spine. It's the database, the message bus, the scheduler, and the
   crash-recovery story in one. No agent-tempo without it. Pi is stateless-per-process; Temporal is
   where ensemble truth lives (phase, lease, outbox, history, search attributes).

2. **The session workflow** — authoritative lifecycle (`booting → attached → processing | awaiting →
   draining → detached → gone`), the outbox dispatch loop, the lease/heartbeat math, saveable state,
   quality gates, worktrees, stages. All runtime-neutral. Pi drives the phase via the extension; the
   workflow *is* the source of truth.

3. **The maestro layer** (per-ensemble + global) — ensemble-wide pause/resume, host-profile registry,
   cross-machine recruiting coordination. Independent of runtime.

4. **The outbox** — the reason cross-workflow coordination is reliable and exactly-once-ish. It stays
   workflow-internal and is the one pattern every tool already respects.

5. **The Pi extension itself** (`src/pi/`) — promoted from adapter to the sole client bridge. The
   transport-neutral tool descriptors (zod as SSOT) + `renderToPi` are the entire tool surface.

6. **Web/SSE** (`src/http/`) — *optional but load-bearing when present*: it's the only way a browser
   dashboard, the command-center's coarse board, the inner-loop tail, and the operator gate reach the
   ensemble. Stands alone; the daemon boots fine without a single SSE client.

---

## 5. How players coordinate with NO MCP and NO channels

This is the crux, and the happy answer is: **almost nothing changes underneath, because the outbox was
never MCP.** Here's each verb in the Pi-native world.

### The shape

Every Pi player runs the extension, which:
- is a Temporal **client** (via `PiWorkflowClient`) bound to **its own** session workflow handle;
- registers the full tool surface **natively** on Pi (`renderToPi(buildAllTempoTools(...))`);
- runs a **cue pump** (polls `pendingMessages`, injects via `sendCustomMessage`) + heartbeat + reset pump.

When the agent calls a tool, the handler does what it does today: `handle.executeUpdate(submitOutbox,
…)` on its own workflow. The workflow's dispatch loop processes the entry via an activity. **No MCP
hop. No channel. The tool call goes straight from Pi → the player's own Temporal workflow.**

### Verb by verb

| Verb | Pi-native mechanism | Changed? |
|---|---|---|
| **cue** | Native Pi tool → `submitOutbox` (CueOutboxEntry) → dispatch activity signals target workflow's `receiveMessage` → target's **cue pump** polls + `sendCustomMessage` injects (peer = `followUp`, operator = `steer`, always `triggerTurn`). | **No** — this is *already* the Pi path. We just delete the parallel MCP-channel path that claude-code used. |
| **report** | Native tool → `submitOutbox` (ReportOutboxEntry) → signals the conductor workflow. Conductor is a Pi interactive player; its cue pump surfaces the report. | No |
| **recruit** | Native tool → `submitOutbox` (Spawn/RecruitOutboxEntry) → **spawn activity on the per-host queue** → `runHeadlessPi()` boots a headless Pi subprocess with the extension inlined. | **Simplified** — one spawn path (Pi), no adapter resolution. |
| **ensemble / hosts** | Native tool → Temporal **visibility query** (`workflow.list` over search attributes). Pure read; never touched MCP. | No |
| **broadcast** | Native tool → fan-out of cues through the outbox. | No |
| **pause / play / restart / destroy / release / migrate** | Native tools → outbox entries / workflow updates, exactly as today. | No |

### Does the outbox survive? **Yes — unchanged, workflow-internal.**

The prompt's phrase "outbox-as-MCP-plumbing" is a slight mischaracterization worth correcting
explicitly: **the outbox was never MCP plumbing.** MCP was the *agent-facing tool surface* (how the
model invokes `cue`). The outbox is the *workflow's outbound queue* (how the cue actually gets
delivered). Pi-native swaps the surface (MCP tools → native Pi tools) and **keeps the outbox bit-for-bit.**

### Does the daemon shrink to just Temporal-workers (+ optional web/SSE)? **Yes.**

- **Shared queue worker:** workflows + delivery activities (deliverCue, deliverReport,
  terminateSession, startRecruitedSession, releasePlayer, deliverDetach/Destroy/Restart). Unchanged.
- **Per-host queue worker:** `spawnProcess` (now always "spawn a Pi subprocess") + `hardTerminateAttachment`. Simplified.
- **Optional HTTP/SSE:** the web-dashboard / inner-loop / gate surface. Standalone.
- **Reconcile + cleanup loops:** stay (orphan restore, retention). Runtime-neutral.

The only thing the daemon loses is the **adapter-version probe fan-out** in host-profile computation —
which collapses to a single "Pi available?" check.

---

## 6. The three modes, concretely

All three are the **same Pi runtime + the same `src/pi/` extension family**, differing only in *how Pi
is launched* and *what the extension does on attach*.

### (a) Interactive player — the conductor and human-driven players

```
agent-tempo up --ensemble myband            # or --recruit-conductor from command-center
   └─ spawns:  pi -e dist/pi/extension.js    # real terminal, human at the keyboard
        └─ extension (mode='interactive'):
             session_start → self-bootstrap workflow → claimAttachment → attached
             renderToPi(...) → full tool surface native in the Pi TUI
             cue pump injects peer/operator messages into the live session
             NO tool-call gate (a human owns their machine)
```

The human talks to Pi normally; agent-tempo tools (`cue`, `recruit`, `ensemble`, …) are just tools Pi
can call. Cues from peers/operators stream in via the pump. This is **today's interactive Pi conductor,
generalized to be the default for every human-driven player.**

### (b) Headless player — recruited workers, no terminal

```
recruit(agent implicitly 'pi', name='soloist-1', host=…)
   └─ outbox → spawn activity (per-host queue) → runHeadlessPi():
        createAgentSession({ resourceLoader: { extensionFactories:[ext], noExtensions:true }, model? })
        extension (mode='headless', toolAccess='restricted'|'standard'|'full'):
             bindExtensions() → session_start → claim → heartbeat → tools → cue pump
             MD-C tool gate ACTIVE (exec/shell hard-blocked at 'restricted')
             MD-G operator gate (arm/decide via daemon HTTP) when an operator is watching
        stays alive until SIGTERM → reliable detach → dispose → exit
```

This is `src/pi/headless.ts` essentially as-is. The headless player is unsupervised, so the
**tool-access policy** (`restricted`/`standard`/`full`) and the **operator gate** are the safety model.
`noExtensions: true` keeps the tool surface to Pi built-ins + agent-tempo tools (no third-party
exec-tool smuggling).

### (c) Command-center / mission-control — the operator console

```
pi -e dist/pi/mission-control/extension.js   # operator's own Pi TUI, OBSERVER-ONLY
   └─ extension:
        opens coarse SSE  (/v1/events/:ensemble)      → ensemble board (phase, part, tool, ctx%)
        opens fine SSE    (/inner, T3 bearer)          → per-player inner-loop tail
        slash-commands → daemon HTTP write surface     → cue/pause/play/restart/destroy/reset
        gate arm/disarm/decide                          → operator approval of headless tool calls
        NEVER claims attachment, NEVER registers as a player  (invisible to the ensemble)
```

This **replaces the deleted Ink TUI.** Instead of a bespoke React/Ink app, oversight is *itself a Pi
extension* — one interactive Pi TUI reskinned into a live mission board + operator controller. It
drives everything over the daemon's HTTP/SSE surface (which is why §4 keeps web/SSE load-bearing). It's
already prototyped in `src/pi/mission-control/`.

**The elegance:** the operator's tool is the same tool as the players' tool (Pi). One runtime to learn,
one runtime to ship.

---

## 7. Risks & resolved unknowns (grounded in Pi 0.78.1)

> All `[VERIFY]` flags from the draft are now **resolved** against tempo-researcher's Pi 0.78.1
> capability findings (installed SDK + its docs/examples, cross-checked against `src/pi/*`). Each item
> below carries a concrete verdict — ✅ resolved-safe, ⚠️ hard risk, or 🔶 partial. No hedges.

### ✅ RESOLVED-SAFE — "Can native Pi tools fully replace the MCP surface?" — **YES, 1:1.**

This was my headline open question; it's now closed. Pi's `registerTool({name,label,description,
parameters,execute})` is a **proven, CI-enforced 1:1 replacement** for the MCP surface — `renderToPi`
registers the *same* transport-neutral zod descriptors that feed `renderToMcp`, and
`test/pi-tool-parity.test.ts` asserts identical tool set + identical required params across both
front-ends. Handlers are reused verbatim and still route through `executeUpdate(submitOutbox)`.
**Dropping MCP loses zero tools.** Crucially, **we use no MCP-only capability** — no sampling
(`createMessage`), no MCP resources, no MCP prompts; MCP was purely a stdio *tool transport* for us. The
push-delivery concern is also moot: a cue is a Temporal signal, not an MCP channel notification (see
"resolved-safe: no channels layer" below). So there is **no capability gap** blocking the cut.

**The one real, irreversible consequence** (naming it as the constraint it is): dropping MCP makes the
tool surface **Pi-only**. Claude Code / opencode / copilot / claude-api can no longer consume
agent-tempo tools — they need the MCP server. That's the *accepted premise* of this spike, not a
defect, but it's a **one-way door**: re-supporting a non-Pi agent later means rebuilding the MCP server.
Mitigation already in place: the transport-neutral descriptor seam (`buildAllTempoTools`, zod SSOT)
survives the cut, so a second front-end *could* be re-added without touching tool logic. (Minor: any
future tool param must be TypeBox-expressible — `zod-to-typebox` is fail-loud + CI-guarded.)

### ✅ RESOLVED-SAFE — "Is there a channels layer to delete?" — **NO. There never was one.**

`PiWorkflowClient` is a thin client-side Temporal `WorkflowClient` (signal/query/update only —
determinism boundary intact) that already does the *entire* coordination surface: claim/heartbeat,
processingStart/End, detach, submitOutbox routing, `pendingMessages`+`markDelivered` cue intake,
resume pointer, reset. **A cue *is* a Temporal signal.** There is no separate channels abstraction to
remove — the extension→Temporal path is sufficient and already shipping. (`src/tui/`'s CUT is also
fully de-risked: Pi's native TUI hosts the command-center without Ink — `setWidget`/`setHeader`/
`setFooter` for persistent surfaces, and `ctx.ui.custom({overlay})` for arbitrary full-screen render,
*proven* by Pi's shipped DOOM@35fps / snake examples. Board-render ceiling is not a concern.)

### ✅ RESOLVED-SAFE — the cue-injection invariant — **a documented Pi contract, not observed behavior.**

This was the draft's "most fragile assumption"; the findings *upgrade* it. The peer-vs-operator
delivery model rests on `session.sendCustomMessage(..., { deliverAs, triggerTurn })` — and
`agent-session.d.ts` (L371–374) confirms that method takes the **identical** options as the extension's
`pi.sendMessage`, so there's no API divergence between our cue-pump call and the documented surface. All
three invariants are **DOCUMENTED** (TSDoc in the shipped `.d.ts` + bundled `docs/extensions.md`
L1306–1309), which downgrades "revalidate on *every* bump" to "published API contract — revalidate on
**major** bumps":
- **`followUp` queues, never preempts a running turn** — documented (`extensions.md` L1307: *"Waits for
  agent to finish. Delivered only when agent has no more tool calls."*). ✅
- **`steer` = same-turn priority** (delivered after the current tool batch finishes, before the next LLM
  call) — documented (L1306). ✅
- **`triggerTurn` = no-op while a turn is in flight, wakes a cold-idle session** — documented (L1309 +
  `.d.ts` L368: *"If true and not streaming, triggers a new LLM turn"* — the "if idle / if not
  streaming" qualifier *is* the no-op-while-busy guarantee). ✅

So peer cues cannot silently become preemptions on a minor bump — the contract is published. Standard
hygiene (a real-Pi mid-turn integration smoke at the version floor) still belongs in CI, but this is no
longer a soft, observation-only assumption.

**⚠️ One honest precision point (a design boundary, not a regression):** even an **operator `steer`**
cue does **NOT** hard-abort a running tool — it lands *after* the current tool batch completes, before
the next LLM call. The only hard mid-tool interrupt is `AbortSignal` / RPC-abort. So if the vision ever
wants *"operator can yank a player out of a long-running tool instantly,"* `steer` won't do it — that
needs the AbortSignal/RPC-abort path wired into the command-center. Worth naming so operator-control
expectations stay honest. (Also pure headroom, not a gap: Pi's `execute(..., onUpdate, ctx)` supports
**streaming tool updates**, which `renderToPi` currently ignores — available if we ever want it.)

### ⚠️ HARD RISK — command-center at multi-host scale, and the structural single-session limit.

Two concrete, named limits (not soft):
- **One active session per Pi process.** You **cannot** host N players as N sessions in one Pi process.
  "Command-center over N players" is therefore *necessarily* an observer extension (HTTP/SSE) **plus**
  N headless subprocesses — the daemon-spawns-a-subprocess-per-recruit model is **structural and
  permanent**, not an implementation choice we can optimize away.
- **The fine inner-loop tail is daemon-local.** Mission-control's `tailability` refuses a cross-host
  tail today (H3a; tracked #645/H3b). The coarse board is cross-host (Temporal visibility), but deep
  per-player observation only works same-host. **A one-operator console over a true multi-machine
  ensemble needs cross-host inner-loop routing that does not exist yet — unproven at >1 host.**
- **(Design-it-deliberately, not a blocker):** `ctx.ui.custom({overlay})` takes *input focus*;
  persistent widgets are position-constrained. A live board and operator slash-commands contend for the
  editor. Mission-control dodges this today by being HTTP-driven observer + ~200 ms render tick — the
  focus model needs an explicit decision before the console grows interactive controls.

### ⚠️ HARD RISK — per-host, non-portable auth (sharpens the cross-machine story).

Subscription auth (Claude Pro/Max, ChatGPT/Codex, GitHub Copilot via Pi's `/login` → OAuth tokens in
`~/.pi/agent/auth.json`, auto-refreshed) is **per-host and not portable.** Recruiting a headless Pi on
host X requires X to *already* be logged in (or carry env-key providers). This is a real friction in the
cross-machine recruiting story that the adapter world partly hid. *Upside that softens the
single-runtime fear:* Pi is genuinely multi-provider — one process reaches Claude, OpenAI, Copilot, and
~30 env-key providers (one model per session at a time, switchable via `model_select` / `provider/model`).
So Pi-native **recovers most of the multi-provider optionality** we'd lose by deleting claude-api /
opencode — the loss is narrower than the draft feared.

### ⚠️ HARD RISK — single upstream dependency + concentrated security surface.

- **Single-runtime exposure.** The whole product rides on one optional ESM package
  (`@earendil-works/pi-coding-agent`), a Node ≥ 22.19 floor, and an upstream API that **has already
  drifted on us** (#645's undeclared interactive `session` field; the instance-rebuild singleton
  hazard; reason-discriminated teardown). No fallback runtime. This is the price of the bet — manage it
  with a pinned version floor + the descriptor seam (above) as an escape hatch.
- **Security concentrates onto one surface.** `tool_call` pre-exec intercept is **confirmed stable in
  0.78 and fires in both interactive and headless** — a solid foundation for native authz (already used
  by `tool-capability.ts` + the 3d operator gate). But in Pi-native, *all* unsupervised-execution
  safety rides on the Pi extension's MD-C deny-list + `noExtensions: true` + MD-G operator gate. The
  `noExtensions` soundness is verified against 0.78 *source* and **must be re-verified on every Pi
  bump** — one regression in how Pi loads extensions reopens the exec-tool vector for every headless
  player at once. Cleaner than six spawn paths, but it's a *single* story.

### ✅ RESOLVED — the worker/daemon is **not eliminable** (clarifies "slims, not dies").

Confirmed: durable workflow code (session/scheduler/maestro + outbox activities) **must** run in a
long-lived worker inside the V8 determinism sandbox — it cannot live in an ephemeral Pi process. The
daemon slims to *worker + spawner + optional HTTP/SSE* but **does not vanish.** Any "daemon-less, just
Pi + Temporal" intuition is structurally impossible. (Aside: Pi ships a JSONL stdin/stdout `--mode rpc`
as an *alternative* operator-control path to extension-embedding — worth knowing, not needed; our
extension+Temporal path is cleaner.)

---

## 8. Bottom line for vinceblank

Pi-native agent-tempo is **the same coordination engine with the scaffolding removed.** You delete two
whole processes (MCP server, Ink TUI), five of six adapters and the entire adapter abstraction, and the
dual MCP/channel delivery path — and you lose **nothing structural**, because the durable core
(Temporal + workflows + outbox + maestro) never depended on any of it. The daemon stays but slims to
*workers + spawn + optional web*. Coordination is *unchanged* under the hood; only the agent-facing tool
surface flips from MCP to native Pi.

The bet you're making is **all-in on Pi as the runtime** — its API stability, its release cadence, its
multi-provider auth, and its cue-injection semantics become your foundation. The reward is a codebase
maybe half the size, one runtime to reason about, and an operator console that's the same tool as the
players. The residual risk is *concentration*: one upstream dependency, one security surface.

**The two most load-bearing unknowns are now resolved against Pi 0.78.1, both in favor:** native Pi
tools are a **CI-enforced 1:1 replacement** for the MCP surface (we use *no* MCP-only capability), and
the cue-injection invariant that the whole peer-vs-operator model rests on is a **documented Pi
contract**, not observed behavior. What remains are *honest, nameable* trade-offs, not blockers:
the cut is **one-way** (the surface becomes Pi-only — no other agent can consume the tools); the
command-center has a **structural single-session-per-process limit** and an **unproven >1-host story**;
operator `steer` **can't hard-abort a long-running tool** without the AbortSignal path; subscription
**auth is per-host**; and **all unsupervised-exec security concentrates** on the Pi extension's gate.

Net: this is a **clean, compelling, technically-sound target** — we already ship ~80% of it. The
decision isn't "can it be done" (it can) but "are you ready to make the Pi-only coupling and the
single-runtime concentration your permanent foundation." If yes, the path is mostly *deletion*, not
construction.
