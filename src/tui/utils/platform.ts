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
 * ' ' = transparent, 'T' = triangle outline, 'A' = arm, 'P' = pivot
 */
export const PIXEL_COLORS: Record<string, string> = {
  T: '#FAF3EE', // triangle outline - cream/white
  B: '#FAF3EE', // alias for triangle (backward compat)
  A: '#E07A5F', // arm - terracotta
  P: '#E07A5F', // pivot - terracotta
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
 * Draw a line on a pixel grid using Bresenham's algorithm.
 */
function drawLine(grid: string[][], x0: number, y0: number, x1: number, y1: number, color: string, thickness = 1): void {
  const dx = Math.abs(x1 - x0);
  const dy = Math.abs(y1 - y0);
  const sx = x0 < x1 ? 1 : -1;
  const sy = y0 < y1 ? 1 : -1;
  let err = dx - dy;
  let cx = x0, cy = y0;

  while (true) {
    // Draw with thickness
    for (let ty = -Math.floor(thickness / 2); ty <= Math.floor(thickness / 2); ty++) {
      for (let tx = -Math.floor(thickness / 2); tx <= Math.floor(thickness / 2); tx++) {
        const py = cy + ty;
        const px = cx + tx;
        if (py >= 0 && py < grid.length && px >= 0 && px < grid[0].length) {
          grid[py][px] = color;
        }
      }
    }
    if (cx === x1 && cy === y1) break;
    const e2 = 2 * err;
    if (e2 > -dy) { err -= dy; cx += sx; }
    if (e2 < dx) { err += dx; cy += sy; }
  }
}

/**
 * Draw a filled circle on a pixel grid.
 */
function drawCircle(grid: string[][], cx: number, cy: number, r: number, color: string): void {
  for (let y = cy - r; y <= cy + r; y++) {
    for (let x = cx - r; x <= cx + r; x++) {
      if ((x - cx) * (x - cx) + (y - cy) * (y - cy) <= r * r) {
        if (y >= 0 && y < grid.length && x >= 0 && x < grid[0].length) {
          grid[y][x] = color;
        }
      }
    }
  }
}

/**
 * Create an empty pixel grid.
 */
function createGrid(width: number, height: number): string[][] {
  return Array.from({ length: height }, () => Array(width).fill(' '));
}

/**
 * Convert a 2D grid to string array for half-block rendering.
 */
function gridToStrings(grid: string[][]): string[] {
  return grid.map(row => row.join(''));
}

/**
 * Pixel art metronome — 3 frames (left, center, right).
 * High-res (32 wide × 28 tall) outline-only triangle with pendulum line.
 * Matches the actual SVG logo: outline triangle, diagonal pendulum arm, pivot dot.
 * Renders to 14 character rows of half-block cells.
 */
export function metronomePixelFrames(): HalfBlockCell[][][] {
  const W = 40;
  const H = 32;

  // SVG coordinates scaled to 40×32 grid:
  // SVG viewport 64×64, triangle: apex(32,8) → bl(14,54) → br(50,54)
  // Scale: x * 40/64 = x * 0.625, y * 32/64 = y/2
  const apex = { x: 20, y: 4 };
  const bl = { x: 9, y: 27 };
  const br = { x: 31, y: 27 };
  const pivotY = 23; // ~46/2
  const pivotX = 20;

  // Pendulum tip positions for 3 frames (extending above apex)
  const armTips = [
    { x: 12, y: 0 },  // left
    { x: 20, y: 0 },  // center (straight up)
    { x: 28, y: 0 },  // right
  ];

  function buildFrame(tipIdx: number): string[] {
    const grid = createGrid(W, H);

    // Draw pendulum arm FIRST (triangle outline draws over it where they overlap)
    const tip = armTips[tipIdx];
    drawLine(grid, pivotX, pivotY, tip.x, tip.y, 'A', 1);

    // Draw pivot dot (radius 1 for thin look)
    drawCircle(grid, pivotX, pivotY, 1, 'P');

    // Draw triangle outline (1px stroke for thin, clean lines)
    drawLine(grid, apex.x, apex.y, bl.x, bl.y, 'T', 1); // left edge
    drawLine(grid, apex.x, apex.y, br.x, br.y, 'T', 1); // right edge
    drawLine(grid, bl.x, bl.y, br.x, br.y, 'T', 1);     // base

    // Restore arm pixels that were overwritten by triangle at overlap points
    drawLine(grid, pivotX, pivotY, tip.x, tip.y, 'A', 1);
    drawCircle(grid, pivotX, pivotY, 1, 'P');

    return gridToStrings(grid);
  }

  return [
    pixelGridToHalfBlocks(buildFrame(0)), // left
    pixelGridToHalfBlocks(buildFrame(1)), // center
    pixelGridToHalfBlocks(buildFrame(2)), // right
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
