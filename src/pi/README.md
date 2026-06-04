# agent-tempo × Pi — native integration

> **Status:** Phase 2 — interactive runtime landed (Phases 0–2 complete; headless = Phase 3).
> Design: [`docs/design/pi-native-integration.md`](../../docs/design/pi-native-integration.md).

This directory makes a [Pi](https://github.com/badlogic/pi-mono) session a first-class
agent-tempo player **natively** — no MCP stdio bridge, no "dev channels" terminal-injection
hacks, no heartbeat-inferred attachment phase. The Pi extension holds a thin **client-side**
Temporal `WorkflowClient`, registers the FULL agent-tempo tool surface on Pi, drives the
attachment phase from real Pi lifecycle events, and survives Pi's per-switch instance rebuild
via a module-scope singleton.

## What it delivers

1. **Full native tool surface** — every agent-tempo tool registered via
   `renderToPi(buildAllTempoTools(...))` with **TypeBox** schemas derived from the shared zod
   descriptors; handlers route through the **outbox** exactly like the MCP surface — zero
   direct peer `.signal()`.
2. **Interactive cue injection** — cues queued on the session workflow are injected into the
   *live* Pi session with D10 semantics (operator `steer` / peer `followUp`, `triggerTurn`).
3. **Event-driven attachment phase** — driven from real Pi lifecycle events, replacing the
   #249 heartbeat-inference machinery (for Pi players).
4. **Survives Pi's instance rebuild** — a module-scope `Map<workflowId, PiPlayerRuntime>` keeps
   the attachment / lease / heartbeat alive across the per-switch teardown (rebind, not
   re-claim).
5. **MD-A liveness** (90s lease / 30s heartbeat), **D11 identity** (fixed workflowId per
   process; mutable `sessionId` resume pointer), and **Option-C teardown** (detach only on a
   clean `quit`; lease reaper backstop).

## Architecture & boundaries

- **Client-side only.** Everything here runs in the Pi agent process and holds a Temporal
  `WorkflowClient`. The durable `Worker` stays in the daemon (D4 = (a)). **Nothing in
  `src/pi/` is imported into the V8 workflow sandbox** — the determinism boundary is intact.
  (`src/workflows/**` must never import `src/pi/**`.)
- **Reuses the existing wire surface verbatim** — `claimAttachment` / `heartbeat` /
  `processingStart` / `processingEnd` / `requestDetach` + `adapterExited` / `submitOutbox` /
  `pendingMessages` + `markDelivered`. No new signals/queries/updates were added.

## File map

| File | Role | Pure / testable? |
|---|---|---|
| `phase-driver.ts` | Pi event → phase + workflow-action state machine | **Pure** — unit-tested, no Temporal/Pi |
| `render-tools.ts` | `renderToPi` — registers the shared tool descriptors on Pi (TypeBox params via the converter) + `toPiResult` | Covered by the MCP↔Pi parity test |
| `zod-to-typebox.ts` | zod→TypeBox tool-schema converter (fail-loud on unsupported constructs; Phase 1 / D1) | **Pure** — unit-tested |
| `lazy-proxy.ts` | D11 lazy `Client` / `WorkflowHandle` proxy — resolves the live target per call | **Pure** — unit-tested |
| `workflow-client.ts` | Thin client-side Temporal wrapper (lease, heartbeat, lifecycle, outbox, cue intake) | Compile-checked (needs Temporal at runtime) |
| `cue-pump.ts` | Polls `pendingMessages`, injects via `sendCustomMessage`, acks via `markDelivered` | Compile-checked |
| `extension.ts` | `export default function(pi)` — registers the FULL tool surface via `renderToPi(buildAllTempoTools(...))` over lazy proxies; wires events → driver → client | Compile-checked |
| `probe.ts` | Optional-dep preflight for the Pi packages (sdk-probe pattern) | Compile-checked |
| `pi-types.ts` | Hand-written structural decls of Pi's `ExtensionAPI` surface | — (see limitation below) |

> **Phase 2 note:** the Phase 0 hand-wired `report-tool.ts` (a single bespoke tool
> with a hand-built TypeBox schema) was **retired** — the report tool now flows
> through the shared descriptor → `renderToPi` → converter path like every other
> tool, eliminating the parallel-schema drift surface.

## Pi event → attachment phase mapping (architect's spec)

| Pi event | Workflow action | Resulting phase |
|---|---|---|
| `session_start` | `claimAttachment` | `attached` |
| `agent_start` | `processingStart` | `processing` |
| `agent_end` | `processingEnd` | `awaiting` **(not `detached`)** |
| `session_shutdown` | `requestDetach` → `adapterExited` | `draining` → `detached` |
| `turn_start` / `turn_end` | — (activity stamp only) | **unchanged** |
| `tool_execution_start` / `_end` | — (activity stamp only) | **unchanged** |

> **CRITICAL invariant (unit-enforced):** `turn_*` and `tool_execution_*` fire *many* times
> within a single agent run. If they drove the phase, the session would oscillate
> `processing`↔`awaiting` repeatedly mid-run. They are **activity signals only** — they
> bump a last-activity timestamp and never touch the phase. See
> `test/pi-phase-driver.test.ts`.

---

## 🔑 Finding 1 — Abrupt-death detection depends ENTIRELY on the heartbeat (feeds MD-A)

**Question (acceptance criterion 5):** if the Pi process is killed *without* a
`session_shutdown` event, does the workflow detect the dead attachment?

**Mechanism.** Graceful exit (`session_shutdown`) sends `requestDetach` + `adapterExited`,
collapsing the phase to `detached` immediately. An **abrupt** death (SIGKILL, crash, power
loss) fires no event, so **no `adapterExited` is sent**. The only remaining signal is the
**attachment lease**: `claimAttachment` returns a lease with `expiresAt = now + leaseMs`,
and the extension's heartbeat loop (`heartbeatSignal`, every `leaseMs/2`) renews it. When
the process dies, the heartbeat stops, the lease lapses, and the workflow's main-loop
deadline race reaps the attachment.

**Result / learning:**

- **With the heartbeat (as implemented):** an abrupt death IS detected — after **≤ `leaseMs`**
  (Phase 2 / MD-A: 90s lease, 30s heartbeat, lease = 3×heartbeat; detection latency ≈ one lease
  window). The phase transitions out of `attached`/`awaiting` once the lease expires.
- **Without a heartbeat:** there would be **no detection at all** — the workflow cannot
  distinguish a dead Pi process from an idle-but-alive one. The lease would never lapse
  (nothing renews *or* expires it on a fixed deadline absent the heartbeat contract).

**⇒ This directly validates MD-A: a liveness heartbeat is still required even in the
event-driven Pi model.** Pi's lifecycle events give us *graceful* transitions for free, but
they cannot cover the *ungraceful* case — the heartbeat/lease is what makes abrupt death
observable. The event model reduces, but does not eliminate, the need for the #249 liveness
machinery.

> Verification note: confirmed by construction + the existing lease semantics in
> `src/workflows/session.ts` (lease `expiresAt` vs `workflow.now()` deadline race). A live
> end-to-end `kill -9` run against a real `pi` session is the recommended Phase 2 follow-up
> to measure exact wall-clock detection latency.

## 🔑 Finding 2 — D12a: one `WorkflowClient` safely serves N in-process sessions

A single `Client` (built from one pooled `Connection`) can back more than one in-process
`AgentSession` loop. The Temporal `Client` is **connection-pooled and stateless per call** —
all per-session state lives on the **`WorkflowHandle`**, which is keyed by `workflowId`
(`agent-session-{ensemble}-{playerId}`). `PiWorkflowClient.connect()` returns a `Client`
that callers may share; each attached session constructs its own `PiWorkflowClient` (handle
+ lease + heartbeat timer) over it.

- **Implication:** the headless Pi runtime (Phase 3) can host several `createAgentSession`
  loops in one OS process sharing a single connection — no connection-per-session overhead.
- **Phase 2 status:** the singleton container exists and is keyed by `workflowId`
  (`Map<workflowId, PiPlayerRuntime>`), so the shape is ready for N players. Interactive Pi
  populates exactly one entry per process; the multi-loop host that fills the map with N
  concurrent `createAgentSession` loops is Phase 3 (headless).

---

## Phase 2 — interactive runtime

- **Full native tool surface.** `extension.ts` registers EVERY agent-tempo tool on
  Pi via `renderToPi(buildAllTempoTools(...))` over D11 lazy proxies — `set_name`,
  `set_part`, `who_am_i`, `cue`, `recruit`, … all work natively. The Phase 0
  hand-wired `report-tool.ts` is retired.
- **Module-scope singleton (survives instance rebuild).** Pi rebuilds the extension
  INSTANCE on every SessionManager switch (`session_shutdown` → `session_start`).
  The Temporal `Client`, fixed `workflowId`, pinned handle, heartbeat timer, cue
  pump, and current-session pointer live in a module-scope `Map<workflowId,
  PiPlayerRuntime>` (one entry interactive; N for Phase 3 headless — D12a). A
  rebuild RE-BINDS to the surviving runtime — **no re-claim, no duplicate
  heartbeat, unbroken lease** (test: `pi-extension-rebuild.test.ts`).
- **Identity.** ONE `pi` process = ONE fixed workflowId; `set_name` updates the
  display id only; `metadata.sessionId` is the mutable resume pointer (refreshed at
  attach + per turn, event-independent).
- **MD-A liveness.** 30s heartbeat / 90s lease (3× invariant; `pi-liveness.test.ts`).
- **Teardown (Option C).** `session_shutdown` detaches ONLY on `reason === 'quit'`
  (best-effort — Pi may not await the handler); switch/unknown reasons → no detach.
  The lease reaper is the permanent floor for SIGKILL/crash/un-landed-quit.

## Phase 3a — headless runtime

A recruited `agent: 'pi'` player runs **headless** (no terminal, no human): the
daemon spawns `dist/adapters/pi/adapter.js`, which calls Pi's `createAgentSession`
with the agent-tempo extension injected inline (`createPiExtension({ mode:
'headless', toolAccess })`). The same module-scope singleton owns the lifecycle.

- **Files:** `headless.ts` (runHeadlessPi: probe → resolve model → createAgentSession
  + `resourceLoader.reload()` + `bindExtensions()` → `setRuntimeSession` →
  keepAlive → reliable detach), `src/adapters/pi/adapter.ts` (env→options entry),
  `src/adapters/pi/index.ts` (registry/identity descriptor — no BaseAttachment).
- **MD-C tool gate** (headless only): `toolAccess` `restricted` (default; bash
  hard-blocked) | `standard` | `full`. Recruit knob → `AGENT_TEMPO_TOOL_ACCESS` →
  the extension's `tool_call` gate (tool-class check first).
- **MD-C deny-list soundness (S2).** The `restricted` gate is a DENY-LIST over
  shell/exec tool *names*, so it is sound only if no third-party extension can
  register an un-blacklisted exec tool. Verified against Pi SDK 0.78 source:
  `DefaultResourceLoader.reload()` loads DISK/package extensions
  (`~/.pi/agent/extensions/`, `<cwd>/.pi/extensions/`) by default
  (`noExtensions` defaults to `false`, `resource-loader.js:132`/`271-276`). The
  headless loader therefore passes **`noExtensions: true`** (and NO
  `additionalExtensionPaths`) via `buildPiResourceLoaderOptions` — disk/package
  extensions are hard-excluded while our inline factory still loads (factories
  are not gated by `noExtensions`). Locked by `test/pi-headless-loader.test.ts`.
  *(security, 3a review.)*
- **Model:** `provider/model` recruit arg → pi-ai `getModel(provider, name)` →
  Pi `Model` object (NOT a string). Copilot via `probeCopilotPiPreflight`.

> **✅ Live-smoke validated (Pi SDK 0.78 + Temporal).** Recruit-equivalent →
> attach (claim + 90s lease) → cue → **report** confirmed end-to-end. Five SDK-shape
> integration fixes were found ONLY by the live run (unit tests model the API, not
> the real one): `agentDir`, ref'd keepAlive (event-loop drain), explicit
> `resourceLoader.reload()` (inline extensions load only in reload), `setRuntimeSession`
> (headless `session_start` carries no `session`), and `sendCustomMessage` (Pi's real
> cue-injection method). See `docs/pi-3a-loop-smoke.md` for the runnable smoke.

## Known limitations (carry forward)

1. **`pi-types.ts` is hand-written → API-drift risk.** These structural decls mirror Pi's
   `ExtensionAPI` (spike commit `564ad70`, packages `0.78.0`) but are NOT the real types, so
   a change in Pi's API won't be caught at compile time. They exist to keep the build green
   **without** Pi installed (Pi is Node-22.19+ optional). A later phase should import the real
   Pi types at type-check time (Pi as a true optional/peer dep) for compile-time drift
   detection. The hand-written decls are a temporary stand-in, not the end state.
2. ~~Enum uses TypeBox union-of-literals, not pi-ai's `StringEnum`.~~ **Resolved (Phase 2):**
   the bespoke `report-tool.ts` schema was retired; the report tool's params now flow zod →
   TypeBox via the shared converter (`zod-to-typebox.ts`) like every other tool. No
   parallel/hand-built schema remains. (The converter emits union-of-literals for enums; a
   future swap to pi-ai's `StringEnum` is purely cosmetic.)
3. **Pi `AgentToolResult` shape (`toPiResult`).** `renderToPi` maps the neutral
   `{ text, isError }` to `{ output, isError }` — sufficient for non-streaming tools. The exact
   streaming/`onUpdate` shape (spike gap D12b) still wants confirmation against a live `pi`.
4. ~~No live `pi` run performed.~~ **Done (3a):** the headless loop (attach → cue → report) is
   live-smoke-validated against Pi SDK 0.78 + Temporal; five SDK-shape integration fixes came out
   of it (see the Phase 3a section). Unit tests still use a structural `ExtensionAPI` fake — they
   model the API, so the live run remains the only check for real SDK-shape drift (e.g. it caught
   `sendCustomMessage` vs our `sendMessage`).

### Carry-items (tracked for later phases)

- **Restart `--continue` read side.** The extension WRITES `metadata.sessionId` (resume
  pointer) and accepts an optional `expectedAttachmentId` handoff (`AGENT_TEMPO_ATTACHMENT_ID`).
  The CONSUMPTION — a Pi-aware spawn building `pi --continue <sessionId>` + passing the
  handoff token on restart — is a daemon/restart-tool concern (Phase 3 / restart follow-up).
- ~~Headless reliable detach.~~ **Done (3a):** `detachAllPiRuntimesForExit()` awaits
  `adapterExited` then the headless entry disposes (signal-then-dispose). NOTE: the graceful
  SIGTERM path is **POSIX-only** — on Windows `TerminateProcess` is a hard kill and the SIGTERM
  handler can't fire, so detach falls to the MD-A 90s lease reaper (working as designed). Validate
  the graceful SIGTERM detach on Linux/macOS CI. *(devops, 3a live smoke.)*
- **Pi-SDK compaction crash on stale session state (Phase-3 hardening).** Pi's `_checkCompaction`
  throws `content is not iterable` when `~/.pi/agent/sessions/` holds partial custom-message state
  from prior runs — Pi-SDK-internal (fires inside the turn loop; can't be caught from the
  extension), AFTER the turn completes. Proper fix: a FRESH session per headless run — use
  `SessionManager.inMemory()` for ephemeral headless players (no on-disk state), reserving
  persistent sessions for the restart-resume path. Smoke workaround: clean `~/.pi/agent/sessions/`
  before re-running on the same ensemble name. *(devops, 3a live smoke.)*
- **Restart `--continue` read side.** (unchanged — daemon/restart-tool consumes `metadata.sessionId`
  → `pi --continue` / `SessionManager.continueRecent`; pairs with the in-memory-session decision above.)
- **Pi switch event / `reason` discriminators.** Adopted `session_start`/`session_shutdown`
  `{reason}` per researcher confirmation; pin a Pi version floor (≥ #2860, #5080, #5115) as a
  D6 "behaviors-to-revalidate-on-bump" item.
- **D6 revalidate-on-bump — `bindExtensions` await ordering (`setRuntimeSession`).** The
  headless boot (`headless.ts`) calls `setRuntimeSession(...)` only AFTER
  `await session.bindExtensions({})` resolves, RELYING ON `bindExtensions` awaiting the async
  `session_start` handlers (which run the claim + map the module-scope runtime) before it
  returns. If a Pi bump makes `bindExtensions` resolve BEFORE those handlers finish, the
  runtime won't be mapped yet, `setRuntimeSession` finds nothing to set the session on, and the
  cue pump never acquires a live session → cues SILENTLY drop. Re-verify this await ordering on
  every Pi bump (add to the D6 revalidate set). *(QA, 3a review.)*
- **Phase-2 interactive cue-injection — implicit live smoke.** There is no standalone unit test
  for the interactive (`extension.ts` default) cue-injection path; the first real interactive Pi
  session that takes a cue exercises it live (and fix #5 — `sendCustomMessage` — is what makes
  that path actually deliver). Treat the first interactive session per Pi bump as the smoke for
  this path until a dedicated harness exists. *(QA, 3a review.)*

## Dependencies (⚠️ flagged for human review — not pre-approved)

Added to `package.json`:

- `typebox` `^1` → **regular dependency.** Pure, zero Node-engine floor; backs the
  zod→TypeBox converter that derives every Pi tool's params.
- `@earendil-works/pi-coding-agent` `~0.78` and `@earendil-works/pi-ai` `~0.78` →
  **optionalDependencies** (declarative; gated behind the `probeSdkInstall` pattern).

> **Open maintainer decision (D6):** Pi requires **Node ≥ 22.19**, but agent-tempo's
> `engines` is `>=20`. This integration deliberately does **not** bump `engines` (that would force
> Node 22 on all consumers, including non-Pi users). Whether/how to reconcile the Node floor
> — peer-dep range, preflight hard-fail vs warn — is left for the maintainer.

## Running the tests

```bash
npm run build       # produces dist/ + workflow-bundle.js (required by the Temporal test env)
npm test            # mocha + vitest

# Just the Pi unit tests (no Temporal/Pi needed):
npx mocha --no-config dist-test/test/pi-*.test.js
```

### Manual verification (live `pi` — Phase 2/3, NOT a unit test)

- **D10 cue semantics (mid-turn):** (a) a PEER cue (`isMaestro=false`) delivered while a turn
  is in flight QUEUES and does NOT preempt the running turn (drains at idle); (b) an OPERATOR
  cue (`isMaestro=true`) mid-turn lands same-turn priority (after the current tool batch,
  before the next LLM call) — NOT a hard tool abort.
- **Rebuild survival:** trigger a Pi session switch (newSession/fork) and confirm the player
  stays attached in `ensemble` (no detach/re-attach flap), one continuous heartbeat.
- **Clean quit vs abrupt kill:** `quit` detaches promptly; `kill -9` detaches within the lease
  window (≤90s) via the reaper.
