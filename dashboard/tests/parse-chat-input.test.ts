/**
 * parseChatInput — submit-time classifier for the dashboard Composer
 * (#471/#472).
 *
 * Pinned cases from the conductor's brief:
 *   1. `@target message` — directed cue
 *   2. `/command args`   — slash command
 *   3. plain message     — conductor-bound cue (or whatever default the
 *                          caller decides)
 *   4. `@target` alone   — mention without body (must NOT silently send
 *                          a no-op cue or a fall-through to conductor)
 *
 * Plus the edge cases the implementation has to nail:
 *   - leading whitespace before `@` or `/`
 *   - bare `/` and `@`
 *   - invalid mention syntax (`@!`, `@-bad`)
 *   - slash always wins over mention (`/foo @bar` is a slash)
 *   - quoted args round-trip via the shared parseCommand tokenizer
 */
import { describe, it, expect } from 'vitest';
import { parseChatInput } from '../src/lib/parse-chat-input';

describe('parseChatInput — canonical cases (#471/#472)', () => {
  it('1. classifies "@target message" as a directed cue', () => {
    expect(parseChatInput('@tempo-eng how are you doing?')).toEqual({
      kind: 'cue',
      target: 'tempo-eng',
      text: 'how are you doing?',
    });
  });

  it('2. classifies "/command args" as a slash invocation', () => {
    expect(parseChatInput('/recall tempo-eng')).toEqual({
      kind: 'slash',
      name: 'recall',
      args: ['tempo-eng'],
      raw: '/recall tempo-eng',
    });
  });

  it('3. classifies plain text as kind=plain (caller routes to conductor)', () => {
    expect(parseChatInput('hello everyone')).toEqual({
      kind: 'plain',
      text: 'hello everyone',
    });
  });

  it('4. classifies "@target" alone as a mention with empty text — caller must decide', () => {
    expect(parseChatInput('@tempo-eng')).toEqual({
      kind: 'cue',
      target: 'tempo-eng',
      text: '',
    });
  });
});

describe('parseChatInput — slash branch', () => {
  it('lowercases the command name', () => {
    expect(parseChatInput('/CLEAR')).toMatchObject({ kind: 'slash', name: 'clear' });
  });

  it('routes "/help" with no args', () => {
    expect(parseChatInput('/help')).toEqual({
      kind: 'slash',
      name: 'help',
      args: [],
      raw: '/help',
    });
  });

  it('preserves quoted args via the shared tokenizer (#109 round-trip)', () => {
    // The TUI's parseCommand handles quoted tokens; the dashboard inherits
    // the same tokenizer for free.
    const out = parseChatInput('/recall "tempo eng with space"');
    expect(out.kind).toBe('slash');
    if (out.kind !== 'slash') return;
    expect(out.args).toEqual(['tempo eng with space']);
  });

  it('falls through to plain when input is just "/" or "/   "', () => {
    expect(parseChatInput('/')).toEqual({ kind: 'plain', text: '/' });
    expect(parseChatInput('/   ')).toEqual({ kind: 'plain', text: '/' });
  });

  it('slash takes precedence over @ embedded in args', () => {
    // `/recall @alice` is a slash-recall with `@alice` as the positional
    // arg — it is NOT a mention. Locks in the precedence rule the
    // dispatcher relies on.
    const out = parseChatInput('/recall @alice');
    expect(out.kind).toBe('slash');
    if (out.kind !== 'slash') return;
    expect(out.name).toBe('recall');
    expect(out.args).toEqual(['@alice']);
  });
});

describe('parseChatInput — mention branch', () => {
  it('strips a single trailing space from the body', () => {
    // `@x   hello` — multi-space gap collapses to a single boundary;
    // the body is the trimmed remainder.
    expect(parseChatInput('@alice   hello')).toEqual({
      kind: 'cue',
      target: 'alice',
      text: 'hello',
    });
  });

  it('preserves multi-line bodies after the mention (no inner trim)', () => {
    // The body is trimmed only at its outer edges — interior whitespace
    // (including newlines) survives so a paste-in code block stays intact.
    const out = parseChatInput('@alice line one\nline two');
    expect(out).toEqual({
      kind: 'cue',
      target: 'alice',
      text: 'line one\nline two',
    });
  });

  it('falls through to plain when the mention contains chars outside PLAYER_NAME_REGEX', () => {
    // `@! hi` — `!` is not in [a-zA-Z0-9_-], so MENTION_RE doesn't match
    // and the input falls through to plain text. The caller can then
    // either toast an "invalid mention" hint or send the literal text.
    expect(parseChatInput('@! hi')).toEqual({ kind: 'plain', text: '@! hi' });
    expect(parseChatInput('@bob.smith hi')).toEqual({ kind: 'plain', text: '@bob.smith hi' });
  });

  it('accepts mention shapes the validation regex permits, even unusual ones', () => {
    // `@-bad` — leading dash IS allowed by PLAYER_NAME_REGEX, so the
    // parser captures it. The Workspace's submit handler validates the
    // captured target against the live roster — a mention shaped like
    // a name but absent from the ensemble toasts a useful error. This
    // policy avoids divergence between TUI player-name validation and
    // dashboard mention parsing.
    expect(parseChatInput('@-bad hi')).toEqual({
      kind: 'cue',
      target: '-bad',
      text: 'hi',
    });
  });

  it('accepts hyphens inside the player name (e.g. @tempo-eng)', () => {
    expect(parseChatInput('@tempo-eng ping')).toEqual({
      kind: 'cue',
      target: 'tempo-eng',
      text: 'ping',
    });
  });

  it('accepts dots and underscores per validation regex', () => {
    expect(parseChatInput('@alice_2 ping')).toMatchObject({ target: 'alice_2' });
  });
});

describe('parseChatInput — leading whitespace', () => {
  it('tolerates leading whitespace before the @-mention', () => {
    expect(parseChatInput('   @alice hi')).toEqual({
      kind: 'cue',
      target: 'alice',
      text: 'hi',
    });
  });

  it('tolerates leading whitespace before the slash', () => {
    expect(parseChatInput('  /clear')).toMatchObject({ kind: 'slash', name: 'clear' });
  });

  it('tolerates trailing whitespace after the body', () => {
    expect(parseChatInput('@alice hi   ')).toEqual({
      kind: 'cue',
      target: 'alice',
      text: 'hi',
    });
  });
});

describe('parseChatInput — empty / boundary inputs', () => {
  it('returns plain "" for empty input', () => {
    expect(parseChatInput('')).toEqual({ kind: 'plain', text: '' });
  });

  it('returns plain "" for whitespace-only input', () => {
    expect(parseChatInput('   \n  ')).toEqual({ kind: 'plain', text: '' });
  });

  it('handles bare "@" as plain (not a mention without target)', () => {
    expect(parseChatInput('@')).toEqual({ kind: 'plain', text: '@' });
  });
});
