/**
 * Platform detection utilities for the TUI.
 * Determines Unicode support, SSH sessions, and terminal capabilities.
 */

/** Whether the terminal supports Unicode box-drawing and status icons. */
export function supportsUnicode(): boolean {
  // Windows Terminal and modern terminals support Unicode
  if (process.env.WT_SESSION) return true;
  // SSH sessions may have limited support
  if (isSSH()) return false;
  // Check LANG/LC_ALL for UTF-8
  const lang = process.env.LANG || process.env.LC_ALL || '';
  if (/utf-?8/i.test(lang)) return true;
  // macOS default terminal supports Unicode
  if (process.platform === 'darwin') return true;
  // Default: assume Unicode on modern systems
  return process.platform !== 'win32' || !!process.env.WT_SESSION;
}

/** Whether we're running inside an SSH session. */
export function isSSH(): boolean {
  return !!(process.env.SSH_CLIENT || process.env.SSH_TTY || process.env.SSH_CONNECTION);
}

/** Get terminal dimensions, with minimum fallback. */
export function getTerminalSize(): { columns: number; rows: number } {
  const columns = process.stdout.columns || 80;
  const rows = process.stdout.rows || 24;
  return { columns, rows };
}

/** Minimum terminal size for the TUI. */
export const MIN_COLUMNS = 80;
export const MIN_ROWS = 24;

/** Check if terminal meets minimum size requirements. */
export function isTerminalLargeEnough(): boolean {
  const { columns, rows } = getTerminalSize();
  return columns >= MIN_COLUMNS && rows >= MIN_ROWS;
}

/** Status icons — Unicode by default, ASCII fallback. */
export function statusIcons(unicode = supportsUnicode()) {
  if (unicode) {
    return {
      active: '\u25CF',     // ●
      stale: '\u25CB',      // ○
      pending: '\u25D4',    // ◔
      blocked: '\u25D0',    // ◐
      terminated: '\u2715', // ✕
      conductor: '\u2605',  // ★
      player: '\u2022',     // •
      arrow: '\u2192',      // →
      check: '\u2714',      // ✔
      cross: '\u2718',      // ✘
      ellipsis: '\u2026',   // …
    };
  }
  return {
    active: '*',
    stale: 'o',
    pending: '~',
    blocked: '!',
    terminated: 'x',
    conductor: '#',
    player: '-',
    arrow: '->',
    check: '+',
    cross: 'x',
    ellipsis: '...',
  };
}

/** Metronome animation frames (single-character). */
export function metronomeFrames(unicode = supportsUnicode()): string[] {
  if (unicode) {
    return ['\u2572', '|', '\u2571', '|']; // ╲ | ╱ |
  }
  return ['\\', '|', '/', '|'];
}

// ── Pixel Art Metronome ──

/**
 * Color palette for pixel art.
 * ' ' = transparent, 'B' = body, 'A' = arm, 'P' = pivot
 */
export const PIXEL_COLORS: Record<string, string> = {
  B: '#1B2838', // body - dark slate
  A: '#E07A5F', // arm - terracotta
  P: '#E07A5F', // pivot - terracotta (same as arm)
};

/** A single half-block cell with optional fg/bg colors. */
export interface HalfBlockCell {
  char: string;
  fg?: string;
  bg?: string;
}

/**
 * Convert two pixel rows into a row of half-block cells.
 * Each character cell encodes 2 vertical pixels:
 * - ▀ = top pixel (fg), bottom transparent
 * - ▄ = bottom pixel (fg), top transparent
 * - █ = both pixels same color (fg)
 * - ▄ with bg = top pixel (bg), bottom pixel (fg)
 */
export function renderHalfBlockRow(topRow: string, bottomRow: string): HalfBlockCell[] {
  const width = Math.max(topRow.length, bottomRow.length);
  const cells: HalfBlockCell[] = [];

  for (let x = 0; x < width; x++) {
    const top = topRow[x] || ' ';
    const bottom = bottomRow[x] || ' ';
    const topColor = PIXEL_COLORS[top];
    const bottomColor = PIXEL_COLORS[bottom];

    if (!topColor && !bottomColor) {
      cells.push({ char: ' ' });
    } else if (topColor && !bottomColor) {
      cells.push({ char: '\u2580', fg: topColor }); // ▀
    } else if (!topColor && bottomColor) {
      cells.push({ char: '\u2584', fg: bottomColor }); // ▄
    } else if (topColor === bottomColor) {
      cells.push({ char: '\u2588', fg: topColor }); // █
    } else {
      // Two different colors: ▄ with fg=bottom, bg=top
      cells.push({ char: '\u2584', fg: bottomColor, bg: topColor });
    }
  }

  return cells;
}

/**
 * Convert a pixel grid (array of strings) into half-block cell rows.
 * Grid height must be even (padded with empty row if odd).
 */
export function pixelGridToHalfBlocks(grid: string[]): HalfBlockCell[][] {
  const rows: HalfBlockCell[][] = [];
  const padded = grid.length % 2 === 0 ? grid : [...grid, ''];

  for (let y = 0; y < padded.length; y += 2) {
    rows.push(renderHalfBlockRow(padded[y], padded[y + 1]));
  }

  return rows;
}

