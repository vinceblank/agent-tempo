/**
 * Unit tests for the "↑ N earlier messages" chat-cap indicator formatting.
 * See src/tui/utils/format.ts → formatEarlierIndicator.
 *
 * Issue #105, Phase 1. No Ink — pure-function tests only.
 *
 * ── Finding ──
 * The inline formatter in src/tui/components/PlayerDetailView.tsx always
 * emits plural "earlier messages", even for count === 1. The
 * formatEarlierIndicator helper tested here implements the correct
 * singular/plural behavior. Wiring PlayerDetailView to use this helper is
 * a follow-up (minor presentation fix, out of scope for Phase 1 per the
 * test plan's "flag findings, don't fix" rule).
 */
import { describe, it, expect } from 'vitest';
import { formatEarlierIndicator } from '../../src/tui/utils/format';

describe('formatEarlierIndicator', () => {
  it('returns null when count is 0 (no indicator)', () => {
    expect(formatEarlierIndicator(0)).toBeNull();
  });

  it('returns null for negative counts (defensive)', () => {
    expect(formatEarlierIndicator(-1)).toBeNull();
    expect(formatEarlierIndicator(-100)).toBeNull();
  });

  it('uses singular form for exactly 1 earlier message', () => {
    expect(formatEarlierIndicator(1)).toBe('\u2191 1 earlier message');
  });

  it('uses plural form for 2+ earlier messages', () => {
    expect(formatEarlierIndicator(2)).toBe('\u2191 2 earlier messages');
    expect(formatEarlierIndicator(5)).toBe('\u2191 5 earlier messages');
    expect(formatEarlierIndicator(42)).toBe('\u2191 42 earlier messages');
  });

  it('uses plural form for large counts', () => {
    expect(formatEarlierIndicator(1000)).toBe('\u2191 1000 earlier messages');
  });

  it('handles cap-boundary: 20 visible messages → no earlier indicator', () => {
    // The PlayerDetailView/ChatView caps at 20 visible; if exactly 20 fit,
    // earlierCount is 0 and no indicator should render.
    expect(formatEarlierIndicator(0)).toBeNull();
  });

  it('defends against non-finite input', () => {
    expect(formatEarlierIndicator(NaN)).toBeNull();
    expect(formatEarlierIndicator(Infinity)).toBeNull();
    expect(formatEarlierIndicator(-Infinity)).toBeNull();
  });

  it('always starts with the up-arrow glyph', () => {
    const out = formatEarlierIndicator(3);
    expect(out).not.toBeNull();
    expect(out!.startsWith('\u2191')).toBe(true);
  });
});
