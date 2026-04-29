# Lead pre-log — #461 overflow audit (v0.28.0-beta.10)

**Status**: lead-1 phase pre-log — hypotheses for recruit walkers to validate
**Lead**: tempo-overflow-lead
**Date**: 2026-04-29
**Worktree**: `C:\repos\.ct-worktrees\tempo-impl\tempo-overflow-lead` on `feat/461-overflow-audit-lead`
**Source**: static read of `dashboard/src/styles/components.css` + `dashboard/src/screens/*.tsx` + `dashboard/src/components/**/*.tsx`. No live sampling yet — recruits do that tomorrow.

> **Methodology note — hypothesis vs. lock**: pixel audit pre-locked 10 findings as confirmed. This audit pre-logs *hypotheses* — suspected findings with severity guess + root-cause guess. Recruits **validate or refute** each hypothesis via live Chrome sampling. This is a more rigorous shape because (a) overflow under stress isn't directly readable from static CSS — it depends on actual computed layout — and (b) it gives recruits a structured workload (start with the suspect list, walk to find new ones) instead of an open exploration. Capture in audit doc §1 as methodology evolution.

---

## How to read this document

Each entry below is a **hypothesis**, not a confirmed finding. Recruits walk each entry's (component, viewport, content-regime) cell and:

- **Confirm** — observed behavior matches hypothesis. Promote to a numbered finding (e.g. F-LEAD-1) in the audit doc §4. Adjust severity if walked observation differs from hypothesis.
- **Refute** — overflow does not occur as predicted. Note in audit doc §4.x as "investigated, no finding" with a one-line note (helps reviewers understand the negative).
- **Adjust** — partial match (e.g. overflow occurs at a different viewport than predicted). Promote to finding with the corrected scope.
- **Discover-adjacent** — while validating one hypothesis, recruit notices a different overflow problem on the same screen. File as new finding (e.g. F-A-NEW-1) — recruits aren't limited to the pre-log.

---

## H1 — Sidebar `.er-name` long ensemble name overflow

**Component**: `Sidebar` (`dashboard/src/components/Sidebar.tsx:97-132`)
**CSS**: `components.css:271-299`
**Static evidence**:
- `.ensemble-row { grid-template-columns: 14px 1fr auto; gap: 10px; }` — middle 1fr cell holds `.col` flex container with `.er-name` + `.er-meta` children.
- `<span className="col" style={{ gap: 0 }}>` (Sidebar.tsx:122) — JSX inline-styles `gap: 0` but does NOT set `min-width: 0`. Without `min-width: 0` on a flex item, intrinsic content width prevents the 1fr column from shrinking below content width.
- `.ensemble-row .er-name { font-weight: 500; letter-spacing: -0.005em; }` — no `overflow`, no `text-overflow`, no `white-space: nowrap`.

**Hypothesis**: Long ensemble names (longTail fixture `tempo-impl-feature-flag-rollout-q3`, stress fixture 300-char name) push the trailing `↵` glyph (auto column) off the sidebar's right edge, OR force the entire 244px sidebar to overflow horizontally.

**Severity guess**: **P1 production-realistic**. Long ensemble names are normal in active dev usage (multi-word slugs).

**Auto-P1 candidate**: yes if overflow visibly clips into the workspace area to the right of the sidebar.

**Root-cause guess**:
1. Add `min-width: 0` to `.ensemble-row .col` (Sidebar.tsx inline style or new `.col` CSS rule)
2. Add `.ensemble-row .er-name { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }` to components.css

**Recruit task**: validate at desktop 1440 + laptop 1180, with longTail and stress ensembleName fixtures seeded.

---

## H2 — EnsembleCard `.ec-meta` lineup + host overflow

**Component**: `EnsembleCard` (`dashboard/src/components/EnsembleCard.tsx:177-180`)
**CSS**: `components.css:889-893`
**Static evidence**:
- `.ec-meta { display: flex; justify-content: space-between; font-size: 11px; }` — no overflow handling on the flex container or its children.
- JSX: two `<span>` siblings hold `lineup` and `host`. Currently both render `'—'` (wire-pending), but the design intends real values.

**Hypothesis**: When `lineup` is populated (e.g. `tempo-impl-feature-flag-rollout-q3`) and `host` is a FQDN (e.g. `ci-runner-prod-us-west-2.internal.example.com`), the two strings collide in the middle or push past the card's right edge.

**Severity guess**: **wire-pending P1** — flag as wire-pending since the values aren't yet live, but the layout WILL break when they are. Worth fixing now so the wire-up doesn't ship a regression.

