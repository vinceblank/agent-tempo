# Phase 1 Design — Pi Streamlining, Operator-Gate Removal, Command-Center-as-Primary

> **Status:** APPROVED — Phase 3 build authorized by vinceblank (via conductor,
> 2026-06-10): D1 both permission layers removed; D2 ships in the 1.7.0 beta line;
> D3 phased TUI replacement; ResetPump→CuePump merge included (C7). Committed as the
> work branch's first commit (C0).
> **Author:** tempo-architect (my-tempo-architect), tempo-impl ensemble. 2026-06-09.
> **Supersedes:** `.tmp-cc-spec.md` **§6 (unified guardrail model) in its entirety** — the
> monitored/supervised/observe-only postures, `failMode`, the MD-G operator gate, AND the
> MD-C `toolAccess` axis are REMOVED per vinceblank's direction (both Pi permission
> layers; confirmed via conductor 2026-06-10). All other sections of that spec (planner
> Q&A via maestro, `respond` tool, SSE `answer` wake, install-by-reference, ensureInfra)
> remain valid and shipped.
> **Scope guard (hard):** *quality gates* (`src/tools/quality-gate.ts`, `evaluate-gate.ts`,
> `gates.ts`, the maestro `setQualityGate`/`evaluateGateCriteria`/`qualityGates` wire ops)
> are a SEPARATE feature and are NOT touched by anything in this document.

---

## Part (a) — Streamlining opportunities, ranked by value / risk

The Pi integration (`src/pi/` 26 files ≈ 5,600 lines + `src/adapters/pi/` + daemon-side
gate/inner-loop modules) has matured through phases 0–3f. The architecture is sound: the
pure `PhaseDriver`, the module-scope runtime singleton (D12a), lazy proxies (D11), the
zod→TypeBox single-source converter (D1), and the outbox-compliant `PiWorkflowClient` are
all load-bearing and should NOT be collapsed. The accidental complexity is concentrated in
the guardrail/gate axis.

| # | Opportunity | Value | Risk | Verdict |
|---|---|---|---|---|
| S1 | **Delete the MD-G operator gate** (Part b). ~2,000+ lines incl. daemon registry/routes/audit, Pi gate-client, mission-control gate UI, 4 test files, 5 docs sections. Removes the two-clients-per-headless-player pattern (`gateInner` + `gateClient`), the failMode threading, the per-arm state, the audit sink, and the T3 gate routes. | Very high | Low–medium (see b.4 breaking assessment) | **DO** — this IS the mandate |
| S2 | **Delete the MD-C `toolAccess` axis with it** (CONFIRMED — user decision, 2026-06-10, relayed by conductor: remove BOTH Pi permission layers). `toolAccess: restricted/standard/full` + `force:true` blocks Bash by default on headless Pi — itself "not all permissions, unlike other adapters". Removing it deletes `src/security/tool-capability.ts`, `computeExcludeTools` + `PI_BUILTIN_ACT_TOOLS` in `headless.ts`, the whole `tool_call` enforcement handler in `extension.ts`, the `TOOL_ACCESS` env + recruit arg + spawn threading. **tool-capability.ts orphan check (verified by grep):** its only `src/` consumers are `extension.ts` (gate/MD-C handler — removed) and `headless.ts` (`EXEC_TOOLS` in `computeExcludeTools` — removed); the `classification` field on `inner.gate_pending` frames is gate-only. No telemetry or mission-control display consumer exists → the module and `test/pi-tool-capability.test.ts` go too. | High | Low–medium — deletes a tempo-security-signed enforcement boundary, but per explicit user direction; `noExtensions:true` supply-chain guard stays | **DO — confirmed** |
| S3 | **Merge `ResetPump` into `CuePump`** (one generic 1 s poll loop, two intake checks per tick). Today every headless player runs two parallel 1 s `setInterval` pollers with identical re-entrancy/teardown scaffolding (~150 duplicated lines; 2 queries/s/player against Temporal either way — the win is code, not load). | Medium | Low — both are pure client-side; existing unit tests port directly | DO in Phase 2 if capacity, else backlog |
| S4 | `session-seed.ts` reserved chokepoint (no live caller passes a non-empty transcript). | Low | Low | **KEEP** — documented reserve for the deferred verbatim-transcript epic; deleting saves ~120 lines but reopens the H1 crash vector if seeding returns. Considered, rejected. |
| S5 | `inner-loop-client.ts` / `gate-client.ts` structural duplication (port discovery, token auth, fetch shim, poll cadence). | — | — | Resolved by S1 (gate-client deleted). Do NOT extract a shared HTTP-client base for one remaining consumer. |
| S6 | `extension.ts` (660 lines). After S1+S2 it loses the entire headless `tool_call` block, gate imports, and `guardrailPolicy` option (~140 lines) — lands ~520 lines with a single responsibility per section. | — | — | No further split warranted post-removal. |
| S7 | Double-layered presence rate-limiting (publisher `isPresent()` cache + client `maybeRefreshPresence()` cache, both 1 s). | Micro | Low | Leave — harmless belt-and-suspenders; collapsing risks regressing the fail-safe-0 semantics. |
| S8 | Dead-seam audit: `PiWorkflowClient.expectedAttachmentId` (restart/migrate adoption plumbing) and `noteInteractiveSessionAbsent` breadcrumb. | — | — | KEEP both — the former is the restart anti-flap path, the latter is a one-time boot diagnostic. Not dead. |

