# Temporal Cost Re-architecture + Workflow Simplification — Ranked Options

> **Status**: approved scope: Tier 0 + B4c, 2026-06-10
> **Author**: tempo-architect (tempo-impl ensemble) · **Date**: 2026-06-10
> **Repo state**: `5d51937c` (v1.7.0-beta.8, post-#743 Pi gate removal), clean tree, verified via `git rev-parse HEAD`.
> **Inputs**: code survey @ 5d51937c (3 parallel sweeps) + tempo-researcher's quantification pass (pricing verified vs live Temporal Cloud docs, June 2026).
> **Tracking**: epic #747; step 0 (per-source instrumentation) is #753.

---

## 0. Framing, baseline, and one honest discrepancy

**Thesis under test** (conductor's framing): *"Temporal for durable state TRANSITIONS; daemon HTTP plane for everything high-frequency."* In-repo precedent: the 3c inner loop (`src/http/inner-loop.ts` — "NOT on Temporal/bus, ephemeral no-replay").

**Verdict: the thesis holds.** Researcher's bottom line confirms it bluntly: *active work is noise* (+~2,000 actions/day per busy player ≈ +$0.10); **the bill is idle polling, full stop**. Every option below is some form of "stop asking Temporal questions whose answers haven't changed."

### Pricing (researcher-verified, June 2026)
$50/M actions (first 5M, May 2026 repricing). **Queries ARE billable** — 1 action each, same as signals, updates, timer-starts, activity-starts, SA-upserts, CAN. Child workflow 2; schedule execution 3.

### Ranked idle-burn drivers (researcher's instrumented estimate, idle 10-player ensemble)
| # | Driver | Mechanics | Volume | $ |
|---|---|---|---|---|
| 1 | **Maestro 5s refresh loops** (per-ensemble + global) | `resolve.ts:107-181 scanEnsembleSessions`: **unfiltered cluster-wide** `SESSION_LIST_QUERY` (:116), `getMetadata` on EVERY running session BEFORE ensemble filtering (:126), then `getPart`+`getActivityState` per match = 3 queries/player/tick; `fetchEnsembleChat` +≤4/tick (`maestro.ts:109,552,977`). `IDLE_TIMEOUT_MS` 5min mitigant exists but any attached ensemble keeps loops alive 24/7. | ≈1.38M actions/day | ≈$69/day |
| 2 | **Pi cue pump** | 2 unconditional queries/sec (`pendingMessages` cue-pump.ts:263 + `pendingReset` :315, wired in prod extension.ts:345) | 172,800/day/Pi-player | ≈$260/mo each |
| 3 | **SDK adapter pollers** (copilot/claude-api/opencode/headless/mock) | fixed 2s poll, **no idle backoff** — note the claude-code interactive adapter ALREADY HAS 2s→30s idle backoff (`adapter.ts:46-48,:120`); pattern exists in-repo, just not ported | 43,200/day/player | — |
| 4 | Heartbeats (30s signal) | liveness lease renewal | 2,880/day/player | — |
| 5 | Phase-watcher queries + workflow timers | 150-300s phase poll; 5-min main-loop fallback timer (`session.ts:1502-1510`) | ~1,000–1,600/day | — |

**Totals** (researcher): 1 Pi + 9 SDK players + maestros ≈ **2.0M actions/day ≈ $3,000/mo**. Without maestro loops: ~$950/mo. All-interactive, no maestro: ~$78/mo.

### ⚠ Discrepancy to resolve with instrumentation (step 0 of any implementation)
My independent cadence sweep also found the **daemon HTTP-plane aggregate poll** (`src/http/aggregate.ts`): 750ms cadence, **unconditional** ("Subscriber count is irrelevant" — file header), fanning out ~68 queries/tick for a 10-player ensemble (prelude + ensemble-level + 3 wire-meta queries/player via `snapshot.ts getPlayerWireMeta` + duplicated `listHosts` + duplicated `getEnsembleChat` 50/200 windows). Naïve math: ~7.8M actions/day — **larger than the researcher's entire 2.0M/day total**, and absent from their driver list. Possible reconciliations: serial-with-skip means effective cadence ≫750ms under load; `query-timeout.ts` in-flight dedup; visibility `workflow.list` calls possibly not action-billed; or the researcher's pass simply didn't cover `aggregate.ts`. **Don't guess — instrument.** Recommendation: before any fix lands, add per-source action counting (client-side interceptor tagging query/signal source) and read the namespace's actual action metering for a 24h idle window. This is a half-day task and de-risks the whole program. Whichever of maestro-5s vs aggregate-750ms dominates, **both are idle polling and both are fixed by the same Tier-0/Tier-1 moves below.**

### Constraint posture (applies to every option)
- **Wire protocol**: additions fine; renames/removals = major bump (docs/WIRE-PROTOCOL.md). Every option below is *additive with legacy fallback*.
- **Replay determinism**: workflow-side changes behind `patched('v1.X-…')`; no I/O enters workflow code — taps live in activities/worker interceptors.
- **Dev-mode/local-Temporal users see zero cost**: Part A is a **Cloud-tier optimization**. Proposed shape: one `costProfile: 'local' | 'cloud'` config axis (env > config.json), default `'local'` = byte-identical behavior to today (actions are free locally; 750ms board feel and 1s cue latency are features there). Cloud profile flips cadences/transports only.

---

## Part A — Cost options, ranked by (est. action reduction ÷ risk)

Adopting the researcher's split: **Tier 0 = no-architecture-change fixes** (days, low risk, ~90%+ of the bill) vs **Tier 1 = re-architecture** (the thesis applied properly; weeks, medium risk, kills the rest and improves latency).

### Tier 0 — fix the misuse before re-architecting anything

**T0.1 — Maestro visibility-API fix** *(kills driver #1, ≈$69/day)*
Filter `SESSION_LIST_QUERY` by the existing `AgentTempoEnsemble` SA (it's indexed; the unfiltered scan + pre-filter `getMetadata` per session is simply a bug-shaped inefficiency). Read part/phase from SAs (`AgentTempoPlayerId`, `AgentTempoAttachmentState`, `AgentTempoPlayerType`) instead of 3 per-session queries — the SAs already carry this. Stretch refresh 5s→15–30s; presence-gate on dashboard connections (the `IDLE_TIMEOUT_MS` machinery exists, extend it to gate on daemon-reported subscriber presence).
- **Reduction**: ~70% of measured total. **Wire blast**: zero (no names touched; SA reads are visibility-side). **Compat**: none needed. **Complexity**: ~100–250 LOC in `resolve.ts`/`maestro.ts` + tests. **Risk: LOW.** One nuance: `getActivityState` feeds the BPM/tempo buckets — keep a slow per-player query for that or derive activity from SA-phase transitions; flag for design review.

**T0.2 — Port the claude-code idle backoff to the 5 SDK pollers** *(driver #3, ~16× idle cut)*
The 2s→30s exponential idle backoff already exists in `src/adapters/claude-code/adapter.ts:46-48,:120`. Hoist it into `SdkAttachment` (one place, all five inherit). ~50–100 LOC. **Risk: LOW** (reset-to-fast-on-delivery logic is already proven in the interactive adapter).

**T0.3 — Merge `pendingReset` into the `pendingMessages` cycle** *(halves driver #2 for ~20 LOC)*
Additive combined query (e.g. `pendingIntake` returning `{ messages, pendingReset }`); pump issues one query/tick instead of two; old queries stay for older clients (deprecate at next major). **Wire blast: additive.** **Risk: LOW.** (D14 single-slot + `ackReset` id-match semantics untouched — only the read is combined.)

**T0.4 — Daemon aggregate-poll hygiene**
(i) Fix per-tick duplications: `listHosts` queried twice, `getEnsembleChat` twice (50+200 windows). (ii) Demand-gate: `totalSubscriberCount() === 0` and no recent `/v1/state` hit → stretch 750ms to 30–60s reconcile; first subscriber → immediate tick + resume. The plumbing (`totalSubscriberCount()`, single-flight `tick()`, on-demand `buildEnsembleSnapshot`) already exists. ~100–200 LOC. **Risk: LOW.** SSE consumers tolerate it by design (`Last-Event-ID` replay, ring buffer).

**Tier 0 combined estimate**: idle bill drops from ≈$3,000/mo to **low hundreds** for the same fleet, in roughly a week of engineering, with zero wire-protocol impact and no new failure modes beyond cadence tuning. **This is the approval-gate recommendation: do Tier 0 first regardless of what's decided about Tier 1.**

### Tier 1 — re-architecture (the thesis, applied)

**T1.1 — Push-based cue delivery over the daemon event plane** *(conductor's option 2; kills residual #2/#3)* — rank 1 in tier
The outbox delivery activity already runs in the daemon worker (`src/activities/outbox.ts` signals `receiveMessage`). Add a post-delivery hook publishing a `cue.pending {ensemble, playerId}` **doorbell** (not the payload) onto the in-process `EnsembleEventBus` → SSE. Adapters/Pi pump switch to wake-on-event + slow fallback poll (30–60s connected; 5–10s when SSE is down).
- **Guarantees vs today: unchanged.** Workflow state stays the source of truth; on wake the adapter runs the existing `pendingMessages` → inject → `markDelivered` sequence. Ordering identical (same fetch path). A dropped doorbell degrades to fallback-poll latency, never loss. **D14/#743-C7 resets**: same pattern (`deliverReset` activity publishes `reset.pending`; single-slot id-match race-safety is workflow-side, untouched).
- **Multi-host**: doorbell must come from the daemon hosting the *recipient's* adapter. v1: nudge only host-local recipients (most ensembles are single-host); remote players keep Tier-0 backoff polling. v2: cross-daemon nudge via the existing per-player ingest-token HTTP plumbing (3c `ingest-registry.ts`).
- **Latency improves**: 1s poll → sub-100ms doorbell. **Wire blast: zero renames**; new SSE event kind is additive per SSE-PROTOCOL. **Compat**: old adapters keep polling; new ones stretch when SSE is up; daemon-down → fallback poll, cost reverts, correctness unchanged. **Complexity**: ~300–600 LOC (activity hook, event kind, adapter wake state machine). **Risk: MEDIUM-LOW.**

**T1.2 — Change-driven aggregate/maestro reads (query diet, properly aimed)** *(conductor's option 4 — reframed)* — rank 2 in tier
The brief's "daemon snapshot cache as sole Temporal query client; all UIs read daemon" is **already the architecture** — TUI/dashboard/mission-control all read the daemon HTTP/SSE plane. The remaining offenders are the daemon's own poll and the maestro's refresh. Beyond Tier 0's gating: the daemon hosts the Temporal **workers in the same process** (`src/daemon.ts`), so every workflow transition already executes locally. A worker-side tap — delivery/lifecycle activities (or a worker interceptor) publishing change events to the bus — makes polling purely a slow reconcile (e.g. 60s), not the primary signal source. Per-transition cost: 0 extra actions (the activity is already running) vs today's per-tick fan-out.
- **Wire blast: zero** (daemon-internal). **Complexity**: ~300–500 LOC. New failure mode: bus event missed → stale until reconcile tick (bounded staleness, already the SSE model). **Risk: MEDIUM-LOW.** Sequencing note: lands naturally on top of T1.1's bus hook — same mechanism, second consumer.

**T1.3 — Tiered liveness: local-daemon heartbeat, Temporal lease as 10–15min backstop** *(conductor's option 1)* — rank 3 in tier, sequence LAST
Adapters beat against their **own host's** daemon over loopback (3c ingest plumbing); daemon holds in-memory liveness; Temporal `heartbeat` signal stretches to 10–15min with `leaseMs` = 3× (validator cap 600,000ms must be raised — additive, patched-gated; `extendAttachmentForCAN` already takes `leaseMs` verbatim post-#249, CAN math unaffected).
- **Crash-detection latency**: *improves* when the daemon is alive (local detection in seconds → daemon immediately signals `adapterExited`/`forceDetach`) — today's floor is leaseMs (90s–3min). Only the adapter-AND-daemon-both-dead case degrades to the 30–45min backstop (mitigant: daemon shutdown handler force-detaches its local players — it already revokes ingest tokens on shutdown; residual exposure = hard host crash only). **This trade needs explicit human sign-off.**
- **Daemon-down**: adapter detects local-beat failure → falls back to direct Temporal beating at today's cadence; cost reverts, correctness unchanged. **Multi-host**: non-issue by construction — per-host daemons already exist for per-host task queues; adapters only ever loopback to their own host's daemon.
- **3c coarse piggyback**: `currentTool`/context% currently rides the 30s heartbeat into workflow state → SSE. With stretched heartbeats, publish `player.activity` directly from the daemon on local beats (it receives the sample anyway) and keep workflow coarse at backstop cadence for cross-host observers.
- **Reduction**: 2,880→~100–150/day/player — small absolute, but it's the cost floor after T0/T1.1-2. **Wire blast: zero renames.** **Complexity**: ~400–800 LOC, new split-liveness failure modes (daemon-truth vs workflow-truth divergence windows; UI must read the merged view). **Risk: MEDIUM** — touches the v0.26 attachment machinery the #249 trilogy just stabilized. Do not lead with this.

**Not recommended now**
- **Signal coalescing beyond T0.3** (conductor's option 3): traffic-proportional, and traffic is noise (+$0.10/day/busy-player). Cherry-pick the ackReset merge (T0.3); skip the rest — complexity smear across many call sites for ~nothing.
- **Local activities for outbox delivery / CAN-fallback-timer stretching / resolve-cache**: real but small; park behind the instrumentation results. The 5-min main-loop fallback timer cleanup is touchy determinism work (session.ts L1488-1493 documents exactly why) for ~288 timers/day.

### Part A sequencing recommendation
**Step 0**: per-source action instrumentation + 24h idle metering (resolves the aggregate-vs-maestro discrepancy, gives the before/after baseline). **Step 1**: Tier 0 (T0.1→T0.4, independent, parallelizable). **Step 2**: T1.1 then T1.2 (shared bus mechanism). **Step 3**: T1.3 only if the residual heartbeat line item justifies the attachment-machinery risk. All behind `costProfile: 'cloud'`; `'local'` default unchanged.

---

## Part B — Simplification track (effort-sized, not designed)

### B1. TUI deprecation acceleration
- **Size**: 9,312 LOC under `src/tui/` (root 5,355 + components 3,357 + utils 600) + **21 test files** (3 Mocha in `test/`, 18 Vitest in `tests/tui/`). No imports of `src/tui` from outside the directory (only historical extraction comments in `src/client/interface.ts`, `src/palette/index.ts`).
- **Payoff**: removes the Ink/React dependency tree entirely — #742 D3 already names the deprecation; killing `src/tui/` also closes **#95 (Fork Ink)** by mooting it. Removes `docs/tui-performance.md` maintenance burden and the dual test-runner split's largest Vitest consumer.
- **Successor surfaces already exist**: web dashboard + Pi mission-control board (`agent-tempo command-center`) cover the live-view + operator-control use cases. Gap analysis needed: TUI slash commands vs mission-control/board parity (the #288 removed-verbs migration-hint table is the precedent for graceful verb retirement).
- **Effort: S–M** (mostly deletion + a deprecation release cycle with launch-verb hints). **Risk: LOW** technically; the cost is user-facing (anyone scripted on the TUI). Recommend: deprecation warning in one minor release, delete in the next.

### B2. Adapter lifecycle convergence (BaseAttachment stack vs Pi singleton)
- **Inventory**: 6 adapters on the class stack (claude-code → BaseAttachment directly; copilot/claude-api/opencode/headless/mock → SdkAttachment → BaseAttachment; ~6,800 LOC total) vs **Pi** (59-LOC descriptor + the `src/pi/` runtime: module-scope singleton, PhaseDriver, CuePump, PiWorkflowClient — no BaseAttachment).
- **Duty matrix** (who implements what): claim/heartbeat/phase-watch/reconnect → BaseAttachment (inherited by 6); processing-pair + onSuperseded → SdkAttachment; Pi reimplements claim/heartbeat (PiWorkflowClient), phase (PhaseDriver from Pi events rather than polling), cue intake (CuePump). Genuine overlap: claim/heartbeat/detach wiring (~3 duties duplicated); genuine divergence: Pi's phase comes from *events* (better than Base's poll!) and its singleton survives Pi's per-switch instance rebuild — constraints BaseAttachment was never designed for.
- **Assessment**: full convergence on one base class is the wrong target — Pi's event-driven phase model is the *direction the SDK adapters should move* (especially under T1.1's push delivery, which deletes the poll loop Base owns). **Recommended framing**: extract a small shared `attachment-core` (claim/heartbeat/lease math/detach wire calls — much already pure in `attachment-math.ts`) consumed by both stacks, rather than forcing Pi under Base. **Effort: M–L. Risk: MEDIUM-HIGH** (#249-class stability surface). **Sequence AFTER Part A Tier 1** — T1.1/T1.3 change the duty list itself; converging first means converging twice.

### B3. MCP tool-family consolidation
- **Census**: **45 tools, 4,246 LOC** in `src/tools/`. Clean merge candidates: coat-check ×4 (274 LOC) → 1 tool with `action` enum; state ×3 (225 LOC) → 1; schedule ×3 (267 LOC) → 1; stages ×2 partial; gates ×4 only partial (create vs evaluate shapes differ legitimately). Net: 45 → ~35–37 registered tools.
- **Payoff is per-player LLM context**, not maintenance: every player carries all tool schemas in its system context. The repeated put/get/list/evict description boilerplate compresses well. (Note: exact token saving depends on MCP client schema rendering; measure one merged family before doing all.)
- **API churn**: MCP tool names are **not** Temporal wire protocol — renaming breaks LLM muscle memory and any user docs/scripts, not replay. The transport-neutral descriptor layer (`descriptor.ts`, MD-B) makes **alias-and-deprecate** cheap: register old names as thin aliases for one release.
- **Effort: S per family. Risk: LOW.** Counter-consideration to flag honestly: action-enum mega-tools can degrade LLM tool-selection accuracy vs distinct names; coat-check/state/schedule are low-stakes, but don't merge high-frequency tools (cue/report/ensemble) on this argument.

### B4. Pause/hold consolidation or removal
**Live incident (2026-06-10, this spike)**: both task briefs + a status ping to this player queued silently for ~5h because the fresh post-crash tempo-impl ensemble came up paused; every `cue` reported success; nothing surfaced the suspension — the orchestrating conductor missed it until the human noticed.

**Census** (full file:line table from sweep): 5 user-facing verbs (`pause`, `play`, `release`, `shutdown`, `restore`) + internal mechanics (session `setPaused` flag gating `canDispatch()` at session.ts:1450; `outboxLocked` hold + `releaseHeld` deferred-message delivery; scheduler `setSchedulerPaused` skip-fires; maestro `maestroSetPaused` ground truth; `load_lineup` warm-hold `held: true` recruits). **There are effectively THREE parallel suspension axes** (session outbox pause, session hold/outboxLocked, maestro+scheduler pause) — the consolidation case writes itself.

**Fresh-up-paused: intentional design, not a bug** (#172, v0.26): `up --lineup` seeds the conductor with the ready-directive (constants.ts:59-72: *"The ensemble is PAUSED and players are HELD… call `resume_ensemble { release: true }` FIRST"*) and pauses everything so no tasks fire before the human's first instruction. The design's failure mode is exactly tonight: **it assumes the conductor reads and acts on the directive**. A post-crash recreated ensemble whose conductor misses/loses that directive (e.g. context loss, /clear-no-hook) leaves the ensemble silently wedged. Design rationale documented; *resilience gap real*. → File an issue for the gap regardless of which option below is chosen (e.g. "paused-ensemble watchdog: conductor or daemon surfaces a banner after N minutes paused with queued cues").

**What pause does NOT do (honest framing)**: it gates **outbox dispatch** (with stop/destroy bypass) and scheduler fires. It does **not** stop the local LLM/shell process — a paused player keeps doing whatever it was doing; it just can't send. It's a **message brake, not an agent brake**. Sweep found **no overselling in docs** (no "safety" framing exists) — good; any future docs touching pause should carry this sentence explicitly.

**Options**:
- **(a) Collapse hold into pause** — one suspension axis, one resume verb. Conceptually right (hold ≈ pause + one deferred message). Wire cost: `releaseHeld`/`setPaused`/`outboxLocked`/`paused`/`setSchedulerPaused`/`maestroSetPaused` are all stable wire names — collapse = deprecation path + major bump, plus the startup-hold deferred-message semantics must survive. **Effort M, breaking.**
- **(b) Demote pause/hold to internal-only** — keep the mechanics for shutdown/restore/migrate/startup-hold; remove the user-facing `pause`/`play`/`release` tools. Smaller user surface but the *incident class remains* (internal pause still silently queues cues). **Effort S–M, breaking (tool removal), doesn't fix the actual problem.**
- **(c) Keep but make LOUD** — additive: (1) `cue` warns when the target session/ensemble is paused or held (the `UNDELIVERABLE_PHASES` warning pattern at cue.ts:133-135 is the exact template — pause/held is simply missing from it); (2) `ensemble`/`who_am_i` responses carry a `⏸ ENSEMBLE PAUSED — cues will queue` banner; (3) snapshot already exposes `flags.{paused,held}` — mission-control/dashboard render it prominently; (4) conductor's report tool echoes a paused warning. **Effort: S (≈1 day). Risk: zero. Non-breaking.**
- **Recommendation**: **(c) now** — it is explicitly compatible with (a) or (b) later and would have prevented tonight's 5-hour silent wedge for one day of work. Decide (a)-vs-(b)-vs-keep at the next major-version planning point, informed by whether (c)'s banners eliminate the operational pain. My architectural lean for the major: (a) — three suspension axes is two too many — but that's a v2 decision, not this quarter's.

---

## Summary ranking (reduction ÷ risk, descending)

| Rank | Item | Action cut | Risk | Wire impact | Effort |
|---|---|---|---|---|---|
| 0 | Instrument per-source action counts | enables all | none | none | 0.5d |
| 1 | T0.1 maestro SA-filter + SA reads + cadence | ~70% of bill | LOW | none | days |
| 2 | T0.2 SDK poller idle backoff | ~16× idle/player | LOW | none | <1d |
| 3 | T0.3 merge pendingReset into pendingMessages | ½ Pi pump | LOW | additive | <1d |
| 4 | T0.4 aggregate dedup + demand gating | daemon idle→~0 | LOW | none | 1–2d |
| 5 | B4(c) pause/hold loudness | n/a (correctness) | none | additive | 1d |
| 6 | T1.1 push cue delivery (doorbell) | residual polling | MED-LOW | additive | ~1wk |
| 7 | T1.2 worker-side change tap | residual aggregate | MED-LOW | none | ~1wk |
| 8 | B3 tool merges (coat-check/state/schedule) | n/a (context) | LOW | MCP-alias | days |
| 9 | B1 TUI deletion | n/a (−9.3k LOC) | LOW | none | 1 release cycle |
| 10 | T1.3 tiered liveness | heartbeat floor | MED | additive | 1–2wk |
| 11 | B2 attachment-core extraction | n/a | MED-HIGH | none | weeks; after T1 |
| — | B4(a/b) pause consolidation | n/a | breaking | major bump | v2 planning |

**Risks flagged for human judgment**: (1) T1.3's both-dead crash-detection window (30–45min backstop); (2) T0.1's effect on BPM/tempo derivation; (3) B1's user-facing TUI retirement; (4) the aggregate-vs-maestro measurement discrepancy — do step 0 before believing any single number in this doc.
