# #389 content-gaps refresh — post-#454 / #461 / canvas v=49 audit

**Author**: tempo-researcher
**Date**: 2026-04-30
**Issue**: [#389 — dashboard: implementation has large content gaps vs canonical design (~70% missing on Overview alone)](https://github.com/vinceblank/agent-tempo/issues/389) (filed 2026-04-27, currently `OPEN`)
**Implementation HEAD**: `5463a92e` — `feat(dashboard): canvas v=49 sync — page-header typography + non-modal popout (#497)`
**Source artifacts**:
- Canonical design: `docs/design/dashboard-handoff/project/screens.jsx` (Overview = lines 4–93)
- Current impl: `dashboard/src/screens/Overview.tsx`, `dashboard/src/components/EnsembleCard.tsx`, `PageHeader.tsx`, `SectionHead.tsx`
- Prior audits: `docs/design/dashboard-audit-389-followup-rev2.md` (code-only), `docs/design/dashboard-audit-389-followup-rev3.md` (live wire + rev3-cert addendum)
- Post-fidelity polish: `docs/design/dashboard-pixel-audit-v0.28.9.md` (#454), `docs/design/dashboard-overflow-audit-v0.28.10.md` (#461), commit `5463a92e` (canvas v=49 sync, #497)

---

## TL;DR

**All 10 listed Overview deltas are FIXED structurally.** The single residual is `Recent activity` content which renders honest empty-state chrome while the cross-ensemble event-stream wire (out-of-scope architectural epic) ships. Every other "presumed similar" screen was walked end-to-end in the rev3-cert pass and certified at "🎯 100% structural fidelity." The post-cert wave then closed every architectural follow-up the live audits surfaced (#430, #431, #434, #436, #437, #438, #444, #459).

**Recommendation**: **Close #389.** The original parent issue scoped *design fidelity*, and design fidelity is no longer the dashboard's bottleneck — it's wire-extension and polish, which is tracked under separate epics.

---

## Method

This is a delta-by-delta sweep against the 10 deltas listed in #389's body table, plus a status check on the "presumed similar" other-screen note. For each delta I:

1. Quoted the original entry verbatim (column 1).
2. Read the canonical source (`screens.jsx:4-93` for Overview) and the current implementation file.
3. Cross-checked against rev3-cert (2026-04-28) — the most recent #389-specific certification, which already walked all 11 screens with live wire data on a post-#442 build.
4. Filed a verdict per delta: `FIXED` / `PARTIAL` / `STILL-OPEN` / `OUT-OF-SCOPE`, with evidence pointers.

Not done: pixel-perfect screenshot diff, behavioral testing of action buttons, mobile container-query verification. Those are owned by other audits (#454 pixel rubric, #461 overflow CI guardrail, Playwright e2e).

---

## 1. Per-delta verdict — Overview screen (the 10 listed in #389)

| # | Element (per #389) | Original impl (per #389) | Severity (per #389) | Current state | Verdict |
|---|---|---|---|---|---|
| 1 | **Page title**: "Overview" + 3 quick-stat pills (`3 ensembles`, `13 players`, `4 hosts`) | "Maestro" + stale subtitle "Dashboard scaffold (PR-2)" | High | `Overview.tsx:102-114` — `<PageHeader title="Overview" pills={…StatPill × 3}>`. Pills render live counts via `useEnsembleList()` + `useHosts()` reducers (`Overview.tsx:71-85`). Subtitle is "All ensembles, rolled up. Tap one to dive in." — exact canonical match. | **FIXED** ✅ |
| 2 | **Page actions**: "↻ Refresh" + "+ New ensemble" buttons | None | High | `Overview.tsx:117-138` — both `<Btn>` rendered with `data-testid="overview-refresh"` + `overview-new-ensemble`, wired to `qc.invalidateQueries(…)` and `navigate('/create-ensemble')` respectively. Per audit rev 4 PR-B, the page-header is pushed into the AppShell slot via `useScreenPageHeader`, so screen-specific actions replace operator chrome. | **FIXED** ✅ |
| 3 | **Section heading**: `<SectionHead kicker="I / RUNNING" title="Active ensembles">` | Plain "Ensembles" heading | Medium | `Overview.tsx:173` — `<SectionHead kicker="I / RUNNING" title="Active ensembles" />`. Same primitive used on canonical (`screens.jsx:30`) and impl (`SectionHead.tsx`). | **FIXED** ✅ |
| 4 | **Ensemble card name**: `@my-band` (with `@` prefix per design) | `tempo-impl` (no `@`) | Low | `EnsembleCard.tsx:109-113` — `<div className="ec-name"><span className="at">@</span>{ensemble.name}</div>`. The `at` span carries the terracotta tint per `components.css`. Live verified in rev3-cert §1.1 (`<span class="at">@</span>design-audit`). | **FIXED** ✅ |
| 5 | **Ensemble card BPM**: `<span className="bpm">{tempo}</span> bpm` display | None | High | `EnsembleCard.tsx:114-119` — `.ec-tempo` wraps `.bpm` span + literal "bpm" label. Bound to `bpm = data?.currentBpm` from snapshot (Q5.6 wire shipped per rev3-cert §2.2; live values 10/14/0 confirmed). Sub-undefined falls through to `—`. | **FIXED** ✅ |
| 6 | **Ensemble card description**: `<div className="ec-desc">{description}</div>` | None | High | `EnsembleCard.tsx:146-148` — `<div className="ec-desc" data-testid="…-desc">{description \|\| null}</div>`, bound to `data?.description` from snapshot (Q5.1 wire shipped). Empty descriptions correctly render an empty element (40px min-height preserves grid alignment) — paraphrase bug closed in **#430** (#439). | **FIXED** ✅ |
| 7 | **Ensemble card stats**: 3-stat grid: players / active / uptime | Inline "9 players · conductor" only | High | `EnsembleCard.tsx:150-173` — `.ec-stats` block with 3 `.ec-stat` children: `playerCount` / `activeCount` (computed from `phase === 'attached' \|\| 'processing'`) / `uptime` (from `formatUptimeFromIso(data?.startedAt)`, Q5.3a wire shipped). Sub-minute uptime edge-case closed in **#431** (#439). | **FIXED** ✅ |
| 8 | **Ensemble card footer**: lineup + host metadata in mono font | None | Medium | `EnsembleCard.tsx:177-180` — `.ec-meta mono dim` row with two spans (`lineup` + `host`). The 3-span shape regression flagged in rev3 R3.P1.2 was fixed in **#440** — chrome is canonical (2 spans, justified). Wire-data values are still hardcoded `'—'` (per-ensemble `lineup` + `host` are deferred to beta.9 wire epic, R3.P2.7 in rev3-cert) — but the original delta in #389 was about the missing structural element, which is present. | **FIXED** ✅ <br>(chrome present; wire-data tracked in beta.9 epic, R3.P2.7) |
| 9 | **Ensemble card roster**: Up to 5 `PlayerAvatar` + overflow count | None | High | `EnsembleCard.tsx:196-216` — `.ec-roster` renders `players.slice(0, 5).map(p => <PlayerAvatar size={22} … />)` with `+N` overflow span. `players` is sorted conductor-first via `sortConductorFirst(data?.players ?? [])` per #462. Live verified in rev3-cert §1.1 (5 22×22 oklch tiles). | **FIXED** ✅ |
| 10 | **Recent activity** section: Full event log (timestamps, route/message/phase/recruit/ensemble events) | Missing entirely | Critical | `Overview.tsx:192-220` — `<RecentActivity />` renders the design's chrome: `<SectionHead kicker="II / RECENT" title="Recent activity" right={…}>` + `<div className="panel"><div className="panel-body flush event-log">…</div></div>`. The body shows an honest empty-state row ("No recent activity. Cross-ensemble event stream coming soon.") because the **cross-ensemble `ClusterEvent` stream is not yet exposed via `/v1/events?global=true`** (Task #15, beta.8+). The "lands in beta.8" stale-copy dependency was retired (#438/#439). The chrome is canonical; the event content is wire-pending and tracked outside #389. | **PARTIAL** 🟡 <br>(chrome shipped + canonical empty-state; live event content awaits cross-ensemble wire) |

### Overview tally

- **FIXED**: 9 / 10 (90%)
- **PARTIAL**: 1 / 10 (10%) — Recent activity wire (architecturally tracked elsewhere; chrome shipped + honest empty-state)
- **STILL-OPEN**: 0 / 10
- **OUT-OF-SCOPE**: 0 / 10

---

## 2. "Presumed similar" other-screen status

#389's body flagged: *"Per-screen comparison needed before scoping the full implementation work"* for Workspace, PlayerDetail, CreateEnsemble, Recruit, Loadouts, PlayerTypes, Schedules, Hosts. None of these had itemized deltas — they were a placeholder for "audit later."

That audit happened. Twice.

| Audit | Date | HEAD | Verdict |
|---|---|---|---|
| **rev 2** (code-only) | 2026-04-28 | `f3709a6e` (post-#393…#415, beta.7) | "Overall fidelity is high. 0 P0 design-fidelity blockers… Beta.7 is fit-for-purpose." |
| **rev 3** (live wire + DOM) | 2026-04-28 | `fdb891f6` (beta.8 release) | "fidelity is HIGH but new visible bugs surfaced under live wire data… Net new P0 bugs since rev 2: zero." 9 P1 / 6 P2 items filed (#430 / #431 / #434 / #437 / #438 / #444 / Settings task-queue). |
| **rev 3-cert** (post-#440 + #442) | 2026-04-28 (21:03Z) | `6b85880e` | **"🎯 100% structural fidelity confirmed."** All R3.P1 items closed. All rev-4 binding-spec markers (C1–C7) honored. |

Every architectural follow-up rev 3 surfaced has since closed:

| # | Title | Closed |
|---|---|---|
| 430 | EnsembleCard description fallback paraphrase | 2026-04-28 |
| 431 | EnsembleCard sub-minute uptime "—" | 2026-04-28 |
| 434 | snapshot `agentType` reports 'claude' for mock players | 2026-04-28 |
| 436 | Settings Connection panel reads static config | 2026-04-28 |
| 437 | daemon: Hosts table empty in dev mode (hostProfile wire) | 2026-04-28 |
| 438 | Overview "Recent activity lands in beta.8" stale copy | 2026-04-28 |
| 444 | Settings task-queue KV stale prod default in dev mode | 2026-04-28 |
| 446 | player-to-player chat row not consistently grey | 2026-04-28 |
| 450 | PlayerDetail "part" generic for non-conductors | 2026-04-28 |
| 459 | declare `--surface-1/-2`, `--text-1` tokens in canonical CSS | 2026-04-30 |
| 461 | UI overflow + content-length robustness audit | 2026-04-29 |
| 462 | conductor always listed first | 2026-04-29 |
| 471/472 | `@<player>` / `/<command>` chat-input autofill | 2026-04-29/30 |
| 473 | sidebar maestro avatar tile-frame parity | 2026-04-29 |

**Net per-screen status (as of `5463a92e`)**: every screen the issue's "presumed similar" note flagged has been audited end-to-end at least twice, certified at 100% structural fidelity, and had its architectural residuals closed.

---

## 3. Implementation epic — was the work actually done

For evidence trail, here are the merged PRs that explicitly cite #389 in their title:

| PR | Title | Merged |
|---|---|---|
| 392 | PR-0 token + font swap + components.css port | 2026-04-28 |
| 393 | PR-A1 layout primitives — desktop + tablet | 2026-04-28 |
| 394 | PR-C1 Workspace desktop+tablet rebuild | 2026-04-28 |
| 395 | docs(design): land audit + v3 handoff bundle | 2026-04-28 |
| 396 | PR-A2 chat + tempo primitives | 2026-04-28 |
| 397 | PR-B Overview screen rebuild | 2026-04-28 |
| 398 | PR-A1m mobile shell | 2026-04-28 |
| 401 | PR-C2 Workspace chat polish | 2026-04-28 |
| 402 | PR-D PlayerDetail rebuild | 2026-04-28 |
| 403 | PR-E CreateEnsemble + Recruit wizards | 2026-04-28 |
| 404 | PR-C3 Workspace mobile | 2026-04-28 |
| 405 | PR-F1 Library — Loadouts + Schedules tabular | 2026-04-28 |
| 406 | PR-F2 PlayerTypes + Hosts library screens | 2026-04-28 |
| 407 | PR-G Settings sidebar route | 2026-04-28 |
| 416 | docs(design): audit rev2 follow-up | 2026-04-28 |
| 419 | audit rev2 fidelity polish — Loadouts/Schedules/subtitle | 2026-04-28 |
| 420 | PR-7 — wire action buttons + audit P1 fold-ins | 2026-04-28 |
| 435 | docs(design): rev3 follow-up audit with live wire data | 2026-04-28 |
| 440 | rev3 polish bundle (chips/footer/headers/heartbeat/subtitle) | 2026-04-28 |
| 442 | final 100% cleanup — 4 fixes for canonical alignment | 2026-04-28 |
| 443 | docs(design): rev3-cert addendum — 100% structural fidelity confirmed | 2026-04-28 |

That's **21 PRs** explicitly attributed to #389, plus the architectural follow-ups listed in §2.

After rev3-cert (commit `6b85880e`), the dashboard moved into a polish phase that's no longer #389-scoped:

- **#454 — pixel audit v0.28.9** (`docs/design/dashboard-pixel-audit-v0.28.9.md`): 8 PR cluster (PR-A through PR-H) covering JSX class drift, container-query rules, tokens. References #389 only as "PR-0 of #389 set the canonical font load." Not new content gaps.
- **#461 — overflow audit v0.28.10** (`docs/design/dashboard-overflow-audit-v0.28.10.md`): 13 findings, 1 auto-P1, plus PR-α (CSS cluster) + PR-v0 (CI overflow guardrail, #491). Robustness, not content fidelity.
- **#497 — canvas v=49 sync** (commit `5463a92e`, today): three substantive UX changes — `.page-header` typographic refinement, pop-out chat → non-modal floating window, canonical `styles.css` resync. Refines existing surfaces; does not add or close any #389 deltas.

---

## 4. Aggregate tally (Overview deltas + per-screen status)

| Bucket | Count |
|---|---|
| Listed Overview deltas — FIXED | 9 |
| Listed Overview deltas — PARTIAL (chrome ✅, wire-pending) | 1 |
| Listed Overview deltas — STILL-OPEN | 0 |
| "Presumed similar" other screens — certified at 100% structural fidelity by rev3-cert | 10 (Workspace / PlayerDetail / CreateEnsemble / Recruit / Loadouts / PlayerTypes / Schedules / Hosts / Settings / Mobile shell) |
| Architectural follow-ups surfaced under live audit — closed since rev3-cert | 14 |
| Net `STILL-OPEN` items attributable to #389 | **0** |

**Headline**: 9 of 10 listed deltas are fixed; the 1 partial is structurally fixed and only awaits a wire backend that is owned by a separate beta.9 epic. Every "presumed similar" gap has been audited and certified.

---

## 5. Recommendation

### Close #389.

Rationale:

1. **The original parent issue scoped design fidelity** — "AppShell + scaffold are present, but the screens themselves are missing ~70% of design content on the Overview screen alone." That symptom is gone. Every listed delta is structurally present in the implementation, every screen has been walked, and rev3-cert formally certified "🎯 100% structural fidelity confirmed."

2. **The acceptance criteria are met.** From #389's checklist:
   - [x] Per-screen comparison report (architect) — rev 2 + rev 3 + rev3-cert delivered.
   - [x] Phasing plan with per-PR scope (architect) — PR-0 / PR-A1 / PR-A1m / PR-A2 / PR-B / PR-C1–C3 / PR-D / PR-E / PR-F1–F2 / PR-G / PR-7. All shipped.
   - [x] Implementation PRs (lead + eng) — 21 PRs cite #389 directly.
   - [x] QA reviews each against design.jsx — rev 2 (code-only) + rev 3 (live wire) + rev3-cert (post-fix verification).
   - [x] Live dashboard matches design intent — rev3-cert confirms.

3. **Residual work is tracked elsewhere and is not "content gaps"**:
   - Recent-activity event content awaits the cross-ensemble `ClusterEvent` stream — an architectural wire epic (Task #15 in the rev2 brief), not a content gap. The chrome is canonical; the empty-state is honest.
   - Per-ensemble `lineup` and `host` wire fields → beta.9 wire epic (R3.P2.7).
   - PlayerDetail `branch: HEAD` UX, PlayerDetail `part` autopopulate → tracked separately (#450 closed for non-conductor part defaults).
   - Polish work has shifted to #454 (pixel rubric) and #461 (overflow robustness + CI guardrail) — distinct scopes.

4. **Keeping #389 open obscures work-tracking signal.** New gaps surfaced post-cert have been filed as their own issues (#430, #431, #434, #436, #437, #438, #444, #446, #450, #459, #461, #462, #471, #472, #473). That pattern is healthier — tight per-issue scope, fast triage, clear close-criteria — than re-opening or re-scoping a once-broad parent.

### Suggested close-out comment

> Closing as resolved. All 10 Overview deltas listed in the issue body are structurally fixed (rev3-cert §1.1, 2026-04-28: "🎯 100% structural fidelity confirmed"). Every "presumed similar" screen has been audited end-to-end across rev 2 + rev 3 + rev3-cert and certified canonical at HEAD `6b85880e`. The single partial — Recent activity content — is awaiting the cross-ensemble event stream (Task #15, beta.9 wire epic), with canonical chrome and honest empty-state shipped. Polish has since shifted to scope-distinct epics (#454 pixel rubric, #461 overflow guardrail, canvas v=49 sync). See `docs/research/389-content-gaps-refresh.md` for the delta-by-delta sweep.

### Alternative considered

**Re-scope to "remaining content gaps post-rev3-cert"** — rejected. There are no remaining *content* gaps; the residuals are wire (Task #15 / R3.P2.7) and behavioral (action button correctness, e2e), which belong in their own scopes. Re-scoping would invite re-litigating already-closed deltas.

**Keep open as-is** — rejected. The body asserts "missing ~70% of design content on the Overview screen alone." That assertion is no longer true (0 of 10 deltas still missing chrome). Leaving the body unchanged misrepresents current state to anyone landing on the issue.

---

## 6. Out of scope (per brief)

- Implementing fixes (this is a research deliverable).
- Pixel-perfect audit beyond the listed deltas (owned by #454 rubric).
- Performance / behavior changes (owned by Playwright e2e + #461 overflow CI guardrail).
- Re-evaluating wire-extension epic prioritization (owned by architect for beta.9 planning).

---

🎼 _Posted by [agent-tempo\[bot\]](https://github.com/apps/agent-tempo) — an AI ensemble acting on behalf of @vinceblank. For a human, mention @vinceblank directly._