**Root-cause guess**: add `min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap;` to `.ec-meta > span` rule.

**Recruit task**: at all 4 canonical viewports, manually inject lineup + host strings (React DevTools or `__seed*` hook) and observe.

---

## H3 — `.picker-row .name` long player-type slug overflow

**Component**: `PickerList` (CreateEnsemble + Recruit wizards)
**CSS**: `components.css:822-839`
**Static evidence**:
- `.picker-row { display: grid; grid-template-columns: 18px 1fr auto; }` — middle 1fr holds `.name`.
- `.picker-row .name { font-weight: 500; }` — no overflow handling.
- `.picker-row .desc { font-size: 11.5px; color: var(--dim); font-family: var(--ff-mono); }` — no overflow.

**Hypothesis**: Long player-type slugs (`la-tempo-advisor`, `my-tempo-researcher`, longTail fixtures) push the right-slot (TypeBadge or source label) off the picker-row's right edge, especially at laptop/tablet viewports where the wizard modal is narrower.

**Severity guess**: **P1 production-realistic** — these are real shipped player-type slugs; the user will see this in the Recruit wizard.

**Root-cause guess**: add `min-width: 0` to grid item containing `.name` + add ellipsis on `.name`.

**Recruit task**: open Recruit wizard at all 4 canonical viewports + boundary 901/899 (where modal width may flip). Validate with longTail fixture.

---

## H4 — `.types-grid 1fr 1fr` long slug stress on laptop

**Component**: `PlayerTypes` (`dashboard/src/screens/PlayerTypes.tsx:128-207`)
**CSS**: `components.css:1431-1437` (`1fr 1fr` post PR-D)
**Static evidence**:
- `.types-grid { grid-template-columns: 1fr 1fr; }` — 2-up at desktop+laptop+tablet, 1fr at phone.
- At laptop 1180 with sidebar 220px → artboard ~960px → each card ~470px wide minus gap minus padding → ~440px content area.
- `.display` heading at `fontSize: 20` + glyph at `fontSize: 22` mono.
- `glyphFor(type.name)` + `shortName` (with `tempo-` prefix stripped). For `my-tempo-researcher` → `shortName = 'my-tempo-researcher'` (the strip only removes `tempo-` prefix, not `my-tempo-` infix → length 19).
- 19 chars × ~13px avg display font ≈ 247px → fits at 440px content area.
- BUT for stress 300-char slug, no `overflow-wrap: anywhere` → unbreakable token pushes card width.

**Hypothesis A** (production-realistic): longTail slugs fit on laptop without overflow. **Refuted-by-static** — should be confirmed live as control.

**Hypothesis B** (synthetic stress): 300-char no-space player-type slug overflows the card or breaks the 1fr 1fr grid by forcing one card wider than its sibling. Severity: **P2 synthetic-stress**.

**Root-cause guess**: add `.types-grid .display { overflow-wrap: anywhere; word-break: break-word; }` to force-break unbreakable tokens.

**Recruit task**: load stress fixture into Player Types screen at laptop. Confirm B; refute or confirm A.

---

## H5 — Hosts table FQDN hostname overflow at non-phone viewports

**Component**: `Hosts` table (`dashboard/src/screens/Hosts.tsx:151-176`)
**CSS**: `components.css:77` (`.table th, .table td` density), `1525-1532` (phone collapse)
**Static evidence**:
- `<td className="mono">` renders `host.hostname` directly with leading status dot.
- Phone breakpoint (520px) has `min-width: 0; word-break: break-word` for table cells (line 1530).
- Tablet+laptop+desktop have no equivalent rule for the Host column → FQDN extends column width.
- Other columns (Platform, Sessions, Types, Daemon, Uptime, Heartbeat) get squeezed.

**Hypothesis**: At desktop 1440 with FQDN fixture (`ci-runner-prod-cluster-pod-7-replica-3.eks.internal.example.com`), the Host column expands to ≥350px and squeezes the rightmost columns into uselessly narrow widths or pushes the table to overflow horizontally.

**Severity guess**: **P1 production-realistic** — kubernetes-pod-style hostnames are a normal production occurrence.

**Auto-P1 candidate**: yes if hosts table introduces horizontal scrollbar OR if other columns become unreadable.

**Root-cause guess**: cap Host column with `max-width: 240px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap;` at non-phone viewports, with `title={hostname}` on the cell for the full value on hover.

