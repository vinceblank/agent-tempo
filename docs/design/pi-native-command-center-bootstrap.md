# Pi-Native, Command-Center-Driven Ensemble Bootstrap

> **Status:** Design spike. UNTRACKED draft — not committed. For vinceblank's review.
> **Author:** greenfield-architect (my-tempo-architect), tempo-impl ensemble.
> **Relation to prior work:** A concrete, *incremental* slice of the Pi-native vision
> (`greenfield-pi-native.md`) — NOT the full fork (`greenfield-pi-fork-manifest.md`). This is the
> on-ramp: prove the "Pi is the front door" UX inside today's codebase.
>
> **vinceblank's goal:** install agent-tempo's Pi extensions the normal `.pi` way, then **start + manage
> an ensemble from *inside* a Pi session** via the command center. Pi is the entry point; the
> `agent-tempo` CLI is not.
>
> **vinceblank's ruling — daemon lifetime:** option **(b)** — the extension **auto-spawns + manages a
> DETACHED daemon**. Temporal workers survive Pi closing; the ensemble outlives any single Pi window;
> the daemon is invisible plumbing the extension handles. The user never runs `agent-tempo` directly.

---

## 1. The key insight (this is mostly wiring, not building)

Two facts collapse the scope dramatically:

1. **The entire ensemble-bootstrap already exists as an HTTP endpoint.** `POST /v1/ensembles`
   (`src/http/catalog.ts → handleCreateEnsemble`) already does `ensureMaestroSession` → recruit the
   conductor (`isConductor: true`, which bootstraps maestro + scheduler + conductor workflows) →
   recruit each lineup player. It was built for the *browser dashboard's* create-ensemble wizard. Its
   own doc comment even maps itself to the CLI `up` path. **The command center can call it as-is.**

2. **`startDaemon()` already spawns the daemon detached.** `src/cli/daemon.ts → startDaemon(config)`
   does exactly vinceblank's ruling (b): `spawn(process.execPath, [DAEMON_ENTRY_PATH], { detached:
   true, stdio: ['ignore', logFd, logFd] })` + `child.unref()`, guarded by a cross-process start lock
   and `isDaemonRunning()`. It already survives the parent exiting. **The extension reuses this verbatim.**

So the command center already POSTs operator actions to the daemon (`MissionControlActions` → cue /
pause / play / restart / destroy / reset / gate). Bootstrap adds two thin things on top: a
**daemon-ensure** step before the first HTTP call, and a **create-ensemble** call. Everything else is
new *command surface*, not new *machinery*.

---

## 2. The in-Pi bootstrap flow, mapped to `agent-tempo up`

`/ensemble-up <name> [--lineup X] [--hold]` from the command-center extension runs:

```
/ensemble-up myband --lineup tempo-dev-team
  1. ensureInfra()         → Temporal reachable? + daemon running? (auto-spawn detached if not)
  2. POST /v1/ensembles    → { name, lineup, startMode, conductorInstructions }
                             (ensureMaestro → recruit conductor → recruit lineup players)
  3. board lights up        → the coarse SSE the command center ALREADY subscribes to streams the
                              player_joined events; the existing ~200ms render tick paints the board
