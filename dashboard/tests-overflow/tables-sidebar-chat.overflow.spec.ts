/**
 * Dashboard overflow guardrail — tables / sidebar / chat / buttons
 * (Batch B coverage from #461 audit).
 *
 * Audit: `docs/design/dashboard-overflow-audit-v0.28.10.md`
 * Walker: tempo-researcher
 * Promoted from: `audit/461-walk-b:dashboard/tests-overflow/_walk-b-measurement.spec.ts`
 *
 * ## What this spec catches
 *
 * Per audit §4 (findings catalog) + §4.3 (refutations):
 *
 *   - **F-B-1 / H1**     — Sidebar `.er-name` long ensemble name overflow (class A self-overflow, conditional auto-P1)
 *   - **F-B-2 / H5**     — Hosts table FQDN cell overflow (class A, conditional auto-P1)
 *   - **F-B-3 / H7**     — `.panel-head` no flex-wrap, subj+actions collision at boundary viewports (class A + class C)
 *   - **F-B-4 / H8**     — `.msg-body` code-block overflow (class A, P1 prod-realistic, ratified)
 *   - **F-B-5 / H9**     — Settings `.kv` long-value overflow (class A)
 *   - **F-B-NEW-1**      — Loadouts Name column unbounded (class A)
 *   - **F-B-NEW-2**      — Generic `.row` button-row missing flex-wrap (class A + class C)
 *
 * Plus refutation-as-regression coverage:
 *
 *   - **H11** — TempoStrip narrow-viewport rendering — refuted (no overflow at 320×240, 390×780, 1440×900)
 *
 * ## Methodology
 *
 * **Self-contained `page.setContent()` injection** — each test injects
 * minimal HTML that faithfully mirrors the production component shape
 * (Sidebar.tsx, Hosts.tsx, FeedMessage.tsx, etc.) and applies the live
 * `components.css` via `<link rel="stylesheet" href="/dashboard/assets/components.css" />`.
 * No daemon, no SPA, no fixture wire-up — the suite runs against any
 * served dashboard build.
 *
 * Walk B was conducted statically (Chrome MCP + dev daemon HTTP API
 * both unavailable mid-walk); this spec is the deferred-measurement
 * surface for those static-confirmed findings, per audit §1.4 (b)
 * concurrent-failure resilience.
 *
 * ## Two measurement classes (per researcher #474 §1.1 taxonomy)
 *
 * **Class A — overflow own container**
 *   `el.scrollWidth > el.clientWidth + 1` — element wider than its box.
 *
 * **Class B — escape into adjacent sibling**
 *   `getBoundingClientRect()` math comparing element edges across
 *   adjacent components.
 *
 * ## CI status
 *
 * PR-α (#489) is on main; this branch is rebased onto it, so confirmed-
 * finding assertions assert the post-fix state and pass. The
 * `dashboard-overflow` CI job uses strict gating (no `continue-on-error`).
 * See `tests-overflow/README.md` for the rollout history.
 */
import { test, expect, type Page } from '@playwright/test';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  LONG_TAIL_ENSEMBLE_NAME,
  FQDN_HOSTNAME,
} from './fixtures';

// ── Source-CSS loader ────────────────────────────────────────────────
//
// Load the dashboard's source CSS files at test-runtime and inject via
// `page.addStyleTag()`. Initially this spec linked to the built bundle
// at `/dashboard/assets/components.css`, but vite hashes that filename
// (`index-{hash}.css`) so the link silently 404'd — most tests then
// passed spuriously (no CSS constraint = no overflow), and three
// assertions that depended on specific PR-α width caps (F-B-2 240px,
// F-B-NEW-1 240px, F-B-4 78% bubble) failed honestly.
//
// Reading source files keeps the spec self-contained against any vite
// build output naming and avoids a pre-test build step. The `@import`
// lines in `globals.css` are stripped because they reference
// `tailwindcss` + relative paths that only resolve under vite's
// build-time graph, not at browser runtime.

