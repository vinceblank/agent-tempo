# dashboard/tests-overflow

CI guardrail for the #461 dashboard overflow + content-length robustness audit
(`docs/design/dashboard-overflow-audit-v0.28.10.md`).

## What this suite catches

The audit walked 14 hypotheses across the dashboard's layout primitives. The
walk produced 13 actionable findings (5 P1, 7 P2, 1 P3), 4 cleanly-refuted
hypotheses, and 2 P3-adjusted-monitor entries. This suite encodes both:

- **Confirmed findings as failing-until-fix assertions** — the assertion
  asserts the post-fix state. PR-α (the CSS cluster fix) flips them green.
- **Refutations + P3-adjusted monitors as passing-assertions** — locks the
  proven-safe patterns against regression. Per audit §1.4 (c) "refutation-
  as-regression-detector": refutations have shelf life longer than
  confirmations because the patterns we proved currently safe could regress
  under future code changes.

| Spec file | Coverage | Source walker |
|---|---|---|
| `cards-headers-wizards.overflow.spec.ts` | Batch A — EnsembleCard, PageHeader, PlayerTypes, PickerList, PlayerSheet | tempo-qa |
| `tables-sidebar-chat.overflow.spec.ts` | Batch B — Sidebar, Hosts table, panel-head, FeedMessage, Settings KV, Loadouts/Schedules tables, generic `.row` | tempo-researcher |

## Running locally

```bash
# 1) Build the dashboard (so /dashboard/assets/components.css exists)
npm --prefix dashboard run build

# 2) Run the overflow suite
npm --prefix dashboard run test:overflow

# Or run a specific spec:
npx --prefix dashboard playwright test \
  --config dashboard/tests-overflow/playwright.config.ts \
  tests-overflow/cards-headers-wizards.overflow.spec.ts
```

The `playwright.config.ts` here spawns a `vite preview` web server pointed at
`dashboard/dist/` so the specs' CSS imports resolve. No daemon required —
each spec injects DOM via `page.evaluate` / `page.setContent`.

## CI status — staged rollout

This is the **v0** of the audit's recommended hybrid v0+v1 path (audit
§10.1). What v0 covers:

- ✅ JS-only structural assertions (class A self-overflow via `scrollWidth >
  clientWidth + 1`)
- ✅ JS bbox-math assertions for class B sibling escape (e.g. F-A-5
  EnsembleCard auto-P1)
- ✅ Refutation regression locks (H4A, H10, H11, H13)
- ✅ P3-adjusted monitors (H12, H14)
- ✅ Post-fix regression locks for stress-only confirmations (F-A-2 stress,
  F-A-3 stress) — PR-α (#489) shipped the fixes; these tests assert the
  fix didn't regress
- ✅ Playwright `toHaveScreenshot` defaults configured (audit §10.3 step 2)

What v0 defers — see follow-up issues filed on PR-merge:

- ⏳ **Route shim** (audit §10.3 step 4) — `dashboard/src/__overflow/routes.tsx`
  to bypass live ensemble seeding for Walk A's nav-driven specs. Without this,
  Walk A tests `test.skip()` when no seeded data is present in the dashboard.
  Walk B (which uses `page.setContent`) runs regardless.
- ⏳ **Initial baseline PNGs** (audit §10.3 step 6) — `npm run test:overflow
  -- --update-snapshots` on Linux CI to commit baselines for the v1 visual
  layer. Adds ~50 PNGs / ~2.5 MB repo growth per researcher's #474 §9.
- ⏳ **v1 `toHaveScreenshot()` calls** — layered onto F-A-5, F-A-6, F-B-3,
  F-B-NEW-2 specs once baselines exist (audit §10.3 step 3).

**PR-α (#489) is on main**: all 13 confirmed-finding assertions assert the
post-fix state and pass. The `dashboard-overflow` CI job has strict gating
(no `continue-on-error`). Refutation regression locks (H4A, H10, H11, H13,
H12, H14) protect proven-safe patterns against future regression.

## Daemon-availability behavior

CI runs `vite preview` to serve `dashboard/dist/` but does **not** start a
Temporal worker daemon. Both test methodologies now run unconditionally
against the daemon-free CI environment:

- **Walk B specs** (`tables-sidebar-chat.overflow.spec.ts`) use
  `about:blank` + `page.setContent()` with an absolute CSS URL —
  truly daemon-independent.
- **Walk A specs** (`cards-headers-wizards.overflow.spec.ts`) navigate
  through the dev-only `/__overflow/<Component>?regime=<…>` route shim
  (#492). The shim pre-seeds TanStack Query caches from the bundled
  fixture catalog in `src/lib/overflow-fixtures.ts` BEFORE mounting
  the target screen, so the screens render with realistic per-regime
  content — no `/v1/*` calls, no daemon required. Walk A's
  `gotoOverview` / `gotoCreateEnsemble` / `gotoPlayerTypes` helpers
  drive this; each accepts an optional `regime` argument
  (`'short' | 'long' | 'i18n' | 'stress'`, defaults to `'short'`).

The shim route is gated behind `import.meta.env.DEV` in `router.tsx`
so vite's production build dead-code-eliminates the entire shim path
— `npm run build` ships zero bytes of overflow-test code.

## Folder structure

```
tests-overflow/
├── README.md                                       # this file
├── playwright.config.ts                            # separate config (testDir, webServer, screenshot defaults)
├── fixtures.ts                                     # re-exports from ../test-fixtures/overflow.json
├── cards-headers-wizards.overflow.spec.ts          # Batch A (graduated from walker branch)
└── tables-sidebar-chat.overflow.spec.ts            # Batch B (graduated from walker branch)
```

## Patterns

### Two measurement classes (per researcher's #474 §1.1 taxonomy)

**Class A — overflow own container**:
```js
const overflowing = el.scrollWidth > el.clientWidth + 1;
```

**Class B — escape into adjacent sibling**:
```js
const aBox = elA.getBoundingClientRect();
const bBox = elB.getBoundingClientRect();
const overlapping = aBox.right > bBox.left;
```

Class B is structurally invisible to JS-only `scrollWidth` checks because
the offending element doesn't overflow ITS container — it bleeds past into
a neighbor's space (the audit's headline F-A-5 EnsembleCard auto-P1 case).
Bbox math closes that gap; v1 visual screenshots provide additional
defense-in-depth where bbox geometry alone can't disambiguate.

### Refutation-as-regression discipline

When a hypothesis is refuted, encode the refute-confirming assertion in
the spec — not just a prose "no finding" entry in the audit doc. Per
audit §1.4 (c): walk-product → CI-product transition with strictly
higher carrying value. The assertion locks the proven-safe pattern
against future regression.

Example — H10 (`.page-pills` × `.page-actions` collision refuted by
`grid-template-columns: 1fr auto` separation):

```ts
test.describe('H10 — page-pills × page-actions collision (refuted)', () => {
  // 6 boundary viewports, each asserts pills.right ≤ actions.left
});
```

If a future PR accidentally regresses the `grid-template-columns: 1fr auto`
rule, the H10 tests catch it.

## Updating the suite

When adding new findings to the audit doc, add corresponding tests here
following the F-X-N naming convention (F-A-N for cards/headers/wizards,
F-B-N for tables/sidebar/chat). Refutations get the same treatment —
encode the assertion that locks the proven-safe pattern.

The fixture surface is `dashboard/test-fixtures/overflow.json`. Re-export
canonical content values via `fixtures.ts` rather than inlining strings
in spec files — that way a future audit can update the fixture once and
have all specs re-pin.
