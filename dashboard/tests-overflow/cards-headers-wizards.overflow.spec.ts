/**
 * Dashboard overflow guardrail — cards / headers / wizards (Batch A
 * coverage from #461 audit).
 *
 * Audit: `docs/design/dashboard-overflow-audit-v0.28.10.md`
 * Walker: tempo-qa
 * Promoted from: `audit/461-walk-a:dashboard/tests-overflow/_walk-a-measurement.spec.ts`
 *
 * ## What this spec catches
 *
 * Per audit §4 (findings catalog) + §4.3 (refutations):
 *
 *   - **F-A-1 / H2** — `.ec-meta` host span overflow at FQDN hostname (class A self-overflow)
 *   - **F-A-2 / H3** — PickerList `.picker-row .name` slug overflow (class A; refuted prod-realistic, confirmed synthetic-stress)
 *   - **F-A-3 / H4B** — PlayerTypes `.display` shortName overflow (class A)
 *   - **F-A-4 / H6-B** — SheetHead `.subj.display` silent clip without ellipsis (class A + visual)
 *   - **F-A-5 / NEW** — `.ec-name` long ensemble name + `.ec-tempo` BPM bbox escape (class B, audit's auto-P1 headline)
 *   - **F-A-6 / NEW** — `.ec-desc` unbreakable token forces card wider than grid track (class B)
 *
 * Plus refutation-as-regression coverage for refuted hypotheses:
 *
 *   - **H4A** — `.types-grid` 1fr 1fr at long-tail slugs — refuted (no overflow)
 *   - **H10** — `.page-pills` × `.page-actions` collision at boundary viewports — refuted
 *   - **H13** — `.ec-roster` PlayerAvatar overflow at 50-player ensembles — refuted
 *
 * Plus P3-adjusted-monitor coverage:
 *
 *   - **H12** — PlayerTypeCard row-height misalignment (cosmetic, no class-A/B; locked as design-time choice)
 *   - **H14** — `.page-actions` i18n button row collision (safe at ≤2× English labels at ≥834px)
 *
 * ## Two measurement classes (per researcher #474 §1.1 taxonomy)
 *
 * **Class A — overflow own container**
 *   `el.scrollWidth > el.clientWidth + 1` — element wider than its box.
 *
 * **Class B — escape into adjacent sibling**
 *   `getBoundingClientRect()` math: element's right edge passes sibling's
 *   left edge minus the grid/flex gap (currently 14px for ensemble cards).
 *
 * ## Methodology
 *
 * **Live-DOM injection**: navigate to the running dashboard, force fixture
 * content directly onto rendered DOM elements via `page.evaluate()`, then
 * sample metrics. Targets CSS layout behaviour invisible to jsdom that
 * must be measured in a real browser rendering engine.
 *
 * Tests gracefully skip via `test.skip()` when expected DOM elements
 * aren't present (e.g. no seeded ensemble data). The CI job seeds a
 * mock ensemble before running this spec — see `tests-overflow/README.md`.
 *
 * ## v0 vs v1
 *
 * v0 (this file): JS-only structural assertions + bbox math. Catches
 * class A reliably and class B via getBoundingClientRect comparisons.
 * v1 (follow-up): per-Locator screenshots layered on top for cases the
 * bbox math can't fully resolve (the audit §10.3 step 3 work).
 */
import { test, expect, Page } from '@playwright/test';
import {
  LONG_TAIL_ENSEMBLE_NAME,
  LONG_TAIL_PLAYER_TYPE_SLUG,
  STRESS_PLAYER_TYPE_SLUG,
  STRESS_DESCRIPTION_UNBREAKABLE,
  FQDN_HOSTNAME,
  CARDS_GRID_GAP_PX,
} from './fixtures';

const DASHBOARD_URL = process.env.DASHBOARD_URL ?? 'http://localhost:5174';

/**
 * #492 — Default regime for Walk A's helpers. Tests that need a
 * different regime (`long` / `i18n` / `stress`) can call the helper
 * with an override; most assertions inject their own fixture text via
 * `page.evaluate()` and only need the shim's baseline to render the
 * surrounding scaffolding (cards / picker rows / type cards).
 */
type OverflowRegime = 'short' | 'long' | 'i18n' | 'stress';
const DEFAULT_REGIME: OverflowRegime = 'short';

/**
 * Build the `/__overflow/<Component>?regime=<...>` URL the shim
 * registered in `src/router.tsx` answers under `import.meta.env.DEV`.
 */
function overflowUrl(component: string, regime: OverflowRegime = DEFAULT_REGIME): string {
  return `${DASHBOARD_URL}/dashboard/__overflow/${component}?regime=${regime}`;
}

// ── Navigation helpers ────────────────────────────────────────────────
//
// Pre-#492 these wrapped `ensureDaemonOrSkip()` because the live SPA
// route depended on a daemon at `127.0.0.1:8473` for `/v1/*` calls,
// and the CI `dashboard-overflow` job doesn't spawn one. The route
// shim seeds TanStack Query caches from the bundled fixture catalog
// in `src/lib/overflow-fixtures.ts`, so the screens render
// unconditionally — daemon-probe + skip path removed.