**Recruit task**: seed `_overflow-fixtures.json:hostnames.fqdn` into hosts list; observe at all 4 canonical viewports.

---

## H6 — PageHeader `.page-title` accent name long-name overflow

**Component**: `PageHeader` (`dashboard/src/components/PageHeader.tsx:64-73`) used by PlayerDetail head
**CSS**: `components.css:346-361, 1183` (phone fontSize: 20)
**Static evidence**:
- `.page-title { font-size: 34px; line-height: 1; letter-spacing: -0.02em; }`
- `.page-title-row { display: flex; align-items: baseline; gap: 14px; flex-wrap: wrap; }` — has `flex-wrap: wrap`, good for long titles
- BUT no `overflow-wrap: anywhere` on `.page-title` — a single 300-char unbreakable token won't wrap mid-word
- At phone, font drops to 20px (line 1183) — still overflow risk

**Hypothesis A** (longTail production): names like `tempo-pixel-audit-recruit-batch-a` (33 chars) at 34px ≈ 600px → at desktop sheet width (likely max ~900px) fits; at phone (390 - sheet padding ≈ 330px) → wraps to next line → OK if `flex-wrap` on `.page-title-row` works for inline children.

**Hypothesis B** (stress): 300-char no-space name pushes page-title-row past the sheet width → horizontal scrollbar in `.player-sheet`. Severity: **P2 synthetic-stress**.

**Root-cause guess**: add `.page-title { overflow-wrap: anywhere; }` to handle stress; verify production-realistic case is graceful.

**Recruit task**: open PlayerDetail with longTail + stress player-name fixtures at desktop + tablet + phone.

---

## H7 — `.panel-head` no flex-wrap at boundary viewports

**Component**: any panel with a `.panel-head` (Workspace side panels, EnsembleWorkspace headers)
**CSS**: `components.css:459-466`
**Static evidence**:
- `.panel-head { display: flex; align-items: center; justify-content: space-between; gap: 12px; }` — no `flex-wrap`.
- At phone, `subj` is hidden via `.panel-head .panel-head-title .subj { display: none; }` (line 1200) — relieving collision.
- At tablet/laptop boundary 901-1199, subj stays visible AND actions stay visible → collision risk if subj is long.

**Hypothesis**: Long subj (e.g. `@tempo-impl-feature-flag-rollout-q3`) at viewport 1199 (just below 1200 CQ — sidebar still 244px) collides with action buttons in panel-head, OR pushes actions off the right edge.

**Severity guess**: **P2 boundary-viewport** — only at the 1199-901 narrow band.

**Root-cause guess**: add `flex-wrap: wrap` to `.panel-head` at the 1200 CQ break, OR add `min-width: 0; overflow: hidden; text-overflow: ellipsis;` to `.panel-head-title`.

**Recruit task**: walk panel-head bearing screens (Workspace, Settings, Loadouts) at boundary viewports 1199 / 1201 / 901 / 899 with longTail fixtures.

---

## H8 — `.msg-body` code-block horizontal overflow

**Component**: `FeedMessage` body (`dashboard/src/components/chat/FeedMessage.tsx:99-101`)
**CSS**: `components.css:528-534`
**Static evidence**:
- `.msg-body { max-width: 72ch; text-wrap: pretty; }` — handles natural-language wrapping fine.
- BUT `.msg-body` has no inner `pre` / `code` overflow rules. If a chat message contains a markdown code block (long single-line: `npm install --save-dev @some/very-long-package-name@1.2.3 …`), the inner `<pre>` extends past the 72ch limit, pushing the parent or introducing a scrollbar.
- Conductor messages frequently include code blocks → high frequency.

**Hypothesis**: Code blocks with long unbreakable tokens overflow the 72ch limit horizontally; the `.msg-body` either grows past 72ch (breaking the layout cap) or introduces a horizontal scrollbar inside the message.

**Severity guess**: **P1 production-realistic** if the layout cap breaks; **P3 cosmetic** if a scrollbar appears (probably the design intent).

**Root-cause guess**: add `.msg-body pre, .msg-body code { overflow-x: auto; max-width: 100%; }` to confine the scrollable region. Verify against canonical handoff for design intent (deliberate ellipsis vs. scroll vs. wrap).

**Recruit task**: live Chrome sample — inject a chat message containing a long-line code block; observe overflow shape.

---

## H9 — Settings `.kv` long-value overflow

