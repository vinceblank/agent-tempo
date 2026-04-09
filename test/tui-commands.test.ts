/**
 * Unit tests for TUI command parser, registry, and utility functions.
 *
 * Pure function tests — no Temporal, no mocks, runs in milliseconds.
 *
 * Covers:
 *   - parseCommand() — input parsing
 *   - COMMANDS registry — completeness and structure
 *   - getCommandNames(), isValidCommand(), formatHelpSummary()
 *   - isSentMessage(), formatTimestamp() — utility helpers
 */
import { expect } from 'chai';
import {
  parseCommand,
  COMMANDS,
  getCommandNames,
  isValidCommand,
  formatHelpSummary,
  isSentMessage,
  formatTimestamp,
} from '../src/tui/commands';
import type { Message, SentMessage } from '../src/types';

// ─────────────────────────────────────────────
// parseCommand
// ─────────────────────────────────────────────

describe('parseCommand', function () {

  it('parses a command with args', function () {
    const result = parseCommand('/cue player hello');
    expect(result).to.deep.equal({
      name: 'cue',
      args: ['player', 'hello'],
      raw: '/cue player hello',
    });
  });

  it('parses a command with no args', function () {
    const result = parseCommand('/help');
    expect(result).to.deep.equal({
      name: 'help',
      args: [],
      raw: '/help',
    });
  });

  it('parses /player with no args', function () {
    const result = parseCommand('/player');
    expect(result).to.not.be.null;
    expect(result!.name).to.equal('player');
    expect(result!.args).to.deep.equal([]);
  });

  it('returns null for non-command input', function () {
    expect(parseCommand('hello world')).to.be.null;
  });

  it('returns null for just a slash', function () {
    expect(parseCommand('/')).to.be.null;
  });

  it('returns null for empty string', function () {
    expect(parseCommand('')).to.be.null;
  });

  it('returns null for whitespace-only input', function () {
    expect(parseCommand('   ')).to.be.null;
  });

  it('trims leading and trailing whitespace', function () {
    const result = parseCommand('  /cue player  ');
    expect(result).to.not.be.null;
    expect(result!.name).to.equal('cue');
    expect(result!.args).to.deep.equal(['player']);
    expect(result!.raw).to.equal('/cue player');
  });

  it('lowercases the command name', function () {
    const result = parseCommand('/CUE Player');
    expect(result).to.not.be.null;
    expect(result!.name).to.equal('cue');
    expect(result!.args).to.deep.equal(['Player']);
  });

  it('preserves arg case (only command name is lowered)', function () {
    const result = parseCommand('/broadcast Hello World');
    expect(result!.args).to.deep.equal(['Hello', 'World']);
  });

  it('handles many args (broadcast with long message)', function () {
    const result = parseCommand('/broadcast a very long message with many words');
    expect(result!.name).to.equal('broadcast');
    expect(result!.args).to.have.lengthOf(7);
    expect(result!.args).to.deep.equal(['a', 'very', 'long', 'message', 'with', 'many', 'words']);
  });

  it('collapses multiple spaces between args', function () {
    const result = parseCommand('/cue   player    hello');
    expect(result!.args).to.deep.equal(['player', 'hello']);
  });

  it('handles tab characters as whitespace', function () {
    const result = parseCommand('/cue\tplayer\thello');
    expect(result!.args).to.deep.equal(['player', 'hello']);
  });

  it('returns null for slash followed by whitespace only', function () {
    expect(parseCommand('/   ')).to.be.null;
  });

  it('parses single-character command', function () {
    const result = parseCommand('/x');
    expect(result).to.not.be.null;
    expect(result!.name).to.equal('x');
    expect(result!.args).to.deep.equal([]);
  });

});

// ─────────────────────────────────────────────
// Command registry
// ─────────────────────────────────────────────

describe('COMMANDS registry', function () {

  it('has description and usage for every command', function () {
    for (const [name, def] of Object.entries(COMMANDS)) {
      expect(def.description, `${name} missing description`).to.be.a('string').and.not.be.empty;
      expect(def.usage, `${name} missing usage`).to.be.a('string').and.not.be.empty;
    }
  });

  it('usage starts with /<command-name> for each command', function () {
    for (const [name, def] of Object.entries(COMMANDS)) {
      expect(def.usage, `${name} usage should start with /${name}`).to.match(new RegExp(`^/${name}`));
    }
  });

  const expectedCommands = [
    'broadcast', 'player', 'status', 'help', 'quit',
    'recruit', 'stop', 'encore', 'recall', 'schedule', 'unschedule',
    'gates', 'stages', 'worktree', 'lineup', 'ensemble', 'back',
  ];

  for (const cmd of expectedCommands) {
    it(`registers "${cmd}" command`, function () {
      expect(COMMANDS).to.have.property(cmd);
    });
  }

  it('/unschedule has a non-null handler (sprint fix)', function () {
    expect(COMMANDS.unschedule.handler).to.not.be.null;
  });

  it('/help handler is null (handled directly in App.tsx)', function () {
    expect(COMMANDS.help.handler).to.be.null;
  });

  it('/quit handler is null (handled directly in App.tsx)', function () {
    expect(COMMANDS.quit.handler).to.be.null;
  });

  it('/up is NOT registered (removed — use create-ensemble wizard)', function () {
    expect(COMMANDS).to.not.have.property('up');
  });

  it('/chat is NOT registered (replaced by @player routing)', function () {
    expect(COMMANDS).to.not.have.property('chat');
  });

  it('/cue is NOT registered (replaced by @player routing)', function () {
    expect(COMMANDS).to.not.have.property('cue');
  });

  it('/ensemble IS registered', function () {
    expect(COMMANDS).to.have.property('ensemble');
    expect(COMMANDS.ensemble.handler).to.not.be.null;
  });

});