const HERE = dirname(fileURLToPath(import.meta.url));
const STYLES_DIR = join(HERE, '..', 'src', 'styles');

const DASHBOARD_CSS = [
  readFileSync(join(STYLES_DIR, 'tokens.css'), 'utf-8'),
  readFileSync(join(STYLES_DIR, 'globals.css'), 'utf-8').replace(/^\s*@import\b.*$/gm, ''),
  readFileSync(join(STYLES_DIR, 'components.css'), 'utf-8'),
].join('\n\n');

// ── Helpers ───────────────────────────────────────────────────────────

interface OverflowReport {
  text: string;
  scrollWidth: number;
  clientWidth: number;
  overflowing: boolean;
  hasEllipsis: boolean;
}

/**
 * Measure overflow on a single element — the canonical "is the content
 * wider than the box" check, plus a "did the layout actually clip with
 * ellipsis" hint via `.textContent.endsWith('…')` (note: `text-overflow:
 * ellipsis` does NOT alter textContent in DOM — the ellipsis is a
 * render-time visual, so this hint is unreliable and kept here only as
 * a debug field; the real signal is `overflowing`).
 */
async function measureOverflow(page: Page, selector: string): Promise<OverflowReport> {
  return page.evaluate((sel) => {
    const el = document.querySelector(sel);
    if (!el) throw new Error(`Selector not found: ${sel}`);
    const text = el.textContent ?? '';
    return {
      text: text.trim(),
      scrollWidth: el.scrollWidth,
      clientWidth: el.clientWidth,
      overflowing: el.scrollWidth > el.clientWidth + 1,
      hasEllipsis: text.trim().endsWith('…'),
    };
  }, selector);
}

/**
 * Minimal page shell. CSS is injected via `page.addStyleTag({ content })`
 * after `setContent` so the source CSS files (read at module load) are
 * applied without depending on any vite-built asset filename. About:blank
 * keeps the dashboard SPA from booting — no `/v1/*` calls, no daemon
 * dependency, no race condition on `setContent`.
 */
const SHELL_HTML = `
<!doctype html>
<html data-theme="dark">
<head>
  <meta charset="UTF-8" />
  <style>
    body { margin: 0; font-family: system-ui, sans-serif; }
  </style>
</head>
<body>
  <main id="root"></main>
</body>
</html>
`;

/**
 * Loads SHELL_HTML against `about:blank` and injects the source CSS so
 * the dashboard SPA never boots.
 */
async function setShellContent(page: Page): Promise<void> {
  await page.goto('about:blank');
  await page.setContent(SHELL_HTML);
  await page.addStyleTag({ content: DASHBOARD_CSS });
}

// ────────────────────────────────────────────────────────────────────────
// F-B-1 — Sidebar `.er-name` long ensemble name overflow (class A)
// ────────────────────────────────────────────────────────────────────────

