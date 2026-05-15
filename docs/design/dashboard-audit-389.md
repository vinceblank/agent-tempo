# Dashboard re-architecture audit + phasing plan (#389)

**Author**: tempo-architect
**Date**: 2026-04-28
**Revision**: 4 (post v3 bundle — vinceblank rewrote `web-design-system.html`
to match `dashboard.html` reality. 7 spec clarifications absorbed into PR
briefs. Underlying screens.jsx + styles.css UNCHANGED → PR-0 work continues.)
**Source**: v2 design bundle at `docs/design/dashboard-handoff/` (after vinceblank's
re-fetch with `chats/` + `web-design-system.html` + `workspace.jsx` populated)
**Issue**: [#389](https://github.com/vinceblank/agent-tempo/issues/389)

## Decision lock-ins (revision 2 header)

All §9 open questions are resolved as of 2026-04-28:

| # | Decision | Impact |
|---|---|---|
| 1 | Settings = sidebar route (retire SettingsSheet) | PR-G ships Settings page; SettingsSheet.tsx deleted |
| 2 | PlayerDetail KV groupings = `Phase & lease` / `Work` / `Messages` | Locked. PR-D uses these names verbatim |
| 3 | Recruit picks player-type AND adapter | PR-E adds picker-list for type + separate field for adapter |
| 4 | **Mobile responsive lands in beta.7** | **Every screen PR (B/C/D/E/F) ships with mobile. PR-A1 splits into A1 + A1m. LoC × 1.3-1.5.** |
| 5 | Snapshot wire extensions deferred to beta.8 | Task #15 spec; beta.7 degrades gracefully (— placeholder) |
| 6 | EnsembleCard description = lineup YAML field | Lineup loader extends to surface optional `description` |

## Revision 4 clarifications (v3 bundle, 2026-04-28)

vinceblank rewrote `web-design-system.html` to match `dashboard.html`/styles.css
reality (the dashboard prototype was canonical; the spec drifted; spec rewritten
to honest doc what exists). Underlying `styles.css` + `screens.jsx` UNCHANGED.

7 clarifications encoded into PR briefs below:

| # | Clarification | Affects |
|---|---|---|
| C1 | **BrandMark = `agent-tempo` mono wordmark with terracotta hyphen + swinging Metronome SVG** (NOT the v2-spec "M·aestro" italic-on-tile) | PR-A1 BrandMark primitive |
| C2 | **MaestroMark = italic serif `M` (Fraunces)** representing the OPERATOR (the human user) — separate primitive from BrandMark, not the brand | PR-A1 MaestroMark primitive (sidebar identity row) |
| C3 | **Phase chips use real codebase PHASES**: `processing` (●, --ok, pulse), `idle` (○), `draining` (◐, --warn), `detached` (◐, --warn), `booting` (◔, --dim), `gone` (✕, --dim). Codebase 7 phases map: `attached → processing` chip, `awaiting → idle` chip; rest 1:1. NOT generic playing/paused/error | PR-A2 FeedMessage PhaseDot, PR-D PlayerDetail |
| C4 | **Italic discipline (corrected)**: italic ONLY for (a) MaestroMark `M`, (b) single `<em>` accent inside a display heading ("@my-band is *listening*"). Serif display NON-italic for `.page-title` / `.section-title` / `.subj` / ensemble names | PR-A1 PageHeader / SectionHead, tokens.css typography note |
| C5 | **Sidebar width = 244px LOCKED** (not 240, not 264) | PR-A1 Sidebar primitive |
| C6 | **TempoStrip = sparkline of message activity (60 bars) with bpm overlay top-right**, neutral-colored bars at 0.75 opacity. NOT beat dots | PR-A2 TempoStrip primitive |
| C7 | **shadcn aliasing = aspirational/handoff doc** for a future React+shadcn rebuild — NOT in beta.7 scope (current implementation is hand-rolled CSS) | Documented in §6.5; confirmed not in beta.7 |

**Bonus finding (also rev 4)**: hardcoded paddings in `styles.css` (e.g.,
`14px 16px 18px` in `.types-grid`) appeared to drift from density tokens, but
the designer's audit found `styles.css` lines 54-64 contain a meta-override
block (`.panel-body`, `.panel-head`, `.roster-item`, etc.) that wins over the
d=6 baseline values further down. **No change to styles.css needed.** PR-0
ports as-is. Add a section comment in `components.css` documenting this
intentional override layer.

---

## 1. Executive summary

The dashboard at `localhost:8473/dashboard/` has **structural divergence** from the
canonical design across every screen. Earlier PRs (#367 PR-4, #370 PR-5, #369 PR-6,
#372 PR-8) shipped scaffolds and routed the right URLs, but the **content surface**
of each screen is missing 50–90% of the design's elements — buttons, sections,
cards, layout primitives, and in some cases entire panels.

The root cause is documented in #389: the local handoff bundle when PR-2 began
omitted `chats/` (the user-intent transcripts) and shipped `web-design-system.html`
as a 0-byte file. PR-2's tokens.css and the shipped sidebar/EnsembleCard primitives
were authored from incomplete inputs. Subsequent PRs built on those primitives
without re-checking the source.

The v2 bundle resolves the input gap: `web-design-system.html` is now a 1394-line
canonical spec, `chats/chat2.md` has 4977 lines of iteration history, and a brand
new `workspace.jsx` (552 lines) describes the entire EnsembleWorkspace surface that
PR-5 implemented from `screens.jsx` only.

### Recommended path (revision 2 — mobile-in-beta.7 baked in)

1. **PR-0 — Token-Library-Update**: fonts (Inter/Fraunces → Instrument Sans/Serif),
   token completeness audit, no behavior change. Lands first. ~50 LoC.
2. **PR-A1 — Layout primitives (desktop+tablet)**: Sidebar (2-section incl. tablet
   collapse to 64px icon rail with `er-initial` letter tiles), PageHeader,
   SectionHead, status-pill family, PlayerAvatar size variants, Btn, KV, Panel,
   EnsembleCard, RosterItem, EventRow, MaestroMark. ~600-700 LoC.
3. **PR-A1m — Mobile shell primitives**: PhoneAppBar, PhoneTabBar,
   EnsembleSwitcher (bottom-sheet), workspace-side slide-in mechanics with grip
   + scrim, `@container artboard` responsive helpers. Independent of A1 timing —
   may run parallel after PR-0. ~350-450 LoC.
4. **PR-A2 — Chat + Tempo primitives**: FeedMessage 3-variant, Composer with
   toolbar (@/, ⌘↩ hint, IS_MAC helper), TempoStrip data-viz, PopoutWindow + ChatStub.
   No Workspace integration. ~450 LoC.
5. **PR-B — Overview rebuild (desktop + mobile)**: drop-in for current
   `Overview.tsx`. Page-pills, Refresh + New ensemble actions, full EnsembleCard
   with description (lineup YAML-sourced), Recent activity event-log. Mobile
   uses A1m primitives + table-to-card pattern where applicable. ~325 LoC.
6. **PR-C1 — Workspace desktop+tablet**: rewrite `Workspace.tsx` + `Sidebar.tsx`
   (with maestro identity row), PageHeader (5-action right cluster + side
   toggle), side panel with Roster + Event log + Schedules. ~500 LoC.
7. **PR-C2 — Workspace chat polish**: composer toolbar wiring, pop-out window
   integration, MAESTRO CHAT panel-head. Parallel-able with PR-C1. ~350 LoC.
8. **PR-C3 — Workspace mobile**: PhoneAppBar wiring (lineup kicker + 4 status
   pills + roster-toggle action), EnsembleSwitcher trigger, popout phone overflow,
   side-panel slide-in via PhoneAppBar action button. Sequenced after C1. ~250 LoC.
9. **PR-D — PlayerDetail (desktop + mobile bottom-sheet)**: action row
   (@DM/Recall/Restart/Detach/Destroy), transcript section, grouped KV
   (`Phase & lease` / `Work` / `Messages`). Already uses ResponsivePanel for
   mobile bottom-sheet. ~350 LoC.
10. **PR-E — Wizards (CreateEnsemble + Recruit)**: ModalShell, Dialog, PickerList,
    Chipset, Field unification. CreateEnsemble = 3-step. Recruit = 4-step with
    PLAYER-TYPE picker-list (from agent_types) + separate AGENT field
    (claude/copilot). Mobile dialogs full-bleed via existing `≤520px` rules. ~500 LoC.
11. **PR-F — Library screens**: Loadouts / PlayerTypes / Schedules / Hosts.
    PageHeader pattern, `data-label` mobile-card pattern, types-grid for PlayerTypes.
    Split eng+lead. ~525 LoC.
12. **PR-G — Settings (sidebar route)**: 5 panels (Connection, Profile,
    Notifications, Appearance, Danger zone). Retire `SettingsSheet.tsx`. Mobile
    settings-grid responsive. ~250 LoC.

**Mobile is in every PR**, not deferred. Per Q4 lock-in.

Each PR's brief MUST tell the implementer: "read README first, then chats/
relevant section, then screens.jsx + workspace.jsx, then web-design-system.html
relevant section." This is the implementer-discipline pin from #389.

**Critical path**: PR-0 → PR-A1 → (PR-A1m, PR-A2 parallel) → (PR-B, PR-C1, PR-D
parallel) → (PR-C2, PR-E parallel) → PR-C3 → PR-F → PR-G. ~12 PRs total.

**Beta.7 release**: ships when PR-0 through PR-G all merge with design-fidelity
QA pass. PR-G is no longer deferrable since it's just Settings (mobile is
already in every other PR).

**Beta.8 prep**: snapshot wire extensions (Task #15). Not blocking beta.7.

### Scope discipline

- ~7–9 PRs of <500 LoC each (PR-A1 may run 600 — flagged risk).
- Beta.7 release once PR-0 through PR-F lands. PR-G can ship in a beta.8 follow-up.
- QA review template gets a P0 "design fidelity" check (§7).

---

## 2. Source-of-truth update (v2 bundle deltas)

### What changed between v1 and v2

| File | v1 state | v2 state |
|---|---|---|
| `chats/` | omitted entirely | `chat1.md` (110), `chat2.md` (4977) — both present |
| `web-design-system.html` | 0 bytes (empty) | **1394 lines, canonical web spec** |
| `styles.css` | 1758 lines | 1888 lines (+130 — new tokens, mobile rules) |
| `workspace.jsx` | did not exist | **552 lines — EnsembleWorkspace surface** |
| `screens.jsx` | 646 lines | 646 lines (unchanged) |
| `screenshots/` | omitted | verify1-6, composer, composer2, broken, check, initial |

### Critical finding: font tokens are wrong

Current `dashboard/src/styles/tokens.css` lines 62-70 ship **Inter / Fraunces /
JetBrains Mono** with this comment:

> "the rendered design used Inter/Fraunces fallbacks. Per the conductor's PR-2
> brief we ship Inter/Fraunces directly so the built dashboard matches what was
> actually reviewed."

Canonical `project/web-design-system.html` (line 9) and v2 `styles.css` (lines
33-35) declare **Instrument Sans / Instrument Serif / JetBrains Mono**. The
`docs-only` style block at the top of `web-design-system.html` confirms (line 9):

```html
<link href="https://fonts.googleapis.com/css2?family=Instrument+Sans:wght@400;500;600;700&family=Instrument+Serif:ital@0;1&family=JetBrains+Mono:wght@400;500&display=swap" rel="stylesheet" />
```

The PR-2 implementer's "fallback" assumption was wrong. The user iterated on
Instrument Sans + Instrument Serif in chat2.md, including the typography section
of web-design-system.html (lines 559–639) which spells out the type scale:

| Role | Family | Spec |
|---|---|---|
| Display (hero) | Instrument Serif | 44/48 italic accent |
| H1 | Instrument Serif | 30/36 |
| H2 | Instrument Sans | 18/26 weight 600 |
| Body | Instrument Sans | 14/22 |
| UI / label | Instrument Sans | 13/20 weight 500 |
| Caption | Instrument Sans | 11 uppercase 0.1em |
| Mono | JetBrains Mono | 12 — IDs & numerics |

Italic discipline is also documented (web-design-system.html lines 614–639):
italic-serif accent words go in the brand mark, empty-state hero, and **one verb
per page header** (e.g., `Maestro is *listening*`, `*composing*`). NEVER for
body, buttons, tables.

**Action**: PR-0 swaps the font stack. This is a Token-Library-Update precondition
for PR-A1.

### Settings: confirmed sidebar route, NOT modal

`workspace.jsx` Sidebar (lines 157-176) lists **Settings as the 6th Library nav
item** (`{ k: "settings", icon: "⚙", label: "Settings" }`), and the Workspace
component's nav switcher (line 226) maps `settings → window.Settings` — a full
page route. Current `dashboard/src/components/SettingsSheet.tsx` ships as a
flat-page section inside its own route, but the file naming + the ResponsivePanel
slot reservation in the comment header still telegraphs "this is a Sheet that
will swap to shadcn `Sheet` later."

**Action**: PR-G turns Settings into a proper sidebar-routed full-page screen,
deletes `SettingsSheet.tsx`, drops the Sheet abstraction. The five settings
panels (Connection / Profile / Notifications / Appearance / Danger zone) per
`screens.jsx:Settings` (lines 536-646) replace the current 3-row select+slider
form.

### Overall posture

The implementation is closer to a TUI port than a web-grade dashboard. The
canonical design's posture (web-design-system.html lines 396–425) is **"document,
not dashboard"** — calm, reading-grade type, generous whitespace, panels not
neon stat tiles. The current implementation skews HUDdy and stripped-down — not
because it disagrees, but because the missing page-pills, descriptions, footers,
and `SectionHead`-with-kicker chrome aren't there.

---

## 3. Per-screen audit

### 3.1 Overview

**Source**: `dashboard/src/screens/Overview.tsx` (107 lines) vs
`project/screens.jsx:Overview` (lines 4-93).

| Element | Design | Implementation | Severity |
|---|---|---|---|
| Page title | `"Overview"` | `"Maestro"` — wrong word, stale subtitle "Dashboard scaffold (PR-2)" | High |
| Page-pills | `3 ensembles · 13 players · 4 hosts` (with `.pill-dot`) | None | High |
| Page subtitle | `"All ensembles, rolled up. Tap one to dive in."` | None | Medium |
| Page-actions | `↻ Refresh` (ghost) + `+ New ensemble` (primary) | None | High |
| SectionHead | `<SectionHead kicker="I / RUNNING" title="Active ensembles" />` | Plain `<h1>Ensembles</h1>` | Medium |
| EnsembleCard `ec-name` | `@my-band` (with `.at` span) | `tempo-impl` — no `@` prefix | Low |
| EnsembleCard `ec-tempo` (BPM) | `<span className="bpm">{tempo}</span> bpm` | None | High |
| EnsembleCard `ec-desc` | `e.description` text block | None | High |
| EnsembleCard `ec-stats` | 3-stat grid (players / active / uptime) with mono uptime | Inline "9 players · conductor" only | High |
| EnsembleCard footer | mono lineup + host metadata in justified row | None | Medium |
| EnsembleCard `ec-roster` | up to 5 PlayerAvatar (size 22) + `+N` overflow | None | High |
| Recent activity section | `<SectionHead kicker="II / RECENT" title="Recent activity" right={...} />` + 7 event rows (route/message/schedule/phase/recruit/ensemble kinds) | **Missing entirely** | Critical |
| `is-empty` card variant | `e.players === 0 ? "is-empty" : ""` | Not handled | Low |

**Data plumbing required**:
- `tempo` (BPM) per ensemble — currently not returned by the daemon snapshot.
  Recommend: derive from `players.length * 4` (matches design's "tempo" mock
  series) or pull from `EnsembleSummary.tempo` if added to the wire.
- `uptime` — derivable from earliest `phase` transition time, or surface from
  `ClusterEvent.created_at` for the ensemble.
- `description` — currently absent. Recommend: optional `description` field on
  `Ensemble` (lineup-defined or set via `set_part` on the ensemble itself).
- Recent activity event-log requires the ClusterEvent stream from
  `/v1/events?global=true` (NOT the per-ensemble stream). Daemon already
  publishes ClusterEvents — the dashboard needs to subscribe.

### 3.2 Workspace (the 90% screen)

**Source**: `dashboard/src/screens/Workspace.tsx` (215 lines) +
`components/Sidebar.tsx` (67 lines) + `components/WorkspaceToolbar.tsx` +
`components/chat/*` vs `project/workspace.jsx` (552 lines, **NEW in v2**) +
`project/screens.jsx` references.

This is the biggest scope. The v2 bundle reveals the entire shape was
underspecified in v1's `screens.jsx`.

#### 3.2.1 Sidebar — completely missing structure

| Element | Design (`workspace.jsx:Sidebar`) | Implementation (`Sidebar.tsx`) | Severity |
|---|---|---|---|
| Sidebar rail width | desktop 240px, tablet collapses to 64px (icon-only) | `minWidth: 220`, no responsive collapse | Medium |
| `.sidebar-brand` | `<Brandmark size="md" />` at top with bottom border | Has Brandmark — ✅ | OK |
| `Ensembles` section kicker | `Ensembles` + `N · running` count | None | High |
| Ensemble rows | `er-dot` + `er-initial` (32×32 letter tile, tablet-only show) + `er-name` + `er-meta` (`{players} players · {tempo} bpm`) + `↵` shortcut hint | None — just a flat NAV_ITEMS list of buttons disabled with "Navigation lights up in PR-4" tooltip | Critical |
| Active state | `.is-active` ensemble row with accent fill, `.has-active` for any ensemble with players | None | High |
| `+ New ensemble…` row | accent-tinted row at end of Ensembles section | None | High |
| `Library` section | 6 nav items: Overview ◇ / Loadouts ≡ / Player types ♪ / Schedules ⧗ / Hosts ⌂ / Settings ⚙ | Current has Overview/Workspace/Players/Schedules/Lineups/Hosts/Settings — **mismatched item set**. "Workspace" is NOT a Library item in design (it's the active-ensemble view); "Players" doesn't exist; "Lineups" should be "Loadouts" | High |
| `.sidebar-maestro` | User-identity row with MaestroMark + name (`vinceblank`) + "maestro" subtitle + ⌥M shortcut hint | None — dead code in PR-2 (chat2.md confirms designer also caught this and added the row) | Medium |
| `.sidebar-footer` | `● localhost:7233` + `v0.26` (connection + version) | None | Medium |

Per chat2.md tail (line 4295): "MaestroMark and `.sidebar-maestro` styles existed
but no JSX rendered them. Added the row above the sidebar footer." The v2
`workspace.jsx` confirms.

Per chat2.md (lines 4870-4974): tablet collapses ensemble rows to 32×32 letter
tiles via `.er-initial` element + `data-initial` on the row, with green presence
dot top-right via `::after`. **This is a new pattern not in `screens.jsx`** —
PR-A1 must include it.

#### 3.2.2 Workspace page-header

| Element | Design (`workspace.jsx:EnsembleWorkspace`) | Implementation | Severity |
|---|---|---|---|
| Page title | `<h1>` with `<span className="prefix mono">ensemble /</span>` + `<span className="at">@</span>{ensName}` — composite breadcrumb-style | Plain `<h1>{ensemble}</h1>` | Medium |
| Page-pills | `● N active` + `N idle` + `◐ N detached` (only when >0) + `up Xh Ym` | None | High |
| Page subtitle | `Lineup tempo-dev-team · conducted by conductor on studio.local` (with mono spans + accent on conductor name) | None | Medium |
| Page-actions | `+ Recruit` (ghost) + `side-toggle` button with people icon + label "Details"/"Hide details" + count badge | Has `<WorkspaceToolbar pause/held>` + `<TempoStrip>` inline | High |
| TempoStrip placement | Below page-header in `.page-tempo` wrapper, only if `__tweaks.showTempoStrip !== false` | Inline in header right-side | Medium |
| TempoStrip content | Real bar-chart data-viz from `window.TEMPO_SERIES` + right-aligned `92 BPM` | Currently a stub component — series prop accepted but rendering not validated against design | Medium |

#### 3.2.3 Workspace body grid

| Element | Design | Implementation | Severity |
|---|---|---|---|
| Layout | `.workspace` grid: `workspace-main` + `workspace-side` (toggleable, `workspace-collapsed` when hidden) | `gridTemplateColumns: 'minmax(220px, 280px) minmax(0, 1fr)'` — left roster, right chat. Different shape: design is chat-on-left, panels-on-right | High |
| Side panel toggleability | Slide-in/out with `<aside>`, grip handle, close button, scrim | Always visible | Medium |
| Roster panel structure | Inside `.workspace-side` panel with panel-head (title "Roster" + subj.display "{N} players") + `+ Recruit` button + `roster-item` rows | Direct `<aside data-testid="roster">` with flat `<RosterItem>` rows; no panel head | High |
| Roster row content | PlayerAvatar (32) + name + conductor★ + PhaseDot + TypeBadge + part + heartbeat + msg count | Per `RosterItem.tsx` — verify against this list | TBD |
| Event log panel | Inside `.workspace-side` panel with panel-head ("Event log" + "System audit trail") + `ring · max 200 · messages elided` meta | None | High |
| Schedules panel | Inside `.workspace-side` panel with panel-head ("Schedules" + "{N} active") + `+ New` button + first 3 schedules as KV rows | None | High |

#### 3.2.4 Maestro chat panel

| Element | Design | Implementation (`Workspace.tsx:ChatLog` + `MessageInput.tsx`) | Severity |
|---|---|---|---|
| Panel head | `<div className="panel-head">` with title `<span className="h">Maestro chat</span>` + subj `<span className="subj display">Conductor + ensemble feed</span>` + right-side `Pause` (ghost) + `↗ Pop out` (ghost) | None — plain ChatLog | High |
| Chat-log | Flex column gap `var(--density-gap) * 0.6`, padding `var(--density-pad)` | Has padding but missing the kicker/subtitle context | Medium |
| Composer frame | `.composer-frame` wraps textarea + toolbar | Plain flex-row form with `<input>` (text, not textarea) + Send button | Critical |
| Composer textarea | `<textarea rows="1">` with auto-grow (max 200px height); placeholder `"Message @conductor"` | `<input type="text">` — no auto-grow, no multiline | High |
| Composer toolbar | `composer-toolbar` with `composer-tools` (`@` button + `/` button) + `composer-send` (`⌘↩` hint via `window.IS_MAC` + `Send` primary btn) | None — no @ or / buttons, no platform-aware kbd hint | Critical |
| `IS_MAC` detection | `/Mac|iPhone|iPad|iPod/i.test(navigator.platform || navigator.userAgent || "")` | Not implemented | Medium |

#### 3.2.5 Pop-out chat window

Per `workspace.jsx` (lines 464-490): a pop-out chat window exists with macOS
chrome (3 traffic lights, title bar, "always on top" pin). When popped, the
workspace dims behind a `popout-scrim` and the floating window shows a
condensed feed (`window.FEED.slice(-6)`). The dock-back is via the red traffic
light. On phone (≤520px viewport per chat2.md fixes) the popout fills
edge-to-edge instead of using `bottom:28px right:28px`.

**Implementation**: Missing entirely. Adds ~150 LoC. Recommend PR-A2 ships the
popout-window component + animation, PR-C wires the toggle.

#### 3.2.6 FeedMessage 3-variant

Per `workspace.jsx` (lines 495-549): three variants on `m.kind`:

- **`out`**: right-positioned, no avatar, "you" sender in mono + `→` + target + time
- **`route`**: with avatar, sender in `var(--dim)`, `→`, target — third-party traffic
- **`in`** (inbound to maestro): with avatar, sender colored `oklch(0.8 0.12
  hueForType(p.type))`, conductor gets `★` badge, `←` arrow (note: INBOUND uses
  ←, not →), target = "maestro"

Current `ChatMessage.tsx` (130 lines) has a bidirectional model with
`thirdParty` flag for `conductor-out`/`conductor-in` (opacity 0.78), and uses
`var(--accent)` for outbound + `→ @recipient` prefix. **The role taxonomy
doesn't quite match**:

- Design: `out` / `route` / `in` (3 explicit kinds)
- Implementation: `direction: 'out' | 'in'` × `role: 'conductor-out' |
  'conductor-in' | 'normal'` (4 roles)

The implementations are functionally similar but the visual chrome differs:
- Design uses `←` arrow on inbound (subtle but intentional — "flow comes IN
  from the player toward maestro")
- Design uses per-type `oklch` color on the inbound sender name (vivid)
- Design renders inbound with avatar (28px); implementation has no avatar in
  ChatMessage
- Design uses italic for task assignments (per conductor's verify.png read)

**Action**: PR-A2 ships `FeedMessage` as a new component with the design's
variant semantics. PR-C wires it via a chat-format adapter that maps
`FormattedChatRow` → `FeedMessage` props.

### 3.3 PlayerDetail

**Source**: `dashboard/src/screens/PlayerDetail.tsx` (148 lines) vs
`project/screens.jsx:PlayerDetail` (lines 97-189).

| Element | Design | Implementation | Severity |
|---|---|---|---|
| Outer shell | `<window.ModalShell label="modal · player detail · esc to close">` | `<ResponsivePanel>` (right-sheet desktop / bottom-sheet mobile) | OK — different but legitimate |
| Header `panel-head player-sheet-head` | PlayerAvatar (40) + name (display 22px) + PhaseDot showLabel + TypeBadge + `on host · branch` mono dim subtitle | Has avatar (36) + name + PhaseDot + TypeBadge — missing the `on host · branch` subtitle | Medium |
| Header action row | `@DM` + `Recall` + `Restart` + `Detach` + `Destroy` (danger) + `✕` close — **5 actions** | Just `✕` close button | Critical |
| Body left: transcript | `<SectionHead kicker="transcript" title="Recent messages" tight />` + 4 `<FeedSnippet>` rows | None — no transcript at all | High |
| Body right: KV groups | 3 grouped sections each with `SectionHead` (kicker + tight title): **Phase & lease** (phase / adapter / host / heartbeat / lease / run id) → **Work** (dir / branch / worktree / part) → **Traffic** (received / sent / outbox) | Single flat KV list (Player ID / Type / Phase / Conductor / Hostname / Agent / Working dir / Git branch / Part) — no grouping, no SectionHead | High |
| KV row style | `.kv` flex-justified label↔value with dashed bottom border | Custom inline-grid 110px label + 1fr value | Medium |
| Body layout | `.player-sheet-body` with `.player-sheet-main` + `.player-sheet-side` (2-column) | Single column | High |

**Conductor pin (Task #3)**: verify whether `Phase & lease / Work / Traffic`
groupings are locked. **Verdict from chat2.md tail (4096-4977 lines)**: the
chat tail iterates on table-on-mobile, sidebar tablet, popout overflow, and
Player Types card squish. Player detail KV groupings are NOT iterated in the
tail — they appear to be settled in the earlier 4095 lines. Without re-reading
the entire chat2.md, I default to **screens.jsx is canonical here**: Phase &
lease / Work / Traffic. Open question for vinceblank in §9.

**Data plumbing required**:
- `adapter` version (`claude-code · v1.2.4`) — surface from session attachment
- `lease expires in Xs` — derive from `currentAttachment.leaseMs - (now - lastHeartbeatAt)`
- `run id` (`a3f2·c881`) — surface workflow runId truncated
- `received` / `sent` message counts — currently not surfaced; add to snapshot
- `outbox` size — already surfaced as `attachment-info` query

### 3.4 RecruitWizard

**Source**: `dashboard/src/screens/Recruit.tsx` (343 lines) vs
`project/screens.jsx:RecruitWizard` (lines 192-258).

| Element | Design | Implementation | Severity |
|---|---|---|---|
| Outer | `<window.ModalShell label="modal · recruit a player · esc to close">` containing `.dialog` (max-width 720) | Plain `<section>` with custom container styles | High |
| Step count | `STEP 2 / 4` shown in `.steps` of dialog-head | `Step {step} of 3` | High — design is **4 steps**, impl is 3 |
| Field: Name | `<input className="input" defaultValue="frontend-eng" />` — single-line | ✅ FormField — matches | OK |
| Field: Type | `picker-list` of 5 rows, each with `marker` + name+desc + TypeBadge right-aligned, `is-active` state on first row, label includes `"· 9 available"` count | `<select>` dropdown of 'claude' / 'copilot' (literal AgentType, not player-type definitions) | Critical — different concept entirely. Design picks from PLAYER_TYPES (the 9 agent types from `agent-types`), impl picks from agent execution adapter |
| Field: Work dir | input | ✅ matches | OK |
| Field: Host | `<select>` from `window.HOSTS` | Not present in implementation | Medium |
| Field: Opening task | `<textarea>` with `· optional` qualifier | ✅ multiline FormField — matches | OK |
| Field: Options | `chipset` with chips: `worktree` / `hold` / `notify maestro` / `copilot bridge`, some `is-active` | Not present | Medium |
| Footer | `.dialog-foot` with hint `"↑↓ to select · Enter to confirm · Esc to cancel"` + Back/Next btns | flex justify-between back/next | Medium |

**Key conceptual divergence**: The design's "Type" field is the **PLAYER_TYPE**
(tempo-conductor / tempo-soloist / tempo-tuner / etc — what the conductor
recruits), not the **AGENT execution adapter** (claude / copilot — what runs
the player). The implementation conflates them. The Recruit form should pick
both: **player type** (from `agent-types` list) AND **agent** (defaults to
claude, can override to copilot).

### 3.5 CreateEnsemble wizard

**Source**: Currently no `CreateEnsemble.tsx` screen (per
`dashboard/src/screens/`). Confirmed via Glob earlier.

| Element | Design (`screens.jsx:CreateEnsemble`) | Implementation |
|---|---|---|
| Whole screen | 3-step wizard inside `ModalShell` + `.dialog` | Stub (`Placeholder.tsx` likely) |

**Action**: PR-E adds `CreateEnsemble.tsx` from scratch. The route is already
open (the design wires it from sidebar `+ New ensemble…` and the
EnsembleSwitcher's `+ New` row).

Per `screens.jsx:CreateEnsemble` (lines 261-326) and `workspace.jsx` (lines
217-219, 456-462): wizard opens as a modal overlay above the current Workspace
when `activeNav === "create-ensemble"`. Per chat2.md fix (line 4222-4253):
the bug where `+ New ensemble…` was a no-op was fixed by adding the modal
overlay path.

### 3.6 Loadouts / PlayerTypes / Schedules / Hosts (read-only library)

**Source**: 4 implementation files vs 4 corresponding `screens.jsx` functions.

All four follow a common pattern (per `screens.jsx`):

1. `app-shell` with Sidebar + PhoneAppBar + main + PhoneTabBar
2. Page-header with title + page-subtitle (with mono spans for technical
   references) + page-actions (1-2 buttons)
3. Body content:
   - **Loadouts** — Panel + table (Name / Summary / Players / Source / Last used / actions)
   - **PlayerTypes** — `types-grid` of cards (TypeBadge + path + display name
     with glyph + summary + tools count + actions)
   - **Schedules** — Panel + table (Name / Target / Cadence / Kind / Next fire /
     actions)
   - **Hosts** — Panel + table (Host / Platform / Sessions / Player types /
     Daemon / Uptime / Heartbeat / actions)

**Mobile responsive**: per chat2.md fixes (lines 4480-4810), tables convert to
**stacked cards on phone** via `data-label` attrs on middle `<td>`s and a
phone-only `@container artboard (max-width: 520px)` rule. Each row becomes:
bold name → label·value pairs (mono uppercase label, content right-aligned) →
action buttons separated by a dashed divider.

**Implementation**: I haven't read the four screens individually — based on
Overview/Workspace/PlayerDetail patterns, expect they have title + (maybe
table) + missing page-pills, page-actions, page-subtitle, mobile data-label
pattern. Per-screen audit during PR-F will confirm.

### 3.7 Settings

**Source**: `dashboard/src/components/SettingsSheet.tsx` (232 lines) vs
`project/screens.jsx:Settings` (lines 536-646).

Currently structured as a "Sheet" component but rendered as a flat page section.
Per design, Settings is a **full page route** in the sidebar nav (Library
section) with a 2-column `.settings-grid` containing 5 panels:

| Panel | Title (`subj.display`) | Content | Implementation |
|---|---|---|---|
| Connection | `Temporal namespace` | KV: namespace / address / task queue / tls / auth + connected pill in panel-head | Missing |
| Profile | `Your maestro identity` | KV: display name / email / default lineup / default host | Missing |
| Notifications | `When the maestro should ping you` | KV: 4 event types with notification mode | Missing |
| Appearance | `Theme & density` | KV: theme / density / accent / metronome + "see Tweaks ⌥T" hint | Theme/density/accent — implemented as form controls, but layout is wrong |
| Danger zone | `Destructive actions` (full-width) | 2 settings-danger-row blocks (Disband all / Reset client state) with description + ghost btn | Has Reset to defaults but no Disband |

### 3.8 Mobile responsive (PhoneTabBar / PhoneAppBar / EnsembleSwitcher)

**Source**: `project/workspace.jsx` (lines 1-115) — entire mobile path. Plus
chat2.md fixes (4350-4810).

Currently the implementation appears desktop-only — no PhoneTabBar, PhoneAppBar,
EnsembleSwitcher, or `@container artboard` mobile rules. This is a meaningful
chunk of work (~250 LoC primitives + ~150 LoC integration).

**Recommendation**: punt to PR-G (post-beta.7 follow-up) unless vinceblank
explicitly wants mobile in beta.7. Most users access the dashboard from desktop;
mobile is nice-to-have but not table-stakes. **Open question for vinceblank in
§9.**

---

## 4. Token + style coverage findings

### 4.1 Font stack — DIVERGED (PR-0 fix required)

| Token | Current | Canonical | Action |
|---|---|---|---|
| `--ff-ui` | Inter | **Instrument Sans** | swap |
| `--ff-display` | Fraunces | **Instrument Serif** | swap |
| `--ff-mono` | JetBrains Mono | JetBrains Mono | OK |

Update Google Fonts import in `dashboard/index.html` from Inter+Fraunces to
Instrument Sans+Instrument Serif. Update `tokens.css` lines 62-70 stack +
remove the comment block that justified the divergence.

### 4.2 Color tokens — full coverage

All canonical color tokens present in current `tokens.css`:
- ✅ `--accent`, `--accent-soft`, `--accent-ink`
- ✅ `--bg`, `--bg-1`, `--bg-2`, `--bg-3`, `--bg-chat-out`
- ✅ `--text`, `--text-2`, `--dim`, `--muted`
- ✅ `--rule`, `--rule-strong`
- ✅ `--ok`, `--warn`, `--err`, `--info`
- ✅ `--shadow-1`, `--shadow-2`
- ✅ Light theme override

Both have the same hex values (verified by side-by-side compare). The `--bg-3`
↔ `--muted` swap rationale documented inline in current tokens.css is
preserved through PR-0.

### 4.3 Density tokens — full coverage

All 6 density steps (`data-density="4"` through `"9"`) present and matching.
Default `"6"` matches.

### 4.4 Tokens missing from current `tokens.css`

None of the canonical CSS custom properties are missing — current tokens.css
is a complete **token** port. The gap is in **component-level styles** (the
canonical 1888-line `styles.css` defines `.btn`, `.kbd`, `.panel`, `.kv`,
`.section-head`, `.tempo-strip`, `.composer`, `.chat-log`, `.msg`, `.event-row`,
`.roster-item`, `.page-header`, `.app-shell`, etc.) which are NOT ported. The
implementation reinvents these via inline styles per-component.

**Recommendation**: PR-A1 + PR-A2 port the relevant `styles.css` rules into
`dashboard/src/styles/components.css` (or scoped CSS modules per component).
Don't migrate to Tailwind utility classes for these — the canonical
`web-design-system.html` mandates token-driven styling and the design uses
class-based selectors, not utility composition.

### 4.5 New CSS for v2 → v3 (mobile patterns)

The `styles.css` v2 added 130 lines (1758 → 1888) with:
- `@container artboard (max-width: 520px)` rules for tables → stacked cards
- `.types-grid` `grid-auto-rows: max-content` + `align-content: start` (Player
  Types card-squish fix)
- `.popout-window` phone overflow rule
- `.er-initial` tablet sidebar letter tile

These are essential for mobile parity. PR-G ports them.

---

## 5. Shared component inventory (PR-A scope)

The following primitives must land in PR-A1 (layout) + PR-A2 (chat/tempo)
**before** any per-screen rebuild PR. Per the conductor's pin: PR-A is the
ordering invariant.

### 5.1 PR-A1 — layout primitives (target ~500 LoC)

| Primitive | Source | Test surface |
|---|---|---|
| `Sidebar` (2-section, brand + Ensembles + Library + Maestro + Footer) | workspace.jsx:Sidebar | testid per ensemble row, per nav row |
| `PageHeader` (title-row + page-pills + subtitle + actions) | screens.jsx (every page-using screen) | `data-testid="page-header"`, `page-pill-{kind}` |
| `SectionHead` (kicker + title + optional right slot, `tight` variant) | screens.jsx (Overview, PlayerDetail) | `data-testid="section-head-{kicker-slug}"` |
| `Btn` (variants: primary/ghost/danger; sizes: sm/md; icon prop) | styles.css `.btn-*`, used everywhere | testid per call site |
| `KV` (label / value with mono toggle, dashed bottom border) | screens.jsx (PlayerDetail, Settings, workspace.jsx) | `data-testid="kv-{key}"` |
| `Panel` + `panel-head` + `panel-body` | styles.css `.panel*` | `data-testid="panel-{slug}"` |
| `StatusPill` family (● / ◐ / dim / accent variants with optional dot + count + label) | workspace.jsx page-pills | `data-testid="status-pill-{kind}"` |
| `EnsembleCard` (full content: head + tempo + desc + stats + footer + roster) | screens.jsx Overview | testid surface unchanged from current |
| `RosterItem` (avatar + name + conductor★ + PhaseDot + TypeBadge + part + heartbeat + msg count) | workspace.jsx Roster panel | `data-testid="roster-item-{playerId}"` |
| `EventRow` (timestamp + kind-pill + body) | screens.jsx Overview, workspace.jsx Event log | `data-testid="event-row-{kind}"` |
| `MaestroMark` | new (per chat2.md addition) — italic serif `M` (Fraunces), 18-22px, represents the operator. **Distinct from BrandMark** (rev 4 C2). | — |
| `BrandMark` (revision 4 clarification C1) | `agent-tempo` mono wordmark with terracotta `-` hyphen + swinging Metronome SVG (pendulum animation tied to ensemble bpm via `animation-duration: 60/bpm s`). Lives in sidebar-brand top slot. | `data-testid="brand-mark"` |

### 5.2 PR-A2 — chat + tempo primitives (target ~400 LoC)

| Primitive | Source | Test surface |
|---|---|---|
| `FeedMessage` (3-variant: out/route/in with hueForType color + `←` inbound + ★ conductor + italic for task assignments) | workspace.jsx FeedMessage | `data-testid="feed-message-{kind}-{id}"` |
| `Composer` (composer-frame + auto-grow textarea + composer-toolbar with @ + / + ⌘↩ hint + Send) | workspace.jsx composer block | `data-testid="composer"`, `composer-tool-{at,slash}`, `composer-send` |
| `IS_MAC` platform detection helper | workspace.jsx top of file | unit test |
| `TempoStrip` data-viz (real bar chart + right-aligned BPM, color-driven by tempo) | styles.css `.tempo-strip*` + `screens.jsx` references | render test against series prop |
| `PopoutWindow` (macOS chrome + 3 traffic lights + always-on-top pin + dock-back via red dot) | workspace.jsx popout block | `data-testid="popout-window"`, `popout-dock-back` |
| `ChatStub` (when popped — "Maestro chat is popped out · click to dock back") | workspace.jsx | — |
| `PhaseDot.showLabel` variant | already exists, verify | — |

### 5.3 PR-A3 (optional — modal/wizard primitives)

Potential split-off if PR-A1+A2 hit the LoC budget:

| Primitive | Source | Notes |
|---|---|---|
| `ModalShell` (label + esc-to-close + scrim + outer shell) | screens.jsx ModalShell wrapper | Used by PlayerDetail / Recruit / CreateEnsemble |
| `Dialog` (max-width 720, dialog-head/body/foot, steps `STEP X / Y`) | screens.jsx | — |
| `PickerList` + `PickerRow` (marker + name+desc + right slot) | screens.jsx Recruit + CreateEnsemble | — |
| `Chipset` + `Chip` (with `is-active` state) | screens.jsx Recruit, Loadouts mobile | — |
| `Field` + input/select/textarea unified styling | screens.jsx wizards | replaces inline styles |

**Recommendation**: Bake A3 into PR-E if budget allows; only split off if PR-A1
or PR-A2 overrun.

### 5.4 Existing components — keep/refactor/retire

| Current file | Action | Reason |
|---|---|---|
| `components/Brandmark.tsx` | Keep | Used in design Sidebar |
| `components/EnsembleCard.tsx` | **Replace** in PR-B | Missing tempo/desc/stats/footer/roster |
| `components/Sidebar.tsx` | **Replace** in PR-A1 | Single-section, missing brand/ensembles/library/maestro/footer |
| `components/PageHeader.tsx` | Verify; likely **replace** in PR-A1 | Need to read; presumed minimal |
| `components/RosterItem.tsx` | Verify; likely refactor | Used in Workspace |
| `components/SettingsSheet.tsx` | **Retire** in PR-G | Settings becomes a page |
| `components/ResponsivePanel.tsx` | Keep — useful for PlayerDetail desktop/mobile | — |
| `components/WorkspaceToolbar.tsx` | **Replace** in PR-C | Won't fit the page-actions+side-toggle pattern |
| `components/FormField.tsx` | Keep, extend in PR-E for design-system Field | — |
| `components/DisabledWithTooltip.tsx` | Keep | — |
| `components/tempo/PlayerAvatar.tsx` | Keep, verify size variants 22/26/28/32/40 | — |
| `components/tempo/PhaseDot.tsx` | Keep, verify `showLabel` | — |
| `components/tempo/TypeBadge.tsx` | Keep | — |
| `components/tempo/TempoStrip.tsx` | **Replace** in PR-A2 | Stub vs real bar chart |
| `components/chat/ChatLog.tsx` | Keep, refactor for FeedMessage in PR-A2 | — |
| `components/chat/ChatMessage.tsx` | **Replace by FeedMessage** in PR-A2 | Variant taxonomy mismatch |
| `components/chat/MessageInput.tsx` | **Replace by Composer** in PR-A2 | Missing toolbar entirely |

---

## 6.5 Implementation tech choices (architect call — revision 3 per lead's audit)

### CSS strategy: **Path B (modified) — add `components.css` port; keep Tailwind for utility one-offs**

Lead's hands-on codebase audit revised my framing. **Concurring with lead's
read**: my original "drop Tailwind wholesale, port full 1888-line styles.css"
was overshooting. The actual situation:

- Existing components use `style={{ background: 'var(--bg-1)' }}` **inline
  everywhere** — Tailwind is loaded but not load-bearing
- `tokens.css` has **no `@theme` block** — tokens aren't exposed as Tailwind
  utilities; they're consumed directly via `var(--…)` in inline styles
- Migration is therefore "move inline `style={}` blocks into class-driven
  CSS, Tailwind stays available for utility one-offs"

#### What lands in PR-0

1. **Add `dashboard/src/styles/components.css`** (~500 LoC selective port —
   layout selectors only). Sections: sidebar, page-header, ensemble-card,
   roster-item, workspace, panel, button, kbd, phone-appbar, phone-tabbar.
   Source: `docs/design/dashboard-handoff/project/styles.css`. Header comment
   names source + commit hash + port date. **Selective, not wholesale** —
   selectors not yet used can land later as additional PR-0.x patches.
2. **Wire via `globals.css` `@import`** so all primitives see the cascade.
3. **NO `@theme` block** in tokens.css — keeps tokens as raw CSS custom
   properties, no Tailwind indirection.
4. **NO Tailwind removal** — Tailwind plugin stays for utility one-offs in
   non-design-driven UI (e.g., debug overlays, dev tooling, future shadcn
   components if they're added).

#### What this means for PR-A1+

- Primitives use `className="sidebar ensemble-row is-active"` rather than
  inline `style={...}` blocks — moves styling from JS land to CSS land
- Inline `style={}` reserved for **runtime-computed values** only (e.g.,
  `style={{ color: 'oklch(0.8 0.12 ' + hueForType(p.type) + ')' }}` in
  FeedMessage)
- Existing inline-style blocks get migrated as primitives are rebuilt; no
  big-bang rewrite required
- testids attach via `data-testid` on the same element as the design
  className. No CSS coupling to testids.
- Tailwind utility strings, where they exist in current code, stay
  functional — just don't add new ones in design-driven UI

#### Path-decision reasoning (kept from rev 2)

1. **Design fidelity is #389's stated goal** — Path A's utility-class
   translation is the failure mode that caused this audit
2. **`styles.css` is iterated directly by vinceblank** — chat2.md fixes
   (types-grid, tablet sidebar, table-to-card pattern). Importing the
   layout selectors imports the bug fixes verbatim
3. **Code surface per primitive shrinks** — JSX + className strings vs JSX +
   utility-class translation that must stay in sync with source
4. **`@container` queries are first-class** in plain CSS; Tailwind 4
   supports them but adds indirection
5. **Class names are stable** — `.ec-head`, `.composer`, `.feed-message`
   appear identically across screens.jsx + workspace.jsx + styles.css; the
   "design renames a class" risk is low

#### Path B vs Path C clarification

This is closer to Path C as conductor framed it ("hybrid — design CSS for
layout/components + Tailwind for utility one-offs"), but with the discipline
that **design-driven primitives use className-only** and **utility strings
are reserved for non-design UI**. The two-systems concern in C is mitigated
by that clear boundary.

### Re-sync responsibility

Architect owns periodic re-sync of `components.css` with canonical
`docs/design/dashboard-handoff/project/styles.css` (every minor release until
shadcn integration in a future epic). Header comment in `components.css`
documents source + last-sync commit hash so drift is visible.

### shadcn aliasing — out of beta.7 scope (rev 4 C7)

The `web-design-system.html` shadcn-token mapping block (lines 522-549) is
**aspirational documentation** for a future React+shadcn rebuild — NOT for the
current implementation. Beta.7 ships hand-rolled CSS via `components.css`
(per Path B). When shadcn lands in a future epic, the mapping block becomes
the migration spec. **No `@theme` block in tokens.css for beta.7.**

### Density override layer (rev 4 bonus finding)

`styles.css` lines 54-64 contain a meta-override block:
```css
.panel-body { padding: var(--density-pad); gap: var(--density-gap); }
.panel-head { padding: var(--density-pad-y) var(--density-pad); }
.roster-item { padding: var(--density-pad-y) var(--density-pad); ... }
.event-row { padding: calc(var(--density-pad-y) * 0.6) ... }
.msg { padding: var(--density-pad-y) var(--density-pad); ... }
.chat-log { gap: calc(var(--density-gap) * 0.6); ... }
.kv { padding: calc(var(--density-pad-y) * 0.5) 0; }
.table th, .table td { padding: var(--density-pad-y) ... }
.page-header { padding: var(--density-pad) calc(var(--density-pad) * 1.6); }
.workspace { gap: var(--density-gap); ... }
```

These overrides win over the d=6 baseline values in component-style sections
(e.g., `.types-grid` `padding: 14px 16px 18px`). The hardcoded values are
intentional fallbacks; the density layer is real. **PR-0 ports `styles.css`
verbatim** including this layer, and `components.css` adds a section comment
documenting it so future developers don't try to "fix" the apparent
inconsistency.

---

## 6. Phasing plan (revision 2)

Each PR's brief MUST start with: **"Read `docs/design/dashboard-handoff/README.md`
first. Then chats/chat2.md sections relevant to the screen. Then
`screens.jsx` (and `workspace.jsx` for Workspace). Then
`web-design-system.html` sections for typography, color, spacing, and the
specific component you're building. Do NOT start implementing until all four
inputs are read."**

This is non-negotiable per the v2 README dispatch instruction.

### Critical path graph (revision 2)

```
                                 ┌──────────────────────────┐
PR-0 ──► PR-A1 ──► PR-A1m ──► PR-B ┐                         │
        │      ╲                 ├──► PR-C2 ┐                │
        │       ╲                │          │                │
        │        ╲──► PR-A2 ─────┤──► PR-D  ├──► PR-C3 ──► PR-F ──► PR-G
        │                        │          │
        └────────────────────────┤──► PR-C1─┘
                                 │
                                 └──► PR-E (after PR-A2 + Field unification)
```

Beta.7 ships when PR-0 through PR-G all land + design-fidelity QA pass.

### PR-0 — Design CSS port + font reconciliation (~530 LoC)

Revised per lead's audit (rev 3). Tailwind stays. Selective `components.css`
port (~500 LoC, not wholesale 1888). Font swap blocked on reconciliation.

- **Owner**: ⭐ **tempo-lead** — mechanical engineering work; no algorithmic
  depth needed. Lead rolls directly into PR-A1 after PR-0 with
  `components.css` already in place.
- **Scope** (per §6.5 modified Path B):
  1. **Add `dashboard/src/styles/components.css`** (~500 LoC selective port):
     - Source: `docs/design/dashboard-handoff/project/styles.css`
     - Selective sections only: `.sidebar*`, `.page-header`, `.page-pills`,
       `.page-pill*`, `.page-actions`, `.page-subtitle`, `.app-shell*`,
       `.ensemble-card`, `.ec-*`, `.section-head`, `.section-kicker`,
       `.section-title`, `.kv*`, `.btn*`, `.btn-primary/ghost/danger`,
       `.kbd`, `.panel*`, `.roster-item`, `.rmeta`, `.rn`, `.rp`, `.workspace*`,
       `.event-row`, `.event-log`, `.phone-appbar*`, `.phone-tab*`,
       `.phone-stat*`, `.ens-switcher*`, `.composer*`, `.popout*`,
       `.chat-stub*`, `.dialog*`, `.picker-list`, `.picker-row`, `.field*`,
       `.chipset`, `.chip`, `.types-grid`, `.table*`, `.settings-grid`,
       `.settings-panel`, `.settings-danger-row`, `.tempo-strip*`, `.msg*`
     - Preserve section markers (`/* ─── Sidebar ──── */`) verbatim
     - Header comment: source path + commit hash + port date + re-sync
       instructions
     - Sections NOT in scope for this PR (load on demand via PR-0.x patches):
       `.ds-*` (design-system internal selectors), tweaks-panel selectors,
       design-canvas selectors — these are design-tool-only chrome
  2. **Wire via `globals.css` `@import`**:
     - Add `@import './components.css';` after `@import './tokens.css';`
     - Confirm cascade order (tokens → components → globals overrides)
  3. **Font reconciliation** (~30 LoC, **GATED**):
     - **Blocker**: Lead's font discrepancy question (per channel) — is
       `tokens.css` Inter/Fraunces correct (rendered design used fallbacks)
       or is `web-design-system.html`'s Instrument Sans/Serif correct
       (declared intent)?
     - **Resolution path** (do all of these before merging):
       1. Wait for vinceblank's answer (conductor has routed)
       2. If vinceblank can't recall: render-test against
          `docs/design/dashboard-handoff/project/dashboard.html` — open in
          browser, inspect computed font on body / .display, screenshot,
          compare to current `localhost:8473/dashboard/`
       3. Whichever font actually renders in design source = locked answer
     - **If Instrument confirmed**: swap Google Fonts import in
       `dashboard/index.html` + tokens.css `--ff-ui` / `--ff-display` to
       Instrument Sans / Instrument Serif. Remove the divergence comment
       block (tokens.css lines 62-70). Add italic-discipline note.
     - **If Inter confirmed correct**: tokens.css stays. Update the comment
       block to note the resolution + reference this audit doc.
     - **DO NOT MERGE PR-0 with font change unless reconciled.** Acceptable
       to land PR-0 without font changes (`components.css` port only) and
       follow-up with a separate font swap PR after vinceblank/render-test
       resolves. Conductor decides which option.
- **Acceptance**:
  - `npm run build` succeeds (no Tailwind plugin errors — Tailwind STAYS)
  - `npm test` passes (snapshots only regen if font swap shipped)
  - `components.css` imports cleanly + applied via `globals.css`
  - Font reconciliation either resolved (Instrument or Inter locked) OR
    explicitly deferred to a follow-up PR with reasoning in the merge commit
  - No code regression: existing screens continue rendering (may look
    visually different where inline styles got replaced, but no React
    breakage)
- **Blocks**: PR-A1, PR-A1m, PR-A2
- **Notes for lead**:
  - The `components.css` port is **selective verbatim**: copy the listed
    sections without rewriting. Add follow-up sections as needed during
    PR-A1+ — they can be appended in-place.
  - Tailwind plugin stays. Don't remove `@tailwindcss/vite` from
    `vite.config.ts`. Don't delete `tailwind.config.ts`.
  - Existing components don't get rewritten in this PR. They continue to
    work via inline styles. Migration to className-driven happens
    incrementally in PR-A1+.
  - If a section of styles.css isn't in the listed port-scope but is needed
    by a primitive in PR-A1+, append it then — don't try to predict the
    full need now.

### PR-A1 — Layout primitives, desktop + tablet (~400-500 LoC, revised per lead's audit)

Lead's codebase audit revealed PR-A1 is mostly **re-skin existing scaffolds**,
not from-scratch primitives. Components already exist in
`dashboard/src/components/` as functional placeholders (Sidebar, PageHeader,
EnsembleCard, RosterItem, AppShell). Tokens system already shipped (full v3
1:1 with design's `styles.css`, density 4-9 attribute, theme dark/light
parity). TempoClient + SSE wired (PR-4). data-testid taxonomy + tests
established.

- **Owner**: tempo-lead (rolls in directly from PR-0 with `components.css`
  in place)
- **Scope** (per primitive, all re-skin from scaffold to full design):
  - **Sidebar (rev 4 C5: width = 244px locked)**: 7-item flat → 2-section
    (Ensembles + Library) with active accent + `+ New ensemble` row +
    maestro identity row + footer (`localhost:7233 · v0.26`). Tablet
    collapse to 64px rail with `.er-initial` 32×32 letter tile + green
    presence dot per chat2.md (lines 4870-4974).
  - **BrandMark (rev 4 C1)**: `agent-tempo` mono wordmark with terracotta
    hyphen + swinging Metronome SVG (pendulum tied to ensemble bpm via
    `animation-duration: 60/bpm s`, frozen when paused). Lives in
    sidebar-brand top slot.
  - **MaestroMark (rev 4 C2)**: italic serif `M` (Fraunces, 18-22px). Lives
    in sidebar-maestro identity row representing the operator.
    **Distinct from BrandMark** — do not collapse them into one primitive.
  - **PageHeader (rev 4 C4: italic discipline corrected)**: operator chrome →
    composite breadcrumb title + page-pills + page-actions + page-subtitle.
    `.page-title` is **serif display NON-italic**. Compact mode for narrow
    widths. Where a hero verb italic accent is desired (e.g., empty-state
    `@my-band is *listening*`), wrap that single word in `<em>` — never
    italicize the entire heading.
  - **EnsembleCard**: link+badge+pills → ec-head (name + tempo) + ec-desc +
    ec-stats (3-stat grid) + lineup/host footer + ec-roster (5 avatars +
    overflow) + hover state. `is-empty` variant for ensembles with 0 players.
  - **AppShell**: 2-col grid → container-query 244px / 64px / hidden + Phone
    bars (PhoneAppBar + PhoneTabBar mounted at appropriate breakpoints).
  - **RosterItem**: 2-row flex → 3-col grid (avatar | name+phase + type+part |
    heartbeat+messages) per workspace.jsx Roster panel.
  - **NEW**: SectionHead (kicker + title + optional right + tight variant),
    Btn (primary/ghost/danger × sm/md), KV (mono toggle, dashed bottom
    border), Panel (head/body), StatusPill family (●/◐/dim/accent), EventRow
    (timestamp + kind-pill + body), MaestroMark, conductor-star.
- **PR-A1m components** (PhoneAppBar / PhoneTabBar / EnsembleSwitcher / mobile
  shell mechanics) ship in PR-A1m, not here. Per Q4 lock-in, AppShell needs
  to be **mobile-aware** (knows about `app-shell--workspace` + container
  queries) but doesn't need PhoneAppBar/Tabbar implementations until A1m.
- **Format** (clarified per §6.5): each component is `.tsx` with
  `className` strings referencing `components.css` selectors. No `.module.css`
  per-component. Inline `style={}` reserved for runtime-computed values only.
- **Acceptance**:
  - Each primitive matches the relevant `workspace.jsx` / `screens.jsx`
    block element-for-element. `data-testid` per the testability addendum.
  - Existing screens (Overview, Workspace, etc.) start using the rebuilt
    primitives — no big-bang screen rewrites in this PR; just primitive
    upgrades that the screens see incrementally.
  - Vitest snapshots regen and pass.
  - Visual A/B against `dashboard.html` for at least Sidebar + PageHeader +
    EnsembleCard.
- **Blocks**: PR-B, PR-C1
- **Risk**: revised down. 400-500 LoC realistic given existing scaffolds. If
  AppShell + Sidebar combined run >250 LoC, split into PR-A1.1 (AppShell +
  Sidebar) and PR-A1.2 (the rest).

### PR-A1m — Mobile shell primitives (~350-450 LoC)

- **Owner**: tempo-eng (after P3 wraps; or lead after PR-A1 if eng remains busy)
- **Scope**: PhoneAppBar (top app bar with switcher + lineup kicker + ensemble
  name + action btn + 4-pill status row), PhoneTabBar (bottom 4-tab nav: Now /
  Ensembles / Library / Settings), EnsembleSwitcher (bottom-sheet with grip
  handle + ensemble rows w/ players+bpm meta + "+ New ensemble"),
  workspace-side slide-in mechanics (grip handle + close button + scrim),
  `@container artboard` responsive helpers + breakpoints.
- **Mapping**: `navToTab` lookup (workspace→workspace, overview→overview,
  loadouts/types/schedules/hosts→library, settings→settings) per
  workspace.jsx:21.
- **Acceptance**: PhoneAppBar renders sample ensemble + status. PhoneTabBar
  matches active state. EnsembleSwitcher opens / dismisses via scrim or close.
- **Blocks**: PR-B (mobile path), PR-C3
- **Note**: May proceed in parallel with PR-A1 — depends only on PR-0 tokens.

### PR-A2 — Chat + Tempo primitives (~450 LoC)

- **Owner**: tempo-eng (parallel to PR-A1m if bandwidth; otherwise sequential
  after A1m)
- **Scope**: FeedMessage 3-variant (out/route/in with hueForType color, `←`
  inbound arrow, ★ for conductor, italic for task assignments), Composer
  (composer-frame + auto-grow textarea + composer-toolbar with @ + / +
  platform-aware ⌘↩ hint via `IS_MAC` helper + Send), TempoStrip
  **(rev 4 C6: sparkline of 60 message-activity bars + bpm overlay
  top-right, NOT beat dots)** — neutral-colored bars at 0.75 opacity
  (`var(--accent)` for current bar), `var(--bpm)` overlay computed from
  `recent-msgs / window-min`, frozen pendulum if paused. PopoutWindow
  (macOS chrome + 3 traffic lights + always-on-top pin + dock-back via red
  dot), ChatStub (popped-out placeholder), `IS_MAC` platform helper.
- **PhaseDot color/icon mapping (rev 4 C3 — TUI PHASES, not generic)**:
  - `processing` → `●` (--ok, with `.is-pulse` 1.6s ease-in-out)
  - `idle` → `○` (--text)
  - `attached` → maps to processing chip visually (dashboard collapses
    attached+processing into one "active" state)
  - `awaiting` → maps to idle chip (the player is waiting for input)
  - `draining` → `◐` (--warn)
  - `detached` → `◐` (--warn)
  - `booting` → `◔` (--dim)
  - `gone` → `✕` (--dim)
  PhaseDot.tsx already exists; PR-A2 verifies its color/icon table matches
  this mapping and adds the `.is-pulse` variant for processing if missing.
- **Acceptance**: each component has unit tests + vitest snapshot. Composer
  ⌘↩ hint flips to `Ctrl ↩` on non-Mac. TempoStrip renders 60-bar sparkline
  from sample series with bpm overlay. PopoutWindow renders + closes via
  dock-back.
- **Blocks**: PR-C1, PR-C2

### PR-B — Overview rebuild, desktop + mobile (~325 LoC)

- **Owner**: tempo-eng
- **Scope**: rewrite `Overview.tsx` to use PR-A1 + PR-A1m primitives. Add
  Recent activity event-log subscription to `/v1/events?global=true` (or
  per-ensemble fanout if global stream not yet exposed). Wire Refresh + New
  ensemble actions (New ensemble routes to `/dashboard/ensemble/new`).
  Mobile uses A1m PhoneAppBar + PhoneTabBar.
- **Acceptance**: page-pills correct counts, EnsembleCard fully populated
  (description from lineup YAML), event log streams. Mobile renders cleanly at
  390px viewport.
- **Data work**: snapshot graceful-degrade for `tempo`/`uptime`/`description`
  (— placeholder if missing, real values once Task #15 lands).

### PR-C1 — Workspace desktop+tablet (~500 LoC)

- **Owner**: tempo-lead
- **Scope**: rewrite `Workspace.tsx` + `Sidebar.tsx` to use PR-A1 primitives.
  Wire PageHeader with composite breadcrumb title (`ensemble / @{name}`),
  4 status pills, lineup subtitle, page-actions (`+ Recruit` + side-toggle
  with people glyph + count badge). Side panel with Roster + Event log +
  Schedules using A1 primitives.
- **Acceptance**: every desktop+tablet `workspace.jsx:EnsembleWorkspace` element
  renders. Tablet sidebar collapses to icon rail.
- **Risk**: 500 LoC budget. Acceptable.

### PR-C2 — Workspace chat polish (~350 LoC)

- **Owner**: tempo-eng (parallel-able with PR-C1 after PR-A2)
- **Scope**: Maestro chat panel-head ("Maestro chat" + subj.display "Conductor +
  ensemble feed" + Pause + ↗ Pop out), composer toolbar wiring, pop-out window
  toggle integration, FeedMessage adapter (map `FormattedChatRow` → FeedMessage
  props for the 3 variants).
- **Acceptance**: clicking ↗ Pop out floats the chat in a macOS-chrome window;
  red traffic light docks back. @ + / toolbar buttons fire (no-op for now;
  PR-7 wires real handlers). ⌘↩ submits.

### PR-C3 — Workspace mobile (~250 LoC)

- **Owner**: lead or eng (parallel-able after PR-C1 + PR-A1m)
- **Scope**: PhoneAppBar wiring (lineup kicker, status row with active/idle/
  detached/uptime, action button toggling roster slide-in), EnsembleSwitcher
  trigger from PhoneAppBar menu button, popout phone overflow rule
  (`bottom: 0; right: 0; left: 0; top: 0` on ≤520px), side-panel slide-in via
  PhoneAppBar action button.
- **Acceptance**: 390px-wide viewport renders cleanly. Roster, event log, and
  schedules accessible via slide-in panel.

### PR-D — PlayerDetail (~350 LoC)

- **Owner**: tempo-eng (parallel-able after PR-A1+A2)
- **Scope**: rewrite `PlayerDetail.tsx`. Action row with 5 buttons (@DM /
  Recall / Restart / Detach / Destroy + ✕ close), transcript section using
  `useEnsembleSnapshot.chat` filtered by player + last 4-6 messages, grouped
  KV sections with SectionHead (`Phase & lease` / `Work` / `Messages`).
  Action buttons disabled-with-tooltip for now; PR-7 wires safe-write.
  Mobile path already covered by ResponsivePanel bottom-sheet.
- **Phase value rendering (rev 4 C3)**: the `phase` row in `Phase & lease`
  uses TUI codebase phase vocabulary via PhaseDot — `booting`, `attached`,
  `processing`, `awaiting`, `draining`, `detached`, `gone` — NOT generic
  playing/paused/error. PhaseDot pulses on `processing`.
- **Acceptance**: all `screens.jsx:PlayerDetail` elements render. KV groupings
  exact: `Phase & lease` (phase, adapter, host, heartbeat, lease, run id),
  `Work` (dir, branch, worktree, part), `Messages` (received, sent, outbox).

### PR-E — Wizards CreateEnsemble + Recruit (~500 LoC)

- **Owner**: tempo-lead
- **Scope**: ship `CreateEnsemble.tsx` from scratch (3-step: lineup →
  customize → review). Rewrite `Recruit.tsx` to 4-step matching
  `screens.jsx:RecruitWizard`. Adds ModalShell, Dialog (max-width 720),
  PickerList + PickerRow, Chipset + Chip, Field unification primitives
  (or split-off as PR-A3 if budget tight).
- **Recruit field semantics (Q3 lock-in)**: PLAYER-TYPE picker-list (loads from
  `agent-types` MCP tool / API endpoint, shows 5 of N with "· N available"
  count) + separate AGENT field (claude/copilot, defaults to claude).
- **CreateEnsemble**: Starting lineup picker-list (loads from `lineups` API),
  blank-ensemble row, default host + start mode (hold/release-immediately
  chipset), Conductor instructions textarea.
- **Mobile**: full-bleed modal at ≤520px (existing `≤520px` rules cover this).
- **Acceptance**: both wizards open as modals (Recruit from Workspace
  page-actions + Sidebar/Roster `+ Recruit` button; CreateEnsemble from
  Overview "New ensemble" + Sidebar "+ New ensemble" + EnsembleSwitcher
  "+ New ensemble"). Submit triggers `useRecruitMutation` /
  `useEnsembleCreateMutation` (the latter needs to exist; flag for engineer).

### PR-F — Library screens, desktop + mobile (~525 LoC)

- **Owner**: split — eng takes Loadouts + Schedules (mostly tabular), lead
  takes PlayerTypes + Hosts (PlayerTypes is the cards-grid that already had
  layout bugs; Hosts has 7 columns)
- **Scope**: rewrite all four. PageHeader for each. Apply `data-label`
  mobile-card pattern (per chat2.md fix lines 4480-4810) — tables collapse to
  stacked cards on phone via `@container artboard (max-width: 520px)` rule.
  PlayerTypes uses types-grid with `grid-auto-rows: max-content` +
  `align-content: start` (per chat2.md fix lines 4393-4444).
- **Acceptance**: every column/cell from `screens.jsx` renders. Mobile
  collapses to stacked cards correctly. PlayerTypes cards size to content
  (155-175px) without squish.

### PR-G — Settings (sidebar route, ~250 LoC)

- **Owner**: tempo-eng
- **Scope**: Convert Settings into a sidebar-routed page (no longer a
  SettingsSheet). 5 panels in `.settings-grid` 2-column layout:
  - **Connection**: KV (namespace / address / task queue / tls / auth) +
    `connected` status pill in panel-head
  - **Profile**: KV (display name / email / default lineup / default host)
  - **Notifications**: KV with notification mode per event (player detached /
    conductor handoff / schedule fired / recruit failed)
  - **Appearance**: KV (theme / density / accent / metronome) +
    "see Tweaks ⌥T" hint
  - **Danger zone** (full-width, `gridColumn: "1 / -1"`): Disband all
    ensembles + Reset client state, each as `settings-danger-row` with
    description + ghost btn
- **Retire**: delete `dashboard/src/components/SettingsSheet.tsx`. Update
  router to mount `Settings.tsx` directly under `/dashboard/settings`.
  Existing prefs store wiring stays — just relocate the controls.
- **Acceptance**: Settings route deep-linkable. All 5 panels render.
  Theme/density/accent controls function via existing prefs store.

### Dispatch order summary (revision 2)

| Phase | PRs in flight | Owners |
|---|---|---|
| 1 | PR-0 | lead |
| 2 | PR-A1 | lead |
| 3 (parallel) | PR-A1m, PR-A2 | eng (post-P3), eng or lead |
| 4 (parallel) | PR-B, PR-C1, PR-D | eng, lead, eng |
| 5 (parallel) | PR-C2, PR-E | eng, lead |
| 6 | PR-C3 | lead or eng |
| 7 (parallel) | PR-F (split) | eng + lead |
| 8 | PR-G | eng |

### Interaction with #388 (HTTP recruit mock-gate)

Independent surface (daemon HTTP handler, not dashboard frontend). No collision.
Eng should land #388 before PR-E if convenient (so Recruit's mock-adapter path
works); otherwise no ordering constraint.

### Interaction with #388 (HTTP recruit mock-gate)

**#388 surface** (per #389 issue body): HTTP recruit blocks mock adapter. This
is independent of every screen change in #389. The fix lives in the daemon HTTP
handler / adapter registry, NOT in the dashboard frontend. **No collision.**

Eng should land #388 ahead of PR-E (since PR-E's Recruit wizard with mock
adapter selection benefits from #388 being fixed). Otherwise no ordering
constraint.

### Beta.7 release

Beta.7 ships when PR-0 + PR-A1 + PR-A2 + PR-B + PR-C + PR-D + PR-E + PR-F land
and pass design-fidelity review. PR-G is a desirable-not-required addition.

---

## 7. Process improvement: design-fidelity check for QA

### Recommended addition to QA review template

Currently QA reviews focus on:
- Tests pass (`vitest` + Playwright e2e green)
- testids reachable
- Functional correctness (does it render, do mutations work)

### Add as P0 review item

**Design fidelity**: For every PR that touches a screen, the QA review MUST
include explicit element-by-element comparison against the corresponding
`screens.jsx` / `workspace.jsx` function (or `web-design-system.html` component
spec).

The reviewer asks:
1. Did I read the corresponding chat2.md section first?
2. For each element in the design source, is it present in the implementation?
3. For each element present in the design source but missing in the
   implementation, is the gap documented in the PR description as deferred-to-
   future-PR (with PR/issue link)?
4. Are the typography (font family, weight, size, italic) and color tokens
   matching?

### Optional automation: design-element coverage test

Add a small Vitest (in `tests/`) that, per screen, lists the **expected
testids** derived from the design source (`screens.jsx` SELECTOR comment) and
asserts they're present in a render snapshot:

```ts
// tests/design-fidelity.test.ts
const OVERVIEW_EXPECTED = [
  'page-header', 'page-pill-ensembles', 'page-pill-players', 'page-pill-hosts',
  'page-action-refresh', 'page-action-new-ensemble',
  'section-head-active-ensembles', 'section-head-recent-activity',
  'event-log',
];
test('Overview screen has all design-required testids', () => {
  render(<Overview />);
  for (const tid of OVERVIEW_EXPECTED) {
    expect(screen.queryByTestId(tid), `missing ${tid}`).toBeInTheDocument();
  }
});
```

This catches "scaffold shipped without content" regressions automatically. Each
`OVERVIEW_EXPECTED` list is owned by the architect and kept in sync with the
design source. Under-running tests are a P0 fail.

### Architect role in review

The architect (me) reviews PR-A1 and PR-A2 for primitive correctness against
`web-design-system.html` before the screen-rebuild PRs (B-G) start. Per-screen
PRs (B onward) can be reviewed by lead/eng with the design-fidelity checklist;
architect signs off on shape decisions only when the primitive has subtleties
(e.g., the FeedMessage 3-variant taxonomy).

---

## 8. Risk register (revision 2)

| # | Risk | Severity | Mitigation |
|---|---|---|---|
| 1 | Bundle-replacement order — audit relied on chats; if the v2 bundle in repo differs subtly from the temp-path version I read, the audit's specific line numbers may be off | Low | Architect re-validates the in-repo bundle before any PR-A merges. |
| 2 | PR-A1 LoC budget overrun (target 600-700, including tablet collapse) | Medium | Pre-split EnsembleCard + RosterItem + EventRow into PR-A1.1 if size projection exceeds 800 at design time. |
| 3 | PR-C overall scope — split into C1/C2/C3 already accepted | Low | Already mitigated by the 3-PR split in revision 2 phasing. |
| 4 | Token coverage gap = font swap may affect all existing tests via snapshot mismatch | Medium | PR-0 includes snapshot regen pass. QA reviews regen. |
| 5 | PlayerDetail KV groupings — RESOLVED Q2 lock-in: `Phase & lease` / `Work` / `Messages` exact | Resolved | — |
| 6 | Recruit Type field semantics — RESOLVED Q3 lock-in: pick BOTH player-type (picker-list) + adapter (separate field) | Resolved | — |
| 7 | Mobile in beta.7 — RESOLVED Q4 lock-in: every screen PR ships mobile | Resolved | LoC × 1.3-1.5 baked into PR sizes. PR-A1m added. |
| 8 | Backend snapshot doesn't surface `tempo`, `description`, `uptime`, `adapter version`, `lease`, `runId`, `received/sent counts` — RESOLVED Q5 lock-in: graceful degrade in beta.7, wire-extension design as Task #15 for beta.8 | Resolved | Implementor uses `—` placeholder for any missing field; QA does not fail review for placeholder-rendered missing fields. |
| 9 | Interaction with #388 (HTTP recruit mock-gate) | Low | Independent surface. No collision. Eng lands #388 ahead of PR-E if convenient. |
| 10 | Settings — RESOLVED Q1 lock-in: sidebar route + retire SettingsSheet | Resolved | — |
| 11 | Per-PR brief discipline (read README + chats + screens.jsx + web-design-system.html before coding) | Critical | Architect writes each PR brief from this audit doc. PR brief template includes the 4-input read step as a checklist. |
| 12 | Design tokens may diverge again (e.g., shadcn install in PR-7 may swap something) | Low | tokens.css mapping documented; shadcn integration deferred. |
| 13 | **NEW**: PR-A1m + PR-A2 parallel work may collide on `app-shell` CSS rules. Mitigation: A1m owns `app-shell--workspace` mobile rules; A2 owns chat/composer/popout positioning rules. Document boundary in PR briefs. | Medium | Architect specifies CSS file ownership in each PR brief. |
| 14 | **NEW**: `useEnsembleCreateMutation` does not yet exist — PR-E needs it | Medium | Architect flags in PR-E brief; eng adds the mutation hook (likely 30 LoC) at PR-E start, OR a pre-PR-E "infrastructure" patch lands the hook stub. |
| 15 | **NEW**: Lineup YAML `description` field is a schema change | Low | Additive. Update `src/ensemble/schema.ts` (Zod) + `src/ensemble/loader.ts`. Backwards compat trivial (optional). Land in PR-B (eng owns it as part of Overview wiring). |
| 16 | **NEW**: Recruit picker-list needs `agent_types` API endpoint | Low | `agent_types` MCP tool exists already; surface via `/v1/agent-types` HTTP route or via TempoClient if not yet exposed. Eng/lead checks during PR-E spec. |
| 17 | **NEW (Path B decision)**: dropping Tailwind 4 in PR-0 may break existing components that relied on utility classes with no semantic equivalent in `components.css` | Medium | Per PR-0 brief: TODO-comment those breakages, let them land "broken-looking", PR-B onward replaces those screens. Architect re-syncs `components.css` if vinceblank lands a styles.css update. |
| 18 | **NEW**: `components.css` port may drift from canonical `styles.css` over time | Medium | Architect owns periodic re-sync (every minor release until shadcn integration). Header comment in `components.css` documents source + last-sync commit hash. |
| 19 | **NEW (rev 3)**: Font discrepancy unresolved — `tokens.css` Inter/Fraunces vs `web-design-system.html` Instrument. Original implementer may have matched what RENDERED (fallback when Instrument didn't load) rather than what was DECLARED | High | PR-0 gates font swap on (a) vinceblank confirmation OR (b) render-test of `dashboard-handoff/project/dashboard.html` to see what actually paints. Acceptable to ship PR-0 without font swap, defer to a follow-up. **Don't swap mid-implementation.** |
| 20 | **NEW (rev 3, lead's audit)**: my original PR-A1 LoC estimate (500-600) was high — components already exist as scaffolds, real work is re-skin. Revised to 400-500 | Low | Phasing rev 3 reflects lead's number. If lead's actual implementation undershoots, parallel PR-A1m may absorb early. |
| 21 | **NEW (rev 4)**: PR-A1 PR-A2 PR-D briefs encode rev-4 C1-C7 clarifications inline. If implementer skims and misses (e.g., italic discipline C4), visual divergence emerges in QA. | Medium | Architect tags every rev-4 clarification in PR briefs with `(rev 4 Cx)` markers so QA can grep for them. QA design-fidelity checklist explicitly checks each marker. |
| 22 | **NEW (rev 4)**: BrandMark vs MaestroMark conflation risk — they're both "an M" but represent different things (brand vs operator). | Medium | Doc explicitly names them as separate primitives in §5.1 + PR-A1. QA verifies sidebar renders BOTH (BrandMark at top, MaestroMark in identity row). |

---

## 9. Decisions (revision 2 — all 6 questions locked 2026-04-28)

1. **Settings → sidebar route**: ✅ LOCKED YES. Retire `SettingsSheet.tsx` in
   PR-G. Settings is a Library nav item with 5 panels per `screens.jsx:Settings`.

2. **PlayerDetail KV groupings**: ✅ LOCKED. Names exact: `Phase & lease` /
   `Work` / `Messages` (per `screens.jsx:PlayerDetail`). Implementor uses
   these strings verbatim — no paraphrasing.

3. **Recruit picks player-type AND adapter**: ✅ LOCKED YES. Picker-list for
   player-type (loads from `agent-types`), separate field for adapter
   (`claude` default, `copilot` opt-in). Step count = 4.

4. **Mobile responsive in beta.7**: ✅ LOCKED YES — Option A (vinceblank: "may
   impact desktop implementation"). Every screen PR ships with mobile. PR-A1
   split into PR-A1 (desktop+tablet) + PR-A1m (mobile shell). PR-G is now
   Settings-only, not Settings+mobile (mobile is in every other PR).

5. **Snapshot wire extensions**: ✅ DEFERRED to beta.8. Beta.7 degrades
   gracefully (— placeholder). New Task #15 owns the design doc for the wire
   extension; it kicks off after PR-A spec writing finishes. Includes the
   open `tempo` semantics question (message-rate-per-minute? player-attached-
   rate? — TBD with vinceblank during beta.8 design pass).

6. **EnsembleCard description source**: ✅ LOCKED — lineup YAML field. Add
   optional `description` to `Lineup` schema (`src/ensemble/schema.ts`). Loader
   surfaces it on `Ensemble` via existing snapshot path. Empty string if
   lineup omits it.

## 9.1 Pending vinceblank input (non-blocking)

Only one question remains for the beta.8 cycle (Task #15):

- **Tempo semantics**: what does "tempo" mean quantitatively for an ensemble?
  Candidates: (a) message-rate-per-minute (last 60s rolling), (b)
  player-attached-rate (count of attached/processing/awaiting players × 4),
  (c) recent-message-count (last 60s), (d) something else. Ask during beta.8
  wire-extension design pass — not blocking beta.7 since fields degrade
  gracefully.

---

## 10. Attached artifacts

- This doc: `docs/design/dashboard-audit-389.md` (canonical audit reference for
  PR-0 through PR-G).
- Updated TaskList (15 tasks): tracking each per-screen audit, primitives
  inventory, phasing, risks, process, and the new beta.8 wire-extension design
  (Task #15).
- Source bundle (canonical): `docs/design/dashboard-handoff/` (v2; replaces
  v1 once vinceblank lands the repo update).

---

## 11. Beta.8 prep — snapshot wire-extension design (Task #15)

Not blocking beta.7. Kicks off after PR-A spec writing finishes.

### Fields to add

| Field | Source / computation | Dashboard usage |
|---|---|---|
| `tempo` | TBD with vinceblank — see §9.1. Likely derived in maestro from event-bus stats over last 60s | EnsembleCard BPM display, Workspace TempoStrip BPM right-aligned |
| `description` | Lineup YAML `description` field (added in PR-B as part of Overview) | EnsembleCard `ec-desc` |
| `uptime` | Earliest `phase: pending → attached` timestamp per ensemble; computed in maestro from event log | EnsembleCard 3-stat grid `uptime`, Workspace page-pill `up Xh Ym` |
| `adapter` (version) | From session attachment metadata; activity surfaces it on `claimAttachment` | PlayerDetail `Phase & lease` group, `adapter: claude-code · v1.2.4` |
| `leaseMs` (remaining) | `currentAttachment.leaseMs - (now - lastHeartbeatAt)` derived dashboard-side from existing fields | PlayerDetail `Phase & lease` group, `lease: expires in 54s` |
| `runId` | Truncated workflow runId, surfaced from Temporal SDK | PlayerDetail `Phase & lease` group, `run id: a3f2·c881` |
| `messagesReceived` / `messagesSent` | Counted in workflow via signal/outbox metering; surfaced via query | PlayerDetail `Messages` group |
| `outboxSize` | Already surfaced via `attachment-info` query | PlayerDetail `Messages` group, `outbox: empty` |

### Schema/wire approach

**Recommendation**: additive-only changes to `EnsembleStateV1` + per-player
projection. Add fields as optional. No `EnsembleStateV2` / feature negotiation
required. Wire-protocol bump is patch-level (additive optional fields don't
break older clients).

Update points:
- `src/types.ts` — add fields to `EnsembleSummary`, `PlayerSummary`,
  `EnsembleSnapshot`
- `src/workflows/maestro.ts` — add fields to maestro state and queries
- `src/workflows/session.ts` — add metering for messagesReceived/Sent
- `src/activities/maestro.ts` — surface tempo computation
- `src/http/snapshot.ts` — include new fields in HTTP response
- `src/http/event-types.ts` — extend SSE event payloads if needed
- `docs/WIRE-PROTOCOL.md` — version bump entry

### Patched markers

Use `patched('v0.X-snapshot-fields')` markers in workflows that compute the
new fields, so rolling deploys maintain compatibility (per the workflow
versioning convention from `CLAUDE.md`).

### Architect deliverable for Task #15

A standalone design doc at `docs/design/snapshot-wire-extension-beta.8.md`
covering: field-by-field source/computation, schema diff, workflow versioning
plan, graceful-degrade contract for older daemons (so that v0.27 dashboard +
v0.26 daemon still renders without errors).

---

🎼 *Audit produced by tempo-architect on the tempo-impl ensemble. Per the
v2 bundle README dispatch instruction: every implementer must read README +
chats + screens.jsx (and workspace.jsx for Workspace) + web-design-system.html
before writing code. This document distills those inputs into per-PR briefs
but does not replace reading them.*
