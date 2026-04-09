/**
 * Unit tests for TUI formatting utilities (src/tui/utils/format.ts).
 *
 * Pure function tests — no Temporal, no mocks, runs in milliseconds.
 */
import { expect } from 'chai';
import { wordWrap, truncate, formatRelativeTime } from '../src/tui/utils/format';

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
