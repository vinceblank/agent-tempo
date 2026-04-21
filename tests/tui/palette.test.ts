/**
 * Unit tests for command palette autocomplete — filter logic and reducer
 * index transitions. See src/tui/commands.ts filterPaletteCommands and
 * src/tui/store.ts (PALETTE_UP / PALETTE_DOWN / PALETTE_SET_INDEX).
 *
 * Issue #105, Phase 1. No Ink — pure-logic tests only.
 */
import { describe, it, expect } from 'vitest';
import { filterPaletteCommands, classifyPaletteInput, filterPlayerNames, PLAYER_PARAM_COMMANDS } from '../../src/tui/commands';
import { initialState, tuiReducer, type TuiState } from '../../src/tui/store';

interface PCmd { name: string; usage: string; description: string }

const commands: PCmd[] = [
  { name: 'recruit', usage: '/recruit', description: 'Spawn a new player' },
  { name: 'recall',  usage: '/recall',  description: "Read a player's history" },
  { name: 'resume',  usage: '/resume',  description: 'Resume a paused ensemble' },
  { name: 'pause',   usage: '/pause',   description: 'Pause the ensemble' },
  { name: 'stop',    usage: '/stop',    description: 'Stop a player' },
  { name: 'help',    usage: '/help',    description: 'Show available commands' },
];

describe('filterPaletteCommands', () => {
  it('empty filter returns all commands in original order (copy, not same ref)', () => {
    const out = filterPaletteCommands(commands, '');
    expect(out).toEqual(commands);
    expect(out).not.toBe(commands); // caller should get a fresh array
  });

  it('bare prefix narrows options (no leading slash)', () => {
    const out = filterPaletteCommands(commands, 're');
    expect(out.map((c) => c.name)).toEqual(['recruit', 'recall', 'resume']);
  });

  it('prefix with leading slash is equivalent', () => {
    const bare = filterPaletteCommands(commands, 're');
    const slash = filterPaletteCommands(commands, '/re');
    expect(slash).toEqual(bare);
  });

  it('prefix longer than any command returns empty', () => {
    expect(filterPaletteCommands(commands, 'nomatch')).toEqual([]);
  });

  it('is case-insensitive', () => {
    expect(filterPaletteCommands(commands, 'RE').map((c) => c.name))
      .toEqual(['recruit', 'recall', 'resume']);
    expect(filterPaletteCommands(commands, '/Pause').map((c) => c.name))
      .toEqual(['pause']);
  });

  it('exact match returns exactly one entry', () => {
    expect(filterPaletteCommands(commands, 'help').map((c) => c.name)).toEqual(['help']);
  });

  it('does not mutate the input array', () => {
    const snapshot = commands.map((c) => c.name);
    filterPaletteCommands(commands, 're');
    expect(commands.map((c) => c.name)).toEqual(snapshot);
  });

  it('works on readonly input', () => {
    const readonly: readonly PCmd[] = commands;
    const out = filterPaletteCommands(readonly, 'p');
    expect(out.map((c) => c.name)).toEqual(['pause']);
  });
});