/**
 * Navigate to the Overview screen via the `/__overflow/` shim (#492).
 *
 * The shim seeds `ENSEMBLES_QUERY_KEY`, `HOSTS_QUERY_KEY`, and a
 * per-ensemble `ensembleQueryKey(name)` for each fixture ensemble
 * before mounting `<Overview />`. The same `data-testid`s that the
 * production screen exposes (`[data-testid^="ensemble-card-"]`) light
 * up — Walk A's existing DOM-injection assertions continue to work.
 */
async function gotoOverview(page: Page, regime: OverflowRegime = DEFAULT_REGIME): Promise<void> {
  await page.goto(overflowUrl('Overview', regime));
  await page.waitForSelector(
    '[data-testid^="ensemble-card-"], [data-testid="overview-empty"]',
    { timeout: 10_000 },
  );
}

/**
 * Navigate to the PlayerTypes screen via the shim. The PlayerTypes
 * library's bundled SHIPPED catalog already renders without a daemon,
 * but routing through the shim keeps the helper inventory consistent
 * and lets a `stress` regime swap in synthetic-stress slugs at the
 * source instead of relying on per-test `page.evaluate()` overrides.
 */
async function gotoPlayerTypes(page: Page, regime: OverflowRegime = DEFAULT_REGIME): Promise<void> {
  await page.goto(overflowUrl('PlayerTypes', regime));
  await page.waitForSelector('.types-grid, [data-testid="player-types-empty"]', {
    timeout: 10_000,
  });
}

/** Navigate to the Create-ensemble wizard via the shim (lineup picker seeded). */
async function gotoCreateEnsemble(page: Page, regime: OverflowRegime = DEFAULT_REGIME): Promise<void> {
  await page.goto(overflowUrl('CreateEnsemble', regime));
  await page.waitForSelector('.picker-row', { timeout: 10_000 });
}

// ────────────────────────────────────────────────────────────────────────
// F-A-1 / H2 — ec-meta spans (class A self-overflow)
// Wire-pending: inject FQDN hostname into the host span via DOM eval.
// ────────────────────────────────────────────────────────────────────────

test.describe('F-A-1 / H2 — ec-meta host span overflow (class A)', () => {
  test('ec-meta container does NOT overflow card at FQDN hostname (class A)', async ({ page }) => {
    await gotoOverview(page);

    const injected = await page.evaluate((fqdn: string) => {
      const span = document.querySelector<HTMLElement>('[data-testid$="-host"]');
      if (!span) return { found: false };
      const meta = span.closest<HTMLElement>('.ec-meta');
      const card = meta?.closest<HTMLElement>('.ensemble-card');
      if (!meta || !card) return { found: false };

      span.textContent = fqdn;
      // Force a layout pass before measuring.
      void span.offsetWidth;

      const spanStyle = getComputedStyle(span);
      const metaRect = meta.getBoundingClientRect();
      const cardRect = card.getBoundingClientRect();

      return {
        found: true,
        // CSS rule applied — fingerprints the ellipsis machinery that
        // makes graceful truncation possible. If a future change strips
        // overflow:hidden or text-overflow:ellipsis, host content would
        // bleed instead of ellipsifying — this catches that.
        overflow: spanStyle.overflow,
        textOverflow: spanStyle.textOverflow,
        whiteSpace: spanStyle.whiteSpace,
        // Outcome semantic — the actual F-A-1 invariant: the .ec-meta
        // container must not overflow the card. Under host-alone pressure
        // the host may ellipsify (architect-acknowledged UX trade-off);
        // the container staying within the card is what matters.
        metaScrollWidth: meta.scrollWidth,
        metaClientWidth: meta.clientWidth,
        metaRight: metaRect.right,
        cardRight: cardRect.right,
      };
    }, FQDN_HOSTNAME);

    if (!injected.found) {
      test.skip();
      return;
    }

    // CSS rule fingerprint — catches "rule removed" / "selector mismatch"
    // regressions. The actual values are spec'd in components.css :941.
    expect(injected.overflow).toBe('hidden');
    expect(injected.textOverflow).toBe('ellipsis');
    expect(injected.whiteSpace).toBe('nowrap');

    // Outcome semantic — F-A-1 invariant: container fits within the card.
    // #494: pre-F-A-1 the rigid host pushed `.ec-meta` past the card's
    // right edge. The architect's `flex: 0 1 auto` fix lets the host
    // ellipsify when the container is too narrow for the full FQDN; the
    // ellipsification is the acceptable trade-off documented in the
    // architect's triage. The card-overflow check is the real invariant.
    expect(
      injected.metaScrollWidth,
      `.ec-meta scrollWidth=${injected.metaScrollWidth} > clientWidth=${injected.metaClientWidth}: container overflowed`,
    ).toBeLessThanOrEqual(injected.metaClientWidth + 1);
    expect(
      injected.metaRight,
      `.ec-meta right=${injected.metaRight} > card right=${injected.cardRight}: container bled past card edge`,
    ).toBeLessThanOrEqual(injected.cardRight + 1);

    // #493 visual regression baseline — locator-scoped on the first
    // ensemble card so a CSS-level regression of the host span's
    // text-overflow / min-width-0 (or #494's `flex: 0 1 auto` fix on
    // `.ec-meta > span:last-child`) surfaces visibly even when
    // scrollWidth math still passes.
    await expect(page.locator('.ensemble-card').first()).toHaveScreenshot('F-A-1-host-fqdn.png');
  });

  // #494 (resolved): the F-A-1 fix relaxed `.ec-meta > span:last-child`
  // from `flex-shrink: 0` to `flex: 0 1 auto`, letting the host ellipsify
  // as a second priority under combined pressure (long lineup + FQDN
  // host). Lineup still shrinks first via flex:1 1 0; host only kicks in
  // when lineup alone can't absorb the overflow.
  test('ec-meta container does NOT overflow card at FQDN + long lineup (class A)', async ({
    page,
  }) => {
    await gotoOverview(page);

    const result = await page.evaluate((fqdn: string) => {
      const metaEl = document
        .querySelector<HTMLElement>('[data-testid$="-lineup"]')
        ?.closest('.ec-meta');
      if (!metaEl) return { found: false };

      const [lineupSpan, hostSpan] = metaEl.querySelectorAll<HTMLElement>('span');
      if (lineupSpan) lineupSpan.textContent = 'tempo-impl-feature-flag-rollout-q3';
      if (hostSpan) hostSpan.textContent = fqdn;

      return {
        found: true,
        scrollWidth: metaEl.scrollWidth,
        clientWidth: metaEl.clientWidth,
        overflowing: metaEl.scrollWidth > metaEl.clientWidth + 1,
      };
    }, FQDN_HOSTNAME);

    if (!result.found) {
      test.skip();
      return;
    }

    expect(
      result.overflowing,
      `ec-meta scrollWidth=${result.scrollWidth} > clientWidth=${result.clientWidth}: confirms F-A-1`,
    ).toBe(false);
  });
});

