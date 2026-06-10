# Pi Version Bump Checklist

> **Scope:** `@earendil-works/pi-coding-agent` and `@earendil-works/pi-ai` version bumps.
>
> The **pi-drift type-gate** (`test/pi-drift/`, H4 — run via `npm run lint:pi-drift`, active
> in `check:all` on Node ≥ 22.19 with Pi installed) catches **TYPE drift automatically in CI**.
> This checklist covers the **runtime/semantic drift the gate cannot catch** — re-verify each
> item on every `@earendil-works/pi-coding-agent` (+ `pi-ai`) version bump.
>
> **Gate (automated, type) + checklist (manual, runtime) = full Pi drift coverage.**

---

## Before you start

1. Run `npm run lint:pi-drift` — the type-gate must pass first. Runtime checks on a type-broken
   shim produce misleading results.
2. Pin the new Pi package version in a throwaway branch and install it (`npm install`).
3. Run each item below against the installed Pi. Source references are under
   `node_modules/@earendil-works/pi-coding-agent/` and
   `node_modules/@earendil-works/pi-agent-core/` (the runtime loop + `AgentToolResult`
   are in `pi-agent-core`).

---

## Checklist

- [ ] **1. Tool execute INPUT — positional contract** (#651, fixed v1.4.1)

  Pi still calls a registered tool's `execute` **positionally**:
  `execute(toolCallId, params, signal, onUpdate, ctx)` — `params` is the 2nd argument.

  - **Source:** `core/tools/tool-definition-wrapper.js:10,31` + `agent-loop.js:419`
  - **Our side locked by:** `test/pi-render-tools.test.ts` positional regression test —
    re-confirm Pi's call sites still match.
  - **Why the gate misses it:** a 1-arg function is assignable to the real 5-arg signature
    (fewer-params-assignable; type-masked).

---

- [ ] **2. Tool execute OUTPUT + error convention** (#653, fixed v1.4.2)

  `AgentToolResult` still has shape `{ content: (TextContent | ImageContent)[]; details; terminate? }`,
  AND Pi requires tool errors to be signaled by **throwing** from `execute` — not a return
  field, not content-encoding. Pi doc: *"Throw on failure instead of encoding errors in content"*.

  - **Source:** `AgentToolResult` def (`pi-agent-core types.d.ts:305`) + throw-doc on
    `execute` (`types.d.ts:327`) + `agent-loop.js` catch → `createErrorToolResult` +
    `isError: true`
  - **Why the gate misses it:** a structurally-different return type was masked by the old
    shim's lying `PiToolResult` declaration.

---

- [ ] **3. Interactive `session_start` payload — NO `session` field as of 0.78.1** (#677, B1 guard)

  **As of Pi 0.78.1, `SessionStartEvent` carries NO `session` field** (it was undeclared in the
  `.d.ts` and is now absent at runtime too). This broke interactive cue/reset injection, fixed in
  **#677**: injection NO LONGER reads `payload.session` — it routes through the stable
  **`pi.sendMessage` / `pi.sendUserMessage`** ExtensionAPI handle, re-resolved per tick from the
  surviving runtime (`rt.pi`). **DO NOT reintroduce a `payload.session` dependency** in the cue
  pump, reset pump, or any interactive path — the handle is the contract, not the event payload.

  - **Boot breadcrumb:** `extension.ts` `noteInteractiveSessionAbsent` emits a **one-time INFO**
    line on the first interactive `session_start` with no session — *"interactive session_start
    has no `session` field — expected on Pi ≥0.78.1; cues/reset route via pi.sendMessage."* This
    is **expected and benign** (NOT a warning, NOT "inert", NOT "drift") — it confirms you're on
    the normal 0.78.1 path. It fires once per process (not per switch/tick). (#677 reworded the
    former B1 WARNING, which had become misleading post-fix, down to this breadcrumb.)
  - **Verification:** run an interactive Pi conductor, `cue` it from a peer, and confirm the cue
    LANDS (via `pi.sendMessage`) and — if no turn starts — escalates via `pi.sendUserMessage`.
    The one-time breadcrumb is informational; the cue landing is what proves the path.
  - **If a future Pi RE-ADDS `session` to `SessionStartEvent`:** still don't depend on it —
    `rt.pi` is the stable handle across instance rebuilds (a captured `session`/`pi` goes stale
    on a session switch; per-tick re-resolution from `rt.pi` is the invariant).
  - **Why the gate misses it:** undeclared/removed runtime field — not type-assertable.

---

- [ ] **4. Headless bootstrap ordering** (README D6, `src/pi/headless.ts`)

  `createAgentSession` → `resourceLoader.reload()` → `bindExtensions({})` →
  `setRuntimeSession` still wires the session correctly. (Headless `session_start` carries
  NO `session`; `setRuntimeSession` is the out-of-band wire.)

  - **Source:** `src/pi/headless.ts` bootstrap sequence
  - **Why the gate misses it:** runtime sequencing contract — not expressible in types.

---

- [ ] **5. Cue-pump injection invariants** (D10 + #677 escalation, `src/pi/cue-pump.ts` `injectCue`)

  `followUp` is non-interrupting; `triggerTurn` wakes a cold-idle session and is a
  no-op while busy. **#677 adds a belt-and-suspenders escalation:** a cue injected via
  `pi.sendMessage` that is NOT followed by a `turn_start` by the next tick is re-injected ONCE
  via `pi.sendUserMessage` (a user message always starts a turn). This relies on
  `pi.sendUserMessage` keeping its "always triggers a turn" semantic and `turn_start`/`agent_start`
  still firing (they stamp `rt.lastTurnStartAt`).

  - **Verification:** run a mid-turn cue smoke — confirm peer cues are not preempted and
    idle cues are not dropped; then cue a COLD-IDLE interactive conductor and confirm it wakes
    (via the `sendMessage` `triggerTurn`, or the `sendUserMessage` escalation if that misses).
  - **Why the gate misses it:** a regression silently turns peer cues into preemptions, drops
    idle cues, or breaks the escalation wake — behavioral, not typed.

---

- [ ] **6. In-memory seed-replay round-trip** (H1/H2)

  `SessionManager.inMemory()` + `appendMessage` + `createAgentSession({ sessionManager })`
  still round-trips seeded messages into `agent.state.messages` correctly (correct order,
  roles, text, key-free, no throw).

  - **Why the gate misses it:** the always-in-memory policy (H1) and restart-resume (H2)
    both depend on this runtime behavior.

---

- [ ] **7. `_checkCompaction` content-shape contract** (H1 sanitizer, `src/pi/session-seed.ts`)

  The sanitizer predicate (`content ∈ { string | array }`) still matches Pi's consumption
  crash sites at `agent-session.js:2486/2493`. If Pi changes the content contract, update
  `sanitizeTranscriptEntry` and the 6-shape regression fixture.

  - **Shapes:** `string` → KEEP, `Array` → KEEP, `null` → DROP, `undefined` → DROP,
    `{}` → DROP, `42` → DROP
  - **Why the gate misses it:** runtime crash vector — the throw is at consumption, not
    at append time.

---

- [ ] **8. `noExtensions` supply-chain invariant** (S2, `src/pi/headless.ts`)

  `noExtensions: true` still hard-excludes disk/package extensions. Re-check
  `buildPiResourceLoaderOptions` and `resource-loader.js` `reload()` merge behavior to
  confirm no extension-loading path reopened.

  - **Why the gate misses it:** security invariant (recruited players load ONLY the inline
    agent-tempo extension) — behavioral, not typed.

---

- [ ] **9. `AgentToolResult` streaming / `onUpdate` callback** (D12b — unconfirmed gap)

  The `onUpdate` callback (`AgentToolUpdateCallback`) and streaming tool-result shape are
  **not currently modeled** by the adapter. Pin if/when streaming tools are added.

  - **Why the gate misses it:** known unmodeled surface — the gap exists by design until
    streaming tools are in scope.

---

- [ ] **10. Version-floor pins** (`src/pi/probe.ts`)

  Re-check `PI_VERSION_FLOOR` (currently `0.78.0`) and `PI_NODE_FLOOR` (currently `22.19.0`)
  against the new Pi package's `package.json#engines` and semver range. Update the constants
  if the new version raises either floor.

  - **Source:** `src/pi/probe.ts` constant declarations

---

- [ ] **11. Reset surface — asymmetric clean-wipe** (#677 PART B, the reset intake in `src/pi/cue-pump.ts`, `extension.ts`)

  Reset delivery is a **capability branch**, and the two halves depend on different Pi APIs:
  - **Headless** — `session.newSession()` (on the SDK session) still performs a clean-wipe
    (fresh context, no replay). The reset pump auto-wipes + acks.
  - **Interactive** — `newSession` is **`ExtensionCommandContext`-ONLY** (NOT on the SDK
    session), so the pump CANNOT auto-reset an interactive conductor. It registers a
    `pi.registerCommand('tempo-reset', { handler })` whose handler calls `ctx.newSession()`, and
    the pump's interactive branch NOTIFIES the operator (via `pi.sendMessage`) to run it
    (ACK-ON-NOTIFY, id-matched notify-once). **Auto-reset of an interactive conductor is
    impossible by design — operator-mediated is the ceiling.**

  - **Re-verify on bump:** `ExtensionCommandContext.newSession()` still exists with the
    `() => Promise<{ cancelled }>` shape (locked by the pi-drift `_recvCommandCtx` row);
    `registerCommand(name, { description, handler })` still exists; `session.newSession()` still
    clean-wipes headless. Run `/tempo-reset` in an interactive Pi and confirm a context wipe;
    `reset` an interactive conductor from a peer and confirm the operator notice appears once.
  - **Why the gate misses it:** the command-registration option shape stays loose (architect
    ruling) and the wipe/notice behaviors are runtime, not typed.

---

## After the checklist

Always run `npm run lint:pi-drift` (the type-gate) alongside this checklist on a bump. Both
must pass before the version bump lands.

If any item reveals a new contract change:
- Fix the adapter shim first.
- Add or update the relevant regression test.
- Note the finding in the Pi version bump PR body.

---

*Refs: [docs/design/pi-hardening-h1-h2-h3.md](design/pi-hardening-h1-h2-h3.md#h4--pi-sdk-type-gate) — H4 lesson (type drift-gate necessary but not sufficient) + full bug chains for items 1 and 2.*
