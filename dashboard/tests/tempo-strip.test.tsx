/**
 * TempoStrip — covers the 60-bar canonical sparkline contract (#389
 * final 100% cleanup). The component left-pads short series with zeros
 * and clips long series to the most recent N so the strip always renders
 * full-width — even a fresh ensemble with 5 minutes of activity draws
 * the same SVG width as a one-hour ensemble.
 */
import { describe, it, expect } from 'vitest';
import { render } from '@testing-library/react';
import { TempoStrip, padTempoSeries } from '../src/components/tempo/TempoStrip';

describe('padTempoSeries', () => {
  it('returns the series unchanged when length already matches target', () => {
    const series = Array.from({ length: 60 }, (_, i) => i);
    expect(padTempoSeries(series)).toBe(series);
  });

  it('left-pads a short series with zeros up to the target length', () => {
    const series = [1, 2, 3];
    const padded = padTempoSeries(series);
    expect(padded).toHaveLength(60);
    // First 57 entries are padded zeros; last 3 are the original data.
    expect(padded.slice(0, 57)).toEqual(Array(57).fill(0));
    expect(padded.slice(-3)).toEqual([1, 2, 3]);
  });

  it('returns 60 zeros for an empty series (fresh ensemble baseline)', () => {
    expect(padTempoSeries([])).toEqual(Array(60).fill(0));
  });

  it('clips a longer series to the most recent target entries', () => {
    const series = Array.from({ length: 90 }, (_, i) => i);
    const clipped = padTempoSeries(series);
    expect(clipped).toHaveLength(60);
    // Most recent 60 — entries 30..89 of the original.
    expect(clipped[0]).toEqual(30);
    expect(clipped[59]).toEqual(89);
  });

  it('honours a custom target length', () => {
    expect(padTempoSeries([1, 2], 5)).toEqual([0, 0, 0, 1, 2]);
    expect(padTempoSeries([1, 2, 3, 4, 5, 6], 4)).toEqual([3, 4, 5, 6]);
  });
});

describe('TempoStrip — full-width canonical render (#389 final)', () => {
  /** Count <rect> elements inside the strip's SVG. */
  function countBars(container: HTMLElement): number {
    return container.querySelectorAll('rect').length;
  }

  it('renders 60 bars even for a fresh ensemble with no activity', () => {
    const { container } = render(<TempoStrip series={[]} />);
    expect(countBars(container)).toEqual(60);
  });

  it('renders 60 bars when the series has 1-59 entries (left-padded)', () => {
    const { container } = render(<TempoStrip series={[1, 2, 3, 4, 5]} />);
    // 60-bar canonical contract — partial-fill is filled in with zeros so
    // the strip never looks stunted on a young ensemble.
    expect(countBars(container)).toEqual(60);
  });

  it('renders 60 bars when the series is exactly 60', () => {
    const series = Array.from({ length: 60 }, () => 1);
    const { container } = render(<TempoStrip series={series} />);
    expect(countBars(container)).toEqual(60);
  });

  it('clips longer series to 60 most-recent bars', () => {
    const series = Array.from({ length: 90 }, () => 1);
    const { container } = render(<TempoStrip series={series} />);
    expect(countBars(container)).toEqual(60);
  });
});
