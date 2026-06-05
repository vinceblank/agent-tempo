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
3. Run each item below against the installed Pi. Source references are to Pi's installed files
   under `node_modules/@earendil-works/pi-coding-agent/`.

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

  - **Source:** `AgentToolResult` definition in `types.d.ts:327` + `agent-loop.js` catch →
    `createErrorToolResult` + `isError: true`
  - **Why the gate misses it:** a structurally-different return type was masked by the old
    shim's lying `PiToolResult` declaration.

---

- [ ] **3. Interactive `session_start` payload — undeclared `session` field** (Finding-2, B1 guard)

  Interactive `session_start` STILL carries `session` at runtime — this field is **not declared
  in Pi's `.d.ts`**. The B1 guard (`extension.ts` `warnIfInteractiveSessionMissing`) warns on
  regression.

  - **Verification:** run an interactive Pi session, inject a cue, confirm no
    `"carried no session"` warning appears.
  - **Why the gate misses it:** undeclared runtime field — not type-assertable.

---

- [ ] **4. Headless bootstrap ordering** (README D6, `src/pi/headless.ts`)

  `createAgentSession` → `resourceLoader.reload()` → `bindExtensions({})` →
  `setRuntimeSession` still wires the session correctly. (Headless `session_start` carries
  NO `session`; `setRuntimeSession` is the out-of-band wire.)

  - **Source:** `src/pi/headless.ts` bootstrap sequence
  - **Why the gate misses it:** runtime sequencing contract — not expressible in types.

---

- [ ] **5. Cue-pump injection invariants** (D10, `src/pi/cue-pump.ts:121–134`)

  `followUp` is non-interrupting; `triggerTurn` wakes a cold-idle session and is a
  no-op while busy.

  - **Verification:** run a mid-turn cue smoke — confirm peer cues are not preempted and
    idle cues are not dropped.
  - **Why the gate misses it:** a regression silently turns peer cues into preemptions or
    drops idle cues — behavioral, not typed.

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

- [ ] **8. MD-C tool-gate / `noExtensions` security invariant** (S2, `src/pi/headless.ts`)

  `noExtensions: true` still hard-excludes disk/package extensions. Re-check
  `buildPiResourceLoaderOptions` and `resource-loader.js` `reload()` merge behavior to
  confirm no extension-loading path reopened.

  - **Why the gate misses it:** security invariant (`restricted` = no host exec) — behavioral,
    not typed.

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

## After the checklist

Always run `npm run lint:pi-drift` (the type-gate) alongside this checklist on a bump. Both
must pass before the version bump lands.

If any item reveals a new contract change:
- Fix the adapter shim first.
- Add or update the relevant regression test.
- Note the finding in the Pi version bump PR body.

---

*Refs: [docs/design/pi-hardening-h1-h2-h3.md](design/pi-hardening-h1-h2-h3.md#h4--pi-sdk-type-gate) — H4 lesson (type drift-gate necessary but not sufficient) + full bug chains for items 1 and 2.*
