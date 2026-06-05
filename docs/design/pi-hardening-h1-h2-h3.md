# Phase 3 Pi Hardening — H1 / H2 / H3

> **Status**: DESIGN RULED + runtime-verified (PoC green, Pi 0.78.0). Implementation pending v1.4.0 ship + explicit go.
> **Author**: tempo-architect
> **Tracking**: #645 (Pi adapter epic #632; see also mission-control 3f #627)
> **Audience**: implementing engineer (tempo-eng pickup), tempo-qa for regression-test fixtures, tempo-devops for Node-floor CI gate.

---

## Overview

Headless Pi players (`agent: 'pi'`) accumulate on-disk session state; a stale or partial entry with malformed `content` causes Pi's `_checkCompaction`-driven scan to throw `"content is not iterable"` (crash at `agent-session.js:2486/2493`). Separately, restart-resume for Pi was an unfilled TODO (`headless.ts` lines 205–208), and the mission-control 3f fine-tail is daemon-local (silent on cross-host players).

This design addresses all three gaps:

| Item | Description |
|---|---|
| **H1** | In-memory headless sessions — eliminates the crash vector and prepares the seeding path |
| **H2** | Restart-resume read side — seeds a fresh in-memory session from agent-tempo durable state |
| **H3(a)** | Cross-host /inner tail — surfacing tailability in the mission-control board |

**Zero workflow / wire / determinism impact** across all three items.

---

## Policy (RULED)