test.describe('F-B-1 / H1 — Sidebar `.er-name` long ensemble name overflow (class A)', () => {
  test('long ensemble name truncates with ellipsis (post-PR-α regression lock — F-B-1)', async ({
    page,
  }) => {
    await setShellContent(page);
    await page.evaluate((longName: string) => {
      const root = document.getElementById('root')!;
      // Faithful Sidebar.tsx:97-132 markup, in isolation.
      root.innerHTML = `
        <aside style="width: 244px; border-right: 1px solid #444; padding: 14px 0; overflow: hidden;">
          <a href="#" class="ensemble-row">
            <span class="er-dot"></span>
            <span class="er-initial" aria-hidden="true">T</span>
            <span class="col" style="gap: 0;">
              <span class="er-name">${longName}</span>
              <span class="er-meta mono">5 players</span>
            </span>
            <span class="mono dim" style="font-size: 10px;">↵</span>
          </a>
        </aside>
      `;
    }, LONG_TAIL_ENSEMBLE_NAME);

    await page.setViewportSize({ width: 1440, height: 900 });

    // **Test-quality principle 14 (assertion fingerprinting)**: this test
    // initially asserted `overflowing === false`, which was correct
    // pre-PR-α (no truncation, no ellipsis) but became wrong once the
    // fix landed — with `text-overflow: ellipsis`, the element IS
    // overflowing (scrollWidth > clientWidth) and that's the design
    // intent. Asserting only `overflowing` conflates "no overflow" with
    // "overflows but graceful". Fingerprint the CSS rule directly.
    const result = await page.evaluate(() => {
      const el = document.querySelector<HTMLElement>('.er-name');
      if (!el) throw new Error('.er-name not found');
      const cs = getComputedStyle(el);
      return {
        text: el.textContent ?? '',
        scrollWidth: el.scrollWidth,
        clientWidth: el.clientWidth,
        textOverflow: cs.textOverflow,
        whiteSpace: cs.whiteSpace,
        overflow: cs.overflow,
      };
    });

    expect(result.text).toBe(LONG_TAIL_ENSEMBLE_NAME);

    // Fingerprint: PR-α applied `overflow: hidden + text-overflow: ellipsis +
    // white-space: nowrap` to `.er-name`. Without these, the test passes
    // for the wrong reason (no constraint = no overflow).
    expect(
      result.textOverflow,
      `text-overflow='${result.textOverflow}' — PR-α rule `+
      `\`.ensemble-row .er-name { text-overflow: ellipsis }\` is missing`,
    ).toBe('ellipsis');
    expect(
      result.whiteSpace,
      `white-space='${result.whiteSpace}' — PR-α rule expects 'nowrap'`,
    ).toBe('nowrap');

    // Truncation outcome: with ellipsis applied, scrollWidth (intrinsic
    // content width) MUST exceed clientWidth (visible box) for the long
    // ensemble name. If they're equal, either content fits trivially
    // (defeats the test setup) or constraints aren't applied.
    expect(
      result.scrollWidth,
      `scrollWidth=${result.scrollWidth} should exceed clientWidth=${result.clientWidth} `+
      `for a 34-char ensemble name in a ~195px column — fixture or constraint regressed`,
    ).toBeGreaterThan(result.clientWidth);
  });
});

// ────────────────────────────────────────────────────────────────────────
// F-B-2 — Hosts table FQDN cell overflow (class A)
// ────────────────────────────────────────────────────────────────────────