```

### Reused-vs-new, step by step against `up()` (`src/cli/commands.ts:1137`)

| `agent-tempo up` step (today) | In-Pi `/ensemble-up` | Reuse / New |
|---|---|---|
| 1. `temporalCliExists()` check | Same probe, or skip (see §10 — Temporal dependency) | **Reuse** (or defer to infra prereq) |
| 2. Start Temporal dev server (`detached` spawn) | `ensureInfra()` step a — same logic, callable from the extension | **Reuse** (lift into a shared `ensureInfra()` helper) |
| 3. `registerSearchAttributes()` | Daemon boot already verifies SAs (`sa-preflight`); no extra step | **Reuse** (daemon owns it) |
| 3.5 Install shipped agent types → `~/.claude/agents/` | One-time; folds into extension install or first-run (§8) | **New (small)** — move into install/first-run |
| 3.7 `isDaemonRunning() \|\| startDaemon(config)` | `ensureInfra()` step b — **the ruling-(b) auto-spawn**, reused verbatim | **Reuse** ✅ (already detached + unref'd) |
| 4. Register MCP server (`init`) | **Dropped** — Pi registers tools natively; no MCP | **Cut** |
| 5. Connect Temporal + "conductor already running?" choice tree | `POST /v1/ensembles` returns **409 ensemble-exists**; command center surfaces a board notice | **Reuse** (HTTP 409, no interactive tree) |
| 5+. Recruit conductor + lineup players | `handleCreateEnsemble` does this inside the one POST | **Reuse** ✅ |

**Net new code is tiny:**
- `MissionControlActions.createEnsemble(...)` → `POST /v1/ensembles` (the actions client has cue/pause/
  play/restart/destroy/reset/gate today but **no create and no recruit** — add both; `/recruit` HTTP
  route already exists, the client method doesn't).
- `ensureInfra()` — a shared helper wrapping the `up()` Temporal-start + `startDaemon` logic so both the
  CLI and the extension call one path (avoids drift).
- Command handlers on the mission-control extension: `/ensemble-up`, `/recruit`, `/ensemble-down`.
- **One genuinely new HTTP endpoint:** ensemble teardown for `/ensemble-down` (see §7).

### Companion commands

| Command | Mechanism | Status |
|---|---|---|
| `/ensemble-up <name> [--lineup] [--hold]` | `ensureInfra()` + `POST /v1/ensembles` | new handler, reused machinery |
| `/recruit <name> [--type T] [--host H]` | `POST /v1/ensembles/:e/recruit` (route exists) | new client method + handler |
| `/ensemble-down [--destroy]` | **new** `POST /v1/ensembles/:e/shutdown` (or fan-out destroy) | new endpoint + handler |
| `/ask <player> <question>` | **new** `POST .../ask` + poll `GET .../answer/:id` via maestro (§4) | new endpoints + handler |
| `/handoff [player]` | cue (or coat-check ticket) → the durable conductor | new handler, reused cue/coat-check |
| `/players /tail /cue /pause /play /restart /destroy /reset /arm /gate` | already shipping | **unchanged** |

---

## 3. Roles: planner (command center) vs executor (conductor) — and one extension or two?

### The planner/executor model (vinceblank-confirmed)

The command center is **a normal interactive Pi session PLUS command-center functionality** — an
interactive Pi **brain (its own LLM) you plan *with*.** It observes/controls the ensemble and **hands
off the plan** to the durable headless conductor for execution. So there are two LLM agents with a
clean division of labor:

| | **Command center** | **Conductor** |
|---|---|---|
| Role | **Planner** — you think *with* it | **Executor** — runs the plan |
| Runtime | Interactive Pi (has its own LLM) | Headless Pi (has its own LLM) |
| Lifetime | **Ephemeral** — a window you open to plan/steer | **Durable** — survives the command center closing |
| Ensemble identity | **NOT a player** (no attachment, no inbox) | **A player** (claims attachment, durable workflow) |
| How it acts | Orchestrates via daemon HTTP (bootstrap + control + plan-handoff) | Coordinates the ensemble via the outbox |

The hand-off is explicit: you plan interactively in the command center, then **push the plan to the
conductor** (a cue carrying the plan, or a richer plan artifact via coat-check). The conductor — durable
— executes and keeps coordinating even after you close the planner window. This is the key UX: *the
human's seat is ephemeral; the orchestration is durable.*

### One extension or two? — RULING: **keep two**

- **Player extension** (`src/pi/extension.ts`) — claims attachment, registers as a player, runs the cue
  pump + heartbeat + MD-C/MD-G gates. Run by a recruited player or the headless conductor.
- **Command-center extension** (`src/pi/mission-control/`) — loaded into an *interactive* Pi session;
  gives that session the board + control verbs + (now) bootstrap + plan-handoff. **Never claims an
  attachment, never registers as a player.**

**The command center has its own LLM but is still NOT a player.** This is the subtle point the
planner/executor model sharpens: "has an LLM / is a full planning agent" and "is a registered ensemble
player" are *orthogonal*. The command center is a thinking agent that *orchestrates from outside* — it
holds no attachment lease, has no Temporal inbox, never appears on its own board. Bootstrapping
(spawn daemon, POST create-ensemble) and plan-handoff (cue the conductor) are all operator actions over
HTTP / the outbox — none claim an attachment.

**Why keep two extensions:** the T1/T2/T3 auth model and the "command center is invisible to the
ensemble" invariant depend on the observer/participant separation. A unified extension that both plans
*and* claims an attachment would put the planner on its own board and saddle it with the lease/
heartbeat/reset/tool-gate lifecycle it has no business running. Keeping them separate keeps each
surface honest — and lets the same person open a planner window against an ensemble that's already
running headless.

**Conductor shape:** recruited **headless by default** (`agent: 'pi'`) — the human's seat is the
command center, so a second interactive conductor window is redundant. An `--interactive-conductor` opt
can spawn a visible Pi conductor TUI for users who want it.

---

## 4. Cue → response: the planner asks, a player answers — **via maestro**

The planner (command center) routinely needs a *correlated answer* from a player: "what's your status
on X?", "is the migration done?". But the command center **isn't a player — it has no Temporal inbox**,
so a player can't cue it back directly. vinceblank's insight: **maestro is the addressable rendezvous**
— route the request/response *through* maestro rather than inventing a new broker or scraping the tail.

### ✅ Verification: maestro can serve this cleanly — coat-check already proves the pattern

Reading `maestro.ts` + `maestro-signals.ts` confirms maestro **already implements exactly this shape**
for coat-check (#318): a **ticket-keyed transient mailbox on workflow state** —
`Record<ticket, CoatCheckEntry>` — with `put`/`get`/`list`/`evict` updates, **carried across
continue-as-new**, swept by a deterministic **TTL** at every handler entry + on the refresh tick. A
correlation-keyed Q&A mailbox is *structurally identical* to coat-check — only the key changes (a
**caller-chosen `questionId`** instead of a server-generated ticket). Maestro is also already an
addressable workflow with a write surface (`maestroSendCommandUpdate`, the coat-check updates) and a
read surface (queries). **So this is not "can maestro do it" — it's "clone the coat-check mailbox with a
caller-supplied key."**

### The flow

```
1. ASK    planner mints questionId → POST /v1/ensembles/:e/ask { target, question, questionId }
            → daemon cues the target player: "[Q questionId] <question> — answer via `respond`"
              (optionally also records the pending question on maestro for audit / reconnect)
2. ANSWER target player calls `respond({ questionId, text })`  → executeUpdate(maestroPostAnswer)
            on the maestro handle — the SAME direct-to-maestro write pattern coat_check_put already uses
            (a shared-store write, not a peer-workflow signal → outbox invariant preserved)
3. READ   planner polls GET /v1/ensembles/:e/answer/:questionId → daemon queries maestroGetAnswer
            → returns the answer (or null until present / TTL). Correlated by questionId end-to-end.
