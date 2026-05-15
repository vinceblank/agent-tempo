# #461 Overflow Audit CI Tooling — Research Spike

- **Author**: tempo-researcher
- **Date**: 2026-04-29
- **Branch**: `main` (read-only research, single new doc)
- **Status**: Research spike (Phase A) — feeds tempo-overflow-lead's audit doc §10
- **Time-box**: 60–90 min (target ~75 min)
- **Tracking**: issue #461 (UI overflow + content-length robustness audit)
- **Predecessors / context**:
  - PR #454 — pixel-alignment audit (canonical content × canonical viewports), already merged. Caught fidelity gaps but NOT content-length robustness.
  - [`docs/research/449-opencode-adapter-spike.md`](449-opencode-adapter-spike.md) — format precedent
  - [`.github/workflows/ci.yml`](../../.github/workflows/ci.yml) — existing CI surface; `dashboard-e2e` job already runs Playwright (chromium-desktop, ~2 min wall-clock)
  - [`dashboard/playwright.config.ts`](../../dashboard/playwright.config.ts) — single-browser config with `screenshot: 'only-on-failure'`

---

## TL;DR

1. **The audit's dominant failure class is overlap-into-adjacent-sibling** — not pure `scrollWidth > clientWidth`. The canonical example in #461's body (`la-tempo-advisor` card's `_tools / Edit / Duplicate` row escaping into the next card) is content escaping its container's visual bounds while the host's own scrollbar logic stays clean. **This materially constrains the option-3 (lightweight JS assertions) coverage** — they catch self-overflow, not cross-container overlap.

2. **Lean recommendation: HYBRID (Playwright per-Locator screenshot diffs + JS structural assertions, layered)** — the conductor's optional 4th option becomes the primary call. Rationale: (a) #461 needs visual-diff coverage for overlap-into-adjacent; (b) JS assertions are 10× faster + 0-flake for the structural subset they DO catch; (c) Playwright is already wired into CI (zero new infra); (d) baselines stored in-repo (no SaaS spend until the surface stabilises).

3. **Chromatic OSS-free is likely INELIGIBLE.** Their free-for-OSS tier is gated on "open-source *design systems or UI component libraries*." agent-tempo is an MCP server that ships a dashboard, not a component library. Costing assumes the **paid Starter tier ($179/mo, 35k snapshots/mo, $0.008/extra)**. At a realistic ~30 components × 4 viewports × 3 content regimes = 360 snapshots/run × ~50 PR-and-main runs/mo = ~18k snapshots/mo — fits Starter, *just* fits free if we miraculously qualify.

4. **Phased path lands cheaply — v0 / v1 / v2 staging.**
   - **v0** (ships in ~3-4 hr): JS structural assertions inside a new `dashboard-overflow` Playwright job. Catches class A (self-overflow) reliably and class D (computed-style drift) cleanly. ~150 LoC, 0 baseline images, 0 SaaS spend.
   - **v1** (additional ~3-4 hr, same PR cluster as v0): targeted Playwright per-Locator screenshots layered onto v0's specs for class B (overlap-into-adjacent) and class C (wraps-badly). ~50 baseline PNGs committed in-repo, ~100 LoC additional. Still 0 SaaS spend.
   - **v2** (deferred indefinitely): adopt Storybook + Chromatic. Only worth it if a future audit reveals the dashboard becomes designer-iteration-heavy. Today, no.

   The audit findings drive whether v0 alone is enough (≥70% class A) or v1 is required (mixed/overlap-heavy). v0 + v1 in a single PR cluster is the lean default given today's evidence.

5. **Conditional pivot.** If overflow-lead's findings split toward "≥70% are scrollWidth-shape on the component itself" → drop to JS-only (option 3). If findings are "≥40% are overlap-into-adjacent or wraps-badly" → keep the hybrid. If findings reveal "we need designer review of *every* PR's visuals" → escalate to Storybook+Chromatic (option 2). Today's evidence (the `la-tempo-advisor` instance + the issue's component checklist) leans toward hybrid.

---

## 1. Problem framing — what we're actually trying to catch

### 1.1 The failure-class taxonomy

Reading #461's body and the `la-tempo-advisor` instance closely, the audit space breaks into **five distinct overflow classes**, each with different visibility characteristics:

| # | Class | Example | Detection shape needed |
|---|---|---|---|
| **A** | **Content overflows its own container** (scrollbar appears OR is hidden by `overflow: hidden`) | Long ensemble name in sidebar tile gets clipped; long description in EnsembleCard adds horizontal scroll | `el.scrollWidth > el.clientWidth` (or scrollHeight) — **JS-trivial** |
| **B** | **Content escapes container into adjacent siblings** | `la-tempo-advisor` button row overflowing into next card's pixel space | Bounding-box geometry between siblings — **JS-feasible but tedious**; or pixel diff |
| **C** | **Content wraps badly** (legible but ugly) | 3-column button row wraps to 4 lines on a 1199px laptop boundary | **Visual diff only** — wraps don't trip overflow flags |
| **D** | **Computed-style drift / cascade misfire** | `.player-card` loses its `min-width` rule under a container query → grid collapse | Snapshot of `getComputedStyle` (drift detector) OR pixel diff |
| **E** | **Narrow-viewport collapse / breakpoint boundary** | `1199px` viewport (just below `1200px` container query) → unintended layout pop | Multi-viewport screenshot OR viewport-aware JS assertion |

**The conductor's framing question** ("is this 80% scrollWidth-shape?") maps to: **what fraction of overflow-lead's findings are class A?** Today's evidence (`la-tempo-advisor` = class B; "long player-type names" / "boundary viewports" listed in #461 = mix of A/C/E) suggests **closer to 30-40% pure class A**, which is the threshold where option-3-only stops carrying.

### 1.2 What CI must do (vs what local dev tooling does)

A CI guardrail's job is **regression prevention**, not initial discovery. Initial discovery is the audit walks. CI takes the audit's stable findings and locks them — every PR runs the guard; broken commits get a red X with a diff.

Useful framing: **CI catches regressions on cases the audit found**. So the tooling needs to:

1. **Lock the regimes the audit identified** — content-length × viewport tuples become test cases
2. **Run cheaply per-PR** — current `dashboard-e2e` job is ~2 min; the budget for visual-regression on top of that is ~2-3 min before reviewers complain
3. **Produce reviewable failures** — when something breaks, a reviewer needs to see *what* broke, not just `expect(x).toBe(y)` failures

### 1.3 Constraints inherited from the existing repo

- **Vite + React 19 + Tailwind 4** dashboard stack (`dashboard/package.json`)
- **Playwright 1.50+** already installed for `dashboard-e2e` smoke pack — chromium-desktop, serial workers, retain-on-failure trace/screenshot
- **No Storybook today** — adding it is net-new infra (~300-500 LoC of stories + config + a new CI job)
- **Vitest is the unit-test runner** for `dashboard/tests/` — it has snapshot support out-of-box (text snapshots, not visual)
- **CI is GitHub Actions on Ubuntu + Windows** — Playwright snapshots are platform-specific (`-chromium-linux.png` vs `-chromium-darwin.png`); Linux baselines are the only ones that need committing if CI runs Linux-only

---

## 2. Coverage matrix — which tool catches which class

Score key: ✅ (catches reliably), 🟡 (catches with caveats), ❌ (misses).

| Class → / Tool ↓ | A: self-overflow | B: overlap-adjacent | C: wraps-badly | D: computed-style drift | E: viewport-boundary |
|---|---|---|---|---|---|
| **1. Playwright per-Locator screenshot matrix** (component × viewport × content-regime, `toHaveScreenshot()` on Locator) | ✅ catches as visual diff | ✅ catches as visual diff | ✅ catches as visual diff (this is its sweet spot) | 🟡 catches *visible* drift; misses computed-style-only drift | ✅ each viewport is a test case |
| **2. Storybook + Chromatic** | ✅ visual diff | ✅ visual diff | ✅ visual diff (best reviewer UX of the three) | 🟡 visible drift | ✅ Chromatic supports viewport mode arrays |
| **3a. JS structural assertions — narrow** (`scrollWidth > clientWidth` shape only, the dispatch's framing) | ✅ trivially | ❌ blind to overlap-into-sibling | ❌ wraps don't trip overflow flags | 🟡 only via separate `getComputedStyle` snapshot (not the dispatch's framing) | ✅ `page.setViewportSize` + assertion |
| **3b. JS structural assertions — broad** (3a + bbox-overlap math + `getComputedStyle` snapshots) | ✅ | 🟡 cross-element bbox math, ~30 LoC per check pattern | ❌ wraps don't trip overflow flags | ✅ best-in-class via `getComputedStyle` snapshots | ✅ |
| **4. Hybrid** (option 3 fast pass + option 1 targeted screenshots for A/B/C-visible cases) | ✅ via JS | ✅ via screenshot OR cross-bbox JS | ✅ via screenshot | ✅ via JS computed-style | ✅ via either layer |

**Reading the matrix:**
- **Option 3a (narrow JS, the dispatch's framing) is materially weaker than the dispatch's con-list suggested.** Pure `scrollWidth > clientWidth` assertions are blind to class B (overlap-into-adjacent — the dominant failure shape per the `la-tempo-advisor` example) and class C (wraps-badly). They lock class A only.
- Option 3b (broad JS — same family, just measured bigger) recovers class D coverage and partial class B coverage at the cost of ~30 LoC per cross-element check. Class C remains unrecoverable at the JS layer.
- Pure option-1 (Playwright screenshots) covers everything but pays for it: slowest, most flake-prone, biggest baseline-management overhead.
- Pure option-2 (Storybook + Chromatic) covers visual classes well but has the largest setup cost and a recurring SaaS bill.
- **Option-4 (hybrid) is the only configuration where every class has at least one ✅ at a defensible cost** — the structural pass uses 3b for cheap classes (A/D), the visual pass uses 1 for hard classes (B/C). Cross-class coverage without paying full price for either layer.

---

## 3. Cost analysis

### 3.1 Direct $ cost (annualised, 12-month horizon)

Assumes **~30 components** × **~4 viewports** × **~3 content regimes** = ~360 test cases.

| Option | Per-PR runs/mo | Snapshots/run | Snapshots/mo | Tier | $/mo | $/yr |
|---|---|---|---|---|---|---|
| **1. Playwright matrix (in-repo baselines)** | ~50 | 360 | 18,000 | n/a — local artifacts | **$0** | **$0** |
| **2a. Chromatic — paid Starter** (free OSS likely ineligible — see §3.4) | ~50 | 360 | 18,000 | Starter | $179 | **$2,148** |
| **2b. Chromatic — free OSS** (IF eligible) | ~50 | 360 | 18,000 | Free OSS | $0 | **$0** |
| **3. JS assertions only** | unlimited | n/a | n/a | n/a | **$0** | **$0** |
| **4. Hybrid (Playwright + JS)** | ~50 | ~120 (only the visual-needed cases) | 6,000 | n/a | **$0** | **$0** |

**Key callouts:**
- Option 1's "0$" hides the baseline-storage cost — ~360 PNGs at ~50KB each = ~18MB committed to the repo, manageable but real
- Option 2 is the only option with a recurring SaaS bill
- Option 4 cuts the visual snapshot count by ~3× by only using screenshots for cases where JS can't catch the failure

### 3.2 Setup time (LoC + hours)

Calibrated against the actual project structure:

| Item | Option 1 | Option 2 | Option 3 | Option 4 (hybrid) |
|---|---|---|---|---|
| **Config files** | extend `dashboard/playwright.config.ts` (~10 LoC for snapshot defaults: `maxDiffPixels`, `threshold`, `animations: 'disabled'`) | new `.storybook/main.ts` (~30 LoC) + `.storybook/preview.ts` (~30 LoC) + `chromatic.yml` GitHub Action (~25 LoC) | none — JS lives inside existing test files | extend `dashboard/playwright.config.ts` (~10 LoC) + a `dashboard/tests/_helpers/overflow-assertions.ts` (~40 LoC) |
| **Test authoring** | ~360 `expect(locator).toHaveScreenshot('component-viewport-regime.png')` calls in `dashboard/tests-overflow/*.spec.ts` (~25 LoC per spec × ~12 spec files = 300 LoC) | ~30 stories at ~25 LoC each = 750 LoC + Chromatic story-level args for content regimes (~5 LoC per story) = ~900 LoC | ~30 components × ~5 assertions each in vitest specs = ~150 LoC | ~150 LoC of JS assertions (option 3) + ~100 LoC of targeted Playwright screenshots (~10 specs only for class C cases) = 250 LoC |
| **Baseline-image initial generation** | ~30 min wall-clock to generate, review, commit ~360 PNGs | ~20 min — Chromatic's "accept all" UI for first run | n/a | ~20 min — generate ~50 PNGs only for visual-needed cases |
| **Storybook scaffold (option 2 only)** | n/a | ~3 hours initial (deps, framework config, vite alias parity, Tailwind 4 integration check, eslint config) | n/a | n/a |
| **CI plumbing** | ~30 LoC delta to `ci.yml` (extend existing `dashboard-e2e` job OR clone for new `dashboard-overflow-e2e` job — see §4) | ~50 LoC: new `dashboard-storybook-build` + `chromatic-publish` jobs + secret management (`CHROMATIC_PROJECT_TOKEN`) | ~5 LoC — extends existing vitest job | ~30 LoC delta to `ci.yml` |
| **Total dev hours** | ~6-8 hrs | ~12-16 hrs | ~3-4 hrs | ~7-9 hrs |
| **Total LoC delta** | ~310 | ~990 | ~155 | ~260 |

### 3.3 Ongoing maintenance burden

| Burden | Option 1 | Option 2 | Option 3 | Option 4 |
|---|---|---|---|---|
| **Baseline drift** (designer ships intentional change → all baselines need refresh) | HIGH — ~360 PNGs to review and commit per intentional change | LOW — Chromatic's UI-driven approval is purpose-built for this | NONE (no baselines) | MEDIUM — ~50 PNGs to review per intentional change |
| **Story authoring lag** | n/a | HIGH — every new component needs a story, and content-regime args must stay in lockstep with the component's prop surface | n/a | n/a |
| **Flake triage** | MEDIUM-HIGH — pixel diffs are flake-prone (anti-aliasing, font rendering, animations) without strong defaults | MEDIUM — Chromatic has its own anti-flake heuristics + `delay`/`disableSnapshot` knobs per story | NONE — JS assertions are deterministic | LOW — only ~50 visual cases × strong defaults (`maxDiffPixels: 50`, `threshold: 0.2`, `animations: 'disabled'`) |
| **CI cost growth** (snapshots × monthly runs) | LINEAR with surface | LINEAR with surface, capped by tier | n/a | LINEAR but ~3× smaller than option 1 |
| **Cross-platform headache** (CI Linux baselines vs dev macOS/Windows local runs) | YES — local dev sees `-chromium-darwin.png`/`-win32.png` mismatches against committed `-linux.png`; standard mitigation is `--update-snapshots` only on Linux CI in a special workflow | YES (same shape, but Chromatic's hosted runner sidesteps it for the canonical baseline) | NONE | YES (same as option 1, smaller surface) |

### 3.4 Why Chromatic OSS-free is likely INELIGIBLE

Per [Chromatic's open-source sponsorship docs](https://www.chromatic.com/docs/open-source/) (validated 2026-04-29): the free OSS tier is restricted to "open-source design systems or UI component libraries." Eligible examples cited: government component libraries, large-org design systems.

agent-tempo is an MCP server with a bundled dashboard — *not* a design system or component library. Eligibility is **probable no** without a special arrangement. The recommendation thus must assume **paid Starter ($179/mo, $2,148/yr)** as the realistic cost — not zero.

There's a nonzero chance Chromatic accepts our application anyway (they decide case-by-case via in-app chat), but planning around the "lucky outcome" is irresponsible cost analysis.

---

## 4. Integration fit — concrete CI delta

### 4.1 Existing CI surface (recap)

From `.github/workflows/ci.yml`:

```
lint-test-ensemble        (Linux, fast)
lint-surface-drift        (Linux, fast)
dashboard-build           (Linux, ~3 min: install + lint + vitest + build + size-limit)
dashboard-e2e             (Linux, ~2 min: Playwright chromium smoke pack)
build-and-test            (Linux × node 20/22/24 × shard 1/2 = 6 parallel jobs)
test-tui                  (Linux × node 20/22/24)
build-and-test-windows    (Windows × shard 1/2)
shard-drift-check         (Linux, gate)
lint-commits              (Linux, fast, PRs only)
```

The natural integration is **inside `dashboard-e2e`** OR **as a clone job named `dashboard-overflow`**. Both are evaluated below.

### 4.2 Option 1 — Playwright matrix integration

**Path A: extend `dashboard-e2e`**
- ✅ Reuses cached Playwright chromium binary, cached `dashboard/node_modules`, root `node_modules`
- ✅ Single playwright report artifact on failure
- ❌ Test wall-clock grows from ~2 min → ~5-7 min (with 360 component-screenshot tests). PR feedback loop slower.
- ❌ A failing visual diff blocks the smoke-pack tests' signal until the run completes

**Path B: clone to `dashboard-overflow`** (per the existing comment in ci.yml about job-cloning Playwright setup)
- ✅ Wall-clock parallel — total CI time unchanged, just adds a new job
- ✅ Independent failure signal (smoke vs overflow diff are conceptually separate)
- ❌ Cache duplication (Playwright browser cache key is the same, but the job downloads its own copy of root + dashboard node_modules); cost adds ~1.5 min of "install" overhead
- ❌ ~50 additional LoC of CI YAML; the `dashboard-build` job's setup-step list must be copied (per the existing #368 footgun warning in ci.yml comments)

**Lean for option 1: Path B (clone job).** The wall-clock parallelism dominates; the ~1.5 min install overhead per job is dwarfed by the ~5 min of overflow tests that would otherwise run serially after the smoke pack.

### 4.3 Option 2 — Storybook + Chromatic integration

Two new CI jobs:

```yaml
storybook-build:
  needs: lint-test-ensemble
  steps:
    - npm ci --ignore-scripts (root deps for path-alias)
    - npm --prefix dashboard ci
    - npm --prefix dashboard run build-storybook  # outputs storybook-static/
    - upload storybook-static as artifact

chromatic-publish:
  needs: storybook-build
  steps:
    - download storybook-static artifact
    - npx chromatic --project-token=${{ secrets.CHROMATIC_PROJECT_TOKEN }} --storybook-build-dir=storybook-static
```

**Pros**: Chromatic's UI is genuinely the best reviewer experience among the three options. PR diffs visualise side-by-side with one-click accept.

**Cons**:
- New SaaS dep, new secret to manage, new attack surface (Chromatic project token leak = ability to publish builds and consume snapshot quota)
- Storybook adds ~3 hrs of upfront setup + a recurring "every new component needs a story" tax
- `chromatic-publish` runs on every PR; a hostile fork could exhaust the snapshot quota (mitigation: `pull_request_target` gating + skip on forks, ~10 LoC additional)
- The existing `dashboard-build` job's bundle-budget check (`size-limit`) doesn't include Storybook's bundle — Storybook can grow unchecked unless we add a separate budget

### 4.4 Option 3 — JS assertions integration

Lives inside `dashboard-build`'s existing `npm --prefix dashboard run test` step (Vitest). No new CI surface.

**Pros**: Zero CI delta. Runs as part of an existing job. ~5 LoC of vitest config tweak (jsdom needs computed-style polyfill consideration — `getComputedStyle` works in jsdom but `getBoundingClientRect` returns zeros without explicit layout simulation).

**Cons**: jsdom's layout fidelity is limited. **`getBoundingClientRect()` returns `{0, 0, 0, 0}` by default in jsdom** unless tests use a real browser environment. This means JS assertions for overflow detection MUST run in a real browser — i.e., in Playwright, not vitest. So "option 3 only" actually requires the same Playwright-driven lifecycle as options 1 and 4, just with assertions instead of screenshots. **This significantly weakens option 3's "no infra" claim.**

**Revised option 3 integration**: extend `dashboard-e2e` (or clone to `dashboard-overflow`) to run a `*.overflow.spec.ts` suite that uses Playwright's page evaluation to query `scrollWidth/clientWidth/getBoundingClientRect` — same CI shape as option 1, but with assertions instead of `toHaveScreenshot`.

This is a meaningful corrective on option 3's "ultra-fast / no flake" framing: **it's still fast and flake-free per assertion, but it needs Playwright to run them. Vitest+jsdom alone can't do real layout.**

### 4.5 Option 4 — Hybrid integration

Same shape as option 1 + 3 combined: extend or clone the `dashboard-e2e` job to run a unified `*.overflow.spec.ts` suite that mixes structural assertions and targeted screenshots.

```ts
// dashboard/tests-overflow/ensemble-card.overflow.spec.ts
test('EnsembleCard at long-tail content × laptop viewport', async ({ page }) => {
  await page.setViewportSize({ width: 1180, height: 800 });
  await page.goto(`${origin}/__overflow/EnsembleCard?regime=long-tail`);

  const card = page.getByTestId('ensemble-card-long-tail');

  // (Class A) — fast structural check
  const overflows = await card.evaluate((el: HTMLElement) =>
    el.scrollWidth > el.clientWidth || el.scrollHeight > el.clientHeight,
  );
  expect(overflows).toBe(false);

  // (Class B) — neighbour bbox overlap check
  const sibling = page.getByTestId('ensemble-card-canonical');
  const [a, b] = await Promise.all([card.boundingBox(), sibling.boundingBox()]);
  expect(rectOverlap(a, b)).toBe(false);

  // (Class C) — visual diff (ONLY for components flagged as wrap-prone in the audit)
  await expect(card).toHaveScreenshot('ensemble-card-laptop-longtail.png', {
    maxDiffPixels: 50,
    threshold: 0.2,
    animations: 'disabled',
    caret: 'hide',
  });
});
```

**Integration delta**: clone `dashboard-e2e` to `dashboard-overflow` (Path B from §4.2) for wall-clock parallelism. Same CI surface as option 1; smaller baseline footprint than option 1; richer failure detection than option 3.

**One non-obvious infrastructure need**: a **`/__overflow/<Component>?regime=...`** route inside the dashboard's dev/test build that mounts a single component with deterministic props. This is a Storybook-lite — ~50 LoC of router config + component-prop-shimming utility. **Cost is real and should be counted in option 4's setup time** (counted in the §3.2 row).

---

## 5. Recommendation matrix — 5 axes × 4 tools

Score each axis 1 (worst) to 5 (best). Weighted total uses the column weights in row 1.

| Axis (weight) | 1. Playwright matrix | 2. Storybook + Chromatic | 3. JS assertions only | 4. **Hybrid** |
|---|---|---|---|---|
| **Catch-all coverage** (×3) | 5 — covers all 5 classes | 5 — covers all 5 classes | 2 — misses C entirely, partial on B | 5 — covers all 5 classes |
| **Total cost** (× $ + setup) (×2) | 4 — $0 SaaS, ~7 hrs setup | 1 — $179/mo + ~14 hrs setup | 5 — $0, ~3-4 hrs setup (caveat: needs Playwright to run anyway, so net ≈ ~5 hrs) | 4 — $0, ~8 hrs setup |
| **Flake resistance** (×2) | 2 — pixel diffs flake without strong defaults; full surface = lots of flake surface | 3 — Chromatic has anti-flake heuristics but pixel diffs are still pixel diffs | 5 — JS assertions are deterministic | 4 — only ~50 visual cases × strong defaults; structural pass takes the bulk of the load |
| **Reviewer UX** (PR diff approval flow) (×2) | 2 — Playwright report artifact is a download-and-open-locally chore; OK once you're used to it | 5 — Chromatic's UI is the gold standard, side-by-side diff with one-click approve | 1 — assertion failures show "expected false, got true"; no visual context | 3 — same as option 1 for the visual subset; structural failures get a clean assertion message |
| **Dev ergonomics** (write-test-locally loop) (×1) | 3 — `--update-snapshots` works, but `chromium-darwin` baselines diverge from CI's `-linux` until you sync | 4 — `npm run storybook` is a real win for component dev; Chromatic CLI runs locally but updates the cloud baseline | 4 — vitest-style assertions, fast loop | 3 — same caveats as option 1 for visual cases |
| **Weighted total** | **3 × 5 + 2 × 4 + 2 × 2 + 2 × 2 + 1 × 3 = 34** | **3 × 5 + 2 × 1 + 2 × 3 + 2 × 5 + 1 × 4 = 37** | **3 × 2 + 2 × 5 + 2 × 5 + 2 × 1 + 1 × 4 = 32** | **3 × 5 + 2 × 4 + 2 × 4 + 2 × 3 + 1 × 3 = 40** |

Numerical winner: **Hybrid (40)**. Option 2 (Storybook+Chromatic) places second on score but loses on the cost axis ($179/mo recurring is a non-trivial sentence to write into the project's budget); option 1 places third (paying for full visual surface when only a subset needs visual coverage); option 3 places last (catch-all coverage gap is unfixable).

The matrix's tie-break favours the option that doesn't commit the project to a recurring SaaS bill or to a setup investment that could be over-engineered for the eventual finding shape.

---

## 6. Lean recommendation

### 6.1 Primary call: phased Hybrid (v0 → v1, defer v2)

**v0 — JS structural assertions (3b, broad) in a new `dashboard-overflow` Playwright job.** Land this in the same PR cluster that fixes the audit's P1 findings:

- Clone `dashboard-e2e` job → `dashboard-overflow` (Path B from §4.2)
- Add `dashboard/tests-overflow/*.overflow.spec.ts` files, one per audited component
- Each spec asserts: (class A) `scrollWidth/clientWidth` ratio, (class B partial) `boundingBox()` non-overlap with named siblings, (class D) `getComputedStyle` snapshot of layout-critical properties
- ~150 LoC, ~0 baseline images, ~3-4 hr work
- **Locks every audit finding that doesn't require visual judgment.** If overflow-lead's findings split ≥70% class A/D, v0 may be enough on its own.

**v1 — Targeted Playwright screenshots for class-C cases (and any class-B cases that bbox math can't resolve).** In the same PR cluster as v0 (not a separate quarter):

- Add `expect(locator).toHaveScreenshot(...)` calls only to specs for components the audit flagged as wrap-prone or aspect-ratio-sensitive
- Strong anti-flake defaults at the Playwright config level: `toHaveScreenshot: { maxDiffPixels: 50, threshold: 0.2, animations: 'disabled', caret: 'hide' }`
- ~50 baseline PNGs committed to repo, ~100 LoC additional, ~3-4 hr work
- Locks the visual-judgment cases

**v2 — Defer Storybook+Chromatic.** Only adopt if a future audit reveals that **>50% of dashboard work is design-iteration where every PR needs designer review** — which today's audit explicitly is not (this is a one-shot regression hunt + lock-in, not a design-iteration cadence). The recurring $179/mo bill plus ~14 hrs of Storybook scaffolding is not justified by today's failure-class shape.

### 6.2 Conditional pivot (per dispatch)

The conductor asked for a recommendation conditioned on overflow-lead's findings. Three branches:

| If overflow-lead's findings show… | …then recommend | Rationale |
|---|---|---|
| **≥70% class A (self-overflow)** | **v0 only** — drop the v1 screenshot layer | Class C and B are too small a slice to justify visual baseline maintenance |
| **40-70% class A; rest mixed across B/C/D** | **v0 + v1 (this recommendation's lean)** | Today's evidence (la-tempo-advisor + #461 component checklist) lands here |
| **<40% class A; ≥30% class C wraps-badly + many computed-style cases** | v0 + v1, with v1 expanded to most components (gateway to v2) | Visual judgment dominates; the marginal Storybook setup may pay off if this finding repeats on a future audit |
| **>30% class B overlap-into-adjacent only** | v0 + v1, with bbox-overlap helpers extracted to `_helpers/overflow-assertions.ts` for reuse | Class B is a JS-feasible-but-tedious shape; a helper library amortises the per-spec cost |

The "trigger" between branches is empirical and easy for overflow-lead to compute once their walks complete — categorise findings into A/B/C/D/E, count, pick the branch.

### 6.3 What the deliverable looks like for the rest of the team

- **Architect**: 3-5 design questions surface from this — should `/__overflow/` test routes ship in the prod dashboard bundle (no — dev-only), should the bbox-overlap helper become a public Playwright matcher (yes if reused 3+ times), where does the "visual judgment subset" boundary live (decided per-component by overflow-lead)
- **Engineer (overflow PR cluster)**: ~250 LoC of test code + ~30 LoC of CI YAML + ~50 LoC of `/__overflow/` route shim + ~50 baseline PNGs. Comparable in scope to the pixel-audit cluster (#454).
- **DevOps**: one new CI job (`dashboard-overflow`), no new secrets, no new external service. Cache reuse with `dashboard-e2e` keeps the install overhead small.
- **QA**: per-component overflow test inventory becomes a reviewable artifact — every audit finding has a spec, every spec is one-line-mappable to the finding it locks.

---

## 7. Open questions / handoff to overflow-lead (§10 of audit doc)

These are the things I deferred to the audit findings + the architect's call:

| # | Question | When it gets decided |
|---|---|---|
| Q1 | What's the actual A/B/C/D/E split in overflow-lead's findings? | After audit walks complete; drives the §6.2 conditional branch |
| Q2 | How many components need *only* class-A coverage vs need class-C visual coverage? | Per-component during audit; determines v1's PNG budget |
| Q3 | Should `/__overflow/<Component>?regime=…` test routes be exposed in the production dashboard bundle? | Architect — lean: no, gate on `import.meta.env.DEV` so they tree-shake out of `npm run build` |
| Q4 | Should the bbox-overlap helper become a public Playwright matcher (e.g., `expect(card).not.toOverlap(neighbour)`)? | After ≥3 specs use it; refactor when it's clearly a pattern |
| Q5 | What's the right baseline-refresh cadence when designer ships intentional changes? | DevOps + designer convention; Playwright's `--update-snapshots` flag is the mechanism, the question is whether to bot it (recommend: manual on first 2 cycles, then evaluate) |
| Q6 | Cross-platform baseline strategy — commit Linux baselines only, or platform-suffix all of them? | DevOps + CI strategy. Lean: **Linux-only baselines**, with a `dashboard/tests-overflow/README.md` documenting the `npm run test:e2e -- --update-snapshots` workflow for local dev (warns devs that `darwin/win32` PNGs are ignored by CI) |
| Q7 | Snapshot storage location — `dashboard/tests-overflow/__snapshots__/` (Playwright default) or a separate top-level `dashboard/snapshots/` for easier reviewer browsing? | Engineer — lean: Playwright default, no exotic restructuring |

---

## 8. Risks + unknowns

### 8.1 Risk: v1 visual subset balloons

If overflow-lead's class-C findings come in larger than expected (>40% of total findings), the visual snapshot count blows past ~50 and we're in option-1 territory by accident. **Mitigation**: spike a sample 10 specs once findings settle, extrapolate, escalate to architect if budget breach is forecast.

### 8.2 Risk: Cross-platform baseline drift bites local dev

Linux-only baselines means `chromium-darwin.png` and `chromium-win32.png` are forever out of sync with CI. Devs running tests locally see false failures unless they remember to use the `--ignore-snapshots` or `--platform-baseline` workflow. **Mitigation**: dashboard-tests-overflow/README.md prescribes the local-dev flow; CI's `dashboard-overflow` job is the authoritative baseline source.

### 8.3 Risk: `/__overflow/` route shim leaks into production bundle

If the test route file lives outside an `import.meta.env.DEV` gate, `vite build` ships it and bloats the production bundle. **Mitigation**: gate at the route level (the route definition itself only registers in DEV); add a `size-limit` budget delta < 1KB to catch regressions.

### 8.4 Unknown: Playwright + Tailwind 4 container queries — flake interaction

Tailwind 4's `@container` rules fire based on container size, not viewport. If a Playwright test sets `setViewportSize` but the container query reads from a non-root element's width, the screenshot may capture mid-resize state. **Verify at impl time**: take the same screenshot 3× in a row, confirm pixel-identical.

### 8.5 Unknown: jsdom-vs-real-browser layout drift

Per §4.4, `getBoundingClientRect()` doesn't work in jsdom without explicit layout. The v0 JS-assertion plan must use Playwright's `page.evaluate()` to run assertions in a real chromium, NOT vitest. **Confirmed before recommending — this corrects the dispatch's option-3 framing.**

### 8.6 Unknown: Chromatic OSS-free eligibility

§3.4 reasons it's "probable no" but Chromatic decides case-by-case. **Mitigation**: cost the recommendation against paid Starter; if it later turns out we qualify for free, we save $2,148/yr — that's an upside surprise, not a downside risk.

---

## 9. Effort estimate (v0 + v1 combined, the lean recommendation)

| Area | LoC range | Notes |
|---|---|---|
| `dashboard/tests-overflow/*.overflow.spec.ts` (~12 spec files, one per audited component family) | 250–350 | JS assertions + targeted screenshots inline |
| `dashboard/tests-overflow/_helpers/overflow-assertions.ts` (bbox-overlap, computed-style snapshot, scrollWidth check) | 60–100 | Extracted helpers reused across specs |
| `dashboard/src/__overflow/routes.tsx` (DEV-only test routes mounting components in known regimes) | 80–150 | One route per audited component family + a regime selector via query param |
| `dashboard/playwright.config.ts` extension (default snapshot options) | 10 | `expect.toHaveScreenshot` defaults |
| `.github/workflows/ci.yml` clone job → `dashboard-overflow` | 50–80 | Mirror `dashboard-e2e` setup; new job in `needs: dashboard-build` chain |
| Baseline PNGs (committed, Linux-only) | n/a (binary) | ~50 PNGs × ~50KB = ~2.5 MB repo growth |
| `dashboard/tests-overflow/README.md` (local-dev baseline flow + cross-platform note) | n/a | Documentation |
| **Total** | **~450–690 LoC** | Comparable to a moderate PR cluster (similar shape to `pair-token` flow's surface) |

---

## Appendix A: Code pointers + reference implementations

- [`.github/workflows/ci.yml`](../../.github/workflows/ci.yml) — existing `dashboard-build` + `dashboard-e2e` jobs to clone from
- [`dashboard/playwright.config.ts`](../../dashboard/playwright.config.ts) — current Playwright config (chromium, serial, retain-on-failure)
- [`dashboard/e2e/smoke.spec.ts`](../../dashboard/e2e/smoke.spec.ts) — existing e2e patterns (route mocking, mobile viewport, testid assertions). Mobile viewport test (test 3) is a near-template for the overflow specs.
- [`dashboard/e2e/test-daemon.ts`](../../dashboard/e2e/test-daemon.ts) — reusable in-process daemon harness for overflow specs
- [`dashboard/package.json`](../../dashboard/package.json) — shows current dep landscape (Vite 8, React 19, Tailwind 4, vitest 2.1, @playwright/test 1.50, no Storybook)
- [`docs/research/449-opencode-adapter-spike.md`](449-opencode-adapter-spike.md) — format precedent (TL;DR → §-numbered → effort table → risks → appendix)
- [`docs/design/dashboard-pixel-audit-v0.28.9.md`](../design/dashboard-pixel-audit-v0.28.9.md) — predecessor audit (PR #454); overflow audit will mirror its PR-cluster shape

## Appendix B: External sources consulted (2026-04-29)

- [Chromatic Pricing](https://www.chromatic.com/pricing) — Free $0/5k snapshots, Starter $179/35k, Pro $399/85k, $0.008/extra
- [Chromatic Open-Source Sponsorships](https://www.chromatic.com/docs/open-source/) — eligibility gated on "design system or component library"
- [Playwright `toHaveScreenshot` (Locator)](https://playwright.dev/docs/api/class-locatorassertions#locator-assertions-to-have-screenshot-1) — full option list, default `threshold: 0.2`, `animations: 'disabled'`, `caret: 'hide'`, `mask`, `maxDiffPixels`
- [Playwright Visual Comparisons docs](https://playwright.dev/docs/test-snapshots) — baseline storage `*-snapshots/` with platform suffix, `--update-snapshots` flag
- [Storybook for React with Vite docs](https://storybook.js.org/docs/get-started/frameworks/react-vite) — `@storybook/react-vite` framework setup
- [#461 issue body](https://github.com/.../issues/461) — failure class taxonomy validation source