**Component**: `Settings` (TBD — read `dashboard/src/screens/Settings.tsx`)
**CSS**: `components.css:76` (.kv padding only)
**Static evidence**:
- `.kv { padding: calc(var(--density-pad-y) * 0.5) 0; }` — only padding, no width handling.
- `.kv` rows likely contain a label + value as flex/grid pair. Long values (version strings with build hash, file paths) overflow.

**Hypothesis**: Long version strings (`v0.28.0-beta.10+main.a1b2c3d`) or long namespace paths in Settings KVs overflow.

**Severity guess**: **P2 longTail content** — depends on whether values are typical or rare.

**Recruit task**: load Settings, observe each KV at all viewports; if a value is short, inject a synthetic long value via DevTools.

**Note**: ST-2 (pixel audit) deferred Settings live-controls ratification; this is orthogonal — the overflow concern stands regardless of static-vs-live decision.

---

## H10 — `.page-pills` chip wrap at boundary 1199

**Component**: PageHeader pills slot
**CSS**: `components.css:366-369, 1184` (phone wrap)
**Static evidence**:
- Default pills container has no flex-wrap at desktop/laptop.
- Phone has `.page-pills { gap: 4px; flex-wrap: wrap; }` (line 1184).
- Boundary 1199 → CQ fires `(max-width: 1200px)` rule but NOT the phone wrap rule → pills could overflow if there are many.

**Hypothesis**: ~6+ pills on a single page-header at viewport 1199 push past the page-actions slot, colliding with action buttons.

**Severity guess**: **P2 boundary-viewport** — depends on pill count, which is component-specific.

**Recruit task**: walk page-headers with high pill counts at boundary viewports.

---

## H11 — TempoStrip narrow-viewport rendering

**Component**: `TempoStrip` (`dashboard/src/components/tempo/TempoStrip.tsx`)
**Static evidence**: not yet read in detail.

**Hypothesis**: Sparkline + bpm overlay at narrow viewports may either clip the sparkline, overlap the bpm chip, or scale awkwardly.

**Severity guess**: **TBD** — needs walk to determine.

**Recruit task**: walk all 4 canonical + 6 boundary viewports; if behavior is graceful → no finding. If clipped → file with severity per regime.

---

## H12 — PlayerTypeCard 1fr 1fr row-height mismatch

**Component**: `PlayerTypeCard` (`dashboard/src/screens/PlayerTypes.tsx:128-207`) inside `.types-grid`
**Static evidence**:
- `.types-grid { grid-auto-rows: max-content; align-content: start; }` (PR-D) — grid rows size to tallest sibling per row.
- Card description in JSX: `<div style={{ color: 'var(--text-2)', fontSize: 13, lineHeight: 1.5 }}>` — no max-height.
- At canonical card content lengths, descriptions are similar → cards align.
- At longTail descriptions, one card may be 4 lines + sibling 2 lines → row height = 4-line card; sibling has visible empty space below the actions row.

**Hypothesis**: Visually unbalanced rows when descriptions in same row vary in length. Not "overflow" strictly — but a content-length-stress finding.

**Severity guess**: **P3 cosmetic** — not broken, just unbalanced. Audit notes it; design owner decides if `flex-grow: 1` on summary or fixed max-height with ellipsis is preferred.

**Recruit task**: load mixed-length descriptions across cards; observe row balance. Out-of-scope-flag if not desired.

---

## H13 — `.ec-roster` PlayerAvatar overlap with long player names (intra-avatar)

**Component**: `PlayerAvatar` inside `EnsembleCard.ec-roster` (line 198-205)
**Static evidence**:
- 5 avatars rendered + `+N` mono-dim suffix.
- Each `PlayerAvatar` is `size={22}` — fixed pixel.
- `.ec-roster` likely flex-row — at 5 avatars + suffix → ~140px width. Card width ~280px+ → fits.
- BUT each avatar may have a `title` tooltip or visible name attached.

**Hypothesis**: Avatars themselves are fixed-size and don't overflow. **Likely-no-finding** — confirm via walk and close.

**Severity guess**: **likely no finding**.

**Recruit task**: spot-check; close if no observable issue.

---

## H14 — Page-actions button row overflow at narrow viewports

**Component**: any PageHeader with multiple action buttons (Hosts, PlayerTypes, Loadouts, Schedules)
**CSS**: `components.css:1186-1191` (phone has `flex-wrap: wrap; justify-content: flex-end`)
**Static evidence**:
- Phone: page-actions wraps. Good.
- Tablet+laptop boundary: no explicit wrap rule → `Re-scan + New type` at PlayerTypes might fit, but `Re-scan + Show stale` at Hosts has variable text width (`Show stale` vs `Hide stale` swap).
- Page actions slot is right-aligned with no max-width.

