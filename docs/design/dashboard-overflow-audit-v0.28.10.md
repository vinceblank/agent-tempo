# Dashboard overflow + content-length robustness audit — v0.28.0-beta.10

**Status**: DRAFT — rubric phase (lead-1)
**Date**: 2026-04-29
**Branch audited**: `main` @ `97c2f554` (npm tag `beta` = `0.28.0-beta.10`)
**Audit lead**: tempo-overflow-lead
**Recruits**: TBD — dispatched after rubric ratification
**Methodology baseline**: depth-2 audit, parallel pattern to `dashboard-pixel-audit-v0.28.9.md`. Where the pixel audit verified design fidelity at canonical content × canonical viewports, this audit verifies **content-length robustness** — does the layout hold when fed production-realistic and synthetic-stress content?

> **Working draft.** §3 (token-level — N/A here) and §4 (findings catalog) are filled in after lead pre-log + recruit walks complete. This commit captures the locked rubric (§1) and the dimensions matrix (§2) for ratification.

---

## Executive summary

*[TBD — written after walks complete. Headline shape will be a content-length × viewport overflow distribution table, identifying which layout regions absorb stress gracefully and which break.]*

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

**Inverted from pixel audit.** The pixel audit's static-first pivot worked because the token table was byte-identical between canonical and impl, so live sampling added no signal. Here the question is whether *computed layout* holds under stress — class application alone can't answer that. Live sampling is primary.

**Per (component, viewport, content-regime) cell**:

1. **Live DOM sample** (primary) via Chrome MCP on a running dashboard:
   - Seed the dashboard with the relevant fixture (see §1.6).
   - Capture `clientWidth`, `scrollWidth`, `getBoundingClientRect()` for the component root + any siblings.
   - Note observed-vs-expected: clipped text without ellipsis-by-design, button row wider than container, card overlapping adjacent card, scrollbar appearing in non-scrollable region.

2. **Static class-application audit** (corroboration) for any live finding:
   - Read the component's JSX + the matching `components.css` rule that resolves at this breakpoint.
   - Identify root cause class: missing `min-width: 0`, missing `text-overflow: ellipsis`, fixed-px width that should be `1fr`, etc.
   - This is what makes the finding *fixable* (turns "the box overflows" into "add `min-width: 0` to `.X`").

A live finding without a static root-cause analysis is incomplete — every finding in §4 carries both.

**Tooling**: Chrome MCP (`mcp__claude-in-chrome__*`) for live sampling. Static reads via Read/Grep. Daemon URL TBD with conductor.

**Methodology evolution from pixel audit — hypothesis vs. lock**: pixel audit pre-locked findings before recruits walked. This audit pre-logs **hypotheses** with severity-guess + root-cause-guess (see `_lead-prelog.md`); recruits validate or refute each. The change is motivated by overflow-under-stress not being directly readable from static CSS — it depends on actual computed layout — so pre-locking would over-claim. Hypothesis-then-validate also gives recruits a structured workload (suspect list to check, then open exploration for new findings) instead of an empty exploration. Future audits should consider this pattern when the audit target is a computed-value phenomenon rather than a token-table comparison.

### 1.5 Severity rubric

- **P1** — overflow visible at **production-realistic content × canonical viewport** (i.e. would hit a real user). Includes auto-P1: external overflow at canonical viewport regardless of content regime.
- **P2** — overflow visible only at **synthetic stress content** OR **boundary viewport** (still real-world possible but rarer).
- **P3** — functional but noticeable degradation: truncated tooltip we want to keep, wrapped chip group that should single-line, container scrollbar appearing without breaking layout.

**Disposition tags** (orthogonal to severity):
- `production-realistic` — triggered at long-tail-realistic regime
- `synthetic-stress` — only triggered at synthetic stress
- `intentional-truncation` — text-overflow ellipsis is the design — flag only if missing or wrong axis
- `cross-cutting` — single root cause spans multiple components (cluster-PR candidate)
- `wire-pending` — affordance not yet wired; overflow assessment is provisional

### 1.6 Test fixtures

Fixtures are committed as `_overflow-fixtures.json` in this directory (deleted before PR; promoted to `dashboard/test-fixtures/overflow.json` if the CI-guardrail companion (§10) ships). Reusable across walks and downstream snapshot tests.

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
- **i18n / RTL** — content lengths in non-Latin scripts, RTL layout mirroring. Out of scope.
- **Browser-engine variance** — sampling is Chrome only. Firefox/Safari layout deltas not covered.

These are flagged as audit-debt, not findings.

---

## 2. Audit dimensions matrix