```

Because the answer lives on maestro (durable, CAN-carried, TTL-bounded), it **waits there even if the
planner window closed and reopened** — the planner can ask, close, come back, and read the answer.
That durability is the whole reason to prefer maestro over an in-memory broker.

### Honest comparison vs the alternatives

| Approach | Correlation | Durability | Cross-host | Architectural honesty | Verdict |
|---|---|---|---|---|---|
| **(A) maestro-mediated** *(recommended)* | First-class (caller-chosen `questionId`) | Durable — answer survives planner + daemon restarts (CAN-carried, TTL-swept) | Works — maestro is queried via the daemon client, host-agnostic | **High** — maestro was *built* as the addressable rendezvous; coat-check + command-relay already prove it | ✅ |
| (B) tail-observation (`/inner` firehose) | **None** — can't tell which output answers which question | Ephemeral — drop-oldest bounded queue, no-replay | **No** — inner tail is daemon-local (H3a) | Low — conflates *observation* with *request/response*; scraping an answer out of a stream is guesswork | ✗ |
| (C) daemon-side correlation broker | First-class (broker holds `questionId → pending`) | **Ephemeral** — dies with the daemon (the planner's answer evaporates on a daemon restart) | Single-daemon only | Low — **reinvents maestro's rendezvous** inside the daemon, which we're trying to keep as thin Temporal-worker plumbing; adds stateful surface | ✗ |

**Recommendation: (A) maestro-mediated.** It's the most architecturally honest precisely because
maestro *is* the ensemble's addressable rendezvous — coat-check and the conductor command-relay are the
same mechanism wearing different hats. It's durable where (C) is ephemeral, correlated where (B) is
blind, and cross-host where both others aren't. And it's the smallest *honest* addition: a near-clone of
a mailbox that already ships.

### Wire impact (additive — flag it)

Per the project rule (update `docs/WIRE-PROTOCOL.md` in the same commit as any new signal/query/update),
this adds — all **additive**, no renames, no removals:
- **`maestroPostAnswer` update** (player → maestro): `{ questionId, from, text }` → writes the answer
  entry. A near-clone of `coatCheckPut`, keyed by the caller-supplied `questionId`.
- **`maestroGetAnswer` query** (planner → maestro, via daemon): `(questionId) → AnswerEntry | null`.
  (Could be an update if "consume-once" semantics are wanted; a query + TTL is simpler and matches
  coat-check's read posture.)
- **Optional `maestroPostQuestion` update** to record the pending question on maestro (audit + lets a
  reconnecting planner enumerate outstanding asks). Nice-to-have; the minimal loop needs only the
  answer mailbox.
- **A player-facing `respond` tool** that calls `maestroPostAnswer` directly on the maestro handle —
  exactly how the `coat_check_*` tools already call maestro updates (a shared-store write, **not** a
  peer-workflow signal, so the outbox invariant is untouched).
- **Two daemon HTTP routes**: `POST /v1/ensembles/:e/ask` and `GET /v1/ensembles/:e/answer/:questionId`,
  plus `MissionControlActions.ask()` / `readAnswer()` and a `/ask <player> <question>` command.
- **One maestro state field**: `answers: Record<questionId, AnswerEntry>` — CAN-carried + TTL-swept,
  mirroring `coatCheck` (carry-only-when-non-empty idiom included).

Net: a handful of additive wire ops that **mirror an existing, battle-tested pattern.** No breaking
change; the new state field rides the same CAN-carry + TTL-sweep machinery coat-check already uses.

---

## 5. The planner operating model — how the command center actually runs

The command center is an interactive Pi session **with its own LLM**. This section specs how that LLM
operates the ensemble.

### 5.1 Two invocation surfaces, one action layer

Every capability is reachable **two ways**, both landing on the same `MissionControlActions` method:

| Capability | Human types (slash-command) | Planner LLM calls (Pi tool) | Lands on |
|---|---|---|---|
| Ask a player | `/ask <p> <q>` | `ask({ target, question })` | `actions.ask` → §4 |
| Hand off the plan | `/handoff [p]` | `handoff({ plan, to? })` | cue / coat-check → conductor |
| Send a message | `/cue <p> <m>` | `cue({ to, message })` | `actions.cue` |
| Recruit a player | `/recruit <p> …` | `recruit({ name, type?, host? })` | `actions.recruit` |
| Observe the board | (always visible) | `observe_board()` → returns the `BoardModel` snapshot as text | in-memory model |
| Disruptive ops | `/pause /restart /destroy /reset /arm /gate` | gated tools (§6) | confirmation gate → `actions.*` |

So the extension registers **both** `registerCommand` (human-typed) **and** `registerTool`
(planner-LLM-callable) for the same verbs — `renderToPi`-style tool registration in the *interactive*
command-center session. The human can drive directly *or* converse with the planner LLM and let it act.
`observe_board()` is the planner's read-path: it doesn't have to scrape the rendered widget — it calls a
tool that returns the structured `BoardModel` (phases, parts, current tool, context %) the extension
already maintains from the coarse SSE.

### 5.2 Yield-not-poll on `/ask` (apply #695 directly)

The planner must **never busy-poll** the maestro answer-mailbox — that's the #695 anti-pattern on the
planner side. The design:

```
planner LLM calls ask({target, question})
  → extension mints questionId, POSTs /v1/ensembles/:e/ask, returns IMMEDIATELY:
      tool result = "dispatched (questionId=…); you'll be woken when the answer lands."
  → the planner's turn ENDS. It yields. No loop, no sleep, no poll.

… time passes; the target player answers → maestroPostAnswer …

  → the daemon's aggregate poll loop (which already diffs maestro state for the board) detects the new
    answer entry and emits an SSE event `answer { questionId, from, text }` on the ensemble stream the
    command center ALREADY subscribes to.
  → the extension's SSE handler receives it and WAKES the planner: it injects the answer into the live
    Pi session via session.sendCustomMessage({ customType:'answer', content }, { triggerTurn: true }) —
    the SAME triggerTurn primitive the cue pump uses to wake an idle player.
  → the planner's LLM turn resumes with the answer in context, mid-plan.
```

**The wake mechanism is the key design choice.** The command center is *not* a player — it has no
workflow inbox and no cue pump — so it can't be woken the way players are. Its inbound channel is the
**SSE stream it already consumes for the board.** So the answer-wake reuses that exact plumbing: daemon
emits an SSE `answer` event → extension turns it into a `triggerTurn` session injection. This is the
planner-side mirror of how cues wake players (poll→inject), but transport is SSE→inject because the
planner's "inbox" is the event stream, not a Temporal workflow.

- **Latency is acceptable *because* the planner yielded.** The answer surfaces at the daemon's poll
  cadence (a few seconds); since the planner isn't burning a turn waiting, latency costs nothing. If
  sub-second wake is ever wanted, add a maestro→daemon notify (push) — but it's not needed for v1.
- **Write stays clean:** the player still writes the answer *directly to maestro* (`maestroPostAnswer`,
  like `coat_check_put`); the daemon only *observes* maestro to emit the wake event. The write path and
  the wake path are decoupled — and the answer is durably parked on maestro regardless of whether the
  planner is even open to be woken (§4's durability property).

### 5.3 The interactive loop — board + conversation in one Pi TUI

> **✅ Coexistence CONFIRMED (tempo-researcher, Pi 0.78.1).** A single interactive Pi TUI runs a
> persistent `setWidget` board (~200ms tick) AND a live conversational agent loop simultaneously: (1)
> `setWidget` is a *fire-and-forget* method, explicitly separated from the focus-taking dialog methods —
> only `custom({overlay})` steals input; plain widgets are passive render content that can't hold the
> cursor. (2) Mid-turn re-render works and is **not** deferred (Pi's own `titlebar-spinner` /
> `working-indicator` examples tick continuously *through* streaming + tool execution — the render loop
> is independent of the async agent loop). (3) Widgets are a separate keyed render layer from the
> transcript; they never fight. This is literally what Pi's flagship `plan-mode/` extension does —
> persistent widget UI + active conversational agent in one session. No split-panes, no focus-toggle
> needed for the baseline.

The loop:
```
┌─ board widget (aboveEditor, ~200ms render tick from coarse SSE) ──────────────┐
│  soloist  ▶ processing  · 34% ctx · running: edit                            │
│  tuner    ⏸ awaiting    · 12% ctx                                            │
└───────────────────────────────────────────────────────────────────────────────┘
> human: "is the soloist done with the migration?"
  planner LLM → ask({target:'soloist', question:'migration done?'}) → yields
  …[answer lands → SSE wake]… planner: "Soloist reports the migration is done, tests green."
> human: "good — recruit a reviewer and hand off the review plan"
  planner LLM → recruit(...) → handoff({plan, to:'conductor'})