**Hypothesis**: Long action labels (especially internationalized future labels) at tablet 834 collide with title or push past the page-header right edge.

**Severity guess**: **P3 cosmetic** for current English labels (all short); **P2 synthetic** if labels lengthen.

**Recruit task**: walk page-actions at tablet + boundary 901/899.

---

## Summary table

| # | Hypothesis | Component | Severity guess | Confidence (static) |
|---|---|---|---|---|
| H1 | `.er-name` long-name overflow | Sidebar | **P1 prod-realistic** | high |
| H2 | `.ec-meta` lineup+host collision | EnsembleCard | wire-pending **P1** | high |
| H3 | `.picker-row .name` slug overflow | PickerList | **P1 prod-realistic** | high |
| H4 | `.types-grid` stress slug | PlayerTypes | **P2 stress** | medium |
| H5 | Hosts FQDN cell overflow | Hosts table | **P1 prod-realistic** | high |
| H6 | `.page-title` long-name overflow | PageHeader | **P2 stress** | medium |
| H7 | `.panel-head` no flex-wrap | panel-head bearing screens | **P2 boundary** | medium |
| H8 | `.msg-body` code-block overflow | FeedMessage | **P1/P3** | medium |
| H9 | Settings `.kv` long-value overflow | Settings | **P2 long-tail** | low (TBD content) |
| H10 | `.page-pills` chip wrap boundary | PageHeader pills | **P2 boundary** | low (count-dependent) |
| H11 | TempoStrip narrow render | TempoStrip | TBD | low |
| H12 | PlayerTypeCard row-height mismatch | PlayerTypes | **P3 cosmetic** | medium |
| H13 | `.ec-roster` avatar overlap | EnsembleCard | likely no finding | low |
| H14 | `.page-actions` button row overflow | PageHeader actions | **P3 / P2 i18n** | low |

**Distribution**: 4 high-confidence P1 prod-realistic, 4 medium-confidence P2, 6 lower-confidence / cosmetic / probable-no-finding.

**Cross-cutting root cause** (preview): missing `min-width: 0` on flex/grid items + missing `text-overflow: ellipsis` on text-bearing leaf elements. If H1, H2, H3, H5 all confirm, **PR-α** = "min-width-0 + ellipsis cluster" is the natural cluster shape. Mirrors the pixel audit's PR-A (phone .table parity) shape.

---

## Coverage map — which recruit walks which

To minimize redundancy, split the walks by component cluster (see `_recruit-brief-a.md` and `_recruit-brief-b.md`):

| Hypothesis | Batch A (cards/headers/wizards) | Batch B (tables/sidebar/chat/buttons) |
|---|---|---|
| H1 — Sidebar `.er-name` | | ✓ |
| H2 — EnsembleCard `.ec-meta` | ✓ | |
| H3 — `.picker-row .name` | ✓ | |
| H4 — `.types-grid` stress | ✓ | |
| H5 — Hosts FQDN | | ✓ |
| H6 — `.page-title` | ✓ | |
| H7 — `.panel-head` | | ✓ |
| H8 — `.msg-body` code | | ✓ |
| H9 — Settings `.kv` | | ✓ |
| H10 — `.page-pills` | ✓ | |
| H11 — TempoStrip | | ✓ |
| H12 — PlayerTypeCard rows | ✓ | |
| H13 — `.ec-roster` | ✓ | |
| H14 — `.page-actions` | ✓ | |

**Rationale**:
- Batch A: card-shape + form-shape components — overflow tends to be intra-card or intra-form.
- Batch B: table/list/chat/sidebar — overflow tends to be cross-cell or cross-row.

---

## Audit doc methodology evolution callout

Add to `dashboard-overflow-audit-v0.28.10.md` §1.4 after the "hybrid live + static" paragraph:

> **Methodology evolution from pixel audit**: pixel audit pre-locked findings before recruits walked. This audit pre-logs **hypotheses** with severity-guess + root-cause-guess; recruits validate or refute each. The change is motivated by overflow-under-stress not being directly readable from static CSS — it depends on actual computed layout — so pre-locking would over-claim. Hypothesis-then-validate also gives recruits a structured workload (suspect list to check, then open exploration for new findings) instead of an empty exploration. Future audits should consider this pattern when the audit target is a computed-value phenomenon rather than a token-table comparison.