**Net:** the integration does not need re-architecture. It needs the guardrail axis
amputated; what remains is cohesive.

---

## Part (b) — Combined removal plan: operator gate (MD-G) + toolAccess (MD-C)

### b.1 What goes (file-by-file)

**DELETE outright (5 source + 5 test files):**

| File | Notes |
|---|---|
| `src/http/gate-registry.ts` | GateRegistry, `GATE_AUTO_ALLOW_MS`/`GATE_CLOSED_DENY_MS`, `GateFailMode`, `GateDecision`, audit publishing |
| `src/http/gate-routes.ts` | `POST /gate-arm`, `/gate-disarm`, `/gate/:requestId`; `GET /gate/:requestId/resolution` |
| `src/http/gate-audit.ts` | JSONL sink. Old `~/.agent-tempo/gate-audit/` dirs left on disk — harmless, no cleanup code needed |
| `src/pi/gate-client.ts` | subprocess poll-bridge |
| `src/security/tool-capability.ts` | orphaned after both removals (verified — see S2) |
| `test/pi-gate-client.test.ts`, `test/pi-tool-capability.test.ts`, `tests/http/gate-registry.test.ts`, `tests/http/gate-routes.test.ts`, `tests/http/gate-audit.test.ts` | |

**EDIT (gate/guardrail sections removed):**

| File | Edit |
|---|---|
| `src/pi/extension.ts` | Drop `GateClient`/`GATE_*_MS`/`classify` imports, `guardrailPolicy` AND `toolAccess` options, and the entire headless `tool_call` handler (lines ~313–395). `PiToolAccess` type goes |
| `src/pi/headless.ts` | Drop `guardrailPolicy` + `toolAccess` from `RunHeadlessPiOptions`; drop `computeExcludeTools`, `PI_BUILTIN_ACT_TOOLS`, the `EXEC_TOOLS` import, and the `excludeTools` pass to `createAgentSession`. **`noExtensions: true` (S2 disk-extension exclusion) STAYS — it is supply-chain hygiene, not permission machinery** |
| `src/adapters/pi/adapter.ts` | Drop `readGuardrailPolicy()` and `readToolAccess()` |
| `src/tools/recruit.ts` | Drop the `guardrailPolicy` zod param (line 152) + threading (172/194/496) AND the `toolAccess` + `force` params (verify `force` has no non-Pi use before removing). ⚠️ *recruit.ts was missed by the mechanical sweep — verify in review* |
| `src/activities/outbox.ts` | Drop `guardrailPolicy` on `RecruitOutboxEntry`/spawn input (192–195, 321–324, 474, 516, 576, 770, 776), the `gate?.setPolicy(...)` call (754), `gate?.clearPlayer()` (901, 946), metadata echo (1226). **KEEP all `ingestToken` mint/revoke logic — that is 3c inner-loop, not gate** |
| `src/workflows/signals.ts` + `src/workflows/session.ts` | `guardrailPolicy?` on `enqueueSpawnUpdate` args (signals:219) and the session passthroughs (session:993–1014, 1677–1809). **Workflow-touching — see b.3 for the isolation rule** |
| `src/daemon.ts`, `src/worker.ts` | Remove GateRegistry construction/threading, `resolveGuardrailPolicy`, shutdown `gate.clear()` |
| `src/http/server.ts` | Unmount gate routes; **keep `requireTier(3)` RBAC — `/inner` egress still uses it** |
| `src/http/inner-loop-routes.ts` | Remove the `gate_pending` ingest side-effect + `gateArmed` from the presence response (`{subscribers}` only) |
| `src/pi/inner-loop-publisher.ts` | Remove `inner.gate_pending` / `inner.gate_resolved` from the `InnerFrame` union |
| `src/pi/inner-loop-client.ts` | Remove `gateArmed()` + `cachedGateArmed` |
| `src/pi/mission-control/actions.ts`, `extension.ts`, `render.ts`, `board.ts` | Remove `gateArm/gateDisarm/gateDecide`, `/arm` + `/gate` commands, gate frame reducers/renderers |
| `src/config.ts`, `src/spawn.ts` | Remove `GUARDRAIL_POLICY` env (+ `TOOL_ACCESS` under D1) and spawn threading |
| `src/types.ts` | Remove `GuardrailPolicy` type; remove `guardrailPolicy?` from `SessionMetadata` (see b.3) |