```
The human **converses with the planner** (top-level Pi chat); the **board stays painted above** the
editor and live-updates from the SSE; the planner **observes** (`observe_board` / the widget),
**queries** (`/ask` → yield/wake), **builds a plan**, and **hands off**. One window, two layers
(persistent widget + conversation transcript) — confirmed-supported, and exactly Pi's own `plan-mode`
pattern.

**The one real refinement (vertical real-estate, researcher caveat):** a widget is a *band* above the
editor, not a full pane — a tall board (many players × multi-line) eats transcript rows. So:
- **Always-on widget = COMPACT** — one summary row per player (`glyph · part · tool · ctx%`), top-N with
  a `+M more` overflow. Keeps the planner's chat usable.
- **`/board` command opens the FULL board as a `custom({overlay})` on demand** — a focus-stealing
  detail view is *fine* for an explicit expand (the human asked for it); dismiss returns to chat.

Baseline = compact coexisting widget; the overlay is the on-demand detail view, not the default. This is
the only adjustment to the model — the core "observe + converse in one TUI" stands.

### 5.4 The `/handoff` plan artifact

**What "the plan" is:** a **lightweight structured brief** — markdown with a small fixed skeleton, not
rigid JSON (the conductor is an LLM; prose-with-structure parses fine and stays human-readable):
```
## Objective         one-line mission
## Assignments       - <player/role>: <task>   (bullet list; may name players to recruit)
## Constraints       branch rules, deadlines, do-not-touch
## Success criteria   what "done" looks like (seeds a quality gate)
```
**Delivery:** small plan → inline in a cue flagged as a handoff (`customType:'plan-handoff'` or a
convention prefix); large plan → **coat-check ticket** (the cue carries the ticket; the conductor
`coat_check_get`s the body — exactly the #318 large-payload path).

**How the conductor ingests it:** the durable headless conductor receives the handoff as a cue. Its
role prompt says: *on a plan-handoff, parse the brief → `set_ensemble_description` (objective) →
recruit/assign per Assignments → optionally open a `quality_gate` from Success criteria / a `stage` for
multi-player tasks → begin orchestrating.* From that point the conductor owns execution and keeps
coordinating **even after the planner window closes** — the planner→executor seam in one message. This
reuses existing features (cue, coat-check, set_ensemble_description, quality_gate, stage) end to end; no
new execution machinery.

---

## 6. Guardrails — the unified autonomous-agent guardrail model

> Replaces the earlier command-center-only tier list. **One classification + one policy knob, applied
> consistently to *any* autonomous LLM agent** — headless conductor and interactive planner alike. Not a
> command-center bolt-on.
>
> **LOCKED 2026-06-06** — fail-mode ruling by the conductor (vinceblank-approved); MD-G mechanism
> verified by **tempo-architect** (phase-3d gate owner) against the shipped gate code. Their corrections
> are baked in below.

### ★ Default = AUTONOMOUS (vinceblank's hard requirement)

An autonomous agent **runs fully independently by default** — no confirms, no gate in the path. Hands-off
unattended orchestration is the whole point: the conductor must run a complete ensemble with zero human
in the loop. **Guardrails are OPT-IN, OFF by default** — exactly today's MD-G posture (the gate is armed
*selectively*; absent an arm, tools run free).

### The durable policy knob (per agent)

| Policy | Behavior | Default? |
|---|---|---|
| **`autonomous`** | No gate. Every op runs free. | ✅ **DEFAULT** (conductor + planner) |
| **`supervised`** | Opt-in. **Dangerous ops** (non-low-risk) require human approval, **fail-CLOSED**. | opt-in |
| **`observe-only`** | Opt-in. Agent may read/observe/advise but **cannot act** — a separate *no-act* axis (tool-access denial, MD-C-style), **not** a gate state. | opt-in |

> **Policy is DURABLE config; the gate arm is EPHEMERAL (architect caveat 2a).** `GateRegistry`'s
> per-workflow `armed` flag is an in-memory operator action that **auto-disarms on detach/destroy**. The
> durable `supervised` policy therefore maps to **arm-at-boot**: a supervised agent re-arms its gate
> (fail-closed) on each attach. Don't conflate the operator's runtime arm with the durable policy.

### One danger-classification — ADOPT MD-G's `classify()` verbatim (it's already comprehensive)

`classify()` (`exec | high-blast | low-risk`, unknown → `high-blast` fail-safe) **already classifies the
full agent-tempo MCP surface** — tempo-security signed the name-sets off 2026-06-04. So we **adopt it
verbatim, not extend it**. The shipped taxonomy (authoritative — do not re-derive):
- **`high-blast`** (gated when supervised): `recruit` *(spawns a new autonomous agent — surface
  expansion; **NOT** low-risk)*, `destroy`, `restart`, `migrate`, `shutdown`, `release`, `broadcast`,
  `schedule`, `restore`, `pause`, `play`, `save_state`, `clear_state`, `coat_check_evict`, `load_lineup`,
  `worktree`, `stage`, `cancel_stage`, `quality_gate`, `evaluate_gate`, `copy_file`, + all host `exec`,
  + **unknown** (fail-safe).
- **`low-risk`** (never gated): `cue`, `report`, `recall`, `listen`, `ensemble`, `who_am_i`,
  `set_name`/`set_part`, `hosts`, `attachment_info`, `agent_types`, `fetch_state`,
  `coat_check_get`/`put`/`list`, `unschedule`, `save_lineup`, `websearch`.

`supervised` gates **non-low-risk**. New CC-planner tools get added to the Sets **with tempo-security
sign-off** (they own the content; the module owns the mechanism).

> **★ Layering (architect): extract `classify()` to a neutral shared module.** It lives in
> `src/pi/tool-capability.ts` today; if the planner isn't a Pi agent, importing from `src/pi/` is a
> layering violation. Move it to e.g. `src/security/tool-capability.ts` — one taxonomy importable by any
> autonomous agent (same anti-drift move as extracting `isSecretKey` out of `cli/` into `utils/`).

### Three GATE postures (architect's key reframing) — `armed ≠ supervised`

The gate has **three** postures, not two. Today's armed MD-G is the *weaker* one:

| Posture | Gate | On operator absence | What it is |
|---|---|---|---|
| **autonomous** | disarmed | — (no gate) | the default |
| **monitored** | armed, **fail-OPEN** | auto-**ALLOW** (45s lazy auto-allow, R3 maintainer-locked) | **today's MD-G** — "let the operator *catch + override* if watching," not "block until approved" |
| **supervised** | armed, **fail-CLOSED** | auto-**DENY** | **NEW** — "the human MUST approve dangerous ops" |

So **today's `armed` is *monitored*, not *supervised*.** True supervised (auto-denies on absence) does
not exist in MD-G yet — it's a new, stricter fail-mode. Preserve MD-G's fail-open as the default for its
current monitored role; **add** fail-closed as a per-arm option that the `supervised` policy sets.

### One policy, two confirm transports — modality-branch is REQUIRED (not just cleaner)

- **Headless agent (conductor)** → the **MD-G operator gate** with the **fail-closed** flag.
  `classify()` non-low-risk → held in `GateRegistry` → operator decides remotely.
- **Interactive agent (planner)** → **`ctx.ui.confirm` in-session.** ★ This is *mandatory, not
  stylistic*: `gate-client` **structurally no-ops to `allow` when there's no ingest token** (`gate-client.ts`:140),
  and interactive Pi has no token — so routing the planner through the remote gate would **silently
  allow everything.** The local confirm is the only correct transport. (Same headless-auto-vs-interactive-
  operator-mediated asymmetry as the #677 reset ruling — cite that precedent.)

### ★ Fail-mode = a property of the policy (LOCKED)

- **MD-G's fail-open is intentional and correct for `monitored`** — its job is observability/intervention
  on an otherwise-autonomous agent; wedging an unsupervised agent on an absent operator would be worse.
  **PRESERVE it; do not change shipped MD-G.**
- **`supervised` = FAIL-CLOSED.** Opting into supervision means *"don't do dangerous things without my
  explicit yes"* — so silence ≠ consent; on timeout / daemon-down a `high-blast`/`exec` op **DENIES**.
- **DENY, don't HANG (conductor constraint 1):** on timeout the op is cleanly **denied** ("denied —
  operator absent"), the agent adapts (proceeds with non-dangerous alternatives / surfaces that it's
  blocked) — it does **not** block indefinitely (that would wedge the conductor). Fail-closed = auto-deny,
  not deadlock. (Architect sub-decision (i): auto-DENY, liveness-preserving — locked.)
- **Add the fail-mode as a per-arm flag (conductor constraint 2):** implement supervised by threading a
  `failMode: 'open' | 'closed'` through `awaitDecision` + the daemon resolution; supervised-arm sets
  `closed` (timeout/daemon-down → `deny`, currently hardcoded `allow`). **Do not flip MD-G's global
  default** — monitored uses stay fail-open.
- **Longer / notify-augmented timeout (architect sub-decision (ii)):** MD-G's 45s is too short for a
  remote human to approve, and under fail-closed a too-short timeout auto-denies *legit* ops. Supervised
  wants a longer timeout + an operator notification on a pending request. (Exact value TBD in P2 build —
  flagged.)
- **Fail-closed on daemon-DOWN safes the whole dangerous surface** when the approval channel is
  unreachable — correct guardrail posture (safety > liveness for the dangerous subset). Stated explicitly
  so it's a chosen property, not a surprise.

### Planner nuance (note, not imposed)

The planner is **interactive + top-authority**: it holds T3 and operates the gate itself — no operator
above it, so it could disarm its own gate. Per vinceblank + consistency, **the planner defaults to
`autonomous`** (floor = autonomous-default for both). Documented option: defaulting the planner's
**irreversible ops only** (`destroy`/`reset`) to confirm — even in `autonomous` — is a **one-line policy
default** if wanted later. ~Free (interactive → local `ctx.ui.confirm`) and closes the "AI-operator
disarms its own gate" hole. Not imposed now; flagged as a cheap future tightening.

### Why this is the honest design
- **Consistency** — conductor and planner obey the *same* model; one knob to learn.
- **Single-source / anti-drift** — `classify()` and the MD-G gate are *reused* (classify adopted
  verbatim; gate gains one fail-mode flag), never paralleled. No second danger list to drift.
- **Autonomy-first** — default is fully independent; supervision is something a human *adds*, never a
  default tax. And the model honestly names that today's armed MD-G is *monitored*, with *supervised* as
  a deliberate new stricter posture.

---

## 7. How it extends `src/pi/mission-control/extension.ts`

The existing extension already has the lifecycle skeleton (`session_start` → open coarse SSE + render
tick + register commands; `session_shutdown` → teardown) and the `Controller` command pattern. Bootstrap
adds a thin layer:

**`MissionControlActions` (actions.ts) — add the bootstrap + Q&A methods:**
```ts
createEnsemble(opts: { name; lineup?; startMode?; conductorInstructions? }): Promise<ActionResult>
  → POST /v1/ensembles                              // handleCreateEnsemble (exists)
