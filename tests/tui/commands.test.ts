/**
 * Unit tests for the slash-command parser and command registry.
 * See src/tui/commands.ts. Issue #105, Phase 1.
 *
 * These tests cover pure-logic behavior: parsing, registry lookups, and
 * help-target resolution. UI/dispatch concerns (App.tsx) are out of scope.
 */
import { describe, it, expect } from 'vitest';
import {
  parseCommand,
  isValidCommand,
  getCommandNames,
  resolveHelpTarget,
  COMMANDS,
} from '../../src/tui/commands';

describe('parseCommand', () => {
  it('returns null for bare text (non-slash input)', () => {
    // Bare text routes to the conductor via sendCommand — not parsed as a command.
    expect(parseCommand('hello world')).toBeNull();
    expect(parseCommand('alice can you review?')).toBeNull();
    expect(parseCommand('@alice ping')).toBeNull();
  });

  it('returns null for empty or whitespace-only input', () => {
    expect(parseCommand('')).toBeNull();
    expect(parseCommand('   ')).toBeNull();
    expect(parseCommand('\t\n')).toBeNull();
  });

  it('returns null for lone "/" with no command name', () => {
    expect(parseCommand('/')).toBeNull();
    expect(parseCommand('/   ')).toBeNull();
  });

  it('parses a simple command with no args', () => {
    const p = parseCommand('/status');
    expect(p).not.toBeNull();
    expect(p!.name).toBe('status');
    expect(p!.args).toEqual([]);
    expect(p!.raw).toBe('/status');
  });

  it('lowercases the command name', () => {
    expect(parseCommand('/STATUS')!.name).toBe('status');
    expect(parseCommand('/Recruit')!.name).toBe('recruit');
  });

  it('parses positional args separated by whitespace', () => {
    const p = parseCommand('/stop alice');
    expect(p!.name).toBe('stop');
    expect(p!.args).toEqual(['alice']);
  });

  it('collapses runs of whitespace between args', () => {
    const p = parseCommand('/recruit   alice    bob   carol');
    expect(p!.args).toEqual(['alice', 'bob', 'carol']);
  });

  it('trims leading/trailing whitespace before parsing', () => {
    expect(parseCommand('  /status  ')!.name).toBe('status');
    expect(parseCommand('\n/stop alice\t')!.args).toEqual(['alice']);
  });

  // ── Quote-aware tokenizer (#109) ──
  // Before #109 the parser split on bare whitespace, so
  //     /schedule create foo cron "0 * * * *"
  // tokenized to 9 args with the cron cells split across them. #109 swapped
  // the split for a tokenizer that honors balanced `"…"` / `'…'` runs and
  // surfaces an `unterminatedQuote: true` flag when input is mid-typed with
  // an open quote. Strict callers opt into the flag; the TUI on-keystroke
  // path ignores it and keeps forgiving behavior.

  it('/schedule create foo cron "0 * * * *" binds the cron expression as one arg', () => {
    const parsed = parseCommand('/schedule create foo cron "0 * * * *"');
    expect(parsed).not.toBeNull();
    expect(parsed!.name).toBe('schedule');
    expect(parsed!.args).toEqual(['create', 'foo', 'cron', '0 * * * *']);
    expect(parsed!.unterminatedQuote).toBeUndefined();
  });

  it('single-quoted argument is preserved as one token', () => {
    const parsed = parseCommand("/x 'multi word value'");
    expect(parsed!.args).toEqual(['multi word value']);
    expect(parsed!.unterminatedQuote).toBeUndefined();
  });

  it('mixed quoting — double-quoted outer lets single quotes be literal', () => {
    const parsed = parseCommand('/x "outer \'inner\' outer"');
    expect(parsed!.args).toEqual(["outer 'inner' outer"]);
  });

  it('mixed quoting — single-quoted outer lets double quotes be literal', () => {
    const parsed = parseCommand('/x \'outer "inner" outer\'');
    expect(parsed!.args).toEqual(['outer "inner" outer']);
  });

  it('empty quoted string becomes an explicit empty-string arg', () => {
    // Useful for commands that take an optional-but-positional string arg
    // and want to pass "no value" explicitly.
    const parsed = parseCommand('/x "" after');
    expect(parsed!.args).toEqual(['', 'after']);
  });

  it('unterminated double quote surfaces unterminatedQuote=true; remainder flushes', () => {
    // Mirrors the mid-typed input case — user is still composing. The parser
    // must not throw or return null (forgiving-input philosophy), but it must
    // flag the unterminated state so strict consumers can react.
    const parsed = parseCommand('/schedule create foo cron "0 * * * *');
    expect(parsed).not.toBeNull();
    expect(parsed!.name).toBe('schedule');
    expect(parsed!.args).toEqual(['create', 'foo', 'cron', '0 * * * *']);
    expect(parsed!.unterminatedQuote).toBe(true);
  });

  it('unterminated single quote also flags unterminatedQuote=true', () => {
    const parsed = parseCommand("/x 'hello world");
    expect(parsed!.args).toEqual(['hello world']);
    expect(parsed!.unterminatedQuote).toBe(true);
  });
});

