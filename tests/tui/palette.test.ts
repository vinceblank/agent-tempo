/**
 * Unit tests for command palette autocomplete — filter logic and reducer
 * index transitions. See src/tui/commands.ts filterPaletteCommands and
 * src/tui/store.ts (PALETTE_UP / PALETTE_DOWN / PALETTE_SET_INDEX).
 *
 * Issue #105, Phase 1. No Ink — pure-logic tests only.
 */
import { describe, it, expect } from 'vitest';
import { filterPaletteCommands } from '../../src/tui/commands';
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
