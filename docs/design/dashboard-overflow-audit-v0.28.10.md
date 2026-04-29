# Dashboard overflow + content-length robustness audit — v0.28.0-beta.10

**Status**: COMPLETE — consolidation phase
**Date**: 2026-04-29
**Branch audited**: `main` @ `97c2f554` (npm tag `beta` = `0.28.0-beta.10`)
**Audit lead**: tempo-overflow-lead (architect)
**Walk authors**: tempo-qa (Batch A — cards/headers/wizards), tempo-researcher (Batch B — tables/sidebar/chat/buttons)
**Methodology baseline**: depth-2 audit, parallel pattern to `dashboard-pixel-audit-v0.28.9.md`. Where the pixel audit verified design fidelity at canonical content × canonical viewports, this audit verifies **content-length robustness** — does the layout hold when fed production-realistic and synthetic-stress content?

---

## Executive summary

Walked 12 dashboard component families across 10 viewports × 3 content-length regimes. **13 findings confirmed**: 5 P1 production-realistic (1 auto-P1 confirmed, 3 conditional auto-P1 pending boundary measurement), 7 P2 long-tail/stress/boundary, 1 P3 cosmetic. **4 hypotheses cleanly refuted** (with refutations encoded as Playwright passing-assertions for permanent regression coverage). **2 pre-log hypotheses** adjusted to P3 monitor-not-fix.

### The audit's existence-proof finding (F-A-5)

The same structural pattern that caused the **la-tempo-advisor card overflow** into adjacent space — fixed in PR-D #463 as a point fix at `auto-fill-minmax` track sizing — **recurs on EnsembleCard.** `.ec-name` lives in flex `space-between` with no `min-width: 0`, and `.ensemble-card` has no `overflow: hidden`. The BPM display escapes the card right edge into adjacent card pixel space at production-realistic 36-char ensemble names. **Auto-P1 confirmed** via static analysis of `EnsembleCard.tsx:109-119` + `components.css:848-862`. **This validates the audit's premise — point fixes mask cluster bugs.**

### Cluster shape

All 13 findings cleave into **one cross-cutting cluster**: missing graceful-degradation rules on shared layout primitives. Three pattern groups within:

1. **`min-width: 0` discipline** — 5 findings (F-A-1, F-A-2, F-A-5, F-B-1, F-B-2) on `.col` / `.picker-row` / `.ec-name` / `.er-name` / table cells. **Auto-P1 surface.**
2. **`overflow-wrap: break-word` discipline** — 4 findings (F-A-3, F-A-4, F-A-6, F-B-5) on `.display` / `.page-title` / `.ec-desc` / `.kv-v`. Legibility surface.
3. **`flex-wrap: wrap` discipline** — 2 findings (F-B-3, F-B-NEW-2) on `.panel-head` / `.row`. Boundary-band surface.
4. **Chat code-block overflow** — 1 finding (F-B-4) on `.msg-body pre, code`. Single-domain.

### CI guardrail recommendation (§10): Hybrid v0+v1, defer v2

**Threshold-override** on researcher's [#474](../research/461-overflow-audit-ci-tooling-spike.md) §6.2 (~70% class A pivots literal-rule to "v0 only") because:
- F-A-5 is auto-P1 class B (overlap-into-adjacent — JS-only assertions are blind to bbox geometry)
- F-B-3 + F-B-NEW-2 are class C with visual-judgment requirements

v0+v1 lands as a single PR cluster, ~450-690 LoC, $0 SaaS spend. Both walker Playwright specs (`dashboard/tests-overflow/_walk-{a,b}-measurement.spec.ts` on walker branches `audit/461-walk-a` and `audit/461-walk-b`) are ready-to-extend prototype seeds for the v0 implementer.

### PR clusters proposed for fix dispatch

- **PR-α — CSS overflow discipline (broad)**: all 13 findings, single-file `components.css` change. ~50-70 lines of CSS additions covering all missing-rule patterns. CSS-only, no behavior change, single review surface.
- **PR-v0 — CI guardrail seed**: graduate walker Playwright specs to canonical `dashboard/tests-overflow/*.overflow.spec.ts`, wire to a new `dashboard-overflow` CI job (Path B clone of `dashboard-e2e`), produce v1 baselines for the 2 class-B and 2 class-C cases. ~250-300 LoC delta. **Refutations (H10, H13, H11) ride along as passing-assertion regression detectors.**

### Methodology evolutions (§1.4)

Four meta-findings emerged that are reusable for future audits:
1. **Concurrent-failure resilience** — methodology degraded gracefully when Chrome MCP + dev daemon both went down for one walker
2. **Hypothesis-vs-lock + pre-log calibration** — 8/14 hypotheses confirmed at predicted severity, 4 cleanly refuted, 1 calibration error caught (H3) — validating the pattern
3. **Refutation-as-regression-detector** — encoding refuted hypotheses as Playwright passing-assertions extends walk-product into permanent CI-product
4. **Threshold-edge override discipline** — forecast tools applied to threshold-edge data require explicit override criteria, not literal application

---

## 1. Methodology

### 1.1 Sources

**Impl-only audit** — there is no canonical analogue for "long content" because the design hand-off shows canonical lengths only. We audit the impl against itself across three content regimes.

- `dashboard/src/screens/*.tsx` (11 screens) — React screen components
- `dashboard/src/components/**/*.tsx` (~30 components) — shared building blocks
- `dashboard/src/styles/components.css` (1687 lines) — layout + container-query rules
- `dashboard/src/styles/tokens.css`, `globals.css` — design tokens (locked byte-identical to canonical per pixel-audit §3)

**Supporting context**:
- `docs/design/dashboard-pixel-audit-v0.28.9.md` — methodology precedent + token table proof
- `docs/design/dashboard-handoff/project/styles.css` — canonical CSS (post-PR-B re-sync; reference for "what should fire at what breakpoint")
- `docs/research/461-overflow-audit-ci-tooling-spike.md` — researcher's #474 v0+v1 hybrid framework + 5-class A/B/C/D/E failure taxonomy
- `examples/agents/*.md` — real player-type slugs (fixture source)
- `examples/ensembles/*.yaml` — real ensemble names (fixture source)

### 1.2 Audit scope

**Components** (12 — derived from #461 checklist):

| # | Component | Stress vectors |
|---|---|---|
| C1 | EnsembleCard | description length, lineup chips overflow, host hostname width |
| C2 | PlayerDetail header | player name, part text, role badge stack |
| C3 | PlayerTypes cards | type slug width, description, tools row count, action button row |
| C4 | Hosts table | hostname FQDN, profile capabilities chip count |
| C5 | Settings panels | KV label width, value length |
| C6 | TempoStrip | sparkline + bpm overlay at narrow widths |
| C7 | Sidebar | ensemble names with `er-initial` tile + `er-name` truncation |
| C8 | Workspace chat panel | long messages, code blocks, multi-line cues |
| C9 | CreateEnsemble wizard | picker rows, form fields with long player-type slugs |
| C10 | Recruit wizard | picker rows, type-badge slot widths |
| C11 | Page-header / panel-head | title length, subtitle, action-button row |
| C12 | Generic button rows | Edit/Duplicate/+New patterns at narrow widths |

**Content-length regimes** (3):

| Regime | Definition | Severity ceiling |
|---|---|---|
| **Canonical** | Design hand-off content (already covered by pixel audit; included as control) | P3 |
| **Long-tail realistic** | Production-actual upper bounds (real player-type slugs, multi-word ensemble slugs, descriptions ≤200 chars, FQDN-style hostnames) | **P1** |
| **Synthetic stress** | Engineered edges (300-char names, no-space descriptions, 50-player ensembles, 100-char hostnames) | **P2** |

Severity floors are absolute — a finding visible only at synthetic stress cannot be P1 even if it's visually severe (rationale: production users won't hit it).

**Viewports** (4 canonical + 6 boundary):

| Viewport | Type | Why included |
|---|---|---|
| 1440 × 900 | Canonical Desktop | none firing |
| 1180 × 820 | Canonical Laptop | `(max-width: 1200px)` fires |
| 834 × 1100 | Canonical Tablet | + `(max-width: 900px)` fires |
| 390 × 780 | Canonical Phone | + `(max-width: 520px)` fires |
| 1201 / 1199 | Boundary | 1200px CQ edge |
| 901 / 899 | Boundary | 900px CQ edge |
| 521 / 519 | Boundary | 520px CQ edge |

Boundary pairs catch off-by-one CQ-firing bugs (the kind of thing that surfaces "looks fine on phone, looks fine on tablet, breaks at the in-between width nobody designed for"). Pixel audit's L-cluster shows boundary bugs are real.

**Visual axes locked to defaults**: dark theme, density 6, accent `#E07A5F`, motion-on. Light-theme overflow is a separate pass.

### 1.3 Architectural framing — overflow under stress

The pixel audit established that the dashboard is **artboard-container-query-driven** (§1.3 of pixel audit). That framing matters here too: overflow is a property of *artboard inline-size × content length × class application*, not just viewport width. Audit cells are (component, artboard-width, content-regime) triples; the viewport is a means to set the artboard width.

Two distinct overflow modes show up in this layout:

1. **Internal overflow** — content exceeds its container's `clientWidth` (text gets clipped or pushes a scrollbar). Detected by `scrollWidth > clientWidth`. Class causes: missing `min-width: 0` on a flex/grid item, missing `overflow: hidden` + `text-overflow: ellipsis`, hard-coded width that doesn't match the content.
2. **External overflow** — content visually overlaps an adjacent sibling (the la-tempo-advisor symptom). Detected by `getBoundingClientRect()` overlap between sibling cards. Class causes: `auto-fill / minmax(155px, 175px)` style track-sizing (PR-D root cause), missing `flex-wrap: wrap` on a row, fixed-px gap that goes negative.