// ────────────────────────────────────────────────────────────────────────
// F-A-5 / F-A-NEW-1 — ec-name + BPM sibling bbox escape (class B, auto-P1)
// Audit's headline existence-proof finding.
// ────────────────────────────────────────────────────────────────────────

test.describe('F-A-5 / NEW — ec-name long ensemble name, BPM bbox escape (class B)', () => {
  test.use({ viewport: { width: 1180, height: 820 } }); // Laptop — 3-4 card layout

  test('ec-tempo (BPM) does NOT escape card right edge at 36-char ensemble name (class B auto-P1)', async ({
    page,
  }) => {
    await gotoOverview(page);

    const result = await page.evaluate((longName: string) => {
      const ecName = document.querySelector<HTMLElement>('.ec-name');
      if (!ecName) return { found: false };

      const card = ecName.closest<HTMLElement>('.ensemble-card');
      if (!card) return { found: false };

      const ecTempo = card.querySelector<HTMLElement>('.ec-tempo');
      if (!ecTempo) return { found: false };

      const atSpan = ecName.querySelector('.at');
      if (atSpan) {
        ecName.textContent = longName;
        ecName.appendChild(atSpan);
      } else {
        ecName.textContent = longName;
      }
      void card.offsetWidth; // reflow

      const cardRect = card.getBoundingClientRect();
      const tempoRect = ecTempo.getBoundingClientRect();
      const nameRect = ecName.getBoundingClientRect();

      return {
        found: true,
        cardRight: cardRect.right,
        tempoLeft: tempoRect.left,
        tempoRight: tempoRect.right,
        nameRight: nameRect.right,
        bpmEscapedCard: tempoRect.right > cardRect.right + 1,
        ecNameOverflowing: ecName.scrollWidth > ecName.clientWidth + 1,
      };
    }, LONG_TAIL_ENSEMBLE_NAME);

    if (!result.found) {
      test.skip();
      return;
    }

    // EXPECTATION: BPM should remain inside the card boundary.
    // Pre-PR-α this failed until F-A-5 fix lands (PR-α).
    expect(
      result.bpmEscapedCard,
      `BPM tempoRight=${result.tempoRight} > cardRight=${result.cardRight}: BPM escaped card — auto-P1 (F-A-5)`,
    ).toBe(false);

    // #493 visual regression baseline — F-A-5 is the audit's headline
    // class-B auto-P1. The bbox check confirms the BPM stays in the
    // card; the screenshot also locks WHERE on the card the BPM lands
    // (vertical alignment, font, spacing). CSS regressions of the
    // ec-tempo column or ec-name min-width-0 surface visibly here.
    await expect(page.locator('.ensemble-card').first()).toHaveScreenshot('F-A-5-bpm-card-boundary.png');
  });

  test('ec-name BPM does NOT collide into adjacent card at 36-char name (class B)', async ({
    page,
  }) => {
    await gotoOverview(page);

    const result = await page.evaluate(
      (args: { longName: string; gap: number }) => {
        const cards = Array.from(document.querySelectorAll<HTMLElement>('.ensemble-card'));
        if (cards.length < 2) return { found: false, reason: 'need ≥2 cards' };

        const card0 = cards[0];
        const card1 = cards[1];

        const ecName0 = card0.querySelector<HTMLElement>('.ec-name');
        const ecTempo0 = card0.querySelector<HTMLElement>('.ec-tempo');
        if (!ecName0 || !ecTempo0) return { found: false, reason: 'ec-name or ec-tempo missing' };

        const card0Rect = card0.getBoundingClientRect();
        const card1Rect = card1.getBoundingClientRect();
        if (card1Rect.left <= card0Rect.right) {
          return { found: false, reason: 'cards stacked vertically; need side-by-side grid' };
        }

        ecName0.textContent = args.longName;
        void card0.offsetWidth;

        const ecTempoRect = ecTempo0.getBoundingClientRect();
        const card1RectAfter = card1.getBoundingClientRect();

        return {
          found: true,
          ecTempoRight: ecTempoRect.right,
          card1Left: card1RectAfter.left,
          bpmEncroachedIntoGap: ecTempoRect.right > card1RectAfter.left - args.gap,
          bpmOverlapsCard1: ecTempoRect.right > card1RectAfter.left,
        };
      },
      { longName: LONG_TAIL_ENSEMBLE_NAME, gap: CARDS_GRID_GAP_PX },
    );

    if (!result.found) {
      test.skip();
      return;
    }

    expect(
      result.bpmOverlapsCard1,
      `BPM right=${result.ecTempoRight} > card1 left=${result.card1Left}: class-B escape into neighbor`,
    ).toBe(false);
  });
});