test.describe('F-B-2 / H5 — Hosts table FQDN cell overflow (class A)', () => {
  test('Host column with FQDN does NOT expand past sane width (post-PR-α regression lock — F-B-2)', async ({
    page,
  }) => {
    await setShellContent(page);
    await page.evaluate((fqdn: string) => {
      const root = document.getElementById('root')!;
      // Faithful Hosts.tsx:154-176 + 199-258 markup, distilled.
      // Panel constrained to 800px to mirror the artboard's bounded
      // width budget — auto-table-layout only honors `max-width` on
      // cells when the table itself has a width budget; in the real
      // dashboard the artboard provides this budget.
      root.innerHTML = `
        <div class="panel" style="margin: 14px; width: 800px;">
          <table class="table" style="width: 100%;">
            <thead>
              <tr><th>Host</th><th>Platform</th><th class="num">Sessions</th><th>Daemon</th><th>Heartbeat</th></tr>
            </thead>
            <tbody>
              <tr data-testid="host-row-fqdn">
                <td class="mono"><span style="color: green">●</span> ${fqdn}</td>
                <td class="mono">linux-x64</td>
                <td class="num">5</td>
                <td class="mono">v0.28.0-beta.10</td>
                <td class="mono">3s ago</td>
              </tr>
            </tbody>
          </table>
        </div>
      `;
    }, FQDN_HOSTNAME);

    await page.setViewportSize({ width: 1440, height: 900 });
    const cell = await page.evaluate(() => {
      const el = document.querySelector<HTMLElement>(
        '[data-testid="host-row-fqdn"] td:first-child',
      );
      if (!el) throw new Error('host-row first cell not found');
      const cs = getComputedStyle(el);
      const padX = parseFloat(cs.paddingLeft) + parseFloat(cs.paddingRight);
      return {
        text: el.textContent ?? '',
        clientWidth: el.clientWidth,
        contentWidth: el.clientWidth - padX,
        padX,
        maxWidth: cs.maxWidth,
        textOverflow: cs.textOverflow,
        whiteSpace: cs.whiteSpace,
      };
    });

    expect(cell.text).toContain('eks.internal.example.com');
    // Fingerprint: PR-α applied `.table td:first-child.mono { max-width:
    // 240px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap }`.
    expect(
      cell.maxWidth,
      `max-width='${cell.maxWidth}' — PR-α rule expects '240px'`,
    ).toBe('240px');
    expect(
      cell.textOverflow,
      `text-overflow='${cell.textOverflow}' — PR-α rule expects 'ellipsis'`,
    ).toBe('ellipsis');

    // Outcome: max-width:240px caps the content-box. clientWidth includes
    // padding (~28-50px depending on density tier), so we assert on the
    // content-box width directly (subtracting horizontal padding) for a
    // box-model-precise check. Without PR-α's rule, content would be
    // ~533px (full FQDN width).
    expect(
      cell.contentWidth,
      `Host cell content width=${cell.contentWidth}px (clientWidth=${cell.clientWidth}, paddingX=${cell.padX}) should be ≤ 240px per max-width — F-B-2`,
    ).toBeLessThanOrEqual(240);
  });
});

// ────────────────────────────────────────────────────────────────────────
// F-B-3 — `.panel-head` no flex-wrap (class A + class C boundary)
// ────────────────────────────────────────────────────────────────────────

test.describe('F-B-3 / H7 — `.panel-head` subj+actions collision at boundary (class A + C)', () => {
  for (const viewport of [
    { label: '1199 (just below 1200 CQ)', w: 1199, h: 820 },
    { label: '901 (just above 900 CQ)', w: 901, h: 820 },
    { label: '521 (just above 520 CQ)', w: 521, h: 780 },
  ]) {
    test(`panel-head fits content without overflow at ${viewport.label} (post-PR-α regression lock — F-B-3)`, async ({
      page,
    }) => {
      await setShellContent(page);
      await page.evaluate(() => {
        const root = document.getElementById('root')!;
        root.innerHTML = `
          <div class="panel" style="width: 100%;">
            <div class="panel-head">
              <div class="panel-head-title">
                <span class="h">Maestro chat</span>
                <span class="subj display">@tempo-impl-feature-flag-rollout-q3</span>
              </div>
              <div class="row">
                <button class="btn btn-ghost btn-sm" data-testid="pause">⏸ Pause</button>
                <button class="btn btn-ghost btn-sm" data-testid="release">Release</button>
                <button class="btn btn-ghost btn-sm" data-testid="popout">↗ Pop out</button>
              </div>
            </div>
          </div>
        `;
      });

      await page.setViewportSize({ width: viewport.w, height: viewport.h });
      const head = await measureOverflow(page, '.panel-head');

      // EXPECTATION: panel-head should not overflow at boundary viewports.
      // Pre-PR-α this failed — no `flex-wrap: wrap`. PR-α fix lands `flex-wrap: wrap`
      // on `.panel-head` + `min-width: 0` + ellipsis on `.panel-head-title .subj`.
      expect(
        head.overflowing,
        `panel-head overflowing at ${viewport.label}: scrollWidth=${head.scrollWidth} > clientWidth=${head.clientWidth} — F-B-3`,
      ).toBe(false);
    });
  }
});

// ────────────────────────────────────────────────────────────────────────
// F-B-4 — `.msg-body` code-block overflow (class A, P1 ratified)
// ────────────────────────────────────────────────────────────────────────

