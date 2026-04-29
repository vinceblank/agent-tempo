/**
 * MaestroAvatar primitive tests (#473).
 *
 * The component composes the MaestroMark italic-M primitive inside a
 * 32×32 neutral tile shell so the sidebar identity row reads as an
 * intentional avatar (visual weight parity with PlayerAvatar) without
 * collapsing the C2 maestro-vs-player semantic distinction (audit rev 4
 * C2).
 *
 * Pinned contracts:
 *   1. Renders a wrapping `data-testid="maestro-avatar"` span.
 *   2. The inner MaestroMark stays the C2 primitive — same `maestro-mark`
 *      testid the FeedMessage tests already grep for.
 *   3. The wrapper carries `aria-label="maestro"` for screen-reader
 *      identification (the inner italic M is decorative once the wrapper
 *      labels it).
 *   4. `size` prop drives the outer tile dimensions exactly (passed
 *      verbatim to the inline `width`/`height`).
 *   5. The inner mark sizes to ~60% of the tile, mirroring PlayerAvatar's
 *      glyph-sizing rule. Default (size 32) → mark size 19px.
 *   6. The `maestro-avatar` class is present so `components.css` tablet-
 *      collapse rules can keep it visible (the `:not(.maestro-avatar)`
 *      exemptions added alongside this component).
 */
import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import { MaestroAvatar } from '../src/components/MaestroAvatar';

describe('MaestroAvatar primitive (#473)', () => {
  it('renders a wrapper with the maestro-avatar testid + aria-label', () => {
    render(<MaestroAvatar />);
    const wrapper = screen.getByTestId('maestro-avatar');
    expect(wrapper).toBeInTheDocument();
    expect(wrapper).toHaveAttribute('aria-label', 'maestro');
  });

  it('composes the C2 MaestroMark primitive inside the tile', () => {
    // The inner MaestroMark must remain reachable under its existing
    // testid — surfaces that previously matched on `.maestro-mark`
    // (FeedMessage tests, future audits) keep working.
    render(<MaestroAvatar />);
    expect(screen.getByTestId('maestro-mark')).toBeInTheDocument();
  });

  it('carries the maestro-avatar class so tablet-collapse CSS finds it', () => {
    // `components.css` uses `:not(.maestro-avatar)` exemptions on the
    // sidebar tablet-collapse rules. If this class drifts, the tile
    // would be hidden at ≤900px container width.
    render(<MaestroAvatar />);
    expect(screen.getByTestId('maestro-avatar')).toHaveClass('maestro-avatar');
  });

  it('defaults to a 32×32 tile (PlayerAvatar parity)', () => {
    render(<MaestroAvatar />);
    const wrapper = screen.getByTestId('maestro-avatar');
    expect(wrapper).toHaveStyle({ width: '32px', height: '32px' });
  });

  it('honors a custom size prop verbatim', () => {
    render(<MaestroAvatar size={48} />);
    const wrapper = screen.getByTestId('maestro-avatar');
    expect(wrapper).toHaveStyle({ width: '48px', height: '48px' });
  });

  it('uses inline-flex centering so the inner M sits in the middle', () => {
    // The original bug from #473 was that an inline `display: inline-block`
    // on MaestroMark clobbered a CSS `display: inline-flex` rule, breaking
    // vertical centering inside the chrome box. The new component owns
    // chrome via inline styles, so inline-flex must be present here.
    render(<MaestroAvatar />);
    const wrapper = screen.getByTestId('maestro-avatar');
    expect(wrapper).toHaveStyle({
      display: 'inline-flex',
      alignItems: 'center',
      justifyContent: 'center',
    });
  });

  it('uses neutral bone-tinted chrome, NOT a hue-rotated player treatment', () => {
    // This is the C2-preserving call: MaestroAvatar must NOT inherit
    // PlayerAvatar's `oklch(L C hue)` colored chrome, which would visually
    // demote the maestro to "just another player." Asserting on
    // `color-mix(... var(--bone) ...)` substring keeps the test resilient
    // to minor token tuning while pinning the semantic intent.
    render(<MaestroAvatar />);
    const wrapper = screen.getByTestId('maestro-avatar');
    const inlineStyle = wrapper.getAttribute('style') ?? '';
    expect(inlineStyle).toContain('color-mix');
    expect(inlineStyle).toContain('--bone');
    // Sanity: nothing in here should reference the player-tile hue
    // machinery (`hueForType`, `oklch(0.2x ...)` per-type backgrounds).
    expect(inlineStyle).not.toMatch(/hueForType|oklch\(0\.2[0-9]\s+0\.0[0-9]\s+\d/);
  });
});