Pi headless players run **always in-memory** (`SessionManager.inMemory`). "Resume" means agent-tempo replays its own durable state (saveable-state #334 + restart seed) into a fresh in-memory session via `appendMessage`. No dual-mode, no Pi-disk persistence, no Pi-native `sessionId` resume.

agent-tempo state is the **single source of resume truth** — Pi uses the same resume model as every other adapter.

**Out of scope (ratified with eyes open):** full-fidelity verbatim Pi-conversation-transcript resume. That would require extension→workflow transcript streaming (wire/determinism touch + history-size concerns). Resume fidelity this pass = whatever agent-tempo already persists. If verbatim continuation is wanted later → separate durable-transcript epic.

---

## H1 — In-memory headless sessions

### Problem

`createAgentSession` currently defaults to a disk-backed `SessionManager.create()` (sdk.js:98). On startup it loads `~/.pi/agent/sessions/<cwd>/*.jsonl`; a stale or partial entry with malformed `content` throws at agent-session.js:2486/2493.

### Fix

In `src/pi/headless.ts`, after `esmImport(PI_PACKAGE)`:

```ts
const sessionManager = SessionManager.inMemory(process.cwd());
createAgentSession({ cwd, agentDir, model?, resourceLoader, sessionManager });
```

`sessionManager` and `resourceLoader` are independent options — no conflict with the existing `noExtensions`/`reload()` path.

### New module: `src/pi/session-seed.ts`

A pure, testable module (no SDK import required) that ships as part of H1 so the gate exists before any replay path:

- `sanitizeTranscriptEntry(entry)` — validates a single transcript entry shape
- `seedSessionManager(sm, transcript)` — the **single chokepoint** for all `sm.appendMessage(...)` calls; `headless.ts` never appends directly

### Sanitizer (load-bearing)

**Placement rationale (PoC-verified):** `appendMessage` never validates — every malformed shape appends "ok"; the throw is purely at consumption (`getLastAssistantText` / context build / compaction). Seed-time sanitization is the **only lever agent-tempo controls**; a consumption-site guard would be Pi-internal. Placement is correct by necessity, not convenience.

**Predicate (confirmed against Pi 0.78.0):**

```ts
isWellShapedContent = (c) => typeof c === 'string' || Array.isArray(c)
```

**Policy — DROP (default):** any entry whose `content` is not string|array, or whose `role`/`type` is not an `appendMessage`-accepted shape (`Message | CustomMessage | BashExecutionMessage`).

Coerce-to-`[]` is a documented one-line escape hatch if turn-pairing sensitivity ever surfaces (both verified crash-safe). DROP is preferred: a malformed entry has no recoverable content; role-alternation is not a Pi hard-requirement.

**Guarantee:** no entry with non-iterable/malformed content can reach the Pi session — replay crash-proof by construction. Closes the Q2 crash vector that in-memory alone leaves open on the replay path.

**Shape matrix (6-fixture regression set — QA owns):**

| Input | Action |
|---|---|
| `content: "string"` | KEEP |
| `content: [...]` | KEEP |
| `content: null` | DROP |
| `content: undefined` | DROP |
| `content: {}` | DROP |
| `content: 42` | DROP |

These 6 cases are a permanent regression fixture, comment-linked to the Pi 0.78 crash sites (`agent-session.js:2486/2493`) so a future Pi SDK bump trips the test instead of silently drifting.

**Determinism / wire impact:** none (client-side only).

---

## H2 — Restart-resume read side

### Approach

On restart-with-resume, seed the fresh in-memory `SessionManager` from agent-tempo durable state via `seedSessionManager()` **before** `createAgentSession`. This is a true continuation — prior context becomes `agent.state.messages`, not just an opening cue.

### Resume source (RULED — option ii)

`ENV.PI_CONTINUE_SESSION` carries a **saveable-state key**. The headless process reads the content back via the existing `fetch_state` path at boot.

- Tiny reference in the env, durable content in the workflow state
- No large env/file payload
- No new wire surface (reuses `fetch_state` / saveable-state #334)

### Plumbing

Already exists end-to-end:

```
spawnPiHeadless(continueSessionId)
  → ENV.PI_CONTINUE_SESSION
  → adapter.ts
  → runHeadlessPi
  → headless.ts lines 205–208  ← this TODO is what H2 fills
```

### `metadata.sessionId` — keep and demote

**Keep** the write (`updateSessionId` / `updateMetadataSignal` — existing signal, zero wire change).

**Demote** the meaning: re-document as "last Pi in-process session id — **audit/log-correlation ONLY**, NOT a resume pointer." Per PoC finding #5, an in-memory `sessionId` is not resumable after `dispose`. Removing the write is pure churn that loses an audit breadcrumb.

**Determinism / wire impact:** none (reuses existing `fetch_state` surface).

---

## H3 — Cross-host /inner tail (mission-control 3f follow-up)

### H3(a) — In scope

- `PlayerRow` gains `hostname` (stop dropping `PlayerSummaryV1.hostname` in `rowFromSummary`, `board.ts`)
- Pure `tailability(model, playerId, localHost)` helper
- `cmdTail` refuses cross-host tails with a clear operator message (`extension.ts`)
- `localHost = os.hostname()` now; `HealthV1.hostname` is the documented future upgrade — NOT built here (robust if `baseUrl` ever points at a remote daemon; additive REST field, not a new SSE event kind)

Zero wire/determinism impact.

### H3(b) — Deferred

Actual cross-host routing requires a remote-daemon HTTP mesh: routable bind + TLS + a **new additive `HostProfile` address field** on the `hostProfile` signal (the lone wire touch) + a cross-daemon auth story (admin tokens are per-daemon/env-only). `baseUrl` stays the documented seam.

---

## Node-floor (Decision B — ratified by user)

Enforce Node ≥ 22.19 **only** at the Pi recruit/spawn boundary: preflight hard-fail with a clean error message — mirrors the `probeSdkInstall`/`resolveModel` fail-clean pattern.

**Do NOT raise** `package.json#engines` (stays `>=20`). The floor belongs to the optional Pi adapter, not the whole package; non-Pi users are untouched.

Implemented as part of H1/spawn.

---

## Dependencies (approved by user)

| Package | Type | Purpose |
|---|---|---|
| `typebox` `^1` | regular dependency | zod→TypeBox converter backing every Pi tool's params schema |
| `@earendil-works/pi-coding-agent` `~0.78` | optionalDependency | Pi extension SDK |
| `@earendil-works/pi-ai` `~0.78` | optionalDependency | Pi AI runtime (gated behind `probeSdkInstall`) |

---

## Sequencing

```
H1 (inMemory + session-seed.ts WITH sanitizer + Node-floor-B preflight at spawn boundary)
  → H2 (resume-source via fetch_state key + appendMessage seed)
  → H3(a) parallel (independent files: mission-control/* vs pi/headless.ts)
```

---

## PoC evidence (Pi 0.78.0, hermetic throwaway spike — researcher)

| Check | Result |
|---|---|
| Q4 runtime round-trip: `inMemory` → `appendMessage(user+assistant)` → `createAgentSession({sessionManager})` → `session.messages` | ✅ Both seeded turns returned, correct order/roles/text, key-free, no throw |
| Crash repro: `content=null` | ✅ `"content is not iterable"` at `agent-session.js:2493` |
| Sanitizer prevents crash | ✅ Full shape matrix confirmed; predicate verified, no refinement needed |

---

## Carry-items for implementation

- **6-shape fixture set** (string/array KEEP; null/undefined/object/number DROP) → permanent regression test owned by QA/eng, comment-linked to Pi 0.78 crash sites (`agent-session.js:2486/2493`) so a future Pi bump trips the test instead of silently drifting (researcher offer)
- **Node-floor-B preflight check** at the spawn boundary
- **`metadata.sessionId` keep-and-demote comment** in `workflow-client.ts`

---

## H4 — Pi SDK type-gate

> **Status:** in-flight — gate PR pending the v1.4.1 render-tools fix merge (imminent).

### H4 lesson — a type drift-gate is necessary but not sufficient

A type-only drift gate has structural blind spots: TypeScript's "fewer-params-assignable-to-more" rule, open index signatures, and undeclared runtime fields all let **semantic** drift pass a type check green.

The H4 manual mapping (reading the real Pi 0.78 `.d.ts` + runtime call sites member-by-member) caught a **shipped v1.4.0 bug**: `render-tools.ts` registered each tool's `execute` as a 1-arg `(args) => handler(args)`, but Pi invokes `execute(toolCallId, params, …)` **positionally** (`tool-definition-wrapper.js` → `agent-loop.js:419`), so every native agent-tempo tool handler received the `toolCallId` string instead of its params. A 1-arg function is type-assignable to the real 5-arg signature, so a gate-only approach would have shipped GREEN over it (fixed in v1.4.1).

> **Bug chain:** `render-tools.ts:48` registered `execute: (args) => handler(args)` (1-arg). Pi invokes positionally: `agent-loop.js:419` `execute(toolCall.id, args, …)` → `tool-definition-wrapper.js:10` `definition.execute(toolCallId, params, …)`. So `args` bound to `toolCallId` (string), not params. TypeScript missed it: a 1-arg fn is assignable to the real 5-arg `execute(toolCallId, params, signal, onUpdate, ctx)`. Fixed in v1.4.1 (`(_toolCallId, params) => handler(params)` + a positional regression test).

The same mapping surfaced a gate-coverage gap — `PiEventPayload.session` models an interactive-only **runtime** field Pi's 0.78 `.d.ts` doesn't declare; it's not type-assertable, so it's covered by a runtime guard instead.

**Takeaway:** keep the type-gate (it catches structural renames/removals cheaply in CI on every Pi bump), but pair it with:

1. **Manual mapping** on each Pi version bump — semantic drift is caught here, not in the gate.
2. **Runtime guards** for the type-masked blind spots (undeclared fields, positional-arity mismatches).

The gate is the cheap regression net; the mapping is where semantic drift is actually caught.

---

## Deferred epics

- **H3(b)** — cross-host `/inner` routing (remote-daemon HTTP mesh; new `hostProfile` signal field; cross-daemon auth)
- **Verbatim Pi-transcript durable resume** — extension→workflow transcript streaming (wire/determinism touch; separate epic)