test.describe('F-B-4 / H8 — `.msg-body` code-block overflow (P1 prod-realistic, ratified)', () => {
  test('long code line stays inside `.msg.out` 78% bubble cap (post-PR-α regression lock — F-B-4)', async ({
    page,
  }) => {
    await setShellContent(page);
    await page.evaluate(() => {
      const root = document.getElementById('root')!;
      root.innerHTML = `
        <div class="chat" style="width: 800px;">
          <div class="chat-log">
            <div class="msg out" data-testid="msg-out-1">
              <div class="msg-head">
                <span class="sender mono">you</span>
                <span class="arrow">→</span>
                <span class="target">conductor</span>
                <span class="time">14:02</span>
              </div>
              <div class="msg-body" data-testid="msg-body-1">
                <pre><code>npm install --save-dev @some/very-long-unbreakable-package-name-that-will-not-wrap@1.2.3-build-metadata-foo-bar-baz</code></pre>
              </div>
            </div>
          </div>
        </div>
      `;
    });

    const bubble = await measureOverflow(page, '[data-testid="msg-out-1"]');
    const pre = await page.evaluate(() => {
      const el = document.querySelector('[data-testid="msg-body-1"] pre');
      if (!el) throw new Error('pre not found');
      return {
        scrollWidth: el.scrollWidth,
        clientWidth: el.clientWidth,
        overflowing: el.scrollWidth > el.clientWidth + 1,
      };
    });

    // The bubble's `clientWidth <= 78% × 800 = 624` is the design contract
    // (`.msg.out { max-width: 78% }`). Today the inner `<pre>` has no
    // overflow-x rule, so its content can extend past `.msg-body` and
    // visually bleed past the bubble border.
    //
    // PR-α fix: `.msg-body pre { display: block; overflow-x: auto;
    // max-width: 100%; white-space: pre; }`. Post-fix the bubble width is
    // honored AND the inner `<pre>` produces an internal horizontal
    // scrollbar.
    expect(
      bubble.clientWidth,
      `bubble clientWidth=${bubble.clientWidth} should be ≤ 624 (78% of 800) — F-B-4`,
    ).toBeLessThanOrEqual(624 + 4); // 4px tolerance for sub-pixel rounding

    // After fix: pre's `overflowing === true` (scrollbar inside bubble).
    // Today: pre's clientWidth equals scrollWidth (no clip), and pre's
    // scrollWidth exceeds .msg-body clientWidth.
    expect(
      pre.overflowing,
      `pre clientWidth=${pre.clientWidth} should be bounded by .msg-body, with scrollWidth=${pre.scrollWidth} > clientWidth → internal scroll — F-B-4`,
    ).toBe(true);
  });
});

// ────────────────────────────────────────────────────────────────────────
// F-B-5 — Settings `.kv` long-value overflow (class A)
// ────────────────────────────────────────────────────────────────────────

test.describe('F-B-5 / H9 — Settings `.kv` long-value overflow (class A)', () => {
  test('long version string does NOT overflow `.kv-v` (post-PR-α regression lock — F-B-5)', async ({
    page,
  }) => {
    await setShellContent(page);
    await page.evaluate(() => {
      const root = document.getElementById('root')!;
      const longVersion = 'v0.28.0-beta.10+main.a1b2c3d4e5f6.dirty.local-build-metadata';
      root.innerHTML = `
        <div class="panel settings-panel" style="width: 360px;">
          <div class="panel-head">
            <div class="panel-head-title">
              <span class="h">Connection</span>
              <span class="subj display">Temporal namespace</span>
            </div>
          </div>
          <div class="panel-body">
            <div class="kv"><span class="kv-k">namespace</span><span class="kv-v mono">claude-tempo-dev</span></div>
            <div class="kv" data-testid="kv-row-version"><span class="kv-k">version</span><span class="kv-v mono" data-testid="kv-version">${longVersion}</span></div>
          </div>
        </div>
      `;
    });

    const value = await measureOverflow(page, '[data-testid="kv-version"]');
    const row = await measureOverflow(page, '[data-testid="kv-row-version"]');

    expect(value.text).toContain('beta.10');
    // EXPECTATION: kv-v should be capped + truncate with ellipsis. Today
    // the row expands horizontally because `.kv` has no `min-width: 0` and
    // `.kv-v` has no overflow rule. PR-α fix: `min-width: 0` on `.kv` +
    // ellipsis on `.kv-v`.
    expect(
      row.overflowing,
      `kv row overflowing: row.scrollWidth=${row.scrollWidth} > row.clientWidth=${row.clientWidth} — F-B-5`,
    ).toBe(false);
  });
});

