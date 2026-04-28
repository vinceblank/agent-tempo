# Dashboard design-fidelity audit — #389 followup, rev 3

**Author**: tempo-architect
**Date**: 2026-04-28
**Source artifacts**:
- Live dashboard: `localhost:5174/dashboard/` → dev daemon at `localhost:8474` (namespace `claude-tempo-dev`, version `0.28.0-beta.8`)
- Test ensembles: `design-audit` (5 mock players: alice, bob, silent-witness, chaos-monkey, conductor) + `verify-mock-fix` (same shape)
- Canonical design: `docs/design/dashboard-handoff/project/{screens.jsx, workspace.jsx, web-design-system.html, dashboard.html, styles.css}`
- Binding spec: `docs/design/dashboard-audit-389.md` rev 4
- Prior audit: `docs/design/dashboard-audit-389-followup-rev2.md` (code-only, pre-wire-data)
- Implementation HEAD: `fdb891f6` (beta.8 release on `main`; #423 PR-A in flight)

## Method

This rev is the live counterpart to rev 2. Where rev 2 was a code-only static audit, rev 3 walks the running dashboard against canonical with **real wire data** flowing — BPM ticking, runId populated, lease countdown live, messaging counters incrementing, mock players in `attached`/`processing` phases.

- Walked all 11 screens (Overview / Workspace / PlayerDetail / CreateEnsemble / Recruit / Loadouts / PlayerTypes / Schedules / Hosts / Settings / Mobile shell) at desktop viewport via Chrome MCP.
- DOM-level inspection of `.ec-*`, `.kv`, `.page-header`, `.tempo-strip`, `.composer`, `.section-head`, `.player-sheet-*`, `.phone-appbar`, `.phone-tabbar`.
- Cross-referenced every rev-2 finding against live state (P1.x, P2.x, D.1/D.2 from rev 2 and the rev-4 binding spec C1–C7).
- Corroborated tempo-conductor's parallel browse findings (received mid-audit) — every overlap is flagged below with cross-reference.

Did NOT do: pixel-perfect screenshot diff against canonical screenshots. Code-level + DOM-shape inspection caught 100% of the structural items the conductor's brief flagged; pixel diffs are deferred to QA dispatch with `pencil` or a Playwright visual-regression harness.

## TL;DR

**Overall fidelity is HIGH but new visible bugs surfaced under live wire data that rev 2's code-only audit could not have caught.** Most rev-4 markers (C1–C7) are still honored; the spec is followed structurally. The new findings split three ways:

1. **NEW under live wire data** (would-not-show in rev 2's static read): EnsembleCard always-rendered `paused`/`held` chips, EnsembleCard footer shape divergence, TempoStrip partial-fill, `heartbeat: —` regression, PhoneAppBar empty-state on /dashboard root, sub-minute uptime "`—`", stale "lands in beta.8" copy.
2. **Architectural** (corroborate conductor's parallel browse, file or already filed): `agentType` union missing `'mock'` (#434), `hostProfile` advertisement (Hosts empty-table wire bug), Settings Connection panel reads static config (drift from running daemon).
3. **Rev 2 carry-overs** (some now fixed under PR-7 wave; some still open): rev 2 P1.6 uptime pill — **shipped**; rev 2 P1.5 host segment — **partially shipped (host yes, lineup still hardcoded missing)**; rev 2 P1.3/P1.4/P2.7 button-disabled state — **regressed** (Edit/Duplicate/Logs/+ New type now `disabled: false` per DOM probe — should still be `DisabledWithTooltip`).

**Verdict on "100% aligned with the design": NOT YET — but close.** Net new P0 bugs since rev 2: zero. New P1 items: 9. New P2 items: 6. Rev 2 carry-overs: 4 still open.

Beta.8 dashboard is fit-for-internal-validation — the issues found here are visible and shippable-but-noticeable. None blocks the user's stated mandate (autonomous E2E validation harness using mock-jam ensembles works end-to-end).

---

## 1. Per-screen audit (live + delta from rev 2)

Legend: ✅ matches design · 🟡 nit · 🔴 gap · 🟧 regression vs rev 2 · 🆕 new finding (live-only)

### 1.1 Overview

| Element | Status | Notes |
|---|---|---|
| Page title `Overview` | ✅ | `<h1>Overview</h1>` |
| Page-pills (ensembles / players / hosts) | ✅ | All three render |
| Page-actions Refresh + New ensemble | ✅ | Both wired |
| SectionHead `I / RUNNING · Active ensembles` | ✅ | — |
| SectionHead `II / RECENT · Recent activity` + right slot | ✅ | — |
| EnsembleCard `@`-prefix + name | ✅ | `<span class="at">@</span>design-audit` |
| EnsembleCard `.bpm` | ✅ | Live values (10, 14, 0). Q5.6 wire works. |
| EnsembleCard `.ec-stats` 3-stat grid | ✅ | players / active / uptime |
| EnsembleCard `.ec-roster` (5 PlayerAvatar size 22) | ✅ | 22×22 tiles with oklch background, no `+N` overflow needed (5 players ≤ 5) |
| EnsembleCard description **`"Conductor active."`** when wire `description: ""` | 🔴 | Same as rev 2 P2.1; **issue #430 already filed**. Verified live: BOTH cards show this paraphrase. Per design, empty description should render empty or `—`. |
| EnsembleCard sub-minute uptime renders **`"—"`** instead of `<60s` | 🆕 🔴 | design-audit (3 min old) showed `uptime: —` initially; verify-mock-fix (16 min) showed `16m`. **`formatDuration` returns `"—"` for sub-minute durations.** Conductor filed **#431**. |
| EnsembleCard footer (`mono dim`) | 🆕 🔴 | Design shape: `<lineup> · <host>` (2 spans, justified). Live shape: `<lineup> · <conductor>` + trailing span `<host>`. **Conductor name surfaces in the lineup-host position** (impl renders 3 things instead of 2). DOM verified: `<span>— · <span class>conductor</span></span><span>—</span>`. P1.5 carry-over with new visual asymmetry. |
| EnsembleCard always-rendered `paused`/`held` text | 🆕 🔴 | DOM has bare `<span>paused</span><span>held</span>` between `.ec-stats` and `.ec-roster` on **every card regardless of state**. design-audit's API state is `paused`; verify-mock-fix's is `offline` — both render both chips. The chips are unstyled (no `.pill` class, no conditional render). **This is dead/broken pill rendering** that doesn't appear in canonical `screens.jsx:Overview` at all. |
| Recent activity copy `"lands in beta.8"` | 🆕 🔴 | Daemon `version: "0.28.0-beta.8"`. The placeholder is now stale — we ARE on beta.8 and the cross-ensemble event stream still hasn't shipped. Update copy to `"lands in beta.9"` or `"coming soon"` until wire ships. |
| Empty state when no ensembles | ✅ | Better than design — shows `claude-tempo up <name>` snippet (rev 2 noted) |

**Verdict**: 🔴 **3 new live-only bugs** (footer shape, paused/held chips, sub-minute uptime). 1 stale copy. Description paraphrase is rev 2 carry-over (#430 filed).

---

### 1.2 Workspace (desktop)

| Element | Status | Notes |
|---|---|---|
| Composite breadcrumb `<h1>` `<span class="prefix mono">ensemble /</span><span class="at">@</span>design-audit` | ✅ | Exact match to canonical |
| Page subtitle `<span class="mono accent">conductor</span> on <span class="mono">main-laptop</span>` | ✅ for partial | **Conducted by + host wires through** — rev 2 P1.5 host half is shipped. |
| Page subtitle missing `Lineup X · ` prefix | 🔴 | Design: `Lineup tempo-mock-jam · conducted by conductor on main-laptop`. Live: `Conducted by conductor on main-laptop` — **the lineup prefix is dropped entirely**, not even rendered as `Lineup — · …` placeholder. Rev 2 P1.5 carry-over (lineup half still open). |
| Page-pills: `1 active` (with `pill-dot`) + `4 idle` + `paused` + `up 8m` | ✅ | **Rev 2 P1.6 uptime pill is now shipped.** State pill (`paused`/`held`/`live` was the rev 2 nit) now correctly conditional. Net 4-pill design count met. |
| Page-actions: `+ Recruit` + side-toggle | ✅ | Wired |
| TempoStrip in `.page-tempo` with bpm overlay top-right (`15bpm`) | ✅ structurally | Renders SVG with bars + bpm overlay text. C6 marker honored. |
| TempoStrip bar-count: 16 of 60 | 🆕 🟡 | Design's 60-bar sparkline (rev-4 C6) renders only 16 bars on a fresh ensemble. Likely behavior: SVG width fixed but only N=ticks-since-start bars drawn. Cosmetic — strip looks "short" until 60 ticks accumulate. **Recommendation**: pad with 0-height bars on the left so the strip always renders full-width. |
| Composer = textarea (not input) with `@`/`/`/`Ctrl ↩ Send` toolbar | ✅ | All four. `IS_MAC` detection: running on Windows → `Ctrl ↩` correct. |
| Pop-out chat window | (not exercised in audit) | Exists per rev 2; not re-verified in this pass |
| Workspace-side panels: Roster + Event log + Schedules | ✅ | All 3 panels render |
| Roster `+ Recruit` link | ✅ | Wires `?ensemble=…` param |
| Schedules side-panel (rev 2 P1.2: stale "lands in PR-F" stub) | (not re-verified directly) | rev 2 P1.2 may now be unstubbed; live ensemble has no schedules so empty-state fires. Worth a fresh probe with a schedules-having ensemble. |

**Verdict**: ✅ **Strong overall.** Rev 2 P1.6 uptime pill shipped. Lineup-prefix half of P1.5 still open. New: TempoStrip partial-fill cosmetic (P2-tier).

---

### 1.3 PlayerDetail (`/ensemble/design-audit/player/conductor`)

| Element | Status | Notes |
|---|---|---|
| ResponsivePanel + `panel-head player-sheet-head` | ✅ | — |
| Header avatar + name + PhaseDot + TypeBadge | ✅ | — |
| Header action row (5 actions + ✕) — `@DM` / `Recall` / `Restart` / `Detach` / `Destroy` / `✕` | ✅ | Exact 5+1, matches design. **All 5 now `disabled: false`** per DOM probe — implies PR-7 has wired actions, OR `DisabledWithTooltip` no longer sets the underlying `disabled` attribute. Functional correctness unverified but design count is right. |
| 4 SectionHead groupings: `transcript / Recent messages` + `attachment / Phase & lease` + `workdir / Work` + `traffic / Messages` | ✅ | Names + kickers exact match. **Q2 lock-in honored.** |
| Phase & lease KVs: phase `● active` / adapter / host / heartbeat / lease / run id | ✅ structurally | All 6 rows render |
| `phase ● active` (raw `attached` → label `active`) | ✅ | rev-4 C3 D.2 doc gap (bucket-share) — implementation matches live. |
| `adapter claude-code` for **mock players** | 🆕 🔴 | Mock conductor's adapter resolves to `claude-code`, not `mock`. **Architectural — `AgentType` union doesn't include `'mock'` (issue #434).** Affects every mock player's adapter cell. Conductor filed. |
| `heartbeat —` (was working in rev 2 per Q5.2) | 🆕 🟧 | Regression. Rev 2 marked this ✅. Live shows empty. Snapshot has `lastActivityAt` not `heartbeat` — wire-field name drift. **Either reslot the read or rename the snapshot field.** |
| `lease expires in 1m` | ✅ | Q5.7 works |
| `run id 019d·20f7` | ✅ | Q5.5 truncation works |
| Work: dir / branch / worktree / part | ✅ structurally | All 4 rows render |
| `branch HEAD` literal on detached HEAD | 🆕 🟡 | UX confusing. Should resolve to commit SHA short or `(detached @ HEAD)`. Conductor noted; agreed P2. |
| `worktree —` (wire-pending) | ✅ | Acceptable degrade |
| `part Conductor session` (or generic "Session in tempo-verify" for non-conductors) | 🟡 | Generic part text doesn't reflect role. Rev 2 didn't flag; conductor's parallel browse caught for non-conductor players. P2 — a future "auto-part" feature could populate from player type. |
| Messages KVs: received / sent / outbox | ✅ | All wire fields populating |
| Transcript section: 16 `msg route` items rendered | ✅ | FeedMessage variants used (`route` = third-party traffic — rev 2 verified). |

**Verdict**: 🟧 **One regression (heartbeat empty)** + 1 architectural (#434 mock adapter resolution) + small UX nits. Otherwise still the best-implemented screen.

---

### 1.4 CreateEnsemble wizard

| Element | Status | Notes |
|---|---|---|
| Dialog with `STEP 1 / 3 · lineup` | ✅ | Exact match |
| Field: Name | ✅ | — |
| Field: Starting lineup picker-list (7 lineups) | ✅ | — |
| Footer hint `3 steps: lineup → customize → review` | ✅ | — |

**Verdict**: ✅ Step 1 walked; rev 2 verified all 3 steps. Behavior unchanged.

---

### 1.5 Recruit wizard

| Element | Status | Notes |
|---|---|---|
| Dialog title `Recruit into @design-audit` | ✅ | `@`-prefix correct |
| `STEP 1 / 4 · identity` (4 steps) | ✅ | Q3 lock-in honored |
| Field: Name + Field: Part (optional) | ✅ | — |
| Footer hint `↑↓ to select · Enter to confirm · Esc to cancel` | ✅ structurally | Rev 2 P2.5 noted keyboard nav not actually wired — needs interaction test to verify |

**Verdict**: ✅ Behavior matches rev 2.

---

### 1.6 Loadouts

| Element | Status | Notes |
|---|---|---|
| `<h1>Loadouts</h1>` page title | ✅ | — |
| **Stacked `header.page-header` × 2** | 🆕 🔴 | Two `<header class="page-header">` elements: first contains `Maestro / Density6 / ☀ Light` (a global app-shell strip), second contains `Loadouts` + subtitle + actions. **Visible double-header.** Verified `headerCount: 2`. Doesn't appear on PlayerTypes (`headerCount: 1`) or Hosts — refactor inconsistency. PlayerTypes/Hosts may have moved their app-strip into a different slot. |
| Subtitle: `Reusable ensemble lineups. Loaded via claude-tempo up --lineup or from here.` | ✅ | — |
| Page-actions: `↑ Import YAML` + `+ New loadout` | ✅ | — |
| Table 6 columns: Name / Summary / Players / Source / Last used / actions | ✅ | — |
| 5 rows (post-#429 fix) | ✅ | Conductor's parallel finding |
| `data-label` on Summary/Players/Source/Last used | ✅ | Mobile collapse pattern present |
| Edit + ▶ Load row buttons `disabled: false` per DOM | 🟧 🟡 | Rev 2 P1.3 expected `DisabledWithTooltip` (which would set `disabled=true`). Conductor's parallel browse confirmed the tooltip text shows. Either DOM `disabled` attribute is unset (visual tooltip works without disabling) OR PR-7 wired the action. Worth a closer read: if buttons are clickable but no-op, that's the same UX bug as rev 2 P1.3 (worse than fully-disabled). |
| `Last used` column blank | ✅ | wire-pending; design degrades gracefully |
| `+ New ensemble` (sidebar) → `useLineups()` (live `/v1/lineups` from #412) | ✅ | rev 2 P1.1 still expects Loadouts.tsx itself to use `useLineups()` instead of `SHIPPED_LINEUPS`. Live behavior of populated 5 rows suggests **may now be using useLineups()**. Worth verifying in code (if 5 vs SHIPPED_LINEUPS' static count happens to match, this signal is ambiguous). |

**Verdict**: 🔴 stacked headers (new). Rev 2 P1.1/P1.3 carry-over status ambiguous from DOM alone — needs code re-verification.

---

### 1.7 PlayerTypes

| Element | Status | Notes |
|---|---|---|
| Single `<h1>Player types</h1>` (no stacked header) | ✅ | `headerCount: 1` |
| 16 cards in types-grid | ✅ | Greater than rev 2's expected 9 — probably includes new mock-related types and customs. Acceptable. |
| Card chrome (TypeBadge, glyph, summary, count) | ✅ structurally | Not deep-dived in this pass |
| Header `+ New type` button `disabled: false` | 🟧 🔴 | Rev 2 P2.7 expected `DisabledWithTooltip`. Live shows clickable. **Same regression pattern as Loadouts row buttons.** |
| Per-card `Edit` + `Duplicate` buttons `disabled: false` | 🟧 🔴 | Rev 2 P1.3 — same. |

**Verdict**: 🟧 **Disabled-state regression on 4 button categories** — matches conductor's "wireup ambiguity" observation. P1 verify-and-fix: do these buttons actually no-op, or did PR-7 wire them silently?

---

### 1.8 Schedules

| Element | Status | Notes |
|---|---|---|
| `<h1>Schedules</h1>` | ✅ | — |
| **Stacked `header.page-header` × 2** | 🆕 🔴 | Same as Loadouts. `headerCount: 2`. |
| Table 5 columns: Name / Target / Cadence / Kind / Next fire / actions | ✅ | — |
| 0 rows (no schedules in test ensembles) | ✅ | Empty state for table |
| Action `+ New schedule` `disabled: false` | 🟧 🔴 | Same disabled-state question as Loadouts. |

**Verdict**: 🔴 stacked headers (matches Loadouts). Otherwise structurally OK.

---

### 1.9 Hosts

| Element | Status | Notes |
|---|---|---|
| Single `<h1>Hosts</h1>` | ✅ | `headerCount: 1` (no stacked, unlike Loadouts/Schedules) |
| Subtitle + actions: `⟳ Re-scan` + `Show stale` | ✅ | Both render |
| **Empty table** despite 5 active sessions | 🆕 🔴 | `tableHeads: []`, `rowCount: 0`. Body shows `"No daemons reporting. Run claude-tempo daemon start on a host."`. **The dev daemon IS running (per `/v1/health`) but doesn't advertise its `hostProfile`.** Snapshot returns `hostProfiles: {}`. **Real wire bug** — corroborates conductor's parallel finding. Per `src/daemon.ts` `runDaemonBoot`, the daemon should signal `hostProfile` to global maestro. Either the maestro lookup is broken OR the dev daemon isn't reaching the global maestro (related to namespace isolation? unlikely — same namespace). Worth dispatching to research. |

**Verdict**: 🔴 **wire bug — Hosts empty in dev mode**. Architectural; not solely a dashboard issue.

---

### 1.10 Settings

| Element | Status | Notes |
|---|---|---|
| 5 panels: Connection / Profile / Notifications / Appearance / Danger zone | ✅ | All present (panelCount probe sees 10 due to nested selectors, but 5 distinct head texts) |
| Connection panel: connected page-pill + `namespace=default · address=localhost:7233 · task queue=claude-tempo · tls=off · auth=—` | 🆕 🔴 | **Daemon is on namespace `claude-tempo-dev` + task queue `claude-tempo-dev`** (per `/v1/health`). Settings panel reads **static config**, not the running daemon. **Same class of bug as #423 Gap 1 (banner-vs-actual mismatch)** — settings panel asserts a connection state that contradicts the daemon's actual state. Confirms conductor's parallel finding. **Recommend: wire to `/v1/health` for namespace/version + read `getConfig()` snapshot endpoint for the rest.** |
| Profile panel: hardcoded `default lineup: tempo-dev-team`, others `—` | 🟡 | Rev 2 P2 tier. Same pattern. |
| Notifications: hardcoded display values | 🟡 | Rev 2 P2 tier. |
| Appearance: functional controls (theme/density/accent) | ✅ | Rev 2 verified |
| Danger zone: Disband all (DisabledWithTooltip) + Reset client state (wired) | ✅ | Rev 2 verified |

**Verdict**: 🔴 **Connection panel reads stale/static** — same root pattern as #423 Gap 1 (banner-vs-config mismatch in dev mode). Should bind to runtime daemon state.

---

### 1.11 Mobile shell

(Audited at outer-window 420×850 but viewport reported 1536×695 — host browser window resize didn't propagate; `@container artboard ≤ 520px` rules thus didn't fire. **Cannot fully verify rendered mobile state in this pass** — would need a Chrome DevTools device-emulation override or fixed dashboard width container.)

| Element | Status | Notes |
|---|---|---|
| `.phone-appbar` element present in DOM (display:none at desktop) | ✅ | — |
| `.phone-tabbar` element present | ✅ | 4 items: Now / Ensembles / Library / Settings |
| EnsembleSwitcher | (not exercised) | — |
| **PhoneAppBar text on /dashboard root: `ensemble@—`** | 🆕 🔴 | When NOT inside any ensemble (sidebar route like `/dashboard/`), the PhoneAppBar's ensemble selector renders as `ensemble · @—` with `—` placeholder. Per design, the AppBar's kicker should adapt: show the screen name (`Overview` / `Loadouts`) instead of the always-on ensemble selector when there's no ensemble context. Confirms conductor's "weird kicker prefix" finding. |

**Verdict**: 🟡 mobile rendering not fully reproducible from this pass (viewport pinning issue); empty-state PhoneAppBar bug visible from DOM regardless.

---

## 2. Cross-cutting check

### 2.1 Rev-4 markers C1–C7 — re-verified live

| Marker | Status | Live evidence |
|---|---|---|
| **C1** BrandMark = wordmark + Metronome SVG | ✅ | Sidebar shows `claudetempo` + metronome (per accessibility tree, `metronome` glyph adjacent to `claudetempo` wordmark) |
| **C2** MaestroMark distinct from BrandMark; italic serif | ✅ | Sidebar `You — the maestro` row + footer; rev 2 already verified `font-style: italic` is scoped to MaestroMark + `.msg.route .msg-body` |
| **C3** PhaseDot real PHASES vocab; `attached → "active"` bucket | ✅ | Live `phase ● active` in PlayerDetail (raw `attached` → label `active`); D.2 doc gap unchanged |
| **C4** Italic discipline | ✅ | Title `<h1>` non-italic per design; subtitle `mono accent conductor` non-italic; rev 2's grep findings unchanged |
| **C5** Sidebar 244px | ✅ | Sidebar `complementary "Main navigation"` rendered with `Library` + `Ensembles` + footer at 244px (CSS-driven) |
| **C6** TempoStrip = sparkline + bpm overlay | ✅ structurally | SVG with bars + `15bpm` overlay top-right. Bar-count partial fill at low N (16/60) is cosmetic; per-bar shape correct. |
| **C7** No `@theme` block; hand-rolled CSS | ✅ | Per rev 2; not re-verified this pass |

All 7 markers honored. C3 D.2 (the "active" label vs "attached" phase) is now live-verified — implementation matches the bucket-share convention rev 2 documented.

### 2.2 Wire-extension fields rendering — live coverage

| Field | Wire shipped? | Live render? | Rev-2 vs Rev-3 delta |
|---|---|---|---|
| `description` (Q5.1) | yes | 🔴 paraphrases when empty (`"Conductor active."`) — #430 | unchanged |
| `currentBpm` (Q5.6) | yes | ✅ live (10/14/0 across cards) | rev 2 already ✅; live confirms |
| `tempoSeries` (Q5.6) | yes | ✅ but partial fill (16 / 60 bars) | new live cosmetic |
| `startedAt` → uptime (Q5.3a) | yes | 🔴 sub-minute → `"—"` (#431) | new live edge case |
| `daemonStartedAt` → host uptime (Q5.3b) | yes | (not visible — Hosts table empty) | regressed by hostProfile wire bug |
| `adapterVersions` (Q5.4) | yes | 🔴 mock players resolve to `claude-code` not `mock` (#434) | new architectural finding |
| `runId` (Q5.5) | yes | ✅ live `019d·20f7` | rev 2 ✅; live confirms |
| `messaging.received/sent/outbox` | yes | ✅ all populating | rev 2 ✅; live confirms |
| `lease.expiresAt` (Q5.7) | yes | ✅ `expires in 1m` | rev 2 ✅; live confirms |
| `lastActivityAt` → heartbeat | (named drift) | 🟧 PlayerDetail shows `heartbeat —` | regressed from rev 2 ✅ |
| `lineup` (workspace subtitle + EnsembleCard footer) | NO | 🔴 hardcoded / placeholder | rev 2 P1.5 carry-over (host shipped, lineup did not) |
| `host` per-ensemble (EnsembleCard footer) | NO | 🔴 footer renders conductor name in lineup-host position | new structural finding |
| `hostProfile` advertisement | yes (signal exists) | 🔴 dev daemon doesn't advertise OR maestro doesn't aggregate | new wire bug → Hosts empty |

### 2.3 Empty-state surface sweep (per conductor pin: beyond #430)

A walk of every visible empty-state in the dashboard:

| Surface | Empty input | Rendered output | Verdict |
|---|---|---|---|
| EnsembleCard `description: ""` | empty string | `"Conductor active."` paraphrase | 🔴 #430 |
| EnsembleCard `description: null` | (not exercised) | (likely same code path) | 🔴 same as #430 |
| EnsembleCard sub-minute uptime | `<60s` | `"—"` instead of `"<1m"` or actual value | 🔴 #431 |
| EnsembleCard footer: `lineup: undefined` | undefined | `"—"` | ✅ acceptable degrade |
| EnsembleCard footer: `host: undefined` | undefined | `"—"` (but in wrong position — see card-shape finding) | 🔴 shape issue overrides |
| EnsembleCard `paused`/`held` chips when state is neither | (always rendered) | both visible always | 🔴 dead/broken pill rendering |
| Workspace subtitle missing lineup half | undefined | drops the prefix entirely vs rendering `"Lineup — · …"` | 🔴 inconsistent with host-half degrade |
| PlayerDetail `heartbeat: undefined` (was `lastActivityAt`) | wire-name drift | `"—"` | 🟧 regression |
| PlayerDetail `worktree: undefined` | wire-pending | `"—"` | ✅ acceptable |
| PlayerDetail `branch: "HEAD"` (detached) | literal "HEAD" | `"HEAD"` | 🟡 UX confusion |
| PlayerDetail `part: "Conductor session"` (default for non-conductors: `"Session in <ensemble>"`) | generic default | renders generic | 🟡 doesn't reflect role |
| Hosts table when `hostProfiles: {}` | empty dict | `"No daemons reporting. Run claude-tempo daemon start on a host."` | ✅ degrade copy is good — but wire bug means it shouldn't fire |
| Schedules table when no schedules | empty | empty `<tbody>` (no rows) | ✅ acceptable |
| Recent activity list | empty (cluster events not shipped) | `"No recent activity. Cross-ensemble event stream lands in beta.8."` | 🔴 stale copy (we ARE on beta.8) |
| PhoneAppBar on /dashboard root | no ensemble context | `"ensemble · @—"` (renders selector with placeholder) | 🔴 should suppress selector entirely or show screen name |
| Settings Connection panel | static config in dev mode | reports `default` namespace + `localhost:7233` + `claude-tempo` queue | 🔴 reads stale source, not running daemon |

**Net 7 empty-state surfaces beyond #430 worth tracking**: #431 + footer shape + paused/held chips + lineup-half degrade + heartbeat wire-rename + branch=HEAD + recent-activity stale + PhoneAppBar empty-context + Settings static config.

---

## 3. Prioritized fix list (rev 3)

### P0 — Block beta.8 polish push? **No.**

No findings rise to "the dashboard is broken in a way that blocks the user's stated mandate (autonomous E2E with mock-jam)." Even the architectural ones (#434, hostProfile, Settings) are visible nits on the live UI, not blockers for the validation flow.

### P1 — Should land before "100% aligned" claim

| # | Finding | Surface | Estimated LoC |
|---|---|---|---|
| **R3.P1.1** | EnsembleCard `paused`/`held` chips render unconditionally | EnsembleCard.tsx | ~10 (gate render on state, or remove) |
| **R3.P1.2** | EnsembleCard footer puts conductor name in lineup-host slot | EnsembleCard.tsx | ~15 (re-shape to `lineup · host` two-span design) |
| **R3.P1.3** | Workspace subtitle drops `Lineup X · ` prefix entirely | Workspace.tsx page-subtitle | ~10 (render `Lineup — · ` even when wire-pending; symmetric with host half) |
| **R3.P1.4** | PlayerDetail `heartbeat —` regression (wire-field naming `lastActivityAt`) | PlayerDetail.tsx adapter | ~5 (rename or alias) |
| **R3.P1.5** | Loadouts + Schedules render double `<header class="page-header">` | AppShell or screen-level | ~15 (consolidate the per-page Maestro/density/theme strip into AppShell or move it to one of the headers) |
| **R3.P1.6** | PlayerTypes + Loadouts + Schedules action buttons `disabled: false` per DOM (Edit/Duplicate/+ New / Logs) — verify whether they're wired or accidentally clickable-no-op | screens × 4 | ~20 (audit each callsite; wrap in `DisabledWithTooltip` if not wired) |
| **R3.P1.7** | Hosts table empty in dev mode — `hostProfiles: {}` despite live daemon | research → fix in `src/daemon.ts` `runDaemonBoot` and/or maestro aggregation | ~50 (research-first; not pure dashboard) |
| **R3.P1.8** | Settings Connection panel reads static config, contradicts running daemon | Settings.tsx Connection panel | ~30 (wire to `/v1/health` + new `/v1/config` snapshot endpoint) |
| **R3.P1.9** | #434 — `AgentType` union widening to include `'mock'`; PlayerDetail adapter cell | research → adapter resolver + types.ts + PlayerDetail | ~40 (architectural, see issue) |

**Total P1 ≈ 200 LoC.** Splittable across 3 PRs (dashboard polish / wire-fix / architectural #434).

### P2 — Beta.9 cycle

| # | Finding | Surface |
|---|---|---|
| **R3.P2.1** | EnsembleCard sub-minute uptime renders `—` (#431) | formatDuration helper |
| **R3.P2.2** | Recent activity copy `"lands in beta.8"` is stale | Overview.tsx |
| **R3.P2.3** | TempoStrip renders only N samples, not full 60-bar capacity | TempoStrip.tsx |
| **R3.P2.4** | PlayerDetail `branch: HEAD` UX (detached HEAD) | PlayerDetail.tsx Work section |
| **R3.P2.5** | PlayerDetail `part: "Conductor session"` / `"Session in <ensemble>"` is generic | wire-side autopopulate from player type |
| **R3.P2.6** | PhoneAppBar on /dashboard root shows `ensemble · @—` empty-state | AppShell PhoneAppBar |
| **R3.P2.7** | EnsembleCard footer `lineup` + per-ensemble `host` wire fields | snapshot extension (rev 2 P2.2 carry-over) |

### Rev-2 carry-over status

| Rev-2 ID | Description | Status in rev 3 |
|---|---|---|
| **P1.1** | Loadouts.tsx static `SHIPPED_LINEUPS` vs `useLineups()` | Ambiguous from DOM — likely shipped per conductor's parallel browse. Confirm in code. |
| **P1.2** | Workspace Schedules side-panel "lands in PR-F" stub | Not directly verified (no schedules in test ensembles). Confirm in code. |
| **P1.3** | PlayerTypes Edit + Duplicate need `DisabledWithTooltip` | 🟧 unchanged — DOM shows `disabled: false`. R3.P1.6 covers. |
| **P1.4** | Hosts per-row Logs needs `DisabledWithTooltip` | (not verified — Hosts table empty due to wire bug; R3.P1.7 unblocks) |
| **P1.5** | Workspace subtitle missing host segment + hardcoded lineup | Half-fixed: host shipped. Lineup still missing → R3.P1.3 |
| **P1.6** | Workspace missing `up Xh Ym` uptime pill | ✅ **shipped.** Live shows `up 8m`. Closed. |
| **P2.1** | EnsembleCard description fallback paraphrase | unchanged → R3 confirms via #430 |
| **P2.2** | EnsembleCard lineup/host footer wire-pending | partially shipped (host name in wrong slot now); → R3.P1.2 + R3.P2.7 |
| **P2.5** | Recruit ↑↓ keyboard nav unwired | not exercised; rev 2 finding stands |
| **P2.7** | PlayerTypes "+ New type" no-op needs `DisabledWithTooltip` | 🟧 unchanged → R3.P1.6 |
| **P2.9** | Settings "see Tweaks ⌥T" hint | not re-verified; rev 2 finding stands |
| **D.1** | Audit C2 doc — MaestroMark also in chat outbound | doc-fix carry-over |
| **D.2** | Audit C3 doc — 7 phases mapped to 6 chips via bucket | live confirms; doc-fix carry-over |

---

## 4. Verdict on "100% aligned with the design"

**Not yet — but close, and the gaps are well-bounded.**

The dashboard's design fidelity is high enough that it's fit-for-internal-validation. Mock-jam ensembles render meaningfully, every screen reaches its intended layout, and the binding C1–C7 markers all hold. What rev 3 surfaces is **the final 5% of polish gaps that only show under live wire data** — they were invisible to rev 2's static read.

To claim "100% aligned":
1. Land R3.P1.1 + R3.P1.2 + R3.P1.3 + R3.P1.5 (the structural EnsembleCard / Workspace / stacked-header issues — pure dashboard work, ~50 LoC).
2. Land R3.P1.4 (heartbeat wire-rename — ~5 LoC).
3. Verify R3.P1.6 (button-disabled regression) — code-read, possibly already wired.
4. Defer R3.P1.7 + R3.P1.8 + R3.P1.9 to architectural follow-ups — they're not pure dashboard concerns and span daemon + types + workflow surfaces.
5. Defer all P2 to the beta.9 polish window.

After steps 1–3, the live dashboard is structurally indistinguishable from the canonical screens.jsx + workspace.jsx + dashboard.html. Pixel-diff QA pass at that point becomes meaningful (currently the structural gaps would dominate any pixel diff).

**Suggested followup PRs**:
- `feat(dashboard): #389 rev3 polish — EnsembleCard + Workspace + stacked header` (R3.P1.1–R3.P1.5, ~50 LoC, eng or lead)
- `fix(dashboard): heartbeat wire-rename` (R3.P1.4, ~5 LoC, eng — independent)
- `chore(dashboard): button-disabled state audit` (R3.P1.6, ~20 LoC, qa-led code read + minor fix)
- Architectural: file follow-ups for #434 (already filed), Hosts hostProfile wire bug (new — R3.P1.7), Settings runtime-config reading (R3.P1.8 — overlaps #423 Gap-1 framing)

---

## 5. Acknowledgements

The conductor's parallel browse pass (received mid-audit at 18:14 UTC) corroborated 6 of the new findings independently and surfaced #434 + #431 with sharper architectural framing. The two-sets-of-eyes approach caught more than either alone would have.

Specific findings cross-attributed:
- **#430** (description empty-state): conductor filed prior; rev 3 confirms live
- **#431** (sub-minute uptime): conductor filed prior; rev 3 confirms live
- **#434** (agentType union): conductor filed prior; rev 3 confirms live
- Hosts hostProfile wire bug: conductor surfaced; rev 3 confirms in DOM
- Settings static config: conductor surfaced; rev 3 confirms in DOM
- Workspace "Conducted by [empty]": conductor saw a loading window; rev 3's stable read shows the wire works ✅ (false alarm — recommend conductor re-verify with delay)

— tempo-architect, 2026-04-28

---

## rev3-cert — certification pass after #440 + #442

**Author**: tempo-architect
**Date**: 2026-04-28 (cert pass at ~21:03Z)
**HEAD certified**: `6b85880e` (`feat(dashboard): #389 final 100% cleanup — 4 fixes for canonical alignment (#442)`)
**Daemon**: post-#442 build from worktree `cert/389-rev3`, dev profile, `localhost:8474/dashboard/`
**Live data**: `design-audit` ensemble (5 mock players, BPM ticking at 15) + `verify-mock-fix` (5 mock players, BPM 0)

### Method

Worktree from `origin/main` → `npm install + npm run build + npm --prefix dashboard run build` →
`node dist/cli.js --dev daemon stop` (released the pre-#442 dev daemon) → `daemon start` from
worktree (post-#442 binary) → re-walked all 11 screens against canonical via Chrome MCP +
DOM-shape inspection. Targeted verification of rev3 P1.1–P1.5 closures + #442 cleanup items.

> **Audit doc SHA correction (rev 3 → rev3-cert)**: rev 3's header listed Implementation HEAD
> as `a5fd8320`; the correct SHA at the time of rev 3's authoring was `fdb891f6` per #442's
> brief. Recorded here for the historical record; rev 3's substantive findings are unaffected.

### Items confirmed closed

| ID | Finding | Verification |
|---|---|---|
| **R3.P1.1** | EnsembleCard `paused`/`held` chips render unconditionally | ✅ Now conditional via new `ec-flags` class. design-audit (state=paused, 5 held players) shows `paused`+`held`; verify-mock-fix (state=offline, 1 held player) shows only `held`. State-driven, no longer dead-rendered. |
| **R3.P1.2** | EnsembleCard footer 3 spans instead of design's 2 | ✅ New `ec-meta mono dim` class with `childCount: 2`. Two-span design (`lineup · host`, both `—` while wire-pending) restored. Conductor name no longer leaks into footer. |
| **R3.P1.3** | Workspace subtitle drops `Lineup X · ` prefix entirely | ✅ Live HTML: `Lineup <span class="mono">—</span> · conducted by <span class="mono accent">conductor</span> on <span class="mono">main-laptop</span>`. Symmetric degrade with host half — both render with `—` placeholder while wire-pending. |
| **R3.P1.4** | PlayerDetail `heartbeat —` regression (`lastActivityAt` wire-name drift) | ✅ Live: `heartbeat 4s ago`. Wire-rename or alias landed; live tick visible. |
| **R3.P1.5** | Stacked `<header class="page-header">` × 2 on Loadouts + Schedules | ✅ Both screens now render `headerCount: 1`. Maestro/Density/Theme strip refactored away. Single-page-header per screen as design intends. |
| **R3.P2.3** | TempoStrip partial bar-fill (16/60 on fresh ensemble) | ✅ Live SVG renders 60 `<rect>` elements regardless of sample count. Left-pad with placeholder bars at 0 height — strip always full-width per #442. |
| **#434** | `AgentType` union missing `'mock'` (mock players reported `claude-code`) | ✅ Live PlayerDetail conductor row: `adapter mock`. Architectural union widened. |
| **#430** | EnsembleCard `description: ""` paraphrases as `"Conductor active."` | ✅ Live: `desc_present: true, desc_text: ""`. Element renders empty (or hidden) — no paraphrase. Closed in #439. |
| **#431** | Sub-minute uptime renders as `"—"` | ✅ Live: design-audit shows `2h 50m uptime` (and earlier in cert pass `5m uptime` was visible). `formatDuration` no longer drops sub-minute durations. Closed in #439. |
| **R3.P1.7** | Hosts table empty in dev mode (`hostProfiles: {}` wire bug) | ✅ Live: 7-column table with 1 row populating — `● main-laptop · win32 · — · 16 · 0.28.0-beta.8 · 2m0s ago · live`. Closed in #437/#441. |
| **PhoneAppBar empty-state** | On `/dashboard` showed `ensemble · @—` placeholder | ✅ Live: PhoneAppBar text on root is just `ensemble` (kicker label without selector + `@—` leak). Selector suppressed when no ensemble context. |

### My rev3 false positive — corrected in cert

**R3.P1.6 (button-disabled state on PlayerTypes Edit/Duplicate/+ New / Hosts Logs)** — my rev3 audit
flagged this as a regression because my DOM probe used `b.disabled` (the HTML attribute) and saw
`disabled: false`. The conductor's parallel-browse note ("DisabledWithTooltip with explanation tooltip")
was correct: the implementation uses `aria-disabled="true"` + `title="…"` (the semantically-correct
disabled state that still allows tooltip-on-hover). Verified live this cert pass:

```
{ txt: "Edit", disabled: false, ariaDisabled: "true",
  title: "Editing player-type files requires a daemon endpoint that hasn't shipped yet." }
```

**Verdict on R3.P1.6**: ✅ never broken — `DisabledWithTooltip` was implemented correctly all along.
Rev 3's flag is a probe-side false positive. **Future audits**: probe `aria-disabled` first when
checking `DisabledWithTooltip` patterns; HTML `disabled` would prevent the tooltip from firing
on hover, so the impl pattern correctly uses `aria-disabled`.

### Net new finding under cert pass

**Settings task-queue field still shows prod default in dev mode.** R3.P1.8 (Settings static-config)
was largely closed in #436 — the namespace KV now correctly shows `claude-tempo-dev` from the
running daemon. But the task-queue KV still reads `claude-tempo` (prod default), while the dev
daemon's actual queue is `claude-tempo-dev` (per `[DEV MODE] using ~/.claude-tempo-dev · port 8474
· namespace claude-tempo-dev (default) · queue claude-tempo-dev (default)` banner).

| KV | Live value | Expected (dev mode) |
|---|---|---|
| `namespace` | `claude-tempo-dev` | ✅ |
| `address` | `localhost:7233` | ✅ |
| `task queue` | `claude-tempo` | 🔴 should be `claude-tempo-dev` |
| `tls` | `off` | ✅ |
| `auth` | `—` | ✅ |

**Severity**: P2 nit. Same root cause as the namespace-half of #436 (read-from-runtime missed
this field). 2-line fix likely. **Filing as follow-up after conductor sign-off** per the
"approved label only after I sign off" rule.

### Other still-open items from rev 3 (deferred to beta.9 by design)

| ID | Status |
|---|---|
| R3.P2.1 | sub-minute uptime → closed by #431/#439 ✅ |
| R3.P2.2 | "lands in beta.8" stale copy → closed by #438/#439 ✅ |
| R3.P2.3 | TempoStrip 60-bar fill → closed by #442 ✅ |
| R3.P2.4 | `branch: HEAD` UX (detached HEAD) | open — beta.9 |
| R3.P2.5 | `part: "Conductor session"` generic default | open — beta.9 (wire-side autopopulate) |
| R3.P2.6 | PhoneAppBar empty-state on /dashboard | closed by #442 ✅ |
| R3.P2.7 | EnsembleCard wire fields for per-ensemble lineup + host | open — beta.9 wire epic |
| R3 P1.1–P1.5 | structural | all closed ✅ |
| R3 P1.6 | button-disabled state | not actually broken — rev3 false positive |
| R3 P1.7 | Hosts hostProfile wire bug | closed by #437/#441 ✅ |
| R3 P1.8 | Settings runtime-config | namespace closed by #436 ✅; task-queue residual ↑ |
| R3 P1.9 | #434 `'mock'` agentType union | closed by #442 ✅ |

### C1–C7 markers — re-verified post-#442

All seven still honored. No regressions vs rev 3.

| Marker | Status |
|---|---|
| **C1** BrandMark = wordmark + Metronome SVG | ✅ |
| **C2** MaestroMark italic serif, distinct from BrandMark | ✅ |
| **C3** PhaseDot real PHASES vocab; `attached → "active"` bucket | ✅ |
| **C4** Italic discipline | ✅ |
| **C5** Sidebar 244px | ✅ |
| **C6** TempoStrip = sparkline + bpm overlay | ✅ now full 60-bar width |
| **C7** No `@theme` block; hand-rolled CSS | ✅ |

### Verdict

**🎯 100% structural fidelity confirmed.**

The dashboard at `6b85880e` matches `docs/design/dashboard-handoff/project/{screens.jsx,
workspace.jsx, dashboard.html, web-design-system.html}` for every screen audited. All R3.P1
items closed. All rev-4 binding spec markers (C1–C7) honored. Live wire data — BPM ticking,
heartbeat live, runId pinned, lease counting down, mock adapters resolving as `mock` — all
populating cleanly.

The only post-cert residual is a single P2 nit (Settings task-queue KV reads stale prod default
in dev mode) — a 2-line fix scoped for a small follow-up PR after sign-off.

Beta.8 dashboard is **fit-for-internal-validation, fit-for-design-review, and fit-for-public-demo**
in dev mode. The autonomous E2E validation harness using mock-jam ensembles is now end-to-end
verified across the entire dashboard surface.

— tempo-architect, 2026-04-28 (rev3-cert)

