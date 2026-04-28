# Dashboard pixel-alignment audit — v0.28.0-beta.9

**Status**: COMPLETE
**Date**: 2026-04-28
**Branch audited**: `release/v0.28.0-beta.6` @ `222bdfd8` (npm tag `beta` = `0.28.0-beta.9`)
**Audit lead**: tempo-architect
**Recruits**: tempo-pixel-a (batch A: Workspace, PlayerDetail, Overview, CreateEnsemble, Recruit), tempo-pixel-b (batch B: Loadouts, PlayerTypes, Schedules, Hosts, Settings)
**Methodology baseline**: depth-2 audit. The earlier `dashboard-audit-389-followup-rev3.md` cert validated *structural* fidelity (component shape, layout grid, behavior). This pass goes deeper into *pixel* fidelity: typography scale, spacing, colors, line-heights, border-radii, shadows, font-weights — compared element-by-element against the canonical `docs/design/dashboard-handoff/project/` bundle.

---

## Executive summary

The impl is **token-aligned but port-drifted**: the design tokens (colors,
typography, density, breakpoints) are byte-identical between canonical
`styles.css` and impl `tokens.css` + `globals.css`, but the
`components.css` port has fallen behind canonical CSS by **144 lines** of
unported rules accumulated since commit `2e4802c8` (PR #340). The headline
finding is a **partial-port event**, not a wholesale styling miss — some
HEAD-canonical changes are present in impl, others aren't, and the
LAST-SYNC marker in components.css is misleading about which.

**Severity distribution**: **10 P1, 7 P2, 20 P3 = 37 findings total** (lead
pre-locked 10; recruits added 27 new + corroborated 14 lead findings on
specific screens/viewports). The P1 cluster is dominated by port-drift; P2
findings are predominantly visible at the phone breakpoint where the
unported `@container artboard (max-width: 520px)` rules live; P3 findings
are split between cosmetic (hex-case normalization) and design-owner
ratification asks (Settings live controls, PlayerTypes column rule).

**Recommended fix path**: 7 PR clusters totaling ~6 active + 1 deferred.
**PR-A** (phone .table parity) and **PR-B** (full 144-line port re-sync)
are ship-blocking for any phone-targeted demo and should land first.
**PR-C** (PlayerDetail sheet frame) and **PR-D** (PlayerTypes column rule)
need design-owner decisions on intentional-vs-drift before they can land.
**PR-E** through **PR-G** are independent and low-risk.

**Methodology endorsement**: both recruits independently pivoted from live
Chrome DevTools sampling to **static class-application audit**, with
identical reasoning: with the token table proven byte-identical, live
sampling adds no signal beyond what static CSS+JSX comparison provides.
The real signal is differential class drift, which is statically
measurable. The audit lead endorses this — static class-application audit
is the right shape for a port-derived stylesheet.

---

## 1. Methodology

### 1.1 Sources

**Canonical** (under `docs/design/dashboard-handoff/project/`):
- `styles.css` (1888 lines) — single canonical stylesheet, primary source of truth
- `web-design-system.html` (1658 lines) — design-system reference page with token tables
- `dashboard.html` (149 lines) — artboard wrapper (note: stale font preload — see §4.5)
- `screens.jsx` (570 lines) — canonical screen primitives
- `workspace.jsx` (552 lines) — canonical workspace primitive

**Impl** (under `dashboard/src/`):
- `styles/tokens.css` (164 lines) — design tokens
- `styles/globals.css` (107 lines) — base reset + utilities + keyframes
- `styles/components.css` (1687 lines) — component CSS (port of canonical's selectors)
- `screens/*.tsx` (10 files) — React screen components
- `index.html` — Google Fonts loader

### 1.2 Audit scope

- **10 designed screens**: Workspace, PlayerDetail, Overview, CreateEnsemble, Recruit (batch A); Loadouts, PlayerTypes, Schedules, Hosts, Settings (batch B). Settings is canonical-by-code-not-by-canvas (defined in `screens.jsx:536` but never rendered as an artboard in `dashboard.html`).
- **4 canonical viewports**: Desktop 1440×900, Laptop 1180×820, Tablet 834×1100, Phone 390×780. Each hits a distinct `@container artboard` regime.
- **Visual axes locked to defaults**: dark theme, density 6, accent `#e07a5f`, motion-on. Light-theme audit is a separate pass.

### 1.3 Architectural framing — container queries, not media queries

The dashboard responds to its **artboard inline-size** via `@container artboard (...)`, not the browser viewport. This means the *artboard* is the responsive container; the viewport sets the artboard width *minus the sidebar* (244 → 220 → 64 → 0 px across the four breakpoints). All sampling is done at canonical viewport-table sizes.

This is a deliberate design-system choice that distinguishes the dashboard from typical media-query-driven responsive layouts and is a **design-system DNA** callout — the dashboard could be embedded in a shrunken iframe and behave as if it were on a phone.

### 1.4 Sample protocol — static class-application audit

Per (screen, viewport) pair, **5 representative elements** were evaluated exercising distinct token classes: page heading (display font), body copy (UI font), primary button (accent + button tokens), card/panel (rule + radius + shadow), mono label (mono font + dim color). For each element, the impl's class application + relevant `components.css` rule that would resolve at that breakpoint was compared against the canonical's `screens.jsx`/`workspace.jsx` + `styles.css` equivalent.

**Methodology pivot from live to static**: the original brief prescribed Chrome DevTools computed-style sampling on a live dev daemon. Both recruits independently pivoted to static audit, with identical reasoning:

1. §3 of the rubric proves all 19 dark-theme color tokens, all 6 density steps, and all 3 typography family stacks are **byte-identical** between canonical and impl.
2. Computed-style divergence after that lock can only come from (a) JSX class-application drift, (b) `@container` rule drift in components.css, or (c) font-loading misses (resolved by `dashboard/index.html` correctly preloading per #389 PR-0).
3. All three are statically measurable by reading CSS and JSX. Live sampling on a daemon would only confirm the value table without finding new drift.

The lead endorses this pivot. **Static class-application audit is the appropriate shape for auditing a port-derived stylesheet against its canonical source.** Live DOM sampling remains available as a 30-min follow-up if font-loading flicker or browser-engine quirks need verification.

### 1.5 Severity rubric

- **P1** — visible design break: wrong color family, wrong font family, ≥1 size-class off, missing element, broken responsive collapse, or **port drift** (canonical rule absent from impl — auto-P1 per discipline regardless of individual visual mildness).
- **P2** — soft mismatch: off-by-1px spacing, slight oklch shade variance, line-height ±0.05, radius off by 2px, color-mix transparency off by 5%, letter-spacing ±0.005em.
- **P3** — token gap or doc-side discrepancy: token defined but unused, hex-case mismatch, inline value that should be a token, doc-vs-CSS contradiction.

**Disposition tag** (orthogonal to severity): some findings are *intentional pending future work* (e.g., F-A-1 awaits Radix integration; L-1/S-1 await PR-7 safe-write endpoints). These keep their severity but are tagged "deferred pending PR-N" so triage can route them.

**Visual severity** (annotation, not re-scoring): some port-drift findings have mild visual impact (e.g., F-A-2: page title doesn't shrink to 20px on phone — visible but not broken). They stay P1 architecturally to keep the port-resync PR's signal intact, with a "visual: mild" annotation where useful.

---

## 2. Architectural finding — port drift

### 2.1 LAST-SYNC pointer is stale (F-LEAD-1, P1)

`dashboard/src/styles/components.css` lines 4–6 declare:

```
SOURCE: docs/design/dashboard-handoff/project/styles.css
LAST-SYNC COMMIT: 2e4802c80c1c251c2126b1f4570f1a8c16792ecf
PORT DATE: 2026-04-28 (PR-0 of #389, audit rev 3 §6.5 Path B)
```

The LAST-SYNC commit `2e4802c8` is "include claude-design dashboard handoff bundle (#340)" — the **initial** bundle land. Canonical `styles.css` has since been updated in `829f67d3` ("land #389 audit + v3 handoff bundle") with **144 lines of CSS changes** plus `+1658` for the new `web-design-system.html` and `+552` for the new `workspace.jsx`. The PORT DATE says "today" but the LAST-SYNC pointer was not updated — meaning there is no documented evidence of a *complete* re-sync.

### 2.2 Verification — partial port confirmed

Spot-checking the 144-line canonical diff against impl:

| Canonical addition | Impl status |
|---|---|
| `@container artboard (max-width: 520px) .popout-window` (phone fullscreen) | ✓ ported (components.css:1298–1308) |
| `.types-grid { grid-auto-rows: max-content; align-content: start }` | ✓ ported (components.css:1352–1356) |
| `.player-sheet { max-width: 100% }` (changed from 92%) | ✗ impl still has 92% (components.css:1361) — **F-LEAD-2** |
| `.ensemble-row .er-initial` block (32×32 mono-letter avatar for tablet) | ✗ entirely missing — **F-LEAD-3** |
| `.ensemble-row--new .icon-g` "new ensemble" affordance (tablet) | ✗ entirely missing |
| `.types-grid > .panel > .row` flex-wrap rules at phone ≤520px | ✗ missing — **F-LEAD-4** |
| `@container artboard (max-width: 520px) .page-title { font-size: 20px }` | ✗ missing — **F-A-2** |
| Phone `.table` first-cell typography (`font-weight: 600; font-size: 14px`) | ✗ missing — **L-2** |
| Phone `.table` last-cell button-row layout (`display: flex !important; .btn { flex: 1 }`) | ✗ missing — **L-3** |
| Phone `.table` middle-cell label width / data-label letter-spacing / row padding / nowrap rule | ✗ missing — **L-4..L-7** |
| Phone `.table` collapse cascade strategy (`display: block` reset) | ⚠ impl uses different strategy — functionally equivalent — **L-8, L-9, F-LEAD-9** |

**Conclusion**: the impl is at a **mixed snapshot** — some HEAD-canonical changes present, others not. The LAST-SYNC marker is a misleading proxy for sync state. **Port drift is the dominant signal** of this audit.

### 2.3 Re-sync path

The file header at lines 35–40 of `components.css` documents the procedure:

```
RE-SYNC: The architect re-syncs this file with the canonical source
each minor release until the planned shadcn integration. To re-sync:
  1. git diff <last-sync> HEAD -- docs/design/dashboard-handoff/project/styles.css
  2. Apply matching changes here, preserving the in-scope filter above.
  3. Update LAST-SYNC COMMIT and PORT DATE.
```

This procedure was **not followed** for #395. **PR-B** (§7) executes this path.

---

## 3. Token-level alignment — proven byte-identical

### 3.1 Color tokens — dark theme

All 18 dark-theme color tokens are **value-identical** between canonical
(`styles.css:7–36`) and impl (`tokens.css:18–56`). The only difference is
**hex case** (canonical UPPERCASE, impl lowercase) — same paint.

Canonical: `#E07A5F`, `#0F1117`, `#141722`, `#1A1E2B`, `#20253417` (alpha hex), `#1B2030`, `#F5EEE6`, `#C5C1B9`, `#7D8090`, `#4B5064`, `#262B3A`, `#343A4F`, `#8CC79A`, `#E9C888`, `#EF5C5C`, `#7FB3D5`, plus `--accent-soft: oklch(0.72 0.12 28 / 0.18)`, `--accent-ink: oklch(0.92 0.05 28)`. Impl: same values, lowercase hex.

**Impl-side addition**: `--muted-2: var(--muted)` — alias reserved for future shadcn remap. Not a canonical token; not a paint diff.

**F-LEAD-5** (P3): batch hex-case normalization to UPPERCASE in a single PR.

### 3.2 Color tokens — light theme

Same shape; values differ per design. Out of scope for this audit.

### 3.3 Typography

| Aspect | Canonical | Impl | Diff |
|---|---|---|---|
| `--ff-ui` family stack | `'Instrument Sans', ui-sans-serif, system-ui, -apple-system, 'Segoe UI', sans-serif` | same | none |
| `--ff-display` | `'Instrument Serif', 'Times New Roman', serif` | same | none |
| `--ff-mono` | `'JetBrains Mono', ui-monospace, SFMono-Regular, Menlo, monospace` | same | none |
| Google Fonts loader | `Instrument+Sans:wght@400;500;600;700&family=Instrument+Serif:ital@0;1&family=JetBrains+Mono:wght@400;500` (web-design-system.html:9) | matches at `dashboard/index.html:13` | none |
| Type scale (production) | 17 distinct sizes used (a subset of canonical's 22; missing 44/38/32/28/26 are DS-page-only) | same set | none |
| Line-heights | 1, 1.05, 1.1, 1.2, 1.4, 1.45, 1.5, 1.55, 1.6, 1.7 + 1.85 (DS-only) | same set in production | none |
| Font weights | 400, 500, 600, 700 | same | none |
| Italic discipline | "✓ for maestro mark, accent `<em>`, routed messages, empty-state hero. ✗ for body, buttons, labels, tables, page/section titles, names." | impl uses italic on `.msg.route .msg-body` (matches "routed messages" rule) | none |
| Font feature `body { font-feature-settings: 'ss01' }` | yes (`styles.css:99`) | yes (`globals.css:25`) | none |

### 3.4 Density tokens

All 6 levels (`d4`–`d9`) plus `:root` default are byte-identical between canonical (`styles.css:38–52`) and impl (`tokens.css:108–164`).

### 3.5 `dashboard.html` font preload — stale legacy choice (F-LEAD-8, P3)

The canonical artboard wrapper (`dashboard.html:9`) preloads legacy `Inter + Fraunces`. The actual `styles.css` declares `Instrument Sans + Instrument Serif + JetBrains Mono`. The canonical bundle is internally inconsistent.

**The impl correctly follows `web-design-system.html` per #389 (PR-0)**, documented in `tokens.css` lines 60–73. Not a bug in the impl — flagged for canonical-side reconciliation.

### 3.6 Shadow tokens

| Token | Canonical | Impl | Used by |
|---|---|---|---|
| `--shadow-1` | declared, unused in production | declared, unused | DS-page only |
| `--shadow-2` | declared, used by `.dialog` | declared, used by `.dialog` | dialog modal drop-shadow |

**F-LEAD-6** (P3): `--shadow-1` declared but never applied. Cosmetic preservation of DS contract; do not remove.

### 3.7 Container-query breakpoints

| Breakpoint | Canonical | Impl |
|---|---|---|
| `(max-width: 1200px)` | yes | yes (`components.css:907`) |
| `(max-width: 900px)` | yes | yes (`components.css:915, 1391`) |
| `(max-width: 720px)` | yes | yes (`components.css:1685`) |
| `(max-width: 520px)` | yes | yes (`components.css:948, 1298, 1408`) |
| `(min-width: 521px)` (inverted) | yes | yes (`components.css:1655`) |

All breakpoints byte-identical. **No drift in responsive boundaries.**

---

## 4. Findings catalog

37 findings total (10 lead pre-locked + 27 from recruits). Grouped by source.

### 4.1 Lead pre-locked (F-LEAD-1..10)

| ID | Severity | Title | Location | Recommendation |
|---|---|---|---|---|
| F-LEAD-1 | **P1** | components.css LAST-SYNC pointer stale; canonical 144-line drift since `2e4802c8` | `dashboard/src/styles/components.css:5` | Port-resync PR per re-sync procedure (PR-B) |
| F-LEAD-2 | **P1** | `.player-sheet { max-width: 92% }` (impl) vs `100%` (canonical HEAD) | `components.css:1361` | Update to `max-width: 100%` (PR-C) |
| F-LEAD-3 | **P1** | `.ensemble-row .er-initial` block missing on tablet sidebar | `components.css` (insertion needed) | Port the er-initial rules; substitute undeclared `--surface-1/2/--text-1` with declared equivalents (PR-B) |
| F-LEAD-4 | **P1** | `.types-grid > .panel > .row` flex-wrap rules missing at phone | `components.css:1408+` | Port the wrapping rules (PR-B + PR-D) |
| F-LEAD-5 | P3 | Hex-case difference (canonical UPPERCASE vs impl lowercase) across 19 dark-theme tokens | `tokens.css:18-99` | Normalize to UPPERCASE (PR-F) |
| F-LEAD-6 | P3 | `--shadow-1` declared but unused in production CSS in both | `tokens.css:58, styles.css:30` | Preserve (DS contract) |
| F-LEAD-7 | P3 | Canonical references undeclared `--surface-1`, `--surface-2`, `--text-1` in tablet block — canonical-side bug | `styles.css:1067-1083` | Substitute with declared tokens when porting F-LEAD-3 |
| F-LEAD-8 | P3 | `dashboard.html` preloads legacy fonts (Inter+Fraunces); impl correctly follows web-design-system.html | `dashboard.html:9` | Out-of-scope (canonical-side); impl is correct |
| F-LEAD-9 | P3 | Phone `.table` collapse strategy uses different selector pattern. Functionally equivalent | `components.css:1408+` vs `styles.css:1582+` | See L-cluster for specific deltas |
| F-LEAD-10 | P3 | DS spec card claims "2 radii" but canonical CSS uses 12. Canonical-internal contradiction | `web-design-system.html:851-867` vs `styles.css` | Update DS spec card or comment; out-of-scope for impl |

### 4.2 Batch A (F-A-1..7)

| ID | Severity | Title | Disposition | Recommendation |
|---|---|---|---|---|
| F-A-1 | **P1** | PlayerDetail outer frame is a slide-out drawer (480px right-edge), not the canonical centered `.sheet.player-sheet` modal. Internal grid correct, outer wrong. | **Deferred pending Radix integration** — ResponsivePanel.tsx documents this as a Radix substitute | PR-C: class-up to `.sheet.player-sheet` now, OR ratify divergence pending Radix |
| F-A-2 | **P1** | `.page-title` doesn't shrink to 20px at the phone breakpoint (port drift) | Visual: mild ("title too big") | PR-B: port the canonical phone rule |
| F-A-3 | **P2** | Pop-out button visible on phone (should be hidden via `.popout-btn { display: none }` wrapper class) | JSX missing `<span class="popout-btn">` wrapper | PR-E: wrap the button |
| F-A-4 | **P2** | `.picker-row` inline padding overrides phone CSS (`padding: '7px 10px'` inline beats `@container` rule) | PickerList JSX inlines style | PR-E: remove inline padding from PickerList |
| F-A-5 | P3 | Blank-ensemble option in CreateEnsemble loses accent cue (canonical: terracotta + `+` glyph; impl: standard radio dot) | JSX missing accent affordance | PR-E: add accent flag to PickerOption |
| F-A-6 | **P2** | Recruit player-type picker right-slot uses gray source-tier label instead of color-coded TypeBadge | Different design intent | PR-E: render TypeBadge in right slot |
| F-A-7 | P3 | Workspace Schedules side-panel drops `+ New` button + Event log copy is shorter (drops "messages elided") | JSX missing affordances | PR-E: restore button + copy |

### 4.3 Batch B — Loadouts/Schedules/Hosts (L-1..L-9, S-1, H-1..H-3)

| ID | Severity | Title | Disposition | Recommendation |
|---|---|---|---|---|
| L-1 | P3 | Loadouts row "Load" button variant downgrade (primary → ghost-disabled); same pattern across Loadouts row "Edit", "Import YAML", "+ New loadout" | **Deferred to PR-7** — wire-pending safe-write endpoints | DEFERRED: restore `variant="primary"` after PR-7 |
| L-2 | **P1** | Phone `.table` first-cell typography missing (`font-weight: 600; font-size: 14px; margin-bottom: 2px`) — card heading affordance disappears | Port drift (in 144-line zone) | PR-A: port the rule |
| L-3 | **P1** | Phone `.table` last-cell button-row layout missing (`display: flex !important; .btn { flex: 1 }`); buttons may overflow on phone | Port drift | PR-A: port the canonical block |
| L-4 | **P2** | Phone `.table` middle-cell label width (84→110px), column-gap (12→8px), font-size (12.5→13px) | Port drift | PR-A: port canonical numbers |
| L-5 | **P2** | Phone `.table` data-label letter-spacing (0.06→0.08em), color (--text-2→--dim), line-height (1.6→inherit) | Port drift | PR-A: port canonical values |
| L-6 | **P2** | Phone `.table` row padding (14/14/12px → 10/12px) — cards feel tighter | Port drift | PR-A |
| L-7 | **P2** | Missing `.table .type-badge / .mono.dim { white-space: nowrap; display: inline-block }` rule on phone | Port drift | PR-A |
| L-8 | P3 | Phone `.table` display-cascade strategy mismatch (canonical resets via `display: block` then re-grids; impl grids directly) | Functionally equivalent | PR-A optional rewrite |
| L-9 | P3 | `.table tr:first-child { border-top: none }` only canonical-side; impl uses border-bottom | Functionally equivalent | PR-A optional |
| S-1 | P3 | Schedules row Cancel button variant downgrade (danger red → ghost gray-disabled) | **Deferred to PR-7** — wire-pending | DEFERRED |
| H-1 | P3 | Hosts Platform cell color (canonical `--text-2`; impl `mono dim` → `--dim`) | Off-by-one ink tier | PR-E: change className to add `--text-2` inline |
| H-2 | P3 | Hosts wire-pending content (`—` for Sessions/Uptime) — graceful degrade | Wire-pending | Informational |
| H-3 | P3 | Hosts heartbeat suffix divergence (canonical mock " ago" duplication) | Visual outcome identical | Informational |

### 4.4 Batch B — PlayerTypes (T-1..T-3)

| ID | Severity | Title | Disposition | Recommendation |
|---|---|---|---|---|
| T-1 | **P1** | `.types-grid` column rule diverges (canonical `1fr 1fr` 2-wide; impl `auto-fill / minmax(155px, 175px)` 5–6 narrow). Major visible layout difference | **Needs design-owner ratification** — impl comment claims "chat2.md fix" | PR-D: hybrid recommended `repeat(auto-fill, minmax(280px, 1fr))` |
| T-2 | **P1** | PlayerTypeCard JSX uses inline `style={{display:flex}}` not `className="row"`; F-LEAD-4's CSS port won't fire on impl. **Cross-cutting: must land WITH F-LEAD-4** | JSX class-application drift | PR-D + PR-B coupling: change to `className="row"`, port CSS |
| T-3 | P3 | `.display` class missing from impl card heading; inline omits `letter-spacing: -0.01em` from `.display` utility | Off-by-one letter-spacing | PR-D: replace inline with `className="display"` |

### 4.5 Batch B — Settings (ST-1..ST-4)

All four are P3 with the "no-canonical-reference" tag (canonical is mock-only; design canvas can't render interactive controls).

| ID | Severity | Title | Disposition | Recommendation |
|---|---|---|---|---|
| ST-1 | P3 | `version` KV row addition in Connection panel (impl adds; canonical lacks) | No-canonical-reference | PR-G: ratify with design owner |
| ST-2 | P3 | Appearance panel: live editing controls (impl) vs static KVs (canonical). **Recommend keep impl, update canonical** — Settings should be editable | No-canonical-reference; impl interprets intent correctly | PR-G: keep impl, update canonical mock |
| ST-3 | P3 | `metronome` KV missing in impl (canonical mock has it as `metronome = on`) | No-canonical-reference | PR-G: design-owner decides if metronome is real |
| ST-4 | P3 | Profile / Notifications panels are mock-only stubs — graceful-degrade | Wire-pending | Informational |

---

## 5. Severity summary

Counts regenerated directly from §4 catalog enumeration. Each `F-LEAD-N`,
`F-A-N`, `L-N`, `S-N`, `H-N`, `T-N`, `ST-N` row in §4 = one finding (some
findings encompass multiple sub-deltas, e.g. L-4 covers three CSS
property deltas in the same rule — these stay as one finding).

| Severity | Lead | Batch A | Batch B | Total |
|---|---|---|---|---|
| **P1** | 4 | 2 | 4 | **10** |
| **P2** | 0 | 3 | 4 | **7** |
| **P3** | 6 | 2 | 12 | **20** |
| **Total** | 10 | 7 | 20 | **37** |

**Batch A breakdown** (F-A-2 was retiered from P2 to P1 during consolidation per the rubric's "port drift = auto-P1" rule, then §5 was updated to match):
- P1: F-A-1, F-A-2 (2)
- P2: F-A-3, F-A-4, F-A-6 (3)
- P3: F-A-5, F-A-7 (2)

**Batch B breakdown**:
- P1: L-2, L-3, T-1, T-2 (4)
- P2: L-4, L-5, L-6, L-7 (4)
- P3: L-1, L-8, L-9, S-1, H-1, H-2, H-3, T-3, ST-1, ST-2, ST-3, ST-4 (12)

**Disposition breakdown** (orthogonal to severity):
- 13 findings are **port drift** (inside the 144-line zone): F-LEAD-1, F-LEAD-2, F-LEAD-3, F-LEAD-4 (4) + F-A-2 (1) + L-2..L-9 (8)
- ~4 findings are **deferred pending PR-7** (safe-write endpoints): L-1, S-1, plus mirrors in CreateEnsemble/Schedules/Settings Disband-all (mirrors aren't separately catalogued; counted as ~4)
- 1 finding is **deferred pending Radix**: F-A-1
- 4 findings are **no-canonical-reference** (Settings ratification): ST-1..ST-4
- 2 findings need **design-owner decisions**: T-1 (column rule), ST-2 (live controls — overlaps with no-canonical-reference)
- The remainder (~15) are JSX/CSS micro-fixes shippable now (some overlap; e.g. T-1 is both port-drift and design-owner-decision)

---

## 6. Headline findings — what to fix first

1. **F-LEAD-1 — components.css LAST-SYNC stale**: 144 lines of canonical drift since PR #340. Partial port. The headline architectural finding; almost every P1 in the audit is downstream of this. **PR-B** is the single most impactful fix.

2. **F-A-1 — PlayerDetail slide-out drawer not centered sheet**: Major UX shape divergence on desktop+tablet. Internal grid is correct; outer frame substitutes a slide-out drawer for a centered modal. Documented by ResponsivePanel.tsx as Radix-substitute, so deferring is defensible — but the audit must surface it.

3. **L-2 + L-3 — phone `.table` card-heading + button-row missing**: Affects every table-bearing screen on phone (Loadouts, Schedules, Hosts). Card-heading affordance disappears; buttons may overflow. **Ship-blocking for any phone-targeted demo.**

4. **T-1 + T-2 — PlayerTypes column rule + JSX inline-flex**: Cross-cutting CSS+JSX interaction. Even with F-LEAD-4's CSS port, the canonical phone-collide-prevention rules don't select the impl JSX. **Must land together.** T-1 needs design-owner decision before PR.

5. **F-LEAD-3 — `.ensemble-row .er-initial` missing on tablet sidebar**: Sidebar collapsed-state visual is incorrect on tablet. Note: canonical references undeclared `--surface-1/2/--text-1` in this block — the impl will need to substitute these with declared tokens when porting (canonical-side bug; F-LEAD-7).

---

## 7. Cluster proposal — fix scoping

Seven PRs (six active + one deferred). Independence noted per cluster.

### PR-A — Phone `.table` collapse parity

**Findings**: L-2, L-3, L-4, L-5, L-6, L-7, L-8, L-9 (+ F-LEAD-9 corroboration).
**Severity envelope**: 2 × P1 + 5 × P2 + 2 × P3.
**Files**: `dashboard/src/styles/components.css` (replace lines 1417-1452 with canonical 1582-1642 verbatim).
**Risk**: low — the canonical block is self-contained in `(max-width: 520px) @container artboard`. Existing `data-label` cells continue to work.
**Touch**: ~60 CSS lines replaced.
**Independence**: standalone; can ship ahead of PR-B.
**Ship priority**: **highest** — ship-blocking for phone-targeted demos.

### PR-B — components.css 144-line port re-sync

**Findings**: F-LEAD-1 (root), F-LEAD-2, F-LEAD-3 (with F-LEAD-7 substitution), F-LEAD-4 (paired with PR-D's T-2), F-A-2 (page-title 20px on phone).
**Severity envelope**: 4 × P1 (some shared with PR-D).
**Files**:
- `dashboard/src/styles/components.css` — apply the 144-line canonical diff.
- `dashboard/src/components/Sidebar.tsx` — render `.er-initial` element for F-LEAD-3 to take effect.
- Substitute undeclared `--surface-1`, `--surface-2`, `--text-1` with declared `--bg-2`, `--bg-1`, `--text` when porting the er-initial block (per F-LEAD-7).
**Risk**: medium — touches sidebar JSX in addition to CSS. Visual regression at tablet sidebar should be verified via screenshot diff.
**Touch**: ~150 lines CSS + ~15 lines JSX in Sidebar.tsx.
**Independence**: largely standalone; PR-D's T-2 must land in the same release for the F-LEAD-4 portion to actually take effect on PlayerTypes.

### PR-C — PlayerDetail sheet frame

**Findings**: F-A-1, F-LEAD-2.
**Severity envelope**: 1 × P1 (F-A-1) + 1 × P1 (F-LEAD-2 follow-up after F-A-1 fix).
**Files**: `dashboard/src/components/ResponsivePanel.tsx`, `dashboard/src/screens/PlayerDetail.tsx`.
**Risk**: medium — depends on Radix decision.
**Decision needed**: either (a) class the ResponsivePanel root with `.sheet.player-sheet` on desktop+tablet (matches canonical, removes the slide-out shape), or (b) accept the divergence and move to a "deferred / known divergence" register pending Radix.
**Recommendation**: (a) — class-up now. The Radix substitution is a separate concern; the visual shape can match canonical without Radix being shipped.
**Touch**: ~30 lines across two files.

### PR-D — PlayerTypes column rule + JSX

**Findings**: T-1, T-2, T-3, F-LEAD-4 (cross-cutting with PR-B).
**Severity envelope**: 2 × P1 + 1 × P3.
**Files**: `dashboard/src/styles/components.css` (revise `.types-grid` rule + port `.types-grid > .panel > .row` rules), `dashboard/src/screens/PlayerTypes.tsx` (change inline-flex to `className="row"`, replace inline display style with `className="display"`).
**Risk**: medium — T-1 needs design-owner ratification before merge.
**Decision needed**: T-1 column rule. Canonical `1fr 1fr` (2 wide cards) vs impl `auto-fill / minmax(155px, 175px)` (5–6 narrow). Recommend hybrid `repeat(auto-fill, minmax(280px, 1fr))`.
**Coupling**: must coordinate with PR-B's F-LEAD-4 port (the CSS rules need both ports to take effect).
**Touch**: ~10 CSS lines + ~15 JSX lines.

### PR-E — JSX class-application micro-fixes

**Findings**: F-A-3, F-A-4, F-A-5, F-A-6, F-A-7, H-1.
**Severity envelope**: 3 × P2 + 3 × P3.
**Files**: `dashboard/src/screens/Workspace.tsx` (F-A-3, F-A-7), `dashboard/src/components/wizard/PickerList.tsx` (F-A-4, F-A-5), `dashboard/src/screens/Recruit.tsx` (F-A-6), `dashboard/src/screens/Hosts.tsx` (H-1).
**Risk**: low — independent micro-fixes; one commit per finding for clean review.
**Touch**: ~30 lines across 5 files.

### PR-F — Token hygiene

**Findings**: F-LEAD-5 (hex-case), F-LEAD-6 (preserve `--shadow-1`).
**Severity envelope**: 2 × P3.
**Files**: `dashboard/src/styles/tokens.css` (UPPERCASE all hex values).
**Risk**: zero.
**Touch**: ~20 lines (case-only).

### PR-G — Settings ratification

**Findings**: ST-1, ST-2, ST-3, ST-4 (all "no-canonical-reference").
**Severity envelope**: 4 × P3.
**Files**: `dashboard/src/screens/Settings.tsx` and/or canonical `screens.jsx:Settings()` (depending on ratification direction).
**Risk**: low — content/feature decisions, not styling drift.
**Decision needed**: live-controls-vs-static (ST-2 primary). Recommendation: **keep impl as live controls; update canonical mock to match**.
**Touch**: depends on direction.

### Deferred — PR-7 follow-up (wire-pending Btn variants)

**Findings**: L-1, S-1, plus same pattern across CreateEnsemble (Save row buttons), Settings (Disband all).
**Severity envelope**: ~6 × P3 (intentional degradation).
**Status**: not yet shippable — wire-pending on safe-write daemon endpoints.
**Touch**: post-PR-7.

### Cosmetic / out-of-scope

- F-LEAD-8 (canonical `dashboard.html` legacy fonts) — already correct on impl side per #389 PR-0; no action needed.
- F-LEAD-10 (DS spec card claims "2 radii"; canonical uses 12) — doc-only contradiction; canonical-side update if/when design owner is available.

---

## 8. Open questions for the user / design owner

1. **F-A-1 disposition** (PR-C): class-up the PlayerDetail root to `.sheet.player-sheet` now, or defer pending Radix integration? Audit recommends class-up-now (visual shape can match without Radix).

2. **T-1 column rule** (PR-D): canonical `1fr 1fr` (2 wide) vs impl `auto-fill / minmax(155px, 175px)` (narrow grid) vs hybrid `auto-fill / minmax(280px, 1fr)` (recommended)? Needs ratification before PR-D can merge.

3. **ST-2 Settings live controls** (PR-G): keep impl as live controls (recommended), or revert to canonical's static-KV mock? Affects design-canvas update direction.

4. **F-LEAD-7 token substitution** (within PR-B): the canonical `.er-initial` block references undeclared `--surface-1`, `--surface-2`, `--text-1`. Substitute with declared `--bg-2`, `--bg-1`, `--text` when porting? Or open an issue on the design-handoff repo for canonical-side declaration first?

5. **F-LEAD-1 LAST-SYNC re-sync cadence**: should we instrument the re-sync procedure with a CI check (e.g., assertion that LAST-SYNC commit is reachable from `main`), or rely on the documented procedure? Procedural drift is the failure mode here.

---

## 9. Appendix

### 9.1 Viewport-to-artboard mapping

| Viewport | Sidebar width | Artboard width | Container regime |
|---|---|---|---|
| 1440 (Desktop) | 244px | 1196px | none firing |
| 1180 (Laptop) | 220px (after 1200px CQ) | 960px | `(max-width: 1200px)` |
| 834 (Tablet) | 64px (after 900px CQ) | 770px | `(max-width: 1200px)` + `(max-width: 900px)` |
| 390 (Phone) | 0 (sidebar hidden) | 390px | all three (520, 900, 1200) |

### 9.2 Working artifacts (deleted before PR)

- `_canonical-tokens.md` — canonical ground truth (sub-agent fork output)
- `_impl-tokens.md` — impl-side token extraction
- `_rubric-and-brief.md` — locked rubric + recruit batches
- `_findings-a.md` — Batch A raw findings
- `_findings-b.md` — Batch B raw findings

These were ephemeral inputs into this consolidated audit doc and are deleted before PR. The findings catalog in §4 captures all signal from each.

### 9.3 Related docs

- `docs/design/dashboard-audit-389.md` — original audit
- `docs/design/dashboard-audit-389-followup-rev3.md` — structural rev3 cert
- `dashboard/src/styles/components.css` — file header + re-sync procedure
- `docs/WIRE-PROTOCOL.md` — wire-protocol stability boundary (not affected by this audit)

---

**Sign-off**: tempo-architect, 2026-04-28. Recruits tempo-pixel-a + tempo-pixel-b stood down clean. Total wall-clock: ~2hr from kickoff (50% under projection due to static-audit pivot). Ready for user review and PR routing.