describe('command registry', () => {
  it('isValidCommand returns true for registered commands', () => {
    expect(isValidCommand('status')).toBe(true);
    expect(isValidCommand('destroy')).toBe(true);
    expect(isValidCommand('recruit')).toBe(true);
    expect(isValidCommand('help')).toBe(true);
  });

  it('isValidCommand returns false for unknown commands', () => {
    // App.tsx uses !isValidCommand(name) to emit the "Unknown command: /foo" error.
    expect(isValidCommand('foobar')).toBe(false);
    expect(isValidCommand('')).toBe(false);
    expect(isValidCommand('nope')).toBe(false);
  });

  it('isValidCommand rejects removed aliases', () => {
    // `/home` is now a first-class verb (#291) — see slash-commands.test.ts.
    // `/exit` is now an alias for `/quit` (#306).
    // The remaining ones stayed removed from the v0.26 cleanup.
    expect(isValidCommand('maestro')).toBe(false);
    expect(isValidCommand('dashboard')).toBe(false);
    expect(isValidCommand('unschedule')).toBe(false);
  });

  it('getCommandNames returns a sorted list', () => {
    const names = getCommandNames();
    const sorted = [...names].sort();
    expect(names).toEqual(sorted);
    // Spot-check a few well-known commands are present.
    expect(names).toContain('status');
    expect(names).toContain('help');
    expect(names).toContain('recruit');
  });

  it('every COMMANDS entry has description and usage strings', () => {
    for (const [name, def] of Object.entries(COMMANDS)) {
      expect(def.description, `${name}.description`).toBeTypeOf('string');
      expect(def.description.length, `${name}.description length`).toBeGreaterThan(0);
      expect(def.usage, `${name}.usage`).toBeTypeOf('string');
      expect(def.usage.length, `${name}.usage length`).toBeGreaterThan(0);
    }
  });
});

describe('resolveHelpTarget', () => {
  it('resolves "/help recruit" and "/help /recruit" to the same target', () => {
    const a = resolveHelpTarget('recruit');
    const b = resolveHelpTarget('/recruit');
    expect(a).not.toBeNull();
    expect(b).not.toBeNull();
    expect(a!.name).toBe('recruit');
    expect(b!.name).toBe('recruit');
    expect(a!.def).toBe(b!.def);
    expect(a!.def).toBe(COMMANDS.recruit);
  });

  it('is case-insensitive', () => {
    expect(resolveHelpTarget('RECRUIT')!.name).toBe('recruit');
    expect(resolveHelpTarget('/Recruit')!.name).toBe('recruit');
  });

  it('trims whitespace', () => {
    expect(resolveHelpTarget('  recruit  ')!.name).toBe('recruit');
  });

  it('returns null for unknown commands', () => {
    expect(resolveHelpTarget('nope')).toBeNull();
    expect(resolveHelpTarget('/nope')).toBeNull();
  });

  it('returns null for empty or slash-only input', () => {
    expect(resolveHelpTarget('')).toBeNull();
    expect(resolveHelpTarget('/')).toBeNull();
    expect(resolveHelpTarget('   ')).toBeNull();
  });
});
