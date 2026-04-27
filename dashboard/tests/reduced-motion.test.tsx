/**
 * Animations honor `prefers-reduced-motion: reduce`.
 *
 * The two animated motifs are PhaseDot (pulse on `processing` phase)
 * and TempoStrip (pulse on the most recent active bar). Both consult
 * `useReducedMotion`; this suite stubs `matchMedia` to drive each
 * branch and asserts the inline `animation` style is set / not set.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { render } from '@testing-library/react';
import { PhaseDot } from '../src/components/tempo/PhaseDot';
import { TempoStrip } from '../src/components/tempo/TempoStrip';

function stubReducedMotion(reduce: boolean) {
  Object.defineProperty(window, 'matchMedia', {
    writable: true,
    configurable: true,
    value: vi.fn((query: string) => ({
      matches: reduce && query === '(prefers-reduced-motion: reduce)',
      media: query,
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
      addListener: vi.fn(),
      removeListener: vi.fn(),
      dispatchEvent: vi.fn(),
      onchange: null,
    })),
  });
}

beforeEach(() => {
  Object.defineProperty(window, 'matchMedia', {
    writable: true,
    configurable: true,
    value: vi.fn(),
  });
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('PhaseDot — animation gate', () => {
  it('animates the pulse on `processing` phase when reduced-motion is OFF', () => {
    stubReducedMotion(false);
    const { getByTestId } = render(<PhaseDot phase="processing" playerId="p" />);
    const dot = getByTestId('phase-dot-p');
    const icon = dot.querySelector('span[aria-hidden="true"]') as HTMLElement;
    expect(icon).toBeTruthy();
    expect(icon.style.animation).toContain('phase-dot-pulse');
  });

  it('suppresses the pulse animation when reduced-motion is ON', () => {
    stubReducedMotion(true);
    const { getByTestId } = render(<PhaseDot phase="processing" playerId="p" />);
    const dot = getByTestId('phase-dot-p');
    const icon = dot.querySelector('span[aria-hidden="true"]') as HTMLElement;
    expect(icon.style.animation === 'none' || icon.style.animation === '').toBe(true);
  });

  it('non-pulse phases (e.g. attached, idle) never animate regardless of preference', () => {
    stubReducedMotion(false);
    const { getByTestId } = render(<PhaseDot phase="attached" playerId="p" />);
    const dot = getByTestId('phase-dot-p');
    const icon = dot.querySelector('span[aria-hidden="true"]') as HTMLElement;
    expect(icon.style.animation === 'none' || icon.style.animation === '').toBe(true);
  });
});

describe('TempoStrip — recent-bar animation gate', () => {
  it('pulses the last active bar when reduced-motion is OFF', () => {
    stubReducedMotion(false);
    const { container } = render(<TempoStrip series={[1, 2, 3, 4, 5]} />);
    const rects = container.querySelectorAll('rect');
    expect(rects.length).toBeGreaterThan(0);
    const lastBar = rects[rects.length - 1] as SVGRectElement;
    expect(lastBar.style.animation).toContain('tempo-strip-pulse');
  });

  it('suppresses the bar pulse when reduced-motion is ON', () => {
    stubReducedMotion(true);
    const { container } = render(<TempoStrip series={[1, 2, 3, 4, 5]} />);
    const rects = container.querySelectorAll('rect');
    const lastBar = rects[rects.length - 1] as SVGRectElement;
    // jsdom serializes empty animation as '' rather than 'none'.
    expect(lastBar.style.animation === '' || lastBar.style.animation === 'none').toBe(true);
  });

  it('does not pulse when the most recent activity is zero (no signal to highlight)', () => {
    stubReducedMotion(false);
    const { container } = render(<TempoStrip series={[1, 2, 3, 0, 0]} />);
    const rects = container.querySelectorAll('rect');
    const lastBar = rects[rects.length - 1] as SVGRectElement;
    expect(lastBar.style.animation === '' || lastBar.style.animation === 'none').toBe(true);
  });
});