// ────────────────────────────────────────────────────────────────────────
// F-B-NEW-1 — Loadouts table Name column unbounded (class A)
// ────────────────────────────────────────────────────────────────────────

test.describe('F-B-NEW-1 — Loadouts Name column unbounded (class A)', () => {
  test('long lineup name does NOT expand the Name column past sane width (post-PR-α regression lock)', async ({
    page,
  }) => {
    await setShellContent(page);
    await page.evaluate(() => {
      const root = document.getElementById('root')!;
      const longName = 'tempo-cross-machine-recruiting-spike-handoff-rev-3';
      // Panel constrained to 800px to mirror the artboard's bounded
      // width budget — auto-table-layout only honors `max-width` on
      // cells when the table itself has a width budget.
      root.innerHTML = `
        <div class="panel" style="margin: 14px; width: 800px;">
          <table class="table" style="width: 100%;">
            <thead><tr><th>Name</th><th>Summary</th><th class="num">Players</th><th>Source</th></tr></thead>
            <tbody>
              <tr data-testid="loadout-row-long">
                <td class="mono"><span class="accent">≡</span> ${longName}</td>
                <td data-label="Summary" style="color: var(--text-2); font-size: 12.5px; max-width: 320px;">A long-running release coordination ensemble.</td>
                <td data-label="Players" class="num">12</td>
                <td data-label="Source"><span class="mono dim" style="font-size: 11px;">user</span></td>
              </tr>
            </tbody>
          </table>
        </div>
      `;
    });

    await page.setViewportSize({ width: 1440, height: 900 });
    const nameCell = await page.evaluate(() => {
      const el = document.querySelector<HTMLElement>(
        '[data-testid="loadout-row-long"] td:first-child',
      );
      if (!el) throw new Error('loadout-row first cell not found');
      const cs = getComputedStyle(el);
      const padX = parseFloat(cs.paddingLeft) + parseFloat(cs.paddingRight);
      return {
        text: el.textContent ?? '',
        clientWidth: el.clientWidth,
        contentWidth: el.clientWidth - padX,
        padX,
        maxWidth: cs.maxWidth,
        textOverflow: cs.textOverflow,
      };
    });

    expect(nameCell.text).toContain('cross-machine-recruiting-spike');
    // Fingerprint: same PR-α rule as F-B-2 (Cluster 4 covers both
    // Hosts and Loadouts via `.table td:first-child.mono`).
    expect(
      nameCell.maxWidth,
      `max-width='${nameCell.maxWidth}' — PR-α rule expects '240px'`,
    ).toBe('240px');
    expect(
      nameCell.textOverflow,
      `text-overflow='${nameCell.textOverflow}' — PR-α rule expects 'ellipsis'`,
    ).toBe('ellipsis');
    // Box-model-precise: assert content-box width (what max-width caps),
    // not clientWidth (which includes padding).
    expect(
      nameCell.contentWidth,
      `Loadouts Name cell content width=${nameCell.contentWidth}px (clientWidth=${nameCell.clientWidth}, paddingX=${nameCell.padX}) should be ≤ 240px per max-width — F-B-NEW-1`,
    ).toBeLessThanOrEqual(240);
  });
});