// ────────────────────────────────────────────────────────────────────────
// F-A-6 / F-A-NEW-2 — ec-desc unbreakable token card escape (class B)
// ────────────────────────────────────────────────────────────────────────

test.describe('F-A-6 / NEW — ec-desc unbreakable stress token, card boundary escape (class B)', () => {
  test.use({ viewport: { width: 1180, height: 820 } });

  test('ec-desc unbreakable token does NOT force card wider than grid track (class B)', async ({
    page,
  }) => {
    await gotoOverview(page);

    const result = await page.evaluate(
      (args: { stressDesc: string; gap: number }) => {
        const cards = Array.from(document.querySelectorAll<HTMLElement>('.ensemble-card'));
        if (cards.length < 2) return { found: false, reason: 'need ≥2 cards' };

        const card0 = cards[0];
        const card1 = cards[1];

        const ecDesc = card0.querySelector<HTMLElement>('.ec-desc');
        if (!ecDesc) return { found: false, reason: 'ec-desc missing' };

        const card0Rect0 = card0.getBoundingClientRect();
        const card1Rect0 = card1.getBoundingClientRect();
        if (card1Rect0.left <= card0Rect0.right) {
          return { found: false, reason: 'cards stacked vertically' };
        }

        ecDesc.textContent = args.stressDesc;
        void card0.offsetWidth;

        const card0Rect1 = card0.getBoundingClientRect();
        const card1Rect1 = card1.getBoundingClientRect();

        return {
          found: true,
          card0WidthBefore: card0Rect0.width,
          card0WidthAfter: card0Rect1.width,
          card0RightAfter: card0Rect1.right,
          card1LeftAfter: card1Rect1.left,
          cardWidened: card0Rect1.width > card0Rect0.width + 1,
          cardOverlapsNeighbour: card0Rect1.right > card1Rect1.left,
          ecDescOverflowing: ecDesc.scrollWidth > ecDesc.clientWidth + 1,
        };
      },
      { stressDesc: STRESS_DESCRIPTION_UNBREAKABLE, gap: CARDS_GRID_GAP_PX },
    );

    if (!result.found) {
      test.skip();
      return;
    }

    // EXPECTATION: card must NOT widen or overlap neighbour. Pre-PR-α this failed until F-A-6 fix.
    expect(
      result.cardOverlapsNeighbour,
      `card0 right=${result.card0RightAfter} > card1 left=${result.card1LeftAfter}: card escaped grid track — class B (F-A-6)`,
    ).toBe(false);

    expect(
      result.ecDescOverflowing,
      `ec-desc scrollWidth overflow: confirms F-A-6 root cause`,
    ).toBe(false);
  });
});

// ────────────────────────────────────────────────────────────────────────
// F-A-2 / H3 — PickerList picker-row name (class A)
// Production-realistic refute + synthetic-stress confirm.
// ────────────────────────────────────────────────────────────────────────