recruit(opts: { name; workDir?; playerType?; host?; agent? }): Promise<ActionResult>
  → POST /v1/ensembles/:e/recruit                   // handleRecruit (route exists)
shutdownEnsemble(destroy?: boolean): Promise<ActionResult>
  → POST /v1/ensembles/:e/shutdown                  // NEW endpoint (see below)
ask(opts: { target; question; questionId }): Promise<ActionResult>
  → POST /v1/ensembles/:e/ask                       // NEW — cue + correlation (see §4)
readAnswer(questionId): Promise<{ answer; from } | null>
  → GET /v1/ensembles/:e/answer/:questionId         // NEW — maestroGetAnswer proxy (see §4)
```

**`ensureInfra()` — a new module the extension calls before the first action:**
```ts
// Reuses cli/daemon.ts (isDaemonRunning / startDaemon) + up()'s Temporal-start block,
// refactored into one shared helper so CLI and extension don't drift.
async function ensureInfra(): Promise<{ config; temporal: 'up'|'started'; daemon: 'up'|'started' }>
```
This is the one place ruling-(b) lives: `isDaemonRunning() || await startDaemon(config)`. Because
`startDaemon` already spawns detached + unref'd, the daemon outlives the Pi window for free.

**⚠️ The one load-bearing behavioral shift — config/env (researcher finding).** Today `agent-tempo up`
is what wires the `AGENT_TEMPO_*` env. On the normal `.pi` path the user runs **bare `pi`** — so
**`AGENT_TEMPO_*` is NOT set.** The extension therefore must **self-resolve config via `getConfig()`**
(which reads `~/.agent-tempo/config.json` + defaults) rather than depend on env injection, and when it
spawns the detached daemon it must hand the daemon an **explicit env built from that resolved config**
(`startDaemon` already does this — it spreads `process.env` + sets the Temporal vars; the change is that
the extension can't assume the operator pre-set them, so the resolved config is the source of truth).
This is the single biggest departure from the CLI-driven bootstrap and `ensureInfra()` must own it.
(Provider auth — `ANTHROPIC_API_KEY` / Pi `auth.json` OAuth — is separate: Pi resolves it; the
extension inherits Pi's `process.env` and doesn't manage it. `ctx.cwd` gives the session cwd for
project resolution.)

**`Controller` — add command handlers** (mirroring the existing `cmdCue`/`cmdPause`/… pattern):
- `cmdEnsembleUp`, `cmdRecruit`, `cmdEnsembleDown` — bootstrap; each calls `ensureInfra()` (idempotent)
  then the matching `actions` method, then `notify()`s the result. The board self-updates from the SSE
  it already consumes, so no manual board mutation is needed.
- `cmdAsk <player> <question>` — the planner→player Q&A (§4): mint `questionId`, `actions.ask(...)`,
  then poll `actions.readAnswer(questionId)` with status feedback until the answer lands (or TTL). This
  is what lets the planner *think with* the ensemble — ask a player and get a correlated answer back
  even though the command center has no inbox.
- `cmdHandoff [player]` — the plan-handoff: push the current plan to the (headless, durable) conductor
  via a cue (or a coat-check ticket for a large plan). The explicit planner→executor seam.

**`createMissionControlExtension` — register the new commands** (`/ensemble-up`, `/recruit`,
`/ensemble-down`, `/ask`, `/handoff`, and `/board` — the full-board `custom({overlay})` expander, §5.3)
alongside the existing nine, in the `session_start` block.

**The one new daemon endpoint:** `POST /v1/ensembles/:e/shutdown` for `/ensemble-down`. Today the write
surface has no ensemble-teardown verb (the CLI `down` + the `shutdown` MCP tool cover it, but neither is
HTTP). Options: (a) add a `shutdown`/`down` action to `WRITE_ACTIONS` + `handleWriteRoute` shimming
`client.shutdown(...)`; or (b) have `/ensemble-down` fan-out per-player `destroy` from the extension.
**Recommend (a)** — one clean endpoint, mirrors how `handleCreateEnsemble` pairs create with teardown,
and keeps the destructive fan-out server-side where it belongs.

---

## 7A. Build surface — P1 (build-ready now) vs P2 (build-ready on P1 landing)

> vinceblank greenlit this as a **classic feature build**, phased. P1 = bootstrap + install (eng
> building now). P2 = the planner (this spec is build-ready so it can start the moment P1 lands).

### P1 — bootstrap + install (eng is implementing now)

**New code (all additive, Pi-extension-side + one HTTP route):**
- `src/cli/ensure-infra.ts` (new) — `ensureInfra()`: `getConfig()` self-resolve → ensure Temporal
  (lift `up()`'s detached `temporal server start-dev` block) → `isDaemonRunning() || startDaemon(config)`.
  **Connect-only — never registers MCP** (that's cut). Shared by CLI + extension so they don't drift.
- `src/pi/mission-control/actions.ts` — add `createEnsemble`, `recruit`, `shutdownEnsemble` (the
  bootstrap subset of the method table above).
- `src/pi/mission-control/extension.ts` — `cmdEnsembleUp` / `cmdRecruit` / `cmdEnsembleDown` handlers +
  registration; each calls `ensureInfra()` then the action.
- `src/pi/install.ts` (new) — `installPiExtensions({ project? })`: idempotent merge of the two **absolute
  dist paths** into `~/.pi/agent/settings.json` (or `.pi/settings.json`). **Install-by-reference, never
  copy** (loose copy breaks `@temporalio/*` resolution). Surface as `agent-tempo install-pi` CLI verb.
- `src/http/writes.ts` — add `'shutdown'` to `WRITE_ACTIONS` + a `handleShutdown` shim to
  `client.shutdown(ensemble)`.
- `package.json` — add the `pi` manifest array (both extension paths) for the publish-a-package path.

**Reused verbatim:** `handleCreateEnsemble` (POST /v1/ensembles), `startDaemon`/`isDaemonRunning`, the
mission-control SSE board, the Pi player runtime (headless conductor = recruit `agent:'pi'`).

**P1 review bar:** strict `tsc` both configs · CI-collection on new tests (mocha `test/` + vitest
`tests/` — grep both) · install **idempotency + no-loose-copy** invariant unit-tested · `ensureInfra`
is **connect-only** (asserts it never calls the MCP-register path).

### P2 — the planner (build-ready interfaces below)

**Maestro Q&A mailbox** (`src/types.ts` + `src/workflows/maestro-signals.ts` + `src/workflows/maestro.ts`)
— clone the coat-check shape:
```ts
// types.ts
export interface AnswerEntry { questionId: string; from: string; text: string; answeredAt: string; }
// maestro-signals.ts  (additive — update WIRE-PROTOCOL.md same commit)
export const maestroPostAnswerUpdate =
  defineUpdate<{ stored: true }, [{ questionId: string; from: string; text: string }]>('maestroPostAnswer');
export const maestroGetAnswerQuery =
  defineQuery<AnswerEntry | null, [string /* questionId */]>('maestroGetAnswer');
