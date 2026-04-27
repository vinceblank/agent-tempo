/**
 * Density-token smoke test — architect's risk #5 (Tailwind 4 + Vite 8 +
 * `oklch()` colors). Verify that flipping `documentElement.dataset.density`
 * does what we claim: cascades the `--density-*` CSS variables to a known
 * value the rest of the app can rely on.
 *
 * jsdom doesn't run Vite's CSS pipeline, so this test loads the raw
 * `tokens.css` and `globals.css` directly and asserts on
 * `getComputedStyle()` of the element under each `data-density` value.
 *
 * If this test fails after a token reorganisation, the design-time
 * density slider stops mutating the cascade. Catch it here, not by
 * eyeballing the dashboard at 5pm.
 */
import { describe, it, expect, beforeAll } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

// Vitest sets the cwd to the project root (the `dashboard/` folder)
// when running, so a relative path is the simplest way to reach the
// tokens. `import.meta.url` resolves to a `vitest:` scheme during
// tests, which `fileURLToPath` rejects — avoid it here.
const TOKENS_CSS = readFileSync(resolve(process.cwd(), 'src/styles/tokens.css'), 'utf8');

describe('density tokens (architect risk #5)', () => {
  beforeAll(() => {
    // jsdom can't `@import` from disk, so inject the raw CSS once before
    // the suite runs. Subsequent `getComputedStyle()` calls then resolve
    // the variables the same way Vite-served HTML would.
    const style = document.createElement('style');
    style.textContent = TOKENS_CSS;
    document.head.appendChild(style);
  });

  // Spec table — values come from the canonical handoff bundle's
  // `styles.css:38-52`. Any drift between the design and the rendered
  // dashboard surfaces here.
  const cases: Array<{ density: string; pad: string; fs: string }> = [
    { density: '4', pad: '22px', fs: '15px' },
    { density: '5', pad: '18px', fs: '14px' },
    { density: '6', pad: '14px', fs: '13px' },
    { density: '7', pad: '11px', fs: '12.5px' },
    { density: '8', pad: '9px', fs: '12px' },
    { density: '9', pad: '7px', fs: '11.5px' },
  ];

  it.each(cases)('density=$density resolves --density-pad=$pad / --density-fs=$fs', ({ density, pad, fs }) => {
    document.documentElement.dataset.density = density;
    const style = getComputedStyle(document.documentElement);
    expect(style.getPropertyValue('--density-pad').trim()).toBe(pad);
    expect(style.getPropertyValue('--density-fs').trim()).toBe(fs);
  });

  it('default state (no density attr) falls back to the :root table', () => {
    delete document.documentElement.dataset.density;
    const style = getComputedStyle(document.documentElement);
    expect(style.getPropertyValue('--density-pad').trim()).toBe('14px');
  });
});