test.describe('F-A-2 / H3 — picker-row name overflow (class A)', () => {
  test('picker-row name does NOT overflow at production-realistic slug (H3 prod-realistic refuted)', async ({
    page,
  }) => {
    await gotoCreateEnsemble(page);

    const result = await page.evaluate((slug: string) => {
      const nameSpan = document.querySelector<HTMLElement>('.picker-row .name');
      if (!nameSpan) return { found: false };

      const original = nameSpan.textContent;
      nameSpan.textContent = slug;
      void nameSpan.offsetWidth;

      const metrics = {
        found: true,
        slug,
        scrollWidth: nameSpan.scrollWidth,
        clientWidth: nameSpan.clientWidth,
        overflowing: nameSpan.scrollWidth > nameSpan.clientWidth + 1,
        containerWidth: nameSpan.closest('button')?.clientWidth ?? -1,
      };

      nameSpan.textContent = original;
      return metrics;
    }, LONG_TAIL_PLAYER_TYPE_SLUG);

    if (!result.found) {
      test.skip();
      return;
    }

    // EXPECTATION: must pass — production-realistic refutation.
    expect(
      result.overflowing,
      `name scrollWidth=${result.scrollWidth} > clientWidth=${result.clientWidth} at '${result.slug}' — H3 prod-realistic refuted`,
    ).toBe(false);

    // #493 visual regression baseline — locator-scoped on the first
    // picker row, the production-realistic slug variant.
    await expect(page.locator('.picker-row').first()).toHaveScreenshot('F-A-2-picker-row-prod-slug.png');
  });

  test('picker-row name does NOT overflow at synthetic-stress slug (F-A-2 fixed in PR-α)', async ({
    page,
  }) => {
    await gotoCreateEnsemble(page);

    const result = await page.evaluate((slug: string) => {
      const nameSpan = document.querySelector<HTMLElement>('.picker-row .name');
      if (!nameSpan) return { found: false };

      nameSpan.textContent = slug;
      void nameSpan.offsetWidth;

      return {
        found: true,
        scrollWidth: nameSpan.scrollWidth,
        clientWidth: nameSpan.clientWidth,
        overflowing: nameSpan.scrollWidth > nameSpan.clientWidth + 1,
      };
    }, STRESS_PLAYER_TYPE_SLUG);

    if (!result.found) {
      test.skip();
      return;
    }

    // POST-FIX REGRESSION LOCK: PR-α (#489) added `min-width: 0` to
    // `.picker-row .name` so even synthetic-stress slugs truncate.
    // Locks against accidental removal of the min-width:0 rule.
    expect(
      result.overflowing,
      `name scrollWidth=${result.scrollWidth} > clientWidth=${result.clientWidth}: F-A-2 stress overflow regressed`,
    ).toBe(false);

    // #493 visual regression baseline — synthetic-stress slug variant.
    await expect(page.locator('.picker-row').first()).toHaveScreenshot('F-A-2-picker-row-stress-slug.png');
  });
});

// ────────────────────────────────────────────────────────────────────────
// F-A-3 / H4B — PlayerTypes .display overflow at synthetic-stress (class A)
// H4A — refuted at long-tail slugs.
// ────────────────────────────────────────────────────────────────────────

test.describe('F-A-3 / H4 — PlayerTypes .display overflow (class A)', () => {
  test('.display does NOT overflow at long-tail slug (H4A refuted)', async ({ page }) => {
    await gotoPlayerTypes(page);

    const result = await page.evaluate((slug: string) => {
      const displayEl = document.querySelector<HTMLElement>('.types-grid .display');
      if (!displayEl) return { found: false };

      const orig = displayEl.textContent;
      displayEl.textContent = slug;
      void displayEl.offsetWidth;

      const metrics = {
        found: true,
        scrollWidth: displayEl.scrollWidth,
        clientWidth: displayEl.clientWidth,
        overflowing: displayEl.scrollWidth > displayEl.clientWidth + 1,
      };
      displayEl.textContent = orig;
      return metrics;
    }, LONG_TAIL_PLAYER_TYPE_SLUG.replace(/^tempo-/, ''));

    if (!result.found) {
      test.skip();
      return;
    }

    // REFUTATION: H4A pre-logged P2 stress; refuted at long-tail (1fr 1fr grid sufficient).
    // Locks the protection — must always pass.
    expect(
      result.overflowing,
      `display scrollWidth=${result.scrollWidth} > clientWidth=${result.clientWidth}: H4A refutation regression`,
    ).toBe(false);

    // #493 visual regression baseline — long-tail slug variant.
    await expect(page.locator('.types-grid').first()).toHaveScreenshot('F-A-3-types-grid-long-tail.png');
  });

  test('.display does NOT overflow grid cell at synthetic-stress shortName (F-A-3 fixed in PR-α)', async ({
    page,
  }) => {
    await gotoPlayerTypes(page);

    const result = await page.evaluate((slug: string) => {
      const displayEls = Array.from(document.querySelectorAll<HTMLElement>('.types-grid .display'));
      if (displayEls.length < 2) return { found: false, reason: 'need ≥2 display elements' };

      const el0 = displayEls[0];
      const el1 = displayEls[1];

      el0.textContent = slug;
      void el0.offsetWidth;

      const rect0 = el0.getBoundingClientRect();
      const rect1 = el1.getBoundingClientRect();

      return {
        found: true,
        scrollWidth: el0.scrollWidth,
        clientWidth: el0.clientWidth,
        overflowingOwn: el0.scrollWidth > el0.clientWidth + 1,
        escapedIntoEl1: rect0.right > rect1.left,
      };
    }, STRESS_PLAYER_TYPE_SLUG.replace(/^this-is-a-very-long-player-type-slug-that-no-one-would-actually-create-but-we-need-to-test-overflow-behavior-at-300-characters-or-so-/, ''));

    if (!result.found) {
      test.skip();
      return;
    }

    // POST-FIX REGRESSION LOCK: PR-α (#489) Cluster 2 added
    // `overflow-wrap: break-word` to the `.display` utility class so
    // synthetic-stress unbreakable tokens wrap to multiple lines instead
    // of overflowing horizontally. Locks against removal of break-word.
    expect(
      result.overflowingOwn,
      `display scrollWidth=${result.scrollWidth} > clientWidth=${result.clientWidth}: F-A-3 stress overflow regressed`,
    ).toBe(false);
    expect(
      result.escapedIntoEl1,
      `display escaped into adjacent grid cell — class-B regression of F-A-3`,
    ).toBe(false);

    // #493 visual regression baseline — synthetic-stress shortName.
    // Captures the multi-line wrap behavior — bbox math sees it as
    // "no overflow" but the visual wrap pattern is the actual fix.
    await expect(page.locator('.types-grid').first()).toHaveScreenshot('F-A-3-types-grid-stress-wrap.png');
  });
});

