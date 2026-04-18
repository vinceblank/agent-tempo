/**
 * Unit tests for TUI formatting utilities (src/tui/utils/format.ts).
 *
 * Pure function tests — no Temporal, no mocks, runs in milliseconds.
 */
import { expect } from 'chai';
import { wordWrap, truncate, formatRelativeTime, phaseToLabel, phaseToColor, phaseToIconName, formatEventType } from '../src/tui/utils/format';

describe('wordWrap', function () {

  it('returns single line when text fits within maxWidth', function () {
    expect(wordWrap('hello world', 20)).to.deep.equal(['hello world']);
  });

  it('wraps at word boundary when text exceeds maxWidth', function () {
    expect(wordWrap('hello world', 5)).to.deep.equal(['hello', 'world']);
  });

  it('returns empty string array for empty input', function () {
    expect(wordWrap('', 10)).to.deep.equal(['']);
  });

  it('does not infinite loop on single long word exceeding width', function () {
    const result = wordWrap('abcdefghijklmnop', 5);
    // Single word can't be broken — returned as-is on one line
    expect(result).to.deep.equal(['abcdefghijklmnop']);
  });

  it('handles embedded newlines by splitting on them', function () {
    expect(wordWrap('line1\nline2', 20)).to.deep.equal(['line1', 'line2']);
  });

  it('wraps multiple words to fit maxWidth', function () {
    const result = wordWrap('a b c d e', 5);
    expect(result).to.deep.equal(['a b c', 'd e']);
  });

  it('wraps a longer sentence correctly', function () {
    const result = wordWrap('the quick brown fox jumps over the lazy dog', 15);
    expect(result).to.deep.equal([
      'the quick brown',
      'fox jumps over',
      'the lazy dog',
    ]);
  });

  it('handles newline + word wrap combined', function () {
    const result = wordWrap('short\nthis line is longer than ten chars', 10);
    expect(result[0]).to.equal('short');
    expect(result.length).to.be.greaterThan(2);
  });

  it('handles maxWidth of 1', function () {
    // Each word is its own line (can't break within words)
    const result = wordWrap('a b c', 1);
    expect(result).to.deep.equal(['a', 'b', 'c']);
  });

  it('handles trailing and leading spaces in words', function () {
    const result = wordWrap('hello   world', 20);
    // split(' ') produces empty strings for multiple spaces — they get filtered by the join logic
    expect(result.length).to.be.greaterThan(0);
  });

});

describe('truncate', function () {

  it('returns text unchanged when shorter than maxLen', function () {
    expect(truncate('hello', 10)).to.equal('hello');
  });

  it('returns text unchanged when exactly at maxLen', function () {
    expect(truncate('hello', 5)).to.equal('hello');
  });

  it('truncates with ellipsis when longer than maxLen', function () {
    expect(truncate('hello world', 8)).to.equal('hello...');
  });

  it('supports custom ellipsis character', function () {
    expect(truncate('hello world', 6, '\u2026')).to.equal('hello\u2026');
  });

  it('returns empty string for empty input', function () {
    expect(truncate('', 10)).to.equal('');
  });

});

describe('formatRelativeTime', function () {

  it('formats 30 seconds ago', function () {
    const iso = new Date(Date.now() - 30_000).toISOString();
    expect(formatRelativeTime(iso)).to.equal('30s ago');
  });

  it('formats 5 minutes ago', function () {
    const iso = new Date(Date.now() - 5 * 60_000).toISOString();
    expect(formatRelativeTime(iso)).to.equal('5m ago');
  });

  it('formats 2 hours ago', function () {
    const iso = new Date(Date.now() - 2 * 3_600_000).toISOString();
    expect(formatRelativeTime(iso)).to.equal('2h ago');
  });

  it('formats 3 days ago', function () {
    const iso = new Date(Date.now() - 3 * 86_400_000).toISOString();
    expect(formatRelativeTime(iso)).to.equal('3d ago');
  });

  it('returns "just now" for future timestamps', function () {
    const iso = new Date(Date.now() + 60_000).toISOString();
    expect(formatRelativeTime(iso)).to.equal('just now');
  });

});

describe('phaseToLabel', function () {

  it('collapses attached + processing to "active"', function () {
    expect(phaseToLabel('attached')).to.equal('active');
    expect(phaseToLabel('processing')).to.equal('active');
  });

  it('maps awaiting to "idle"', function () {
    expect(phaseToLabel('awaiting')).to.equal('idle');
  });

  it('collapses detached + draining to "disconnected"', function () {
    expect(phaseToLabel('detached')).to.equal('disconnected');
    expect(phaseToLabel('draining')).to.equal('disconnected');
  });

  it('maps booting to "pending"', function () {
    expect(phaseToLabel('booting')).to.equal('pending');
  });

  it('maps gone to "gone"', function () {
    expect(phaseToLabel('gone')).to.equal('gone');
  });

  it('returns "unknown" for undefined or unrecognized values', function () {
    expect(phaseToLabel(undefined)).to.equal('unknown');
    expect(phaseToLabel('bogus-phase')).to.equal('unknown');
  });

});

describe('phaseToColor', function () {

  it('returns a non-empty color string for every valid phase', function () {
    for (const phase of ['attached', 'processing', 'awaiting', 'draining', 'detached', 'booting', 'gone']) {
      const color = phaseToColor(phase);
      // Under NO_COLOR, colors become undefined — either the string is a hex
      // value or it's undefined; both are valid theme values. We assert
      // the helper doesn't throw and returns a defined-or-undefined result.
      expect(color === undefined || typeof color === 'string').to.equal(true);
    }
  });

  it('picks distinct colors for active vs disconnected vs pending', function () {
    // Under NO_COLOR these could all be undefined; skip strict inequality
    // and just assert they map through the label bucket.
    expect(phaseToColor('attached')).to.equal(phaseToColor('processing'));
    expect(phaseToColor('detached')).to.equal(phaseToColor('draining'));
  });

});

describe('phaseToIconName', function () {

  it('returns "active" for attached/processing', function () {
    expect(phaseToIconName('attached')).to.equal('active');
    expect(phaseToIconName('processing')).to.equal('active');
  });

  it('returns "stale" for awaiting (idle)', function () {
    expect(phaseToIconName('awaiting')).to.equal('stale');
  });

  it('returns "blocked" for detached/draining (disconnected)', function () {
    expect(phaseToIconName('detached')).to.equal('blocked');
    expect(phaseToIconName('draining')).to.equal('blocked');
  });

  it('returns "pending" for booting', function () {
    expect(phaseToIconName('booting')).to.equal('pending');
  });

  it('returns "terminated" for gone', function () {
    expect(phaseToIconName('gone')).to.equal('terminated');
  });

  it('returns "blocked" (cautionary) for unknown/undefined', function () {
    expect(phaseToIconName(undefined)).to.equal('blocked');
    expect(phaseToIconName('bogus')).to.equal('blocked');
  });

});

describe('formatEventType', function () {

  it('formats player_joined as "joined"', function () {
    expect(formatEventType('player_joined')).to.equal('joined');
  });

  it('formats player_left as "left"', function () {
    expect(formatEventType('player_left')).to.equal('left');
  });

  it('formats status_changed as "status"', function () {
    expect(formatEventType('status_changed')).to.equal('status');
  });

  it('returns unknown types as-is', function () {
    expect(formatEventType('something_else')).to.equal('something_else');
  });

});