/**
 * Pixel art metronome — 3 frames (left, center, right).
 * Each frame is a pixel grid (16 wide × 12 tall) that renders
 * to 6 character rows of half-block cells.
 *
 * Matches the SVG logo: solid triangle body, pendulum from bottom pivot.
 */
export function metronomePixelFrames(): HalfBlockCell[][][] {
  // 16 wide × 12 tall pixel grids
  // ' '=transparent, B=body, A=arm, P=pivot
  const center = [
    '      BBBB      ', // row 0  (tip)
    '     BBBBBB     ', // row 1
    '    BBBBBBBB    ', // row 2
    '   BBBBABBBBB   ', // row 3  (arm top)
    '  BBBBBABBBBBB  ', // row 4
    ' BBBBBBABBBBBBB ', // row 5
    'BBBBBBBABBBBBBBB', // row 6
    'BBBBBBBPBBBBBBBB', // row 7  (pivot)
    'BBBBBBBBBBBBBBBB', // row 8  (base top)
    'BBBBBBBBBBBBBBBB', // row 9  (base bottom)
    '                ', // row 10
    '                ', // row 11
  ];

  const left = [
    '      BBBB      ', // row 0
    '     BBBBBB     ', // row 1
    '    BABBBBBB    ', // row 2  (arm top-left)
    '   BBBABBBBB    ', // row 3
    '  BBBBABBBBBB   ', // row 4
    ' BBBBBABBBBBBB  ', // row 5
    'BBBBBBABBBBBBBBB', // row 6
    'BBBBBBBPBBBBBBBB', // row 7  (pivot)
    'BBBBBBBBBBBBBBBB', // row 8
    'BBBBBBBBBBBBBBBB', // row 9
    '                ', // row 10
    '                ', // row 11
  ];

  const right = [
    '      BBBB      ', // row 0
    '     BBBBBB     ', // row 1
    '    BBBBBABB    ', // row 2  (arm top-right)
    '   BBBBBABBB    ', // row 3
    '  BBBBBBABBBB   ', // row 4
    ' BBBBBBBABBBBB  ', // row 5
    'BBBBBBBBABBBBBBB', // row 6
    'BBBBBBBPBBBBBBBB', // row 7  (pivot)
    'BBBBBBBBBBBBBBBB', // row 8
    'BBBBBBBBBBBBBBBB', // row 9
    '                ', // row 10
    '                ', // row 11
  ];

  return [
    pixelGridToHalfBlocks(left),
    pixelGridToHalfBlocks(center),
    pixelGridToHalfBlocks(right),
  ];
}

/**
 * Legacy string-based metronome art for non-pixel contexts.
 * @deprecated Use metronomePixelFrames() for the splash screen.
 */
export function metronomeArt(unicode = supportsUnicode()): string[][] {
  if (unicode) {
    return [
      ['   /\\   ', '  /  \\  ', ' / ╱  \\ ', '/╱  ●  \\', '‾‾‾‾‾‾‾‾'],
      ['   /\\   ', '  / | \\ ', ' /  |  \\', '/  ●   \\', '‾‾‾‾‾‾‾‾'],
      ['   /\\   ', '  /  ╲ \\', ' /   ╲ \\', '/   ● ╲\\', '‾‾‾‾‾‾‾‾'],
    ];
  }
  return [
    ['   /\\   ', '  /  \\  ', ' / /  \\', '/o    \\', '~~~~~~~~'],
    ['   /\\   ', '  / | \\', ' /  | \\', '/  o  \\', '~~~~~~~~'],
    ['   /\\   ', '  /  \\ \\', ' /   \\\\', '/    o\\', '~~~~~~~~'],
  ];
}

/**
 * Block-letter "claude-tempo" title art (figlet "small" style).
 * 5 lines tall, ~62 characters wide.
 *
 * Color guide for consumers: cyan bold
 */
export function titleArt(unicode = supportsUnicode()): string[] {
  if (unicode) {
    return [
      ' ┌─┐┬  ┌─┐┬ ┬┌┬┐┌─┐  ─┬─┌─┐┌┬┐┌─┐┌─┐',
      ' │  │  ├─┤│ │ ││├┤    │ ├┤ │││├─┘│ │',
      ' └─┘┴─┘┴ ┴└─┘─┴┘└─┘   ┴ └─┘┴ ┴┴  └─┘',
    ];
  }

  return [
    ' __  _    __   _  _  ___  ___    ___ ___  __  __ ___  ___',
    '/ _|| |  / _| | || ||   \\| __|  |_ _| __|/  \\/  | _ \\/ _ \\',
    '| (_|| |_| (_| | || || |) | _|    | || _|| |\\/| |  _/ (_) |',
    ' \\__||___|\\__| \\_,_||___/|___|   |_||___|_|  |_|_|  \\___/',
  ];
}

/** Minimum terminal width for the title art to display without wrapping. */
const TITLE_ART_MIN_WIDTH = 70;

/** Whether the title art fits in the given terminal width. */
export function titleArtFits(columns: number): boolean {
  return columns >= TITLE_ART_MIN_WIDTH;
}
