/**
 * Unit tests for the `__MOCK__:` cue-prefix directive parser
 * (ADR 0014 §4.4). Pure module — no Temporal.
 */
import { describe, expect, it } from 'vitest';
import { parsePrefixDirectives, PREFIX } from '../../../src/adapters/mock/prefix';

describe('parsePrefixDirectives — non-prefix bodies', () => {
  it('returns matched: false for plain text', () => {
    const r = parsePrefixDirectives('hello, world');
    expect(r.matched).toBe(false);
    expect(r.actions).toHaveLength(0);
    expect(r.errors).toHaveLength(0);
  });

  it('returns matched: false when prefix appears mid-body (not at start)', () => {
    const r = parsePrefixDirectives(`do not run __MOCK__: cue alice "x"`);
    expect(r.matched).toBe(false);
  });

  it('returns matched: false when prefix has leading whitespace', () => {
    // The prefix must be at byte 0 (architect §4.4 — "first line begins with").
    const r = parsePrefixDirectives(`  ${PREFIX} cue alice "x"`);
    expect(r.matched).toBe(false);
  });
});

describe('parsePrefixDirectives — recognized verbs', () => {
  it('parses cue with @sender target', () => {
    const r = parsePrefixDirectives(`${PREFIX} cue @sender hello world`);
    expect(r.matched).toBe(true);
    expect(r.actions).toEqual([{ cue: { to: '@sender', message: 'hello world' } }]);
    expect(r.errors).toHaveLength(0);
  });

  it('parses report directive', () => {
    const r = parsePrefixDirectives(`${PREFIX} report result task complete`);
    expect(r.actions).toEqual([{ report: { type: 'result', text: 'task complete' } }]);
  });

  it('parses delay directive', () => {
    const r = parsePrefixDirectives(`${PREFIX} delay 1500`);
    expect(r.actions).toEqual([{ delayMs: 1500 }]);
  });

  it('parses crash directive', () => {
    const r = parsePrefixDirectives(`${PREFIX} crash supervisor reset test`);
    expect(r.actions).toEqual([{ crash: { message: 'supervisor reset test' } }]);
  });

  it('parses release directive', () => {
    const r = parsePrefixDirectives(`${PREFIX} release alice`);
    expect(r.actions).toEqual([{ release: { target: 'alice' } }]);
  });

  it('parses multiple directives across lines', () => {
    const body = [
      `${PREFIX} cue alice first message`,
      `${PREFIX} delay 500`,
      `${PREFIX} report update halfway done`,
    ].join('\n');
    const r = parsePrefixDirectives(body);
    expect(r.matched).toBe(true);
    expect(r.actions).toHaveLength(3);
    expect(r.errors).toHaveLength(0);
  });

  it('treats the prefix line as a directive even when subsequent lines have no prefix', () => {
    // The prefix is required on byte 0 only — additional lines are
    // interpreted as directives whether or not they re-include the prefix.
    const body = `${PREFIX} cue alice line1\ncue bob line2`;
    const r = parsePrefixDirectives(body);
    expect(r.matched).toBe(true);
    expect(r.actions).toEqual([
      { cue: { to: 'alice', message: 'line1' } },
      { cue: { to: 'bob', message: 'line2' } },
    ]);
  });
});

describe('parsePrefixDirectives — error cases', () => {
  it('reports unknown verbs without aborting the batch', () => {
    const body = [
      `${PREFIX} cue alice ok`,
      `${PREFIX} dance fancy`,
      `${PREFIX} delay 100`,
    ].join('\n');
    const r = parsePrefixDirectives(body);
    expect(r.matched).toBe(true);
    expect(r.actions).toHaveLength(2);
    expect(r.errors).toHaveLength(1);
    expect(r.errors[0]).toMatch(/unknown verb/);
  });

  it('rejects cue with an invalid target', () => {
    // Target is the first whitespace-delimited token. `bad-target!` has no
    // internal whitespace, so the whole token is the target — and `!` makes
    // it fail PLAYER_NAME_REGEX.
    const r = parsePrefixDirectives(`${PREFIX} cue bad-target! the rest of the message`);
    expect(r.errors).toHaveLength(1);
    expect(r.errors[0]).toMatch(/invalid target/);
  });

  it('rejects report with an invalid type', () => {
    const r = parsePrefixDirectives(`${PREFIX} report fancy text`);
    expect(r.errors).toHaveLength(1);
    expect(r.errors[0]).toMatch(/invalid report type/);
  });

  it('rejects delay with a non-numeric value', () => {
    const r = parsePrefixDirectives(`${PREFIX} delay forever`);
    expect(r.errors).toHaveLength(1);
    expect(r.errors[0]).toMatch(/positive integer/);
  });

  it('rejects delay above the cap', () => {
    const r = parsePrefixDirectives(`${PREFIX} delay 999999`);
    expect(r.errors).toHaveLength(1);
    expect(r.errors[0]).toMatch(/exceeds cap/);
  });

  it('skips empty lines silently', () => {
    const body = `${PREFIX} cue alice ok\n\n\n`;
    const r = parsePrefixDirectives(body);
    expect(r.actions).toHaveLength(1);
    expect(r.errors).toHaveLength(0);
  });
});