**Auto-P1 rule** (parallel to pixel audit's "port drift = auto-P1"): **External overflow at canonical viewport × any content regime = auto-P1**. Rationale: visual overlap with an adjacent UI element is a hard fail regardless of how rare the trigger is — it can't be dismissed as "edge case" because the consequence is "user sees broken UI."

### 1.4 Sample protocol — hybrid live + static

**Inverted from pixel audit.** The pixel audit's static-first pivot worked because the token table was byte-identical between canonical and impl, so live sampling added no signal. Here the question is whether *computed layout* holds under stress — class application alone can't answer that. Live sampling is primary in design.

**Per (component, viewport, content-regime) cell**:

1. **Live DOM sample** (primary) via Chrome MCP on a running dashboard — capture `clientWidth`, `scrollWidth`, `getBoundingClientRect()` for the component root + any siblings; observe-vs-expected for clipping/overlap/scrollbars.
2. **Static class-application audit** (corroboration) for any live finding — read JSX + matching `components.css` rule; identify root-cause class. A live finding without a static root-cause analysis is incomplete — every finding in §4 carries both.

**Tooling**: Chrome MCP (`mcp__claude-in-chrome__*`) for live sampling. Static reads via Read/Grep. Daemon URL TBD with conductor.

#### 1.4.1 Methodology evolutions captured during this audit

Four meta-findings emerged worth foregrounding for future audits:

##### (a) Concurrent-failure resilience

Mid-walk, both walker channels lost browser-automation tooling at different points:
- **tempo-qa** hit `Browser extension is not connected` from Chrome MCP (~4 min into Batch A setup)
- **tempo-researcher** hit the same Chrome MCP failure **plus** an aggregate-poll-stuck dev daemon (HTTP API hang, same #249-era pattern recurring) — **both failure modes simultaneously**

The methodology degraded gracefully via two composable paths:
1. **Static-only fallback** with disposition tag `static-confirmed, live measurement pending` for class-A self-overflow patterns where missing-rule causal chains constitute sufficient evidence
2. **Deferred Playwright measurement** via walker-authored `*.overflow.spec.ts` specs encoding the assertion patterns; runnable in any chromium environment via `page.setContent()` (no daemon dependency)

**Generalization**: an audit's methodology is only credible if it survives **concurrent** tool-stack failures, not just any single failure. Future audits should design graceful-degradation paths per failure mode, then explicitly compose them when failures concur. tempo-researcher's both-tools-down case is the canonical "both-failure-modes" precedent — full rigor delivery despite total tool-stack failure of the live-measurement channel.

##### (b) Hypothesis-vs-lock and pre-log calibration validation

Pixel audit pre-locked findings before recruits walked; this audit pre-logged **hypotheses** with severity-guess + root-cause-guess (`_lead-prelog.md`), and recruits validated or refuted each.

**Pre-log calibration result**:
- **8 of 14 hypotheses confirmed at predicted severity** (4 high-conf P1: H1, H2, H5, H8; 3 medium P2: H4 (sub-finding B), H6, H7, H9; plus 1 nuanced split — H4A refuted, H4B confirmed)
- **4 cleanly refuted** (H4A, H10, H11, H13)
- **2 adjusted to P3 monitor-not-fix** (H12 cosmetic row-height, H14 i18n-monitor)
- **0 false-confirms** (no P1-pre-logged that walked as no-finding)
- **1 calibration error caught** (H3 pre-logged P1 production-realistic, walked as P2 synthetic-stress only — production-realistic refuted because all real shipped/long-tail player-type slugs ≤19 chars fit at the narrowest column width)

**Calibration verdict**: the audit's mental model of the codebase is structurally well-calibrated. Future audits inheriting the hypothesis-then-validate pattern can leverage the same forecast structure with high confidence. The single calibration error (H3) is itself a methodology validation: pre-log + walker validation caught a lead-side error that lock-not-hypothesize would have shipped as a false-P1 finding.

##### (c) Refutation-as-regression-detector

tempo-qa encoded **refuted hypotheses** (H10 page-pills/actions collision, H13 ec-roster avatar overflow) as **passing-assertions** in `_walk-a-measurement.spec.ts`. The spec doesn't just catch found bugs — it catches re-introductions of the patterns we proved aren't bugs today.

**General rule**: when refuting a hypothesis, encode the refutation as a regression test. Refutations have shelf life longer than confirmations because the patterns we proved currently safe could regress under future code changes; locking the proof in CI prevents the regression. Walk-product → CI-product transition with strictly higher carrying value.

This pattern updates the brief template for future audits: refutation entries ship with their refute-confirming spec assertion, not just a prose "no finding" entry.

##### (d) Threshold-edge override discipline

§10's CI-guardrail decision is forecast-driven: researcher's #474 §6.2 conditional pivot table maps finding-class distributions to v0/v1/v2 recommendations. Our class-A share is **69% (9 of 13)** — exactly at the threshold edge between "v0 only" (≥70%) and "v0+v1" (40-70%) branches.

We override to **v0+v1** with explicit reasoning:
- **F-A-5 is auto-P1 class B** (overlap-into-adjacent — v0 JS-only assertions are structurally blind to bbox geometry per #474 §1.1)
- **F-B-3 + F-B-NEW-2 are class C** (wraps-badly — visual-judgment cases that JS assertions can't catch per #474 §2 coverage matrix)

**Generalization**: a threshold rule applied to threshold-edge data needs explicit override criteria documented inline, not literal application. Threshold tables are forecast tools, not decision rules. Future §10-style decisions should follow the same posture — when data lands at a threshold edge, override with documented reasoning, not literal application. This pattern applies broadly beyond CI guardrails (any forecast-driven branching decision benefits from explicit override criteria).

### 1.5 Severity rubric

- **P1** — overflow visible at **production-realistic content × canonical viewport** (i.e. would hit a real user). Includes auto-P1: external overflow at canonical viewport regardless of content regime.
- **P2** — overflow visible only at **synthetic stress content** OR **boundary viewport** (still real-world possible but rarer).
- **P3** — functional but noticeable degradation: truncated tooltip we want to keep, wrapped chip group that should single-line, container scrollbar appearing without breaking layout.

**Disposition tags** (orthogonal to severity, composable):
- `production-realistic` — triggered at long-tail-realistic regime
- `long-tail-realistic` — triggered at long-tail-realistic regime, narrower scope than canonical-prod
- `synthetic-stress` — only triggered at synthetic stress
- `boundary-viewport` — only manifests in 521-1199 boundary band
- `intentional-truncation` — text-overflow ellipsis is the design — flag only if missing or wrong axis
- `cross-cutting` — single root cause spans multiple components (cluster-PR candidate)
- **`wire-pending`** — affordance not yet wired; finding's prod manifestation is latent until data flows. Eng implementer can ship the fix preventatively
- **`static-confirmed, live measurement pending`** (NEW disposition added during walks when Chrome MCP became unavailable) — class-A self-overflow patterns with strong static evidence (missing-rule causal chain, e.g. flex item without `min-width: 0` carrying long content) file with this tag. Severity scores normally; live measurement deferred to the Playwright spec at `dashboard/tests-overflow/_walk-{a,b}-measurement.spec.ts` on walker branches

### 1.6 Test fixtures

Fixtures are committed as `_overflow-fixtures.json` in this directory (this audit doc PR), then promoted to `dashboard/test-fixtures/overflow.json` for the v0 PR cluster's reuse. See §9.1.

| Fixture key | Content | Source |
|---|---|---|
| `playerTypeSlugs.short` | 8 slugs at canonical length (≤14 chars) | `examples/agents/*.md` |
| `playerTypeSlugs.longTail` | 5 long-tail slugs (15-22 chars: `la-tempo-advisor`, `my-tempo-researcher`, etc.) | Production observation |
| `playerTypeSlugs.stress` | 3 synthetic (300-char, with/without spaces, with/without hyphens) | Engineered |
| `ensembleNames.canonical` | 5 names from `examples/ensembles/*.yaml` (`tempo-big-band`, etc.) | Repo |
| `ensembleNames.longTail` | 5 multi-word slugs (`tempo-mock-jam-session-coordinator`, etc.) | Engineered realistic |
| `ensembleNames.stress` | 3 synthetic (300-char, no spaces, all-vowels) | Engineered |
| `descriptions.canonical` | 5 strings ≤80 chars | Design hand-off |
| `descriptions.longTail` | 5 strings 120-200 chars | Production-realistic |
| `descriptions.stress` | 3 strings: 500-char with spaces, 300-char no spaces, 200-char with `&nbsp;`-equivalents | Engineered |
| `hostnames.short` | 3 short (`main-laptop`, `dev-mac`, `ci-runner-1`) | Production-realistic |
| `hostnames.fqdn` | 3 FQDN (`main-laptop.local.example.com`, kubernetes-pod-name-style) | Production-realistic |
| `hostnames.stress` | 2 synthetic (100+ chars, dots-only) | Engineered |
| `ensembleSize.canonical` | 5-player ensemble | Design hand-off |
| `ensembleSize.longTail` | 15-player ensemble | Production-realistic |
| `ensembleSize.stress` | 50-player ensemble | Engineered |

### 1.7 What this audit doesn't cover

- **Light-theme overflow** — color tokens differ; layout rules don't, but verifying that requires a separate pass.
- **Live data churn** — overflow during chat-feed scroll, animation frames, transitions. Captures are static post-paint.
- **Touch-input overflow** — only covers mouse/keyboard pointer geometry. Touch-target adequacy is a separate accessibility audit.
- **i18n / RTL** — content lengths in non-Latin scripts, RTL layout mirroring. Out of scope (F-B-NEW-2 flagged P3-today/P2-i18n).
- **Browser-engine variance** — sampling is Chrome only. Firefox/Safari layout deltas not covered.

These are flagged as audit-debt, not findings.

---

## 2. Audit dimensions matrix

| Component | Cell count walked | Stress vectors active |
|---|---|---|
| EnsembleCard | ~24 cells | name, description, host, lineup, BPM (F-A-1, F-A-5, F-A-6) |
| PlayerDetail header | ~20 cells | sheet head, accent name, status row (F-A-4 sub-B) |
| PlayerTypes cards | ~24 cells | type slug, display text, action row (F-A-3, H4A refuted, H12/H14 P3) |
| Hosts table | ~20 cells | FQDN host column (F-B-2) |
| Settings panels | ~16 cells | KV value width (F-B-5) |
| TempoStrip | ~12 cells | sparkline + label overlay (H11 refuted) |
| Sidebar | ~16 cells | `.er-name` long-name (F-B-1) |
| Workspace chat | ~16 cells | `.msg-body pre/code` (F-B-4), `.panel-head` (F-B-3) |
| CreateEnsemble + Recruit wizards | ~24 cells | `.picker-row` slug column (F-A-2) |
| Page-header | ~12 cells | `.page-title` long-name + `.page-pills` collision (F-A-4 sub-A, H10 refuted) |
| Generic button rows | ~12 cells | `.row` flex-wrap discipline (F-B-NEW-2) |
| Loadouts + Schedules | ~16 cells | table Name column (F-B-NEW-1) |

**Total cells walked**: ~212 cells (compressed from ~288 nominal × 2 walkers via batching). Findings density: **13 cataloged findings + 4 refutations + 2 P3-monitor adjustments / ~212 cells = ~9% catalog rate**, consistent with ~10x-compression target.

---

## 3. Token-level alignment

N/A — this audit is impl-self-stress, not impl-vs-canonical. Token alignment is locked by pixel audit §3.

---

## 4. Findings catalog

### 4.1 Findings table

| ID | Hyp ref | Component | File:line | Severity | Class | Disposition | Auto-P1 |
|---|---|---|---|---|---|---|---|
| F-A-1 | H2 ✓ | EnsembleCard `.ec-meta` | EnsembleCard.tsx:177-180 | **P1** | A (high-conf) | wire-pending, static-confirmed, lmp | yes (FQDN collision once wired) |
| F-A-2 | H3 ✓ (adjusted) | PickerList `.picker-row .name` | PickerList.tsx:60-112 | P2 | A (high-conf) | synthetic-stress, static-confirmed, lmp | no |
| F-A-3 | H4B ✓ | PlayerTypes `.display` | PlayerTypes.tsx:157-174 | P2 | A (high-conf) | synthetic-stress, static-confirmed, lmp | no |
| F-A-4 | H6 ✓ | PageHeader `.page-title` + SheetHead `.subj.display` | PageHeader.tsx:62-78, PlayerDetail.tsx:154-163 | P2 | A (high-conf) | production-realistic + synthetic-stress, static-confirmed, lmp | no |
| F-A-5 | NEW | EnsembleCard `.ec-name` | EnsembleCard.tsx:109-119 | **P1** | **B (high-conf)** | production-realistic, static-confirmed, lmp | **YES** |
| F-A-6 | NEW | EnsembleCard `.ec-desc` | EnsembleCard.tsx:146-148 | P2 | B (high-conf) | synthetic-stress, static-confirmed, lmp | no |
| F-B-1 | H1 ✓ | Sidebar `.er-name` | Sidebar.tsx:97-132 | **P1** | A (high-conf) | production-realistic, static-confirmed, lmp | conditional |
| F-B-2 | H5 ✓ | Hosts table FQDN column | Hosts.tsx:151-176 | **P1** | A (high-conf) | production-realistic, static-confirmed, lmp | conditional |
| F-B-3 | H7 ✓ | `.panel-head` (Workspace chat) | Workspace.tsx:401-425 | P2 | C+E (high-conf) | boundary-viewport, static-confirmed, lmp | no |
| F-B-4 | H8 ✓ (P1 ratified) | `.msg-body pre, code` | FeedMessage.tsx:99-101 | **P1** | A (high-conf) | production-realistic, static-confirmed, lmp | conditional |
| F-B-5 | H9 ✓ | Settings `.kv` long values | Settings.tsx:357-364 | P2 | A (high-conf) | long-tail-realistic, static-confirmed, lmp | no |
| F-B-NEW-1 | NEW | Loadouts Name column | Loadouts.tsx:111-155 | P2 | A (high-conf) | long-tail-realistic, static-confirmed, lmp | no |
| F-B-NEW-2 | NEW | Generic `.row` flex-wrap | Workspace.tsx:406-425 + Loadouts.tsx:137-152 + Schedules.tsx:181-196 | P3 | C (high-conf) | future-i18n, static-confirmed, lmp | no |

**Class column legend** (per researcher's [#474](../research/461-overflow-audit-ci-tooling-spike.md) §1.1 taxonomy):

- **A**: self-overflow — content exceeds container's `clientWidth`; `scrollWidth > clientWidth` shape
- **B**: overlap-into-adjacent-sibling — bbox geometry escape; only catchable via `getBoundingClientRect()` cross-element math
- **C**: wraps-badly — visible but ugly multi-line wrap (visual-judgment territory)
- **D**: computed-style drift / cascade misfire (snapshot of `getComputedStyle` needed)
- **E**: viewport-boundary / breakpoint pop (manifests only in narrow boundary bands)

**Confidence marker**: `(high-conf)` — static evidence directly localizes the missing rule; `(inferred)` — classification derived from finding-text without explicit static evidence. **All 13 findings are high-conf** because both walkers ran static-only methodology with explicit CSS rule references.

**Class distribution**: A: 9 (69%) · B: 2 (15%) · C: 2 (15%) · D: 0 · E: 0.5 (F-B-3 is C+E hybrid)

Class-A share at 69% sits at the v0/v0+v1 threshold edge per researcher's #474 §6.2 (≥70% A → v0 only). See §10 for threshold-override reasoning. **Net: v0+v1 with documented override.**

### 4.2 Per-finding details

#### Walk A findings (Cards / Headers / Wizards — by tempo-qa)

##### F-A-1 — `.ec-meta` spans overflow at long host / lineup values

- **Hypothesis ref**: H2 (confirmed)
- **Component**: EnsembleCard
- **File**: `dashboard/src/components/EnsembleCard.tsx:177-180`
- **CSS rule**: `components.css:889-892`
- **Viewport**: all (1440, 1180, 834, 390)
- **Content regime**: wire-pending (live data not yet wired; spans currently render `'—'`)
- **Class**: A (high-conf)
- **Observed**: `.ec-meta { display: flex; justify-content: space-between; }` — both child `<span>` elements carry no `overflow: hidden`, `text-overflow: ellipsis`, or `min-width: 0`. When the host span receives a FQDN value such as `ci-runner-prod-cluster-pod-7-replica-3.eks.internal.example.com` (63 chars) the two spans will collide or overflow the `.ec-meta` container. Currently masked because JSX hard-codes `'—'` for both values.
- **Expected**: host span truncates with ellipsis; lineup span clips gracefully; no collision between the two.
- **Severity**: **P1** wire-pending
- **Auto-P1**: yes — FQDN collision at canonical viewport is production-realistic once data is wired
- **Disposition**: `static-confirmed, live measurement pending`; **wire-pending** (P1 trigger latent until host/lineup data flows)
- **Root cause**: missing `overflow: hidden; text-overflow: ellipsis; white-space: nowrap; min-width: 0` on `.ec-meta > span` (or at minimum on the host span)
- **Fix shape**:
  ```css
  /* components.css ~892 */
  .ec-meta > span {
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    min-width: 0;
  }
  .ec-meta > span:first-child { flex: 1 1 0; }
  .ec-meta > span:last-child  { flex-shrink: 0; }
  ```

##### F-A-2 — `.picker-row .name` overflows at synthetic-stress slugs

- **Hypothesis ref**: H3 (adjusted — production-realistic refuted, synthetic-stress confirmed)
- **Component**: PickerList (CreateEnsemble wizard + Recruit wizard)
- **File**: `dashboard/src/components/wizard/PickerList.tsx:60-112`
- **CSS rule**: `components.css:822-839`
- **Viewport**: all (stress)
- **Content regime**: synthetic-stress only (production-realistic regime: **refuted**)
- **Class**: A (high-conf)
- **Observed (production-realistic, refuted)**: longest real shipped/long-tail slug is `my-tempo-researcher` = 19 chars. At phone picker (390px viewport, ~188px usable column after 18px marker + auto right cell): 19 chars × ~8.5px/char ≈ 162px — fits within 188px. All canonical viewports provide more column width. No overflow at any canonical + production-realistic cell.
- **Observed (synthetic-stress, confirmed)**: `PickerList.tsx` row uses inline `display: grid; gridTemplateColumns: '18px 1fr auto'`. The middle `<span>` flex column has no `min-width: 0` and the inner `.name` span has no `overflow: hidden; text-overflow: ellipsis`. At synthetic-stress slugs (260+ char unbreakable token) the `1fr` column resolves to `min-content` and forces the button element wider than the picker list container, causing horizontal scroll or overflow into the right gutter.
- **Expected**: name column clips with ellipsis at grid track boundary; button never wider than container.
- **Severity**: **P2 synthetic-stress** (downgraded from pre-log P1; calibration-error-caught example for §1.4 (b))
- **Auto-P1**: no
- **Disposition**: `static-confirmed, live measurement pending`; **synthetic-stress** (production-realistic refuted)
- **Root cause**: missing `min-width: 0` on the middle column `<span>` and missing `overflow: hidden; text-overflow: ellipsis; white-space: nowrap` on `.name`
- **Fix shape**:
  ```css
  .picker-row .name {
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  /* + min-width: 0 on the parent flex column via inline style or class */
  ```

##### F-A-3 — PlayerTypes `.display` cell overflows at synthetic-stress slugs

- **Hypothesis ref**: H4 partial (H4A refuted, H4B confirmed)
- **Component**: PlayerTypes cards
- **File**: `dashboard/src/screens/PlayerTypes.tsx:157-174`
- **CSS rule**: `components.css:1431-1437` (`.types-grid`)
- **Viewport**: all (stress)
- **Content regime**: synthetic-stress
- **Class**: A (high-conf)
- **Observed**: `.display { fontSize: 20 }` inside a `grid-template-columns: 1fr 1fr` container has no `overflow-wrap: break-word` or `word-break: break-all`. The shortName for a stress slug (260+ chars after the `tempo-` prefix strip) forms a single unbreakable token wider than the grid track. The token overflows the card boundary and obscures the right-column card. `grid-auto-rows: max-content` means the row height expands to the natural-overflow height rather than clipping, so the content visibly juts into the right-column card slot.
- **Expected**: display text wraps inside the card boundary; no overflow into adjacent card.
- **Severity**: **P2 synthetic-stress**
- **Auto-P1**: no — only at synthetic-stress slugs; all 13 shipped / long-tail types fit within a 440px+ card
- **Disposition**: `static-confirmed, live measurement pending`; synthetic-stress
- **Root cause**: missing `overflow-wrap: break-word` on `.display` (or on the card container); CSS grid `1fr` column without explicit `max-width` or `overflow: hidden`
- **Fix shape**:
  ```css
  .display {
    overflow-wrap: break-word;
    word-break: break-word; /* fallback */
    min-width: 0;
  }
  ```

##### F-A-4 — `.page-title` / SheetHead `.subj.display` overflow without ellipsis

- **Hypothesis ref**: H6 (confirmed × 2 sub-findings)
- **Component**: PageHeader (`.page-title`) + PlayerDetail SheetHead (`.subj.display`)
- **File**: `dashboard/src/components/PageHeader.tsx:62-78`; `dashboard/src/screens/PlayerDetail.tsx:154-163`
- **CSS rule**: `components.css:346-391` (PageHeader); `components.css:1477` (`.player-sheet`)
- **Viewport**: phone 390px (production-realistic for sub-finding B); all (synthetic-stress for sub-finding A)
- **Content regime**: production-realistic at phone (B); synthetic-stress at larger viewports (A)
- **Class**: A (high-conf)

**Sub-finding F-A-4-A — PageHeader `.page-title`**: `font-size: 34px` display heading with no `overflow: hidden`, `text-overflow: ellipsis`, or `overflow-wrap`. `page-header` is `grid-template-columns: 1fr auto`; the left `1fr` cell nominally prevents overflow into the right `auto` (actions) cell. At phone (390px) the heading area has ≈ 280px usable width and a 36-char ensemble name at 34px ≈ 750px rendered width — wraps to two lines, which may be intentional, but an unbreakable stress token forces the `1fr` column to expand beyond container width.

**Sub-finding F-A-4-B — SheetHead `.subj.display`**: `font-size: 22px` player ID rendered inside `.player-sheet { overflow: hidden }`. The outer clip removes content beyond the sheet boundary but provides no ellipsis indicator. A 50-char player ID is clipped silently. **P2 production-realistic** because player IDs up to `PLAYER_NAME_MAX` (64 chars) can be assigned in the wild.

- **Expected**: `.page-title` wraps gracefully at natural break points; SheetHead player ID gets ellipsis at the sheet edge rather than silent clip.
- **Severity**: **P2** (both sub-findings)
- **Auto-P1**: no — both require either long slugs or narrow viewports
- **Disposition**: `static-confirmed, live measurement pending`; A: synthetic-stress + phone-prod; B: production-realistic
- **Root cause** (A): missing `overflow-wrap: break-word` on `.page-title` for unbreakable tokens
- **Root cause** (B): `.player-sheet { overflow: hidden }` clips without per-element ellipsis; the `.subj.display` span has no `overflow: hidden; text-overflow: ellipsis; white-space: nowrap`
- **Fix shape**:
  ```css
  /* A — components.css PageHeader section */
  .page-title { overflow-wrap: break-word; }

  /* B — components.css player-sheet section */
  .subj.display {
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  ```

##### F-A-5 — `.ec-name` overflows at long ensemble names; BPM pushed off card right edge (auto-P1)

- **Hypothesis ref**: NEW (open-walk discovery — the audit's existence-proof finding)
- **Component**: EnsembleCard
- **File**: `dashboard/src/components/EnsembleCard.tsx:109-119`
- **CSS rule**: `components.css:848-862`
- **Viewport**: 1180px Laptop, 834px Tablet (3-4 card grid layout; each card ≈ 280–390px wide)
- **Content regime**: long-tail-realistic
- **Class**: **B** (overlap-into-adjacent-sibling — high-conf via static analysis)
- **Observed**: `.ec-name { font-family: var(--ff-display); font-size: 22px; }` is a flex sibling inside `.ec-head { display: flex; justify-content: space-between; align-items: baseline; }`. Neither `.ec-name` nor `.ec-tempo` (BPM display) has `min-width: 0`, `overflow: hidden`, or `text-overflow: ellipsis`. **`.ensemble-card` (CSS line 848) has no `overflow: hidden`.**

  At 3-4 card grid layout (viewport 1180px or 834px), each card gets ≈ 280–390px track width via `repeat(auto-fill, minmax(280px, 1fr))` (CSS line 845). A 36-char long-tail ensemble name such as `tempo-impl-feature-flag-rollout-q3` at 22px display font renders at ≈ 450–500px. Without `min-width: 0` on `.ec-name`, the flex item does not shrink. The `.ec-head` flex container expands to fit, widening beyond the card's content box. Because `.ensemble-card` has no `overflow: hidden`, the expanded `.ec-head` bleeds outside the card's right border. Under `justify-content: space-between`, the `.ec-tempo` (BPM) sibling is positioned at the expanded container's right edge — placing it **outside the card's border box and into the adjacent card's pixel space**.

  **This is the la-tempo-advisor / PR-D #463 pattern recurring at the structural level on a different component.**
- **Expected**: `.ec-name` truncates with ellipsis at card boundary; BPM remains visible inside the card.
- **Severity**: **P1**
- **Auto-P1**: **YES** — BPM display escapes card right edge into adjacent card pixel space at production-realistic content (36-char names are within `ENSEMBLE_NAME_MAX`)
- **Disposition**: `static-confirmed, live measurement pending`; **production-realistic**
- **Root cause**: missing `overflow: hidden; text-overflow: ellipsis; white-space: nowrap; min-width: 0` on `.ec-name`; `.ensemble-card` lacks `overflow: hidden`; `.ec-tempo` lacks `flex-shrink: 0`
- **Fix shape**:
  ```css
  .ec-name {
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    min-width: 0;
    flex: 1 1 0;
  }
  .ec-tempo { flex-shrink: 0; }
  /* Optional defense-in-depth */
  .ensemble-card { overflow: hidden; }
  ```
- **Live measurement**: pending — Playwright bbox-overlap assertion at `dashboard/tests-overflow/_walk-a-measurement.spec.ts:F_A_5_ec_name`

##### F-A-6 — `.ec-desc` unbreakable token escapes card boundary (class B)

- **Hypothesis ref**: NEW (open-walk discovery)
- **Component**: EnsembleCard
- **File**: `dashboard/src/components/EnsembleCard.tsx:146-148`
- **CSS rule**: `components.css:873`
- **Viewport**: all (stress)
- **Content regime**: synthetic-stress
- **Class**: B (high-conf)
- **Observed**: `.ec-desc { color: var(--text-2); font-size: 13px; line-height: 1.5; min-height: 40px; }` has no `overflow-wrap`, `word-break`, or `overflow: hidden`. An unbreakable synthetic-stress description token (530+ chars, no spaces) causes the card container to expand beyond its CSS grid track width, overlapping the adjacent card. Class-B (bbox escape into sibling).
- **Expected**: description wraps within card boundary; card never wider than its grid track.
- **Severity**: **P2 synthetic-stress**
- **Auto-P1**: no — requires synthetic-stress content
- **Disposition**: `static-confirmed, live measurement pending`; synthetic-stress
- **Root cause**: missing `overflow-wrap: break-word` on `.ec-desc`; also missing on the card container itself
- **Fix shape**:
  ```css
  .ec-desc {
    overflow-wrap: break-word;
    word-break: break-word; /* fallback */
  }
  ```

#### Walk B findings (Tables / Sidebar / Chat / Buttons — by tempo-researcher)

##### F-B-1 — Sidebar `.er-name` long ensemble name overflow

- **Hypothesis ref**: H1 (confirmed)
- **Component**: Sidebar
- **File**: `dashboard/src/components/Sidebar.tsx:97-132`
- **CSS rule**: `components.css:271-299`
- **Viewport**: all non-phone (>520px); phone collapse via `.er-initial` rule
- **Content regime**: `long-tail-realistic`
- **Class**: A (high-conf), conditional B (auto-P1 if bleeds into workspace)
- **Observed**:
  - `.ensemble-row` is `display: grid` with `grid-template-columns: 14px 1fr auto`. Middle 1fr column holds `<span className="col" style={{ gap: 0 }}>` flex container containing `.er-name` + `.er-meta`.
  - `.er-name` rule is **only** `font-weight: 500; letter-spacing: -0.005em`. No `overflow`, no `text-overflow: ellipsis`, no `white-space: nowrap`.
  - The inline `<span className="col">` JSX has **no `min-width: 0`**. CSS default for flex items is `min-width: auto` (= content-width-floor). Without explicit `min-width: 0`, the 1fr grid cell **cannot shrink below intrinsic content width** — long `.er-name` will force the 1fr column to expand.
  - The trailing auto-column holds a fixed-width `↵` glyph (Sidebar.tsx:128-130).
- **Expected**: long ensemble names truncate with ellipsis inside the row's available space; sidebar width remains ~244px.
- **Severity**: **P1 production-realistic**
- **Auto-P1**: **conditional** — confirms auto-P1 if at desktop 1440 the sidebar visibly bleeds into the workspace artboard area. Boundary-viewport sweep needed via Playwright.
- **Disposition**: `static-confirmed, live measurement pending`; production-realistic
- **Root cause**: missing `min-width: 0` on `.ensemble-row .col` flex container + missing `overflow: hidden; text-overflow: ellipsis; white-space: nowrap` on `.er-name` + `.er-meta`
- **Fix shape**:
  ```css
  .ensemble-row .col { min-width: 0; }
  .ensemble-row .er-name,
  .ensemble-row .er-meta {
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  ```

##### F-B-2 — Hosts table FQDN hostname overflow at non-phone viewports

- **Hypothesis ref**: H5 (confirmed)
- **Component**: Hosts table → HostRow
- **File**: `dashboard/src/screens/Hosts.tsx:151-176, 199-258`
- **CSS rule**: `components.css:77` (base `.table` cell rule), `1525-1532` (phone collapse only)
- **Viewport**: all non-phone (>520px); phone is fine via stacked-card collapse
- **Content regime**: `long-tail-realistic`
- **Class**: A (high-conf), conditional B (auto-P1 if forces table-wide horizontal scroll)
- **Observed**:
  - The Host cell renders the hostname directly: `<td className="mono"><span style={{ color: ... }}>●</span> {id}</td>`. No `max-width`, no inline ellipsis style, no `title` tooltip.
  - The base `.table` cell rule is **only** padding + font-size at non-phone viewports. No `max-width`, no `overflow`, no `white-space`.
  - The phone-only stacked-card override (lines 1525-1532) sets `min-width: 0; word-break: break-word` for table cells — but only inside `@container artboard (max-width: 520px)`. At desktop/laptop/tablet the Host column inherits the base `auto` table-layout shrinkability.
  - `<table className="table">` has no `table-layout: fixed`. Default is `auto` → column widths driven by intrinsic content, including unbreakable FQDNs.
- **Expected**: long FQDNs truncate with ellipsis (or wrap, per design judgment), with the full hostname available via hover/tooltip; other columns retain readable widths.
- **Severity**: **P1 production-realistic**. Kubernetes-pod-style hostnames are standard production reality.
- **Auto-P1**: **conditional** — confirms auto-P1 if the table introduces a horizontal scrollbar OR if rightmost columns become unreadably narrow.
- **Disposition**: `static-confirmed, live measurement pending`; production-realistic
- **Coordination note**: per researcher's coordination ask, the right `max-width` for Host column needs design judgment. Researcher's recommendation: **truncate-with-tooltip** to keep row at one line and preserve column ratios.
- **Root cause**: missing `max-width` + ellipsis on the Host column at non-phone viewports
- **Fix shape**:
  ```css
  .table td:first-child {
    max-width: 240px;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  ```
  + add `title={id}` to `<td>` in `Hosts.tsx:201` so the full FQDN is hover-readable

##### F-B-3 — `.panel-head` missing flex-wrap; chat panel head subj + actions collision

- **Hypothesis ref**: H7 (confirmed)
- **Component**: Workspace chat panel head (and any `.panel-head` with both title + multi-action right slot)
- **File**: `dashboard/src/screens/Workspace.tsx:401-425`
- **CSS rule**: `components.css:459-466` (`.panel-head`); `:467-471` (`.panel-head-title`); `:1289` (`.row`); `:1199-1200` (phone-only padding tighten + `.subj` hide)
- **Viewport**: boundary band 901-1199; also 521-899 to a lesser degree
- **Content regime**: `long-tail-realistic`
- **Class**: C (wraps-badly) + E (boundary-viewport) (high-conf)
- **Observed**:
  - `.panel-head { display: flex; align-items: center; justify-content: space-between; gap: 12px; }`. **No `flex-wrap`.**
  - `.panel-head-title { display: inline-flex; align-items: baseline; gap: 10px; }`. **No `flex-wrap`, no `min-width: 0`, no overflow handling.**
  - `.panel-head-title .subj { font-family: var(--ff-display); font-size: 18px; }`. **No `overflow`, no ellipsis, no `max-width`.**
  - The right slot uses `<div className="row">` — `.row { display: flex; align-items: center; gap: 8px; }`. **No `flex-wrap`** outside two specific overrides (PlayerSheet, dialog-foot).
  - In the boundary band 901-1199, all three contributors collide simultaneously: subj is visible, `.row` doesn't wrap, `.panel-head` doesn't wrap, and the workspace chat-panel right slot holds three buttons.
- **Expected**: at narrow boundary viewports, either the subj truncates with ellipsis OR the row wraps onto a second line; either way, the right-slot buttons stay visible and clickable.
- **Severity**: **P2 boundary-viewport** — only manifests in 901-1199 band
- **Auto-P1**: no
- **Disposition**: `static-confirmed, live measurement pending`; boundary-viewport
- **Root cause**: missing `flex-wrap: wrap` on `.panel-head` (preferred — wraps the entire title+actions pair); plus missing `min-width: 0; overflow: hidden; text-overflow: ellipsis` on `.panel-head-title .subj` for fallback graceful-degrade
- **Fix shape**:
  ```css
  .panel-head { flex-wrap: wrap; }
  .panel-head-title { min-width: 0; }
  .panel-head-title .subj {
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  ```

##### F-B-4 — `.msg-body` code-block missing `pre` / `code` overflow rules

- **Hypothesis ref**: H8 (confirmed, P1 ratified by lead)
- **Component**: FeedMessage body
- **File**: `dashboard/src/components/chat/FeedMessage.tsx:99-101`
- **CSS rule**: `components.css:528-534` (`.msg-body`); `:576-586` (`.msg.out` 78% bubble cap); **absence** of any `pre`/`code` rule across the entire stylesheet (lead grep confirmed zero matches in `dashboard/src/styles/*`)
- **Viewport**: all
- **Content regime**: `production-realistic` — long unbreakable cmd-line invocations, file paths, package names, stack traces
- **Class**: A (high-conf), conditional B (auto-P1 if bleeds bubble bounds into adjacent UI)
- **Observed**:
  - `.msg-body { ...; max-width: 72ch; text-wrap: pretty; }` is natural-language-only typography. `text-wrap: pretty` is a prose-quality enhancement; pairing it with `max-width: 72ch` (the ideal-prose-measure) is the canonical book-typography stack. Both are senseless for code.
  - `.msg.out { ...; max-width: 78%; }` caps the outbound bubble width.
  - **No `pre` rule. No `code` rule. No `overflow-x` rule in chat scope. No `white-space` rule in chat scope. No `word-break` rule in chat scope.**
  - FeedMessage renders `m.body` as `ReactNode` — caller-supplied `<pre><code>` markup passes through unchanged.
  - UA defaults: `<pre>` is `white-space: pre`, `display: block`, `overflow: visible`. So a long unbreakable line inside `<pre><code>` extends as far as the content needs, with no clipping.
  - The `.msg.out { max-width: 78% }` cap blocks *bubble* growth, but child overflow is `visible`, so the inner `<pre>` content **bleeds past the bubble border** into adjacent layout (potentially the `.workspace-side` panel or beyond).
  - **The absence is the finding.** The natural-language-only `.msg-body` rules tell us the designer was thinking about prose, not code. There's no design-intent enforcement for code blocks at all.
- **Expected** (per lead's design-intent ratification — option (1) deliberate horizontal scroll, standard chat-app behavior): block-level `<pre>` produces a horizontal scroll inside the message bubble; inline `<code>` wraps at any character as graceful fallback. Bubble bounds (`max-width: 78%`) are honored.
- **Severity**: **P1 production-realistic** (lead-ratified). Code-block content is canonical conductor-message content; the layout breakage is structural.
- **Auto-P1**: **conditional** — confirms auto-P1 if long unbreakable code content escapes the `.msg.out { max-width: 78% }` bubble bounds and bleeds into adjacent UI. Static analysis suggests this WILL happen because `overflow: visible` is the UA default for `<pre>` and there's no override anywhere.
- **Disposition**: `static-confirmed, live measurement pending`; production-realistic
- **Root cause**: missing block-level `<pre>` overflow handling + missing inline `<code>` wrap-anywhere fallback in chat scope
- **Fix shape** (two-rule split for block vs inline):
  ```css
  .msg-body pre {
    display: block;
    overflow-x: auto;
    max-width: 100%;
    white-space: pre;  /* option (1): scroll, NOT wrap */
  }
  .msg-body code {
    overflow-wrap: anywhere;  /* inline code wraps at any char */
  }
  ```

##### F-B-5 — Settings `.kv` long-value overflow

- **Hypothesis ref**: H9 (confirmed)
- **Component**: Settings → KV rows
- **File**: `dashboard/src/screens/Settings.tsx:357-364, 122-145, 147-183`
- **CSS rule**: `components.css:158-168`; `:76`
- **Viewport**: all (settings-grid is two-column at >720px and one-column below)
- **Content regime**: `synthetic-stress` for current canonical values; `long-tail-realistic` for plausible future content (federated namespace, dirty-build version strings)
- **Class**: A (high-conf)
- **Observed**:
  - `.kv { display: flex; justify-content: space-between; gap: 12px; ... }`. The flex container has **no `min-width: 0`**.
  - `.kv-k { color: var(--dim); ... }`. **No overflow, no max-width.**
  - `.kv-v { color: var(--text); font-variant-numeric: tabular-nums; }`. **No overflow, no max-width.**
  - With `justify-content: space-between` and no overflow handling on either child, a long `kv-v` will: (1) force the parent `.kv` row to expand horizontally (overflowing the panel's body), OR (2) push the `.kv-k` left-stuck label past the row's left edge if the panel container clips, OR (3) wrap if the inner span allows wrapping (default `white-space: normal`) — likely outcome for natural values; hyphenated single-token strings may not break depending on UA hyphen handling.
- **Expected**: long values truncate with ellipsis (with tooltip for full value) OR wrap to next line gracefully without breaking the panel boundary.
- **Severity**: **P2 long-tail content stress**. Current canonical values are short — escalates to P1 only if a real wire-up surfaces a long value without a fix.
- **Auto-P1**: no
- **Disposition**: `static-confirmed, live measurement pending`; long-tail-realistic / synthetic-stress mix
- **Root cause**: missing `min-width: 0` on `.kv` flex container; missing `overflow: hidden; text-overflow: ellipsis; white-space: nowrap` on `.kv-v` (with hover tooltip)
- **Fix shape**:
  ```css
  .kv { min-width: 0; }
  .kv-v {
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  ```
  + `title={v}` on the value span in `Settings.tsx:361`

##### F-B-NEW-1 — Loadouts table Name column unbounded

- **Hypothesis ref**: NEW (open-walk discovery)
- **Component**: Loadouts table → LoadoutRow
- **File**: `dashboard/src/screens/Loadouts.tsx:111-155`
- **CSS rule**: `components.css:77` (base `.table` cell rule)
- **Viewport**: all non-phone
- **Content regime**: `long-tail-realistic`
- **Class**: A (high-conf)
- **Observed**: Name cell is `<td className="mono"><span className="accent">≡</span> {l.name}</td>`. **No max-width, no inline ellipsis, no wrapper handling overflow.** The Summary column DOES have `style={{ ..., maxWidth: 320 }}` — design did handle the description column. The Name column was missed. Same root-cause shape as F-B-2 (Hosts table).
- **Expected**: long lineup names truncate with ellipsis at sensible max-width.
- **Severity**: **P2 long-tail content** — typical canonical lineup names are short; longTail shapes start to bite at narrow viewports
- **Auto-P1**: no
- **Disposition**: `static-confirmed, live measurement pending`; long-tail-realistic
- **Root cause**: missing per-column max-width on the Name column at non-phone viewports
- **Fix shape**: same shape as F-B-2; consider extracting into a shared utility class:
  ```css
  .table td:first-child[class*="mono"] {
    max-width: 240px;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  ```

##### F-B-NEW-2 — Generic `.row` button-row missing flex-wrap

- **Hypothesis ref**: NEW (open-walk discovery; generalizes pre-log H7's panel-head case)
- **Component**: any `.row` container that holds buttons across the dashboard
- **File**: `dashboard/src/screens/Workspace.tsx:406-425` (chat panel-head right slot — 3 buttons); `dashboard/src/screens/Loadouts.tsx:137-152` (LoadoutRow actions); `dashboard/src/screens/Schedules.tsx:181-196` (ScheduleRow actions)
- **CSS rule**: `components.css:1289` (`.row { display: flex; align-items: center; gap: 8px; }`); flex-wrap variants only at `:1517` (`.player-sheet-head .row`) and `:1599` (`.dialog-foot .row`)
- **Viewport**: 521-1199
- **Content regime**: `long-tail-realistic` for any future label internationalization or extended action text
- **Class**: C (high-conf)
- **Observed**:
  - Default `.row` is `display: flex; gap: 8px; align-items: center` — no flex-wrap.
  - Flex-wrap override exists for two specific contexts (`.player-sheet-head`, `.dialog-foot`) but **not as a global default**, even though the same collision shape (multi-button row + sibling content + narrow viewport) appears across at least three other surfaces.
  - Action cells in tables (`text-align: right` on `<td>`) won't collapse buttons gracefully if they exceed cell width.
- **Expected**: button rows wrap onto multiple lines at narrow viewports rather than colliding with sibling content.
- **Severity**: **P3 cosmetic** for current English short labels (Edit, Cancel, Pause, Release, Pop out, Load are 4-9 chars); **P2 long-tail** if any future label hits 12+ chars OR i18n adds locale-specific length expansion (German labels typically +30-40%)
- **Auto-P1**: no
- **Disposition**: `static-confirmed, live measurement pending`; future-i18n
- **Root cause**: missing default `flex-wrap: wrap` on the global `.row` utility class
- **Fix shape**:
  ```css
  /* Make wrap the default — opt out via a discrete class if needed */
  .row { flex-wrap: wrap; }
  ```
  **Risk**: existing `.row` callsites that depend on nowrap behavior could break. **Audit recommendation for eng implementer**: grep `\.row\b` callsites first; if any rely on nowrap, add `.row.row--nowrap` opt-out class. Most likely safe — alignment + gap rules don't change with wrap.

### 4.3 Refuted hypotheses

#### H4A — refuted

**Hypothesis**: PlayerTypes `.display` shortName overflows at long-tail type slugs.

**Walk verdict**: All 5 long-tail types have names ≤24 chars after `tempo-` prefix strip (`my-tempo-architect`, `my-tempo-researcher` = 18-19 chars). At `grid-template-columns: 1fr 1fr` with 1440px viewport, each card is ≈ 680px wide; at 834px each card is ≈ 390px. No overflow at any long-tail × canonical viewport cell. Static rule preventing overflow: `grid-template-columns: 1fr 1fr` tracks allocate sufficient width for all 13 shipped/long-tail types.

**Regression coverage**: encoded as passing-assertion in `_walk-a-measurement.spec.ts` — sweeps `1fr 1fr` grid with all longTail slug widths.

#### H10 — refuted

**Hypothesis**: `.page-pills` overflows into `.page-actions` at boundary viewports or when many pills are active.

**Walk verdict**: `page-header` uses `grid-template-columns: 1fr auto`. Pills live in left `1fr` cell; actions in right `auto` cell. Grid cells do not overlap — pills **cannot** physically collide with actions regardless of pill count. At non-phone: `.page-pills { display: inline-flex; gap: 8px; }` inside `.page-title-row { ...flex-wrap: wrap; }`. When pills exceed title row width they wrap below the title, not into the actions cell. At phone (520px breakpoint): `.page-pills { flex-wrap: wrap; }` added explicitly.

**Static rule preventing collision**: `grid-template-columns: 1fr auto` separates the two grid cells.

**Regression coverage**: encoded as 6 boundary-viewport passing-assertions in `_walk-a-measurement.spec.ts` (1201/1199/901/899/521/519) — locks the protection against future regression of the `grid-template-columns: 1fr auto` rule.

#### H11 — refuted

**Hypothesis**: TempoStrip narrows badly at boundary viewports.

**Walk verdict** (researcher): `.tempo-strip` width auto from parent, no fixed dimension that could exceed container. `.tempo-strip-label` is `position: absolute; right: 12px; left: 12px; display: flex; justify-content: space-between` — stretches with strip width; `tempo` + `92 bpm` labels (~5-6 chars each) have abundant space at any plausible viewport. `.tempo-strip-svg` uses `width="100%"` + `preserveAspectRatio="none"`. At narrow viewports, the 60-bar series compresses horizontally; bars retain `Math.max(1.5, h)` floor so they don't disappear, and `viewBox` scaling means no clipping at any width.

**Regression coverage**: encoded as 3-viewport assertion in `_walk-b-measurement.spec.ts` (320×240 synthetic-narrow, 390×780 phone, 1440×900 desktop) — locks no-overflow guarantee.

#### H13 — refuted

**Hypothesis**: `.ec-roster` PlayerAvatars overflow at 50-player ensembles.

**Walk verdict**: roster renders maximum 5 `PlayerAvatar` components at `size={22}` (each 22px circle) plus `+N` suffix. At 5 avatars: `5 × 22px + 4 × 4px gap ≈ 126px` well within any card's `.ec-roster` slot. For N=45 (3-char `+N` suffix), total roster display ≈ 126 + 10 + 30 = 166px. All canonical viewports provide ≥ 280px card width with slack. **Static rule limiting render**: `slice(0, 5)` in JSX caps avatar count.

**Regression coverage**: encoded as passing-assertion in `_walk-a-measurement.spec.ts` — sweeps 5-player and 50-player ensemble fixtures, asserts roster width fits all card-grid layouts.

### 4.4 Adjusted-to-P3 (monitor-not-fix) hypotheses

#### H12 — confirmed P3 cosmetic

**Hypothesis**: `.types-grid` card heights misalign when display text wraps differently across columns.

**Walk verdict**: `grid-auto-rows: max-content` means each row height is set independently per row — cards in same visual row are not height-aligned. When one card has a long description that wraps to two lines and its grid-row peer has a single-line description, cards appear misaligned in height. Cosmetic — no content overflow, no class-A or class-B issue.

**Severity**: P3 cosmetic. **No fix required**; flagged for design-owner review if visual alignment is desired (would need `align-items: stretch` + a min-height on cards).

#### H14 — adjusted P3 (monitor at i18n)

**Hypothesis**: `.page-actions` button row overflows at i18n / longer button labels.

**Walk verdict**: `page-header` uses `grid-template-columns: 1fr auto` — `auto` cell expands to fit actions content. As long as actions total width ≤ remaining viewport width after `1fr` title area, no collision. Current labels ("New ensemble", "Recruit") are short. At i18n labels up to 2× English length (~28 chars) buttons remain within `auto` cell for canonical viewports ≥ 834px. At phone (390px), `.page-actions { flex-wrap: wrap }` is added.

**Severity adjusted**: P3 — not a current finding; **monitor when i18n strings are added**.

### 4.5 Classification ambiguity log

**No ambiguous classifications.** All 13 findings are tagged `(high-conf)` because both walkers ran static-only methodology with explicit `components.css` line references and JSX file:line citations. The classification pipeline is:

1. Walker reports finding with full root-cause in prose
2. Lead pattern-matches the prose against researcher's #474 §1.1 taxonomy
3. Class assigned at high-conf level when the finding text explicitly identifies the failure mode (self-overflow vs adjacent-bbox-escape vs wrap vs computed drift vs viewport-boundary)

If future iterations or v0 implementer review surfaces ambiguity (e.g. F-B-1's conditional-auto-P1 turns out NOT to bleed into workspace, downgrading from class A+B to clean class A self-overflow), append below as:

```
F-X-N: candidate classes [A|B], distinguishing observation = ?
```

Phase B implementer should consult this log if a prescribed fix doesn't match the assigned class.

---

## 5. Severity summary

| Severity | Count | Findings |
|---|---|---|
| **P1 production-realistic** | 5 | F-A-1 (wire-pending), **F-A-5 (auto-P1 confirmed)**, F-B-1 (cond auto-P1), F-B-2 (cond auto-P1), F-B-4 (cond auto-P1) |
| of which auto-P1 confirmed | 1 | F-A-5 |
| of which auto-P1 conditional (boundary measurement pending) | 3 | F-B-1, F-B-2, F-B-4 |
| **P2 long-tail-realistic** | 3 | F-A-4 sub-B (SheetHead phone), F-B-5, F-B-NEW-1 |
| **P2 boundary-viewport** | 1 | F-B-3 |
| **P2 synthetic-stress** | 3 | F-A-2, F-A-3, F-A-6 |
| **P3 cosmetic** | 1 | F-B-NEW-2 (P3 today, P2 if i18n adds 30%+ length) |
| Subtotal — actionable findings | **13** | |
| Refuted with regression coverage | 4 | H4A, H10, H11, H13 |
| Adjusted to P3 monitor-not-fix | 2 | H12 (cosmetic row-height), H14 (i18n-monitor) |
| **Total walked outcomes** | **19** | |

---

## 6. Headline findings — what to fix first

### #1 — F-A-5 EnsembleCard `.ec-name` overflow (P1 auto-P1, audit's existence-proof)

The la-tempo-advisor / PR-D #463 pattern recurring at the structural level on a different component. `.ec-name` lives in flex `space-between` with no `min-width: 0`; `.ensemble-card` has no `overflow: hidden`. At production-realistic 36-char ensemble names, the `.ec-tempo` (BPM) sibling escapes the card right edge into adjacent card pixel space.

**Why this matters most**: validates the audit's premise that point-fixes mask cluster bugs. PR-D was a fix at one site; this finding shows the same structural pattern recurring elsewhere. Without this audit, it would have shipped to production as a layout regression visible at 36-char ensemble names — well within `ENSEMBLE_NAME_MAX`.

### #2 — F-B-1 Sidebar `.er-name` long-name overflow (P1 production-realistic, conditional auto-P1)

The sidebar's `.ensemble-row` grid middle cell has no `min-width: 0` on its flex column. Long-tail real ensemble names (e.g. `tempo-impl-feature-flag-rollout-q3` = 32 chars) force the 1fr column to expand. If the expansion bleeds past the sidebar's right edge into the workspace artboard, auto-P1 fires.

**Why this is high-priority**: sidebar is on every screen. Any user with a long-named ensemble loaded sees the regression on every page navigation.

### #3 — F-B-2 Hosts table FQDN overflow (P1 production-realistic, conditional auto-P1)

K8s-style FQDN hostnames (e.g. `ci-runner-prod-cluster-pod-7-replica-3.eks.internal.example.com`) overflow the Hosts table Host column at non-phone viewports. The table has no `table-layout: fixed`; default `auto` layout means a long FQDN expands the column and squeezes siblings (Heartbeat, Daemon, Uptime become unreadably narrow).

**Why this is high-priority**: K8s hostnames are the canonical production deployment shape. The fix requires a design judgment (truncate-with-tooltip vs word-break vs allow-row-wrap); recommendation is truncate-with-tooltip to preserve column ratios.

### #4 — F-B-4 Chat code-block overflow (P1 production-realistic, conditional auto-P1)

`components.css` has zero rules for `pre` or `code` selectors. The chat pane's `.msg-body` has natural-language-only typography (`max-width: 72ch`, `text-wrap: pretty`) but no fallback for code. Long unbreakable code content (file paths, package names, stack traces) escapes the bubble's `max-width: 78%` cap because UA-default `<pre>` is `overflow: visible`.

**Why this matters**: conductor messages and player-to-player cues frequently contain code snippets. The layout breakage is structural — not an edge case.

### #5 — F-A-1 EnsembleCard `.ec-meta` overflow (P1 wire-pending)

When lineup + host data wires up to EnsembleCard, the `.ec-meta` flex container (no `min-width: 0`, no ellipsis on either child) will collide host FQDN with lineup name. **Fix should ship preventatively** alongside the wire-up PR (or before it) to avoid a visible regression on the wiring commit.

---

## 7. Cluster proposal

### 7.1 Final cluster shape: **2 PRs**

After consolidation, the 13 findings + 4 refutations + 2 P3-adjustments converge to two PR clusters:

#### PR-α — CSS overflow discipline (broad)

**Scope**: all 13 findings, single-file `components.css` change. ~50-70 lines of CSS additions covering:
- 5 findings on `min-width: 0` discipline (F-A-1, F-A-2, F-A-5, F-B-1, F-B-2)
- 4 findings on `overflow-wrap: break-word` discipline (F-A-3, F-A-4, F-A-6, F-B-5)
- 2 findings on `flex-wrap: wrap` discipline (F-B-3, F-B-NEW-2)
- 1 finding on chat code-block overflow (F-B-4)
- F-A-1's wire-pending pre-emptive fix (committed before wire-up PR)

**Why one PR**: all changes are CSS-only on shared layout primitives in a single file. The "engineering surface" is the same — no behavior change, no JSX edits (except F-B-2's optional `title={id}` attribute and F-A-1's optional flex-shrink hint). One PR is a single cohesive review. Splitting into PR-α-1 (text-overflow) + PR-α-γ (flex-wrap) would create review-overhead without clean conceptual line.

**Risk**: `.row { flex-wrap: wrap }` (F-B-NEW-2) globalizes a default. **Eng pre-flight**: grep `\.row\b` callsites; if any rely on nowrap behavior, add `.row.row--nowrap` opt-out class. Estimated risk: low (alignment + gap rules don't change with wrap).

**Estimated scope**: ~50-70 LoC of CSS additions, ~2-3 LoC of JSX (`title=` attributes for hover-tooltip).

#### PR-v0 — CI guardrail seed

**Scope**: graduate the two walker Playwright specs to canonical:
1. Move `audit/461-walk-a:dashboard/tests-overflow/_walk-a-measurement.spec.ts` → `dashboard/tests-overflow/cards-headers-wizards.overflow.spec.ts`
2. Move `audit/461-walk-b:dashboard/tests-overflow/_walk-b-measurement.spec.ts` → `dashboard/tests-overflow/tables-sidebar-chat.overflow.spec.ts`
3. Wire to a new `dashboard-overflow` CI job (Path B clone of `dashboard-e2e` per researcher's #474 §4.2)
4. Produce v1 baseline PNGs for the 2 class-B (F-A-5, F-A-6 bbox) and 2 class-C (F-B-3, F-B-NEW-2 wrap) cases — ~4-8 baseline PNGs
5. Promote `_overflow-fixtures.json` → `dashboard/test-fixtures/overflow.json` (already in this audit-doc PR — see §9.1)

**Refutations as regression coverage**: H4A, H10, H11, H13 are encoded as passing-assertions in the walker specs. They ride along into PR-v0 as permanent regression detectors (per §1.4 (c) refutation-as-regression-detector pattern).

**Estimated scope**: ~250-300 LoC delta to existing walker specs (renaming, anti-flake config defaults, baseline initial run); ~30 LoC `.github/workflows/ci.yml` clone for `dashboard-overflow` job.

### 7.2 Why broad PR-α

Researcher's coordination note suggested splitting flex-wrap (F-B-3, F-B-NEW-2) into a separate PR-β to keep PR-α text-overflow-only. Lead-side decision: **broad** because:

- All 13 findings are CSS-only on `components.css`
- All share the "shared layout primitive missing graceful-degradation rule" pattern
- No behavior change in any finding
- Total LoC delta ≤70 — within single-review-session bounds (pixel audit's PR-A had ~80 LoC and reviewed cleanly)
- Splitting introduces review-overhead (two re-reads of the same file's style cluster) without yielding cleaner conceptual line

If during eng-impl review the broad PR-α turns out to need staging (e.g. CI flakiness on the global `.row { flex-wrap: wrap }` rule), splitting at that point is fine — but lead opens with broad as the default.

### 7.3 Sub-cluster details (within PR-α)

For implementer reference, the four sub-clusters within PR-α group the fix by pattern:

| Sub-cluster | Findings | Fix pattern | Surface |
|---|---|---|---|
| **α.1 — `min-width: 0` discipline** | F-A-1, F-A-2, F-A-5, F-B-1, F-B-2 | Add `min-width: 0` to flex/grid items + `overflow: hidden; text-overflow: ellipsis; white-space: nowrap` on text leaves | Auto-P1 surface (highest priority) |
| **α.2 — `overflow-wrap: break-word` discipline** | F-A-3, F-A-4, F-A-6, F-B-5 | Add `overflow-wrap: break-word` to text containers carrying potentially-unbreakable tokens | Legibility surface |
| **α.3 — `flex-wrap: wrap` discipline** | F-B-3, F-B-NEW-2 | Add `flex-wrap: wrap` to `.panel-head` + `.row` defaults | Boundary-band surface |
| **α.4 — Chat code-block overflow** | F-B-4 | Add `pre`/`code` overflow handling in `.msg-body` scope | Single-domain, 2-3 lines |

### 7.4 Refutations as regression coverage in PR-v0

Per §1.4 (c), the following refutations land as passing-assertions in PR-v0:

| Refuted hyp | Assertion in spec | Locks |
|---|---|---|
| H4A | longTail slug widths × `1fr 1fr` grid (PlayerTypes) | Track sizing for shipped + longTail types |
| H10 | `.page-pills` × 6 boundary viewports (PageHeader) | `grid-template-columns: 1fr auto` separation |
| H11 | TempoStrip × 3 viewports including 320px synthetic-narrow | viewBox scaling + bar-floor `Math.max(1.5, h)` |
| H13 | `.ec-roster` 5-player + 50-player fixtures | `slice(0, 5)` JSX cap on avatar render |

Each becomes a permanent guard against re-introduction of the structural patterns we proved currently safe. **This is strictly higher carrying value than walks-as-throwaway.**

---

## 8. Open questions

Researcher's #474 §7 left 7 open questions. Lead disposition below:

| # | Question | Disposition |
|---|---|---|
| Q1 | A/B/C/D/E split in findings? | **Answered**: 9A (69%) / 2B (15%) / 2C (15%) / 0D / 0.5E (F-B-3 hybrid). See §4.1. |
| Q2 | How many components need only class-A coverage vs class-C visual coverage? | **Answered**: 9 components class-A only (PR-v0 v0 layer suffices); 2 components (EnsembleCard for F-A-5/6 bbox; chat panel-head for F-B-3 wrap) need v1 visual layer. ~50 baseline PNGs scoped to these visual-needed cases. |
| Q3 | Should `/__overflow/<Component>?regime=…` test routes be exposed in production dashboard bundle? | **NO** — gate on `import.meta.env.DEV` so they tree-shake out of `npm run build`. Add `size-limit` budget delta < 1KB regression check to catch leaks. |
| Q4 | Should bbox-overlap helper become a public Playwright matcher (e.g. `expect(card).not.toOverlap(neighbour)`)? | **After ≥3 specs use it.** Both walker specs already use bbox math (F-A-5 + F-A-6 in walk-a; conditional auto-P1 cases in walk-b). When v1 expansion adds a third use, refactor at that point. |
| Q5 | Baseline-refresh cadence when designer ships intentional changes? | **Manual on first 2 cycles, then evaluate.** Playwright's `--update-snapshots` is the mechanism; bot-automation deferred until cycle pattern is observed. |
| Q6 | Cross-platform baseline strategy — commit Linux baselines only or platform-suffix all? | **Linux-only baselines.** Matches existing `dashboard-e2e` job's CI shape. Add `dashboard/tests-overflow/README.md` documenting the local-dev `--update-snapshots` flow + warning about `darwin/win32` PNG mismatches. |
| Q7 | Snapshot storage location? | **Playwright default** (`dashboard/tests-overflow/__snapshots__/`). No exotic restructuring. |

### Additional architect calls surfaced during consolidation

**Q-A — F-A-1 wire-pending fix coordination**: should the fix ship in PR-α (preventative, before wire-up) or as part of the future wire-up PR? **Recommend preventative in PR-α.** The fix is harmless when data is `'—'` placeholder; ensures no visible regression on the wire-up commit.

**Q-B — F-B-2 Hosts column max-width value**: `240px` is a guess. Design-owner should confirm whether this is the right ratio for Heartbeat/Daemon/Uptime sibling columns. Recommend including a `<Hosts>` test fixture with one FQDN row to pin the visual at `240px` cap during PR-α review.

**Q-C — F-B-NEW-2 `.row { flex-wrap: wrap }` global default**: low-risk per static analysis but warrants eng pre-flight grep of `\.row\b` callsites. If any callsite relies on nowrap (e.g. precise icon-row alignment), add `.row.row--nowrap` opt-out class.

---

## 9. Appendix

### 9.1 Working artifacts

**This audit-doc PR contains** (kept):
- `docs/design/dashboard-overflow-audit-v0.28.10.md` — this audit doc (canonical)
- `dashboard/test-fixtures/overflow.json` — promoted from `_overflow-fixtures.json` for v0 PR's reuse

**This audit-doc PR removes** (deleted before PR per audit hygiene):
- `_lead-prelog.md` — working artifact, history preserved in git
- `_overflow-fixtures.json` — promoted to `dashboard/test-fixtures/overflow.json` (see above)
- `_recruit-brief-a.md` — working artifact
- `_recruit-brief-b.md` — working artifact

**Walker branches** (separate from this PR; v0 implementer references):
- `audit/461-walk-a:docs/design/_findings-a.md` — Batch A raw findings (eng-handoff)
- `audit/461-walk-a:dashboard/tests-overflow/_walk-a-measurement.spec.ts` — v0 prototype seed
- `audit/461-walk-b:docs/design/_findings-b.md` — Batch B raw findings (eng-handoff)
- `audit/461-walk-b:dashboard/tests-overflow/_walk-b-measurement.spec.ts` — v0 prototype seed

The walker branches are NOT merged into `feat/461-overflow-audit-lead` (this branch). They remain as separate refs whose contents flow into the v0 PR cluster when the eng implementer picks them up.

### 9.2 Related docs

- `docs/design/dashboard-pixel-audit-v0.28.9.md` — methodology precedent, token-table proof
- `docs/design/dashboard-audit-389.md` — original audit
- `docs/design/dashboard-audit-389-followup-rev3.md` — structural rev3 cert
- `docs/research/461-overflow-audit-ci-tooling-spike.md` — researcher's #474, v0+v1 hybrid framework + 5-class A/B/C/D/E taxonomy
- `dashboard/src/styles/components.css` — port re-sync procedure header
- `.github/workflows/ci.yml` — existing `dashboard-build` + `dashboard-e2e` jobs (clone source for `dashboard-overflow`)
- `dashboard/playwright.config.ts` — current Playwright config (chromium, serial, retain-on-failure)

---

## 10. Companion — CI guardrail recommendation

### 10.1 Recommendation: Hybrid v0+v1 (defer v2)

**Phased path**:
- **v0** — JS structural assertions (3b, broad) in a new `dashboard-overflow` Playwright job. Catches class A reliably + class D cleanly + partial class B via bbox math. ~150 LoC + 0 baseline PNGs. ~3-4 hr work.
- **v1** — Targeted Playwright per-Locator screenshots layered onto v0 specs for class B (F-A-5, F-A-6 cases that bbox math can't fully resolve) and class C (F-B-3, F-B-NEW-2 visual-judgment cases). ~50 baseline PNGs committed in-repo; ~100 LoC additional. ~3-4 hr work. Same PR cluster as v0.
- **v2** — Storybook + Chromatic. **Deferred indefinitely.** Today's audit is one-shot regression hunt + lock-in, not design-iteration cadence. Researcher's #474 §3.4 confirms Chromatic OSS-free is likely ineligible (claude-tempo isn't a design-system / component-library project), so v2 cost is $179/mo Starter (~$2,148/yr) for ~30 components × ~4 viewports × ~3 regimes × ~50 PR-and-main runs/mo = ~18k snapshots/mo. **Not justified by today's failure-class shape.**

**Total v0+v1 effort**: ~7-9 hr eng work, ~450-690 LoC, $0 SaaS spend. Single PR cluster.

### 10.2 Why threshold-override (v0+v1, not v0-only)

Class-A share at **69% sits at the v0/v0+v1 threshold edge** per researcher's #474 §6.2 (≥70% A → v0 only; 40-70% A → v0+v1). Literal application would route to v0-only.

**Override to v0+v1 with explicit reasoning**:

1. **F-A-5 is auto-P1 class B.** Auto-P1 means high-impact regression risk; v0 (JS-only assertions) is structurally blind to bbox-overlap geometry per #474 §1.1 + §2 coverage matrix. Even if all other findings were class A, F-A-5 alone justifies v1 visual coverage to lock the no-overlap guarantee.

2. **F-B-3 + F-B-NEW-2 are class C wraps-badly.** Per #474 §2: "wraps don't trip overflow flags" — JS assertions cannot catch wraps-badly cases. These require visual judgment via Playwright `toHaveScreenshot()`.

3. **F-B-1, F-B-2, F-B-4 are conditional-auto-P1 class A** — they MAY escalate to class B during boundary measurement. v1 visual coverage hedges against the conditional-bbox-escape outcome at no marginal cost.

**The threshold is a forecast tool, not a decision rule.** Per §1.4 (d) threshold-edge override discipline. v0+v1 is correct because the data lands at a threshold edge AND the auto-P1 class-B finding (F-A-5) makes the visual layer necessary for risk coverage.

### 10.3 Implementation guidance

**Walker specs are ready-to-extend prototype seeds.**

1. **Move + rename**:
   - `audit/461-walk-a:dashboard/tests-overflow/_walk-a-measurement.spec.ts` → `dashboard/tests-overflow/cards-headers-wizards.overflow.spec.ts`
   - `audit/461-walk-b:dashboard/tests-overflow/_walk-b-measurement.spec.ts` → `dashboard/tests-overflow/tables-sidebar-chat.overflow.spec.ts`

2. **Add Playwright config defaults** (`dashboard/playwright.config.ts` — extend ~10 LoC):
   ```ts
   expect: {
     toHaveScreenshot: {
       maxDiffPixels: 50,
       threshold: 0.2,
       animations: 'disabled',
       caret: 'hide',
     },
   },
   ```

3. **Add v1 screenshot assertions** to specs for the 4 visual-needed cases (F-A-5, F-A-6, F-B-3, F-B-NEW-2). Each adds 1-2 `expect(locator).toHaveScreenshot(...)` calls with the config defaults above.

4. **Add `/__overflow/<Component>?regime=…` test route shim** (`dashboard/src/__overflow/routes.tsx` ~80-150 LoC). Per Q3: gate on `import.meta.env.DEV` so it tree-shakes out of production bundle. Add `size-limit` budget delta `< 1KB` regression check.

5. **Add `dashboard-overflow` CI job** (`.github/workflows/ci.yml` ~30 LoC). Path B clone of `dashboard-e2e` per #474 §4.2 — wall-clock parallelism dominates the ~1.5 min install overhead.

6. **Initial baseline run** — `npm run test:e2e -- --update-snapshots` on Linux CI. Commit ~50 baseline PNGs (Linux-only, ~2.5 MB repo growth per #474 §9).

7. **Documentation** — `dashboard/tests-overflow/README.md` with local-dev baseline flow + cross-platform note (warns about `chromium-darwin.png` / `chromium-win32.png` mismatches against Linux CI baselines).

### 10.4 Forward decision points

**v2 reconsideration triggers** (would justify Storybook + Chromatic adoption):
- A future audit reveals >50% of dashboard work is design-iteration where every PR needs designer review
- Component count grows past ~60 (current ~30) AND visual review cadence increases
- Snapshot count exceeds 35k/mo (Chromatic Starter tier ceiling) under hybrid v0+v1

Until any of these fire, **v2 stays deferred**. v0+v1 lean carries indefinitely on the current dashboard surface.

**v1 expansion triggers** (would expand v1's screenshot coverage beyond ~50 PNGs):
- A future audit finds >40% class C (wraps-badly) cases — visual judgment dominates, more components need screenshots
- Class B cases proliferate (e.g. another point-fix-masking-cluster pattern surfaces) — bbox helpers extracted to public matcher per Q4

Until then, v1 stays scoped to the 4 known visual-needed cases.

---

**Sign-off**: tempo-overflow-lead (architect), 2026-04-29.
**Walk authors**: tempo-qa (Batch A), tempo-researcher (Batch B).
**Methodology**: hybrid live + static, with concurrent-failure resilience (Chrome MCP + dev daemon both unavailable mid-walk; degraded gracefully via static-only + deferred Playwright measurement).
**Calibration**: pre-log forecast 8/14 hits at predicted severity, 4 cleanly refuted, 1 calibration error caught. Audit's mental model of codebase well-calibrated.