// ────────────────────────────────────────────────────────────────────────
// F-A-4A / H6-B — SheetHead player ID silent clip without ellipsis
// ────────────────────────────────────────────────────────────────────────

test.describe('F-A-4 / H6-B — SheetHead player ID silent clip (class A + visual)', () => {
  test('SheetHead .subj.display does NOT overflow without ellipsis at 33-char player ID', async ({
    page,
  }) => {
    const cards = await page.locator('[data-testid^="ensemble-card-"]').count().catch(() => 0);
    if (cards === 0) {
      test.skip();
      return;
    }

    await gotoOverview(page);
    await page.locator('[data-testid^="ensemble-card-"]').first().click();
    await page.waitForURL(/\/ensemble\//);

    const playerRow = page.locator('[data-testid^="player-row-"]').first();
    if (!(await playerRow.isVisible().catch(() => false))) {
      test.skip();
      return;
    }
    await playerRow.click();

    await page.waitForSelector('.player-sheet', { timeout: 5_000 });

    const result = await page.evaluate((longId: string) => {
      const subjEl = document.querySelector<HTMLElement>('.player-sheet .subj.display');
      if (!subjEl) return { found: false };

      subjEl.textContent = longId;
      void subjEl.offsetWidth;

      const cs = getComputedStyle(subjEl);
      return {
        found: true,
        scrollWidth: subjEl.scrollWidth,
        clientWidth: subjEl.clientWidth,
        overflowing: subjEl.scrollWidth > subjEl.clientWidth + 1,
        textOverflow: cs.textOverflow,
        overflow: cs.overflow,
        whiteSpace: cs.whiteSpace,
      };
    }, 'tempo-pixel-audit-recruit-batch-a-extra-chars-here');

    if (!result.found) {
      test.skip();
      return;
    }

    // EXPECTATION: should truncate with ellipsis. Pre-PR-α this failed (F-A-4 / H6-B).
    expect(
      result.textOverflow,
      `text-overflow is '${result.textOverflow}' instead of 'ellipsis' — H6-B missing ellipsis`,
    ).toBe('ellipsis');
  });
});

// ────────────────────────────────────────────────────────────────────────
// REFUTATION-AS-REGRESSION (§4.3) — these MUST always pass.
//
// Per audit §1.4 (c) "refutation-as-regression-detector" pattern:
// refutations have shelf life longer than confirmations because the
// patterns we proved currently safe could regress under future code
// changes. Locking the proof in CI prevents the regression.
// ────────────────────────────────────────────────────────────────────────

// #494 (resolved): the H10 fix adds `flex-wrap: wrap; gap: 4px;` to
// `.page-pills` inside `@container artboard (max-width: 900px)` (the
// 899px and 521px iterations now wrap cleanly within the title cell).
// At 519px the header grid collapses to a single column — pills and
// actions stack on separate rows, so the test heuristic was tightened
// with a vertical AND-gate (see L660-680). All six viewports now hold.

test.describe('H10 — page-pills × page-actions collision (refuted)', () => {
  for (const viewport of [
    { width: 1201, height: 820, label: 'just-above-1200' },
    { width: 1199, height: 820, label: 'just-below-1200' },
    { width: 901, height: 820, label: 'just-above-900' },
    { width: 899, height: 820, label: 'just-below-900' },
    { width: 521, height: 780, label: 'just-above-520' },
    { width: 519, height: 780, label: 'just-below-520' },
  ]) {
    test(`pills do not overlap actions at ${viewport.label} (${viewport.width}px)`, async ({
      page,
    }) => {
      await page.setViewportSize({ width: viewport.width, height: viewport.height });
      await gotoOverview(page);

      const result = await page.evaluate(() => {
        const pills = document.querySelector<HTMLElement>('.page-pills');
        const actions = document.querySelector<HTMLElement>('.page-actions');
        if (!pills || !actions) return { found: false };

        const pillsRect = pills.getBoundingClientRect();
        const actionsRect = actions.getBoundingClientRect();

        return {
          found: true,
          pillsRight: pillsRect.right,
          actionsLeft: actionsRect.left,
          pillsBottom: pillsRect.bottom,
          actionsTop: actionsRect.top,
          // #494: AND-gate vertical overlap. At <=520px the header grid
          // collapses to `grid-template-columns: 1fr` (components.css ~L1068),
          // so pills and actions stack on separate rows — horizontal-only
          // comparison would trivially return true for two full-width
          // stacked elements without there being a real visual collision.
          // Require BOTH horizontal AND vertical overlap to count as a hit.
          overlapping:
            pillsRect.right > actionsRect.left &&
            pillsRect.bottom > actionsRect.top,
        };
      });

      if (!result.found) {
        test.skip();
        return;
      }

      // REFUTATION: H10 is structurally refuted by `grid-template-columns: 1fr auto`.
      // Locks against regression of that rule.
      expect(
        result.overlapping,
        `pills right=${result.pillsRight} > actions left=${result.actionsLeft} at ${viewport.width}px: H10 collision (should never happen)`,
      ).toBe(false);

      // #493 visual regression baseline — per-viewport. Captures the
      // page-header's pill+action layout at the refuted-safe widths;
      // a regression of `grid-template-columns: 1fr auto` would
      // change the visual partition between the two columns even if
      // bbox math still shows them not-overlapping at this viewport.
      await expect(page.locator('.page-header')).toHaveScreenshot(`H10-page-header-${viewport.width}px.png`);
    });
  }
});

test.describe('H13 — ec-roster avatar overflow at 50-player ensemble (refuted)', () => {
  test('ec-roster does NOT overflow card (class A)', async ({ page }) => {
    await gotoOverview(page);

    const result = await page.evaluate(() => {
      const roster = document.querySelector<HTMLElement>('.ec-roster');
      if (!roster) return { found: false };

      return {
        found: true,
        scrollWidth: roster.scrollWidth,
        clientWidth: roster.clientWidth,
        overflowing: roster.scrollWidth > roster.clientWidth + 1,
      };
    });

    if (!result.found) {
      test.skip();
      return;
    }

    // REFUTATION: H13 is refuted by JSX `slice(0, 5)` cap on avatar render.
    // Locks against accidental removal of that cap.
    expect(
      result.overflowing,
      `ec-roster scrollWidth=${result.scrollWidth} > clientWidth=${result.clientWidth}: H13 should be refuted`,
    ).toBe(false);

    // #493 visual regression baseline — the 5-avatar cap is visually
    // distinctive; a regression that allows the 6th avatar through
    // would change the visual stack even if scrollWidth still fits.
    await expect(page.locator('.ec-roster').first()).toHaveScreenshot('H13-ec-roster-avatar-cap.png');
  });
});

// ────────────────────────────────────────────────────────────────────────
// P3-ADJUSTED MONITOR (§4.4) — flagged for future review, not for fix
//
// **Novel surface**: H12 + H14 were adjusted to P3 during overflow-lead's
// consolidation pass and therefore never made it into the walker
// artifacts (which encoded H4A/H10/H11/H13 refutations only). The walker
// → CI handoff has a gap here: H12 + H14 are refutation-grade in spirit
// (proven not-a-bug, locked against regression) but their assertions
// only land in this PR. Per conductor's PR-v0 brief, this is the high-
// value novel work that converts the walk-product into the CI-product.
//
// ── H12 — PlayerTypeCard row-height misalignment (cosmetic) ──
//
// Audit §4.4: cards in same visual row can be unequal-height when one
// has a wrapping description and its peer doesn't. This is intentional
// per `grid-auto-rows: max-content`. P3, no fix required. The test
// locks the design-time behavior: if a future change adds
// `align-items: stretch` (forcing equal heights), the test MUST be
// updated alongside. Until then, this asserts the as-designed shape.
// ────────────────────────────────────────────────────────────────────────

test.describe('H12 — PlayerTypeCard row-height (P3 cosmetic, design-locked)', () => {
  test('cards do not enforce equal heights via align-items:stretch', async ({ page }) => {
    await gotoPlayerTypes(page);

    const result = await page.evaluate(() => {
      const grid = document.querySelector<HTMLElement>('.types-grid');
      if (!grid) return { found: false };

      const computed = getComputedStyle(grid);
      return {
        found: true,
        gridAutoRows: computed.gridAutoRows,
        alignItems: computed.alignItems,
        // The actual cards (panels in the grid)
        cardCount: grid.querySelectorAll('.types-grid > *').length,
      };
    });

    if (!result.found) {
      test.skip();
      return;
    }

    // P3 design lock: H12's "cosmetic misalignment" is a consequence of
    // `grid-auto-rows: max-content` + default `align-items: normal`. If
    // either rule changes, design owner needs to ratify the new behavior
    // (per audit §4.4 "if visual alignment is desired").
    expect(
      result.gridAutoRows.replace(/\s+/g, ' '),
      'grid-auto-rows should be max-content (per audit §4.4 design-time choice)',
    ).toContain('max-content');
    // `align-items: stretch` would invalidate H12's "cosmetic" classification.
    expect(
      result.alignItems,
      `align-items='${result.alignItems}' would force equal heights — H12 needs design ratification`,
    ).not.toBe('stretch');

    // #493 visual regression baseline — locks the PlayerTypes grid
    // layout including the design-time `align-items: normal` shape
    // that H12 ratifies. A regression to `stretch` would change the
    // visual heights of adjacent cards.
    await expect(page.locator('.types-grid')).toHaveScreenshot('H12-types-grid-design-lock.png');
  });
});

// ────────────────────────────────────────────────────────────────────────
// H14 — page-actions button row at i18n-doubled labels (refuted up to 2× English)
//
// Audit §4.4: page-header `grid-template-columns: 1fr auto` permits
// `auto` cell to expand for actions; refuted at i18n labels up to 2×
// English length (~28 chars) for canonical viewports ≥834px. This
// regression-locks the protection: if a future change shrinks `auto`
// cell or imposes a max-width, this test must update.
// ────────────────────────────────────────────────────────────────────────

// #494 (resolved): the H14 fix added `min-width: 0` to `.page-title`
// (components.css :369-382), letting the title shrink and allowing
// F-A-4's existing `overflow-wrap: break-word` to engage. Tablet (834px)
// now holds alongside desktop/laptop.

test.describe('H14 — page-actions i18n button row (refuted at ≥834px / ≤2× English)', () => {
  for (const viewport of [
    { width: 1440, height: 900, label: 'desktop' },
    { width: 1180, height: 820, label: 'laptop' },
    { width: 834, height: 1100, label: 'tablet' },
  ]) {
    test(`page-actions buttons fit auto cell at ${viewport.label} (${viewport.width}px) with simulated i18n labels`, async ({
      page,
    }) => {
      await page.setViewportSize({ width: viewport.width, height: viewport.height });
      await gotoOverview(page);

      const result = await page.evaluate(() => {
        const pageHeader = document.querySelector<HTMLElement>('.page-header');
        const actions = document.querySelector<HTMLElement>('.page-actions');
        const pageTitle = document.querySelector<HTMLElement>('.page-title');
        if (!pageHeader || !actions || !pageTitle) return { found: false };

        // Simulate i18n: replace each button's label text with a 2× expansion.
        // German is ~30-40% longer for tech UI; we use 2× for safety margin.
        const buttons = Array.from(actions.querySelectorAll<HTMLElement>('button, a'));
        for (const btn of buttons) {
          const labelSpan = btn.querySelector<HTMLElement>('span:not(.btn-icon)') ?? btn;
          const original = labelSpan.textContent ?? '';
          labelSpan.textContent = original + ' '.repeat(0) + original.split('').reverse().join('');
        }
        void pageHeader.offsetWidth;

        const headerRect = pageHeader.getBoundingClientRect();
        const actionsRect = actions.getBoundingClientRect();
        const titleRect = pageTitle.getBoundingClientRect();

        return {
          found: true,
          headerRight: headerRect.right,
          actionsRight: actionsRect.right,
          actionsLeft: actionsRect.left,
          titleRight: titleRect.right,
          titleBottom: titleRect.bottom,
          actionsTop: actionsRect.top,
          actionsOverflowed: actionsRect.right > headerRect.right + 1,
          // #494: AND-gate vertical overlap — same pattern the H10@519
          // refinement uses (~L660-680). At ≤900px the page-header grid
          // collapses to `grid-template-columns: 1fr` (components.css :1079),
          // so title and actions stack on separate rows. Horizontal-only
          // comparison would trivially fire for any two stacked elements
          // (both span the full header width). Require BOTH horizontal AND
          // vertical overlap to count as a real visual collision.
          actionsCollidedWithTitle:
            titleRect.right > actionsRect.left &&
            titleRect.bottom > actionsRect.top,
        };
      });

      if (!result.found) {
        test.skip();
        return;
      }

      // REFUTATION: at ≥834px with 2× English labels, actions fit auto cell.
      expect(
        result.actionsOverflowed,
        `actions right=${result.actionsRight} > header right=${result.headerRight} at ${viewport.width}px: H14 i18n collision`,
      ).toBe(false);
      expect(
        result.actionsCollidedWithTitle,
        `title right=${result.titleRight} > actions left=${result.actionsLeft}: title bled into actions cell`,
      ).toBe(false);

      // #493 visual regression baseline — per-viewport. The expanded
      // i18n labels are visible in the screenshot; a regression of the
      // auto-cell width budget would clip them differently.
      await expect(page.locator('.page-header')).toHaveScreenshot(`H14-page-header-i18n-${viewport.width}px.png`);
    });
  }
});
