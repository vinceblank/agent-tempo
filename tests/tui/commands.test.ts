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

  it('does not crash on malformed input with embedded quote characters', () => {
    // Current parser does not interpret quotes — it treats them as literal chars.
    // This test guards against a future regression that might choke on them.
    const malformed = parseCommand('/schedule create foo cron "0 * * * *');
    expect(malformed).not.toBeNull();
    expect(malformed!.name).toBe('schedule');
    // The quote characters remain embedded in the tokens — parser is quote-naive.
    expect(malformed!.args.length).toBeGreaterThan(0);
  });

  // ── KNOWN LIMITATION / Finding for follow-up ──
  // The current parser splits on whitespace without honoring quoted strings.
  // Per #105 Phase 1 review: commands like
  //     /schedule create foo cron "0 * * * *"
  // should treat the cron expression as a single arg. Today they don't.
  // Flagged as a follow-up; no behavior change in this PR.
  it.todo(
    'TODO: /schedule create foo cron "0 * * * *" should bind the cron expression as one arg (quoted-string support)',
  );
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

  it('isValidCommand rejects removed aliases (regression for /home, /maestro, etc.)', () => {
    // Per CLAUDE.md: /home, /maestro, /dashboard, /exit, /unschedule are NOT registered.
    expect(isValidCommand('home')).toBe(false);
    expect(isValidCommand('maestro')).toBe(false);
    expect(isValidCommand('dashboard')).toBe(false);
    expect(isValidCommand('exit')).toBe(false);
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