**KEEP (explicitly out of scope):** all quality-gate files; `tests/adapters/mock/recruit-gate.test.ts`
(ADR 0014 dev-mode gate), `tests/http/sse-existence-gate.test.ts` (SSE visibility), `dev-banner.ts`
("gate 4" production-safety line) — name collisions on "gate", different features.
`AGENT_TEMPO_INGEST_TOKEN`, `IngestTokenRegistry`, `/inner/ingest|presence|/inner` routes, the
inner-loop publisher/tail — **the whole 3c inner loop survives**; only its two gate frame types go.

**Docs:** `CLAUDE.md` (structure listing + concepts bullets), `docs/concepts.md` (guardrail
section), `docs/INNER-LOOP-PROTOCOL.md` (gate frames, gateArmed, postures),
`docs/WIRE-PROTOCOL.md` (getMetadata + enqueueSpawn field notes), `docs/SSE-PROTOCOL.md`,
`docs/tools.md`, `docs/configuration.md`, `README.md`, CHANGELOG "Removed" section.

### b.2 Tests

Beyond the 5 deleted files: grep **both `test/` and `tests/`** for `guardrailPolicy`,
`gate`, `toolAccess`, `observe-only`, `supervised`, `monitored`. Known EDIT list
(researcher-verified): `test/pi-mission-control-render.test.ts`,
`test/pi-inner-loop-publisher.test.ts`, `test/pi-extension-rebuild.test.ts`,
`test/pi-headless-loader.test.ts` (loses the `computeExcludeTools` cases; keeps the
`noExtensions:true` invariant case), `tests/http/inner-loop-routes.test.ts`, plus
recruit/spawn suites asserting the removed options (#712/#715 cases from the 1.7.0
betas). NOT in scope despite the name: `tests/adapters/mock/recruit-gate.test.ts`,
`tests/http/sse-existence-gate.test.ts`, `test/quality-gate*`.

### b.3 Breaking-change assessment (the part that needs care)

1. **Temporal wire protocol: NO breaking change.** No signal/query/update *name* is removed.
   `guardrailPolicy` rides only as an *optional field* on `enqueueSpawn` update args, outbox
   entry data, and the `getMetadata` return — all documented as "additive, non-breaking" in
   #700 P2/G. Field-level removal of optional data does not violate the name-stability rule;
   document it in `docs/WIRE-PROTOCOL.md` in the same commit.
2. **Workflow-code isolation rule.** The session-workflow passthroughs are data-only (they
   copy an optional field into activity inputs — no command-shape change), so removal is
   replay-safe without a `patched()` marker. Still: land the `signals.ts`/`session.ts`/
   `types.ts` strip as **its own commit** with `npm run build` (workflow-bundle rebuild) and
   the WIRE-PROTOCOL.md note, so the determinism-sensitive hunk reviews in isolation. Old
   in-flight workflows whose state carries `guardrailPolicy` are fine — the field is simply
   ignored by new code.
3. **HTTP/SSE surface: in-package lockstep.** The 4 gate routes, the `gateArmed` presence
   field, and the `inner.gate_*` frames are consumed ONLY by our own mission-control and Pi
   subprocess (both ship in the same npm package as the daemon). No plausible external
   consumer exists: the routes require either the loopback ingest token or the env-only T3
   admin token. Removal is documented in `docs/SSE-PROTOCOL.md` / `INNER-LOOP-PROTOCOL.md`.
