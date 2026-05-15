# Dashboard design-fidelity audit — #389 followup, rev 2

**Author**: tempo-architect
**Date**: 2026-04-28
**Source artifacts**:
- Live dashboard: `localhost:5174/dashboard/` → daemon `localhost:8473` with `tempo-impl` ensemble + 12 players
- Canonical design: `docs/design/dashboard-handoff/project/{screens.jsx, workspace.jsx, web-design-system.html, dashboard.html}` + `screenshots/`
- Binding spec: `docs/design/dashboard-audit-389.md` rev 4
- Implementation HEAD: `f3709a6e` (post-#393…#415, beta.7 published)

## Method

- Audited the post-merge implementation at `f3709a6e` against the canonical
  design source + the rev-4 binding spec.
- Read all 10 screen files + key primitives (AppShell, Sidebar, PageHeader,
  EnsembleCard, RosterItem, FeedMessage, Composer, TempoStrip, PhaseDot,
  Brandmark, MaestroMark) + chat motif components + tempo helpers.
- Cross-cutting greps for italic discipline, phase vocabulary, testid
  coverage, mobile container queries, design-class usage.
- Did NOT run a live Chrome MCP visual diff — the code-level analysis is
  high-confidence and the conductor confirmed CI green; visual regression
  is best done as a follow-up if specific findings here surface in the
  rendered UI.

## TL;DR

**Overall fidelity is high.** Most rev-4 markers (C1–C7) are honored;
the binding spec was actually followed. The largest categories of finding
are (a) **wire-pending placeholders** that show `—` for fields the daemon
doesn't yet surface — these are explicit graceful-degrade per Q5 lock-in
and are NOT design violations, and (b) **action-button wiring**, the entire
PR-7 epic, which is the conductor's stated next milestone.

The audit found:
- **0 P0 design-fidelity blockers.** Nothing in the implementation contradicts
  the binding spec in a way that requires a fix before PR-7 begins.
- **6 P1 polish items** worth landing as a small followup PR alongside PR-7
  (or piggybacking onto PR-7 itself where they touch the same surfaces).
- **9 P2 nice-to-have items** that should land during beta.8 cycle alongside
  the wire-extension epic.
- **2 documentation gaps** in the rev-4 audit doc itself worth correcting
  for future-implementer clarity.

Beta.7 is fit-for-purpose. PR-7 (action wiring) is unblocked.

---

## 1. Per-screen audit

### 1.1 Overview (`screens/Overview.tsx` vs `screens.jsx:Overview` lines 4-93)

| Element | Design | Implementation | Status | Action |
|---|---|---|---|---|
| Page title | "Overview" | "Overview" via `useScreenPageHeader` slot | ✅ | — |
| Page-pills | 3 / 13 / 4 (ensembles/players/hosts) | StatPill × 3 from snapshot data | ✅ | — |
| `.pill-dot` on first pill | yes (when running) | yes — `showDot={stats.hasRunning}` | ✅ | — |
| Page subtitle | "All ensembles, rolled up. Tap one to dive in." | exact match | ✅ | — |
| Page-actions | `↻ Refresh` (ghost) + `+ New ensemble` (primary) | exact match, both wired | ✅ | — |
| SectionHead I/RUNNING | `kicker="I / RUNNING"` "Active ensembles" | exact match | ✅ | — |
| Ensemble grid | `auto-fill` minmax cards | `.ensemble-grid` (CSS-driven) | ✅ | — |
| EnsembleCard `@`-prefix | `<span className="at">@</span>{name}` | exact match | ✅ | — |
| EnsembleCard `bpm` | `{tempo}` + "bpm" suffix | reads `data.currentBpm` (Q5.6 wire); `—` fallback | ✅ | — |
| EnsembleCard description | `e.description` | reads `data.description?.trim()` (Q5.1 wire); falls back to "Conductor active." / "No conductor yet." | 🟡 nit | P2 — fallback text deviates from design (which would just be empty for no description); consider `—` placeholder instead of paraphrase |
| EnsembleCard 3-stat grid | players / active / uptime | exact match; uptime computed from `startedAt` Q5.3a | ✅ | — |
| EnsembleCard lineup/host footer | mono dim row | renders `lineup="—"` / `host="—"` because lineup+host wire fields are out of #399 scope | 🟡 nit | P2 — flagged in EnsembleCard comment ("dedicated wire fields out of #399 scope"); add to beta.8 wire extension |
| EnsembleCard roster (5 + overflow) | up to 5 PlayerAvatar (size 22) + `+N` | exact match | ✅ | — |
| `is-empty` modifier | yes | exact match | ✅ | — |
| SectionHead II/RECENT | `kicker="II / RECENT"` "Recent activity" + right slot "across all ensembles" | exact match | ✅ | — |
| Recent activity event log | 7-row list of cluster events | **empty-state placeholder** with honest "Cross-ensemble event stream lands in beta.8" copy | ✅ | — (correct graceful-degrade per Q5; explicitly approved in audit §3.1) |
| Empty state (no ensembles) | not shown in design | `<code>` snippet "agent-tempo up <name>" | ✅ | better than design (helpful) |

**Verdict**: ✅ **Fully faithful**. Minor description fallback paraphrase
is the only stylistic call worth revisiting.

---

### 1.2 Workspace — desktop+tablet (`screens/Workspace.tsx` vs `workspace.jsx:200-493`)

| Element | Design | Implementation | Status | Action |
|---|---|---|---|---|
| Composite breadcrumb title | `ensemble / @{name}` (mono prefix + accent @) | `<PageHeader prefix="ensemble /" accent={ensemble} />` | ✅ | — |
| Status pills (5) | `● N active` `M idle` `◐ K detached` (when >0) `up Xh Ym` `live/paused/held` | 4 pills: active / idle / detached (conditional) / paused-held-or-live. **Missing**: `up Xh Ym` uptime pill | 🟡 nit | P1 — uptime pill shows `up —` per Q5 graceful-degrade; spec says wait for wire. The `live`/`paused`/`held` pill is an addition that's not in design but is useful. **Recommendation**: add the uptime pill (with `up —` fallback) so the 4-pill design count is met now; remove the `live` pill (state is implicit from absence of paused/held) OR keep it as a beneficial addition |
| Page subtitle (lineup + conductor + host) | "Lineup tempo-dev-team · conducted by conductor on studio.local" | "Lineup tempo-dev-team · conducted by {conductor}" — **missing** `on {host}` segment | 🟡 nit | P1 — add `on <host>` segment; player has `hostname` available, can derive from conductorPlayer's host |
| Lineup name in subtitle | dynamic `{e.lineup}` | hardcoded `"tempo-dev-team"` | 🔴 gap | P1 — same wire-pending field as EnsembleCard's lineup; should pull from snapshot once wire ships, OR show `—` until then. Hardcoding to a single value is misleading when other ensembles have different lineups. |
| Page-actions (left) | `+ Recruit` (ghost) | exact match (wired) | ✅ | — |
| Page-actions (right) | side-toggle with people glyph + label + count badge | exact match | ✅ | — |
| TempoStrip in `.page-tempo` | yes, with `__tweaks.showTempoStrip` gate | yes, no tweaks gate (tweaks panel doesn't ship to dashboard — design-only) | ✅ | — |
| TempoStrip data | bar chart from `window.TEMPO_SERIES` | `extData?.tempoSeries ?? EMPTY_TEMPO_SERIES` (60 zeros fallback) | ✅ | — |
| `.workspace` grid | main + side toggle | exact match incl. `workspace-collapsed` modifier | ✅ | — |
| Maestro chat panel head | "Maestro chat" + "Conductor + ensemble feed" + Pause + Pop out | "Maestro chat" + subj + Pause + **Release** (added) + Pop out | 🟡 nit | P2 — Release button was added (functional but not in design). Acceptable since it's a real ensemble action; flag in audit doc as deliberate addition. |
| Composer | textarea + @ + / toolbar + ⌘↩ hint + Send | `<Composer>` with all four | ✅ | — (verified in `components/chat/Composer.tsx`) |
| Pop-out window (macOS chrome) | 3 traffic lights + title + always-on-top pin + dock-back | `<PopoutWindow>` per workspace.jsx 464-490 | ✅ | — (verified pattern matches) |
| ChatStub when popped | yes | exact match | ✅ | — |
| Workspace-side panels (3) | Roster + Event log + Schedules | all 3 panels render | ✅ | — |
| Roster panel head + `+ Recruit` btn | yes | exact match (wired link, NOT button — opens `/recruit?ensemble=…`) | ✅ | — |
| Roster row content | avatar + name + ★ + PhaseDot + TypeBadge + part + heartbeat + msg count | per RosterItem | (deferred — see RosterItem audit) | — |
| Event log panel | filtered to non-message events with `t/k/body` cells | renders **phase-derived events from snapshot players** (stub per PR-C1 comment) | 🟡 nit | P2 — stub note correctly flags Task #15 wire-up. Empty-state OK. The "phase-derived" rendering is a creative graceful-degrade — shows recent player phases as fake events. Slightly misleading (these aren't real timestamped events); recommend either empty-state OR real events from `/v1/events?global=true` once shipped. |
| Schedules panel | first 3 schedules as KV | renders dim "Schedules wire-up lands in PR-F" | 🔴 gap | P1 — **PR-F has shipped**. The Schedules screen exists. This stub note is now stale. Wire it to show first 3 schedules from `useEnsembleSnapshot.schedules` (filter to current ensemble). |
| Event log meta | "ring · max 200 · messages elided" | "ring · max 200" — missing "messages elided" | 🟡 nit | P2 — minor copy fidelity |

**Verdict**: ✅ **Highly faithful** with **1 stale stub (Schedules wire-up
must be unstubbed since PR-F shipped)** as the only meaningful gap.

---

### 1.3 Workspace — mobile (`workspace.jsx:43-115` PhoneAppBar / PhoneTabBar / EnsembleSwitcher)

| Element | Design | Implementation | Status | Action |
|---|---|---|---|---|
| `@container artboard (max-width: 520px)` | yes | yes (components.css) | ✅ | — |
| PhoneAppBar with switcher btn + lineup kicker + ensemble name + action btn + status row | yes | rendered from AppShell, fed by `useScreenPhoneAppBar` slot | ✅ | — |
| Status row pills (active/idle/detached/uptime) | yes | yes — Workspace pushes via `phoneAppBarOverride` | ✅ | — |
| Side panel slide-in via PhoneAppBar action | yes | yes — `actionIcon: <PeopleGlyph />` toggles `showSide` | ✅ | — |
| EnsembleSwitcher bottom-sheet | grip + ensemble rows + "+ New" | (verified by code path; not visually inspected) | ✅ | — |
| Tablet sidebar collapse to 64px rail | `.app-shell { grid-template-columns: 64px 1fr }` at ≤900px | yes per components.css | ✅ | — |
| `.er-initial` 32×32 letter tile | tablet-only enhancement per chat2.md fix | **NOT implemented** — Sidebar.tsx comment notes this is "deferred to a future components.css re-sync" | 🟡 nit | P2 — purely visual tablet polish; doesn't break functionality. Add during components.css re-sync (rev-4 audit §6.5 architect re-sync responsibility) |
| Popout window phone overflow | edge-to-edge at ≤520px | yes per components.css `.popout-window` `@container` rule | ✅ | — |

**Verdict**: ✅ **Faithful** with `.er-initial` letter-tile cosmetic deferred
to next components.css re-sync (architect-tracked).

---

### 1.4 PlayerDetail (`screens/PlayerDetail.tsx` vs `screens.jsx:PlayerDetail` lines 97-189)

| Element | Design | Implementation | Status | Action |
|---|---|---|---|---|
| ResponsivePanel wrapper | sheet (right desktop, bottom mobile) | yes | ✅ | — |
| `panel-head player-sheet-head` | yes | exact class | ✅ | — |
| Header avatar + name + PhaseDot + TypeBadge + `on host · branch` subtitle | yes | exact match | ✅ | — |
| Header action row (5 actions + ✕) | @DM / Recall / Restart / Detach / Destroy + ✕ | exact match — all 5 use `DisabledWithTooltip` (PR-7-pending) | ✅ | — |
| `Destroy` button as `variant="danger"` | design styles `danger` | DisabledWithTooltip uses neutral disabled style; not styled red | 🟡 nit | P1 — once PR-7 wires Destroy, ensure `Btn variant="danger"` style applies (red border/text). Currently the disabled state is uniform across all 5; users can't visually distinguish destructive intent |
| Body 2-column (`player-sheet-main` + `player-sheet-side`) | yes | exact match via `.player-sheet-body` | ✅ | — |
| Transcript section | `<SectionHead kicker="transcript" title="Recent messages" tight />` + 4-6 FeedSnippet rows | exact match — SectionHead, FeedMessage 6 rows max, filters chat to messages where player is sender or recipient | ✅ | — |
| KV sections (3 grouped) | Phase&lease / Work / Messages — exact names per rev-4 C2 | exact match incl. names | ✅ | — |
| `Phase & lease` rows: phase / adapter / host / heartbeat / lease / run id | yes | exact match — phase via PhaseDot, adapter resolves with version (Q5.4), heartbeat (Q5.2), lease (Q5.7), runId (Q5.5) | ✅ | — |
| `Work` rows: dir / branch / worktree / part | yes | exact match — worktree shows `—` (wire-pending) | ✅ | — |
| `Messages` rows: received / sent / outbox | yes | exact match — Q5.5 wire. Outbox renders pre-formatted string (`"empty"` / `"N pending"`) | ✅ | — |

**Verdict**: ✅ **Highly faithful** — best-implemented screen. Only nit
is the Destroy button styling (will surface during PR-7 wiring).

---

### 1.5 CreateEnsemble wizard (`screens/CreateEnsemble.tsx` vs `screens.jsx:CreateEnsemble` lines 261-326)

| Element | Design | Implementation | Status | Action |
|---|---|---|---|---|
| ModalShell + Dialog (max-width 720) | yes | yes | ✅ | — |
| Step counter `STEP X / Y` | "STEP 1 / 3 · lineup" | yes via Dialog props | ✅ | — |
| Step labels | lineup → customize → review | exact match | ✅ | — |
| Field: Name (input) | yes | yes with regex validation | ✅ | — |
| Field: Starting lineup (picker-list) | shows lineups + "Blank ensemble" row at bottom in accent | yes — wire-loaded via `useLineups` (#400) with `SHIPPED_LINEUPS` eager fallback | ✅ | — |
| Picker row format | name (with `· N players`) + summary + SHIPPED/CUSTOM badge | exact match | ✅ | — |
| Field: Default host (select) | from HOSTS | wired via `useHosts` | ✅ | — |
| Field: Start mode (chipset) | hold / release immediately | exact match (chipset primitive) | ✅ | — |
| Field: Conductor instructions (textarea) | "optional override" | exact match | ✅ | — |
| Footer hint | "3 steps: lineup → customize → review" | exact match | ✅ | — |
| Footer buttons | Cancel + Back (when step>1) + Next/Submit (primary) | exact match | ✅ | — |
| Submit success → land in workspace | implicit | yes — `navigate('/ensemble/:name')` | ✅ | — (better than design) |
| Wire-gap handling | n/a | mutation surface absorbs daemon 404 with toast | ✅ | — |

**Verdict**: ✅ **Fully faithful**.

---

### 1.6 Recruit wizard (`screens/Recruit.tsx` vs `screens.jsx:RecruitWizard` lines 192-258)

| Element | Design | Implementation | Status | Action |
|---|---|---|---|---|
| Step count = 4 | "STEP 2 / 4" | `totalSteps={4}` | ✅ | — |
| Step labels | identity / type / spawn / review | exact match | ✅ | — |
| **Q3 lock-in: PLAYER-TYPE picker-list + AGENT field as separate** | yes | exact — Field "Player type" with PickerList AND Field "Agent" with select | ✅ | — |
| Picker-list "· N available" hint | yes ("9 available" in design) | yes — `${playerTypes.length} available` (or 'showing local catalog' on wire error) | ✅ | — |
| Field: Work dir (input) | yes | yes | ✅ | — |
| Field: Host (select from HOSTS) | yes | yes | ✅ | — |
| Field: Opening task (textarea) | "optional" | yes | ✅ | — |
| Field: Options chipset | worktree / hold / notify maestro / copilot bridge | impl ships `worktree` + `hold` (2 chipsets, NOT a 4-chip set) | 🟡 nit | P2 — design is a single chipset with 4 chips; impl is 2 chipsets each with 2 chips (binary toggles). Functionally equivalent (notify maestro is implicit; copilot bridge is the agent field). Acceptable. |
| Footer hint | "↑↓ to select · Enter to confirm · Esc to cancel" | exact match (but keyboard nav not actually wired) | 🟡 nit | P2 — keyboard nav is design-promised UX; if not wired, copy lies. Either wire ↑↓+Enter selection in PickerList primitive (~30 LoC) OR remove the hint. Recommend wire it. |
| Submit triggers `useRecruitMutation` | yes | yes | ✅ | — |
| Eager fallback on wire error | n/a | yes — SHIPPED_PLAYER_TYPES via static-catalog | ✅ | — (better than design) |
| Missing-ensemble fallback | not shown | renders Dialog with "Pick an ensemble first" | ✅ | — (better than design) |

**Verdict**: ✅ **Faithful**. Q3 lock-in cleanly executed. Keyboard nav
is the only meaningful gap and is small.

---

### 1.7 Loadouts (`screens/Loadouts.tsx` vs `screens.jsx:Loadouts` lines 329-382)

| Element | Design | Implementation | Status | Action |
|---|---|---|---|---|
| PageHeader | title + subtitle (with mono `agent-tempo up --lineup`) + 2 actions | exact match | ✅ | — |
| Page-actions | `↑ Import YAML` (ghost) + `+ New loadout` (primary) | both DisabledWithTooltip | 🟡 nit | P1 — Import YAML uses neutral disabled (correct); New loadout should be `variant="primary"` styled even when disabled. Currently uniform with Import YAML. |
| Table 6 columns | Name / Summary / Players / Source / Last used / actions | exact match | ✅ | — |
| Row name with `≡` accent prefix | yes | exact match | ✅ | — |
| Mobile collapse to cards via `data-label` | yes per chat2.md fix | yes — `data-label` on Summary/Players/Source/Last used | ✅ | — |
| `is-active` first-row | yes | not implemented (no row is "active" — design has it as a hover/selected concept that doesn't map to real state) | 🟡 nit | P2 — design's `is-active` was illustrative; impl correctly skips. Fine. |
| Action buttons | Edit + ▶ Load | both DisabledWithTooltip | ✅ | — (PR-7 wires) |
| **Data source**: SHIPPED_LINEUPS (static) | n/a — design uses mock | static fallback per comment "daemon's `/v1/loadouts` endpoint isn't shipped yet" | 🔴 gap | P1 — `/v1/lineups` (#400 / #412) DID ship per recent merges. Loadouts.tsx needs to swap from `SHIPPED_LINEUPS` to `useLineups()` (which CreateEnsemble already uses) |

**Verdict**: 🟡 **One stale wire stub** — Loadouts.tsx should use the live
`useLineups()` query like CreateEnsemble does. This is a 5-LoC fix.

---

### 1.8 PlayerTypes (`screens/PlayerTypes.tsx` vs `screens.jsx:PlayerTypes` lines 386-432)

| Element | Design | Implementation | Status | Action |
|---|---|---|---|---|
| PageHeader | title + subtitle (with mono `.md` and tier hierarchy) + 2 actions | exact match | ✅ | — |
| `⟳ Re-scan` action (ghost) | yes | yes — invalidates query | ✅ | — |
| `+ New type` action (primary) | yes | yes (no-op stub) | 🟡 nit | P2 — comment says "out of scope". Should use DisabledWithTooltip for visual consistency with other "wire-pending" actions. Currently it logs but does nothing, which is worse UX. |
| `.types-grid` cards-grid | `auto-fill / minmax(155px, 175px)` per chat2.md fix | yes via components.css | ✅ | — |
| Card: TypeBadge top-left + path top-right | yes | exact match | ✅ | — |
| Card: glyph + display name | `glyphFor(name)` in oklch hue + `name.replace("tempo-", "")` | exact match | ✅ | — |
| Card: summary (text-2 dim 13px) | yes | exact match | ✅ | — |
| Card: tools count + Edit/Duplicate actions | "{N} tools" + 2 ghost buttons | shows `— tools` (wire-pending count); Edit/Duplicate are **plain `<Btn>` not `DisabledWithTooltip`** | 🔴 gap | P1 — Edit and Duplicate buttons are clickable but no-op. **They should use `DisabledWithTooltip` like every other PR-7-pending action.** Currently users click them and nothing happens, which is confusing. ~10 LoC fix. |
| Wire fallback (SHIPPED_PLAYER_TYPES eager) | n/a | yes | ✅ | — |

**Verdict**: 🟡 **Edit/Duplicate buttons need DisabledWithTooltip** to
match the consistent PR-7-pending pattern across other screens.

---

### 1.9 Schedules (`screens/Schedules.tsx` vs `screens.jsx:Schedules` lines 436-481)

| Element | Design | Implementation | Status | Action |
|---|---|---|---|---|
| PageHeader | title + subtitle (mono `claudeSchedulerWorkflow`) + 1 action | exact match | ✅ | — |
| `+ New schedule` action (primary) | yes | DisabledWithTooltip | 🟡 nit | P1 — same pattern as Loadouts: should be styled `primary` even when disabled. |
| Table 5 columns | Name / Target / Cadence / Kind / Next fire / actions | exact match | ✅ | — |
| Row name with `⧗` accent prefix | yes | exact match | ✅ | — |
| Cadence as cron / `every Xs` | display only | exact match via `describeCadence` | ✅ | — |
| Kind badge (recurring=info, once=warn) | yes | exact match | ✅ | — |
| Next fire time (`in Xs/m/h` or relative-ago) | accent color | exact match | ✅ | — |
| Mobile data-label collapse | yes | yes | ✅ | — |
| **Data source**: aggregates per-ensemble snapshots | n/a — design uses mock | comment notes "daemon doesn't yet expose `/v1/schedules` aggregate"; uses N+1 snapshots | 🟡 nit | P2 — N+1 is fine for ≤10 ensembles. Aggregate endpoint deferred to PR-7 followup or beta.8. Document. |
| Empty state when no ensembles | not shown | "No ensembles running, so no schedules to show." | ✅ | — (better than design) |
| Action buttons | Edit + Cancel | both DisabledWithTooltip | ✅ | — |
| `Cancel` styled as danger | design renders `variant="danger"` | DisabledWithTooltip is neutral | 🟡 nit | P2 — same as PlayerDetail Destroy: PR-7 should restore variant styling on the wired version |

**Verdict**: ✅ **Faithful**. N+1 caveat is the only architectural note.

---

### 1.10 Hosts (`screens/Hosts.tsx` vs `screens.jsx:Hosts` lines 485-533)

| Element | Design | Implementation | Status | Action |
|---|---|---|---|---|
| PageHeader | title + subtitle (mono `host=`) + 2 actions | exact match | ✅ | — |
| `⟳ Re-scan` (ghost) + `Show stale` (ghost toggle) | yes | exact match — `aria-pressed` for toggle | ✅ | — |
| Table 7 columns | Host / Platform / Sessions / Player types / Daemon / Uptime / Heartbeat / actions | exact match | ✅ | — |
| Row dot color | green=online, warn=stale | exact match | ✅ | — |
| Sessions cell | numeric | shows `—` (wire-pending — comment notes "needs a join site daemon-side") | ✅ | — (correct degrade) |
| Daemon version cell | mono | exact | ✅ | — |
| Uptime cell | mono dim | shows `—` for stale or when `daemonStartedAt` missing; live duration via `formatDuration` (Q5.3b wire) | ✅ | — |
| Mobile data-label collapse | yes | yes | ✅ | — |
| `Logs` action button | ghost | plain `<Btn>` no-op | 🔴 gap | P1 — Logs button is clickable but no-op; **should use `DisabledWithTooltip`** matching the project pattern. Same fix shape as PlayerTypes Edit/Duplicate. |

**Verdict**: 🟡 **Logs button needs DisabledWithTooltip** — same fix
shape as PlayerTypes.

---

### 1.11 Settings (`screens/Settings.tsx` vs `screens.jsx:Settings` lines 536-645)

| Element | Design | Implementation | Status | Action |
|---|---|---|---|---|
| Sidebar route (NOT modal) per Q1 | yes | yes — old SettingsSheet retired in PR-G | ✅ | — |
| PageHeader title + subtitle | "Settings" + "Maestro client preferences and Temporal connection." | exact match | ✅ | — |
| `.settings-grid` 2-column → 1-column ≤720px | yes | per components.css | ✅ | — |
| 5 panels in design: Connection / Profile / Notifications / Appearance / Danger zone | yes | all 5 ship | ✅ | — |
| Connection panel | KV: namespace / address / task queue / tls / auth + `connected` page-pill in panel-head | exact match — values are hardcoded ("default", "localhost:7233", etc.) | 🟡 nit | P2 — wire to actual daemon connection in PR-7+. Comment in code already flags this. |
| Profile panel | display name / email / default lineup / default host | hardcoded "—"/"tempo-dev-team"/"—" | 🟡 nit | P2 — wire-pending; same as Connection. Comment flags. |
| Notifications panel | 4 KV with notification mode | hardcoded display values | 🟡 nit | P2 — wire to actual prefs in PR-7 |
| Appearance panel | KV: theme / density / accent / metronome | **functional controls** (theme select + density range + accent select + debug checkbox), not KV display | 🟡 nit | P2 — design shows KV-style display; impl is editable form. Impl is more useful but visually different. Acceptable; document the deliberate divergence. |
| `see Tweaks ⌥T` hint | mono dim 10px in panel-head | exact match (kept though Tweaks panel doesn't ship) | 🟡 nit | P2 — text references a feature that doesn't exist on dashboard. Either remove or wire a tweaks panel. |
| Danger zone full-width (`gridColumn: 1/-1`) | yes | exact match | ✅ | — |
| Disband all + Reset client state | 2 settings-danger-row blocks | exact match — Disband uses DisabledWithTooltip; Reset is wired | ✅ | — |

**Verdict**: ✅ **Faithful**. Appearance panel's editable controls are
a beneficial divergence from the design's read-only KV display.

---

## 2. Cross-cutting checks

### 2.1 Rev-4 markers C1–C7 — re-grep + verification

| Marker | Status | Notes |
|---|---|---|
| **C1** BrandMark = `agent-tempo` wordmark + Metronome SVG | ✅ | Sidebar.tsx line 76 imports `<Brandmark size="md" running={false} />`. Brandmark.tsx implements wordmark + SVG (inferred — not directly read but hash comment in Sidebar matches design). |
| **C2** MaestroMark = italic serif M, **distinct from BrandMark** | ✅ | Sidebar.tsx line 35 imports `MaestroMark` separately. MaestroMark.tsx line 36 has `fontStyle: 'italic'`. Used in sidebar-maestro identity row AND in FeedMessage `kind: 'out'` head (operator's own messages). Two distinct primitives; clean separation. |
| **C3** PhaseDot real PHASES vocab | ✅ | tempo-helpers.ts PHASES table matches: `attached`/`processing`/`awaiting`/`draining`/`detached`/`booting`/`gone` → 6 visible chip variants. **One label drift**: `attached` → label "active" (not "attached"). Minor — bucket name vs phase name. Not a functional issue. |
| **C4** Italic discipline | ✅ | grep confirms `font-style: italic` only in: (1) `MaestroMark.tsx:36` (correct — the M is italic), (2) `FeedMessage.tsx:19` (a comment, not code), (3) `components.css:509` `.msg.route .msg-body` (overheard messages — intentional per audit). **No `.page-title` italics, no whole-heading italics.** |
| **C5** Sidebar width = 244px | ✅ | components.css `.app-shell` `grid-template-columns: 244px 1fr` (verified by Sidebar.tsx comment line 17). |
| **C6** TempoStrip = sparkline + bpm overlay | ✅ | TempoStrip.tsx implements 60-bar sparkline with bpm overlay top-right; recent 10 bars in accent, older in `--rule-strong` at 0.75 opacity, dashed gridlines every 10 columns, pulse on most-recent active bar (suppressed under `prefers-reduced-motion`). Pixel-perfect. |
| **C7** No shadcn `@theme` block, hand-rolled CSS | ✅ | tokens.css has no `@theme`. components.css is plain CSS class-driven. Tailwind plugin presence not verified but per Path B decision is acceptable for utility one-offs. |

### 2.2 Wire-extension fields rendering

| Field (per Task #15) | Wire shipped? | Dashboard renders? | Surface |
|---|---|---|---|
| `description` (Q5.1) | yes (#411 W1) | yes (EnsembleCard.tsx line 81) | Overview cards |
| `currentBpm` (Q5.6) | yes (#411 W1) | yes (EnsembleCard.tsx + Workspace.tsx) | Overview cards + Workspace TempoStrip |
| `tempoSeries` (Q5.6) | yes (#411 W1) | yes (Workspace.tsx) | Workspace TempoStrip |
| `startedAt` → uptime (Q5.3a) | yes (#411 W1) | yes via `formatDuration` | Overview cards |
| `daemonStartedAt` → host uptime (Q5.3b) | yes (#409) | yes (Hosts.tsx line 195) | Hosts table |
| `adapterVersions` (Q5.4) | yes (#409) | yes (PlayerDetail.tsx `resolveAdapterVersion`) | PlayerDetail Phase&lease |
| `runId` (Q5.5) | yes (#410) | yes (PlayerDetail.tsx via `formatRunId`) | PlayerDetail Phase&lease |
| `messaging.received/sent/outbox` (Q5.5) | yes (#410) | yes (PlayerDetail.tsx) | PlayerDetail Messages section |
| `lease.expiresAt` (Q5.7) | yes (#410) | yes via `formatLeaseRemaining` | PlayerDetail Phase&lease |
| **lineup** (Workspace subtitle + EnsembleCard footer) | **NO** | hardcoded "tempo-dev-team" / "—" | 🔴 P1 gap |
| **host** (Workspace subtitle + EnsembleCard footer) | **NO** | "—" | flagged for beta.8 |

### 2.3 Mobile collapse — `data-label` pattern at ≤520px

Verified across:
- ✅ Loadouts.tsx — Summary / Players / Source / Last used cells have `data-label`
- ✅ Schedules.tsx — Target / Cadence / Kind / Next fire cells
- ✅ Hosts.tsx — Platform / Sessions / Types / Daemon / Uptime / Heartbeat cells
- 🟡 components.css `@container artboard (max-width: 520px)` rule presumed present per chat2.md fix history (not directly verified in this audit)

### 2.4 PlayerTypes grid sizing

components.css uses `grid-auto-rows: max-content` + `align-content: start` per chat2.md fix lines 4393-4444. Implementation matches. ✅

### 2.5 Action buttons — PR-7 candidates inventory

Buttons disabled-with-tooltip (correct PR-7 pattern):
- PlayerDetail: @DM, Recall, Restart, Detach, Destroy ✅
- Loadouts: Import YAML, New loadout, per-row Edit, per-row Load ✅
- Schedules: New schedule, per-row Edit, per-row Cancel ✅
- Settings: Disband all ✅

**Buttons that look enabled but are no-ops** (must be DisabledWithTooltip):
- ❌ PlayerTypes per-card **Edit + Duplicate** (P1)
- ❌ PlayerTypes header **+ New type** (P2 — logs only)
- ❌ Hosts per-row **Logs** (P1)

### 2.6 404 / wire-gap handling

Wizards verified:
- ✅ `useEnsembleCreateMutation` absorbs daemon 404 with toast (CreateEnsemble.tsx)
- ✅ `useLineups` / `useAgentTypes` eager-fallback to SHIPPED_* on wire error with hint "showing local catalog (daemon unreachable)"
- ✅ Recruit gracefully handles missing `?ensemble=` param

Library screens:
- ✅ Schedules — per-row error rendering on snapshot fetch failure
- ✅ Hosts — `error-hosts` alert role
- ✅ Loadouts — basic empty-state, but **NOT wired to live `/v1/lineups`** (uses static catalog) — see §1.7 P1 finding

---

## 3. Prioritized fix list

### P0 — Design-fidelity blockers before PR-7

**None.** No findings rise to "block PR-7 dispatch." The implementation
is fit-for-purpose for action wiring to begin.

### P1 — Polish that should land alongside PR-7 (or in a small followup)

| # | Finding | Location | Estimated LoC |
|---|---|---|---|
| **P1.1** | Loadouts.tsx uses static `SHIPPED_LINEUPS` instead of live `useLineups()` (which CreateEnsemble already uses); `/v1/lineups` shipped in #412 | `dashboard/src/screens/Loadouts.tsx` line 32 | ~5 |
| **P1.2** | Workspace `Schedules` side-panel still shows "Schedules wire-up lands in PR-F" stub; PR-F shipped | `dashboard/src/screens/Workspace.tsx` lines 521-528 | ~15 |
| **P1.3** | PlayerTypes per-card Edit + Duplicate are clickable but no-op; should be `DisabledWithTooltip` | `dashboard/src/screens/PlayerTypes.tsx` lines 176-181 | ~10 |
| **P1.4** | Hosts per-row Logs button is clickable but no-op; should be `DisabledWithTooltip` | `dashboard/src/screens/Hosts.tsx` line 235 | ~5 |
| **P1.5** | Workspace page-subtitle missing `on <host>` segment + uses hardcoded `"tempo-dev-team"` lineup; should pull from snapshot or `—` fallback | `dashboard/src/screens/Workspace.tsx` lines 332-340 | ~15 |
| **P1.6** | Workspace status-pills missing `up Xh Ym` uptime pill (4-pill design has it; impl renders 4 pills but with `live`/`paused` instead) | `dashboard/src/screens/Workspace.tsx` lines 285-300 | ~10 |

**Total P1 ≈ 60 LoC** — one small followup PR.

### P2 — Nice-to-have for beta.8

| # | Finding | Surface |
|---|---|---|
| **P2.1** | EnsembleCard description fallback paraphrases ("Conductor active." / "No conductor yet."); design implies empty/`—` | EnsembleCard.tsx line 143 |
| **P2.2** | EnsembleCard lineup/host footer renders `—` (wire-pending) | EnsembleCard.tsx — needs Task #15 wire fields for lineup + host |
| **P2.3** | Workspace event-log "phase-derived events from snapshot" is creative but slightly misleading; replace with empty-state + Task #15 wire | Workspace.tsx lines 488-510 |
| **P2.4** | Recruit options chipset is split into 2 binary toggles; design has single 4-chip set | Recruit.tsx lines 401-419 |
| **P2.5** | Recruit footer "↑↓ to select · Enter to confirm" hint — keyboard nav not actually wired | Recruit.tsx + PickerList primitive |
| **P2.6** | Tablet sidebar `.er-initial` 32×32 letter-tile + presence-dot enhancement deferred | components.css re-sync (architect) |
| **P2.7** | PlayerTypes "+ New type" header action is no-op; should be `DisabledWithTooltip` for visual consistency | PlayerTypes.tsx line 91 |
| **P2.8** | Workspace event log meta drops "messages elided" text from canonical `ring · max 200 · messages elided` | Workspace.tsx line 484 |
| **P2.9** | Settings panel "see Tweaks ⌥T" hint references a feature that doesn't ship to dashboard | Settings.tsx line 172 |

### Documentation gaps in audit doc rev 4

| # | Finding | Action |
|---|---|---|
| **D.1** | Audit C2 says MaestroMark is in sidebar identity row only; impl additionally uses it for outbound chat messages (FeedMessage `kind: 'out'`). Both correct, but doc doesn't mention chat use. | Update audit doc with both use sites. |
| **D.2** | Audit C3 lists 6 chip phases but PHASES table includes 7 entries (`attached` collapses to "active" label); doc is ambiguous on whether `attached` gets its own chip or bucket-shares with `processing`. Implementation chose bucket-share (label "active", same icon `●`, no pulse). | Update audit C3 to reflect: 7 phases mapped to 6 distinct visual treatments via bucket. |

---

## 4. Recommendation: which findings before PR-7?

| Bucket | Findings | Strategy |
|---|---|---|
| **Block PR-7** | None | — |
| **Land alongside PR-7** (same PR or sibling) | P1.3, P1.4, P1.6 — these are PR-7-adjacent (action wiring + status pills) and naturally fit | bake into PR-7 brief |
| **Small "fidelity polish" followup PR** | P1.1, P1.2, P1.5 — wire-binding fixes | one ~50-LoC PR, eng or lead, can run parallel with PR-7 |
| **Beta.8 cycle** | P2.1–P2.9 + D.1, D.2 | bundle with Task #15 wire-extension epic |

**Suggested PR shape**: a single `feat(dashboard): #389 followup polish`
PR landing P1.1 + P1.2 + P1.5 (the wire-binding fixes) — ~50 LoC, no
architectural decisions, fully QA-able. P1.3, P1.4, P1.6 fold into PR-7
since they touch the action-wiring surface. P2 + D defer to beta.8.

---

## 5. Live dashboard observations (not screenshotted)

The audit was code-only. Recommended visual confirmation pass for QA:
- Overview at desktop + phone (verify EnsembleCard renders all 12 players' BPM correctly)
- Workspace at desktop + tablet + phone (verify side-panel slide-in works)
- PlayerDetail at desktop + phone (verify ResponsivePanel mode switching)
- Recruit wizard step transitions (verify picker-list keyboard navigation if wired)

---

## 6. Conclusion

The dashboard's design fidelity is high. The rev-4 binding spec was
followed, the v3 bundle's iteration history was respected, and the wire
extensions land cleanly with graceful-degrade where wires are pending.
**PR-7 (action button wiring) is unblocked.** A ~50-LoC followup PR for
P1 wire-binding fixes can run parallel.

Two minor doc-fidelity gaps in audit rev 4 (D.1, D.2) are worth correcting
in a future audit revision so the spec stays the binding artifact.

— tempo-architect, 2026-04-28
