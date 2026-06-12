# v2.0-beta Scoping — Simplification + Ease of Use

> **Status**: SCOPING — the doc the next quarter executes against. Operator decision points in §E.
> **Author**: tempo-architect · 2026-06-12 · scoped against main @ `7a7556d9` (post-#734).
> **Operator-confirmed pillars**: (1) TUI eliminated — CLI + Pi command-center are the only
> operator surfaces (cost-doc B1; the operator sign-off previously flagged as required is now
> given; closes #95 by mooting it); (2) breaking changes allowed — wire-protocol 2.0 may
> remove/rename; (3) workflow clean-slate — all `patched()` markers and the legacy branches
> they guard removed.
> **Constraint**: the in-flight 1.x critical path (#777, #774, #768, T1.1 PR-2/3) completes on
> 1.x main first — nothing here disturbs it.
> Researcher's debt inventory (2026-06-12 sweep) is integrated throughout — **source of
> record: [PR #779 comment "2.0 debt inventory"](https://github.com/vinceblank/agent-tempo/pull/779#issuecomment-4694637520)**
> (includes caveats; counts spot-checked by them, not line-audited). Their synthesis
> independently converges on §A's conclusion: one drain/cutover gate is the
> highest-leverage decision in the release.

---

## A. The migration story (designed first — it constrains everything else)

### A.1 The problem, precisely

**17 `patched()` markers** exist today (researcher census: 11 replay-only no-ops —
v0.10…v0.26 stack in session.ts:198-212 + maestro's v0.17/v0.18 + stages — and 6 conditional:
v0.12-cron-schedule, v0.19-ensemble-chat, v0.20-response-requested-blocked,
v0.26-can-lease-from-attachment, v1.8-sa-diet ×6 sites, v1.8-memo-observation-fields; zero
`deprecatePatch` anywhere). They fire **eagerly on every new run**, so every 1.x run's history
carries marker records. The two v1.8 markers are the youngest and most likely to be straddled
by live runs at upgrade time — which is precisely why a cutover gate (A.3) that makes
straddling impossible beats reasoning about each marker's drain state individually. Removing the `patched()` calls means a 2.0 worker **cannot replay any
1.x-recorded run** — and our session/maestro/scheduler workflows are deliberately long-lived
(they never complete; they `continueAsNew`), so 1.x histories never age out on their own.
The same boundary problem applies to every other 2.0 removal: the legacy-SA dual-read
(pre-v1.8 runs), the `pendingReset`/`pendingMessages`-era queries old pumps poll, v0.25 shim
fields, and `MaestroInput`/`SessionInput` legacy field tolerance. **One protocol must clear
them all.**

### A.2 Option A1 — in-place upgrade via the `deprecatePatch` ladder (textbook Temporal)

2.0 deletes every legacy **branch** but swaps each `patched('x')` for `deprecatePatch('x')`
(18 one-liners). 2.0 workers can then replay 1.x histories (markers present and accepted);
2.1 removes the `deprecatePatch` lines once every run has CAN'd at least once under 2.0.
Pre-conditions: every live run's current execution must have recorded every marker — true for
any run started/CAN'd on a recent 1.x (markers are eager), but ancient dormant runs predating
a marker's introduction would non-determinism-fault and need terminate-or-flag handling at
reconcile.
**Cost**: a two-release ladder; the replay-compat test matrix stays alive through all of 2.0;
"clean slate" is ~95% (branches gone, 18 marker lines linger); every OTHER legacy tolerance
(SA dual-read, old-pump queries) still needs its own individual drain story.

### A.3 Option A2 — clean cutover with guard rails ⭐ RECOMMENDED

**Rule: a 2.0 worker never sees a pre-2.0 run.** Mechanism, all three parts cheap:

1. **Stamp**: 2.0 workflows record `protocol: 2` in their start input + memo
   (`AgentTempoProtocol`). All 2.0-started runs are identifiable from visibility.
2. **Guard**: the 2.0 daemon's boot preflight (the sa-preflight slot) scans for Running
   agent-tempo workflows without the stamp → **refuses to start workers**, printing the
   migration command. No silent replay faults, ever — the failure is at boot, loud, with a
   remedy.
3. **Cutover verb**: 1.x-final (§D) ships `agent-tempo upgrade-to-2`:
   pause ensembles → drain outboxes → snapshot continuity state (lineups via `save_lineup`;
   players nudged to `save_state` — **#334 was designed as exactly this continuity story**)
   → `shutdown --destroy` all workflows (they COMPLETE; histories become irrelevant to
   replay) → operator installs 2.0 → `agent-tempo up --from-upgrade` recreates fresh
   protocol-2 workflows from the snapshot.

**Why A2 wins**: agent-tempo sessions are ephemeral *coordination* state, not
business-critical event history — operators already destroy/recreate ensembles routinely
(this week's logs are full of it), and the saveable-state + lineup machinery exists precisely
to make recreation cheap. A2 clears **every** legacy tolerance simultaneously and for free:
post-cutover there is no pre-v1.8 workflow (SA dual-read fallback: delete; memo dual-read
TODO in `utils/search-attributes.ts`: execute), no old pump attached to a 2.0 workflow
(`pendingReset` + superseded queries: delete), no v0.25-shim sender. A1 pays a two-release
tax to preserve in-place upgrades of sessions nobody needs preserved.

### A.4 Mixed-version edges (apply under either option)

- **Cross-host**: adapters + daemon ship in one package, but multi-host clusters can skew.
  2.0 adds `protocolVersion` to `claimAttachment` (a 2.0-wire field — breaking is allowed);
  2.0 workflows reject v1 adapters with an actionable error, and `hosts` already surfaces
  per-daemon versions (`hostProfile.version`) for skew diagnosis. Upgrade order: all hosts'
  daemons before any ensemble comes back up — documented, and the recruit host-preflight can
  enforce (version floor on the advertised profile).
- **`~/.claude-tempo` shim** (`legacy-migration.ts`): deleted in 2.0. 0.x users hop through
  1.x-final — same hop the cutover already requires.
- **Legacy `ClaudeTempo*` search attributes**: already unregistered-by-default post-T0.5;
  2.0 ops note tells operators to drop them; the #775 matcher's pre-rebrand marker is
  retired per its recorded debt trigger (this IS the rebrand-playbook checklist firing).
- **Env names**: rebrand leftovers (`CLAUDE_TEMPO_DEV_MODE`, friends) unify to
  `AGENT_TEMPO_*` in 2.0-beta.1; dual-reading dropped (§C.3).

---

## B. TUI retirement path

**The plan of record already exists — #742 (approved D3).** The 2.0 pillar changes its
*schedule*, not its content: "after P0 gaps close, ~1–2 minors" becomes "deletion lands in
2.0-beta.1; P0 gap closure is 1.x-side work that starts now."

- **The 9 P0 gaps** (from #742, each "1 actions-client method + 1 command + a renderer";
  ~8–12 daemon read routes total in the existing pattern): multi-ensemble re-bind (**largest
  single gap**), recall/scrollback, broadcast (trivial), migrate, hosts, attachment-info,
  schedule CRUD (conversational, no wizard port), restore+go, human `/status` overlay.
  Already at parity: cue, pause/play, restart, destroy, reset, recruit, shutdown, live board,
  conductor bootstrap. P1 items (gates/stages/worktree/lineup/search views) close during the
  beta window; P2 (wizards, palette, theming) are explicitly never ported.
- **CLI absorption**: minimal — most TUI-only verbs already have CLI homes (`hosts`,
  `restore`, `status`). Researcher confirms exactly **one external importer**: `cli.ts:755`
  (~32-line dynamic import) — the amputation is clean. But that import site is also the
  **bare-command default**: today bare `agent-tempo` bootstraps then launches the TUI, so 2.0
  must pick a new default (decision point §E.8). Droppable deps: `ink` ×3, `react`,
  `@types/react`; `qrcode-terminal` only after verifying the dashboard pairing-QR path
  doesn't share it.
- **Web dashboard: STAYS** (recommendation = reaffirm D3's recorded decision): it is the
  zero-dependency fallback surface — mission-control needs the optional Pi dep + Node ≥
  22.19, while daemon/players stay Node 20. Deleting two surfaces in one breaking release
  maximizes regret-risk for marginal extra simplification; revisit in 2.x with usage signal.
  (Operator decision point §E.3 if they want max-deletion instead.)
- **Deletion payload** (2.0-beta.1): `src/tui/` (~9.3k LOC), 21 test files (incl. the 19
  CI-quarantined Vitest failures — deleted, not fixed, per D3), `ink`/`react`/`ink-*` deps
  (tarball + install win), `docs/tui.md` + `docs/tui-performance.md`, README surgery,
  `#288`-style removed-verb hints for TUI launch verbs.

---

## C. Simplification beyond the confirmed pillars

### C.1 B3 tool merges (43 → ~35–37)
Breaking-allowed changes the calculus: aliases are no longer load-bearing. Recommendation:
merge coat-check ×4→1, state ×3→1, schedule ×3→1, stages ×2→1, gates partially (create vs
evaluate stay distinct) — via the transport-neutral descriptor layer; ship **one beta with
descriptor aliases** for muscle-memory migration, drop aliases at 2.0 GA. Do NOT merge
high-frequency distinct tools (cue/report/ensemble) — tool-selection accuracy beats registry
size there. Net: ~1,000 LOC and ~8 fewer registered tools × every player's context, effort S
per family and fully parallelizable (researcher). Their extras, adopted: `migrate` is
`restart --host` sugar (fold); `listen` deprecates post-T1.1 (the doorbell makes the one-shot
drain pointless); `set_name` folds into an identity tool; audit which tools existed only to
serve the TUI.

### C.2 B2 attachment-core extraction — sequencing reaffirmed, window assigned
2.0 does not change the *order* (post-T1.1: the doorbell PR-2/3 rewrite the poll loops —
extracting before they settle means extracting twice). It does provide the right *window*:
internal churn is invisible to users and betas absorb risk. **2.0-beta.2+ candidate, never
beta.1.** Pi's event-driven phase model remains the direction; the target is a shared
`attachment-core` consumed by both stacks, not forcing Pi under BaseAttachment.

### C.3 Config + surface trim
- Env unification: `CLAUDE_TEMPO_*` → `AGENT_TEMPO_*`, single names, no dual-read (2.0-beta.1).
- Delete (researcher's shim census, integrated): `legacy-migration.ts` — note the nuance:
  dropping it breaks 0.x→2.0 DIRECT upgrades, which §A.3's cutover already forbids, so drop
  + document the 1.x hop (the protocols align); `removed-verbs.ts` (9 of its 10 hints point
  at the TUI — wrong after deletion anyway; replace wholesale with TUI-era hints for one
  release, then delete); `tui/removed-commands.ts` (dies free); the `httpToken` single-token
  shim (auth.ts:116-185 + server.ts:127 + config.ts:300 → readToken/adminToken only);
  `hosts.ts:94-110` legacy poller-identity; `daemon-command.ts:406-445` claude-tempo
  service-file cleanup; `CLAUDE_TEMPO_DEBUG` (grpc-shutdown-guard.ts:59); the migration
  marker file; pre-rebrand matcher marker (#775 recorded debt trigger — this rebrand-playbook
  item fires here); copilot pid-file fallback (hard-terminate.ts:78-83, TODO-v1.7); legacy
  `./logs` fallback (commands.ts:2020,2056); 6 rebrand string leftovers. Ops docs:
  v0.26-migration deletable now; v1.0 rebrand doc kept as rollback reference; sa-diet doc
  becomes the 2.0 SA-drop runbook.
- Wire-protocol 2.0 document: regenerate WIRE-PROTOCOL.md as v2. Researcher's 9-item
  deprecation list adopted: `pendingReset` query (#762's recorded deprecation), the SA
  dual-read fallback (search-attributes.ts:149 TODO, 3 call sites), the 4 LEGACY SAs +
  operator drop runbook, guardrailPolicy note verification (#743), plus the maestro V1
  refresh activity (maestro.ts:114 TODO(#748)) and superseded two-call patterns
  (`hostProfiles` where `hostProfilesWithExistence` won). Drift-detector `SECTION_TO_KIND`
  updated in the same commit per process. SSE surface confirmed clean — no v2 removals.

### C.4 New-user roughness (ease-of-use half of the theme)
- **SA preflight remains the #1 onboarding wall** (cap collisions, manual `temporal operator`
  commands). T0.5 cut required SAs to 5; 2.0 should attempt **auto-registration** on local
  Temporal (the CLI shells out already; dev-server and docker-compose cases are scriptable)
  and reserve the paste-friendly instructions for Cloud/locked-down namespaces.
- Node-version split messaging (daemon 20 vs Pi seat 22.19) surfaces as confusing late
  failures — preflight earlier, message once.
- Bare `agent-tempo` six-step bootstrap is good; keep. B4c's suspension loudness closed the
  worst silent-wedge trap. `[R-inventory]` may surface more.
- **Deleting beats documenting** is the tiebreak rule for everything in this section.

---

## D. Sequencing + release shape

```
now ──► finish 1.x critical path (#777 #774 #768, T1.1 PR-2/3)
     ──► ship 1.8.0 STABLE  ◄── the "last 1.x" everyone cutover-hops through
          • Tier 0 + T1.1 + ghost/lifecycle fixes (the unreleased pile)
          • + the `upgrade-to-2` cutover verb (A.3) — the 1.x HALF of the
            migration story must ship BEFORE 2.0-beta.1 exists
          • 1.8.x branch: critical fixes only thereafter
     ──► main becomes 2.0-beta line
          • beta.1: cutover guard + stamp · marker/branch deletion · wire-v2
            removals · TUI deletion · env unification · tool merges (aliased)
          • beta.2+: B2 attachment-core · P1 mission-control gaps · alias drop
            at GA · dashboard review item
          • GA gate: 1.8 → 2.0 upgrade round-trip in CI (E2E: up on 1.8,
            upgrade-to-2, verify ensemble continuity on 2.0) + docs surgery done
```

- **Why a stable 1.8.0 first**: (i) the cutover protocol needs a 1.x release that *contains*
  the cutover verb; (ii) the unreleased pile (Tier 0 + T1.1) is real value 1.x users should
  get without buying a breaking release; (iii) it gives 0.x/early-1.x users a single
  documented hop. Beta cadence for 2.0: match 1.7's rhythm (frequent small betas).
- P0 mission-control gap closure (#742) is **1.x-side and starts now** — it is additive,
  doesn't disturb the critical path, and must be done before beta.1 deletes the TUI.

## Non-goals (unchanged from prior records)
T1.2 (worker-side tap — trigger: Window-A residual on the meter), T1.3 (tiered liveness —
operator sign-off, sequenced last), cross-host doorbell v2, pause/hold axis collapse B4(a/b)
— **note**: 2.0 is the natural major for B4(a) *if* B4c's banners proved insufficient;
current evidence says banners sufficed → keep parked, revisit at 2.0 GA review.

---

## E. Operator decision points — **ALL EIGHT RATIFIED (operator ruling, 2026-06-12)**

> Relayed via conductor 2026-06-12. Each row's "Ruling" column is the operative decision;
> alternatives are preserved for the record. E.8 carries the operator's standing objection
> rights until 2.0-beta.1 ships it.

| # | Decision | **Ruling (operator, 2026-06-12)** | Alternative considered & its cost |
|---|---|---|---|
| 1 | Migration protocol | **RATIFIED: A2 clean cutover** (guarded; zero residue; clears ALL legacy tolerance at once; #334+lineups are the continuity story) | A1 deprecatePatch ladder: in-place upgrade preserved, but 2-release tax + live replay-compat matrix through 2.0 + per-debt drain stories |
| 2 | 1.8.0 stable before 2.0 branch | **RATIFIED: yes** — carries the cutover verb + ships the unreleased pile to 1.x users | Cut 2.0 from the beta line directly: faster, but no cutover-verb home and 1.x users never get Tier 0/T1.1 in a stable |
| 3 | Web dashboard fate | **RATIFIED: stays** as the zero-dependency fallback — 2.0 operator surfaces are CLI + command-center + web dashboard; TUI dies per plan | Delete with TUI: max simplification, one rendering stack — at the cost of no operator surface without the Pi dep |
| 4 | Tool-merge alias window | **RATIFIED: one beta with aliases, drop at GA** | No aliases (cleanest, most muscle-memory breakage) / keep through GA (registry-size win deferred) |
| 5 | Env unification in beta.1 | **RATIFIED: yes** — all renames at once while the breaking window is open | Defer: drags dual-reads through 2.x |
| 6 | B2 in 2.0 betas | **RATIFIED: beta.2+, contingent on T1.1 PR-2/3 settled** | Defer to 2.x: safer, but loses the beta window where internal churn is free |
| 7 | B4(a) pause-axis collapse in 2.0 | **RATIFIED: no — keep parked** (B4c banners resolved the operational pain) | Fold in: one suspension axis, but adds a breaking surface with no incident pressure behind it |
| 8 | Bare `agent-tempo` default after TUI deletion | **RATIFIED (with standing objection rights until 2.0-beta.1 ships it): bootstrap (six-step, unchanged) + `status` + next-step hints** — incl. a `command-center` suggestion when the Pi seat is available. Safe, informative, no side effects beyond provisioning | `up`: most helpful for the returning user, but bare-command-starts-an-ensemble is a surprising side effect on first run; plain help: safest, least useful |