| Component | C₁ | C₂ | C₃ | C₄ | C₅ | C₆ | C₇ | C₈ | C₉ | C₁₀ | C₁₁ | C₁₂ |
|---|---|---|---|---|---|---|---|---|---|---|---|---|
| EnsembleCard | | | | | | | | | | | | |
| PlayerDetail header | | | | | | | | | | | | |
| PlayerTypes cards | | | | | | | | | | | | |
| Hosts table | | | | | | | | | | | | |
| Settings panels | | | | | | | | | | | | |
| TempoStrip | | | | | | | | | | | | |
| Sidebar | | | | | | | | | | | | |
| Workspace chat | | | | | | | | | | | | |
| CreateEnsemble | | | | | | | | | | | | |
| Recruit | | | | | | | | | | | | |
| Page-header | | | | | | | | | | | | |
| Button rows | | | | | | | | | | | | |

Where columns are (viewport × content-regime) cells: C₁ = 1440 × canonical, C₂ = 1440 × longTail, C₃ = 1440 × stress, C₄ = 1180 × canonical, … (12 viewports × 3 regimes = 36 cells per row, but most rows can skip canonical-content cells since pixel audit covers those — effectively ~24 cells per row × 12 rows = 288 cells).

**Sampling efficiency**: most cells will be no-finding. Lead pre-log + recruit walks aim for ~10x compression — only cells with deltas get cataloged.

---

## 3. Token-level alignment

N/A — this audit is impl-self-stress, not impl-vs-canonical. Token alignment is locked by pixel audit §3.

---

## 4. Findings catalog

*[TBD — populated after walks. Will follow pixel-audit §4 shape: lead pre-log section, recruit batches, severity-disposition table per finding.]*

---

## 5. Severity summary

*[TBD]*

---

## 6. Headline findings — what to fix first

*[TBD]*

---

## 7. Cluster proposal

*[TBD — likely 4-7 PR clusters mirroring pixel audit's PR-A through PR-G shape:]*
- PR-α: `min-width: 0` cluster (most common flex-overflow root cause)
- PR-β: `text-overflow: ellipsis` cluster (truncation discipline)
- PR-γ: button-row wrapping cluster (Edit/Duplicate/+New patterns)
- PR-δ: grid track-sizing cluster (auto-fill-minmax variants)
- PR-ε: sidebar er-name truncation cluster
- PR-ζ: chat / message overflow cluster
- PR-η: deferred / wire-pending

Final cluster shape determined by finding distribution.

---

## 8. Open questions

*[TBD — surfaces design-owner ambiguities discovered during walks. Examples that may surface:]*
- Where text gets ellipsis vs wrap — is there a global rule, or is each component's choice intentional?
- Truncation tooltip pattern — should every truncated affordance carry a `title=`?
- `flex-wrap: wrap` vs container scroll for chip groups — design preference?

---

## 9. Appendix

### 9.1 Working artifacts (deleted before PR)

- `_overflow-fixtures.json` — fixture matrix for all walks (committed initially; promoted to `dashboard/test-fixtures/overflow.json` if §10 CI work proceeds)
- `_findings-a.md` — Batch A raw findings (recruit)
- `_findings-b.md` — Batch B raw findings (recruit)
- `_lead-prelog.md` — lead pre-log raw findings

### 9.2 Related docs

- `docs/design/dashboard-pixel-audit-v0.28.9.md` — methodology precedent, token-table proof
- `docs/design/dashboard-audit-389.md` — original audit
- `docs/design/dashboard-audit-389-followup-rev3.md` — structural rev3 cert
- `dashboard/src/styles/components.css` — port re-sync procedure header

---

## 10. Companion — CI guardrail recommendation

*[TBD after walks — finding distribution determines the right tool shape.]*

Three options under evaluation:

| Option | Cost | Catches | Misses |
|---|---|---|---|
| **A. Lightweight `scrollWidth > clientWidth` assertions** in component tests | Low (just JS) | Internal overflow | External overlap (la-tempo-advisor symptom) |
| **B. Playwright + screenshot diff matrix** (fixtures × viewports × components) | Medium (CI minutes + flake risk) | Both modes | Subjective "looks weird" cases |
| **C. Storybook + Chromatic** | Higher (SaaS + Storybook setup) | Both modes + auth-aware change review | n/a |

Recommendation deferred to post-walk synthesis. If 80% of findings are internal-overflow shape, A is enough. If external-overflow dominates (likely given the la-tempo-advisor trigger), B or C is required.

If `tempo-researcher` spikes the option-evaluation in parallel with this audit's walks, we can land a recommendation in the same PR. Otherwise §10 is a forward-pointer.

---

**Sign-off**: TBD — pending walks + consolidation.