describe('tuiReducer — palette index transitions', () => {
  function stateWithPalette(index: number): TuiState {
    return { ...initialState('demo'), paletteVisible: true, paletteIndex: index };
  }

  it('PALETTE_UP at index 0 stays clamped to 0', () => {
    const s = stateWithPalette(0);
    const out = tuiReducer(s, { type: 'PALETTE_UP' });
    expect(out.paletteIndex).toBe(0);
  });

  it('PALETTE_UP decrements index by 1 when > 0', () => {
    const s = stateWithPalette(3);
    const out = tuiReducer(s, { type: 'PALETTE_UP' });
    expect(out.paletteIndex).toBe(2);
  });

  it('PALETTE_DOWN increments without a max', () => {
    const s = stateWithPalette(0);
    const out = tuiReducer(s, { type: 'PALETTE_DOWN' });
    expect(out.paletteIndex).toBe(1);
  });

  it('PALETTE_DOWN clamps to max when provided', () => {
    const s = stateWithPalette(4);
    const out = tuiReducer(s, { type: 'PALETTE_DOWN', max: 4 });
    expect(out.paletteIndex).toBe(4); // stays at max
    const out2 = tuiReducer(out, { type: 'PALETTE_DOWN', max: 4 });
    expect(out2.paletteIndex).toBe(4);
  });

  it('PALETTE_SET_INDEX jumps directly', () => {
    const s = stateWithPalette(0);
    const out = tuiReducer(s, { type: 'PALETTE_SET_INDEX', index: 5 });
    expect(out.paletteIndex).toBe(5);
  });

  // Wrap-around is NOT currently supported; PALETTE_UP/_DOWN clamp at 0/max.
  // Documenting the current behavior (not wrapping) locks in the contract.
  it('PALETTE_UP at 0 does not wrap around to the end', () => {
    const s = stateWithPalette(0);
    const out = tuiReducer(s, { type: 'PALETTE_UP' });
    expect(out.paletteIndex).toBe(0);
    expect(out.paletteIndex).not.toBe(-1);
  });
});

describe('classifyPaletteInput (#306 player-arg autocomplete)', () => {
  it('returns null for empty / whitespace / plain chat input', () => {
    expect(classifyPaletteInput('')).toBeNull();
    expect(classifyPaletteInput('   ')).toBeNull();
    expect(classifyPaletteInput('hello world')).toBeNull();
  });

  it('classifies "/rec" as command mode with partial "rec"', () => {
    const ctx = classifyPaletteInput('/rec');
    expect(ctx).toEqual({ mode: 'command', partial: 'rec', replacePrefix: '/' });
  });

  it('classifies bare "/" as command mode with empty partial', () => {
    expect(classifyPaletteInput('/')).toEqual({ mode: 'command', partial: '', replacePrefix: '/' });
  });

  it('classifies "@al" as player mode with partial "al"', () => {
    expect(classifyPaletteInput('@al')).toEqual({ mode: 'player', partial: 'al', replacePrefix: '@' });
  });

  it('classifies "/restart " as player-arg mode with empty partial', () => {
    const ctx = classifyPaletteInput('/restart ');
    expect(ctx).toEqual({ mode: 'player-arg', partial: '', replacePrefix: '/restart ' });
  });

  it('classifies "/restart co" as player-arg mode with partial "co"', () => {
    expect(classifyPaletteInput('/restart co')).toEqual({
      mode: 'player-arg',
      partial: 'co',
      replacePrefix: '/restart ',
    });
  });

  it('classifies every PLAYER_PARAM_COMMAND after a space', () => {
    for (const cmd of PLAYER_PARAM_COMMANDS) {
      const ctx = classifyPaletteInput(`/${cmd} `);
      expect(ctx, `missing palette mode for /${cmd} <space>`).not.toBeNull();
      expect(ctx!.mode).toBe('player-arg');
      expect(ctx!.replacePrefix).toBe(`/${cmd} `);
    }
  });

  it('does NOT surface palette for non-player-param commands after a space', () => {
    // `/recruit foo` is free-form — recruit name, not a picker.
    expect(classifyPaletteInput('/recruit foo')).toBeNull();
    // `/cue alice hello` is also free-form.
    expect(classifyPaletteInput('/cue alice hello')).toBeNull();
  });

  it('does NOT surface palette for second positional arg (after two spaces)', () => {
    // Only the first arg (a player name) is completed. Subsequent args are
    // free-form (e.g. worktree create <name> — the name is typed by the user).
    expect(classifyPaletteInput('/worktree create foo')).toBeNull();
    expect(classifyPaletteInput('/restart alice extra')).toBeNull();
  });

  it('lowercases the partial', () => {
    expect(classifyPaletteInput('/RESTART Co')!.partial).toBe('co');
    expect(classifyPaletteInput('/RECRUIT')!.partial).toBe('recruit');
  });

  it('ignores leading whitespace before the /', () => {
    expect(classifyPaletteInput('  /restart ')!.mode).toBe('player-arg');
  });
});