4. **Versioning (Decision D2).** `guardrailPolicy` + `failMode` + `observe-only` (#700 P2/G,
   #712, #715) exist **only in the 1.7.0 betas** — removing them before 1.7.0 stable means
   they never ship in a stable release at all (zero-cost removal). The base MD-G gate
   (arm/disarm, gate routes, gate frames; phase 3d/#636) did ship in a stable 1.x, so its
   removal is a *feature removal*. **Recommendation: ship the whole removal inside the
   current 1.7.0 beta line** with a CHANGELOG "Removed" entry — one release where the
   feature is gone at stable-cut, rather than stabilizing 1.7.0 with the gate and breaking
   it in 1.8/2.0. Strict-semver alternative (2.0.0) flagged for vinceblank but not
   recommended: the gate has no externally-reachable consumers.
5. **Behavioral change to disclose:** a recruited headless Pi player will execute any tool
   — including shell — without operator approval or a `force:true` escape hatch. That is
   the explicit user intent ("ALL permissions, exactly like the other adapters") — state it
   plainly in the CHANGELOG and `docs/concepts.md` rather than burying it.

### b.4 Commit sequence (Phase 3, tempo-lead handoff — APPROVED, one branch off fresh main)

**Ordering principle: strip CONSUMERS before deleting PROVIDERS — every commit must be
strict-tsc-green on both configs.** Known dependency edges:
- `extension.ts` imports `GATE_AUTO_ALLOW_MS`/`GATE_CLOSED_DENY_MS` from
  `http/gate-registry` → strip the extension BEFORE deleting gate-registry.
- The `InnerFrame` union members `inner.gate_pending`/`inner.gate_resolved` are referenced
  by mission-control `render.ts`/`board.ts` AND `http/inner-loop-routes.ts` (ingest
  side-effect) → strip those references before (or with) the union-member removal.
- `recruit.ts` may stop *sending* `guardrailPolicy`/`toolAccess` before the outbox-entry /
  signals types lose the optional fields (optional-field senders strip first; types last).

1. **C0** — commit this design doc (`docs/design/pi-streamline-gate-removal-cc.md`) as the
   branch's first commit; delete the root `.tmp-cc-design.md` + `.tmp-cc-spec.md` drafts
   (disposition: see "Prior drafts" below).
2. **C1** — mission-control gate surface: strip `actions.ts` (gateArm/Disarm/Decide),
   `extension.ts` (`/arm`, `/gate` commands), `board.ts` reducers, `render.ts` gate frames;
   edit `test/pi-mission-control-render.test.ts`.
3. **C2** — Pi client side: strip `pi/extension.ts` (whole headless `tool_call` handler,
   gate/classify imports, `guardrailPolicy`+`toolAccess` options), `pi/headless.ts`
   (`computeExcludeTools`, `PI_BUILTIN_ACT_TOOLS`, `excludeTools` pass — KEEP
   `noExtensions:true`), `adapters/pi/adapter.ts` (env readers), `inner-loop-client.ts`
   (`gateArmed`), `inner-loop-publisher.ts` (`InnerFrame` gate members — co-strip the
   `inner-loop-routes.ts` ingest reference here if typing requires); DELETE
   `pi/gate-client.ts` + `security/tool-capability.ts` +
   `test/pi-gate-client.test.ts` + `test/pi-tool-capability.test.ts`; edit
   `test/pi-inner-loop-publisher.test.ts`, `test/pi-extension-rebuild.test.ts`,
   `test/pi-headless-loader.test.ts`.
4. **C3** — daemon/HTTP: DELETE `http/gate-registry.ts`/`gate-routes.ts`/`gate-audit.ts`;
   unwire `daemon.ts`/`worker.ts`/`http/server.ts`/`inner-loop-routes.ts` (`gateArmed`
   presence field); remove `gate?.setPolicy/clearPlayer` calls in `activities/outbox.ts`
   (call sites only — entry-type fields wait for C5); DELETE the 3 `tests/http/gate-*`
   suites; edit `tests/http/inner-loop-routes.test.ts`.
5. **C4** — tools + spawn + config: `recruit.ts` params (`guardrailPolicy`, `toolAccess`,
   `force` — verify `force` has no non-Pi use), `spawn.ts` env threading, `config.ts`
   `GUARDRAIL_POLICY`/`TOOL_ACCESS` env defs.
6. **C5** — **workflow touch (ISOLATED):** `signals.ts` (`enqueueSpawnUpdate` arg field) +
   `session.ts` passthroughs + `types.ts` (`GuardrailPolicy`, `SessionMetadata` field,
   outbox-entry fields) ; **`npm run build`** (workflow-bundle rebuild) +
   **`docs/WIRE-PROTOCOL.md` in the SAME commit**. Replay-safe, no `patched()` (data-only).
7. **C6** — docs sweep (CLAUDE.md, concepts, INNER-LOOP-PROTOCOL, SSE-PROTOCOL,
   configuration, tools, README) + CHANGELOG **"Removed"** entry (base MD-G + toolAccess;
   disclose the behavioral change per b.3.5).
8. **C7** — **ResetPump→CuePump merge (S3 — APPROVED by vinceblank, own commit):** one
   generic poll loop, two intake checks per tick; port `test/` reset-pump + cue-pump suites.
   Lands AFTER C1–C6 (it touches the same `extension.ts` region C2 edits).
   Every commit: strict tsc both configs; `npm run check:all` before push.

### Prior drafts — disposition (C0)

- `.tmp-cc-design.md` (repo root): contains only a stray git-error line (a failed
  `git show` of a path that never existed) — no content. DELETE.
- `.tmp-cc-spec.md` (repo root): the #700 P1/P2 design spike. Its §6 (unified guardrail
  model) is **superseded by this document**; its remaining sections (planner Q&A via
  maestro, `respond`, SSE `answer` wake, install-by-reference, ensureInfra) are SHIPPED —
  the code and CHANGELOG are now the record. DELETE the draft; this doc is the in-repo
  successor of record.

---

## Part (c) — Pi command-center vs the Ink TUI

### c.1 Recommendation: **REPLACE AFTER GAPS CLOSED** (phased, not now)

- **Now (1.7.0):** declare mission-control the *primary* operator surface in docs; TUI
  enters **maintenance mode** (bug fixes only, no new features — enforce in review).
- **Next 1–2 minors:** close the P0 gap list below in mission-control (mostly mechanical:
  each gap = 1 actions-client method + 1 command + a renderer; ~8–12 new daemon read routes
  in the existing `handleWriteRoute`/snapshot pattern, since mission-control is HTTP-only
  while the TUI reaches through `TempoClient` to Temporal directly).
- **Then:** delete `src/tui/` + the `ink`/`react`/`ink-text-input`/`ink-spinner` runtime
  deps (a material install-size/tarball win and one less rendering stack to maintain).

**Why not replace now:** the TUI still owns multi-ensemble navigation, history/recall, and
the management views (schedules/hosts/gates/stages/worktrees) — losing them with no
replacement would regress real operator workflows.

**TUI maintenance debt (supporting evidence, QA beta.7 retro via conductor):** the TUI
suite carries **19 pre-existing Vitest failures on main** (`npm run test:tui`) — accumulated
drift, not recent regressions. This strengthens the deprecation case and argues against
investing in fixing those 19 before the direction decision: under this recommendation,
triage them only to the extent CI gating requires (quarantine/skip with a tracking issue),
not to full green.

**Daemon-HTTP reachability (researcher-verified):** of the TUI's 29 commands, everything is
already daemon-HTTP-mediated except three — conductor spawn (`/recruit-conductor`,
`/restore` shell out `agent-tempo up`), ensemble creation (wizard spawns a child process),
and lineup serving (local-disk YAML). **None of these requires a new daemon endpoint:**
`POST /v1/ensembles` (`handleCreateEnsemble`) already recruits the conductor + lineup
players server-side, the recruit write route already accepts `isConductor: true`, and the
mission-control extension is in-process Node with local fs access for lineup files (and
already ships `/ensemble-up` on exactly this path). The TUI gaps are implementation
artifacts of the TUI, not missing daemon capability. Recommendation: initial bootstrap
stays a CLI verb (`agent-tempo command-center` already runs `ensureInfra()`); everything
post-bootstrap is mission-control. Command history is mission-control-local
(Pi owns its own session history; no port needed).

**Why replace at all:** the planner LLM makes wizards obsolete (conversational recruit/
schedule beats a 7-step Ink form); the inner-loop tail + board already exceed the TUI's
live-visibility; bootstrap (`/ensemble-up` + ensureInfra) already exceeds the TUI's
assumptions; and `.tmp-cc-spec.md`'s "Pi is the front door" thesis (vinceblank-endorsed)
makes the TUI's elimination the designed end-state, with the **web dashboard** remaining as
the zero-dependency fallback surface.

**The one hard constraint to accept (flag to vinceblank):** mission-control requires the
optional `@earendil-works/pi-coding-agent` dep and **Node ≥ 22.19** for the *operator seat*
(daemon/players stay Node 20). Killing the TUI makes Pi the only terminal operator UI;
operators who can't run Pi use the web dashboard. If that trade is unacceptable, the answer
is "keep both" — but then the TUI must keep pace, which contradicts the streamlining goal.

### c.2 Feature-gap matrix (TUI → mission-control), prioritized

Checklist source: `src/tui/commands.ts` (28 commands) + component inventory.

**Already at parity (no work):** cue, pause, play, restart, destroy, reset, recruit,
ensemble-down/shutdown, live board (richer than TUI: phase glyphs + tool + ctx% + tail),
conductor bootstrap (`/ensemble-up` exceeds `/recruit-conductor`).

**P0 — must close before TUI deprecation:**

| TUI capability | Mission-control work needed |
|---|---|
| Multi-ensemble home / `/ensemble` switch | Board is bound to one ensemble at session start. Add `/ensembles` list + re-bind (re-open SSE on a new ensemble). Largest single gap |
| `/recall` per-player history; chat scrollback | New daemon read route proxying recall + a paged text renderer (or planner tool `recall`) |
| `/broadcast` | Trivial: fan-out over board players via existing cue action |
| `/migrate` | New write-route shim (`client.migrate`) + command |
| `/hosts` | Read route + renderer (`formatHostList` is already a pure shared util) |
| `/attachment-info` | Read route + renderer (`attachment-format.ts` already shared) |
| `/schedule` list/create/delete + `/unschedule` | Read+write routes; creation is conversational via planner (no wizard port) |
| `/restore`, `/go` (release) | Write-route shims + commands |
| `/status` full detail overlay | `observe_board` exists for the LLM; add a human `/status` rendering the full BoardModel |

**P1 — close during deprecation window:** `/gates` + `/stages` views (read routes — quality
gates feature, display only), `/worktree` list (create/remove already delegate to the
conductor anyway), `/lineup load/save`, `/search`.

**P2 — never port:** Recruit/Schedule/Create-Ensemble wizards (planner conversation replaces
them), command palette/fuzzy completion (Pi's own UX), theming, Ink scrollback mechanics.

**Reverse gaps (TUI lacks, mission-control has):** planner LLM tools (ask/handoff/cue/
recruit/observe_board), fine inner-loop tail, infra bootstrap, coat-check plan handoff,
cross-host tailability awareness. These are the reasons the direction is one-way.

---

## Decisions

| # | Decision | Status |
|---|---|---|
| D1 | Remove the MD-C `toolAccess` axis (and orphaned `src/security/tool-capability.ts`) along with the gate? | **RESOLVED — yes** (user decision 2026-06-10, relayed by conductor: both Pi permission layers go; full tool surface by default, like claude-code-headless/opencode). `noExtensions:true` supply-chain guard stays regardless |
| D2 | Version for the removal | **RESOLVED — inside the 1.7.0 beta line** (vinceblank, 2026-06-10). guardrailPolicy/failMode/observe-only never reach stable; base MD-G removal documented in CHANGELOG "Removed". Researcher concurs the Temporal wire layer is non-breaking |
| D3 | TUI end-state | **RESOLVED — phased replacement approved** (vinceblank, 2026-06-10): mission-control primary now; TUI maintenance mode immediately (quarantine the 19 failing Vitest cases, no fixes); delete after the P0 gap list closes. **CC P0 gaps are a SEPARATE follow-up batch — do NOT parallelize with the removal branch (both edit mission-control files)** |

## Phase 2 delegation sketch

- **my-tempo-engineer:** b.4 commits C1–C5 (C5 isolated, `npm run build`); then P0 gap
  routes/commands as a follow-on epic.
- **my-tempo-docs:** C6 docs sweep; CLAUDE.md structure listing; supersede note on
  `.tmp-cc-spec.md` §6.
- **my-tempo-qa:** grep-both-test-dirs sweep for gate/guardrail/toolAccess remnants;
  verify quality-gate suites untouched; `npm run check:all`; quarantine plan for the 19
  pre-existing TUI Vitest failures (skip + tracking issue, no fix investment per D3).