// ─────────────────────────────────────────────
// getCommandNames / isValidCommand / formatHelpSummary
// ─────────────────────────────────────────────

describe('getCommandNames', function () {

  it('returns a sorted array of command names', function () {
    const names = getCommandNames();
    expect(names).to.be.an('array');
    const sorted = [...names].sort();
    expect(names).to.deep.equal(sorted);
  });

  it('includes all registered commands', function () {
    const names = getCommandNames();
    expect(names.length).to.equal(Object.keys(COMMANDS).length);
  });

});

describe('isValidCommand', function () {

  it('returns true for registered commands', function () {
    expect(isValidCommand('broadcast')).to.be.true;
    expect(isValidCommand('player')).to.be.true;
    expect(isValidCommand('help')).to.be.true;
  });

  it('returns false for unknown commands', function () {
    expect(isValidCommand('foo')).to.be.false;
    expect(isValidCommand('notacommand')).to.be.false;
  });

  it('is case-sensitive (commands are lowercase)', function () {
    expect(isValidCommand('CUE')).to.be.false;
    expect(isValidCommand('Help')).to.be.false;
  });

});

describe('formatHelpSummary', function () {

  it('returns a non-empty string', function () {
    const summary = formatHelpSummary();
    expect(summary).to.be.a('string').and.not.be.empty;
  });

  it('starts with "Available commands:"', function () {
    expect(formatHelpSummary()).to.match(/^Available commands:/);
  });

  it('includes all command usages', function () {
    const summary = formatHelpSummary();
    for (const [, def] of Object.entries(COMMANDS)) {
      expect(summary).to.include(def.usage);
    }
  });

});

// ─────────────────────────────────────────────
// isSentMessage
// ─────────────────────────────────────────────

describe('isSentMessage', function () {

  it('returns true for a SentMessage with direction "sent"', function () {
    const sent: SentMessage & { direction: 'sent' } = {
      id: '1', to: 'player', text: 'hello', timestamp: '2026-01-01T00:00:00Z', direction: 'sent',
    };
    expect(isSentMessage(sent)).to.be.true;
  });

  it('returns false for a Message (no direction field)', function () {
    const msg: Message = {
      id: '1', from: 'player', text: 'hello', timestamp: '2026-01-01T00:00:00Z', delivered: true,
    };
    expect(isSentMessage(msg)).to.be.false;
  });

  it('returns false for a Message with isMaestro flag', function () {
    const msg: Message = {
      id: '1', from: 'maestro', text: 'hi', timestamp: '2026-01-01T00:00:00Z', delivered: true, isMaestro: true,
    };
    expect(isSentMessage(msg)).to.be.false;
  });

});

// ─────────────────────────────────────────────
// formatTimestamp
// ─────────────────────────────────────────────

describe('formatTimestamp', function () {

  it('formats an ISO string to HH:MM', function () {
    // Use a known UTC time, format will be in local timezone
    const result = formatTimestamp('2026-04-08T14:30:00Z');
    expect(result).to.match(/^\d{2}:\d{2}$/);
  });

  it('pads single-digit hours and minutes', function () {
    // Create a date in local time to control the output
    const d = new Date(2026, 0, 1, 3, 5);
    const result = formatTimestamp(d.toISOString());
    expect(result).to.equal('03:05');
  });

  it('handles midnight', function () {
    const d = new Date(2026, 0, 1, 0, 0);
    const result = formatTimestamp(d.toISOString());
    expect(result).to.equal('00:00');
  });

  it('returns NaN:NaN for invalid date string (no exception thrown)', function () {
    // new Date('not-a-date') creates Invalid Date — getHours() returns NaN
    // The try/catch only handles thrown exceptions, not NaN
    expect(formatTimestamp('not-a-date')).to.equal('NaN:NaN');
  });

  it('returns NaN:NaN for empty string', function () {
    expect(formatTimestamp('')).to.equal('NaN:NaN');
  });

});