// ────────────────────────────────────────────────────────────────────────
// F-B-NEW-2 — Generic `.row` button-row missing flex-wrap (class A + class C)
// ────────────────────────────────────────────────────────────────────────

test.describe('F-B-NEW-2 — Generic `.row` no flex-wrap (class A + C)', () => {
  test('multi-button row in narrow container wraps gracefully (post-PR-α regression lock)', async ({
    page,
  }) => {
    await setShellContent(page);
    await page.evaluate(() => {
      const root = document.getElementById('root')!;
      root.innerHTML = `
        <div style="width: 240px; border: 1px solid #444; padding: 8px;">
          <div class="row" data-testid="row-narrow">
            <button class="btn btn-ghost btn-sm">Edit</button>
            <button class="btn btn-ghost btn-sm">Cancel</button>
            <button class="btn btn-ghost btn-sm">Pop out</button>
            <button class="btn btn-ghost btn-sm">Pause longer label</button>
          </div>
        </div>
      `;
    });

    const row = await measureOverflow(page, '[data-testid="row-narrow"]');

    // EXPECTATION: row should wrap onto multiple lines, not extend past
    // its 240px container. Today `.row` has no `flex-wrap: wrap` default.
    // PR-α fix: `.row { flex-wrap: wrap; }` (with audit-recommended grep
    // of nowrap call sites first; opt-out class for any holdouts).
    expect(
      row.overflowing,
      `row overflowing in 240px container: scrollWidth=${row.scrollWidth} > clientWidth=${row.clientWidth} — F-B-NEW-2`,
    ).toBe(false);
  });
});

// ────────────────────────────────────────────────────────────────────────
// REFUTATION-AS-REGRESSION (§4.3) — H11 must always pass
//
// Per audit §1.4 (c) "refutation-as-regression-detector" pattern: the
// patterns we proved currently safe could regress under future code
// changes. Locking the proof in CI prevents the regression.
// ────────────────────────────────────────────────────────────────────────

test.describe('H11 — TempoStrip narrow viewport (refuted; regression lock)', () => {
  for (const viewport of [
    { w: 320, h: 240, label: 'synthetic-narrow' },
    { w: 390, h: 780, label: 'phone' },
    { w: 1440, h: 900, label: 'desktop' },
  ]) {
    test(`TempoStrip renders without overflow at ${viewport.label} (${viewport.w}×${viewport.h})`, async ({
      page,
    }) => {
      await setShellContent(page);
      await page.evaluate(() => {
        const root = document.getElementById('root')!;
        // Faithful TempoStrip.tsx + components.css:109-128 shape.
        const bars = Array.from({ length: 60 }, (_, i) =>
          `<rect x="${i * 6}" y="20" width="4" height="${20 + (i % 7) * 2}" fill="#888" />`,
        ).join('');
        root.innerHTML = `
          <div class="tempo-strip" data-testid="tempo-strip" style="height: 44px;">
            <div class="tempo-strip-label">
              <span class="mono dim">tempo</span>
              <span class="tempo-bpm"><span class="mono num">92</span><span class="mono dim">bpm</span></span>
            </div>
            <svg class="tempo-strip-svg" viewBox="0 0 360 44" width="100%" height="44" preserveAspectRatio="none">${bars}</svg>
          </div>
        `;
      });

      await page.setViewportSize({ width: viewport.w, height: viewport.h });
      const strip = await measureOverflow(page, '[data-testid="tempo-strip"]');

      // REFUTATION: H11 was static-refuted because (a) `viewBox` + 100% width
      // + `preserveAspectRatio: none` deforms bars elastically rather than
      // clipping, and (b) `Math.max(1.5, h)` floor on bar heights keeps
      // bars visible at any compression ratio. If this fails, H11 needs
      // re-opening as a real finding.
      expect(
        strip.overflowing,
        `TempoStrip overflowing at ${viewport.label}: scrollWidth=${strip.scrollWidth} > clientWidth=${strip.clientWidth}`,
      ).toBe(false);
    });
  }
});