describe('filterPlayerNames (#306)', () => {
  const names = ['conductor', 'tempo-composer', 'tempo-soloist', 'alice'];

  it('empty partial returns all names', () => {
    expect(filterPlayerNames(names, '')).toEqual(names);
  });

  it('prefix match wins', () => {
    expect(filterPlayerNames(names, 'con')).toEqual(['conductor']);
  });

  it('segment match across hyphens (co matches tempo-composer)', () => {
    // `co` matches both `conductor` (prefix) and `tempo-composer` (segment).
    expect(filterPlayerNames(names, 'co')).toEqual(['conductor', 'tempo-composer']);
  });

  it('exact match is excluded (nothing left to complete)', () => {
    expect(filterPlayerNames(names, 'conductor')).toEqual([]);
  });

  it('is case-insensitive', () => {
    expect(filterPlayerNames(names, 'CON')).toEqual(['conductor']);
  });

  it('returns empty when nothing matches', () => {
    expect(filterPlayerNames(names, 'zzz')).toEqual([]);
  });
});

// The scenarios below pin the logic layer for the "/destroy conductor" dead-key
// bug the PromptArea Enter handler fix is built on. The keyboard handler itself
// (PromptArea.tsx useInput) cannot be exercised from Vitest without Ink render
// (the project deliberately keeps tests/tui/ free of Ink — see vitest.config.ts),
// so these tests anchor the invariants the handler depends on:
//
//   1. classifyPaletteInput keeps returning `player-arg` mode even when the
//      user has typed an exact player name — the palette is still "visible" by
//      policy.
//   2. filterPlayerNames returns [] for that exact match — the palette has
//      zero suggestions.
//   3. (1) + (2) describe the trap. The fix in PromptArea is: on Enter, always
//      close the palette and fall through to the regular submit block, never
//      attempt an accept-via-Enter branch. Tab remains the accept key.
describe('palette + Enter dead-key regression (#306)', () => {
  const names = ['conductor', 'tempo-composer', 'alice'];

  it('"/destroy conductor" classifies as player-arg (palette visible by policy)', () => {
    const ctx = classifyPaletteInput('/destroy conductor');
    expect(ctx).toEqual({
      mode: 'player-arg',
      partial: 'conductor',
      replacePrefix: '/destroy ',
    });
  });

  it('"/destroy conductor" yields zero palette suggestions (exact match excluded)', () => {
    const ctx = classifyPaletteInput('/destroy conductor')!;
    expect(filterPlayerNames(names, ctx.partial)).toEqual([]);
  });

  it('"/destroy " (trailing space) classifies as player-arg with all names available', () => {
    const ctx = classifyPaletteInput('/destroy ');
    expect(ctx).toEqual({ mode: 'player-arg', partial: '', replacePrefix: '/destroy ' });
    // Empty partial lists everything — Tab selects, Enter submits bare command.
    expect(filterPlayerNames(names, ctx!.partial)).toEqual(names);
  });

  // Every PLAYER_PARAM_COMMAND can hit the same trap when typed with an exact
  // player name. Pin the invariant for each so a future rename can't regress it.
  it('every PLAYER_PARAM_COMMAND with an exact player name yields zero suggestions', () => {
    for (const cmd of PLAYER_PARAM_COMMANDS) {
      const raw = `/${cmd} conductor`;
      const ctx = classifyPaletteInput(raw);
      expect(ctx, `palette should be active for ${raw}`).not.toBeNull();
      expect(ctx!.mode).toBe('player-arg');
      expect(filterPlayerNames(names, ctx!.partial), `${raw} should have 0 suggestions`).toEqual([]);
    }
  });
});