// (optional) maestroPostQuestionUpdate — record pending asks for audit/reconnect
// maestro.ts: answers: Record<questionId, AnswerEntry> on state; TTL-swept in sweepExpired*;
//             CAN-carried in MaestroInput.answers (carry-only-when-non-empty, like coatCheck)
```
**Player-facing `respond` tool** (`src/tools/respond.ts` new) — calls `maestroHandle.executeUpdate(
maestroPostAnswerUpdate, …)` **directly on the maestro handle**, exactly like the `coat_check_*` tools
(shared-store write, not a peer signal → outbox invariant untouched). `from` = `getPlayerId()` (no
spoofable arg, like coat-check's `putBy`). Registered in `server-tools.ts` so it lands on both the
native Pi surface and (classic) MCP.

**Daemon ask/answer routes** (`src/http/writes.ts` or a new `qa.ts`):
- `POST /v1/ensembles/:e/ask` `{ target, question, questionId }` → cue the target (carrying `questionId`
  + a "respond via the `respond` tool" instruction). 202.
- `GET /v1/ensembles/:e/answer/:questionId` → proxy `maestroGetAnswerQuery` → `AnswerEntry | null`.

**SSE answer-wake** (`src/http/event-types.ts` + `aggregate.ts` + `src/pi/mission-control/`):
- Add a `TempoEvent` variant `{ type: 'answer', questionId, from, ts }` (text fetched on read — keep the
  event small).
- The aggregate poll loop diffs the maestro `answers` map and emits the event when a new entry appears.
- The command-center SSE handler, on `answer`, **wakes the planner**: `session.sendCustomMessage({
  customType:'answer', content }, { triggerTurn:true })` — the planner-side mirror of the cue-pump wake.

**Planner tool surface** (`src/pi/mission-control/extension.ts`) — register the verbs as **Pi tools**
(`registerTool`, alongside the human `registerCommand`s): `ask`, `handoff`, `cue`, `recruit`,
`observe_board` (returns the `BoardModel` snapshot as text). `ask` is **yield-not-poll**: the tool POSTs
and returns immediately; the SSE wake resumes the turn.

**Guardrail (unified model, §6)** — one per-agent policy (`autonomous` DEFAULT / `supervised` /
`observe-only`) + one classification (reuse `tool-capability.ts → classify()`, extended to orchestration
verbs). `autonomous` (default) = no gate. `supervised` gates **non-low-risk** ops: headless conductor →
the **existing MD-G `GateRegistry`** (arm == supervised); interactive planner → `ctx.ui.confirm`
in-session (T3 token attached post-confirmation). **No new mechanism** — generalize MD-G + `classify()`.
**[MD-G: coordinating with tempo-architect]** on per-agent arm state + the fail-open→fail-closed override
for `supervised`.

**`/handoff`** — cue flagged `customType:'plan-handoff'` (small) or coat-check ticket (large); the
conductor agent definition (`examples/agents/*conductor*.md`) gains the "on plan-handoff →
set_ensemble_description → recruit/assign → quality_gate/stage → orchestrate" instruction.

### Consolidated wire additions (P2 — all additive; update `docs/WIRE-PROTOCOL.md` same commit)

| Kind | Name | Direction |
|---|---|---|
| Maestro update | `maestroPostAnswer` | player → maestro |
| Maestro query | `maestroGetAnswer` | planner → maestro (via daemon) |
| Maestro update (opt) | `maestroPostQuestion` | daemon → maestro (audit) |
| Maestro state | `answers: Record<questionId, AnswerEntry>` (CAN-carried, TTL-swept) | — |
| MCP/Pi tool | `respond` (player) | — |
| HTTP | `POST /ask`, `GET /answer/:id`, `POST /shutdown` (P1) | — |
| SSE event | `answer { questionId, from, ts }` | daemon → command center |

No renames, no removals — additive only.

### Build decisions — v1 DEFAULTS (conductor-endorsed 2026-06-06; lock for build)

1. **`maestroGetAnswer` = QUERY + TTL** (not consume-once). Idempotent reads + TTL-sweep mirror
   coat-check — simpler and reconnect-safe (a reconnecting planner can re-read its answer).
2. **Answer-wake = POLL for v1.** The daemon aggregate loop already polls maestro for the board — reuse
   it to emit the `answer` SSE event. A maestro→daemon push is a later optimization (same call made for
   the cue-pump in #677). Latency is free because the planner yielded.
3. **Confirmation UI = `ctx.ui.confirm` for v1.** Native Pi blocking confirm is right + unambiguous; a
   richer board-rendered approval row is a polish follow-up.
4. **`respond` addressing = EXPLICIT tool for v1.** The player calls `respond({questionId, text})`
   explicitly; no auto-routing a reply by inferred correlation. Explicit > fuzzy (the #688-era lesson);
   auto-route is a later ergonomic if wanted.

---

## 8. Distribution — installing the extensions the `.pi` way (resolved)

All `[VERIFY]` items here are now **resolved** against tempo-researcher's Pi 0.78.1 install-model
findings (bundled `docs/extensions.md` / `docs/packages.md` / `docs/settings.md`). Pi has a first-class
extension-discovery + package-manager system; "install agent-tempo the normal Pi way" is fully
supported and is the right call (`pi -e <deep path>` is explicitly the "quick test only" path).

### How Pi loads extensions (the mechanics)
- **Auto-discovery, no settings entry:** `~/.pi/agent/extensions/*.{ts,js}` (+ `*/index.*`) globally,
  `.pi/extensions/*.{ts,js}` per-project. TS loads without compilation (jiti). Project scope wins on
  dedup over global.
- **Explicit settings:** `~/.pi/agent/settings.json` (or `.pi/settings.json`) with
  `"extensions": ["/abs/path"]` and/or `"packages": ["npm:…","git:…"]`.
- **Package manager:** `pi install npm:@scope/pkg | git:… | /abs/path`, `pi remove`, `pi list`,
  `pi config` (enable/disable). A Pi package declares a `pi` manifest in `package.json`.
- **Multi-extension coexistence is first-class** — event handlers chain in load order; if two register
  the same command name, Pi keeps both with numeric suffixes (`/cmd:1`, `/cmd:2`). So the agent-tempo
  player ext + command-center ext + the user's own extensions all run side-by-side.

### ✅ One package → two extensions — YES
agent-tempo ships **both** entry points from one install via a manifest array:
```json
"pi": { "extensions": ["./dist/pi/extension.js", "./dist/pi/mission-control/extension.js"] }
```
Each file is `export default function (pi: ExtensionAPI) { … }`. The command-center ext stays
observer-only; the player ext claims attachment; both gate on `ctx.hasUI` / `ctx.mode`.

### ✅ Detached daemon spawn from extension code — YES
Extension code is **plain in-process Node with full host permissions** (`containerization.md`:
"Extensions run wherever the `pi` process runs"). Pi imposes no sandbox by default — `spawn(daemonEntry,
args, { detached: true, stdio: 'ignore' }).unref()` works and survives Pi exit. **This is exactly the
`src/cli/daemon.ts → startDaemon` pattern — reuse it verbatim**, calling our own helper directly (no
shelling out to the `agent-tempo` CLI). *Caveat to name:* if the user launched `pi` inside an OpenShell
process-sandbox (opt-in, non-default), the spawned daemon inherits that boundary — edge case, flag it.

### ✅ Recommended install mechanism — settings-path write (preserves dependency resolution)
The **load-bearing constraint** the researcher surfaced: our extension imports the agent-tempo dist,
which imports `@temporalio/*`, `croner`, etc. Those resolve via Node's upward `node_modules` walk —
which only works if the extension file sits **inside the installed agent-tempo package**. Therefore:

- **DO (recommended): install-by-reference.** An `agent-tempo install-pi-extensions` step idempotently
  merges the **absolute dist paths** (`…/agent-tempo/dist/pi/extension.js` +
  `…/dist/pi/mission-control/extension.js`) into `~/.pi/agent/settings.json` `"extensions"` (or
  `.pi/settings.json` with `--project`). Node's walk from that path finds
  `…/agent-tempo/node_modules/@temporalio` — **resolution intact, zero copying.** Plain `pi` then
  auto-loads both.
- **OR: publish a proper Pi package** (`pi install npm:@agent-tempo/pi`) with Pi's core packages
  (`@earendil-works/pi-ai`, `pi-coding-agent`, `typebox`, …) as `peerDependencies: "*"` (don't bundle)
  and our runtime deps in `dependencies` (Pi runs `npm install` in the package's own module root). Most
  idiomatic + gallery-listed; most work.
- **DON'T: copy a loose file** into `~/.pi/agent/extensions/agent-tempo.js` — there's no `node_modules`
  beside it, so our bare `@temporalio/*` imports **fail**. This is the one install method to avoid.

### ✅ Long-running command handlers — fine
`registerCommand` handlers are `async` and awaited with **no documented timeout**; a multi-second
`/ensemble-up` is acceptable. UX rule: don't freeze the editor — stream progress via `ctx.ui.notify` /
`ctx.ui.setStatus` ("daemon starting… workers up… ensemble live"); the board's render tick + SSE is the
natural surface for it.

---

## 9. Classic or fork? — **shippable in CLASSIC today, as the first Pi-native step**

This does **not** require the fork. Every load-bearing piece exists in classic agent-tempo right now:
- `handleCreateEnsemble`, the write surface, `handleRecruit` — all in `src/http/`.
- `startDaemon` / `isDaemonRunning` — in `src/cli/daemon.ts`.
- The mission-control extension — already in `src/pi/mission-control/`.
- The Pi player + headless runtime — already in `src/pi/`.

The net-new work (the two `MissionControlActions` methods, `ensureInfra()`, three command handlers, one
`/shutdown` endpoint) is **purely additive** and Pi-extension-side. Nothing here demands deleting the
adapter layer or the MCP server.

**This is the strategically ideal first step:** it lets vinceblank *feel* the "Pi is the front door"
UX — install via `.pi`, `/ensemble-up`, drive the whole ensemble from one Pi TUI — **inside the current
codebase**, before committing to the fork. If the UX lands, the fork becomes "delete everything this
flow doesn't use." If it doesn't, nothing was forked prematurely. The bootstrap *validates the thesis*
of the fork without paying for it.

One classic-only nuance: in classic, recruited players can be any adapter. The command-center bootstrap
simply recruits `agent: 'pi'` (or whatever the lineup specifies) — it works identically; it just happens
to be the all-Pi path the fork would later make the only path.

---

## 10. Open questions & risks

The two big distribution unknowns (detached-spawn, install model) are **resolved** (§8). What remains
are design calls + handshakes, not feasibility doubts.

### ✅ Resolved
- **Detached daemon spawn from inside Pi** — confirmed: extension code is plain Node with full host
  permissions; `spawn(..., { detached: true }).unref()` works and survives Pi exit (reuse
  `startDaemon`). Only the opt-in OpenShell sandbox wraps it (edge case, §8).
- **Install model + one-package-two-extensions + long async handlers** — all confirmed (§8).

### ⚠️ The named design change (own it, don't treat as a risk): config/env under bare `pi`
Bare-`pi` launch means **no `AGENT_TEMPO_*` env** — the extension self-resolves config via `getConfig()`
and passes explicit env to the spawned daemon (§7). This is *the* behavioral shift from CLI-driven
bootstrap. It's fully tractable (the config file + defaults exist), but every bootstrap codepath must
route through the resolved config rather than reading env — so it's called out as a design invariant,
not left implicit.

### Open calls for vinceblank
1. **Who starts Temporal?** The daemon needs Temporal reachable; `up()` starts a dev server. For a true
   "Pi is the front door" UX, `ensureInfra()` should ensure Temporal too (reuse the `up()` detached
   `temporal server start-dev` block) — *or* Temporal is an install prerequisite / managed Cloud
   endpoint. **Needs his call:** auto-start Temporal from the extension (seamless, but pulls the
   `temporal` CLI dependency into the in-Pi flow), or treat it as a prereq?
2. **Admin token bootstrapping.** `MissionControlActions` needs the T3 admin token
   (`AGENT_TEMPO_HTTP_ADMIN_TOKEN`) to POST *writes* (create-ensemble is a write; loopback-no-auth only
   covers reads). Clean fix that rides the config/env shift above: when `ensureInfra()` spawns the
   daemon, it **generates the admin token and passes it in the explicit env**, then holds it in-process
   for the actions client — so the extension and the daemon it spawned share a token by construction, no
   file-scraping race. (For an *already-running* daemon it spawned earlier, read it back from
   `~/.agent-tempo/`.) **Needs a small token-handshake design.**
3. **Conductor headless-vs-interactive** (§3) — defaulting the conductor to headless is my
   recommendation (the command center is the human's seat); confirm that matches his mental model, or
   add an `--interactive-conductor` opt for a visible Pi conductor window.
4. **Error surfacing in the board.** Bootstrap failures (Temporal down, daemon spawn failed, lineup
   400) must render legibly in the command-center widget, not just `notify()` toasts that scroll away —
   the difference between "magical" and "frustrating" on first run. Drive progress + errors through
   `ctx.ui.setStatus` / the board's render tick (§8).

---

## 11. Bottom line

The "Pi is the front door" bootstrap is **~80% existing machinery wired to new slash-commands.** The
ensemble-creation HTTP endpoint, the detached-daemon spawner, and the observer board all already exist;
the spike adds a daemon-ensure step, a create/recruit/shutdown/ask client surface, a handful of command
handlers, one teardown endpoint, and a maestro Q&A mailbox that **clones the proven coat-check pattern.**

The shape is a clean **planner/executor split**: the command center is an *interactive Pi planner with
its own LLM* that you think *with* — it orchestrates and observes but is **never a player** (no
attachment, no inbox) — and it hands off plans to the *durable headless conductor* that executes and
outlives the planner window. The one genuinely interesting design question — how a player answers the
inbox-less planner — resolves elegantly to **route through maestro**, the ensemble's addressable
rendezvous, which already implements exactly this mailbox shape for coat-check: correlated, durable, and
cross-host where the tail-firehose and a daemon-side broker are none of those. And critically,
**it's shippable in classic agent-tempo today** as the first concrete Pi-native step — the lowest-risk
way to prove vinceblank's "Pi as the front door" thesis before the fork.

The operating model is now specced to the "how it runs" layer: the planner exposes every verb **both**
as a human slash-command and a planner-LLM tool; `/ask` is **yield-not-poll** (fire → yield → an SSE
`answer` event wakes the planner's turn via `triggerTurn`, the planner-side mirror of how cues wake
players); the board **coexists with live conversation in one TUI** (Pi-confirmed — its own `plan-mode`
pattern; compact widget + on-demand `/board` overlay); and guardrails follow a **unified, autonomy-first
model** (§6): every autonomous agent — conductor and planner alike — defaults to **fully autonomous**
(vinceblank's hard requirement: hands-off orchestration is the point), with **opt-in** `supervised` /
`observe-only` policies that **reuse the existing MD-G gate + `classify()`** (no parallel mechanism) —
so supervision is something a human *adds* when wanted, never a default tax, and there's one knob to
learn across both agents.

The distribution unknowns are now **resolved** (§8): Pi natively supports normal-Pi-way install (one
package ships both extensions; install-by-reference via a settings-path write preserves our Temporal
`node_modules` resolution; the one method to avoid is a loose file copy), and a detached daemon spawn
from extension code is a plain-Node operation that reuses `startDaemon` verbatim. What's left is a small
set of design calls — the config/env shift under bare `pi` (the one real behavioral change, fully
tractable), plus two handshakes (who starts Temporal, admin-token passing) that ride the same
explicit-env-at-spawn path. Nothing in the core flow is speculative; it's assembly.
